/**
 * Authenticated HTTP routes for the Bots plugin.
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
 * Coded errors thrown by the store/VM (`error.code`) pass their code through;
 * anything unexpected is logged through `deps.log` and reported as `INTERNAL`.
 *
 * @module host/routes
 */

/** Docker image used when neither the store nor the VM exposes a default. */
const FALLBACK_DEFAULT_IMAGE = 'ubuntu:24.04';
/** Upper bound for one VM status probe while composing a bot view. */
const STATUS_TIMEOUT_MS = 4000;
/** Upper bound for the docker availability probe. */
const DOCKER_TIMEOUT_MS = 4000;
/** Upper bound for `docker images`-based listing. */
const IMAGES_TIMEOUT_MS = 8000;
/** VM lifecycle actions accepted by `/api/bots.vm`. */
const VM_ACTIONS = Object.freeze(['start', 'stop', 'restart', 'remove', 'status']);
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
 * Deep-copy a bot record for view composition.
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
 * Bound a promise with a timeout carrying `code: 'VM_PROBE_TIMEOUT'`.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} timeoutMs
 * @param {string} message
 * @returns {Promise<T>}
 */
function withTimeout(promise, timeoutMs, message) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    // Deliberately not unref'd: the timer is always cleared below, and keeping it
    // referenced means a test (or a CLI context) waiting on the probe stays alive
    // until the bounded probe settles.
    timer = setTimeout(() => reject(codedError('VM_PROBE_TIMEOUT', message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Default docker image advertised to the UI.
 *
 * @param {{ store?: any, vm?: any, defaultImage?: string }} deps
 * @returns {string}
 */
function defaultImageOf(deps) {
  for (const candidate of [deps.defaultImage, deps.store?.defaultImage, deps.vm?.defaultImage]) {
    if (typeof candidate === 'string' && candidate !== '') return candidate;
  }
  return FALLBACK_DEFAULT_IMAGE;
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
 * Compose the workspace part of a bot view.
 *
 * @param {{ ensureWorkspaceId?: (record: Record<string, any>) => Promise<string | null> }} deps
 * @param {Record<string, any>} record
 * @returns {Promise<{ workspaceId: string | null, workspaceError: string | null }>}
 */
async function workspaceState(deps, record) {
  if (typeof deps.ensureWorkspaceId !== 'function') {
    return { workspaceId: null, workspaceError: 'workspace registry unavailable' };
  }
  try {
    const workspaceId = await deps.ensureWorkspaceId(record);
    return {
      workspaceId: typeof workspaceId === 'string' && workspaceId !== '' ? workspaceId : null,
      workspaceError: null,
    };
  } catch (error) {
    return { workspaceId: null, workspaceError: messageOf(error) };
  }
}

/**
 * Normalize a VM status object returned by the VM adapter into the contracted
 * `vmStatus` shape (missing fields get safe defaults).
 *
 * @param {{ store?: any, vm?: any }} deps
 * @param {Record<string, any>} record
 * @param {unknown} status
 * @returns {Record<string, any>}
 */
function normalizeVmStatus(deps, record, status) {
  const vm = isPlainObject(record.vm) ? record.vm : {};
  const source = isPlainObject(status) ? status : {};
  return {
    id: record.id,
    containerName:
      typeof source.containerName === 'string' && source.containerName !== ''
        ? source.containerName
        : `dsh-bot-${record.id}`,
    enabled: typeof source.enabled === 'boolean' ? source.enabled : vm.enabled === true,
    state: typeof source.state === 'string' && source.state !== '' ? source.state : 'error',
    running: source.running === true,
    image:
      typeof source.image === 'string' && source.image !== ''
        ? source.image
        : typeof vm.image === 'string'
          ? vm.image
          : defaultImageOf(deps),
    startedAt: typeof source.startedAt === 'string' ? source.startedAt : null,
    exitCode: typeof source.exitCode === 'number' ? source.exitCode : null,
    detail: typeof source.detail === 'string' ? source.detail : null,
    error: typeof source.error === 'string' ? source.error : null,
  };
}

/**
 * Build a degraded VM status for a failed/timed-out probe.
 *
 * @param {{ store?: any, vm?: any }} deps
 * @param {Record<string, any>} record
 * @param {unknown} error
 * @returns {Record<string, any>}
 */
function degradedVmStatus(deps, record, error) {
  const vm = isPlainObject(record.vm) ? record.vm : {};
  const code = isPlainObject(error) && typeof error.code === 'string' ? error.code : null;
  return {
    id: record.id,
    containerName: `dsh-bot-${record.id}`,
    enabled: vm.enabled === true,
    state: code === 'VM_DOCKER_UNAVAILABLE' || code === 'VM_PROBE_TIMEOUT' ? 'unavailable' : 'error',
    running: false,
    image: typeof vm.image === 'string' ? vm.image : defaultImageOf(deps),
    startedAt: null,
    exitCode: null,
    detail: null,
    error: messageOf(error),
  };
}

/**
 * Probe one bot's VM status without ever rejecting.
 *
 * @param {{ vm: any, store?: any }} deps
 * @param {Record<string, any>} record
 * @returns {Promise<Record<string, any>>}
 */
async function safeVmStatus(deps, record) {
  try {
    const status = await withTimeout(
      Promise.resolve(deps.vm.status(record)),
      STATUS_TIMEOUT_MS,
      'VM status probe timed out',
    );
    return normalizeVmStatus(deps, record, status);
  } catch (error) {
    return degradedVmStatus(deps, record, error);
  }
}

/**
 * Compose a full `BotView` (record + workspace registry info + VM status).
 *
 * @param {{ store?: any, vm: any, ensureWorkspaceId?: Function }} deps
 * @param {Record<string, any>} record
 * @returns {Promise<Record<string, any>>}
 */
async function composeView(deps, record) {
  const [workspace, vmStatus] = await Promise.all([workspaceState(deps, record), safeVmStatus(deps, record)]);
  return {
    ...cloneRecord(record),
    workspaceId: workspace.workspaceId,
    workspaceError: workspace.workspaceError,
    vmStatus,
  };
}

/**
 * Probe docker availability without ever rejecting.
 *
 * @param {{ vm: any }} deps
 * @returns {Promise<{ available: boolean, version: string | null, error: string | null }>}
 */
async function probeDocker(deps) {
  try {
    const result = await withTimeout(
      Promise.resolve(deps.vm.available()),
      DOCKER_TIMEOUT_MS,
      'Docker availability probe timed out',
    );
    const source = isPlainObject(result) ? result : {};
    return {
      available: source.available === true,
      version: typeof source.version === 'string' ? source.version : null,
      error: typeof source.error === 'string' ? source.error : null,
    };
  } catch (error) {
    return { available: false, version: null, error: messageOf(error) };
  }
}

/**
 * @param {Record<string, any>} body
 * @returns {Record<string, unknown>}
 */
function pickCreateInput(body) {
  const input = {
    name: body.name,
    emoji: body.emoji,
    color: body.color,
    instructions: body.instructions,
    vm: body.vm,
  };
  if (body.character !== undefined) input.character = body.character;
  return input;
}

/**
 * Reject a character id the shipped catalog does not know. `null`/empty
 * clears the character (legacy emoji avatar) and is always accepted; without
 * a catalog dependency only the store's syntax check applies.
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
 * Public projection of one catalog bit.
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
    avatar: `/api/bots.avatar?id=${encodeURIComponent(bit.id)}`,
  };
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
  const records = deps.store.list();
  const bots = await Promise.all(records.map((record) => composeView(deps, record)));
  const docker = await probeDocker(deps);
  return success({ bots, docker, defaultImage: defaultImageOf(deps) });
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
  const record = await deps.store.create(pickCreateInput(body));
  if (typeof deps.onBotChanged === 'function') {
    try {
      deps.onBotChanged(record);
    } catch (error) {
      log(deps, `bots: onBotChanged failed for bot ${String(record?.id)}: ${messageOf(error)}`);
    }
  }
  if (typeof deps.store.ensureWorkspace === 'function') {
    try {
      await deps.store.ensureWorkspace(record);
    } catch (error) {
      // The record exists; a failed mkdir is retried later by chat/VM setup.
      log(deps, `bots: could not create workspace for bot ${String(record?.id)}: ${messageOf(error)}`);
    }
  }
  return success({ bot: await composeView(deps, record) });
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
  const record = await deps.store.update(id, body.patch);
  if (typeof deps.onBotChanged === 'function') {
    try {
      deps.onBotChanged(record);
    } catch (error) {
      log(deps, `bots: onBotChanged failed for bot ${id}: ${messageOf(error)}`);
    }
  }
  return success({ bot: await composeView(deps, record) });
}

/**
 * POST /api/bots.delete
 *
 * Removes the record (and optionally its workspace) and then best-effort removes
 * the VM container. The record stays deleted even when container removal fails.
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
  const removed = await deps.store.remove(id, { deleteWorkspace });
  if (typeof deps.vm.forget === 'function') {
    try {
      // Tombstone before touching Docker: an in-flight vm_bash must not be
      // able to recreate the container once the record is gone.
      deps.vm.forget(removed);
    } catch (error) {
      log(deps, `bots: VM forget failed for bot ${id}: ${messageOf(error)}`);
    }
  }
  if (typeof deps.vm.remove === 'function') {
    try {
      await deps.vm.remove(removed);
    } catch (error) {
      log(deps, `bots: VM container removal failed for bot ${id}: ${messageOf(error)}`);
    }
  }
  return success({
    deleted: true,
    workspaceRemoved: deleteWorkspace,
    workspaceDir: typeof removed?.workspaceDir === 'string' ? removed.workspaceDir : null,
  });
}

/**
 * POST /api/bots.vm
 *
 * @param {Record<string, any>} deps
 * @param {Request} request
 * @returns {Promise<Response>}
 */
async function handleVm(deps, request) {
  const body = await readJsonBody(request);
  const id = requireId(body);
  const action = body.action;
  if (typeof action !== 'string' || !VM_ACTIONS.includes(action)) {
    throw codedError('BAD_REQUEST', `"action" must be one of: ${VM_ACTIONS.join(', ')}`);
  }
  const record = deps.store.get(id);
  if (!isPlainObject(record)) {
    throw codedError('BOT_NOT_FOUND', `Bot "${id}" was not found`);
  }
  if (action !== 'status') {
    if (typeof deps.vm[action] !== 'function') {
      throw new Error(`VM adapter does not implement ${action}()`);
    }
    await deps.vm[action](record);
  }
  return success({ bot: await composeView(deps, record) });
}

/**
 * GET /api/bots.images
 *
 * Docker image discovery is an enhancement: when the daemon is unavailable the
 * route degrades to an empty image list (the create dialog keeps its free-text
 * image field) and logs the real failure.
 *
 * @param {Record<string, any>} deps
 * @returns {Promise<Response>}
 */
async function handleImages(deps) {
  let images = [];
  try {
    const result = await withTimeout(
      Promise.resolve(deps.vm.listImages()),
      IMAGES_TIMEOUT_MS,
      'Listing Docker images timed out',
    );
    if (Array.isArray(result)) images = result;
  } catch (error) {
    log(deps, `bots: could not list Docker images: ${messageOf(error)}`);
  }
  return success({ images, defaultImage: defaultImageOf(deps) });
}

/**
 * GET /api/bots.docker
 *
 * @param {Record<string, any>} deps
 * @returns {Promise<Response>}
 */
async function handleDocker(deps) {
  return success(await probeDocker(deps));
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
    return success({ version: 1, groups: [], bits: [], error: 'catalog unavailable' });
  }
  return success({
    version: catalog.version ?? 1,
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
    log(deps, `bots: avatar ${id} unavailable: ${messageOf(error)}`);
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
        const code =
          isPlainObject(error) && typeof error.code === 'string' && CODED_ERROR_PATTERN.test(error.code)
            ? error.code
            : 'INTERNAL';
        if (code === 'INTERNAL') {
          log(deps, `bots: route ${path} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
          return failure('INTERNAL', 'Internal server error');
        }
        return failure(code, messageOf(error));
      }
    },
  };
}

/**
 * Register all Bots HTTP routes on the host connection.
 *
 * @param {{ connection: { fetch: { register: (route: any) => () => void } } }} ctx
 *   host plugin context; only `ctx.connection.fetch.register` is used
 * @param {{
 *   store: any,
 *   vm: any,
 *   ready: Promise<void>,
 *   ensureWorkspaceId: (record: Record<string, any>) => Promise<string | null>,
 *   onBotChanged?: (record: Record<string, any>) => void,
 *   catalog?: ReturnType<typeof import('./catalog.js').loadBitCatalog>,
 *   log?: (message: string) => void,
 * }} deps
 *   `ready` resolves after the store is initialized; `ensureWorkspaceId` maps a
 *   bot record to the DSH workspace registry id used to open chats.
 * @returns {() => void} disposer that unregisters every route
 */
export function registerBotRoutes(ctx, deps) {
  const registry = ctx?.connection?.fetch;
  if (registry === null || typeof registry?.register !== 'function') {
    throw new TypeError('registerBotRoutes: ctx.connection.fetch.register is required');
  }
  if (!isPlainObject(deps) || !isPlainObject(deps.store) || !isPlainObject(deps.vm)) {
    throw new TypeError('registerBotRoutes: deps.store and deps.vm are required');
  }
  const definitions = [
    defineRoute(deps, '/api/bots.list', ['GET'], () => handleList(deps)),
    defineRoute(deps, '/api/bots.create', ['POST'], (request) => handleCreate(deps, request)),
    defineRoute(deps, '/api/bots.update', ['POST'], (request) => handleUpdate(deps, request)),
    defineRoute(deps, '/api/bots.delete', ['POST'], (request) => handleDelete(deps, request)),
    defineRoute(deps, '/api/bots.vm', ['POST'], (request) => handleVm(deps, request)),
    defineRoute(deps, '/api/bots.images', ['GET'], () => handleImages(deps)),
    defineRoute(deps, '/api/bots.docker', ['GET'], () => handleDocker(deps)),
    defineRoute(deps, '/api/bots.catalog', ['GET'], () => handleCatalog(deps)),
    defineRoute(deps, '/api/bots.avatar', ['GET'], (request) => handleAvatar(deps, request)),
  ];
  const disposers = definitions.map((definition) => registry.register(definition));
  return () => {
    for (let index = disposers.length - 1; index >= 0; index -= 1) {
      try {
        if (typeof disposers[index] === 'function') disposers[index]();
      } catch (error) {
        log(deps, `bots: route disposer failed: ${messageOf(error)}`);
      }
    }
  };
}
