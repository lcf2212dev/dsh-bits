/**
 * Authenticated HTTP routes for the Bits plugin (v5).
 *
 * Every route is an exact host-side Fetch route registered through
 * `ctx.connection.fetch.register(...)`; the DSH Connection host already enforces
 * browser/API-owner authentication and method matching, so handlers only own
 * request validation and JSON payload shape.
 *
 * Response convention (always HTTP 200 for handler-level outcomes):
 *   success -> `{ ok: true, ...payload }`
 *   failure -> `{ ok: false, error: { code, message } }`
 *
 * Coded errors thrown by the bit store, the model catalog or the bit runtime
 * (`error.code`) pass their code through; anything unexpected is logged through
 * `deps.log` and reported as `INTERNAL`.
 *
 * There is no VM anymore: the VM/image/docker/notify-test routes were removed in
 * v5, and the ad-hoc execution happens through the bit runtime
 * (`host/bit-runtime.js`, injected as `deps.runtime`).
 *
 * @module host/routes
 */

/** Upper bound for one ad-hoc `POST /api/bots.run` invocation (contract §7). */
const DEFAULT_RUN_TIMEOUT_MS = 15 * 60 * 1000;
/** Maximum length of an ad-hoc run request (contract §6.1). */
const MAX_RUN_REQUEST_LENGTH = 20000;
/** Error codes that may cross the route boundary verbatim. */
const CODED_ERROR_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;

/**
 * @param {string} code
 * @param {string} message
 * @returns {Error & { code: string }}
 */
function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function messageOf(error) {
  if (error instanceof Error && typeof error.message === 'string' && error.message !== '') return error.message;
  if (isPlainObject(error) && typeof error.message === 'string' && error.message !== '') return error.message;
  if (isPlainObject(error) && typeof error.code === 'string' && error.code !== '') return error.code;
  if (typeof error === 'string' && error !== '') return error;
  return 'Unknown error';
}

/**
 * @param {unknown} error
 * @returns {string | null} the coded error code, or `null` for uncoded errors
 */
function codedCodeOf(error) {
  if (isPlainObject(error) && typeof error.code === 'string' && CODED_ERROR_PATTERN.test(error.code)) {
    return error.code;
  }
  return null;
}

/**
 * Deep-copy a record for view composition.
 *
 * @template T
 * @param {T} value
 * @returns {T}
 */
function cloneRecord(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * @param {Record<string, any>} payload
 * @returns {Response}
 */
function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

/**
 * @param {Record<string, any>} [payload]
 * @returns {Response}
 */
function success(payload = {}) {
  return jsonResponse({ ok: true, ...payload });
}

/**
 * @param {string} code
 * @param {string} message
 * @returns {Response}
 */
function failure(code, message) {
  return jsonResponse({ ok: false, error: { code, message } });
}

/**
 * Log through the optional `deps.log` without ever failing the request.
 *
 * @param {{ log?: (message: string) => void }} deps
 * @param {string} message
 */
function log(deps, message) {
  try {
    if (typeof deps.log === 'function') deps.log(message);
  } catch {
    // Logging must never break a request.
  }
}

/**
 * Parse a JSON object request body.
 *
 * @param {Request} request
 * @returns {Promise<Record<string, any>>}
 * @throws coded `BAD_REQUEST`
 */
async function readJsonBody(request) {
  if (request === null || typeof request?.json !== 'function') {
    throw codedError('BAD_REQUEST', 'Request body is required');
  }
  let body;
  try {
    body = await request.json();
  } catch {
    throw codedError('BAD_REQUEST', 'Request body must be valid JSON');
  }
  if (!isPlainObject(body)) throw codedError('BAD_REQUEST', 'Request body must be a JSON object');
  return body;
}

/**
 * Read and validate the `id` field of a JSON body.
 *
 * @param {Record<string, any>} body
 * @returns {string}
 * @throws coded `BAD_REQUEST`
 */
function requireId(body) {
  const id = body.id;
  if (typeof id !== 'string' || id.trim() === '') {
    throw codedError('BAD_REQUEST', '"id" is required and must be a non-empty string');
  }
  return id.trim();
}

/**
 * Reject a character id the shipped catalog does not know. `null`/empty
 * clears the character (emoji avatar) and is always accepted; without a
 * catalog dependency only the store's syntax check applies.
 *
 * @param {{ catalog?: any }} deps
 * @param {unknown} character
 * @throws coded `BOT_INVALID_CHARACTER`
 */
function assertKnownCharacter(deps, character) {
  if (character === undefined || character === null || character === '') return;
  const catalog = deps.catalog;
  if (catalog === null || catalog === undefined || typeof catalog.has !== 'function') return;
  if (!catalog.has(character)) {
    throw codedError('BOT_INVALID_CHARACTER', `Unknown bit character "${String(character)}"`);
  }
}

/**
 * Public projection of one catalog bit (schema v2 adds the execution defaults).
 *
 * @param {Record<string, any>} bit
 * @returns {Record<string, any>}
 */
function catalogBitView(bit) {
  return {
    id: bit.id,
    name: bit.name,
    group: bit.group ?? null,
    emoji: bit.emoji,
    color: bit.color,
    summary: { ...bit.summary },
    instructions: bit.instructions,
    isOrchestrator: bit.isOrchestrator === true,
    model: typeof bit.model === 'string' ? bit.model : 'subscription/sonnet',
    effort: typeof bit.effort === 'string' ? bit.effort : 'high',
    avatar: `/api/bots.avatar?id=${encodeURIComponent(bit.id)}`,
  };
}

/**
 * Pick only the documented create fields so a caller can never force `id`,
 * `workspaceDir` or a v4 `vm` through the route.
 *
 * @param {Record<string, any>} body
 * @returns {Record<string, unknown>}
 */
function pickCreateInput(body) {
  const input = {
    name: body.name,
    emoji: body.emoji,
    color: body.color,
    instructions: body.instructions,
    isOrchestrator: body.isOrchestrator,
    model: body.model,
    effort: body.effort,
  };
  if (body.character !== undefined) input.character = body.character;
  return input;
}

/**
 * Resolve the bit runtime, mapping a missing dependency to a coded error.
 *
 * @param {{ runtime?: any }} deps
 * @returns {{ listModels: Function, runBit: Function }}
 * @throws coded `BIT_RUNTIME_UNAVAILABLE`
 */
function requireRuntime(deps) {
  if (!isPlainObject(deps.runtime) || typeof deps.runtime.runBit !== 'function') {
    throw codedError('BIT_RUNTIME_UNAVAILABLE', 'Bit runtime is unavailable');
  }
  return deps.runtime;
}

/**
 * Normalize the `{ response, meta }` pair returned by the bit runtime.
 *
 * @param {unknown} result
 * @returns {{ response: string, meta: Record<string, any> }}
 * @throws coded `BIT_RUN_FAILED`
 */
function normalizeRunResult(result) {
  if (typeof result === 'string') return { response: result, meta: {} };
  if (!isPlainObject(result) || typeof result.response !== 'string') {
    throw codedError('BIT_RUN_FAILED', 'Bit runtime returned an invalid response');
  }
  return { response: result.response, meta: isPlainObject(result.meta) ? cloneRecord(result.meta) : {} };
}

/**
 * Read the optional boolean `readOnly` field of the run body (default `true`
 * for ad-hoc runs, contract §6.1).
 *
 * @param {unknown} value
 * @returns {boolean}
 * @throws coded `BAD_REQUEST`
 */
function readReadOnly(value) {
  if (value === undefined) return true;
  if (typeof value !== 'boolean') throw codedError('BAD_REQUEST', '"readOnly" must be a boolean');
  return value;
}

/**
 * Validate the ad-hoc run request text.
 *
 * @param {unknown} value
 * @returns {string}
 * @throws coded `BAD_REQUEST`
 */
function readRunRequest(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw codedError('BAD_REQUEST', '"request" is required and must be a non-empty string');
  }
  if (value.length > MAX_RUN_REQUEST_LENGTH) {
    throw codedError('BAD_REQUEST', `"request" must be at most ${MAX_RUN_REQUEST_LENGTH} characters`);
  }
  return value;
}

// -----------------------------------------------------------------------------
// Route handlers
// -----------------------------------------------------------------------------

/**
 * GET /api/bots.list
 *
 * @param {Record<string, any>} deps
 * @returns {Promise<Response>}
 */
async function handleList(deps) {
  const bits = deps.bits.list();
  return success({ bits, bots: cloneRecord(bits) });
}

/**
 * POST /api/bots.create
 *
 * @param {Record<string, any>} deps
 * @param {Request} request
 * @returns {Promise<Response>}
 */
async function handleCreate(deps, request) {
  const body = await readJsonBody(request);
  assertKnownCharacter(deps, body.character);
  const bit = await deps.bits.create(pickCreateInput(body));
  return success({ bit, bot: cloneRecord(bit) });
}

/**
 * POST /api/bots.update
 *
 * @param {Record<string, any>} deps
 * @param {Request} request
 * @returns {Promise<Response>}
 */
async function handleUpdate(deps, request) {
  const body = await readJsonBody(request);
  const id = requireId(body);
  if (!isPlainObject(body.patch)) {
    throw codedError('BAD_REQUEST', '"patch" is required and must be an object');
  }
  assertKnownCharacter(deps, body.patch.character);
  const bit = await deps.bits.update(id, body.patch);
  return success({ bit, bot: cloneRecord(bit) });
}

/**
 * POST /api/bots.delete
 *
 * @param {Record<string, any>} deps
 * @param {Request} request
 * @returns {Promise<Response>}
 */
async function handleDelete(deps, request) {
  const body = await readJsonBody(request);
  const id = requireId(body);
  let deleteWorkspace = false;
  if (body.deleteWorkspace !== undefined) {
    if (typeof body.deleteWorkspace !== 'boolean') {
      throw codedError('BAD_REQUEST', '"deleteWorkspace" must be a boolean');
    }
    deleteWorkspace = body.deleteWorkspace;
  }
  const removed = await deps.bits.remove(id, { deleteWorkspace });
  return success({
    deleted: true,
    id: removed.id,
    workspaceRemoved: deleteWorkspace,
    workspaceDir: typeof removed.workspaceDir === 'string' ? removed.workspaceDir : null,
  });
}

/**
 * GET /api/bots.catalog
 *
 * @param {Record<string, any>} deps
 * @returns {Promise<Response>}
 */
async function handleCatalog(deps) {
  const catalog = deps.catalog;
  if (catalog === null || catalog === undefined) {
    return success({ version: 2, groups: [], bits: [], error: 'catalog unavailable' });
  }
  return success({
    version: catalog.version ?? 2,
    groups: Array.isArray(catalog.groups) ? catalog.groups.map((group) => ({ id: group.id, label: { ...group.label } })) : [],
    bits: Array.isArray(catalog.bits) ? catalog.bits.map(catalogBitView) : [],
    error: typeof catalog.error === 'string' ? catalog.error : null,
  });
}

/**
 * GET /api/bots.avatar?id=<bit id>
 *
 * Binary route for `<img src>`: answers WebP bytes, or a 404 for an unknown
 * id so the browser `error` event lets the UI fall back to the emoji.
 *
 * @param {Record<string, any>} deps
 * @param {Request} request
 * @returns {Promise<Response>}
 */
async function handleAvatar(deps, request) {
  let id = '';
  try {
    id = new URL(request.url, 'http://localhost').searchParams.get('id') ?? '';
  } catch {
    id = '';
  }
  const catalog = deps.catalog;
  if (!id || catalog === null || catalog === undefined || typeof catalog.readAvatar !== 'function' || !catalog.has(id)) {
    return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
  }
  let bytes;
  try {
    bytes = await catalog.readAvatar(id);
  } catch (error) {
    log(deps, `bits: avatar ${id} unavailable: ${messageOf(error)}`);
    return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
  }
  return new Response(bytes, {
    status: 200,
    headers: {
      'content-type': 'image/webp',
      'cache-control': 'private, max-age=86400',
      'x-content-type-options': 'nosniff',
    },
  });
}

/**
 * GET /api/bots.models
 *
 * @param {Record<string, any>} deps
 * @param {Request} request
 * @returns {Promise<Response>}
 */
async function handleModels(deps, request) {
  const runtime = requireRuntime(deps);
  if (typeof runtime.listModels !== 'function') {
    throw codedError('BIT_RUNTIME_UNAVAILABLE', 'Bit runtime does not expose a model catalog');
  }
  const result = await runtime.listModels({ signal: request?.signal });
  const models = Array.isArray(result) ? result : isPlainObject(result) && Array.isArray(result.models) ? result.models : null;
  if (models === null) throw new Error('Bit runtime returned an invalid model list');
  return success({ models: cloneRecord(models) });
}

/**
 * Bound `promise` with a route-level timeout that aborts `controller` with a
 * coded `BIT_RUN_TIMEOUT`.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} timeoutMs
 * @param {AbortController} controller
 * @returns {Promise<T>}
 */
function withRunTimeout(promise, timeoutMs, controller) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = codedError('BIT_RUN_TIMEOUT', `Bit run exceeded ${timeoutMs} ms`);
      try {
        controller.abort(error);
      } catch {
        // Aborting is best effort; the coded rejection below is what matters.
      }
      reject(error);
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * POST /api/bots.run — ad-hoc worker invocation (request → response).
 *
 * Orchestrator bits are refused: they run inside flows (Times tab), not ad-hoc.
 *
 * @param {Record<string, any>} deps
 * @param {Request} request
 * @returns {Promise<Response>}
 */
async function handleRun(deps, request) {
  const body = await readJsonBody(request);
  const id = requireId(body);
  const runRequest = readRunRequest(body.request);
  const readOnly = readReadOnly(body.readOnly);
  const bit = deps.bits.get(id);
  if (!isPlainObject(bit)) throw codedError('BOT_NOT_FOUND', `Bit "${id}" was not found`);
  if (bit.isOrchestrator === true) {
    throw codedError('BIT_IS_ORCHESTRATOR', 'Orquestradores executam em fluxos');
  }
  const runtime = requireRuntime(deps);
  const timeoutMs =
    typeof deps.runTimeoutMs === 'number' && Number.isFinite(deps.runTimeoutMs) && deps.runTimeoutMs > 0
      ? deps.runTimeoutMs
      : DEFAULT_RUN_TIMEOUT_MS;
  // The workspace is the run cwd; make sure it exists before invoking.
  try {
    await deps.bits.ensureWorkspace(bit);
  } catch (error) {
    log(deps, `bits: could not ensure workspace for bit ${id}: ${messageOf(error)}`);
  }
  const controller = new AbortController();
  const transportSignal = request?.signal;
  const forwardAbort = () => {
    try {
      controller.abort(transportSignal?.reason);
    } catch {
      // Ignore double aborts.
    }
  };
  if (transportSignal !== undefined && transportSignal !== null) {
    if (transportSignal.aborted) forwardAbort();
    else transportSignal.addEventListener('abort', forwardAbort, { once: true });
  }
  try {
    const result = await withRunTimeout(
      Promise.resolve().then(() =>
        runtime.runBit({
          bit: cloneRecord(bit),
          request: runRequest,
          readOnly,
          cwd: bit.workspaceDir,
          signal: controller.signal,
        }),
      ),
      timeoutMs,
      controller,
    );
    const { response, meta } = normalizeRunResult(result);
    return success({ response, meta });
  } catch (error) {
    const code = codedCodeOf(error);
    if (code !== null) throw error;
    throw codedError('BIT_RUN_FAILED', messageOf(error));
  } finally {
    if (transportSignal !== undefined && transportSignal !== null) {
      try {
        transportSignal.removeEventListener('abort', forwardAbort);
      } catch {
        // Best effort.
      }
    }
  }
}

// -----------------------------------------------------------------------------
// Registration
// -----------------------------------------------------------------------------

/**
 * Build one exact Fetch route definition with readiness gating and uniform
 * error handling.
 *
 * @param {Record<string, any>} deps
 * @param {string} path exact route path
 * @param {string[]} methods allowed HTTP methods
 * @param {(request: Request) => Promise<Response>} handler
 * @returns {{ path: string, methods: string[], requestBody: 'buffered', fetch: (request: Request) => Promise<Response> }}
 */
function defineRoute(deps, path, methods, handler) {
  return {
    path,
    methods,
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        if (deps.ready !== undefined && deps.ready !== null) await deps.ready;
        return await handler(request);
      } catch (error) {
        const code = codedCodeOf(error) ?? 'INTERNAL';
        if (code === 'INTERNAL') {
          log(deps, `bits: route ${path} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
          return failure('INTERNAL', 'Internal server error');
        }
        return failure(code, messageOf(error));
      }
    },
  };
}

/**
 * Register all Bits HTTP routes on the host connection.
 *
 * @param {{ connection: { fetch: { register: (route: any) => () => void } } }} ctx
 *   host plugin context; only `ctx.connection.fetch.register` is used
 * @param {{
 *   bits: any,
 *   catalog?: ReturnType<typeof import('./catalog.js').loadBitCatalog>,
 *   ready: Promise<void>,
 *   runtime?: any,
 *   runTimeoutMs?: number,
 *   log?: (message: string) => void,
 * }} deps
 *   `bits` is the v5 bit store; `ready` resolves after it is initialized;
 *   `runtime` is the bit runtime created in `index.js`
 *   (`createBitRuntime`), used by the models and run routes.
 * @returns {() => void} disposer that unregisters every route
 */
export function registerBotRoutes(ctx, deps) {
  const registry = ctx?.connection?.fetch;
  if (registry === null || typeof registry?.register !== 'function') {
    throw new TypeError('registerBotRoutes: ctx.connection.fetch.register is required');
  }
  if (!isPlainObject(deps) || !isPlainObject(deps.bits)) {
    throw new TypeError('registerBotRoutes: deps.bits is required');
  }
  const definitions = [
    defineRoute(deps, '/api/bots.list', ['GET'], () => handleList(deps)),
    defineRoute(deps, '/api/bots.create', ['POST'], (request) => handleCreate(deps, request)),
    defineRoute(deps, '/api/bots.update', ['POST'], (request) => handleUpdate(deps, request)),
    defineRoute(deps, '/api/bots.delete', ['POST'], (request) => handleDelete(deps, request)),
    defineRoute(deps, '/api/bots.catalog', ['GET'], () => handleCatalog(deps)),
    defineRoute(deps, '/api/bots.avatar', ['GET'], (request) => handleAvatar(deps, request)),
    defineRoute(deps, '/api/bots.models', ['GET'], (request) => handleModels(deps, request)),
    defineRoute(deps, '/api/bots.run', ['POST'], (request) => handleRun(deps, request)),
  ];
  const disposers = definitions.map((definition) => registry.register(definition));
  return () => {
    for (let index = disposers.length - 1; index >= 0; index -= 1) {
      try {
        if (typeof disposers[index] === 'function') disposers[index]();
      } catch (error) {
        log(deps, `bits: route disposer failed: ${messageOf(error)}`);
      }
    }
  };
}
