// 从文本文件导入 prompts
import system_prompt_text from './system_prompt.txt';
import user_prompt_text from './user_prompt.txt';

// 定义常量
const KV_KEY = "generated_text";
const EXTERNAL_PROMPT_URL = "https://prompt.hitokoto.natsuki.cloud";
const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent";

export default {
    /**
     * 处理 HTTP 请求的处理器，现在包含路由逻辑。
     * @param {Request} request - 传入的请求对象
     * @param {object} env - 环境变量和绑定
     * @param {object} ctx - 执行上下文
     * @returns {Response} - 返回给客户端的响应
     */
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        // 路由：根据请求路径执行不同逻辑
        switch (url.pathname) {
            case '/':
                // 根路径：从 KV 读取并返回内容
                return this.handle_get_text(request, env);

            case '/update':
                // 更新路径：执行带认证的强制更新
                return this.handle_force_update(request, env);

            default:
                // 其他路径：返回 404
                return new Response('Not Found', { status: 404 });
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
     * 处理根路径 '/' 的请求
     */
    async handle_get_text(request, env) {
        try {
            const cached_text = await env.TEXT_CACHE.get(KV_KEY);
            if (cached_text) {
                return new Response(cached_text, {
                    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
                });
            } else {
                return new Response("内容正在生成中，请稍后刷新重试。", {
                    status: 503,
                    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
                });
            }
        } catch (error) {
            console.error("Error in handle_get_text:", error);
            return new Response(`服务器内部错误: ${error.message}`, { status: 500 });
        }
    },

    /**
     * 处理 '/update' 路径的强制更新请求
     */
    async handle_force_update(request, env) {
        if (request.method !== 'POST') {
            return new Response('Method Not Allowed. Please use POST.', { status: 405 });
        }

        const correct_token = env.UPDATE_TOKEN;
        if (!correct_token) {
            console.error("UPDATE_TOKEN secret is not set in the environment.");
            return new Response('Server configuration error: Update token not set.', { status: 500 });
        }

        const auth_header = request.headers.get('Authorization');
        if (!auth_header || !auth_header.startsWith('Bearer ')) {
            return new Response('Authorization header is missing or invalid.', { status: 401 });
        }

        const submitted_token = auth_header.split(' ')[1];
        if (submitted_token !== correct_token) {
            return new Response('Forbidden: Invalid token.', { status: 403 });
        }

        try {
            console.log("Manual update triggered via /update endpoint.");
            await this.update_kv_text(env);
            return new Response(JSON.stringify({ success: true, message: 'Text content updated successfully.' }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        } catch (error) {
            console.error("Error during manual update:", error);
            return new Response(JSON.stringify({ success: false, message: `Failed to update: ${error.message}` }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
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

// --- 辅助函数 (无变化) ---

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
