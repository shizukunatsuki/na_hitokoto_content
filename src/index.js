// 从文本文件导入 prompts
import system_prompt_text from './system_prompt.txt';
import user_prompt_text from './user_prompt.txt';

// --- 配置常量 ---
const KV_KEY = "generated_text";
const EXTERNAL_PROMPT_URL = "https://prompt.hitokoto.natsuki.cloud";
const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent";

// 重试策略配置
const RETRY_ATTEMPTS = 3; // 自动更新失败时的最大重试次数
const RETRY_DELAY_MS = 2000; // 每次重试之间的延迟（毫秒）

// CORS 头部配置
const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
};

export default {
    /**
     * 主 HTTP 请求处理器
     */
    async fetch(request, env, ctx) {
        if (request.method === 'OPTIONS') {
            return this.handle_options(request);
        }

        const url = new URL(request.url);

        switch (url.pathname) {
            case '/':
                return this.handle_get_text(request, env);
            case '/update':
                return this.handle_force_update(request, env);
            default:
                return new Response('Not Found\n', { 
                    status: 404,
                    headers: CORS_HEADERS 
                });
        }
    },

    /**
     * Cron 触发的计划任务处理器
     */
    async scheduled(event, env, ctx) {
        console.log(`[${new Date().toISOString()}] Cron job triggered. Starting update process with retries.`);
        ctx.waitUntil(this.run_update_with_retries(env));
    },

    /**
     * 带重试逻辑的更新执行器，供 scheduled 任务调用
     * @param {object} env
     */
    async run_update_with_retries(env) {
        for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
            try {
                await this.update_kv_text(env);
                console.log(`Update successful on attempt ${attempt}/${RETRY_ATTEMPTS}.`);
                return; // 成功后立即退出
            } catch (error) {
                console.error(`Attempt ${attempt}/${RETRY_ATTEMPTS} failed: ${error.message}`);
                if (attempt < RETRY_ATTEMPTS) {
                    await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
                } else {
                    console.error("All retry attempts failed. The content was not updated by the cron job.");
                }
            }
        }
    },

    /**
     * 处理 OPTIONS 预检请求
     */
    handle_options(request) {
        return new Response(null, {
            status: 204,
            headers: CORS_HEADERS,
        });
    },
    
    /**
     * 处理根路径 '/' 的请求
     */
    async handle_get_text(request, env) {
        try {
            const cached_text = await env.TEXT_CACHE.get(KV_KEY);
            if (cached_text) {
                return new Response(cached_text + '\n', {
                    headers: { 'Content-Type': 'text/plain; charset=utf-8', ...CORS_HEADERS },
                });
            } else {
                return new Response("内容正在生成中，请稍后刷新重试。\n", {
                    status: 503,
                    headers: { 'Content-Type': 'text/plain; charset=utf-8', ...CORS_HEADERS },
                });
            }
        } catch (error) {
            console.error("Error in handle_get_text:", error);
            return new Response(`服务器内部错误: ${error.message}\n`, { 
                status: 500,
                headers: { 'Content-Type': 'text/plain; charset=utf-8', ...CORS_HEADERS }
            });
        }
    },

    /**
     * 处理 '/update' 路径的强制更新请求 (无重试，立即反馈)
     */
    async handle_force_update(request, env) {
        if (request.method !== 'POST') {
            return new Response('Method Not Allowed. Please use POST.\n', { status: 405, headers: CORS_HEADERS });
        }
        const correct_token = env.UPDATE_TOKEN;
        if (!correct_token) {
            console.error("UPDATE_TOKEN secret is not set in the environment.");
            return new Response('Server configuration error: Update token not set.\n', { status: 500, headers: CORS_HEADERS });
        }
        const auth_header = request.headers.get('Authorization');
        if (!auth_header || !auth_header.startsWith('Bearer ')) {
            return new Response('Authorization header is missing or invalid.\n', { status: 401, headers: CORS_HEADERS });
        }
        const submitted_token = auth_header.split(' ')[1];
        if (submitted_token !== correct_token) {
            return new Response('Forbidden: Invalid token.\n', { status: 403, headers: CORS_HEADERS });
        }

        try {
            console.log("Manual update triggered via /update endpoint.");
            await this.update_kv_text(env);
            const success_response = { success: true, message: 'Text content updated successfully.' };
            return new Response(JSON.stringify(success_response) + '\n', {
                status: 200,
                headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
            });
        } catch (error) {
            console.error("Error during manual update:", error);
            const error_response = { success: false, message: `Failed to update: ${error.message}` };
            return new Response(JSON.stringify(error_response) + '\n', {
                status: 500,
                headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
            });
        }
    },

    /**
     * 更新 KV 中存储文本的核心函数
     */
    async update_kv_text(env) {
        try {
            const external_prompt = await get_external_prompt();
            const new_text = await generate_text_with_llm(
                system_prompt_text,
                user_prompt_text,
                external_prompt,
                env.GEMINI_API_KEY
            );
            await env.TEXT_CACHE.put(KV_KEY, new_text);
            console.log("Successfully generated and stored new text in KV.");
        } catch (error) {
            console.error("Error during text generation and storage:", error);
            throw error;
        }
    }
};

/**
 * 从外部 URL 获取 prompt
 */
async function get_external_prompt() {
    console.log(`Fetching external prompt from: ${EXTERNAL_PROMPT_URL}`);
    const response = await fetch(EXTERNAL_PROMPT_URL);
    if (!response.ok) {
        throw new Error(`无法从外部 URL 获取 prompt，状态码: ${response.status}`);
    }
    const text = await response.text();
    console.log(`Successfully fetched external prompt: "${text}"`);
    return text;
}

/**
 * 调用 Google Gemini API 生成文本 (已包含最终的 temperature 设置)
 */
async function generate_text_with_llm(system_prompt, fixed_user_prompt, dynamic_user_prompt, api_key) {
    if (!api_key) {
        throw new Error("GEMINI_API_KEY 未设置。请在 Cloudflare Worker 的环境变量中配置它。");
    }
    const final_user_prompt = `${fixed_user_prompt}\n\n"${dynamic_user_prompt}"`;
    const request_body = {
        "systemInstruction": { "parts": [{ "text": system_prompt }] },
        "contents": [{ "role": "user", "parts": [{ "text": final_user_prompt }] }],
        "safetySettings": [
            { "category": "HARM_CATEGORY_HARASSMENT", "threshold": "BLOCK_NONE" },
            { "category": "HARM_CATEGORY_HATE_SPEECH", "threshold": "BLOCK_NONE" },
            { "category": "HARM_CATEGORY_SEXUALLY_EXPLICIT", "threshold": "BLOCK_NONE" },
            { "category": "HARM_CATEGORY_DANGEROUS_CONTENT", "threshold": "BLOCK_NONE" }
        ],
        "generationConfig": {
            "temperature": 2.0, // 新增：将 temperature 设置为最大值以获得最高创造力
            "thinkingConfig": {
                "thinkingBudget": 32768
            }
        }
    };
    
    console.log("Calling Gemini API with final performance and creativity settings...");
    const response = await fetch(GEMINI_API_URL, {
        method: 'POST',
        headers: { 
            'Content-Type': 'application/json', 
            'X-goog-api-key': api_key 
        },
        body: JSON.stringify(request_body),
    });

    if (!response.ok) {
        const error_text = await response.text();
        throw new Error(`LLM API 请求失败，状态码: ${response.status}, 响应: ${error_text}`);
    }

    const data = await response.json();
    const generated_text = data?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!generated_text) {
        const finish_reason = data?.candidates?.[0]?.finishReason;
        if (finish_reason === 'SAFETY') {
             console.error("LLM API response blocked due to safety reasons, despite settings. Response:", JSON.stringify(data));
             throw new Error("LLM API 响应因安全原因被阻止。");
        }
        console.error("LLM API 响应格式不正确或未返回内容:", JSON.stringify(data));
        throw new Error("LLM API 未返回有效的文本内容。");
    }

    console.log("Successfully generated text from LLM.");
    return generated_text.trim();
}
