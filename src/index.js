/**
 * AI Content Generator Worker
 * 功能：定期从外部源获取 Prompt，调用 AI 模型生成内容并缓存至 Cloudflare KV。
 * 特性：支持 OpenAI 接口标准，具备主备模型切换与自动重试机制。
 */

// 导入静态 Prompt 文件 (需在 wrangler.toml 中配置规则或保证文件存在)
import systemPromptText from './system_prompt.txt';
import userPromptText from './user_prompt.txt';

// ==========================================
// 1. 全局配置与常量定义
// ==========================================

/** KV 存储键名 */
const STORAGE_KEY = "generated_text";

/** 外部动态 Prompt 获取地址 */
const REMOTE_PROMPT_URL = "https://prompt.hitokoto.natsuki.cloud/";

/** 重试策略配置 */
const RETRY_CONFIG = {
    MAX_ATTEMPTS: 4,      // 最大重试次数
    DELAY_SECONDS: 4      // 重试间隔（秒）
};

/** 跨域资源共享 (CORS) 头配置 */
const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
};

/**
 * 模型策略配置中心
 * 在此定义主模型（Primary）和备用模型（Fallback）。
 * 所有模型必须支持 OpenAI Chat Completion 接口规范。
 */
const MODEL_REGISTRY = {
    // 主模型
    PRIMARY: {
        id: "gemini-3-flash-preview",
        endpoint: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
        apiKeyEnv: "GEMINI_API_KEY",
        parameters: {
            temperature: 2.0,
            reasoning_effort: "high",
        }
    },
    // 备用模型
    FALLBACK: {
        id: "gemini-2.5-flash",
        endpoint: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
        apiKeyEnv: "GEMINI_API_KEY",
        parameters: {
            temperature: 2.0,
            reasoning_effort: "high",
        }
    }
};

// ==========================================
// 2. Worker 主逻辑 (入口)
// ==========================================

export default {
    /**
     * HTTP 请求处理入口
     */
    async fetch(request, env, ctx) {
        // 处理 CORS 预检请求
        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: CORS_HEADERS });
        }

        const url = new URL(request.url);

        try {
            switch (url.pathname) {
                case '/':
                    return await handleGetContent(env);
                case '/update':
                    return await handleManualUpdate(request, env);
                default:
                    return new Response('Not Found\n', { 
                        status: 404, 
                        headers: CORS_HEADERS 
                    });
            }
        } catch (err) {
            console.error(`[System Error] Unhandled exception: ${err.message}`);
            return new Response(`Internal Server Error: ${err.message}\n`, {
                status: 500,
                headers: CORS_HEADERS
            });
        }
    },

    /**
     * Cron 定时任务入口
     */
    async scheduled(event, env, ctx) {
        console.log(`[Cron] Scheduled task started at ${new Date().toISOString()}`);
        ctx.waitUntil(
            executeResilientUpdate(env)
                .then(result => console.log(`[Cron] Task completed. Model: ${result.model}`))
                .catch(err => console.error(`[Cron] Task CRITICAL FAILURE: ${err.message}`))
        );
    }
};

// ==========================================
// 3. 路由处理函数
// ==========================================

/**
 * 处理根路径 GET 请求：返回缓存的文本
 */
async function handleGetContent(env) {
    try {
        const content = await env.TEXT_CACHE.get(STORAGE_KEY);
        
        if (!content) {
            return new Response("Service warming up, content is generating...\n", {
                status: 503,
                headers: { 'Content-Type': 'text/plain; charset=utf-8', ...CORS_HEADERS }
            });
        }

        return new Response(content + '\n', {
            headers: { 'Content-Type': 'text/plain; charset=utf-8', ...CORS_HEADERS }
        });
    } catch (error) {
        throw new Error(`Cache retrieval failed: ${error.message}`);
    }
}

/**
 * 处理 /update POST 请求：强制刷新内容
 */
async function handleManualUpdate(request, env) {
    if (request.method !== 'POST') {
        return new Response('Method Not Allowed. Use POST.\n', { status: 405, headers: CORS_HEADERS });
    }

    // 1. 安全校验
    const serverToken = env.UPDATE_TOKEN;
    if (!serverToken) {
        return new Response('Server configuration error.\n', { status: 500, headers: CORS_HEADERS });
    }

    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return new Response('Unauthorized: Missing or invalid Bearer token.\n', { status: 401, headers: CORS_HEADERS });
    }

    const clientToken = authHeader.split(' ')[1];
    if (clientToken !== serverToken) {
        return new Response('Forbidden: Invalid token.\n', { status: 403, headers: CORS_HEADERS });
    }

    // 2. 执行更新逻辑
    try {
        console.log("[API] Manual update triggered.");
        const result = await executeResilientUpdate(env);

        const responseData = {
            success: true,
            message: 'Content refreshed successfully.',
            model_used: result.model,
            new_content: result.content
        };

        return new Response(JSON.stringify(responseData, null, 2) + '\n', {
            status: 200,
            headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
        });

    } catch (error) {
        console.error(`[API] Update failed: ${error.message}`);
        const errorData = {
            success: false,
            message: `Update failed after retries: ${error.message}`
        };
        return new Response(JSON.stringify(errorData, null, 2) + '\n', {
            status: 500,
            headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
        });
    }
}

// ==========================================
// 4. 核心业务逻辑 (Controller)
// ==========================================

/**
 * 执行具备容错能力的更新流程
 */
async function executeResilientUpdate(env) {
    let currentModelKey = 'PRIMARY';
    const { MAX_ATTEMPTS, DELAY_SECONDS } = RETRY_CONFIG;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            console.log(`[Update Cycle] Attempt ${attempt}/${MAX_ATTEMPTS} using [${currentModelKey}]...`);

            const generatedText = await generateAndCacheContent(env, currentModelKey);

            console.log(`[Update Cycle] Success. Content length: ${generatedText.length}`);
            return { model: currentModelKey, content: generatedText };

        } catch (error) {
            console.warn(`[Update Cycle] Attempt ${attempt} failed: ${error.message}`);

            if (attempt === MAX_ATTEMPTS) {
                throw new Error(`Failed to update content after ${MAX_ATTEMPTS} attempts. Last error: ${error.message}`);
            }

            // 智能降级策略：
            // 如果主模型遇到 429 (限流) 或 5xx (服务端错误)，切换到备用模型
            if (currentModelKey === 'PRIMARY' && (error.statusCode === 429 || error.statusCode >= 500)) {
                console.log(`[Failover] Switching strategy: PRIMARY -> FALLBACK for next attempt.`);
                currentModelKey = 'FALLBACK';
            }

            if (DELAY_SECONDS > 0) {
                await new Promise(resolve => setTimeout(resolve, DELAY_SECONDS * 1000));
            }
        }
    }
}

/**
 * 编排内容生成流程
 */
async function generateAndCacheContent(env, modelKey) {
    const dynamicPrompt = await fetchRemotePrompt(env);
    const generatedContent = await callOpenAIStyleAPI(
        env,
        MODEL_REGISTRY[modelKey],
        systemPromptText,
        userPromptText,
        dynamicPrompt
    );
    await env.TEXT_CACHE.put(STORAGE_KEY, generatedContent);
    return generatedContent;
}

// ==========================================
// 5. 工具函数与 API 调用 (Service Layer)
// ==========================================

/**
 * 从远程 URL 获取动态 Prompt
 */
async function fetchRemotePrompt(env) {
    const token = env.UPDATE_TOKEN;
    if (!token) throw new Error("Missing UPDATE_TOKEN environment variable.");

    const response = await fetch(REMOTE_PROMPT_URL, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!response.ok) {
        const err = new Error(`Remote prompt fetch failed: ${response.status} ${response.statusText}`);
        err.statusCode = response.status;
        throw err;
    }

    return await response.text();
}

/**
 * 通用 LLM 调用函数 (OpenAI 兼容风格)
 */
async function callOpenAIStyleAPI(env, modelConfig, sysPrompt, userFixed, userDynamic) {
    const apiKey = env[modelConfig.apiKeyEnv];
    if (!apiKey) {
        throw new Error(`API Key not found for environment variable: ${modelConfig.apiKeyEnv}`);
    }

    const finalUserContent = `${userFixed}\n\n"${userDynamic}"`;
    
    const messages = [
        { role: "system", content: sysPrompt },
        { role: "user", content: finalUserContent }
    ];

    const payload = {
        model: modelConfig.id,
        messages: messages,
        ...modelConfig.parameters
    };

    console.log(`[LLM Service] Calling ${modelConfig.id} at ${modelConfig.endpoint}`);

    const response = await fetch(modelConfig.endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        let errorBody = "";
        try { errorBody = await response.text(); } catch (e) {}
        const error = new Error(`API Request Failed (${response.status}): ${errorBody.substring(0, 200)}`);
        error.statusCode = response.status;
        throw error;
    }

    const data = await response.json();
    
    // 提取关键字段
    const content = data?.choices?.[0]?.message?.content;
    const finishReason = data?.choices?.[0]?.finish_reason;

    // 如果没有内容，直接抛出 finish_reason (例如 "content_filter" 或 "length")
    if (!content) {
        // 使用 fallback 文本防止 finishReason 为 undefined
        throw new Error(finishReason || "Unknown error (no content returned)");
    }

    return content.trim();
}
