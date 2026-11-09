/**
 * Authenticated HTTP routes for Bots plugin teams (CONTRACT §10.3) plus the
 * synchronous team template loader used by `index.js`.
 *
 * Same conventions as `host/routes.js` (§5): always HTTP 200 for handler-level
 * outcomes, `{ ok: true, ...payload }` / `{ ok: false, error: { code, message } }`,
 * coded errors pass through, anything unexpected is logged and reported as
 * `INTERNAL`, and every handler awaits `deps.ready` first.
 *
 * @module host/team-routes
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { normalizeTeam } from './teams.js';

/** Error codes that may cross the route boundary verbatim. */
const CODED_ERROR_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;
/** Template id (file basename without `.json`). */
const TEMPLATE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const DEFAULT_TEMPLATE_EMOJI = '👥';
const MAX_TEMPLATE_NAME = 60;
const MAX_TEMPLATE_DESCRIPTION = 2000;
const MAX_TEMPLATE_EMOJI_CODE_POINTS = 8;

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
 * @template T
 * @param {T} value
 * @returns {T}
 */
function cloneRecord(value) {
  return JSON.parse(JSON.stringify(value));
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
 * `updatedAt`) from a team body or patch.
 *
 * @param {Record<string, any>} value
 * @returns {Record<string, any>}
 */
function withoutStoreKeys(value) {
  const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...rest } = value;
  return rest;
}

/**
 * When a catalog is available, reject member characters it does not know.
 *
 * @param {{ catalog?: any }} deps
 * @param {unknown} members
 * @throws coded `TEAM_INVALID`
 */
function assertKnownCharacters(deps, members) {
  const catalog = deps.catalog;
  if (catalog === null || catalog === undefined || typeof catalog.has !== 'function') return;
  if (!Array.isArray(members)) return;
  members.forEach((member, index) => {
    if (!isPlainObject(member)) return;
    const character = member.character;
    if (typeof character !== 'string' || character === '') return;
    if (!catalog.has(character)) {
      throw codedError('TEAM_INVALID', `members[${index}].character: unknown bit character "${character}"`);
    }
  });
}

// -----------------------------------------------------------------------------
// Handlers
// -----------------------------------------------------------------------------

/**
 * GET /api/bots.teams
 *
 * @param {Record<string, any>} deps
 * @returns {Promise<Response>}
 */
async function handleList(deps) {
  return success({ teams: deps.teams.list() });
}

/**
 * POST /api/bots.teams.create
 *
 * @param {Record<string, any>} deps
 * @param {Request} request
 * @returns {Promise<Response>}
 */
async function handleCreate(deps, request) {
  const body = await readJsonBody(request);
  if (!isPlainObject(body.team)) throw codedError('BAD_REQUEST', '"team" is required and must be an object');
  const input = withoutStoreKeys(body.team);
  assertKnownCharacters(deps, input.members);
  const team = await deps.teams.create(input);
  return success({ team });
}

/**
 * POST /api/bots.teams.update
 *
 * @param {Record<string, any>} deps
 * @param {Request} request
 * @returns {Promise<Response>}
 */
async function handleUpdate(deps, request) {
  const body = await readJsonBody(request);
  const id = requireId(body);
  if (!isPlainObject(body.patch)) throw codedError('BAD_REQUEST', '"patch" is required and must be an object');
  const patch = withoutStoreKeys(body.patch);
  assertKnownCharacters(deps, patch.members);
  const team = await deps.teams.update(id, patch);
  return success({ team });
}

/**
 * POST /api/bots.teams.delete
 *
 * @param {Record<string, any>} deps
 * @param {Request} request
 * @returns {Promise<Response>}
 */
async function handleDelete(deps, request) {
  const body = await readJsonBody(request);
  const id = requireId(body);
  const removed = await deps.teams.remove(id);
  return success({ deleted: true, id: typeof removed?.id === 'string' ? removed.id : id });
}

/**
 * GET /api/bots.teams.templates
 *
 * @param {Record<string, any>} deps
 * @returns {Promise<Response>}
 */
async function handleTemplates(deps) {
  const templates = Array.isArray(deps.templates) ? cloneRecord(deps.templates) : [];
  return success({ templates });
}

/**
 * GET /api/bots.teams.providers
 *
 * The profile's model providers (accounts) with their models, so the team
 * editor can offer the same picker the chat composer does. A member `provider`
 * pins the account its model is resolved in.
 *
 * @param {Record<string, any>} deps
 * @returns {Promise<Response>}
 */
async function handleProviders(deps) {
  const llm = deps.llm;
  if (llm === undefined || llm === null || typeof llm.listProviders !== 'function') return success({ providers: [] });
  const providers = [];
  for (const item of llm.listProviders()) {
    if (!isPlainObject(item) || typeof item.id !== 'string' || item.id === '') continue;
    let models = [];
    try {
      const list = await llm.listModels(item.id);
      models = (Array.isArray(list) ? list : [])
        .filter((model) => isPlainObject(model) && typeof model.id === 'string' && model.id !== '')
        .map((model) => ({ id: model.id, name: typeof model.name === 'string' && model.name !== '' ? model.name : model.id }));
    } catch {
      // A provider that cannot list its models still appears (id/name only).
      models = [];
    }
    providers.push({ id: item.id, name: typeof item.name === 'string' && item.name !== '' ? item.name : item.id, models });
  }
  return success({ providers });
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
 * Register the team routes on the host connection.
 *
 * @param {{ connection: { fetch: { register: (route: any) => () => void } } }} ctx
 * @param {{
 *   teams: import('./teams.js').TeamStore,
 *   ready: Promise<void>,
 *   catalog?: { has: (id: unknown) => boolean },
 *   templates?: Array<{ id: string, name: string, description: string, emoji: string, team: object }>,
 *   llm?: { listProviders: () => Array<{ id: string, name?: string }>, listModels: (provider: string) => Promise<any[]> },
 *   log?: (message: string) => void,
 * }} deps
 * @returns {() => void} disposer that unregisters every route
 */
export function registerTeamRoutes(ctx, deps) {
  const registry = ctx?.connection?.fetch;
  if (registry === null || typeof registry?.register !== 'function') {
    throw new TypeError('registerTeamRoutes: ctx.connection.fetch.register is required');
  }
  if (!isPlainObject(deps) || deps.teams === null || typeof deps.teams !== 'object') {
    throw new TypeError('registerTeamRoutes: deps.teams is required');
  }
  const definitions = [
    defineRoute(deps, '/api/bots.teams', ['GET'], () => handleList(deps)),
    defineRoute(deps, '/api/bots.teams.create', ['POST'], (request) => handleCreate(deps, request)),
    defineRoute(deps, '/api/bots.teams.update', ['POST'], (request) => handleUpdate(deps, request)),
    defineRoute(deps, '/api/bots.teams.delete', ['POST'], (request) => handleDelete(deps, request)),
    defineRoute(deps, '/api/bots.teams.templates', ['GET'], () => handleTemplates(deps)),
    defineRoute(deps, '/api/bots.teams.providers', ['GET'], () => handleProviders(deps)),
  ];
  const disposers = definitions.map((definition) => registry.register(definition));
  return () => {
    for (let index = disposers.length - 1; index >= 0; index -= 1) {
      try {
        if (typeof disposers[index] === 'function') disposers[index]();
      } catch (error) {
        log(deps, `bots: team route disposer failed: ${messageOf(error)}`);
      }
    }
  };
}

// -----------------------------------------------------------------------------
// Templates
// -----------------------------------------------------------------------------

/**
 * Validate one parsed template document.
 *
 * @param {unknown} raw
 * @param {string} fallbackId file basename without `.json`
 * @returns {{ id: string, name: string, description: string, emoji: string, team: Record<string, any> }}
 * @throws Error describing the first problem
 */
function normalizeTemplate(raw, fallbackId) {
  if (!isPlainObject(raw)) throw new Error('template must be a JSON object');
  const id = raw.id === undefined ? fallbackId : raw.id;
  if (typeof id !== 'string' || !TEMPLATE_ID_PATTERN.test(id)) throw new Error('id must match /^[a-z0-9][a-z0-9_-]{0,63}$/');
  if (!isPlainObject(raw.team)) throw new Error('team must be an object');
  const team = normalizeTeam(raw.team);
  const rawName = raw.name === undefined ? team.name : raw.name;
  if (typeof rawName !== 'string' || rawName.trim() === '' || rawName.trim().length > MAX_TEMPLATE_NAME) {
    throw new Error(`name must be 1-${MAX_TEMPLATE_NAME} characters`);
  }
  const description = raw.description === undefined || raw.description === null ? team.description : raw.description;
  if (typeof description !== 'string' || description.length > MAX_TEMPLATE_DESCRIPTION) {
    throw new Error(`description must be a string of at most ${MAX_TEMPLATE_DESCRIPTION} characters`);
  }
  const emoji = raw.emoji === undefined || raw.emoji === null ? team.emoji || DEFAULT_TEMPLATE_EMOJI : raw.emoji;
  if (typeof emoji !== 'string' || Array.from(emoji).length > MAX_TEMPLATE_EMOJI_CODE_POINTS) {
    throw new Error(`emoji must be a string of at most ${MAX_TEMPLATE_EMOJI_CODE_POINTS} characters`);
  }
  return { id, name: rawName.trim(), description, emoji, team };
}

/**
 * Synchronously load team templates from `<dir>/*.json` (sorted by file name).
 *
 * Each file is `{ id, name, description, emoji, team }`; `team` is validated
 * with {@link normalizeTeam} in full mode (no `id`/`createdAt` needed) and
 * returned normalized. Invalid files and duplicate ids are skipped and reported
 * through `log`. A missing directory yields `[]`.
 *
 * @param {string} dir absolute directory path
 * @param {(message: string) => void} [logFn] receives one line per skipped file
 * @returns {Array<{ id: string, name: string, description: string, emoji: string, team: Record<string, any> }>}
 */
export function loadTeamTemplates(dir, logFn) {
  const report = (message) => log({ log: logFn }, message);
  let names;
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (error?.code !== 'ENOENT') report(`bots: cannot read team templates in ${dir}: ${messageOf(error)}`);
    return [];
  }
  const templates = [];
  const seen = new Set();
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      const template = normalizeTemplate(raw, name.slice(0, -'.json'.length));
      if (seen.has(template.id)) throw new Error(`duplicate template id "${template.id}"`);
      seen.add(template.id);
      templates.push(template);
    } catch (error) {
      report(`bots: skipped team template ${file}: ${messageOf(error)}`);
    }
  }
  return templates;
}
