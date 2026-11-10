/**
 * Authenticated HTTP routes for Bots plugin projects (CONTRACT §12.3).
 *
 * Same conventions as `host/team-routes.js` (§10.3): always HTTP 200 for
 * handler-level outcomes, `{ ok: true, ...payload }` /
 * `{ ok: false, error: { code, message } }`, coded errors pass through,
 * anything unexpected is logged and reported as `INTERNAL`, and every handler
 * awaits `deps.ready` first.
 *
 * Deleting a project first detaches its id from every team that lists it (so a
 * retry finishes the work if a team update fails), then removes the project.
 *
 * @module host/project-routes
 */

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
 * @param {{ log?: (message: string) => void } | undefined} deps
 * @param {string} message
 */
function log(deps, message) {
  try {
    if (typeof deps?.log === 'function') deps.log(message);
  } catch {
    // Logging must never break a request.
  }
}

/**
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
 * Drop the store-owned keys a client may echo back (`id`, `createdAt`,
 * `updatedAt`) from a project body or patch.
 *
 * @param {Record<string, any>} value
 * @returns {Record<string, any>}
 */
function withoutStoreKeys(value) {
  const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...rest } = value;
  return rest;
}

// -----------------------------------------------------------------------------
// Handlers
// -----------------------------------------------------------------------------

/**
 * GET /api/bots.projects
 *
 * @param {Record<string, any>} deps
 * @returns {Promise<Response>}
 */
async function handleList(deps) {
  return success({ projects: deps.projects.list() });
}

/**
 * POST /api/bots.projects.create
 *
 * @param {Record<string, any>} deps
 * @param {Request} request
 * @returns {Promise<Response>}
 */
async function handleCreate(deps, request) {
  const body = await readJsonBody(request);
  if (!isPlainObject(body.project)) throw codedError('BAD_REQUEST', '"project" is required and must be an object');
  const project = await deps.projects.create(withoutStoreKeys(body.project));
  return success({ project });
}

/**
 * POST /api/bots.projects.update
 *
 * @param {Record<string, any>} deps
 * @param {Request} request
 * @returns {Promise<Response>}
 */
async function handleUpdate(deps, request) {
  const body = await readJsonBody(request);
  const id = requireId(body);
  if (!isPlainObject(body.patch)) throw codedError('BAD_REQUEST', '"patch" is required and must be an object');
  const project = await deps.projects.update(id, withoutStoreKeys(body.patch));
  return success({ project });
}

/**
 * POST /api/bots.projects.delete
 *
 * Detach the project id from every team that lists it, then remove the project.
 * A failed team update aborts the delete (coded error returned) without removing
 * the project, so a retry finishes the remaining detachments.
 *
 * @param {Record<string, any>} deps
 * @param {Request} request
 * @returns {Promise<Response>}
 */
async function handleDelete(deps, request) {
  const body = await readJsonBody(request);
  const id = requireId(body);
  const project = typeof deps.projects.get === 'function' ? deps.projects.get(id) : undefined;
  if (project === undefined) throw codedError('PROJECT_NOT_FOUND', `Project "${id}" was not found`);
  const listed = deps.teams.list();
  const teams = Array.isArray(listed) ? listed : [];
  let detachedTeams = 0;
  for (const team of teams) {
    if (!isPlainObject(team) || !Array.isArray(team.projectIds) || !team.projectIds.includes(id)) continue;
    await deps.teams.update(team.id, { projectIds: team.projectIds.filter((projectId) => projectId !== id) });
    detachedTeams += 1;
  }
  const removed = await deps.projects.remove(id);
  return success({ deleted: true, id: typeof removed?.id === 'string' ? removed.id : id, detachedTeams });
}

// -----------------------------------------------------------------------------
// Registration
// -----------------------------------------------------------------------------

/**
 * @param {Record<string, any>} deps
 * @param {string} routePath
 * @param {string[]} methods
 * @param {(request: Request) => Promise<Response>} handler
 * @returns {{ path: string, methods: string[], requestBody: 'buffered', fetch: (request: Request) => Promise<Response> }}
 */
function defineRoute(deps, routePath, methods, handler) {
  return {
    path: routePath,
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
          log(deps, `bots: route ${routePath} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
          return failure('INTERNAL', 'Internal server error');
        }
        return failure(code, messageOf(error));
      }
    },
  };
}

/**
 * Register the project routes on the host connection.
 *
 * @param {{ connection: { fetch: { register: (route: any) => () => void } } }} ctx
 * @param {{
 *   projects: import('./projects.js').ProjectStore,
 *   teams: import('./teams.js').TeamStore,
 *   ready: Promise<void>,
 *   log?: (message: string) => void,
 * }} deps
 * @returns {() => void} disposer that unregisters every route
 */
export function registerProjectRoutes(ctx, deps) {
  const registry = ctx?.connection?.fetch;
  if (registry === null || typeof registry?.register !== 'function') {
    throw new TypeError('registerProjectRoutes: ctx.connection.fetch.register is required');
  }
  if (!isPlainObject(deps) || deps.projects === null || typeof deps.projects !== 'object') {
    throw new TypeError('registerProjectRoutes: deps.projects is required');
  }
  if (deps.teams === null || typeof deps.teams !== 'object') {
    throw new TypeError('registerProjectRoutes: deps.teams is required');
  }
  const definitions = [
    defineRoute(deps, '/api/bots.projects', ['GET'], () => handleList(deps)),
    defineRoute(deps, '/api/bots.projects.create', ['POST'], (request) => handleCreate(deps, request)),
    defineRoute(deps, '/api/bots.projects.update', ['POST'], (request) => handleUpdate(deps, request)),
    defineRoute(deps, '/api/bots.projects.delete', ['POST'], (request) => handleDelete(deps, request)),
  ];
  const disposers = definitions.map((definition) => registry.register(definition));
  return () => {
    for (let index = disposers.length - 1; index >= 0; index -= 1) {
      try {
        if (typeof disposers[index] === 'function') disposers[index]();
      } catch (error) {
        log(deps, `bots: project route disposer failed: ${messageOf(error)}`);
      }
    }
  };
}
