// 从文本文件导入 prompts
import system_prompt_text from './system_prompt.txt';
import user_prompt_text from './user_prompt.txt';

// 定义常量
const KV_KEY = "generated_text";
const EXTERNAL_PROMPT_URL = "https://prompt.hitokoto.natsuki.cloud";
const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent";

// 定义通用的 CORS 头部，以便复用
const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
};

export default {
    /**
     * 处理 HTTP 请求的处理器，完整支持 CORS。
     * @param {Request} request - 传入的请求对象
     * @param {object} env - 环境变量和绑定
     * @param {object} ctx - 执行上下文
     * @returns {Response} - 返回给客户端的响应
     */
    async fetch(request, env, ctx) {
        // 处理浏览器的 CORS 预检请求 (preflight request)
        if (request.method === 'OPTIONS') {
            return this.handle_options(request);
        }

        const url = new URL(request.url);

        // 路由逻辑
        switch (url.pathname) {
            case '/':
                return this.handle_get_text(request, env);
            case '/update':
                return this.handle_force_update(request, env);
            default:
                // 为 404 响应也添加 CORS 头部和换行符
                return new Response('Not Found\n', { 
                    status: 404,
                    headers: CORS_HEADERS 
                });
        }
    },

    /**
     * 由 Cron 触发的计划任务处理器
     * @param {ScheduledEvent} event - 计划事件对象
     * @param {object} env - 环境变量和绑定
     * @param {object} ctx - 执行上下文
     */
    async scheduled(event, env, ctx) {
        console.log(`[${new Date().toISOString()}] Cron job triggered. Starting text generation.`);
        ctx.waitUntil(this.update_kv_text(env));
    },

    /**
     * 处理 OPTIONS 预检请求的处理器
     * @param {Request} request
     */
    handle_options(request) {
        // 直接返回带有 CORS 许可的空响应
        return new Response(null, {
            status: 204, // No Content
            headers: CORS_HEADERS,
        });
    },
    
    /**
     * 处理根路径 '/' 的请求
     * @param {Request} request
     * @param {object} env
     */
    async handle_get_text(request, env) {
        try {
            const cached_text = await env.TEXT_CACHE.get(KV_KEY);
            if (cached_text) {
                return new Response(cached_text + '\n', {
                    headers: {
                        'Content-Type': 'text/plain; charset=utf-8',
                        ...CORS_HEADERS,
                    },
                });
            } else {
                return new Response("内容正在生成中，请稍后刷新重试。\n", {
                    status: 503,
                    headers: {
                        'Content-Type': 'text/plain; charset=utf-8',
                        ...CORS_HEADERS,
                    },
                });
            }
        } catch (error) {
            console.error("Error in handle_get_text:", error);
            return new Response(`服务器内部错误: ${error.message}\n`, { 
                status: 500,
                headers: {
                    'Content-Type': 'text/plain; charset=utf-8',
                    ...CORS_HEADERS,
                }
            });
        }
    },

    /**
     * 处理 '/update' 路径的强制更新请求
     * @param {Request} request
     * @param {object} env
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
                headers: {
                    'Content-Type': 'application/json',
                    ...CORS_HEADERS,
                },
            });
        } catch (error) {
            console.error("Error during manual update:", error);
            const error_response = { success: false, message: `Failed to update: ${error.message}` };
            return new Response(JSON.stringify(error_response) + '\n', {
                status: 500,
                headers: {
                    'Content-Type': 'application/json',
                    ...CORS_HEADERS,
                },
            });
        }
    },

    /**
     * 更新 KV 中存储文本的核心函数 (被 scheduled 和 handle_force_update 共用)
     * @param {object} env - 环境变量和绑定
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
 * @returns {Promise<string>} - 返回获取到的 prompt 文本
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
 * 调用 Google Gemini API 生成文本
 * @param {string} system_prompt - 系统指令
 * @param {string} fixed_user_prompt - 固定的用户指令
 * @param {string} dynamic_user_prompt - 动态获取的用户指令
 * @param {string} api_key - Gemini API Key
 * @returns {Promise<string>} - 返回 LLM 生成的文本
 */
async function generate_text_with_llm(system_prompt, fixed_user_prompt, dynamic_user_prompt, api_key) {
    if (!api_key) {
        throw new Error("GEMINI_API_KEY 未设置。请在 Cloudflare Worker 的环境变量中配置它。");
    }
    const final_user_prompt = `${fixed_user_prompt}\n\n"${dynamic_user_prompt}"`;
    const request_body = {
        "systemInstruction": { "parts": [{ "text": system_prompt }] },
        "contents": [{ "role": "user", "parts": [{ "text": final_user_prompt }] }]
    };
    const response = await fetch(GEMINI_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-goog-api-key': api_key },
        body: JSON.stringify(request_body),
    });
    if (!response.ok) {
        const error_text = await response.text();
        throw new Error(`LLM API 请求失败，状态码: ${response.status}, 响应: ${error_text}`);
    }
    const data = await response.json();
    const generated_text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!generated_text) {
        console.error("LLM API 响应格式不正确或未返回内容:", JSON.stringify(data));
        throw new Error("LLM API 未返回有效的文本内容。");
    }
    console.log("Successfully generated text from LLM.");
    return generated_text.trim();
}
