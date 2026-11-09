/**
 * Durable JSON store for Bots plugin teams (CONTRACT §10).
 *
 * A team groups bits into roles (members) and describes how work flows between
 * them as an editable graph (`flow.nodes` + `flow.edges`). Teams are pure data:
 * nothing here launches agents or touches the filesystem outside
 * `<botsRoot>/teams.json`.
 *
 * Persistence mirrors {@link import('./store.js').BotStore}: mutations are
 * serialized, every write is atomic (sibling temporary file, fsync, rename;
 * file mode 0600, directory 0700), mutators persist before resolving, and every
 * read returns a deep copy. A corrupt document is renamed to
 * `teams.json.corrupt-<timestamp>` and the store starts empty.
 *
 * Validation lives in the pure {@link normalizeTeam}; violations throw an
 * `Error` with `code: 'TEAM_INVALID'` and a message naming the field, e.g.
 * `members[2].id: duplicate id "builder"`. Unknown fields are dropped silently.
 *
 * @module host/teams
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/** Version stamped into every persisted document. */
const STATUS_VERSION = 1;
/** Team id: 10 lowercase hexadecimal characters. */
const TEAM_ID_PATTERN = /^[0-9a-f]{10}$/;
/** Member id inside one team. */
const MEMBER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** Bit character id (catalog membership is checked by the routes). */
const CHARACTER_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** Flow node / edge id. */
const GRAPH_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** Accent color: `#rrggbb`. */
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

const DEFAULT_EMOJI = '👥';
const DEFAULT_COLOR = '#2563eb';
const MAX_TEAMS = 200;
const MAX_NAME = 60;
const MAX_DESCRIPTION = 2000;
const MAX_EMOJI_CODE_POINTS = 8;
const MAX_WORKSPACE_DIR = 1024;
const MAX_MEMBERS = 64;
const MAX_ROLE = 200;
const MAX_MODEL = 60;
/** Profile provider id pinning the member's model (`anthropic-2`…); empty = automatic. */
const MAX_PROVIDER = 64;
const MAX_EFFORT = 20;
const MAX_INSTRUCTIONS = 40000;
const MAX_RULES = 40000;
const MAX_SKILLS = 64;
const MAX_ENTRY = 20;
const MAX_ENTRY_LABEL = 60;
const MAX_ENTRY_TEMPLATE = 2000;
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PACK_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MCP_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const MAX_MCP = 8;
const MAX_LAUNCHES = 64;
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
const PATCH_FIELDS = Object.freeze(['name', 'description', 'emoji', 'color', 'workspaceDir', 'members', 'flow', 'lead', 'harness', 'bindWorkspace', 'rules', 'skills', 'entry']);

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
 * @param {string} field dotted field path, e.g. `members[0].name`
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
 * @param {unknown} value
 * @returns {string | null}
 */
function normalizeTimestamp(value) {
  if (typeof value !== 'string') return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
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
 * @returns {string | null}
 */
function normalizeCharacter(value, field) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !CHARACTER_PATTERN.test(value)) {
    invalid(field, 'must be a lowercase bit id such as "bit-builder" or null');
  }
  return value;
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
 * Validate a full `members` array, including `launches` references.
 *
 * @param {unknown} value
 * @returns {Array<Record<string, any>>}
 */
/** Optional team id reference (another team); null when absent. */
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

/** Request templates offered by "Enviar AB" ({n} and {pedido} placeholders). */
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
 * Provider id that pins a member's model route to one profile provider
 * (`anthropic-2`, `deepseek-account`…). Empty string means automatic: the
 * runtime prefers the caller's provider, then the profile's registration order.
 *
 * @param {unknown} value
 * @param {string} field dotted field path
 * @returns {string}
 */
function normalizeProvider(value, field) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') invalid(field, 'must be a provider id string');
  const text = value.trim();
  if (text.length > MAX_PROVIDER) invalid(field, `must be at most ${MAX_PROVIDER} characters`);
  return text;
}

/** Lead member id (must be a member) or null. */
function normalizeLead(value, memberIds) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') invalid('lead', 'must be a member id or null');
  if (memberIds !== null && !memberIds.has(value)) invalid('lead', `unknown member "${value}"`);
  return value;
}

function normalizeMembers(value) {
  const raw = boundedArray(value, 'members', MAX_MEMBERS);
  const ids = new Set();
  const members = raw.map((entry, index) => {
    const field = `members[${index}]`;
    if (!isPlainObject(entry)) invalid(field, 'must be an object');
    if (typeof entry.id !== 'string' || !MEMBER_ID_PATTERN.test(entry.id)) {
      invalid(`${field}.id`, 'must match /^[a-z0-9][a-z0-9_-]{0,63}$/');
    }
    if (ids.has(entry.id)) invalid(`${field}.id`, `duplicate id "${entry.id}"`);
    ids.add(entry.id);
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
      character: normalizeCharacter(entry.character, `${field}.character`),
      name: requiredName(entry.name, `${field}.name`),
      role: optionalText(entry.role, `${field}.role`, MAX_ROLE),
      model: optionalText(entry.model, `${field}.model`, MAX_MODEL),
      provider: normalizeProvider(entry.provider, `${field}.provider`),
      effort: optionalText(entry.effort, `${field}.effort`, MAX_EFFORT),
      access,
      instructions: optionalText(entry.instructions, `${field}.instructions`, MAX_INSTRUCTIONS),
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
 * Pure team validator/normalizer (CONTRACT §10.1).
 *
 * Full mode (default) validates a complete team body, applies defaults and runs
 * every cross-field check (`launches`, step `memberId`, edge endpoints). It
 * returns `{ name, description, emoji, color, workspaceDir, members, flow }`;
 * `id`, `createdAt`, `updatedAt` and any unknown fields in `input` are ignored
 * (the store owns them).
 *
 * Partial mode (`{ partial: true }`) validates only the fields present in a
 * patch and returns just those, normalized. `members`/`flow` are whole
 * replacements; step `memberId` references are only checked when the patch also
 * carries `members` (the store re-validates the merged record in full mode).
 *
 * @param {unknown} input
 * @param {{ partial?: boolean }} [options]
 * @returns {Record<string, any>}
 * @throws coded `TEAM_INVALID` naming the offending field
 */
export function normalizeTeam(input, { partial = false } = {}) {
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
    if (has('members')) out.members = normalizeMembers(input.members);
    if (has('flow')) {
      const memberIds = out.members ? new Set(out.members.map((member) => member.id)) : null;
      out.flow = normalizeFlow(input.flow, memberIds);
    }
    if (Object.prototype.hasOwnProperty.call(input, 'lead')) {
      out.lead = normalizeLead(input.lead, out.members ? new Set(out.members.map((member) => member.id)) : null);
    }
    if (Object.prototype.hasOwnProperty.call(input, 'harness')) out.harness = normalizeHarness(input.harness);
    if (has('bindWorkspace')) out.bindWorkspace = input.bindWorkspace === true;
    if (has('rules')) out.rules = optionalText(input.rules, 'rules', MAX_RULES);
    if (has('skills')) out.skills = normalizeSkillNames(input.skills, 'skills');
    if (has('entry')) out.entry = normalizeEntry(input.entry);
    return out;
  }
  const members = normalizeMembers(input.members);
  return {
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
  };
}

// -----------------------------------------------------------------------------
// Store
// -----------------------------------------------------------------------------

/**
 * Durable store for team records in `<botsRoot>/teams.json`.
 *
 * @example
 * const teams = new TeamStore({ botsRoot: path.join(dshHome, 'bots') });
 * await teams.init();
 * const team = await teams.create({ name: 'DSC' });
 */
export class TeamStore {
  /** @type {string} */
  #botsRoot;
  /** @type {string} */
  #file;
  /** @type {Array<Record<string, any>>} */
  #records = [];
  /** Serializes mutating operations so concurrent updates cannot interleave. */
  #mutationChain = Promise.resolve();
  /** Serializes file writes (one atomic write at a time). */
  #writeChain = Promise.resolve();

  /**
   * @param {{ botsRoot: string }} options `botsRoot` must be an absolute path
   */
  constructor({ botsRoot } = {}) {
    if (typeof botsRoot !== 'string' || botsRoot.trim() === '' || !path.isAbsolute(botsRoot)) {
      throw new TypeError('TeamStore: botsRoot must be an absolute path string');
    }
    this.#botsRoot = path.resolve(botsRoot);
    this.#file = path.join(this.#botsRoot, 'teams.json');
  }

  /** @returns {string} absolute root directory */
  get botsRoot() {
    return this.#botsRoot;
  }

  /** @returns {string} absolute path of `teams.json` */
  get file() {
    return this.#file;
  }

  /**
   * Create `botsRoot` and load the persisted document. A missing file starts
   * empty; malformed JSON (or a document without a `teams` array) is renamed to
   * `teams.json.corrupt-<timestamp>` and the store starts empty. Individual
   * persisted teams that fail validation are dropped.
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
   * Validate, create and persist a team.
   *
   * @param {{ name: string, description?: string, emoji?: string, color?: string,
   *   workspaceDir?: string | null, members?: object[], flow?: object }} input
   * @returns {Promise<Record<string, any>>} deep copy of the created record
   * @throws coded `TEAM_INVALID`, `TEAM_LIMIT`
   */
  async create(input) {
    return this.#mutate(() => this.#createRecord(input));
  }

  /**
   * Apply a patch (`members`/`flow` replace whole) and persist. Cross-field
   * checks run on the merged record.
   *
   * @param {string} id
   * @param {Record<string, any>} patch
   * @returns {Promise<Record<string, any>>} deep copy of the updated record
   * @throws coded `TEAM_NOT_FOUND`, `TEAM_INVALID`
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
    const fields = normalizeTeam(input);
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
    const changes = normalizeTeam(patch, { partial: true });
    const current = this.#records[index];
    /** @type {Record<string, any>} */
    const merged = { ...cloneRecord(current) };
    for (const key of PATCH_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(changes, key)) merged[key] = changes[key];
    }
    const fields = normalizeTeam(merged);
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
   * Normalize persisted teams, dropping entries that no longer validate and
   * regenerating missing/duplicate ids.
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
      } catch {
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
}
