/**
 * Durable JSON store for Bots plugin records.
 *
 * Every bot is persisted as one record inside `<botsRoot>/bots.json`, a document
 * shaped `{ statusVersion: 1, bots: BotRecord[] }`. Mutations are serialized so
 * concurrent callers cannot lose each other's changes, and each write replaces
 * the file atomically (write a sibling temporary file, fsync it, then rename).
 *
 * Public read methods return deep copies, so callers can never mutate the
 * in-memory store by reference. Destructive workspace deletion is refused unless
 * the resolved workspace path really lives inside {@link BotStore#botsRoot}.
 *
 * @module host/store
 */

import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

/** Version stamped into every persisted document. */
const STATUS_VERSION = 1;
/** Bot id: 10 lowercase hexadecimal characters. */
const ID_PATTERN = /^[0-9a-f]{10}$/;
/** Accent color: `#rrggbb`. */
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
/** Docker image reference accepted for `vm.image`. */
const IMAGE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,199}$/;
const DEFAULT_EMOJI = '🤖';
const DEFAULT_IMAGE = 'ubuntu:24.04';
const MAX_NAME_LENGTH = 60;
const MAX_INSTRUCTIONS_LENGTH = 20000;
const MAX_EMOJI_CODE_POINTS = 8;
const CREATE_FIELDS = new Set(['id', 'name', 'character', 'emoji', 'color', 'instructions', 'workspaceDir', 'vm']);
const PATCH_FIELDS = new Set(['name', 'character', 'emoji', 'color', 'instructions', 'vm']);
/** Bit character id (`bit-...`); catalog membership is checked by the routes. */
const CHARACTER_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const VM_FIELDS = new Set(['enabled', 'image']);
/** Accent palette used when `color` is omitted; deterministic per bot id. */
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
 * Pick a deterministic palette color from a bot id.
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
 * @returns {string} trimmed bot name
 * @throws coded `BOT_INVALID_NAME`
 */
function normalizeName(value) {
  if (typeof value !== 'string') throw codedError('BOT_INVALID_NAME', 'Bot name is required');
  const name = value.trim();
  if (name.length < 1 || name.length > MAX_NAME_LENGTH) {
    throw codedError('BOT_INVALID_NAME', `Bot name must be 1-${MAX_NAME_LENGTH} characters`);
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
 * @returns {string | null} character id, or `null` for a bot without a character
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
 * @returns {string} absolute normalized workspace directory
 * @throws coded `BOT_INVALID_PATCH`
 */
function normalizeWorkspaceDir(value) {
  if (typeof value !== 'string' || value.trim() === '' || !path.isAbsolute(value)) {
    invalidPatch('workspaceDir must be an absolute path');
  }
  return path.resolve(value);
}

/**
 * Validate a docker image reference.
 *
 * @param {unknown} value
 * @returns {string}
 * @throws coded `BOT_INVALID_IMAGE`
 */
function normalizeImage(value) {
  if (typeof value !== 'string' || !IMAGE_PATTERN.test(value)) {
    throw codedError('BOT_INVALID_IMAGE', 'vm.image must be a valid docker image reference');
  }
  return value;
}

/**
 * Validate the fields of an incoming `vm` object.
 *
 * @param {unknown} value
 * @returns {{ enabled?: boolean, image?: string }} validated partial vm fields
 * @throws coded `BOT_INVALID_PATCH` / `BOT_INVALID_IMAGE`
 */
function validateVm(value) {
  if (value === undefined || value === null) return {};
  if (!isPlainObject(value)) invalidPatch('vm must be an object');
  for (const key of Object.keys(value)) {
    if (!VM_FIELDS.has(key)) invalidPatch(`Unknown vm field "${key}"`);
  }
  const validated = {};
  if (value.enabled !== undefined) {
    if (typeof value.enabled !== 'boolean') invalidPatch('vm.enabled must be a boolean');
    validated.enabled = value.enabled;
  }
  if (value.image !== undefined) validated.image = normalizeImage(value.image);
  return validated;
}

/**
 * Durable, DOM-free store for Bots plugin records.
 *
 * @example
 * const store = new BotStore({ botsRoot: path.join(dshHome, 'bots') });
 * await store.init();
 * const bot = await store.create({ name: 'Pesquisador' });
 */
export class BotStore {
  /** @type {string} */
  #botsRoot;
  /** @type {string} */
  #file;
  /** @type {string} */
  #defaultImage;
  /** @type {Array<Record<string, any>>} */
  #records = [];
  /** Serializes mutating operations so concurrent updates cannot interleave. */
  #mutationChain = Promise.resolve();
  /** Serializes file writes (one atomic write at a time). */
  #writeChain = Promise.resolve();

  /**
   * @param {{ botsRoot: string, defaultImage?: string }} options
   *   `botsRoot` must be an absolute directory path; `defaultImage` is the
   *   docker image used when a bot does not pick one.
   */
  constructor({ botsRoot, defaultImage = DEFAULT_IMAGE } = {}) {
    if (typeof botsRoot !== 'string' || botsRoot.trim() === '' || !path.isAbsolute(botsRoot)) {
      throw new TypeError('BotStore: botsRoot must be an absolute path string');
    }
    if (typeof defaultImage !== 'string' || !IMAGE_PATTERN.test(defaultImage)) {
      throw new TypeError('BotStore: defaultImage must be a valid docker image reference');
    }
    this.#botsRoot = path.resolve(botsRoot);
    this.#file = path.join(this.#botsRoot, 'bots.json');
    this.#defaultImage = defaultImage;
  }

  /**
   * Absolute root directory holding bot workspaces and the store document.
   * @returns {string}
   */
  get botsRoot() {
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
   * Default docker image used by newly created bots.
   * @returns {string}
   */
  get defaultImage() {
    return this.#defaultImage;
  }

  /**
   * Create `botsRoot` and load the persisted document.
   *
   * A malformed JSON document (or one without a `bots` array) is renamed to
   * `bots.json.corrupt-<timestamp>` and the store starts empty; unreadable
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
    if (!isPlainObject(parsed) || !Array.isArray(parsed.bots)) {
      await this.#quarantineCorruptFile();
      this.#records = [];
      return this;
    }
    this.#records = this.#normalizeLoadedBots(parsed.bots);
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
   * Find a bot whose workspace directory matches `dir`.
   *
   * Compares `path.resolve` of both sides, and additionally compares real paths
   * (symlink targets) when both resolve. The bot's own folder name may be a
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
   * Validate, create and persist a bot record.
   *
   * @param {{ id?: string, name: string, character?: string | null, emoji?: string, color?: string,
   *   instructions?: string, workspaceDir?: string,
   *   vm?: { enabled?: boolean, image?: string } }} [input]
   * @returns {Promise<Record<string, any>>} deep copy of the created record
   * @throws coded `BOT_INVALID_NAME`, `BOT_INVALID_IMAGE`, `BOT_INVALID_PATCH`,
   *   `BOT_ID_EXISTS`
   */
  async create(input = {}) {
    return this.#mutate(() => this.#createRecord(input));
  }

  /**
   * Apply a partial patch and persist the updated record.
   *
   * @param {string} id
   * @param {{ name?: string, character?: string | null, emoji?: string, color?: string,
   *   instructions?: string, vm?: { enabled?: boolean, image?: string } }} patch
   * @returns {Promise<Record<string, any>>} deep copy of the updated record
   * @throws coded `BOT_NOT_FOUND`, `BOT_INVALID_PATCH`, `BOT_INVALID_NAME`,
   *   `BOT_INVALID_IMAGE`
   */
  async update(id, patch) {
    return this.#mutate(() => this.#updateRecord(id, patch));
  }

  /**
   * Remove a bot record, optionally deleting its workspace directory.
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
   * Ensure the bot workspace directory exists.
   *
   * @param {Record<string, any> | string} record bot record (or bot id)
   * @returns {Promise<string>} absolute workspace directory path
   * @throws coded `BOT_NOT_FOUND`, `BOT_INVALID_PATCH`
   */
  async ensureWorkspace(record) {
    const resolved = typeof record === 'string' ? this.get(record) : record;
    if (!isPlainObject(resolved)) {
      throw codedError('BOT_NOT_FOUND', `Bot "${String(record)}" was not found`);
    }
    const workspaceDir = resolved.workspaceDir;
    if (typeof workspaceDir !== 'string' || workspaceDir.trim() === '' || !path.isAbsolute(workspaceDir)) {
      throw codedError('BOT_INVALID_PATCH', 'Bot record has no absolute workspaceDir');
    }
    const absolute = path.resolve(workspaceDir);
    await fs.mkdir(absolute, { recursive: true, mode: 0o700 });
    return absolute;
  }

  /**
   * Persist the current records atomically. Writes are serialized: a second
   * `flush()` waits for the first, so the file is never interleaved or partial.
   *
   * @returns {Promise<void>}
   */
  flush() {
    const task = async () => {
      const contents = `${JSON.stringify({ statusVersion: STATUS_VERSION, bots: this.#records }, null, 2)}\n`;
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
      if (!CREATE_FIELDS.has(key)) invalidPatch(`Unknown bot field "${key}"`);
    }
    const name = normalizeName(input.name);
    const id = this.#allocateId(input.id);
    const vmFields = validateVm(input.vm);
    const now = new Date().toISOString();
    /** @type {Record<string, any>} */
    const record = {
      id,
      name,
      character: normalizeCharacter(input.character, null),
      emoji: normalizeEmoji(input.emoji, DEFAULT_EMOJI),
      color: normalizeColor(input.color, paletteColorFor(id)),
      instructions: normalizeInstructions(input.instructions),
      workspaceDir:
        input.workspaceDir === undefined
          ? path.join(this.#botsRoot, id, 'workspace')
          : normalizeWorkspaceDir(input.workspaceDir),
      vm: {
        enabled: vmFields.enabled === true,
        image: vmFields.image ?? this.#defaultImage,
      },
      createdAt: now,
      updatedAt: now,
    };
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
   * @param {string} id
   * @param {unknown} patch
   * @returns {Promise<Record<string, any>>}
   */
  async #updateRecord(id, patch) {
    const index = this.#indexOf(id);
    if (index < 0) throw codedError('BOT_NOT_FOUND', `Bot "${String(id)}" was not found`);
    if (!isPlainObject(patch)) invalidPatch('update() patch must be an object');
    for (const key of Object.keys(patch)) {
      if (!PATCH_FIELDS.has(key)) invalidPatch(`Cannot update bot field "${key}"`);
    }
    const current = this.#records[index];
    const vmFields = validateVm(patch.vm);
    /** @type {Record<string, any>} */
    const next = { ...current, vm: { ...current.vm } };
    if (patch.name !== undefined) next.name = normalizeName(patch.name);
    if (patch.character !== undefined) next.character = normalizeCharacter(patch.character, current.character ?? null);
    if (patch.emoji !== undefined) next.emoji = normalizeEmoji(patch.emoji, current.emoji);
    if (patch.color !== undefined) next.color = normalizeColor(patch.color, current.color);
    if (patch.instructions !== undefined) next.instructions = normalizeInstructions(patch.instructions);
    if (patch.vm !== undefined && patch.vm !== null) {
      next.vm = {
        enabled: vmFields.enabled ?? current.vm.enabled,
        image: vmFields.image ?? current.vm.image,
      };
    }
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
    if (index < 0) throw codedError('BOT_NOT_FOUND', `Bot "${String(id)}" was not found`);
    const record = this.#records[index];
    const workspaceDir = typeof record.workspaceDir === 'string' ? path.resolve(record.workspaceDir) : null;
    let deleteTarget = null;
    if (deleteWorkspace) {
      if (workspaceDir === null) {
        throw codedError('BOT_WORKSPACE_OUTSIDE_ROOT', 'Refusing to delete workspace: bot has no usable workspaceDir');
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
  // Persistence helpers
  // ---------------------------------------------------------------------------

  /** @returns {Promise<void>} */
  async #ensureRootDir() {
    await fs.mkdir(this.#botsRoot, { recursive: true, mode: 0o700 });
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
   * Move a corrupt store document aside so the store can start empty.
   * @returns {Promise<void>}
   */
  async #quarantineCorruptFile() {
    const backup = `${this.#file}.corrupt-${Date.now()}`;
    try {
      await fs.rename(this.#file, backup);
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Loading helpers
  // ---------------------------------------------------------------------------

  /**
   * Normalize a parsed `bots` array, dropping unusable entries.
   *
   * @param {unknown[]} bots
   * @returns {Array<Record<string, any>>}
   */
  #normalizeLoadedBots(bots) {
    const records = [];
    const usedIds = new Set();
    for (const bot of bots) {
      const record = this.#normalizeLoadedRecord(bot, usedIds);
      if (record === null) continue;
      usedIds.add(record.id);
      records.push(record);
    }
    return records;
  }

  /**
   * Coerce one persisted entry into a valid record.
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
    let workspaceDir = typeof raw.workspaceDir === 'string' ? raw.workspaceDir.trim() : '';
    workspaceDir =
      workspaceDir !== '' && path.isAbsolute(workspaceDir)
        ? path.resolve(workspaceDir)
        : path.join(this.#botsRoot, id, 'workspace');
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
    const rawVm = isPlainObject(raw.vm) ? raw.vm : {};
    const image =
      typeof rawVm.image === 'string' && IMAGE_PATTERN.test(rawVm.image) ? rawVm.image : this.#defaultImage;
    const createdAt = normalizeTimestamp(raw.createdAt) ?? normalizeTimestamp(raw.updatedAt) ?? new Date().toISOString();
    const updatedAt = normalizeTimestamp(raw.updatedAt) ?? createdAt;
    return {
      id,
      name,
      character,
      emoji,
      color,
      instructions,
      workspaceDir,
      vm: { enabled: rawVm.enabled === true, image },
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
        throw codedError('BOT_ID_EXISTS', `A bot with id "${requestedId}" already exists`);
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
        `Refusing to delete workspace outside bots root: ${workspaceDir}`,
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
}
