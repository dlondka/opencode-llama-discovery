# opencode-llama-discovery

A local [opencode](https://opencode.ai) plugin that discovers the models served by a
running `llama-server` and registers them under a plugin-owned `llamacpp` provider.

Once configured, llama.cpp models appear in `/models` alongside the built-in
providers, with context limits, vision/tool capabilities, and the correct model
identifier filled in automatically.

## Features

- Polls `GET /v1/models` on the llama.cpp server and registers every discovered model.
- Uses the server's runtime `meta.n_ctx` (falling back to `meta.n_ctx_train`) as the
  model context limit, so relaunching the server with a different `-c` updates it.
- Detects vision support from `architecture.input_modalities`.
- Keeps the last successful inventory when the server is temporarily unavailable.
- Supports llama-server API-key authentication (`--api-key` / `--api-key-file`).
- No build step: opencode's Bun runtime executes the TypeScript entrypoint directly.
- Works with the server's `--alias`, or falls back to a sanitized GGUF filename.

## Requirements

- opencode v2.2.5 or newer (the plugin uses the v2 plugin API).
- A running `llama-server` exposing the OpenAI-compatible `/v1/models` endpoint.
- If the server requires authentication, an API key available through
  `{file:...}` or `{env:...}` substitution.
- No extra runtime dependencies; TypeScript is only needed for development.

## Configuration

Add the plugin to your opencode config (`~/.config/opencode/opencode.jsonc`):

```jsonc
{
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-llama-discovery",
      "options": {
        "baseURL": "http://localhost:9931",
        // Optional; omit when llama-server has no --api-key.
        "apiKey": "{file:/absolute/path/to/llama-server.key}",
        "outputLimit": 8192,
        "pollInterval": 30000,
        "tools": true
      }
    }
  ]
}
```

The `package` value must be the absolute path to this project directory. opencode
resolves the directory's root `index.ts` as the plugin entrypoint.

### Options

| Option         | Default                 | Description                                                        |
| -------------- | ----------------------- | ------------------------------------------------------------------ |
| `baseURL`      | `http://localhost:9931` | llama-server root URL. A trailing `/v1` is also accepted.          |
| `apiKey`       | none                    | Bearer token for llama-server. Use `{file:...}` or `{env:...}`.    |
| `outputLimit`  | `8192`                  | Maximum output tokens. llama.cpp does not expose this value.       |
| `pollInterval` | `30000`                 | Milliseconds between `/v1/models` polls (minimum `1000`).          |
| `tools`        | `true`                  | Whether discovered models advertise tool-calling support.          |

### Server authentication

If `llama-server` was started with `--api-key` or `--api-key-file`, configure the
same key for the plugin:

```jsonc
"apiKey": "{file:/absolute/path/to/llama-server.key}"
```

or:

```jsonc
"apiKey": "{env:LLAMA_API_KEY}"
```

The plugin sends `Authorization: Bearer <key>` when polling `/v1/models` and sets
the provider's `apiKey`, so inference requests authenticate as well.

`/health` is public, but `/v1/models` and the inference endpoints require the key.
Without a valid key, discovery logs `HTTP 401 (check apiKey)` and keeps the last
successful inventory; on a first start, no models are registered.

Use opencode's `{file:...}` or `{env:...}` substitution instead of hardcoding the
key in `opencode.jsonc`.

## How it works

1. On startup the plugin requests `{baseURL}/v1/models` with a 1.5 s timeout,
   sending `Authorization: Bearer <apiKey>` when `apiKey` is configured.
2. Each model is mapped into an opencode provider model:
   - `providerID/id` is a URL-safe slug of the GGUF basename.
   - The raw GGUF path is kept as the API-facing `modelID`.
   - The display name is the first alias when it is a short name, otherwise the
     GGUF basename without `.gguf`.
   - `limit.context` comes from `meta.n_ctx` or `meta.n_ctx_train`.
   - `limit.output` comes from the `outputLimit` option.
3. The `llamacpp` provider is registered through `ctx.provider.transform(...)`,
   using the `@ai-sdk/openai-compatible` provider package with
   `settings.baseURL = {baseURL}/v1` and `settings.apiKey` when configured.
4. The inventory is polled every `pollInterval`. When it changes, the provider is
   updated and reloaded.
5. Failed polls keep the previous inventory, so models do not disappear during a
   brief server restart. They are replaced as soon as the server responds again.

## Development

```sh
npm install
npm run typecheck
```

Check that opencode loads the plugin and discovers models:

```sh
opencode models --standalone | grep llamacpp
```

Run a chat against a discovered model:

```sh
opencode run --standalone -m llamacpp/<model-id> "Reply with exactly: ok"
```

Plugin activity is logged with the `[llamacpp-discovery]` prefix.

## Project layout

```text
opencode-llama-discovery/
├── README.md
├── index.ts          # plugin entrypoint
├── package.json      # project metadata and typecheck script
├── package-lock.json
└── tsconfig.json
```

## Limitations

- One server per plugin instance; use separate config entries for multiple servers.
- The plugin sends one API key per provider instance. llama-server may accept
  multiple keys, but the plugin uses the configured one.
- There is no per-model access control; llama-server authentication is server-wide.
- The server does not expose a maximum output length, so `outputLimit` is manual.
- The plugin does not change the server's `--alias` or launch arguments.
- A malformed `/v1/models` response is treated as a failed poll, not an empty inventory.

## Acknowledgements

Development of this project was assisted by AI.
