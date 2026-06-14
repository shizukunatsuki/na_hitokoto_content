# na_hitokoto_content

`na_hitokoto_content` 是 `na_hitokoto` 系列里的内容生成服务。

它运行在 Cloudflare Workers 上，定时从 `na_hitokoto_prompt` 获取动态 Prompt，调用 OpenAI 兼容格式的 LLM 接口生成一句文本，把最新文本写入自己的 KV 缓存，并把同一份生成结果写入 `na_hitokoto_history` 作为历史记录。

生产域名：

```text
https://content.hitokoto.natsuki.cloud
```

## 系列关系

当前系列大致分工如下：

- `na_hitokoto_prompt`：聚合外部语料并输出动态 Prompt。
- `na_hitokoto_content`：消费 Prompt，调用模型生成当前展示文本。
- `na_hitokoto_history`：保存生成历史，提供按内容或 ID 查询的历史接口。
- `na_hitokoto_page`：展示侧项目。

`na_hitokoto_content` 依赖：

- `https://prompt.hitokoto.natsuki.cloud/`
- `https://history.hitokoto.natsuki.cloud/add`
- Cloudflare KV binding：`TEXT_CACHE`
- Cloudflare secret：`ACCESS_TOKEN`
- 至少一个当前模型链路需要的模型 API key

## 当前行为

生成成功后，Worker 会按顺序执行：

1. 调用 `na_hitokoto_prompt` 获取动态 Prompt。
2. 调用当前模型角色对应的 OpenAI 兼容接口生成文本。
3. 将最新文本写入 `TEXT_CACHE`，key 为 `generated_text`。
4. 调用 `na_hitokoto_history` 的 `POST /add` 写入历史。
5. 返回生成文本。

注意：history 写入失败只会记录日志，不会让本次内容更新失败。这样即使 history 服务短暂不可用，`content` 的当前文本仍然会刷新。

## 路由

### `GET /`

公开接口，返回当前缓存的文本。

响应是 `text/plain; charset=utf-8`，正文末尾会追加一个换行符。

如果 `TEXT_CACHE` 中还没有 `generated_text`，会返回 `503`：

```text
Service warming up, content is generating...
```

### `POST /update`

受保护接口，用于手动触发一次内容生成。

请求头：

```http
Authorization: Bearer <ACCESS_TOKEN>
```

成功响应：

```json
{
  "success": true,
  "message": "Content refreshed successfully.",
  "model_used": "PRIMARY",
  "new_content": "..."
}
```

常见响应：

- `401`：没有 Bearer token，或 Authorization 格式不正确。
- `403`：Bearer token 存在但值不正确。
- `500`：Prompt 获取失败、所有模型链路失败，或 Worker 内部错误。

### `POST /modeltest`

受保护接口，用于临时测试某个 OpenAI 兼容模型端点。

请求头同样使用：

```http
Authorization: Bearer <ACCESS_TOKEN>
```

请求体：

```json
{
  "endpoint": "https://example.com/v1/chat/completions",
  "apikey": "model-api-key",
  "model_id": "model-name",
  "raw": false,
  "parameters": {
    "temperature": 1
  }
}
```

说明：

- `endpoint`、`apikey`、`model_id` 必填。
- `parameters` 可选，但必须是 JSON object。
- `raw` 为 `true` 或字符串 `"true"` 时，会透传上游响应。
- `raw` 为 false 时，只返回模型生成的文本。

## 定时任务

`wrangler.toml` 中配置了每小时整点执行：

```toml
[triggers]
crons = ["0 * * * *"]
```

Cron 会调用与 `/update` 相同的生成流程，但不会通过 HTTP 鉴权；它直接使用 Worker 环境变量和 secret。

## 模型回退策略

模型配置在 [src/index.js](/Users/natsuki/na/project/na_hitokoto/na_hitokoto_content/src/index.js) 中维护。

当前角色绑定：

```js
const MODEL_ROLE_BINDINGS = {
    PRIMARY: "QWEN",
    FALLBACK: "CF_KIMI_K2_6",
    FINAL: "GEMINI_FLASH_LATEST",
};
```

流程：

1. `PRIMARY` 最先尝试。
2. 如果 `PRIMARY` 返回 `429`，后续常规重试切换到 `FALLBACK`。
3. 常规阶段最多重试 `8` 次。
4. 常规阶段全部失败后，进入 `FINAL` 阶段，最多再试 `4` 次。
5. 所有阶段失败后，`/update` 返回 `500`。

当前模型 API key 环境变量：

- `QWEN` 使用 `QWEN_API_KEY`。
- `CF_KIMI_K2_6` 使用 `CLOUDFLARE_API_KEY` 和 `CLOUDFLARE_A_ID`。
- `GEMINI_FLASH_LATEST` 使用 `GEMINI_API_KEY`。
- 其他已定义但未绑定的模型可能使用 `OPENROUTER_API_KEY` 或 `GITHUB_API_KEY`。

## History 集成

默认写入地址：

```text
https://history.hitokoto.natsuki.cloud/add
```

可选覆盖变量：

```toml
HISTORY_API_URL = "https://history.hitokoto.natsuki.cloud/add"
```

鉴权策略：

- `content` 调用 `history` 时直接复用 `ACCESS_TOKEN`。
- `history` 侧的 `API_TOKEN` 必须与 `content` 侧的 `ACCESS_TOKEN` 保持一致。
- 本地测试时，当前约定使用环境变量 `na_hitokoto_token` 保存同一个 token。

写入 payload：

```json
{
  "new_content_id": "16位大写HEX",
  "new_content": "生成文本"
}
```

ID 规则：

- 由 `content` 生成 8 字节随机数，再转为 16 位大写 HEX。
- 不会使用保留值 `FFFFFFFFFFFFFFFF`。
- 如果 history 返回 `409 duplicate_id`，`content` 会重新生成 ID 并重试。
- 当前最多尝试 `3` 次。

重要行为：

- `POST /add` 写入 D1 后，`POST /match` 可以立即查到。
- `GET /get` 读取的是 history 的公开随机 KV 缓存，不保证刚写入后立即出现。
- history 的公开随机缓存由 history 自己的 cron 刷新，当前约为每 30 分钟一次。

## 配置

`wrangler.toml` 中的关键配置：

```toml
name = "na-hitokoto-content"
main = "src/index.js"
compatibility_date = "2026-02-01"

routes = [
    { pattern = "content.hitokoto.natsuki.cloud", custom_domain = true }
]

[[kv_namespaces]]
binding = "TEXT_CACHE"
id = "da58941aa79b41c890f4d2f155dc658a"
```

生产 secret 和变量需要在 Cloudflare 中配置。不要把 secret 明文提交到仓库。

必需：

- `ACCESS_TOKEN`
- `QWEN_API_KEY`，当 `PRIMARY` 仍绑定 `QWEN` 时必需

按当前回退链路建议配置：

- `CLOUDFLARE_API_KEY`
- `CLOUDFLARE_A_ID`
- `GEMINI_API_KEY`

可选：

- `HISTORY_API_URL`
- `OPENROUTER_API_KEY`
- `GITHUB_API_KEY`

## 本地开发

安装依赖：

```sh
npm install
```

启动本地 Worker：

```sh
npm run dev
```

部署：

```sh
npm run deploy
```

只做打包检查：

```sh
npm exec wrangler -- deploy --dry-run --outdir /private/tmp/na_hitokoto_content-dry-run
```

当前项目没有自动化单元测试。改动后至少应执行 Wrangler dry-run，并在生产部署后做 smoke test。

## 生产验证

公开接口 smoke test：

```sh
curl -i https://content.hitokoto.natsuki.cloud/
curl -i -X OPTIONS https://content.hitokoto.natsuki.cloud/update
curl -i -X POST https://content.hitokoto.natsuki.cloud/update
curl -i -X POST -H "Authorization: Bearer invalid-smoke-token" https://content.hitokoto.natsuki.cloud/update
curl -i https://content.hitokoto.natsuki.cloud/not-found-smoke
curl -i https://history.hitokoto.natsuki.cloud/get
```

预期：

- `GET /` 返回 `200` 和当前文本。
- `OPTIONS /update` 返回 `204`。
- 不带 token 的 `POST /update` 返回 `401`。
- 错误 token 的 `POST /update` 返回 `403`。
- 未知路径返回 `404`。
- `history /get` 返回 `200`，可能是 `{}`。

完整端到端验证需要 `na_hitokoto_token`：

```sh
curl -sS --max-time 240 \
  -X POST \
  -H "Authorization: Bearer ${na_hitokoto_token}" \
  https://content.hitokoto.natsuki.cloud/update
```

拿到响应中的 `new_content` 后，用 history `/match` 验证是否入库：

```sh
curl -sS --max-time 60 \
  -X POST \
  -H "Authorization: Bearer ${na_hitokoto_token}" \
  -H "Content-Type: application/json" \
  --data '{"key":["这里替换为 new_content"]}' \
  https://history.hitokoto.natsuki.cloud/match
```

预期返回：

```json
{
  "data": {
    "生成文本": "16位大写HEX ID"
  },
  "all_succeed": true,
  "failed": []
}
```

也可以用返回的 ID 反查：

```sh
curl -sS --max-time 60 \
  -X POST \
  -H "Authorization: Bearer ${na_hitokoto_token}" \
  -H "Content-Type: application/json" \
  --data '{"key":["16位大写HEX ID"]}' \
  https://history.hitokoto.natsuki.cloud/match
```

## 已验证状态

最近一次生产验证结果：

- `/update` 使用 `na_hitokoto_token` 返回 `200`。
- 返回模型角色为 `PRIMARY`。
- `GET /` 返回内容与 `/update` 的 `new_content` 一致，差异仅为末尾换行。
- history `/match` 按内容查询成功。
- history `/match` 按 ID 反查成功。
- 验证到的历史 ID 示例：`670242D4C929FC88`。

注意：这个 ID 只是一次生产验证样本，不是固定配置。

## 给后续 LLM 的接手说明

如果下一个对话要继续集成或排障，请先读这几个文件：

- [src/index.js](/Users/natsuki/na/project/na_hitokoto/na_hitokoto_content/src/index.js)
- [wrangler.toml](/Users/natsuki/na/project/na_hitokoto/na_hitokoto_content/wrangler.toml)
- [src/system_prompt.txt](/Users/natsuki/na/project/na_hitokoto/na_hitokoto_content/src/system_prompt.txt)
- [src/user_prompt.txt](/Users/natsuki/na/project/na_hitokoto/na_hitokoto_content/src/user_prompt.txt)

接手时不要假设 `GET /get` 为空就代表 history 写入失败。判断 history 写入是否成功，应优先使用 `POST /match` 按内容或 ID 查询。

不要新增单独的 `HISTORY_API_TOKEN`，当前设计是整个 `na_hitokoto` 系列复用同一个 `ACCESS_TOKEN`。

不要把 `na_hitokoto_token`、`ACCESS_TOKEN` 或任何模型 API key 写入仓库。

如果修改生成流程，必须确认这三个结果仍成立：

1. `TEXT_CACHE` 中的 `generated_text` 会刷新。
2. `/update` 返回的 `new_content` 与 `GET /` 一致。
3. 同一条 `new_content` 可以通过 history `/match` 查到。
