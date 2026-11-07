/**
 * opencode plugin: discover models from a running `llama-server` and register
 * them under a plugin-owned `llamacpp` provider.
 *
 * The server's `/v1/models` response carries the raw GGUF path, the aliases,
 * the input modalities, and the runtime `meta.n_ctx`. That is everything the
 * provider registry needs except the maximum output length, which is a plugin
 * option because llama.cpp does not expose one.
 *
 * The inventory is polled so a server restart with a different `-c` value
 * updates the model's context limit. A failed poll keeps the last successful
 * inventory, so a briefly unavailable server does not make models disappear.
 */

const PROVIDER_ID = "llamacpp"
const PROVIDER_NAME = "llama.cpp"
const DEFAULT_BASE_URL = "http://localhost:9931"
const DEFAULT_OUTPUT_LIMIT = 8192
const DEFAULT_POLL_INTERVAL = 30_000
const MIN_POLL_INTERVAL = 1_000
const FALLBACK_CONTEXT_LIMIT = 8192
const REQUEST_TIMEOUT_MS = 1_500

type Options = {
  readonly apiKey?: unknown
  readonly baseURL?: unknown
  readonly outputLimit?: unknown
  readonly pollInterval?: unknown
  readonly tools?: unknown
}

type NormalizedOptions = {
  readonly outputLimit: number
  readonly tools: boolean
}

type RemoteModel = {
  readonly id?: unknown
  readonly aliases?: unknown
  readonly architecture?: { readonly input_modalities?: unknown }
  readonly created?: unknown
  readonly meta?: {
    readonly n_ctx?: unknown
    readonly n_ctx_train?: unknown
  }
}

type DiscoveredModel = {
  readonly id: string
  readonly modelID: string
  readonly providerID: string
  readonly name: string
  readonly capabilities: {
    readonly tools: boolean
    readonly input: readonly string[]
    readonly output: readonly string[]
  }
  readonly variants: readonly never[]
  readonly time: { readonly released: number }
  readonly cost: readonly never[]
  readonly status: "active"
  readonly enabled: true
  readonly limit: {
    readonly context: number
    readonly output: number
  }
}

type ProviderEditor = {
  get(id: string): unknown
  update(id: string, update: (provider: Record<string, unknown>) => void): void
  readonly models: {
    set(id: string, models: readonly DiscoveredModel[]): void
  }
}

type Registration = {
  dispose(): Promise<void> | void
}

type Context = {
  readonly options?: Options
  readonly provider: {
    transform(callback: (editor: ProviderEditor) => void): Promise<Registration>
    reload(): Promise<void>
  }
}

function positiveInt(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback
}

/** Accept either the server root or an already-suffixed `/v1` URL. */
function normalizeRoot(value: unknown): string {
  const raw = typeof value === "string" && value.trim() !== "" ? value.trim() : DEFAULT_BASE_URL
  return raw.replace(/\/+$/, "").replace(/\/v1$/i, "")
}

function basename(value: string): string {
  const parts = value.split(/[\\/]/)
  return parts[parts.length - 1] || value
}

function slugify(value: string): string {
  return value
    .replace(/\.gguf$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

function releasedAt(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0
  // llama.cpp reports `created` in seconds; keep already-millisecond values.
  return value > 10_000_000_000 ? Math.trunc(value) : Math.trunc(value * 1000)
}

function hasVision(model: RemoteModel): boolean {
  const modalities = model.architecture?.input_modalities
  return (
    Array.isArray(modalities) &&
    modalities.some((modality) => typeof modality === "string" && modality.toLowerCase() === "image")
  )
}

function displayName(model: RemoteModel, id: string, fallback: string): string {
  const alias = Array.isArray(model.aliases) ? model.aliases[0] : undefined
  if (typeof alias !== "string") return fallback
  const trimmed = alias.trim()
  // `--alias` defaults to the full GGUF path on some launch commands; a path
  // is not a useful display name and `providerID/id` parsing cannot use one.
  if (trimmed === "" || trimmed.includes("/") || trimmed.includes("\\")) return fallback
  if (trimmed === id || trimmed === model.id) return fallback
  return trimmed
}

function mapModels(payload: unknown, options: NormalizedOptions): DiscoveredModel[] {
  const record = payload !== null && typeof payload === "object" ? (payload as Record<string, unknown>) : {}
  const data = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.models)
      ? record.models
      : undefined
  // A malformed response is a failed poll, not an empty inventory: keep the
  // last successful models instead of wiping them on a transient bad payload.
  if (data === undefined) throw new Error("unexpected /v1/models payload")

  const entries = data
    .filter((item): item is RemoteModel => item !== null && typeof item === "object")
    .filter((item) => typeof item.id === "string" && item.id.length > 0)
    .toSorted((a, b) => (a.id as string).localeCompare(b.id as string))

  const used = new Map<string, number>()
  return entries.map((item) => {
    const rawID = item.id as string
    const base = basename(rawID)
    const baseName = base.replace(/\.gguf$/i, "")
    const slug = slugify(baseName) || "model"

    const count = (used.get(slug) ?? 0) + 1
    used.set(slug, count)
    // Keep the common case (one model, one slug) untouched, but never let two
    // GGUF files with the same basename overwrite each other in the registry.
    const id = count === 1 ? slug : `${slug}-${count}`

    const context =
      positiveInt(item.meta?.n_ctx, 0) ||
      positiveInt(item.meta?.n_ctx_train, 0) ||
      FALLBACK_CONTEXT_LIMIT

    return {
      id,
      modelID: rawID,
      providerID: PROVIDER_ID,
      name: displayName(item, id, baseName || id),
      capabilities: {
        tools: options.tools,
        input: hasVision(item) ? ["text", "image"] : ["text"],
        output: ["text"],
      },
      variants: [],
      time: { released: releasedAt(item.created) },
      cost: [],
      status: "active",
      enabled: true,
      limit: {
        context,
        output: options.outputLimit,
      },
    } satisfies DiscoveredModel
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function setup(ctx: Context): Promise<() => Promise<void>> {
  const raw = ctx.options ?? {}
  const root = normalizeRoot(raw.baseURL)
  const outputLimit = positiveInt(raw.outputLimit, DEFAULT_OUTPUT_LIMIT)
  const pollInterval = Math.max(MIN_POLL_INTERVAL, positiveInt(raw.pollInterval, DEFAULT_POLL_INTERVAL))
  const tools = raw.tools !== false
  const apiKey = typeof raw.apiKey === "string" && raw.apiKey.trim() !== "" ? raw.apiKey.trim() : undefined
  const options: NormalizedOptions = { outputLimit, tools }

  let inventory: DiscoveredModel[] = []
  let lastHash: string | undefined
  let stopped = false
  let running = false
  let reachable: boolean | undefined
  let inFlight: AbortController | undefined

  // Register once; every successful poll only updates `inventory` and calls
  // `reload()`, so transforms never accumulate.
  const registration = await ctx.provider.transform((editor) => {
    if (inventory.length === 0) {
      if (editor.get(PROVIDER_ID)) editor.models.set(PROVIDER_ID, [])
      return
    }

    editor.update(PROVIDER_ID, (provider) => {
      provider.name = PROVIDER_NAME
      provider.activation = "enabled"
      // The host normalizes this to the bundled
      // `@opencode/ai/providers/openai-compatible` package.
      provider.package = "@ai-sdk/openai-compatible"
      provider.settings = {
        baseURL: `${root}/v1`,
        ...(apiKey ? { apiKey } : {}),
      }
      provider.canonical = undefined
      provider.integrationID = undefined
    })
    editor.models.set(PROVIDER_ID, inventory)
  })

  const refresh = async (): Promise<void> => {
    if (stopped || running) return
    running = true
    const controller = new AbortController()
    inFlight = controller
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

    try {
      const response = await fetch(`${root}/v1/models`, {
        signal: controller.signal,
        headers: {
          accept: "application/json",
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
      })
      if (!response.ok) {
        const hint = response.status === 401 || response.status === 403 ? " (check apiKey)" : ""
        throw new Error(`HTTP ${response.status}${hint}`)
      }
      const payload: unknown = await response.json()
      if (stopped) return

      if (reachable === false) console.log(`[llamacpp-discovery] server reachable again at ${root}`)
      reachable = true

      const next = mapModels(payload, options)
      const hash = JSON.stringify(next)
      if (hash === lastHash) return

      lastHash = hash
      inventory = next
      if (next.length === 0) {
        console.warn("[llamacpp-discovery] server returned no models")
      } else {
        console.log(`[llamacpp-discovery] discovered ${next.length} model(s): ${next.map((model) => model.id).join(", ")}`)
      }
      await ctx.provider.reload()
    } catch (error) {
      if (stopped) return
      if (reachable !== false) {
        reachable = false
        console.warn(
          `[llamacpp-discovery] discovery failed for ${root}: ${errorMessage(error)}; keeping last inventory`,
        )
      }
    } finally {
      clearTimeout(timer)
      if (inFlight === controller) inFlight = undefined
      running = false
    }
  }

  console.log(
    `[llamacpp-discovery] starting; server ${root}, poll ${pollInterval}ms, auth ${apiKey ? "enabled" : "disabled"}`,
  )
  await refresh()
  const interval = setInterval(() => {
    void refresh()
  }, pollInterval)

  return async () => {
    stopped = true
    clearInterval(interval)
    inFlight?.abort()
    await registration.dispose()
    console.log("[llamacpp-discovery] stopped")
  }
}

export default {
  id: "llamacpp-discovery",
  setup,
}
