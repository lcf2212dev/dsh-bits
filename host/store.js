/**
 * Durable JSON store for Bits plugin records (v5).
 *
 * Every bit is persisted as one record inside `<botsRoot>/bits.json`, a document
 * shaped `{ statusVersion: 2, bits: BitRecord[] }`. Mutations are serialized so
 * concurrent callers cannot lose each other's changes, and each write replaces
 * the file atomically (write a sibling temporary file, fsync it, then rename).
 *
 * A v4 `<botsRoot>/bots.json` is migrated once on `init()`: normal records are
 * converted to the v5 shape (drop `vm`, fill `isOrchestrator`/`model`/`effort`
 * from the catalog) and the old file is kept as `bots.json.migrated-<ts>`.
 * Corrupt documents are renamed aside (`bits.json.corrupt-<ts>`) and the store
 * starts empty, exactly like v4.
 *
 * Public read methods return deep copies, so callers can never mutate the
 * in-memory store by reference. Destructive workspace deletion is refused unless
 * the resolved workspace path really lives inside {@link BitStore#botsRoot}.
 *
 * @module host/store
 */

import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

/** Version stamped into every persisted document. */
const STATUS_VERSION = 2;
/** Bit id: 10 lowercase hexadecimal characters. */
const ID_PATTERN = /^[0-9a-f]{10}$/;
/** Accent color: `#rrggbb`. */
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const DEFAULT_EMOJI = '🤖';
/** Execution defaults for worker bits (invoked single-shot). */
export const DEFAULT_WORKER_MODEL = 'subscription/sonnet';
export const DEFAULT_WORKER_EFFORT = 'high';
/** Execution defaults for orchestrator bits (they run as DSH agents). */
export const DEFAULT_ORCHESTRATOR_MODEL = 'deepseek-account/deepseek-flash';
export const DEFAULT_ORCHESTRATOR_EFFORT = 'max';
const MAX_NAME_LENGTH = 60;
const MAX_INSTRUCTIONS_LENGTH = 20000;
const MAX_EMOJI_CODE_POINTS = 8;
const MAX_WORKSPACE_DIR_LENGTH = 1024;
const MAX_MODEL_LENGTH = 120;
const MAX_EFFORT_LENGTH = 20;
/** Hard cap on the number of stored bits. */
const MAX_BITS = 200;
/** Subscription models: workers only (orchestrators need a DSH chat route). */
const SUBSCRIPTION_MODEL_PATTERN = /^subscription\//;
const SUBSCRIPTION_ALIASES = new Set(['opus', 'sonnet', 'haiku']);
const CREATE_FIELDS = new Set([
  'id',
  'name',
  'character',
  'emoji',
  'color',
  'instructions',
  'isOrchestrator',
  'model',
  'effort',
  'workspaceDir',
]);
const PATCH_FIELDS = new Set([
  'name',
  'character',
  'emoji',
  'color',
  'instructions',
  'isOrchestrator',
  'model',
  'effort',
]);
/** Bit character id (`bit-...`); catalog membership is checked by the routes. */
const CHARACTER_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** Accent palette used when `color` is omitted; deterministic per bit id. */
const COLOR_PALETTE = Object.freeze([
  '#7c3aed',
  '#2563eb',
  '#0891b2',
  '#059669',
  '#d97706',
  '#dc2626',
  '#db2777',
  '#9333ea',
  '#0d9488',
  '#ea580c',
]);

/**
 * Build an `Error` carrying a stable machine-readable `code`.
 *
 * @param {string} code stable error code (e.g. `BOT_NOT_FOUND`)
 * @param {string} message human-readable message
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
 * Deep-copy a record through JSON so callers never share store state.
 *
 * @template T
 * @param {T} value
 * @returns {T}
 */
function cloneRecord(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * @param {string} message
 * @returns {never}
 */
function invalidPatch(message) {
  throw codedError('BOT_INVALID_PATCH', message);
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Pick a deterministic palette color from a bit id.
 *
 * @param {string} id 10 hex chars
 * @returns {string} `#rrggbb`
 */
function paletteColorFor(id) {
  return COLOR_PALETTE[Number.parseInt(id.slice(0, 2), 16) % COLOR_PALETTE.length];
}

/**
 * @param {unknown} value
 * @returns {string | null} normalized ISO timestamp, or `null`
 */
function normalizeTimestamp(value) {
  if (typeof value !== 'string') return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

/**
 * @param {unknown} value
 * @returns {string} trimmed bit name
 * @throws coded `BOT_INVALID_NAME`
 */
function normalizeName(value) {
  if (typeof value !== 'string') throw codedError('BOT_INVALID_NAME', 'Bit name is required');
  const name = value.trim();
  if (name.length < 1 || name.length > MAX_NAME_LENGTH) {
    throw codedError('BOT_INVALID_NAME', `Bit name must be 1-${MAX_NAME_LENGTH} characters`);
  }
  return name;
}

/**
 * @param {unknown} value
 * @param {string} fallback used when `value` is `undefined`
 * @returns {string}
 * @throws coded `BOT_INVALID_PATCH` for non-string or out-of-range values
 */
function normalizeEmoji(value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string') invalidPatch('emoji must be a string');
  const length = Array.from(value).length;
  if (length < 1 || length > MAX_EMOJI_CODE_POINTS) {
    invalidPatch(`emoji must contain 1-${MAX_EMOJI_CODE_POINTS} characters`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string | null} fallback used when `value` is `undefined`
 * @returns {string | null} character id, or `null` for a bit without a character
 * @throws coded `BOT_INVALID_PATCH`
 */
function normalizeCharacter(value, fallback) {
  if (value === undefined) return fallback;
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !CHARACTER_PATTERN.test(value)) {
    invalidPatch('character must be a lowercase bit id such as "bit-scout"');
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} fallback used when `value` is `undefined`
 * @returns {string} lowercase `#rrggbb`
 * @throws coded `BOT_INVALID_PATCH`
 */
function normalizeColor(value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !COLOR_PATTERN.test(value)) {
    invalidPatch('color must be a #rrggbb hex string');
  }
  return value.toLowerCase();
}

/**
 * @param {unknown} value
 * @returns {string}
 * @throws coded `BOT_INVALID_PATCH`
 */
function normalizeInstructions(value) {
  if (value === undefined) return '';
  if (typeof value !== 'string') invalidPatch('instructions must be a string');
  if (value.length > MAX_INSTRUCTIONS_LENGTH) {
    invalidPatch(`instructions must be at most ${MAX_INSTRUCTIONS_LENGTH} characters`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 * @throws coded `BOT_INVALID_PATCH`
 */
function normalizeIsOrchestrator(value) {
  if (typeof value !== 'boolean') invalidPatch('isOrchestrator must be a boolean');
  return value;
}

/**
 * @param {unknown} value
 * @returns {string} trimmed model string (may be empty)
 * @throws coded `BOT_INVALID_PATCH`
 */
function normalizeModel(value) {
  if (typeof value !== 'string') invalidPatch('model must be a string');
  const model = value.trim();
  if (model.length > MAX_MODEL_LENGTH) {
    invalidPatch(`model must be at most ${MAX_MODEL_LENGTH} characters`);
  }
  return model;
}

/**
 * @param {unknown} value
 * @returns {string} trimmed effort string (may be empty)
 * @throws coded `BOT_INVALID_PATCH`
 */
function normalizeEffort(value) {
  if (typeof value !== 'string') invalidPatch('effort must be a string');
  const effort = value.trim();
  if (effort.length > MAX_EFFORT_LENGTH) {
    invalidPatch(`effort must be at most ${MAX_EFFORT_LENGTH} characters`);
  }
  return effort;
}

/**
 * Whether a model string belongs to the subscription (Claude Code) family:
 * `subscription/<alias>` or a legacy bare `opus` / `sonnet` / `haiku`.
 *
 * @param {string} model normalized model string
 * @returns {boolean}
 */
function isSubscriptionModel(model) {
  const normalized = typeof model === 'string' ? model.trim().toLowerCase() : '';
  if (normalized === '') return false;
  return SUBSCRIPTION_MODEL_PATTERN.test(normalized) || SUBSCRIPTION_ALIASES.has(normalized);
}

/**
 * Orchestrator bits run as DSH agents, so they must point at a DSH chat route
 * (`<provider>/<model>`); a subscription model is worker-only (contract §1).
 *
 * @param {boolean} isOrchestrator
 * @param {string} model normalized model string
 * @throws coded `BOT_INVALID`
 */
function assertOrchestratorModel(isOrchestrator, model) {
  if (isOrchestrator !== true) return;
  if (!isSubscriptionModel(model)) return;
  throw codedError(
    'BOT_INVALID',
    `model: an orchestrator bit needs a DSH chat route (<provider>/<model>); "${model}" is a subscription model (workers only)`,
  );
}

/**
 * @param {unknown} value
 * @returns {string} absolute normalized workspace directory
 * @throws coded `BOT_INVALID_PATCH`
 */
function normalizeWorkspaceDir(value) {
  if (typeof value !== 'string' || value.trim() === '' || !path.isAbsolute(value)) {
    invalidPatch('workspaceDir must be an absolute path');
  }
  if (value.length > MAX_WORKSPACE_DIR_LENGTH) {
    invalidPatch(`workspaceDir must be at most ${MAX_WORKSPACE_DIR_LENGTH} characters`);
  }
  return path.resolve(value);
}

/**
 * Read an optional persisted string field, truncated to `max` characters.
 *
 * @param {unknown} value
 * @param {number} max
 * @returns {string | null} trimmed value, or `null` when the field is absent
 */
function readPersistedString(value, max) {
  if (typeof value !== 'string') return null;
  return value.trim().slice(0, max);
}

/**
 * @param {unknown} value
 * @param {number} maxLength
 * @returns {string | null} usable absolute path, or `null`
 */
function readPersistedWorkspaceDir(value, maxLength) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > maxLength || !path.isAbsolute(trimmed)) return null;
  return path.resolve(trimmed);
}

/**
 * Durable, DOM-free store for Bits plugin records.
 *
 * @example
 * const bits = new BitStore({ botsRoot: path.join(dshHome, 'bots'), catalog });
 * await bits.init();
 * const bit = await bits.create({ name: 'Pesquisador', character: 'bit-scout' });
 */
export class BitStore {
  /** @type {string} */
  #botsRoot;
  /** @type {string} */
  #file;
  /** @type {ReturnType<typeof import('./catalog.js').loadBitCatalog> | null} */
  #catalog;
  /** @type {((message: string) => void) | null} */
  #logFn;
  /** @type {Array<Record<string, any>>} */
  #records = [];
  /** Serializes mutating operations so concurrent updates cannot interleave. */
  #mutationChain = Promise.resolve();
  /** Serializes file writes (one atomic write at a time). */
  #writeChain = Promise.resolve();

  /**
   * @param {{ botsRoot: string, catalog?: any, log?: (message: string) => void }} options
   *   `botsRoot` must be an absolute directory path; `catalog` optionally
   *   provides the default `isOrchestrator`/`model`/`effort` per character.
   */
  constructor({ botsRoot, catalog = null, log = null } = {}) {
    if (typeof botsRoot !== 'string' || botsRoot.trim() === '' || !path.isAbsolute(botsRoot)) {
      throw new TypeError('BitStore: botsRoot must be an absolute path string');
    }
    this.#botsRoot = path.resolve(botsRoot);
    this.#file = path.join(this.#botsRoot, 'bits.json');
    this.#catalog = isPlainObject(catalog) ? catalog : null;
    this.#logFn = typeof log === 'function' ? log : null;
  }

  /**
   * Absolute root directory holding bit workspaces and the store document.
   * @returns {string}
   */
  get botsRoot() {
    return this.#botsRoot;
  }

  /**
   * Alias of {@link BitStore#botsRoot} (`bits` is the v5 product name).
   * @returns {string}
   */
  get bitsRoot() {
    return this.#botsRoot;
  }

  /**
   * Absolute path of the persisted JSON document.
   * @returns {string}
   */
  get file() {
    return this.#file;
  }

  /**
   * Create `botsRoot` and load the persisted document, migrating a v4
   * `bots.json` when no `bits.json` exists yet.
   *
   * A malformed JSON document (or one without a `bits` array) is renamed to
   * `bits.json.corrupt-<timestamp>` and the store starts empty; unreadable
   * paths/permission errors are rethrown.
   *
   * @returns {Promise<this>} this store, initialized
   */
  async init() {
    await this.#ensureRootDir();
    let raw;
    try {
      raw = await fs.readFile(this.#file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') {
        this.#records = [];
        await this.#migrateLegacyFile();
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
    if (!isPlainObject(parsed) || !Array.isArray(parsed.bits)) {
      await this.#renameAside(this.#file, 'corrupt');
      this.#records = [];
      this.#log('bits: bits.json is corrupt; started empty');
      return this;
    }
    this.#records = this.#normalizeLoadedRecords(parsed.bits);
    return this;
  }

  /**
   * @returns {Array<Record<string, any>>} deep-copied records in creation order
   */
  list() {
    return this.#records.map((record) => cloneRecord(record));
  }

  /**
   * @param {unknown} id
   * @returns {Record<string, any> | undefined} deep copy, or `undefined`
   */
  get(id) {
    const index = this.#indexOf(id);
    return index < 0 ? undefined : cloneRecord(this.#records[index]);
  }

  /**
   * Find a bit whose workspace directory matches `dir`.
   *
   * Compares `path.resolve` of both sides, and additionally compares real paths
   * (symlink targets) when both resolve. The bit's own folder name may be a
   * symlink, so `dir` does not need to be byte-identical to the stored path.
   *
   * @param {unknown} dir absolute or relative directory path
   * @returns {Record<string, any> | undefined} deep copy, or `undefined`
   */
  getByWorkspace(dir) {
    if (typeof dir !== 'string' || dir.trim() === '') return undefined;
    const target = path.resolve(dir);
    const targetReal = this.#realpathOrNull(target);
    for (const record of this.#records) {
      if (typeof record.workspaceDir !== 'string') continue;
      const candidate = path.resolve(record.workspaceDir);
      if (candidate === target) return cloneRecord(record);
      if (targetReal === null) continue;
      const candidateReal = this.#realpathOrNull(candidate);
      if (candidateReal !== null && candidateReal === targetReal) return cloneRecord(record);
    }
    return undefined;
  }

  /**
   * Validate, create and persist a bit record.
   *
   * A known `character` supplies the defaults for `isOrchestrator`, `model` and
   * `effort` (contract §2/§4); otherwise the worker defaults are used, or the
   * orchestrator defaults when `isOrchestrator` is true. The workspace directory
   * is created on create (creation never fails because of the mkdir).
   *
   * An orchestrator bit must point at a DSH chat route (`<provider>/<model>`):
   * a subscription model is worker-only and is refused with `BOT_INVALID`.
   *
   * @param {{ id?: string, name: string, character?: string | null, emoji?: string,
   *   color?: string, instructions?: string, isOrchestrator?: boolean,
   *   model?: string, effort?: string, workspaceDir?: string }} [input]
   * @returns {Promise<Record<string, any>>} deep copy of the created record
   * @throws coded `BOT_INVALID_NAME`, `BOT_INVALID_PATCH`, `BOT_ID_EXISTS`,
   *   `BOT_LIMIT`, `BOT_INVALID` (orchestrator with a subscription model)
   */
  async create(input = {}) {
    return this.#mutate(() => this.#createRecord(input));
  }

  /**
   * Apply a partial patch and persist the updated record.
   *
   * The patched record is re-validated as a whole: an orchestrator bit cannot be
   * left (or promoted) on a subscription model (`BOT_INVALID`), so promoting a
   * worker requires patching `model` to a DSH route in the same update.
   *
   * @param {string} id
   * @param {{ name?: string, character?: string | null, emoji?: string,
   *   color?: string, instructions?: string, isOrchestrator?: boolean,
   *   model?: string, effort?: string }} patch
   * @returns {Promise<Record<string, any>>} deep copy of the updated record
   * @throws coded `BOT_NOT_FOUND`, `BOT_INVALID_PATCH`, `BOT_INVALID_NAME`,
   *   `BOT_INVALID` (orchestrator with a subscription model)
   */
  async update(id, patch) {
    return this.#mutate(() => this.#updateRecord(id, patch));
  }

  /**
   * Remove a bit record, optionally deleting its workspace directory.
   *
   * The workspace path is validated against the store's real root *before* the
   * record is removed, so a refused deletion leaves the store untouched. When
   * deletion is requested and allowed, the record is persisted as removed first
   * and only then is the directory deleted recursively.
   *
   * @param {string} id
   * @param {{ deleteWorkspace?: boolean }} [options]
   * @returns {Promise<Record<string, any>>} deep copy of the removed record
   * @throws coded `BOT_NOT_FOUND`, `BOT_WORKSPACE_OUTSIDE_ROOT`
   */
  async remove(id, { deleteWorkspace = false } = {}) {
    return this.#mutate(() => this.#removeRecord(id, deleteWorkspace === true));
  }

  /**
   * Ensure the bit workspace directory exists.
   *
   * @param {Record<string, any> | string} record bit record (or bit id)
   * @returns {Promise<string>} absolute workspace directory path
   * @throws coded `BOT_NOT_FOUND`, `BOT_INVALID_PATCH`
   */
  async ensureWorkspace(record) {
    const resolved = typeof record === 'string' ? this.get(record) : record;
    if (!isPlainObject(resolved)) {
      throw codedError('BOT_NOT_FOUND', `Bit "${String(record)}" was not found`);
    }
    const workspaceDir = resolved.workspaceDir;
    if (typeof workspaceDir !== 'string' || workspaceDir.trim() === '' || !path.isAbsolute(workspaceDir)) {
      throw codedError('BOT_INVALID_PATCH', 'Bit record has no absolute workspaceDir');
    }
    const absolute = path.resolve(workspaceDir);
    await fs.mkdir(absolute, { recursive: true, mode: 0o700 });
    return absolute;
  }

  /**
   * Delete one bit's workspace directory after validating that it lives inside
   * the store root (never escapes it, directly or through a symlink).
   *
   * @param {Record<string, any> | string} record bit record (or bit id)
   * @returns {Promise<string>} the deleted absolute path
   * @throws coded `BOT_NOT_FOUND`, `BOT_INVALID_PATCH`, `BOT_WORKSPACE_OUTSIDE_ROOT`
   */
  async deleteWorkspace(record) {
    const resolved = typeof record === 'string' ? this.get(record) : record;
    if (!isPlainObject(resolved)) {
      throw codedError('BOT_NOT_FOUND', `Bit "${String(record)}" was not found`);
    }
    const workspaceDir = this.#workspaceDirOf(resolved);
    if (workspaceDir === null) {
      throw codedError('BOT_INVALID_PATCH', 'Bit record has no absolute workspaceDir');
    }
    const target = await this.#assertWorkspaceInsideRoot(workspaceDir);
    await fs.rm(target, { recursive: true, force: true });
    return target;
  }

  /**
   * Persist the current records atomically. Writes are serialized: a second
   * `flush()` waits for the first, so the file is never interleaved or partial.
   *
   * @returns {Promise<void>}
   */
  flush() {
    const task = async () => {
      const contents = `${JSON.stringify({ statusVersion: STATUS_VERSION, bits: this.#records }, null, 2)}\n`;
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
  // Mutations (serialized through #mutationChain)
  // ---------------------------------------------------------------------------

  /**
   * Run one mutation after all previously queued mutations settled.
   *
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
   * @param {Record<string, any>} input
   * @returns {Promise<Record<string, any>>}
   */
  async #createRecord(input) {
    if (!isPlainObject(input)) invalidPatch('create() expects an object');
    for (const key of Object.keys(input)) {
      if (!CREATE_FIELDS.has(key)) invalidPatch(`Unknown bit field "${key}"`);
    }
    if (this.#records.length >= MAX_BITS) {
      throw codedError('BOT_LIMIT', `At most ${MAX_BITS} bits are supported`);
    }
    const name = normalizeName(input.name);
    const id = this.#allocateId(input.id);
    const character = normalizeCharacter(input.character, null);
    const catalogBit = this.#catalogBit(character);
    const isOrchestrator =
      input.isOrchestrator === undefined
        ? catalogBit !== null && catalogBit.isOrchestrator === true
        : normalizeIsOrchestrator(input.isOrchestrator);
    const defaults = this.#defaultsFor(character, isOrchestrator);
    const now = new Date().toISOString();
    /** @type {Record<string, any>} */
    const record = {
      id,
      name,
      character,
      emoji: normalizeEmoji(input.emoji, DEFAULT_EMOJI),
      color: normalizeColor(input.color, paletteColorFor(id)),
      instructions: normalizeInstructions(input.instructions),
      isOrchestrator,
      model: input.model === undefined ? defaults.model : normalizeModel(input.model),
      effort: input.effort === undefined ? defaults.effort : normalizeEffort(input.effort),
      workspaceDir:
        input.workspaceDir === undefined
          ? path.join(this.#botsRoot, id, 'workspace')
          : normalizeWorkspaceDir(input.workspaceDir),
      createdAt: now,
      updatedAt: now,
    };
    assertOrchestratorModel(record.isOrchestrator, record.model);
    this.#records.push(record);
    try {
      await this.flush();
    } catch (error) {
      this.#records.pop();
      throw error;
    }
    // Contract §2: the workspace is created with the record. A failed mkdir is
    // logged but never fails the creation (the same resilience the v4 route had).
    await this.#ensureWorkspaceDir(record.workspaceDir);
    return cloneRecord(record);
  }

  /**
   * @param {string} id
   * @param {unknown} patch
   * @returns {Promise<Record<string, any>>}
   */
  async #updateRecord(id, patch) {
    const index = this.#indexOf(id);
    if (index < 0) throw codedError('BOT_NOT_FOUND', `Bit "${String(id)}" was not found`);
    if (!isPlainObject(patch)) invalidPatch('update() patch must be an object');
    for (const key of Object.keys(patch)) {
      if (!PATCH_FIELDS.has(key)) invalidPatch(`Cannot update bit field "${key}"`);
    }
    const current = this.#records[index];
    /** @type {Record<string, any>} */
    const next = { ...current };
    if (patch.name !== undefined) next.name = normalizeName(patch.name);
    if (patch.character !== undefined) next.character = normalizeCharacter(patch.character, current.character ?? null);
    if (patch.emoji !== undefined) next.emoji = normalizeEmoji(patch.emoji, current.emoji);
    if (patch.color !== undefined) next.color = normalizeColor(patch.color, current.color);
    if (patch.instructions !== undefined) next.instructions = normalizeInstructions(patch.instructions);
    if (patch.isOrchestrator !== undefined) next.isOrchestrator = normalizeIsOrchestrator(patch.isOrchestrator);
    if (patch.model !== undefined) next.model = normalizeModel(patch.model);
    if (patch.effort !== undefined) next.effort = normalizeEffort(patch.effort);
    assertOrchestratorModel(next.isOrchestrator, next.model);
    next.updatedAt = new Date().toISOString();
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
   * @param {string} id
   * @param {boolean} deleteWorkspace
   * @returns {Promise<Record<string, any>>}
   */
  async #removeRecord(id, deleteWorkspace) {
    const index = this.#indexOf(id);
    if (index < 0) throw codedError('BOT_NOT_FOUND', `Bit "${String(id)}" was not found`);
    const record = this.#records[index];
    const workspaceDir = this.#workspaceDirOf(record);
    let deleteTarget = null;
    if (deleteWorkspace) {
      if (workspaceDir === null) {
        throw codedError('BOT_WORKSPACE_OUTSIDE_ROOT', 'Refusing to delete workspace: bit has no usable workspaceDir');
      }
      deleteTarget = await this.#assertWorkspaceInsideRoot(workspaceDir);
    }
    this.#records.splice(index, 1);
    try {
      await this.flush();
    } catch (error) {
      this.#records.splice(index, 0, record);
      throw error;
    }
    if (deleteWorkspace) await fs.rm(deleteTarget, { recursive: true, force: true });
    return cloneRecord(record);
  }

  // ---------------------------------------------------------------------------
  // Catalog-aware defaults
  // ---------------------------------------------------------------------------

  /**
   * @param {string | null} character
   * @returns {Record<string, any> | null}
   */
  #catalogBit(character) {
    if (typeof character !== 'string' || this.#catalog === null) return null;
    try {
      if (typeof this.#catalog.get === 'function') {
        const bit = this.#catalog.get(character);
        return isPlainObject(bit) ? bit : null;
      }
      if (typeof this.#catalog.has === 'function' && this.#catalog.has(character)) {
        const bit = this.#catalog.get?.(character);
        return isPlainObject(bit) ? bit : null;
      }
    } catch {
      // A broken catalog must never break the store.
    }
    return null;
  }

  /**
   * Resolve the `{ model, effort }` defaults for a new/reset record.
   *
   * A known character supplies its catalog defaults when its catalog row belongs
   * to the same family (`isOrchestrator`) as the record; otherwise the family
   * defaults apply, so an orchestrator never silently inherits a subscription
   * worker model.
   *
   * @param {string | null} character
   * @param {boolean} isOrchestrator
   * @returns {{ model: string, effort: string }}
   */
  #defaultsFor(character, isOrchestrator) {
    const orchestrator = isOrchestrator === true;
    const catalogBit = this.#catalogBit(character);
    const sameFamily = catalogBit !== null && (catalogBit.isOrchestrator === true) === orchestrator;
    const model =
      sameFamily && typeof catalogBit.model === 'string' && catalogBit.model.trim() !== ''
        ? catalogBit.model.trim()
        : orchestrator
          ? DEFAULT_ORCHESTRATOR_MODEL
          : DEFAULT_WORKER_MODEL;
    const effort =
      sameFamily && typeof catalogBit.effort === 'string' && catalogBit.effort.trim() !== ''
        ? catalogBit.effort.trim()
        : orchestrator
          ? DEFAULT_ORCHESTRATOR_EFFORT
          : DEFAULT_WORKER_EFFORT;
    return { model, effort };
  }

  // ---------------------------------------------------------------------------
  // Persistence helpers
  // ---------------------------------------------------------------------------

  /** @returns {Promise<void>} */
  async #ensureRootDir() {
    await fs.mkdir(this.#botsRoot, { recursive: true, mode: 0o700 });
  }

  /**
   * Best-effort workspace creation used by `create()`.
   *
   * @param {string} workspaceDir
   * @returns {Promise<void>}
   */
  async #ensureWorkspaceDir(workspaceDir) {
    try {
      await fs.mkdir(workspaceDir, { recursive: true, mode: 0o700 });
    } catch (error) {
      this.#log(`bits: could not create workspace ${workspaceDir}: ${messageOf(error)}`);
    }
  }

  /**
   * Write `contents` to a sibling temporary file and atomically rename it over
   * the store file. The temporary file is always removed on failure.
   *
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

  /**
   * Move `file` aside with a `.<kind>-<ts>` suffix.
   *
   * @param {string} file
   * @param {'corrupt' | 'migrated'} kind
   * @returns {Promise<string | null>} backup path, or `null` when the file is gone
   */
  async #renameAside(file, kind) {
    const backup = `${file}.${kind}-${Date.now()}`;
    try {
      await fs.rename(file, backup);
      return backup;
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Loading / migration helpers
  // ---------------------------------------------------------------------------

  /**
   * Migrate a v4 `bots.json` document into `bits.json` (contract §3.1).
   *
   * The new document is written *before* the legacy file is renamed, so a
   * failed rename can never lose records; the rename is still attempted and a
   * failure is only logged.
   *
   * @returns {Promise<boolean>} whether a legacy document was processed
   */
  async #migrateLegacyFile() {
    const legacyFile = path.join(this.#botsRoot, 'bots.json');
    let raw;
    try {
      raw = await fs.readFile(legacyFile, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    if (!isPlainObject(parsed) || !Array.isArray(parsed.bots)) {
      await this.#renameAside(legacyFile, 'corrupt');
      this.#records = [];
      this.#log('bits: legacy bots.json is corrupt; started empty');
      return false;
    }
    this.#records = this.#normalizeLoadedRecords(parsed.bots);
    await this.flush();
    try {
      const backup = await this.#renameAside(legacyFile, 'migrated');
      this.#log(
        `bits: migrated ${this.#records.length} bot(s) from bots.json to bits.json` +
          (backup === null ? '' : ` (backup ${path.basename(backup)})`),
      );
    } catch (error) {
      this.#log(`bits: could not rename legacy bots.json: ${messageOf(error)}`);
    }
    return true;
  }

  /**
   * Normalize a parsed array of persisted records, dropping unusable entries.
   *
   * @param {unknown[]} bits
   * @returns {Array<Record<string, any>>}
   */
  #normalizeLoadedRecords(bits) {
    const records = [];
    const usedIds = new Set();
    for (const raw of bits) {
      const record = this.#normalizeLoadedRecord(raw, usedIds);
      if (record === null) continue;
      usedIds.add(record.id);
      records.push(record);
    }
    return records;
  }

  /**
   * Coerce one persisted entry into a valid v5 record.
   *
   * Missing v5 execution fields are filled from the catalog character when
   * known, otherwise from the family defaults (contract §3.1). A `vm` field from
   * v4 data is dropped.
   *
   * @param {unknown} raw
   * @param {Set<string>} usedIds ids already taken by earlier entries
   * @returns {Record<string, any> | null} `null` when the entry is unusable
   */
  #normalizeLoadedRecord(raw, usedIds) {
    if (!isPlainObject(raw)) return null;
    const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, MAX_NAME_LENGTH) : '';
    if (name === '') return null;
    let id = typeof raw.id === 'string' && ID_PATTERN.test(raw.id) ? raw.id : null;
    if (id === null || usedIds.has(id)) {
      do {
        id = randomBytes(5).toString('hex');
      } while (usedIds.has(id));
    }
    const workspaceDir =
      readPersistedWorkspaceDir(raw.workspaceDir, MAX_WORKSPACE_DIR_LENGTH) ??
      path.join(this.#botsRoot, id, 'workspace');
    const emoji =
      typeof raw.emoji === 'string' &&
      Array.from(raw.emoji).length >= 1 &&
      Array.from(raw.emoji).length <= MAX_EMOJI_CODE_POINTS
        ? raw.emoji
        : DEFAULT_EMOJI;
    const character =
      typeof raw.character === 'string' && CHARACTER_PATTERN.test(raw.character) ? raw.character : null;
    const color =
      typeof raw.color === 'string' && COLOR_PATTERN.test(raw.color)
        ? raw.color.toLowerCase()
        : paletteColorFor(id);
    const instructions =
      typeof raw.instructions === 'string' ? raw.instructions.slice(0, MAX_INSTRUCTIONS_LENGTH) : '';
    const catalogBit = this.#catalogBit(character);
    const isOrchestrator =
      typeof raw.isOrchestrator === 'boolean'
        ? raw.isOrchestrator
        : catalogBit !== null && catalogBit.isOrchestrator === true;
    const defaults = this.#defaultsFor(character, isOrchestrator);
    const model = readPersistedString(raw.model, MAX_MODEL_LENGTH);
    const effort = readPersistedString(raw.effort, MAX_EFFORT_LENGTH);
    const createdAt =
      normalizeTimestamp(raw.createdAt) ?? normalizeTimestamp(raw.updatedAt) ?? new Date().toISOString();
    const updatedAt = normalizeTimestamp(raw.updatedAt) ?? createdAt;
    return {
      id,
      name,
      character,
      emoji,
      color,
      instructions,
      isOrchestrator,
      model: model ?? defaults.model,
      effort: effort ?? defaults.effort,
      workspaceDir,
      createdAt,
      updatedAt,
    };
  }

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------

  /**
   * @param {unknown} id
   * @returns {number} record index, or -1
   */
  #indexOf(id) {
    if (typeof id !== 'string') return -1;
    return this.#records.findIndex((record) => record.id === id);
  }

  /**
   * Absolute workspace directory of a record, or `null` when unusable.
   *
   * @param {Record<string, any>} record
   * @returns {string | null}
   */
  #workspaceDirOf(record) {
    if (!isPlainObject(record) || typeof record.workspaceDir !== 'string') return null;
    const trimmed = record.workspaceDir.trim();
    if (trimmed === '' || !path.isAbsolute(trimmed)) return null;
    return path.resolve(trimmed);
  }

  /**
   * @param {unknown} requestedId
   * @returns {string} unique 10 hex char id
   * @throws coded `BOT_INVALID_PATCH`, `BOT_ID_EXISTS`
   */
  #allocateId(requestedId) {
    if (requestedId !== undefined && requestedId !== null) {
      if (typeof requestedId !== 'string' || !ID_PATTERN.test(requestedId)) {
        invalidPatch('id must be 10 lowercase hexadecimal characters');
      }
      if (this.#records.some((record) => record.id === requestedId)) {
        throw codedError('BOT_ID_EXISTS', `A bit with id "${requestedId}" already exists`);
      }
      return requestedId;
    }
    let id;
    do {
      id = randomBytes(5).toString('hex');
    } while (this.#records.some((record) => record.id === id));
    return id;
  }

  /**
   * @param {string} workspaceDir absolute path
   * @returns {Promise<string>} validated real target path, safe to delete
   * @throws coded `BOT_WORKSPACE_OUTSIDE_ROOT` when the real path escapes the root
   */
  async #assertWorkspaceInsideRoot(workspaceDir) {
    let realRoot;
    try {
      realRoot = await fs.realpath(this.#botsRoot);
    } catch {
      realRoot = this.#botsRoot;
    }
    let realTarget = workspaceDir;
    try {
      realTarget = await fs.realpath(workspaceDir);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw codedError(
          'BOT_WORKSPACE_OUTSIDE_ROOT',
          `Refusing to delete workspace: cannot resolve ${workspaceDir}: ${error?.message ?? error}`,
        );
      }
    }
    const relative = path.relative(realRoot, realTarget);
    const inside = relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
    if (!inside) {
      throw codedError(
        'BOT_WORKSPACE_OUTSIDE_ROOT',
        `Refusing to delete workspace outside bits root: ${workspaceDir}`,
      );
    }
    return realTarget;
  }

  /**
   * @param {string} target
   * @returns {string | null}
   */
  #realpathOrNull(target) {
    try {
      return realpathSync(target);
    } catch {
      return null;
    }
  }

  /**
   * Log through the optional `log` callback without ever failing the store.
   *
   * @param {string} message
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

/** @deprecated v4 name kept for older imports; use {@link BitStore}. */
export { BitStore as BotStore };
