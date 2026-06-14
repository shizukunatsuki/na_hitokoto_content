# na_hitokoto_content

Cloudflare Worker that generates the current `na_hitokoto` text, stores it in
`TEXT_CACHE`, and writes the generated result to `na_hitokoto_history`.

## History integration

After each successful generation, the Worker:

1. stores the latest text in KV under `generated_text`;
2. calls `https://history.hitokoto.natsuki.cloud/add`;
3. sends the same `ACCESS_TOKEN` as a Bearer token.

History write failures are logged but do not fail the content update, so the
current content endpoint remains available even if the history service is
temporarily unavailable.

Optional runtime variable:

```toml
HISTORY_API_URL = "https://history.hitokoto.natsuki.cloud/add"
```
