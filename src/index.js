/**
 * AI Content Generator Worker
 * 功能：定期从外部源获取 Prompt，调用 AI 模型生成内容并缓存至 Cloudflare KV。
 * 特性：支持 OpenAI 接口标准，具备 "主模型 -> 备用模型 -> 最终保底" 的三级容灾机制。
 */

// 导入静态 Prompt 文件
import systemPromptText from './system_prompt.txt';
import userPromptText from './user_prompt.txt';

// ==========================================
// 1. 全局配置与常量定义
// ==========================================

/** KV 存储键名 */
const STORAGE_KEY = "generated_text";

/** 外部动态 Prompt 获取地址 */
const REMOTE_PROMPT_URL = "https://prompt.hitokoto.natsuki.cloud/";

/** 重试策略配置 (仅针对 Primary/Fallback 阶段) */
const RETRY_CONFIG = {
    MAX_ATTEMPTS: 8,      // 主/备循环的最大重试次数
    DELAY_SECONDS: 2      // 重试间隔（秒）
};

/** 跨域资源共享 (CORS) 头配置 */
const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
};

/**
 * 模型策略配置中心
 * 包含三级模型：PRIMARY (主力), FALLBACK (备用), FINAL (绝地反击)
 */
const MODEL_REGISTRY = {
    // 【第一级】主模型
    PRIMARY: {
        id: "gemini-3-flash-preview",
        endpoint: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
        apiKeyEnv: "GEMINI_API_KEY",
        parameters: {
            temperature: 2.0,
            reasoning_effort: "high",
        }
    },
    // 【第二级】备用模型
    FALLBACK: {
        id: "gemini-2.5-flash",
        endpoint: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
        apiKeyEnv: "GEMINI_API_KEY",
        parameters: {
            temperature: 2.0,
            reasoning_effort: "high",
        }
    },
    // 【第三级】最终保底模型
    FINAL: {
        id: "gpt-4.1", 
        endpoint: "https://models.inference.ai.azure.com/chat/completions",
        apiKeyEnv: "GITHUB_API_KEY",
        parameters: {
            temperature: 1.0,
            //reasoning_effort: "high",
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

async function handleManualUpdate(request, env) {
    if (request.method !== 'POST') {
        return new Response('Method Not Allowed. Use POST.\n', { status: 405, headers: CORS_HEADERS });
    }

    const serverToken = env.UPDATE_TOKEN;
    if (!serverToken) return new Response('Server configuration error.\n', { status: 500, headers: CORS_HEADERS });

    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return new Response('Unauthorized: Missing or invalid Bearer token.\n', { status: 401, headers: CORS_HEADERS });
    }

    if (authHeader.split(' ')[1] !== serverToken) {
        return new Response('Forbidden: Invalid token.\n', { status: 403, headers: CORS_HEADERS });
    }

    try {
        console.log("[API] Manual update triggered.");
        const result = await executeResilientUpdate(env);

        return new Response(JSON.stringify({
            success: true,
            message: 'Content refreshed successfully.',
            model_used: result.model,
            new_content: result.content
        }, null, 2) + '\n', {
            status: 200,
            headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
        });

    } catch (error) {
        console.error(`[API] Update failed: ${error.message}`);
        return new Response(JSON.stringify({
            success: false,
            message: `Update failed after final attempt: ${error.message}`
        }, null, 2) + '\n', {
            status: 500,
            headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
        });
    }
}

// ==========================================
// 4. 核心业务逻辑 (Controller)
// ==========================================

/**
 * 执行具备多级容错能力的更新流程
 * 流程：获取Prompt(仅1次) -> Primary/Fallback 循环重试 -> 全部失败 -> Final 模型最后尝试 -> 抛出异常
 */
async function executeResilientUpdate(env) {
    let currentModelKey = 'PRIMARY';
    const { MAX_ATTEMPTS, DELAY_SECONDS } = RETRY_CONFIG;
    let lastError = null;

    // 1. 预先获取动态 Prompt (避免重试时重复请求)
    let dynamicPrompt;
    try {
        dynamicPrompt = await fetchRemotePrompt(env);
    } catch (fetchErr) {
        // 如果连 Prompt 都获取不到，直接失败，无需尝试 AI 生成
        throw new Error(`Critical Dependency Failure: Unable to fetch prompt. ${fetchErr.message}`);
    }

    // --- 阶段一：常规重试循环 (Primary & Fallback) ---
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            console.log(`[Update Cycle] Attempt ${attempt}/${MAX_ATTEMPTS} using [${currentModelKey}]...`);

            // 将预获取的 prompt 传入
            const generatedText = await generateAndCacheContent(env, currentModelKey, dynamicPrompt);

            console.log(`[Update Cycle] Success. Content length: ${generatedText.length}`);
            return { model: currentModelKey, content: generatedText };

        } catch (error) {
            lastError = error;
            console.warn(`[Update Cycle] Attempt ${attempt} failed: ${error.message}`);

            // 智能降级逻辑 (Primary -> Fallback)
            if (currentModelKey === 'PRIMARY' && (error.statusCode === 429)) {
                console.log(`[Failover] Switching strategy: PRIMARY -> FALLBACK for next attempt.`);
                currentModelKey = 'FALLBACK';
            }

            // 如果不是最后一次尝试，则等待重试
            if (attempt < MAX_ATTEMPTS && DELAY_SECONDS > 0) {
                await new Promise(resolve => setTimeout(resolve, DELAY_SECONDS * 1000));
            }
        }
    }

    // --- 阶段二：绝地反击 (Final Model) ---
    console.warn(`[Critical] All ${MAX_ATTEMPTS} standard attempts failed. Engaging FINAL model protocol.`);
    
    try {
        console.log(`[Final Stand] Attempting generation using [FINAL] model...`);
        // 使用同一个 prompt 进行最后尝试
        const finalContent = await generateAndCacheContent(env, 'FINAL', dynamicPrompt);
        
        console.log(`[Final Stand] Success! The FINAL model saved the execution.`);
        return { model: 'FINAL', content: finalContent };
        
    } catch (finalError) {
        throw new Error(`CRITICAL FAILURE: All strategies exhausted. 
            Standard Retries Last Error: ${lastError?.message}
            Final Model Error: ${finalError.message}`);
    }
}

/**
 * 编排内容生成流程
 */
async function generateAndCacheContent(env, modelKey, dynamicPrompt) {
    // 检查配置是否存在
    if (!MODEL_REGISTRY[modelKey]) {
        throw new Error(`Model configuration for '${modelKey}' not found.`);
    }

    // 使用传入的 dynamicPrompt
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

    console.log(`[Prompt Service] Fetching from ${REMOTE_PROMPT_URL}`);
    const response = await fetch(REMOTE_PROMPT_URL, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!response.ok) {
        const err = new Error(`Remote prompt fetch failed: ${response.status}`);
        err.statusCode = response.status;
        throw err;
    }

    const text = await response.text();
    console.log(`[Prompt Service] Fetched ${text.length} chars.`);
    return text;
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

    console.log(`[LLM Service] Calling ${modelConfig.id}`);

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
    
    const content = data?.choices?.[0]?.message?.content;
    const finishReason = data?.choices?.[0]?.finish_reason;

    if (!content) {
        throw new Error(finishReason || "Unknown error (no content returned)");
    }

    return content.trim();
}
