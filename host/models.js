/**
 * Model catalog and model resolution for bits (v5).
 *
 * Two model families exist:
 *
 * 1. **Subscription** — Claude Code through the `claude_delegate` tool of
 *    `@dsh-burn-plugins/dsh-claude-delegate`. Stored as `subscription/<alias>` with
 *    `alias ∈ {opus, sonnet, haiku}`; the effort is a CLI flag.
 * 2. **DSH chat routes** — the profile's LLM providers. Stored as
 *    `<provider>/<modelId>`. Orchestrator bits must use this family (an agent
 *    needs a route); workers may use it as a single model call.
 *
 * `createModelCatalog(ctx)` keeps a ~60 s cache of the profile routes and never
 * throws from `list()`: a profile whose providers cannot be listed falls back
 * to the subscription group. The helpers are import-free of `@deepseek-ai`
 * packages on purpose (the plugin only talks to DSH through `ctx` services).
 *
 * @module host/models
 */

/** Efforts accepted by the Claude Code CLI (`--effort`). */
export const SUBSCRIPTION_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

/** Effort list offered when a DSH model reports no reasoning metadata. */
export const FALLBACK_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

/** Legacy/wanted effort → supported effort preference order (same as v4 runtime). */
export const EFFORT_ALIASES = {
  xhigh: ['xhigh', 'max', 'high'],
  high: ['high', 'max'],
  medium: ['medium', 'high', 'low'],
  low: ['low', 'minimal', 'medium'],
  max: ['max', 'xhigh', 'high'],
}

/** Subscription aliases and their display labels. */
export const SUBSCRIPTION_MODELS = [
  { alias: 'opus', label: 'Claude Opus 5.5 (subscription)' },
  { alias: 'sonnet', label: 'Claude Sonnet 5.5 (subscription)' },
  { alias: 'haiku', label: 'Claude Haiku 5.5 (subscription)' },
]

/** Default orchestrator route (DeepSeek-V4.1-Flash Max). */
export const DEFAULT_ORCHESTRATOR_MODEL = 'deepseek-account/deepseek-flash'
export const DEFAULT_ORCHESTRATOR_EFFORT = 'max'
/** Default worker model/effort (subscription, same as the bits store). */
export const DEFAULT_WORKER_MODEL = 'subscription/sonnet'
export const DEFAULT_WORKER_EFFORT = 'high'

/** How long the profile route catalog stays cached. */
const CACHE_TTL_MS = 60_000

function codedError(code, message) {
  return Object.assign(new Error(message), { code })
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function nameOf(bit) {
  const name = bit && typeof bit.name === 'string' ? bit.name.trim() : ''
  return name !== '' ? name : (bit && typeof bit.id === 'string' ? bit.id : 'unnamed')
}

function modelStringOf(bit) {
  return bit && typeof bit.model === 'string' ? bit.model.trim() : ''
}

/** Effort ids reported by a model-info object (adapter metadata) or a ModelOption. */
export function effortIdsOf(model) {
  if (!model) return []
  if (Array.isArray(model)) return model.map((item) => (typeof item === 'string' ? item.trim() : (item && typeof item.id === 'string' ? item.id.trim() : ''))).filter(Boolean)
  if (Array.isArray(model.efforts)) return model.efforts.map((item) => (typeof item === 'string' ? item.trim() : (item && typeof item.id === 'string' ? item.id.trim() : ''))).filter(Boolean)
  if (model.reasoning && Array.isArray(model.reasoning.efforts)) return effortIdsOf(model.reasoning.efforts)
  return []
}

/**
 * Map a wished effort onto the efforts a model supports, the way the old team
 * runtime did (`xhigh → xhigh|max|high`, …).
 *
 * @param {any} model model-info object, ModelOption, or effort id list.
 * @param {string} [wished] bit effort (may be empty).
 * @returns {string | undefined} first supported id, or `undefined` when the
 *   model reports no efforts (or the wished one cannot be mapped).
 */
export function effortFor(model, wished) {
  const supported = effortIdsOf(model)
  if (supported.length === 0) return undefined
  const wanted = typeof wished === 'string' ? wished.trim().toLowerCase() : ''
  if (wanted === '') return undefined
  const candidates = EFFORT_ALIASES[wanted] || [wanted]
  return candidates.find((id) => supported.includes(id))
}

/** Subscription aliases and options (no I/O). */
function subscriptionOptions() {
  return SUBSCRIPTION_MODELS.map((item) => Object.freeze({
    id: `subscription/${item.alias}`,
    label: item.label,
    group: 'subscription',
    backend: 'claude-code',
    alias: item.alias,
    efforts: [...SUBSCRIPTION_EFFORTS],
    tools: true,
    supportsOrchestrator: false,
  }))
}

/** Normalize a model label for matching ("Claude Opus 5.5 (copilot)" → "claude opus 5-5"). */
function normalizeLabel(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\(copilot\)/g, ' ')
    .replace(/(\d)\.(\d)/g, '$1-$2')
    .replace(/[\s_]+/g, ' ')
    .trim()
}

/** Subscription alias of a stored model string (`subscription/opus` or legacy `opus`). */
function subscriptionAlias(model) {
  const raw = String(model || '').trim().toLowerCase()
  if (raw.startsWith('subscription/')) {
    const alias = raw.slice('subscription/'.length).trim()
    return SUBSCRIPTION_MODELS.some((item) => item.alias === alias) ? alias : null
  }
  return SUBSCRIPTION_MODELS.some((item) => item.alias === raw) ? raw : null
}

/**
 * Match one DSH route option by `<provider>/<model>` or by the model label
 * (bare labels such as `DeepSeek-V4.1-Flash` are accepted for legacy data).
 *
 * @param {any[]} options route ModelOptions.
 * @param {string} wanted stored model string.
 * @returns {any | null}
 */
function matchRoute(options, wanted) {
  const raw = String(wanted || '').trim()
  if (raw === '') return null
  const normalized = normalizeLabel(raw)
  const slash = raw.indexOf('/')
  if (slash > 0) {
    const provider = raw.slice(0, slash).trim().toLowerCase()
    const model = raw.slice(slash + 1).trim().toLowerCase()
    const sameProvider = options.filter((option) => String(option.provider).toLowerCase() === provider)
    if (sameProvider.length > 0) {
      return sameProvider.find((option) => String(option.model).toLowerCase() === model)
        || sameProvider.find((option) => normalizeLabel(option.model) === normalizeLabel(model))
        || sameProvider.find((option) => normalizeLabel(option.label) === normalizeLabel(model))
        || sameProvider.find((option) => normalizeLabel(option.model).includes(normalizeLabel(model)))
        || null
    }
    return null
  }
  const exact = options.find((option) => normalizeLabel(option.label) === normalized)
    || options.find((option) => normalizeLabel(option.model) === normalized)
  if (exact) return exact
  // Tolerant token match, like the v4 team runtime: every token of the wanted
  // label must appear in the model id or in the display label ("DeepSeek-V4.1-
  // Flash" → deepseek, v4, 1, flash).
  const tokens = String(raw)
    .toLowerCase()
    .replace(/\(copilot\)/g, ' ')
    .replace(/(\d)\.(\d)/g, '$1-$2')
    .split(/[\s_/-]+/)
    .filter(Boolean)
  if (tokens.length === 0) return null
  return options.find((option) => {
    const haystack = `${normalizeLabel(option.label)} ${normalizeLabel(option.model)} ${String(option.model).toLowerCase().replace(/[.\-_]+/g, ' ')}`
    return tokens.every((token) => haystack.includes(token))
  }) || null
}

/**
 * Build the model catalog for one host context.
 *
 * @param {any} ctx host context (`ctx.llm` provides listProviders/listModels/resolveModelInfo).
 * @returns {{ list: () => Promise<{ models: any[] }>, resolve: (bit: any) => Promise<any>, effortFor: typeof effortFor, routeFor: (bit: any) => Promise<any> }}
 */
export function createModelCatalog(ctx) {
  const llm = ctx && ctx.llm ? ctx.llm : null
  let cached = null
  let cachedAt = 0
  let inflight = null

  /** Read the profile's chat routes; never throws (a broken provider is skipped). */
  async function buildRouteOptions() {
    const options = []
    let providers = []
    try {
      providers = llm && typeof llm.listProviders === 'function' ? llm.listProviders() : []
    } catch {
      providers = []
    }
    if (!Array.isArray(providers)) providers = []
    for (const provider of providers) {
      const providerId = provider && typeof provider.id === 'string' ? provider.id : ''
      if (providerId === '') continue
      let models = []
      try {
        models = await llm.listModels(providerId)
      } catch {
        continue
      }
      if (!Array.isArray(models)) continue
      const infos = await Promise.all(models.map(async (model) => {
        const modelId = model && typeof model.id === 'string' ? model.id : ''
        if (modelId === '') return []
        try {
          return effortIdsOf(await llm.resolveModelInfo(providerId, modelId))
        } catch {
          return []
        }
      }))
      models.forEach((model, index) => {
        const modelId = model && typeof model.id === 'string' ? model.id : ''
        if (modelId === '') return
        const label = model && typeof model.name === 'string' && model.name.trim() !== '' ? model.name.trim() : modelId
        const reported = infos[index] && infos[index].length > 0 ? infos[index] : []
        options.push(Object.freeze({
          id: `${providerId}/${modelId}`,
          label,
          group: 'routes',
          backend: 'dsh',
          provider: providerId,
          model: modelId,
          efforts: reported.length > 0 ? reported : [...FALLBACK_EFFORTS],
          tools: false,
          supportsOrchestrator: true,
        }))
      })
    }
    return options
  }

  async function loadCatalog() {
    let routes = []
    try {
      routes = await buildRouteOptions()
    } catch {
      routes = []
    }
    return Object.freeze([...subscriptionOptions(), ...routes])
  }

  /**
   * Catalog of model options: the subscription aliases plus the profile's DSH
   * chat routes, cached for ~60 s. Never throws: with no reachable provider the
   * subscription group is still returned.
   *
   * @returns {Promise<{ models: any[] }>}
   */
  async function list() {
    if (cached !== null && Date.now() - cachedAt < CACHE_TTL_MS) return { models: cached }
    if (inflight === null) {
      inflight = loadCatalog()
        .then((models) => {
          cached = models
          cachedAt = Date.now()
          return models
        })
        .catch(() => (cached !== null ? cached : Object.freeze(subscriptionOptions())))
        .finally(() => { inflight = null })
    }
    let models = cached
    try {
      models = await inflight
    } catch {
      models = cached
    }
    if (models === null || models === undefined) models = Object.freeze(subscriptionOptions())
    return { models }
  }

  /**
   * Resolve a bit's stored model to a concrete invocation target.
   *
   * @param {any} bit bit record.
   * @returns {Promise<{ backend: 'claude-code', alias: string, modelId: string, effort?: string } | { backend: 'dsh', provider: string, model: string, effort?: string }>}
   * @throws coded `BIT_MODEL_MISSING` (no model) / `BIT_MODEL_INVALID` (unknown model).
   */
  async function resolve(bit) {
    const model = modelStringOf(bit)
    if (model === '') throw codedError('BIT_MODEL_MISSING', `Bit "${nameOf(bit)}" has no model defined.`)
    const alias = subscriptionAlias(model)
    if (alias) {
      const effort = effortFor(subscriptionOptions().find((option) => option.alias === alias), bit && bit.effort)
      return { backend: 'claude-code', alias, modelId: `subscription/${alias}`, ...effort !== undefined ? { effort } : {} }
    }
    const { models } = await list()
    const options = models.filter((option) => option.group === 'routes')
    const match = matchRoute(options, model)
    if (!match) {
      const providers = [...new Set(options.map((option) => option.provider))]
      throw codedError('BIT_MODEL_INVALID', providers.length > 0
        ? `The model "${model}" of bit "${nameOf(bit)}" does not exist in this profile (providers: ${providers.join(', ')}).`
        : `The model "${model}" of bit "${nameOf(bit)}" does not exist in this profile (no DSH chat route registered).`)
    }
    const effort = effortFor(match, bit && bit.effort)
    return { backend: 'dsh', provider: match.provider, model: match.model, ...effort !== undefined ? { effort } : {} }
  }

  /**
   * Lead/orchestrator route: the bit must be an orchestrator and resolve to a
   * DSH chat route. An orchestrator without a stored model falls back to
   * DeepSeek-V4.1-Flash Max.
   *
   * @param {any} bit orchestrator bit record.
   * @returns {Promise<{ provider: string, model: string, reasoningEffort?: string }>}
   * @throws coded `BIT_MODEL_INVALID` when the bit is not an orchestrator or
   *   the route is invalid; `BIT_MODEL_MISSING` when it has no model and the
   *   default cannot be resolved.
   */
  async function routeFor(bit) {
    if (!bit || bit.isOrchestrator !== true) {
      throw codedError('BIT_MODEL_INVALID', `Bit "${nameOf(bit)}" is not an orchestrator: only orchestrators run as DSH agents.`)
    }
    const stored = modelStringOf(bit)
    const fallback = stored === ''
    const resolved = await resolve({
      ...bit,
      model: fallback ? DEFAULT_ORCHESTRATOR_MODEL : stored,
      effort: fallback ? (String((bit && bit.effort) || '').trim() || DEFAULT_ORCHESTRATOR_EFFORT) : bit.effort,
    })
    if (resolved.backend !== 'dsh') {
      throw codedError('BIT_MODEL_INVALID', `The orchestrator "${nameOf(bit)}" needs a DSH chat route; "${stored}" is a subscription model (workers only).`)
    }
    const route = { provider: resolved.provider, model: resolved.model }
    if (resolved.effort !== undefined) route.reasoningEffort = resolved.effort
    // Validate the route against the profile; an unsupported effort is dropped
    // (the model default applies) before the route itself is judged invalid.
    if (llm && typeof llm.resolveCallConfig === 'function') {
      try {
        await llm.resolveCallConfig({ ...route })
        return route
      } catch (error) {
        if (route.reasoningEffort !== undefined) {
          try {
            await llm.resolveCallConfig({ provider: route.provider, model: route.model })
            delete route.reasoningEffort
            return route
          } catch {
            // fall through to the coded error below
          }
        }
        throw codedError('BIT_MODEL_INVALID', `The route "${resolved.provider}/${resolved.model}" of the orchestrator "${nameOf(bit)}" was not accepted by this profile: ${messageOf(error)}`)
      }
    }
    return route
  }

  return { list, resolve, effortFor, routeFor }
}
