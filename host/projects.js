/**
 * Durable JSON store for Bots plugin projects (CONTRACT §12).
 *
 * A project is the level above teams: a named container ("DSC",
 * "Prefeitura") that groups the teams working on it. Projects are pure data:
 * nothing here launches agents or touches the filesystem outside
 * `<botsRoot>/projects.json`.
 *
 * Persistence mirrors {@link import('./teams.js').TeamStore}: mutations are
 * serialized, every write is atomic (sibling temporary file, fsync, rename;
 * file mode 0600, directory 0700), mutators persist before resolving, and every
 * read returns a deep copy. A corrupt document is renamed to
 * `projects.json.corrupt-<timestamp>` and the store starts empty.
 *
 * Validation lives in the pure {@link normalizeProject}; violations throw an
 * `Error` with `code: 'PROJECT_INVALID'` and a message naming the field, e.g.
 * `name: must be 1-60 characters`. Unknown fields are dropped silently.
 *
 * @module host/projects
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/** Version stamped into every persisted document. */
const STATUS_VERSION = 1;
/** Project id: 10 lowercase hexadecimal characters. */
const PROJECT_ID_PATTERN = /^[0-9a-f]{10}$/;
/** Accent color: `#rrggbb`. */
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

const DEFAULT_EMOJI = '📁';
const DEFAULT_COLOR = '#2563eb';
const MAX_PROJECTS = 100;
const MAX_NAME = 60;
const MAX_DESCRIPTION = 2000;
const MAX_EMOJI_CODE_POINTS = 8;
/** Fields a patch may replace; anything else is ignored. */
const PATCH_FIELDS = Object.freeze(['name', 'description', 'emoji', 'color']);

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
 * @param {string} field dotted field path, e.g. `description`
 * @param {string} message
 * @returns {never}
 */
function invalid(field, message) {
  throw codedError('PROJECT_INVALID', `${field}: ${message}`);
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
 * Pure project validator/normalizer (CONTRACT §12.1).
 *
 * Full mode (default) validates a complete project body and applies defaults.
 * It returns `{ name, description, emoji, color }`; `id`, `createdAt`,
 * `updatedAt` and any unknown fields in `input` are ignored (the store owns
 * them).
 *
 * Partial mode (`{ partial: true }`) validates only the fields present in a
 * patch and returns just those, normalized.
 *
 * @param {unknown} input
 * @param {{ partial?: boolean }} [options]
 * @returns {Record<string, any>}
 * @throws coded `PROJECT_INVALID` naming the offending field
 */
export function normalizeProject(input, { partial = false } = {}) {
  if (!isPlainObject(input)) invalid(partial ? 'patch' : 'project', 'must be an object');
  if (partial) {
    /** @type {Record<string, any>} */
    const out = {};
    const has = (key) => Object.prototype.hasOwnProperty.call(input, key) && input[key] !== undefined;
    if (has('name')) out.name = requiredName(input.name, 'name');
    if (has('description')) out.description = optionalText(input.description, 'description', MAX_DESCRIPTION);
    if (has('emoji')) out.emoji = normalizeEmoji(input.emoji, 'emoji');
    if (has('color')) out.color = normalizeColor(input.color, 'color', DEFAULT_COLOR);
    return out;
  }
  return {
    name: requiredName(input.name, 'name'),
    description: optionalText(input.description, 'description', MAX_DESCRIPTION),
    emoji: normalizeEmoji(input.emoji, 'emoji'),
    color: normalizeColor(input.color, 'color', DEFAULT_COLOR),
  };
}

// -----------------------------------------------------------------------------
// Store
// -----------------------------------------------------------------------------

/**
 * Durable store for project records in `<botsRoot>/projects.json`.
 *
 * @example
 * const projects = new ProjectStore({ botsRoot: path.join(dshHome, 'bots') });
 * await projects.init();
 * const project = await projects.create({ name: 'DSC' });
 */
export class ProjectStore {
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
      throw new TypeError('ProjectStore: botsRoot must be an absolute path string');
    }
    this.#botsRoot = path.resolve(botsRoot);
    this.#file = path.join(this.#botsRoot, 'projects.json');
  }

  /** @returns {string} absolute root directory */
  get botsRoot() {
    return this.#botsRoot;
  }

  /** @returns {string} absolute path of `projects.json` */
  get file() {
    return this.#file;
  }

  /**
   * Create `botsRoot` and load the persisted document. A missing file starts
   * empty; malformed JSON (or a document without a `projects` array) is renamed
   * to `projects.json.corrupt-<timestamp>` and the store starts empty.
   * Individual persisted projects that fail validation are dropped.
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
    if (!isPlainObject(parsed) || !Array.isArray(parsed.projects)) {
      await this.#quarantineCorruptFile();
      this.#records = [];
      return this;
    }
    this.#records = this.#normalizeLoadedProjects(parsed.projects);
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
   * Validate, create and persist a project.
   *
   * @param {{ name: string, description?: string, emoji?: string, color?: string }} input
   * @returns {Promise<Record<string, any>>} deep copy of the created record
   * @throws coded `PROJECT_INVALID`, `PROJECT_LIMIT`
   */
  async create(input) {
    return this.#mutate(() => this.#createRecord(input));
  }

  /**
   * Apply a patch and persist.
   *
   * @param {string} id
   * @param {Record<string, any>} patch
   * @returns {Promise<Record<string, any>>} deep copy of the updated record
   * @throws coded `PROJECT_NOT_FOUND`, `PROJECT_INVALID`
   */
  async update(id, patch) {
    return this.#mutate(() => this.#updateRecord(id, patch));
  }

  /**
   * @param {string} id
   * @returns {Promise<Record<string, any>>} deep copy of the removed record
   * @throws coded `PROJECT_NOT_FOUND`
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
      const contents = `${JSON.stringify({ statusVersion: STATUS_VERSION, projects: this.#records }, null, 2)}\n`;
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
    const fields = normalizeProject(input);
    if (this.#records.length >= MAX_PROJECTS) {
      throw codedError('PROJECT_LIMIT', `At most ${MAX_PROJECTS} projects can be stored`);
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
    if (index < 0) throw codedError('PROJECT_NOT_FOUND', `Project "${String(id)}" was not found`);
    const changes = normalizeProject(patch, { partial: true });
    const current = this.#records[index];
    /** @type {Record<string, any>} */
    const merged = { ...cloneRecord(current) };
    for (const key of PATCH_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(changes, key)) merged[key] = changes[key];
    }
    const fields = normalizeProject(merged);
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
    if (index < 0) throw codedError('PROJECT_NOT_FOUND', `Project "${String(id)}" was not found`);
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
   * Normalize persisted projects, dropping entries that no longer validate and
   * regenerating missing/duplicate ids.
   *
   * @param {unknown[]} projects
   * @returns {Array<Record<string, any>>}
   */
  #normalizeLoadedProjects(projects) {
    const records = [];
    const usedIds = new Set();
    for (const raw of projects) {
      if (records.length >= MAX_PROJECTS) break;
      if (!isPlainObject(raw)) continue;
      let fields;
      try {
        fields = normalizeProject(raw);
      } catch {
        continue;
      }
      let id = typeof raw.id === 'string' && PROJECT_ID_PATTERN.test(raw.id) ? raw.id : null;
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
