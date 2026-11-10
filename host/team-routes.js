/**
 * Authenticated HTTP routes for Bits plugin teams (V5-CONTRACT §5.2, §5.4) plus
 * the synchronous team template loader used by `index.js`.
 *
 * Same conventions as `host/routes.js` (§5): always HTTP 200 for handler-level
 * outcomes, `{ ok: true, ...payload }` / `{ ok: false, error: { code, message } }`,
 * coded errors pass through, anything unexpected is logged and reported as
 * `INTERNAL`, and every handler awaits `deps.ready` first.
 *
 * A team template is a JSON file with its own bits plus a team whose members
 * reference those bits by a local `key`:
 *
 * ```json
 * {
 *   "id": "engineering",
 *   "name": "Engenharia (Claude Code)",
 *   "bits": [{ "key": "coordinator", "name": "Coordinator", "character": "bit-coordinator",
 *              "isOrchestrator": true, "model": "deepseek-account/deepseek-flash", "effort": "max" }],
 *   "team": { "name": "Engenharia", "lead": "coordinator",
 *             "members": [{ "id": "coordinator", "bitKey": "coordinator", "role": "…", "access": "read" }] }
 * }
 * ```
 *
 * `POST /api/bots.teams.fromTemplate` is the one-time instantiation: every
 * template bit becomes a fresh bit (catalog defaults for its character plus the
 * template overrides) and the team is created with `bitKey → bitId` resolved.
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
/** Local bit key inside a template (`bits[].key`, `members[].bitKey`). */
const TEMPLATE_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** Bit character id (catalog membership is checked by the routes when available). */
const CHARACTER_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** Accent color: `#rrggbb`. */
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const DEFAULT_TEMPLATE_EMOJI = '👥';
const MAX_TEMPLATE_NAME = 60;
const MAX_TEMPLATE_DESCRIPTION = 2000;
const MAX_TEMPLATE_EMOJI_CODE_POINTS = 8;
const MAX_BIT_NAME = 60;
const MAX_BIT_INSTRUCTIONS = 20000;
const MAX_BIT_MODEL = 120;
const MAX_BIT_EFFORT = 20;
const MAX_BIT_EMOJI_CODE_POINTS = 8;

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
 * When a project store is available, every project id in the payload/patch must
 * resolve (CONTRACT §12.3). Without the store the check is skipped, which keeps
 * older hosts and route-only tests working.
 *
 * @param {{ projects?: any }} deps
 * @param {unknown} projectIds raw `projectIds` value from the request body
 * @throws coded `TEAM_INVALID`
 */
function assertKnownProjects(deps, projectIds) {
  const projects = deps.projects;
  if (projects === null || projects === undefined || typeof projects.get !== 'function') return;
  if (!Array.isArray(projectIds)) return;
  projectIds.forEach((projectId, index) => {
    if (typeof projectId !== 'string') return; // normalizeTeam reports the type error.
    if (projects.get(projectId) === undefined) {
      throw codedError('TEAM_INVALID', `projectIds[${index}]: unknown project "${projectId}"`);
    }
  });
}

/**
 * Resolve a project id from a request body and make sure it exists.
 *
 * @param {{ projects?: any }} deps
 * @param {unknown} value raw `projectId`
 * @returns {string | null}
 * @throws coded `PROJECT_NOT_FOUND`
 */
function resolveProjectId(deps, value) {
  const projectId = typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
  if (projectId === null) return null;
  const project = deps.projects && typeof deps.projects.get === 'function' ? deps.projects.get(projectId) : undefined;
  if (project === undefined || project === null) throw codedError('PROJECT_NOT_FOUND', `Project "${projectId}" was not found`);
  return projectId;
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
  assertKnownProjects(deps, input.projectIds);
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
  assertKnownProjects(deps, patch.projectIds);
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
 * POST /api/bots.teams.fromTemplate
 *
 * Body: `{ templateId, name?, projectId? }`. Creates the template's bits (one
 * time, always fresh) and the team referencing them, then returns
 * `{ team, bits }`.
 *
 * @param {Record<string, any>} deps
 * @param {Request} request
 * @returns {Promise<Response>}
 */
async function handleFromTemplate(deps, request) {
  const body = await readJsonBody(request);
  const templateId = typeof body.templateId === 'string' ? body.templateId.trim() : '';
  if (templateId === '') throw codedError('BAD_REQUEST', '"templateId" is required and must be a non-empty string');
  const templates = Array.isArray(deps.templates) ? deps.templates : [];
  const template = templates.find((item) => isPlainObject(item) && item.id === templateId);
  if (template === undefined) {
    throw codedError('TEAM_TEMPLATE_NOT_FOUND', `Team template "${templateId}" was not found`);
  }
  if (body.name !== undefined && body.name !== null && typeof body.name !== 'string') {
    throw codedError('BAD_REQUEST', '"name" must be a string when given');
  }
  const projectId = resolveProjectId(deps, body.projectId);
  const result = await instantiateTeamTemplate(deps, template, { name: body.name, projectId });
  return success({ team: result.team, bits: result.bits });
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
 *   bits: import('./store.js').BitStore,
 *   ready: Promise<void>,
 *   projects?: { get: (id: string) => object | undefined },
 *   catalog?: { has: (id: unknown) => boolean, get?: (id: unknown) => object | undefined },
 *   templates?: Array<{ id: string, name: string, description: string, emoji: string, bits: object[], team: object }>,
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
  if (!isPlainObject(deps.bits) || typeof deps.bits.create !== 'function') {
    throw new TypeError('registerTeamRoutes: deps.bits (BitStore) is required');
  }
  const definitions = [
    defineRoute(deps, '/api/bots.teams', ['GET'], () => handleList(deps)),
    defineRoute(deps, '/api/bots.teams.create', ['POST'], (request) => handleCreate(deps, request)),
    defineRoute(deps, '/api/bots.teams.update', ['POST'], (request) => handleUpdate(deps, request)),
    defineRoute(deps, '/api/bots.teams.delete', ['POST'], (request) => handleDelete(deps, request)),
    defineRoute(deps, '/api/bots.teams.templates', ['GET'], () => handleTemplates(deps)),
    defineRoute(deps, '/api/bots.teams.fromTemplate', ['POST'], (request) => handleFromTemplate(deps, request)),
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
// Template instantiation (shared with host/harness-routes.js)
// -----------------------------------------------------------------------------

/**
 * Instantiate a validated template: create one fresh bit per `template.bits`
 * entry (catalog defaults for the character, overridden by the template
 * fields), then create the team with `bitKey → bitId` resolved. Created bits are
 * removed again when the team cannot be created, so a failed instantiation
 * leaves no orphan bits behind.
 *
 * @param {{ teams: any, bits: any, catalog?: any, projects?: any, log?: (m: string) => void }} deps
 * @param {{ bits: Array<Record<string, any>>, team: Record<string, any> }} template
 * @param {{ name?: string | null, projectId?: string | null }} [options]
 * @returns {Promise<{ team: Record<string, any>, bits: Array<Record<string, any>> }>}
 */
export async function instantiateTeamTemplate(deps, template, { name = undefined, projectId = null } = {}) {
  const catalog = isPlainObject(deps.catalog) && typeof deps.catalog.get === 'function' ? deps.catalog : null;
  const created = [];
  try {
    /** @type {Map<string, string>} */
    const bitIdByKey = new Map();
    for (const definition of template.bits) {
      if (definition.character !== null && definition.character !== undefined && catalog !== null && typeof catalog.has === 'function' && !catalog.has(definition.character)) {
        throw codedError('BIT_INVALID_CHARACTER', `bits: unknown bit character "${definition.character}"`);
      }
      /** @type {Record<string, any>} */
      const input = { name: definition.name, character: definition.character ?? null };
      const catalogRow =
        definition.character !== null && definition.character !== undefined && catalog !== null
          ? catalog.get(definition.character)
          : undefined;
      let instructions = definition.instructions;
      if (instructions === undefined && isPlainObject(catalogRow) && typeof catalogRow.instructions === 'string') {
        instructions = catalogRow.instructions;
      }
      if (isPlainObject(catalogRow)) {
        // The bit store does not inherit emoji/color from the catalog (§2), so
        // the catalog defaults are supplied here (§5.2).
        if (definition.emoji === undefined && typeof catalogRow.emoji === 'string') input.emoji = catalogRow.emoji;
        if (definition.color === undefined && typeof catalogRow.color === 'string' && COLOR_PATTERN.test(catalogRow.color)) {
          input.color = catalogRow.color;
        }
      }
      if (instructions !== undefined) input.instructions = instructions;
      if (definition.isOrchestrator !== undefined) input.isOrchestrator = definition.isOrchestrator;
      if (definition.model !== undefined) input.model = definition.model;
      if (definition.effort !== undefined) input.effort = definition.effort;
      if (definition.emoji !== undefined) input.emoji = definition.emoji;
      if (definition.color !== undefined) input.color = definition.color;
      const bit = await deps.bits.create(input);
      if (!isPlainObject(bit) || typeof bit.id !== 'string') {
        throw codedError('INTERNAL', 'bit store did not return a bit id');
      }
      created.push(bit);
      bitIdByKey.set(definition.key, bit.id);
    }
    const teamInput = { ...template.team };
    teamInput.members = template.team.members.map((member) => {
      const target = { ...member, bitId: bitIdByKey.get(member.bitKey) };
      delete target.bitKey;
      return target;
    });
    if (name !== undefined && name !== null) teamInput.name = name;
    if (projectId !== null && projectId !== undefined) {
      teamInput.projectIds = [projectId];
      teamInput.shared = false;
    }
    assertKnownProjects(deps, teamInput.projectIds);
    const team = await deps.teams.create(teamInput);
    return { team, bits: created };
  } catch (error) {
    for (const bit of created.reverse()) {
      try {
        // Roll back the record and the workspace directory it was created with.
        await deps.bits.remove(bit.id, { deleteWorkspace: true });
      } catch (rollbackError) {
        log(deps, `bots: could not roll back bit ${String(bit?.id)}: ${messageOf(rollbackError)}`);
      }
    }
    throw error;
  }
}

// -----------------------------------------------------------------------------
// Templates
// -----------------------------------------------------------------------------

/**
 * Validate one template bit definition.
 *
 * @param {unknown} raw
 * @param {number} index
 * @param {Set<string>} keys
 * @returns {Record<string, any>}
 * @throws Error describing the first problem
 */
function normalizeTemplateBit(raw, index, keys) {
  const field = `bits[${index}]`;
  if (!isPlainObject(raw)) throw new Error(`${field} must be an object`);
  if (typeof raw.key !== 'string' || !TEMPLATE_KEY_PATTERN.test(raw.key)) {
    throw new Error(`${field}.key must match /^[a-z0-9][a-z0-9_-]{0,63}$/`);
  }
  if (keys.has(raw.key)) throw new Error(`${field}.key: duplicate key "${raw.key}"`);
  keys.add(raw.key);
  if (typeof raw.name !== 'string') throw new Error(`${field}.name is required and must be a string`);
  const name = raw.name.trim();
  if (name.length < 1 || name.length > MAX_BIT_NAME) throw new Error(`${field}.name must be 1-${MAX_BIT_NAME} characters`);
  /** @type {Record<string, any>} */
  const bit = { key: raw.key, name, character: null };
  if (raw.character !== undefined && raw.character !== null && raw.character !== '') {
    if (typeof raw.character !== 'string' || !CHARACTER_PATTERN.test(raw.character)) {
      throw new Error(`${field}.character must be a lowercase bit id such as "bit-builder" or null`);
    }
    bit.character = raw.character;
  }
  if (raw.instructions !== undefined) {
    if (typeof raw.instructions !== 'string' || raw.instructions.length > MAX_BIT_INSTRUCTIONS) {
      throw new Error(`${field}.instructions must be a string of at most ${MAX_BIT_INSTRUCTIONS} characters`);
    }
    bit.instructions = raw.instructions;
  }
  if (raw.isOrchestrator !== undefined) {
    if (typeof raw.isOrchestrator !== 'boolean') throw new Error(`${field}.isOrchestrator must be a boolean`);
    bit.isOrchestrator = raw.isOrchestrator;
  }
  if (raw.model !== undefined) {
    if (typeof raw.model !== 'string' || raw.model.length > MAX_BIT_MODEL) {
      throw new Error(`${field}.model must be a string of at most ${MAX_BIT_MODEL} characters`);
    }
    bit.model = raw.model;
  }
  if (raw.effort !== undefined) {
    if (typeof raw.effort !== 'string' || raw.effort.length > MAX_BIT_EFFORT) {
      throw new Error(`${field}.effort must be a string of at most ${MAX_BIT_EFFORT} characters`);
    }
    bit.effort = raw.effort;
  }
  if (raw.emoji !== undefined) {
    if (typeof raw.emoji !== 'string' || Array.from(raw.emoji).length > MAX_BIT_EMOJI_CODE_POINTS) {
      throw new Error(`${field}.emoji must be a string of at most ${MAX_BIT_EMOJI_CODE_POINTS} characters`);
    }
    bit.emoji = raw.emoji;
  }
  if (raw.color !== undefined) {
    if (typeof raw.color !== 'string' || !COLOR_PATTERN.test(raw.color)) {
      throw new Error(`${field}.color must be a #rrggbb hex color`);
    }
    bit.color = raw.color.toLowerCase();
  }
  return bit;
}

/**
 * Validate one parsed template document (V5-CONTRACT §5.2). The `team` is
 * validated by {@link normalizeTeam} in template mode: members must reference an
 * entry of the template's own `bits` through `bitKey`. A template without
 * `bits` is invalid; a lead bit explicitly marked as a worker is invalid too.
 *
 * @param {unknown} raw
 * @param {string} fallbackId file basename without `.json`
 * @returns {{ id: string, name: string, description: string, emoji: string, bits: object[], team: Record<string, any> }}
 * @throws Error describing the first problem
 */
function normalizeTemplate(raw, fallbackId) {
  if (!isPlainObject(raw)) throw new Error('template must be a JSON object');
  const id = raw.id === undefined ? fallbackId : raw.id;
  if (typeof id !== 'string' || !TEMPLATE_ID_PATTERN.test(id)) throw new Error('id must match /^[a-z0-9][a-z0-9_-]{0,63}$/');
  if (!Array.isArray(raw.bits) || raw.bits.length === 0) throw new Error('bits is required and must be a non-empty array');
  const keys = new Set();
  const bits = raw.bits.map((bit, index) => normalizeTemplateBit(bit, index, keys));
  if (!isPlainObject(raw.team)) throw new Error('team must be an object');
  const teamBits = {
    get(key) {
      return keys.has(key) ? { id: key, isOrchestrator: undefined } : undefined;
    },
  };
  const team = normalizeTeam(raw.team, { memberBit: 'bitKey', bits: teamBits, requireLeadOrchestrator: false });
  if (team.lead !== null) {
    const leadMember = team.members.find((member) => member.id === team.lead);
    const leadBit = leadMember === undefined ? undefined : bits.find((bit) => bit.key === leadMember.bitKey);
    if (leadBit !== undefined && leadBit.isOrchestrator === false) {
      throw new Error(`lead "${team.lead}" references bit "${leadBit.key}" which is not an orchestrator`);
    }
  }
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
  return { id, name: rawName.trim(), description, emoji, bits, team };
}

/**
 * Synchronously load team templates from `<dir>/*.json` (sorted by file name).
 *
 * Each file follows the v5 template format above; `team` is validated in
 * template mode (`bitKey` members) and `bits` is returned as loaded. Invalid
 * files and duplicate ids are skipped and reported through `log`. A missing
 * directory yields `[]`.
 *
 * @param {string} dir absolute directory path
 * @param {(message: string) => void} [logFn] receives one line per skipped file
 * @returns {Array<{ id: string, name: string, description: string, emoji: string, bits: object[], team: Record<string, any> }>}
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
