/**
 * Durable JSON store for Bits plugin teams (V5-CONTRACT §3.2, §5.1).
 *
 * A team is a flow whose members reference **bits by id** (`members[].bitId`)
 * and describes how work moves between them as an editable graph
 * (`flow.nodes` + `flow.edges`). Teams are pure data: nothing here launches
 * agents or touches the filesystem outside `<botsRoot>/teams.json`. A team also
 * carries a `shared` flag and the `projectIds` it belongs to (the projects
 * themselves live in `host/projects.js`; the store does not check that they
 * exist).
 *
 * Persistence mirrors {@link import('./store.js').BitStore}: mutations are
 * serialized, every write is atomic (sibling temporary file, fsync, rename;
 * file mode 0600, directory 0700), mutators persist before resolving, and every
 * read returns a deep copy. A corrupt document is renamed to
 * `teams.json.corrupt-<timestamp>` and the store starts empty.
 *
 * `init()` also migrates a v4 `teams.json` (members with embedded
 * character/name/model/instructions) to v5: every legacy member is converted
 * into a bit (deduplicated by `character|name|instructions`, the lead bit forced
 * to `isOrchestrator` / DeepSeek-V4.1-Flash Max) and the old file is backed up
 * as `teams.json.bak-<timestamp>`. The migration is idempotent, never loses a
 * team and never throws because the catalog or a character is missing.
 *
 * Validation lives in the pure {@link normalizeTeam}; violations throw an
 * `Error` with `code: 'TEAM_INVALID'` and a message naming the field, e.g.
 * `members[2].bitId: unknown bit "3f9a1c2b7e"`. A `lead` that is not a
 * member, or whose bit is not an orchestrator, is rejected with
 * `TEAM_LEAD_NOT_ORCHESTRATOR`. Unknown fields are dropped silently.
 *
 * @module host/teams
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/** Version stamped into every persisted document. */
const STATUS_VERSION = 2;
/** Team id: 10 lowercase hexadecimal characters. */
const TEAM_ID_PATTERN = /^[0-9a-f]{10}$/;
/** Member id inside one team. */
const MEMBER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** Bit id (V5-CONTRACT §2): 10 lowercase hexadecimal characters. */
const BIT_ID_PATTERN = /^[0-9a-f]{10}$/;
/** Flow node / edge id. */
const GRAPH_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** Accent color: `#rrggbb`. */
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

/** Worker bit defaults (V5-CONTRACT §2); also the v4→v5 migration fallback. */
const DEFAULT_WORKER_MODEL = 'subscription/sonnet';
const DEFAULT_WORKER_EFFORT = 'high';
/** Orchestrator bit defaults: DeepSeek-V4.1-Flash Max (V5-CONTRACT §1). */
const DEFAULT_ORCHESTRATOR_MODEL = 'deepseek-account/deepseek-flash';
const DEFAULT_ORCHESTRATOR_EFFORT = 'max';

const DEFAULT_EMOJI = '👥';
const DEFAULT_COLOR = '#2563eb';
const MAX_TEAMS = 200;
const MAX_NAME = 60;
const MAX_DESCRIPTION = 2000;
const MAX_EMOJI_CODE_POINTS = 8;
const MAX_WORKSPACE_DIR = 1024;
const MAX_MEMBERS = 64;
const MAX_ROLE = 200;
const MAX_RULES = 40000;
/** Bit instructions cap (V5-CONTRACT §2); v4 teams allowed more. */
const MAX_BIT_INSTRUCTIONS = 20000;
const MAX_SKILLS = 64;
const MAX_ENTRY = 20;
const MAX_ENTRY_LABEL = 60;
const MAX_ENTRY_TEMPLATE = 2000;
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PACK_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MCP_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const MAX_MCP = 8;
const MAX_LAUNCHES = 64;
/** Projects one team may belong to (CONTRACT §12.1). */
const MAX_PROJECT_IDS_PER_TEAM = 20;
const MAX_NODES = 500;
const MAX_EDGES = 1000;
const MAX_NODE_LABEL = 200;
const MAX_NODE_DETAIL = 4000;
const MAX_EDGE_LABEL = 120;
const COORD_LIMIT = 100000;
const SIZE_MIN = 40;
const SIZE_MAX = 4000;

const ACCESS_VALUES = Object.freeze(['read', 'write']);
const NODE_TYPES = Object.freeze(['start', 'end', 'step', 'decision', 'pause', 'group', 'note', 'team']);
const SIZED_NODE_TYPES = new Set(['group', 'note']);
const EDGE_KINDS = Object.freeze(['flow', 'loop', 'delegate', 'handoff']);
/** Fields a patch may replace; anything else is ignored. */
const PATCH_FIELDS = Object.freeze(['name', 'description', 'emoji', 'color', 'workspaceDir', 'members', 'flow', 'lead', 'harness', 'bindWorkspace', 'rules', 'skills', 'entry', 'shared', 'projectIds']);

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
 * @param {string} field dotted field path, e.g. `members[0].bitId`
 * @param {string} message
 * @returns {never}
 */
function invalid(field, message) {
  throw codedError('TEAM_INVALID', `${field}: ${message}`);
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
  if (typeof error === 'string' && error !== '') return error;
  return 'Unknown error';
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function normalizeTimestamp(value) {
  if (typeof value !== 'string') return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

/**
 * Trimmed non-empty string, or `null`.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
function trimmedOrNull(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text === '' ? null : text;
}

// -----------------------------------------------------------------------------
// Field validators (pure)
// -----------------------------------------------------------------------------

/**
 * Required trimmed name.
 *
 * @param {unknown} value
 * @param {string} field
 * @returns {string}
 */
function requiredName(value, field) {
  if (typeof value !== 'string') invalid(field, 'is required and must be a string');
  const name = value.trim();
  if (name.length < 1 || name.length > MAX_NAME) invalid(field, `must be 1-${MAX_NAME} characters`);
  return name;
}

/**
 * Optional bounded string; `undefined`/`null` become `""`.
 *
 * @param {unknown} value
 * @param {string} field
 * @param {number} max
 * @returns {string}
 */
function optionalText(value, field, max) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') invalid(field, 'must be a string');
  if (value.length > max) invalid(field, `must be at most ${max} characters`);
  return value;
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string}
 */
function normalizeEmoji(value, field) {
  if (value === undefined || value === null) return DEFAULT_EMOJI;
  if (typeof value !== 'string') invalid(field, 'must be a string');
  if (Array.from(value).length > MAX_EMOJI_CODE_POINTS) {
    invalid(field, `must contain at most ${MAX_EMOJI_CODE_POINTS} characters`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} field
 * @param {string | undefined} fallback returned for `undefined`/`null`
 * @returns {string | undefined} lowercase `#rrggbb`
 */
function normalizeColor(value, field, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || !COLOR_PATTERN.test(value)) invalid(field, 'must be a #rrggbb hex color');
  return value.toLowerCase();
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string | null}
 */
function normalizeWorkspaceDir(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') invalid(field, 'must be an absolute path string or null');
  const dir = value.trim();
  if (dir === '') return null;
  if (dir.length > MAX_WORKSPACE_DIR) invalid(field, `must be at most ${MAX_WORKSPACE_DIR} characters`);
  if (!path.isAbsolute(dir)) invalid(field, 'must be an absolute path');
  return dir;
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {number} integer clamped to ±COORD_LIMIT
 */
function normalizeCoord(value, field) {
  if (value === undefined || value === null) return 0;
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid(field, 'must be a finite number');
  return Math.round(Math.min(COORD_LIMIT, Math.max(-COORD_LIMIT, value))) || 0;
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {number | undefined} integer clamped to SIZE_MIN..SIZE_MAX, or `undefined`
 */
function normalizeSize(value, field) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid(field, 'must be a finite number');
  return Math.round(Math.min(SIZE_MAX, Math.max(SIZE_MIN, value)));
}

/**
 * @param {unknown} value
 * @param {string} field
 * @param {number} max
 * @returns {unknown[]}
 */
function boundedArray(value, field, max) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) invalid(field, 'must be an array');
  if (value.length > max) invalid(field, `must contain at most ${max} entries`);
  return value;
}

// -----------------------------------------------------------------------------
// Members and flow
// -----------------------------------------------------------------------------

/**
 * Optional team id reference (another team); null when absent.
 *
 * @param {unknown} value
 * @param {string} field
 * @returns {string | null}
 */
function normalizeTeamRef(value, field) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !TEAM_ID_PATTERN.test(value)) invalid(field, 'must be a team id (10 hex chars) or null');
  return value;
}

/** Skill name list (deduplicated). */
function normalizeSkillNames(value, field) {
  const names = boundedArray(value, field, MAX_SKILLS);
  names.forEach((name, index) => {
    if (typeof name !== 'string' || !SKILL_NAME_PATTERN.test(name)) invalid(`${field}[${index}]`, 'must be a skill name');
  });
  return [...new Set(names)];
}

/** MCP server names (from the harness pack) mounted for a member. */
function normalizeMcpNames(value, field) {
  const names = boundedArray(value, field, MAX_MCP);
  names.forEach((name, index) => {
    if (typeof name !== 'string' || !MCP_NAME_PATTERN.test(name)) invalid(`${field}[${index}]`, 'must be an MCP server name');
  });
  return [...new Set(names)];
}

/** Request templates offered by "Send request" ({n} and {request} placeholders). */
function normalizeEntry(value) {
  const raw = boundedArray(value, 'entry', MAX_ENTRY);
  const ids = new Set();
  return raw.map((entry, index) => {
    const field = `entry[${index}]`;
    if (!isPlainObject(entry)) invalid(field, 'must be an object');
    if (typeof entry.id !== 'string' || !GRAPH_ID_PATTERN.test(entry.id)) invalid(`${field}.id`, 'must match /^[A-Za-z0-9_-]{1,64}$/');
    if (ids.has(entry.id)) invalid(`${field}.id`, `duplicate id "${entry.id}"`);
    ids.add(entry.id);
    const label = requiredName(entry.label, `${field}.label`);
    if (label.length > MAX_ENTRY_LABEL) invalid(`${field}.label`, `must be at most ${MAX_ENTRY_LABEL} characters`);
    const template = optionalText(entry.template, `${field}.template`, MAX_ENTRY_TEMPLATE);
    if (!template.trim()) invalid(`${field}.template`, 'is required');
    return { id: entry.id, label, template };
  });
}

/** Pack id of the harness the team carries; null when none. */
function normalizeHarness(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !PACK_ID_PATTERN.test(value)) invalid('harness', 'must be a harness pack id or null');
  return value;
}

/**
 * Project ids the team belongs to: at most 20 entries of 10 lowercase hex
 * chars, deduplicated in their original order (CONTRACT §12.1). Whether the
 * referenced projects exist is checked by the routes, not by the store.
 *
 * @param {unknown} value
 * @returns {string[]}
 */
function normalizeProjectIds(value) {
  const ids = boundedArray(value, 'projectIds', MAX_PROJECT_IDS_PER_TEAM);
  ids.forEach((id, index) => {
    if (typeof id !== 'string' || !TEAM_ID_PATTERN.test(id)) invalid(`projectIds[${index}]`, 'must be a project id (10 hex chars)');
  });
  return [...new Set(ids)];
}

/**
 * Cross-field rule run on a complete (merged) record: a team that is not
 * shared can belong to at most one project.
 *
 * @param {Record<string, any>} team
 * @throws coded `TEAM_INVALID`
 */
function assertProjectLimit(team) {
  if (team.shared === false && team.projectIds.length > 1) {
    invalid('projectIds', 'a non-shared team can belong to only one project');
  }
}

/** Lead member id (must be a member) or null. */
function normalizeLead(value, memberIds) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') invalid('lead', 'must be a member id or null');
  if (memberIds !== null && !memberIds.has(value)) invalid('lead', `unknown member "${value}"`);
  return value;
}

/**
 * Validate a full `members` array, including `launches` references.
 *
 * Every member references a bit. Teams persisted since v5 use `bitId` (a
 * {@link BitStore} id); team **templates** use a local `bitKey` that the
 * template loader resolves against the template's `bits` array
 * (`memberBit: 'bitKey'`). With a bit store (or an equivalent `{ get }` lookup)
 * the reference must resolve; without one only the syntax is checked.
 *
 * @param {unknown} value
 * @param {{ bits?: { get: (id: string) => object | undefined } | null, memberBit?: 'bitId' | 'bitKey' }} [options]
 * @returns {Array<Record<string, any>>}
 */
function normalizeMembers(value, { bits = null, memberBit = 'bitId' } = {}) {
  const raw = boundedArray(value, 'members', MAX_MEMBERS);
  const ids = new Set();
  const isKey = memberBit === 'bitKey';
  const members = raw.map((entry, index) => {
    const field = `members[${index}]`;
    if (!isPlainObject(entry)) invalid(field, 'must be an object');
    if (typeof entry.id !== 'string' || !MEMBER_ID_PATTERN.test(entry.id)) {
      invalid(`${field}.id`, 'must match /^[a-z0-9][a-z0-9_-]{0,63}$/');
    }
    if (ids.has(entry.id)) invalid(`${field}.id`, `duplicate id "${entry.id}"`);
    ids.add(entry.id);
    const reference = entry[memberBit];
    if (reference === undefined || reference === null || reference === '') {
      invalid(`${field}.${memberBit}`, isKey ? 'is required and must be a template bit key' : 'is required and must be a bit id');
    }
    if (typeof reference !== 'string' || !(isKey ? MEMBER_ID_PATTERN : BIT_ID_PATTERN).test(reference)) {
      invalid(
        `${field}.${memberBit}`,
        isKey ? 'must match /^[a-z0-9][a-z0-9_-]{0,63}$/' : 'must be a bit id (10 lowercase hex characters)',
      );
    }
    if (bits !== null && typeof bits.get === 'function') {
      const bit = bits.get(reference);
      if (bit === undefined || bit === null) invalid(`${field}.${memberBit}`, `unknown ${isKey ? 'template bit' : 'bit'} "${reference}"`);
    }
    let access = 'write';
    if (entry.access !== undefined && entry.access !== null) {
      if (!ACCESS_VALUES.includes(entry.access)) invalid(`${field}.access`, 'must be "read" or "write"');
      access = entry.access;
    }
    const launches = boundedArray(entry.launches, `${field}.launches`, MAX_LAUNCHES);
    launches.forEach((launch, launchIndex) => {
      if (typeof launch !== 'string') invalid(`${field}.launches[${launchIndex}]`, 'must be a member id string');
    });
    return {
      id: entry.id,
      [memberBit]: reference,
      role: optionalText(entry.role, `${field}.role`, MAX_ROLE),
      access,
      launches: [...new Set(launches)],
      skills: normalizeSkillNames(entry.skills, `${field}.skills`),
      teamRef: normalizeTeamRef(entry.teamRef, `${field}.teamRef`),
      mcp: normalizeMcpNames(entry.mcp, `${field}.mcp`),
    };
  });
  members.forEach((member, index) => {
    member.launches.forEach((launch) => {
      if (!ids.has(launch)) invalid(`members[${index}].launches`, `unknown member id "${launch}"`);
    });
  });
  return members;
}

/**
 * Validate a full `flow` object.
 *
 * @param {unknown} value
 * @param {Set<string> | null} memberIds known member ids, or `null` to skip
 *   `memberId` existence checks (partial patch without `members`)
 * @returns {{ nodes: Array<Record<string, any>>, edges: Array<Record<string, any>> }}
 */
function normalizeFlow(value, memberIds) {
  if (value === undefined || value === null) return { nodes: [], edges: [] };
  if (!isPlainObject(value)) invalid('flow', 'must be an object with nodes and edges');
  const rawNodes = boundedArray(value.nodes, 'flow.nodes', MAX_NODES);
  const rawEdges = boundedArray(value.edges, 'flow.edges', MAX_EDGES);

  const nodeIds = new Set();
  const nodes = rawNodes.map((entry, index) => {
    const field = `flow.nodes[${index}]`;
    if (!isPlainObject(entry)) invalid(field, 'must be an object');
    if (typeof entry.id !== 'string' || !GRAPH_ID_PATTERN.test(entry.id)) {
      invalid(`${field}.id`, 'must match /^[A-Za-z0-9_-]{1,64}$/');
    }
    if (nodeIds.has(entry.id)) invalid(`${field}.id`, `duplicate id "${entry.id}"`);
    nodeIds.add(entry.id);
    if (!NODE_TYPES.includes(entry.type)) invalid(`${field}.type`, `must be one of ${NODE_TYPES.join(', ')}`);
    /** @type {Record<string, any>} */
    const node = {
      id: entry.id,
      type: entry.type,
      x: normalizeCoord(entry.x, `${field}.x`),
      y: normalizeCoord(entry.y, `${field}.y`),
    };
    if (SIZED_NODE_TYPES.has(entry.type)) {
      const w = normalizeSize(entry.w, `${field}.w`);
      const h = normalizeSize(entry.h, `${field}.h`);
      if (w !== undefined) node.w = w;
      if (h !== undefined) node.h = h;
    }
    node.label = optionalText(entry.label, `${field}.label`, MAX_NODE_LABEL);
    node.detail = optionalText(entry.detail, `${field}.detail`, MAX_NODE_DETAIL);
    if (entry.type === 'step') {
      let memberId = null;
      if (entry.memberId !== undefined && entry.memberId !== null && entry.memberId !== '') {
        if (typeof entry.memberId !== 'string') invalid(`${field}.memberId`, 'must be a member id string or null');
        if (memberIds !== null && !memberIds.has(entry.memberId)) {
          invalid(`${field}.memberId`, `unknown member "${entry.memberId}"`);
        }
        memberId = entry.memberId;
      }
      node.memberId = memberId;
    }
    if (entry.type === 'team') node.teamRef = normalizeTeamRef(entry.teamRef, `${field}.teamRef`);
    const color = normalizeColor(entry.color, `${field}.color`, undefined);
    if (color !== undefined) node.color = color;
    return node;
  });

  const edgeIds = new Set();
  const edges = rawEdges.map((entry, index) => {
    const field = `flow.edges[${index}]`;
    if (!isPlainObject(entry)) invalid(field, 'must be an object');
    if (typeof entry.id !== 'string' || !GRAPH_ID_PATTERN.test(entry.id)) {
      invalid(`${field}.id`, 'must match /^[A-Za-z0-9_-]{1,64}$/');
    }
    if (edgeIds.has(entry.id)) invalid(`${field}.id`, `duplicate id "${entry.id}"`);
    edgeIds.add(entry.id);
    for (const end of ['from', 'to']) {
      if (typeof entry[end] !== 'string' || !nodeIds.has(entry[end])) {
        invalid(`${field}.${end}`, `unknown node "${String(entry[end])}"`);
      }
    }
    if (entry.from === entry.to) invalid(`${field}.to`, 'an edge cannot connect a node to itself');
    let kind = 'flow';
    if (entry.kind !== undefined && entry.kind !== null) {
      if (!EDGE_KINDS.includes(entry.kind)) invalid(`${field}.kind`, `must be one of ${EDGE_KINDS.join(', ')}`);
      kind = entry.kind;
    }
    return {
      id: entry.id,
      from: entry.from,
      to: entry.to,
      label: optionalText(entry.label, `${field}.label`, MAX_EDGE_LABEL),
      kind,
    };
  });

  return { nodes, edges };
}

/**
 * The team lead, when set, must reference an orchestrator bit (V5-CONTRACT
 * §5.1). Skipped when no bit store is available or when the caller explicitly
 * opts out (template loading, which cannot know catalog defaults yet).
 *
 * @param {{ lead: string | null, members: Array<Record<string, any>> }} team
 * @param {{ get: (id: string) => object | undefined } | null} bits
 * @param {'bitId' | 'bitKey'} memberBit
 * @throws coded `TEAM_LEAD_NOT_ORCHESTRATOR`
 */
function assertLeadOrchestrator(team, bits, memberBit = 'bitId') {
  if (team.lead === null || bits === null || typeof bits.get !== 'function') return;
  const leadMember = team.members.find((member) => member.id === team.lead);
  if (leadMember === undefined) return; // normalizeLead already rejects this.
  const reference = leadMember[memberBit];
  if (typeof reference !== 'string') return;
  const bit = bits.get(reference);
  if (bit === undefined || bit === null) return; // member validation already rejects this.
  if (bit.isOrchestrator !== true) {
    throw codedError(
      'TEAM_LEAD_NOT_ORCHESTRATOR',
      `lead: bit "${reference}" of member "${leadMember.id}" is not an orchestrator`,
    );
  }
}

/**
 * Pure team validator/normalizer (V5-CONTRACT §5.1 + CONTRACT §12.1).
 *
 * Full mode (default) validates a complete team body, applies defaults and runs
 * every cross-field check (`launches`, step `memberId`, edge endpoints, the
 * project rule — a non-shared team may belong to at most one project — and,
 * when a bit store is given, the member `bitId` existence and lead-orchestrator
 * rules). It returns `{ name, description, emoji, color, workspaceDir, members,
 * flow, ..., shared, projectIds }`; `id`, `createdAt`, `updatedAt` and any
 * unknown fields in `input` are ignored (the store owns them).
 *
 * Partial mode (`{ partial: true }`) validates only the fields present in a
 * patch and returns just those, normalized. `members`/`flow` are whole
 * replacements; step `memberId` references are only checked when the patch also
 * carries `members` (the store re-validates the merged record in full mode).
 * The shared/project cross-field rule and the lead rule also run on the merged
 * record only. Project ids are checked for syntax only: whether they exist is a
 * route-level concern when a project store is available.
 *
 * Options:
 * - `bits`: `{ get(id) }` bit store (or template key lookup). When present,
 *   member references must resolve and the lead must be an orchestrator bit.
 * - `memberBit`: `'bitId'` (default) for persisted teams, `'bitKey'` for team
 *   templates (members reference the template's `bits` by local key).
 * - `requireLeadOrchestrator`: `false` to skip the lead rule even with `bits`
 *   (template loading).
 *
 * @param {unknown} input
 * @param {{ partial?: boolean, bits?: { get: (id: string) => object | undefined } | null,
 *   memberBit?: 'bitId' | 'bitKey', requireLeadOrchestrator?: boolean }} [options]
 * @returns {Record<string, any>}
 * @throws coded `TEAM_INVALID` / `TEAM_LEAD_NOT_ORCHESTRATOR` naming the offending field
 */
export function normalizeTeam(input, { partial = false, bits = null, memberBit = 'bitId', requireLeadOrchestrator = true } = {}) {
  if (!isPlainObject(input)) invalid(partial ? 'patch' : 'team', 'must be an object');
  if (partial) {
    /** @type {Record<string, any>} */
    const out = {};
    const has = (key) => Object.prototype.hasOwnProperty.call(input, key) && input[key] !== undefined;
    if (has('name')) out.name = requiredName(input.name, 'name');
    if (has('description')) out.description = optionalText(input.description, 'description', MAX_DESCRIPTION);
    if (has('emoji')) out.emoji = normalizeEmoji(input.emoji, 'emoji');
    if (has('color')) out.color = normalizeColor(input.color, 'color', DEFAULT_COLOR);
    if (Object.prototype.hasOwnProperty.call(input, 'workspaceDir')) {
      out.workspaceDir = normalizeWorkspaceDir(input.workspaceDir, 'workspaceDir');
    }
    if (has('members')) out.members = normalizeMembers(input.members, { bits, memberBit });
    if (has('flow')) {
      const memberIds = out.members ? new Set(out.members.map((member) => member.id)) : null;
      out.flow = normalizeFlow(input.flow, memberIds);
    }
    if (Object.prototype.hasOwnProperty.call(input, 'lead')) {
      out.lead = normalizeLead(input.lead, out.members ? new Set(out.members.map((member) => member.id)) : null);
    }
    if (out.members !== undefined && out.lead !== undefined && requireLeadOrchestrator) {
      assertLeadOrchestrator({ lead: out.lead, members: out.members }, bits, memberBit);
    }
    if (Object.prototype.hasOwnProperty.call(input, 'harness')) out.harness = normalizeHarness(input.harness);
    if (has('bindWorkspace')) out.bindWorkspace = input.bindWorkspace === true;
    if (has('rules')) out.rules = optionalText(input.rules, 'rules', MAX_RULES);
    if (has('skills')) out.skills = normalizeSkillNames(input.skills, 'skills');
    if (has('entry')) out.entry = normalizeEntry(input.entry);
    if (has('shared')) out.shared = input.shared === true;
    if (has('projectIds')) out.projectIds = normalizeProjectIds(input.projectIds);
    return out;
  }
  const members = normalizeMembers(input.members, { bits, memberBit });
  /** @type {Record<string, any>} */
  const team = {
    name: requiredName(input.name, 'name'),
    description: optionalText(input.description, 'description', MAX_DESCRIPTION),
    emoji: normalizeEmoji(input.emoji, 'emoji'),
    color: normalizeColor(input.color, 'color', DEFAULT_COLOR),
    workspaceDir: normalizeWorkspaceDir(input.workspaceDir, 'workspaceDir'),
    members,
    flow: normalizeFlow(input.flow, new Set(members.map((member) => member.id))),
    lead: normalizeLead(input.lead, new Set(members.map((member) => member.id))),
    harness: normalizeHarness(input.harness),
    bindWorkspace: input.bindWorkspace === true,
    rules: optionalText(input.rules, 'rules', MAX_RULES),
    skills: normalizeSkillNames(input.skills, 'skills'),
    entry: normalizeEntry(input.entry),
    shared: input.shared === true,
    projectIds: normalizeProjectIds(input.projectIds),
  };
  assertProjectLimit(team);
  if (requireLeadOrchestrator) assertLeadOrchestrator(team, bits, memberBit);
  return team;
}

// -----------------------------------------------------------------------------
// v4 → v5 migration helpers
// -----------------------------------------------------------------------------

/**
 * True when a persisted team still carries at least one legacy (v4) member,
 * i.e. a member object without a `bitId`.
 *
 * @param {unknown} team
 * @returns {boolean}
 */
function hasLegacyMembers(team) {
  if (!isPlainObject(team) || !Array.isArray(team.members)) return false;
  return team.members.some((member) => !isPlainObject(member) || typeof member.bitId !== 'string' || !BIT_ID_PATTERN.test(member.bitId));
}

/**
 * Dedupe key of one legacy member: `character|name|instructions` (trimmed).
 * A member without a character or name falls back to its own id, as specified
 * by V5-CONTRACT §3.2 ("missing → id"), so unrelated members never merge.
 * Instructions are truncated exactly like the bit that will be created for
 * them (§2 caps instructions at 20000 chars), so a later retry reuses that bit.
 *
 * @param {Record<string, any>} member
 * @returns {string}
 */
function legacyMemberDedupeKey(member) {
  const character = trimmedOrNull(member.character);
  const name = trimmedOrNull(member.name);
  if (character === null || name === null) return `member:${String(member.id)}`;
  const instructions = typeof member.instructions === 'string' ? member.instructions.slice(0, MAX_BIT_INSTRUCTIONS).trim() : '';
  return `${character}|${name}|${instructions}`;
}

/**
 * Dedupe key of an existing bit, in the same shape as
 * {@link legacyMemberDedupeKey} so a migration reuses the bit it created on a
 * previous attempt (or one created for another team/preset).
 *
 * @param {Record<string, any>} bit
 * @returns {string}
 */
function bitDedupeKey(bit) {
  const character = trimmedOrNull(bit.character);
  const name = trimmedOrNull(bit.name);
  if (character === null || name === null) return `bit:${String(bit.id)}`;
  const instructions = typeof bit.instructions === 'string' ? bit.instructions.slice(0, MAX_BIT_INSTRUCTIONS).trim() : '';
  return `${character}|${name}|${instructions}`;
}

/**
 * @param {Record<string, any>} team
 * @returns {string}
 */
function teamLabel(team) {
  const name = typeof team?.name === 'string' && team.name.trim() !== '' ? team.name.trim() : null;
  const id = typeof team?.id === 'string' && team.id !== '' ? team.id : 'unknown';
  return name === null ? `"${id}"` : `"${name}" (${id})`;
}

// -----------------------------------------------------------------------------
// Store
// -----------------------------------------------------------------------------

/**
 * Durable store for team records in `<botsRoot>/teams.json`.
 *
 * @example
 * const teams = new TeamStore({ botsRoot: path.join(dshHome, 'bots'), bits });
 * await teams.init();
 * const team = await teams.create({ name: 'DSC', members: [{ id: 'builder', bitId }] });
 */
export class TeamStore {
  /** @type {string} */
  #botsRoot;
  /** @type {string} */
  #file;
  /** @type {{ list: Function, get: Function, create: Function, update: Function }} */
  #bits;
  /** @type {{ get: (id: string) => object | undefined } | null} catalog row lookup (migration only) */
  #catalog;
  /** @type {((message: string) => void) | null} */
  #logFn;
  /** @type {Array<Record<string, any>>} */
  #records = [];
  /** @type {Record<string, number> | null} summary of the last migration, if one ran */
  #lastMigration = null;
  /** Serializes mutating operations so concurrent updates cannot interleave. */
  #mutationChain = Promise.resolve();
  /** Serializes file writes (one atomic write at a time). */
  #writeChain = Promise.resolve();

  /**
   * @param {{ botsRoot: string, bits: import('./store.js').BitStore,
   *   catalog?: { get: (id: string) => object | undefined } | null,
   *   log?: (message: string) => void }} options
   *   `botsRoot` must be an absolute path; `bits` is the bit store used to
   *   validate member references and to migrate v4 members; `catalog` is used
   *   only to give migrated bits their catalog emoji/color.
   */
  constructor({ botsRoot, bits, catalog = null, log = null } = {}) {
    if (typeof botsRoot !== 'string' || botsRoot.trim() === '' || !path.isAbsolute(botsRoot)) {
      throw new TypeError('TeamStore: botsRoot must be an absolute path string');
    }
    if (
      !isPlainObject(bits) ||
      typeof bits.list !== 'function' ||
      typeof bits.get !== 'function' ||
      typeof bits.create !== 'function' ||
      typeof bits.update !== 'function'
    ) {
      throw new TypeError('TeamStore: bits (BitStore) is required');
    }
    this.#botsRoot = path.resolve(botsRoot);
    this.#file = path.join(this.#botsRoot, 'teams.json');
    this.#bits = bits;
    this.#catalog = isPlainObject(catalog) && typeof catalog.get === 'function' ? catalog : null;
    this.#logFn = typeof log === 'function' ? log : null;
  }

  /** @returns {string} absolute root directory */
  get botsRoot() {
    return this.#botsRoot;
  }

  /** @returns {string} absolute path of `teams.json` */
  get file() {
    return this.#file;
  }

  /** Summary of the v4→v5 migration performed by the last {@link init}, or null. */
  get lastMigration() {
    return this.#lastMigration === null ? null : { ...this.#lastMigration };
  }

  /**
   * Create `botsRoot` and load the persisted document. A missing file starts
   * empty; malformed JSON (or a document without a `teams` array) is renamed to
   * `teams.json.corrupt-<timestamp>` and the store starts empty. A v4 document
   * is migrated in place (see {@link TeamStore}); individual persisted teams
   * that fail validation are dropped.
   *
   * @returns {Promise<this>}
   */
  async init() {
    await this.#ensureRootDir();
    let raw;
    try {
      raw = await fs.readFile(this.#file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') {
        this.#records = [];
        this.#lastMigration = null;
        return this;
      }
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    if (!isPlainObject(parsed) || !Array.isArray(parsed.teams)) {
      await this.#quarantineCorruptFile();
      this.#records = [];
      this.#lastMigration = null;
      return this;
    }
    const migration = await this.#migrateTeams(parsed.teams);
    this.#lastMigration = migration.changed || migration.summary.failed > 0 ? { ...migration.summary } : null;
    if (migration.changed) {
      const records = this.#normalizeLoadedTeams(migration.teams);
      await this.#backupFile();
      this.#records = records;
      await this.flush();
      const parts = [`${migration.summary.teams} teams`, `${migration.summary.bitsCreated} bits created`];
      if (migration.summary.bitsUpdated > 0) parts.push(`${migration.summary.bitsUpdated} bits updated`);
      if (migration.summary.failed > 0) parts.push(`${migration.summary.failed} kept unmigrated`);
      this.#log(`bots: migrated teams.json: ${parts.join(', ')}`);
      return this;
    }
    this.#records = this.#normalizeLoadedTeams(parsed.teams);
    return this;
  }

  /** @returns {Array<Record<string, any>>} deep copies in creation order */
  list() {
    return this.#records.map((record) => cloneRecord(record));
  }

  /**
   * @param {unknown} id
   * @returns {Record<string, any> | undefined}
   */
  get(id) {
    const index = this.#indexOf(id);
    return index < 0 ? undefined : cloneRecord(this.#records[index]);
  }

  /**
   * Validate, create and persist a team. Members reference bits by `bitId` and
   * the lead (when set) must reference an orchestrator bit.
   *
   * @param {{ name: string, description?: string, emoji?: string, color?: string,
   *   workspaceDir?: string | null, members?: object[], flow?: object }} input
   * @returns {Promise<Record<string, any>>} deep copy of the created record
   * @throws coded `TEAM_INVALID`, `TEAM_LEAD_NOT_ORCHESTRATOR`, `TEAM_LIMIT`
   */
  async create(input) {
    return this.#mutate(() => this.#createRecord(input));
  }

  /**
   * Apply a patch (`members`/`flow` replace whole) and persist. Cross-field
   * checks (including the bit references and the lead rule) run on the merged
   * record.
   *
   * @param {string} id
   * @param {Record<string, any>} patch
   * @returns {Promise<Record<string, any>>} deep copy of the updated record
   * @throws coded `TEAM_NOT_FOUND`, `TEAM_INVALID`, `TEAM_LEAD_NOT_ORCHESTRATOR`
   */
  async update(id, patch) {
    return this.#mutate(() => this.#updateRecord(id, patch));
  }

  /**
   * @param {string} id
   * @returns {Promise<Record<string, any>>} deep copy of the removed record
   * @throws coded `TEAM_NOT_FOUND`
   */
  async remove(id) {
    return this.#mutate(() => this.#removeRecord(id));
  }

  /**
   * Persist the current records atomically; writes are serialized.
   *
   * @returns {Promise<void>}
   */
  flush() {
    const task = async () => {
      const contents = `${JSON.stringify({ statusVersion: STATUS_VERSION, teams: this.#records }, null, 2)}\n`;
      await this.#writeFileAtomically(contents);
    };
    const result = this.#writeChain.then(task);
    this.#writeChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  // ---------------------------------------------------------------------------
  // Mutations
  // ---------------------------------------------------------------------------

  /**
   * @template T
   * @param {() => Promise<T>} operation
   * @returns {Promise<T>}
   */
  #mutate(operation) {
    const result = this.#mutationChain.then(operation);
    this.#mutationChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * @param {unknown} input
   * @returns {Promise<Record<string, any>>}
   */
  async #createRecord(input) {
    const fields = normalizeTeam(input, { bits: this.#bits });
    if (this.#records.length >= MAX_TEAMS) {
      throw codedError('TEAM_LIMIT', `At most ${MAX_TEAMS} teams can be stored`);
    }
    const now = new Date().toISOString();
    const record = { id: this.#allocateId(), ...fields, createdAt: now, updatedAt: now };
    this.#records.push(record);
    try {
      await this.flush();
    } catch (error) {
      this.#records.pop();
      throw error;
    }
    return cloneRecord(record);
  }

  /**
   * @param {unknown} id
   * @param {unknown} patch
   * @returns {Promise<Record<string, any>>}
   */
  async #updateRecord(id, patch) {
    const index = this.#indexOf(id);
    if (index < 0) throw codedError('TEAM_NOT_FOUND', `Team "${String(id)}" was not found`);
    const changes = normalizeTeam(patch, { partial: true, bits: this.#bits });
    const current = this.#records[index];
    /** @type {Record<string, any>} */
    const merged = { ...cloneRecord(current) };
    for (const key of PATCH_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(changes, key)) merged[key] = changes[key];
    }
    const fields = normalizeTeam(merged, { bits: this.#bits });
    const next = {
      id: current.id,
      ...fields,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString(),
    };
    this.#records[index] = next;
    try {
      await this.flush();
    } catch (error) {
      this.#records[index] = current;
      throw error;
    }
    return cloneRecord(next);
  }

  /**
   * @param {unknown} id
   * @returns {Promise<Record<string, any>>}
   */
  async #removeRecord(id) {
    const index = this.#indexOf(id);
    if (index < 0) throw codedError('TEAM_NOT_FOUND', `Team "${String(id)}" was not found`);
    const [record] = this.#records.splice(index, 1);
    try {
      await this.flush();
    } catch (error) {
      this.#records.splice(index, 0, record);
      throw error;
    }
    return cloneRecord(record);
  }

  // ---------------------------------------------------------------------------
  // v4 → v5 migration (V5-CONTRACT §3.2)
  // ---------------------------------------------------------------------------

  /**
   * Convert every persisted v4 team into v5 (members referencing bits).
   *
   * Idempotent: a document whose teams all use `bitId` members is returned
   * unchanged (`changed: false`). Bits are deduplicated by
   * `character|name|instructions` across members, teams and bits created by a
   * previous attempt; a failure on one team never loses it (the raw record is
   * preserved and retried on the next boot).
   *
   * @param {unknown[]} teams raw persisted teams
   * @returns {Promise<{ teams: unknown[], changed: boolean, summary: { teams: number, bitsCreated: number, bitsUpdated: number, failed: number } }>}
   */
  async #migrateTeams(teams) {
    const summary = { teams: 0, bitsCreated: 0, bitsUpdated: 0, failed: 0 };
    if (!teams.some((team) => isPlainObject(team) && hasLegacyMembers(team))) {
      return { teams, changed: false, summary };
    }
    /** @type {Map<string, string>} dedupe key → bit id */
    const byKey = new Map();
    let existing = [];
    try {
      existing = this.#bits.list();
    } catch (error) {
      this.#log(`bots: could not list bits for the teams migration: ${messageOf(error)}`);
      existing = [];
    }
    if (Array.isArray(existing)) {
      for (const bit of existing) {
        if (!isPlainObject(bit) || typeof bit.id !== 'string') continue;
        const key = bitDedupeKey(bit);
        if (!byKey.has(key)) byKey.set(key, bit.id);
      }
    }
    const migrated = [];
    for (const team of teams) {
      if (!isPlainObject(team) || !hasLegacyMembers(team)) {
        migrated.push(team);
        continue;
      }
      try {
        migrated.push(await this.#migrateTeam(team, byKey, summary));
        summary.teams += 1;
      } catch (error) {
        // Never lose a team: keep the raw record (load keeps it) and retry later.
        migrated.push(team);
        summary.failed += 1;
        this.#log(`bots: could not migrate team ${teamLabel(team)}: ${messageOf(error)}`);
      }
    }
    return { teams: migrated, changed: summary.teams > 0, summary };
  }

  /**
   * Migrate one v4 team: reuse/create one bit per legacy member and replace the
   * members with `{ id, bitId, role, access, launches, teamRef, mcp, skills }`.
   * Every other field (lead, flow, harness, shared, projectIds, entry…) is
   * copied untouched.
   *
   * @param {Record<string, any>} raw
   * @param {Map<string, string>} byKey dedupe key → bit id
   * @param {{ bitsCreated: number, bitsUpdated: number }} summary
   * @returns {Promise<Record<string, any>>}
   * @throws coded `TEAM_INVALID`/`TEAM_LEAD_NOT_ORCHESTRATOR` when the team cannot be converted
   */
  async #migrateTeam(raw, byKey, summary) {
    const leadId = typeof raw.lead === 'string' && raw.lead !== '' ? raw.lead : null;
    const members = [];
    for (const member of Array.isArray(raw.members) ? raw.members : []) {
      if (!isPlainObject(member)) throw codedError('TEAM_INVALID', 'members: must contain objects');
      const isLead = leadId !== null && member.id === leadId;
      let bitId =
        typeof member.bitId === 'string' && BIT_ID_PATTERN.test(member.bitId) ? member.bitId : null;
      if (bitId !== null) {
        if (isLead) await this.#forceOrchestratorBit(bitId, summary);
      } else {
        const key = legacyMemberDedupeKey(member);
        bitId = byKey.get(key) ?? null;
        if (bitId === null) {
          bitId = await this.#createMigratedBit(member, key, isLead, byKey, summary);
        } else if (isLead) {
          await this.#forceOrchestratorBit(bitId, summary);
        }
      }
      members.push({
        id: member.id,
        bitId,
        role: member.role,
        access: member.access,
        launches: member.launches,
        teamRef: member.teamRef,
        mcp: member.mcp,
        skills: member.skills,
      });
    }
    const migrated = { ...raw, members };
    // Throws (and keeps the raw team) when the conversion is not a valid v5 team.
    normalizeTeam(migrated, { bits: this.#bits });
    return migrated;
  }

  /**
   * Create the bit for one legacy member. The bit store fills catalog defaults
   * (isOrchestrator/model/effort) for a known `character`; the catalog is only
   * consulted here for emoji/color, which the store does not inherit
   * (V5-CONTRACT §3.2). The lead bit is always forced to the orchestrator route.
   *
   * @param {Record<string, any>} member
   * @param {string} key dedupe key
   * @param {boolean} isLead
   * @param {Map<string, string>} byKey
   * @param {{ bitsCreated: number }} summary
   * @returns {Promise<string>}
   */
  async #createMigratedBit(member, key, isLead, byKey, summary) {
    const character = trimmedOrNull(member.character);
    /** @type {Record<string, any>} */
    const input = {
      name: member.name,
      character,
      // v4 teams allowed up to 40000 chars of member instructions; the bit
      // record caps them at 20000 (§2), so truncate instead of failing.
      instructions: typeof member.instructions === 'string' ? member.instructions.slice(0, MAX_BIT_INSTRUCTIONS) : '',
    };
    const catalogRow = this.#catalogRow(character);
    if (catalogRow !== null) {
      if (typeof catalogRow.emoji === 'string' && catalogRow.emoji !== '') input.emoji = catalogRow.emoji;
      if (typeof catalogRow.color === 'string' && COLOR_PATTERN.test(catalogRow.color)) input.color = catalogRow.color;
    }
    if (isLead) {
      input.isOrchestrator = true;
      input.model = DEFAULT_ORCHESTRATOR_MODEL;
      input.effort = DEFAULT_ORCHESTRATOR_EFFORT;
    }
    const created = await this.#bits.create(input);
    if (!isPlainObject(created) || typeof created.id !== 'string' || created.id === '') {
      throw codedError('TEAM_INVALID', 'bit store did not return a bit id');
    }
    byKey.set(key, created.id);
    summary.bitsCreated += 1;
    return created.id;
  }

  /**
   * Make sure a reused bit can be a team lead (V5-CONTRACT §3.2: the lead bit is
   * forced to the orchestrator route). A bit reused by a lead that is still a
   * worker is updated in place.
   *
   * @param {string} bitId
   * @param {{ bitsUpdated: number }} summary
   * @returns {Promise<void>}
   */
  async #forceOrchestratorBit(bitId, summary) {
    const bit = this.#bits.get(bitId);
    if (bit === undefined || bit === null) return; // normalizeTeam reports the unknown bit.
    if (bit.isOrchestrator === true) return;
    await this.#bits.update(bitId, {
      isOrchestrator: true,
      model: DEFAULT_ORCHESTRATOR_MODEL,
      effort: DEFAULT_ORCHESTRATOR_EFFORT,
    });
    summary.bitsUpdated += 1;
  }

  /**
   * @param {string | null} character
   * @returns {Record<string, any> | null}
   */
  #catalogRow(character) {
    if (character === null || this.#catalog === null) return null;
    try {
      const row = this.#catalog.get(character);
      return isPlainObject(row) ? row : null;
    } catch {
      return null;
    }
  }

  /** Copy the v4 document aside before the migrated one replaces it. */
  async #backupFile() {
    const backup = `${this.#file}.bak-${Date.now()}`;
    await fs.copyFile(this.#file, backup);
    try {
      await fs.chmod(backup, 0o600);
    } catch {
      // Best effort; the copy is what matters.
    }
    return backup;
  }

  // ---------------------------------------------------------------------------
  // Persistence helpers
  // ---------------------------------------------------------------------------

  /** @returns {Promise<void>} */
  async #ensureRootDir() {
    await fs.mkdir(this.#botsRoot, { recursive: true, mode: 0o700 });
  }

  /**
   * @param {string} contents
   * @returns {Promise<void>}
   */
  async #writeFileAtomically(contents) {
    await this.#ensureRootDir();
    const serial = `${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}`;
    const temporary = `${this.#file}.tmp-${serial}`;
    /** @type {import('node:fs/promises').FileHandle | undefined} */
    let handle;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.chmod(0o600);
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(temporary, this.#file);
    } catch (error) {
      if (handle !== undefined) {
        try {
          await handle.close();
        } catch {
          // The original error is the interesting one.
        }
      }
      try {
        await fs.rm(temporary, { force: true });
      } catch {
        // Best effort cleanup; never mask the write error.
      }
      throw error;
    }
  }

  /** @returns {Promise<void>} */
  async #quarantineCorruptFile() {
    const backup = `${this.#file}.corrupt-${Date.now()}`;
    try {
      await fs.rename(this.#file, backup);
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
  }

  /**
   * Normalize persisted teams, dropping entries that no longer validate
   * structurally and regenerating missing/duplicate ids. Member references are
   * checked for syntax only (the authoritative bit checks run on
   * create/update): a bit that was removed or demoted must not make a whole
   * team disappear from the page.
   *
   * A legacy (v4) record whose migration failed is kept as-is instead of being
   * dropped, so a migration error can never lose a team.
   *
   * @param {unknown[]} teams
   * @returns {Array<Record<string, any>>}
   */
  #normalizeLoadedTeams(teams) {
    const records = [];
    const usedIds = new Set();
    for (const raw of teams) {
      if (records.length >= MAX_TEAMS) break;
      if (!isPlainObject(raw)) continue;
      let fields;
      try {
        fields = normalizeTeam(raw);
      } catch (error) {
        if (hasLegacyMembers(raw)) {
          records.push(this.#preserveRawRecord(raw, usedIds));
          this.#log(`bots: team ${teamLabel(raw)} kept unmigrated: ${messageOf(error)}`);
        }
        continue;
      }
      let id = typeof raw.id === 'string' && TEAM_ID_PATTERN.test(raw.id) ? raw.id : null;
      if (id === null || usedIds.has(id)) {
        do {
          id = randomBytes(5).toString('hex');
        } while (usedIds.has(id));
      }
      usedIds.add(id);
      const createdAt = normalizeTimestamp(raw.createdAt) ?? normalizeTimestamp(raw.updatedAt) ?? new Date().toISOString();
      const updatedAt = normalizeTimestamp(raw.updatedAt) ?? createdAt;
      records.push({ id, ...fields, createdAt, updatedAt });
    }
    return records;
  }

  /**
   * Keep a raw legacy record (migration failed) without requiring it to
   * validate, so the data can be migrated on a later boot.
   *
   * @param {Record<string, any>} raw
   * @param {Set<string>} usedIds
   * @returns {Record<string, any>}
   */
  #preserveRawRecord(raw, usedIds) {
    let id = typeof raw.id === 'string' && TEAM_ID_PATTERN.test(raw.id) ? raw.id : null;
    if (id === null || usedIds.has(id)) {
      do {
        id = randomBytes(5).toString('hex');
      } while (usedIds.has(id));
    }
    usedIds.add(id);
    const createdAt = normalizeTimestamp(raw.createdAt) ?? normalizeTimestamp(raw.updatedAt) ?? new Date().toISOString();
    const updatedAt = normalizeTimestamp(raw.updatedAt) ?? createdAt;
    return { ...raw, id, createdAt, updatedAt };
  }

  /**
   * @param {unknown} id
   * @returns {number}
   */
  #indexOf(id) {
    if (typeof id !== 'string') return -1;
    return this.#records.findIndex((record) => record.id === id);
  }

  /** @returns {string} unique 10 hex char id */
  #allocateId() {
    let id;
    do {
      id = randomBytes(5).toString('hex');
    } while (this.#records.some((record) => record.id === id));
    return id;
  }

  /**
   * @param {string} message
   * @returns {void}
   */
  #log(message) {
    if (this.#logFn === null) return;
    try {
      this.#logFn(message);
    } catch {
      // Logging must never break the store.
    }
  }
}
