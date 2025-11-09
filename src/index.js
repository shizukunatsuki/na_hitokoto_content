// 从文本文件导入 prompts
import system_prompt_text from './system_prompt.txt';
import user_prompt_text from './user_prompt.txt';

// --- 配置常量 ---
const KV_KEY = "generated_text";
const EXTERNAL_PROMPT_URL = "https://prompt.hitokoto.natsuki.cloud/";

// 模型配置
const MODEL_CONFIG = {
    'gemini-pro-latest': {
        api_url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro-latest:generateContent",
        thinking_budget: 32768,
    },
    'gemini-flash-latest': {
        api_url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent",
        thinking_budget: 24576,
    },
};
const PRIMARY_MODEL = 'gemini-pro-latest';
const FALLBACK_MODEL = 'gemini-flash-latest';

// 重试策略配置
const RETRY_ATTEMPTS = 16; // 更新失败时的最大重试次数

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
        console.log(`[${new Date().toISOString()}] Cron job triggered. Starting update process with retries and fallback.`);
        ctx.waitUntil(
            this.run_update_with_retries(env).catch(err => {
                console.error("Cron job failed after all retries:", err.message);
            })
        );
    },

    /**
     * 带精确重试和回退逻辑的统一更新执行器
     * @param {object} env
     * @returns {Promise<{model_used: string, new_content: string}>} 成功时返回包含所用模型和新内容的对象
     * @throws {Error} 所有重试尝试失败后抛出错误
     */
    async run_update_with_retries(env) {
        let model_for_this_attempt = PRIMARY_MODEL;

        for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
            try {
                const new_content = await this.update_kv_text(env, model_for_this_attempt);
                
                // [增强] 在成功日志中输出新内容，便于追踪
                console.log(`Update successful on attempt ${attempt}/${RETRY_ATTEMPTS} using model: ${model_for_this_attempt}. New content: "${new_content}"`);
                
                return { model_used: model_for_this_attempt, new_content: new_content };
            } catch (error) {
                console.error(`Attempt ${attempt}/${RETRY_ATTEMPTS} with model ${model_for_this_attempt} failed: ${error.message}`);

                if (attempt < RETRY_ATTEMPTS) {
                    if (model_for_this_attempt === PRIMARY_MODEL && error.status_code === 429) {
                        console.log("Primary model received 429. Falling back to the fallback model for the next attempt.");
                        model_for_this_attempt = FALLBACK_MODEL;
                    } else {
                        console.log(`Retrying with the same model: ${model_for_this_attempt}.`);
                    }
                }
            }
        }
        
        throw new Error("All retry attempts failed. The content was not updated.");
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
     * 处理 '/update' 路径的强制更新请求
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
            console.log("Manual update triggered via /update endpoint. Initiating update with retries/fallback.");
            const update_result = await this.run_update_with_retries(env);
            
            // [增强] 在成功的 JSON 响应中添加 new_content 字段
            const success_response = { 
                success: true, 
                message: 'Text content updated successfully.',
                model_used: update_result.model_used,
                new_content: update_result.new_content 
            };
            return new Response(JSON.stringify(success_response, null, 2) + '\n', { // 使用 null, 2 美化 JSON 输出
                status: 200,
                headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
            });
        } catch (error) {
            console.error("Error during manual update after all retries:", error);
            const error_response = { 
                success: false, 
                message: `Failed to update after all retries: ${error.message}` 
            };
            return new Response(JSON.stringify(error_response, null, 2) + '\n', {
                status: 500,
                headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
            });
        }
    },

    /**
     * 更新 KV 中存储文本的核心函数
     * @param {object} env
     * @param {string} model_name - 要使用的模型名称
     * @returns {Promise<string>} 返回新生成的文本
     */
    async update_kv_text(env, model_name) {
        try {
            const external_prompt = await get_external_prompt(env);
            const new_text = await generate_text_with_llm(
                system_prompt_text,
                user_prompt_text,
                external_prompt,
                env.GEMINI_API_KEY,
                model_name
            );
            await env.TEXT_CACHE.put(KV_KEY, new_text);
            console.log(`Successfully generated and stored new text in KV using model: ${model_name}.`);
            
            // [核心修改] 将新生成的文本返回给调用者
            return new_text; 
        } catch (error) {
            // 将错误向上抛出，由上层重试逻辑统一处理
            throw error;
        }
    }
};

/**
 * 从外部 URL 获取 prompt
 */
async function get_external_prompt(env) {
    console.log(`Fetching external prompt via POST from: ${EXTERNAL_PROMPT_URL}`);

    const access_token = env.UPDATE_TOKEN;
    if (!access_token) {
        throw new Error("UPDATE_TOKEN 环境变量未设置，无法从外部 URL 获取 prompt。");
    }

    const response = await fetch(EXTERNAL_PROMPT_URL, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${access_token}`
        }
    });

    if (!response.ok) {
        const error_text = await response.text();
        const error = new Error(`无法从外部 URL 获取 prompt，状态码: ${response.status}, 响应: ${error_text}`);
        error.status_code = response.status; // 附加状态码以便上层逻辑判断
        throw error;
    }

    const text = await response.text();
    console.log(`Successfully fetched external prompt: "${text}"`);
    return text;
}

/**
 * 使用指定的 LLM 模型生成文本
 */
async function generate_text_with_llm(system_prompt, fixed_user_prompt, dynamic_user_prompt, api_key, model_name) {
    if (!api_key) {
        throw new Error("GEMINI_API_KEY 未设置。请在 Cloudflare Worker 的环境变量中配置它。");
    }
    
    const model_config = MODEL_CONFIG[model_name];
    if (!model_config) {
        throw new Error(`未知的模型名称: ${model_name}`);
    }

    const final_user_prompt = `${fixed_user_prompt}\n\n"${dynamic_user_prompt}"`;
    
    const request_body = {
        "systemInstruction": { "parts": [{ "text": system_prompt }] },
        "contents": [{ "role": "user", "parts": [{ "text": final_user_prompt }] }],
        "safetySettings": [
            { "category": "HARM_CATEGORY_HARASSMENT", "threshold": "OFF" },
            { "category": "HARM_CATEGORY_HATE_SPEECH", "threshold": "OFF" },
            { "category": "HARM_CATEGORY_SEXUALLY_EXPLICIT", "threshold": "OFF" },
            { "category": "HARM_CATEGORY_DANGEROUS_CONTENT", "threshold": "OFF" }
        ],
        "generationConfig": {
            "temperature": 2.0,
            "thinkingConfig": {
                "thinkingBudget": model_config.thinking_budget 
            }
        }
    };
       
    console.log(`Calling Gemini API with model: ${model_name}, thinking budget: ${model_config.thinking_budget}...`);
    const response = await fetch(model_config.api_url, {
        method: 'POST',
        headers: { 
            'Content-Type': 'application/json', 
            'X-goog-api-key': api_key 
        },
        body: JSON.stringify(request_body),
    });

    if (!response.ok) {
        const error_text = await response.text();
        const error = new Error(`LLM API 请求失败，状态码: ${response.status}, 响应: ${error_text}`);
        error.status_code = response.status; // 附加状态码以便上层逻辑判断
        throw error;
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
