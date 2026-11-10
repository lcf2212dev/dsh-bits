/**
 * Unit tests for host/store.js (BitStore v5).
 *
 * Plain `node test/store.test.mjs`; only Node built-ins are used. Every test gets
 * its own temporary directory, removed afterwards.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BitStore, BotStore } from '../host/store.js';
import { loadBitCatalog } from '../host/catalog.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG = loadBitCatalog(path.join(ROOT, 'bits'));

// ---------------------------------------------------------------------------
// Tiny test harness
// ---------------------------------------------------------------------------

let passed = 0;
const failures = [];

/**
 * @param {string} name
 * @param {() => Promise<void>} fn
 */
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`not ok - ${name}`);
    console.error(error);
  }
}

/**
 * Run `fn` with a fresh temporary directory that is always removed afterwards.
 *
 * @template T
 * @param {(tmp: string) => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withTempDir(fn) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-bits-store-'));
  try {
    return await fn(tmp);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

/**
 * @param {string} dir
 * @param {Record<string, any>} [options]
 * @returns {Promise<BitStore>} initialized store rooted at `<dir>/bots`
 */
async function makeStore(dir, options = {}) {
  const store = new BitStore({ botsRoot: path.join(dir, 'bots'), catalog: CATALOG, ...options });
  await store.init();
  return store;
}

/**
 * @param {string} dir
 * @returns {Promise<string[]>} names of the files in `dir`
 */
async function listDir(dir) {
  try {
    return await fs.readdir(dir);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

/**
 * @param {string} dir
 * @param {RegExp} pattern
 * @returns {Promise<string[]>} matching entry names
 */
async function entriesMatching(dir, pattern) {
  return (await listDir(dir)).filter((entry) => pattern.test(entry));
}

/**
 * @param {string} file
 * @returns {Promise<Record<string, any>>}
 */
async function readStoreFile(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

/**
 * Assert no atomic-write temporary files were left behind.
 *
 * @param {string} dir
 */
async function assertNoTempFiles(dir) {
  const leftovers = (await listDir(dir)).filter((entry) => entry.includes('.tmp-'));
  assert.deepEqual(leftovers, [], `no temporary files should remain in ${dir}`);
}

/**
 * @param {() => Promise<unknown>} fn
 * @param {string} code
 * @param {string} label
 */
async function assertCodedRejection(fn, code, label) {
  await assert.rejects(fn, (error) => {
    assert.equal(error?.code, code, `${label}: expected code ${code}, got ${error?.code}`);
    return true;
  });
}

/** @param {Record<string, any>} record */
const V5_KEYS = Object.freeze([
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
  'createdAt',
  'updatedAt',
]);

/**
 * @param {Record<string, any>} record
 * @param {string} [label]
 */
function assertV5RecordShape(record, label = 'record') {
  assert.deepEqual(Object.keys(record), [...V5_KEYS], `${label}: v5 keys and order`);
  assert.equal(record.vm, undefined, `${label}: no v4 vm field`);
}

// ---------------------------------------------------------------------------
// Basic construction
// ---------------------------------------------------------------------------

await test('exports BitStore and keeps the v4 BotStore alias', async () => {
  assert.equal(BotStore, BitStore);
  await withTempDir(async (tmp) => {
    const store = new BitStore({ botsRoot: path.join(tmp, 'bots') });
    assert.equal(store.file, path.join(tmp, 'bots', 'bits.json'));
    assert.equal(store.botsRoot, path.resolve(tmp, 'bots'));
    assert.equal(store.bitsRoot, store.botsRoot);
    assert.throws(() => new BitStore({ botsRoot: 'relative/dir' }), TypeError);
    assert.throws(() => new BitStore(), TypeError);
  });
});

await test('init creates the root directory with owner-only mode and an empty store', () =>
  withTempDir(async (tmp) => {
    const botsRoot = path.join(tmp, 'nested', 'bots');
    const store = new BitStore({ botsRoot, catalog: CATALOG });
    await store.init();
    assert.deepEqual(store.list(), []);
    const stat = await fs.stat(botsRoot);
    assert.equal(stat.mode & 0o777, 0o700, 'botsRoot should be created 0700');
    assert.deepEqual(await listDir(botsRoot), []);
  }));

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

await test('create applies the v5 worker defaults and persists atomically', () =>
  withTempDir(async (tmp) => {
    const store = await makeStore(tmp);
    const record = await store.create({ name: '  Pesquisador  ' });

    assertV5RecordShape(record);
    assert.match(record.id, /^[0-9a-f]{10}$/);
    assert.equal(record.name, 'Pesquisador');
    assert.equal(record.character, null);
    assert.equal(record.emoji, '🤖');
    assert.match(record.color, /^#[0-9a-f]{6}$/);
    assert.equal(record.instructions, '');
    assert.equal(record.isOrchestrator, false);
    assert.equal(record.model, 'subscription/sonnet');
    assert.equal(record.effort, 'high');
    assert.equal(record.workspaceDir, path.join(store.botsRoot, record.id, 'workspace'));
    assert.equal(record.createdAt, record.updatedAt);
    assert.ok(!Number.isNaN(Date.parse(record.createdAt)));

    const file = await readStoreFile(store.file);
    assert.equal(file.statusVersion, 2);
    assert.equal(file.bits.length, 1);
    assert.deepEqual(file.bits[0], record);

    const stat = await fs.stat(store.file);
    assert.equal(stat.mode & 0o777, 0o600, 'store file should be 0600');
    assert.deepEqual(await entriesMatching(store.botsRoot, /^bits\.json$/), ['bits.json']);
    assert.deepEqual(await entriesMatching(store.botsRoot, /^bots\.json$/), []);
    await assertNoTempFiles(store.botsRoot);
  }));

await test('create inherits isOrchestrator/model/effort from the catalog character', () =>
  withTempDir(async (tmp) => {
    const store = await makeStore(tmp);
    const scout = await store.create({ name: 'Scout', character: 'bit-scout' });
    assert.equal(scout.isOrchestrator, false);
    assert.equal(scout.model, 'subscription/haiku');
    assert.equal(scout.effort, 'low');

    const architect = await store.create({ name: 'Arquiteto', character: 'bit-architect' });
    assert.equal(architect.isOrchestrator, false);
    assert.equal(architect.model, 'subscription/opus');
    assert.equal(architect.effort, 'xhigh');

    const manager = await store.create({ name: 'Manager', character: 'bit-manager' });
    assert.equal(manager.isOrchestrator, true, 'orchestrator catalog bit inherits the flag');
    assert.equal(manager.model, 'deepseek-account/deepseek-flash');
    assert.equal(manager.effort, 'max');

    const coordinator = await store.create({ name: 'Coord', character: 'bit-coordinator' });
    assert.equal(coordinator.isOrchestrator, true);
    assert.equal(coordinator.model, 'deepseek-account/deepseek-flash');
    assert.equal(coordinator.effort, 'max');

    // A store without a catalog falls back to the worker defaults (never throws).
    const plain = new BitStore({ botsRoot: path.join(tmp, 'plain') });
    await plain.init();
    const noCatalog = await plain.create({ name: 'No catalog', character: 'bit-manager' });
    assert.equal(noCatalog.isOrchestrator, false);
    assert.equal(noCatalog.model, 'subscription/sonnet');
    assert.equal(noCatalog.effort, 'high');
  }));

await test('create with an explicit isOrchestrator keeps the model family coherent', () =>
  withTempDir(async (tmp) => {
    const store = await makeStore(tmp);
    // Worker catalog bit promoted to orchestrator: the catalog model does not
    // belong to a DSH route, so the orchestrator family defaults win.
    const promoted = await store.create({ name: 'Chefe', character: 'bit-mascot', isOrchestrator: true });
    assert.equal(promoted.isOrchestrator, true);
    assert.equal(promoted.model, 'deepseek-account/deepseek-flash');
    assert.equal(promoted.effort, 'max');

    // Orchestrator catalog bit demoted to worker: worker defaults.
    const demoted = await store.create({ name: 'Ajudante', character: 'bit-coordinator', isOrchestrator: false });
    assert.equal(demoted.isOrchestrator, false);
    assert.equal(demoted.model, 'subscription/sonnet');
    assert.equal(demoted.effort, 'high');

    // Unknown character + orchestrator flag.
    const unknown = await store.create({ name: 'Orphan', character: null, isOrchestrator: true });
    assert.equal(unknown.model, 'deepseek-account/deepseek-flash');
    assert.equal(unknown.effort, 'max');

    // Explicit values always win.
    const explicit = await store.create({
      name: 'Explicito',
      character: 'bit-reviewer',
      isOrchestrator: false,
      model: 'subscription/opus',
      effort: 'max',
    });
    assert.equal(explicit.model, 'subscription/opus');
    assert.equal(explicit.effort, 'max');
  }));

await test('create accepts explicit fields, a caller id and a custom workspaceDir', () =>
  withTempDir(async (tmp) => {
    const store = await makeStore(tmp);
    const workspaceDir = path.join(tmp, 'custom-ws');
    const record = await store.create({
      id: 'abcdef0123',
      name: 'Dev',
      character: 'bit-builder',
      emoji: '🧪',
      color: '#ABCDEF',
      instructions: 'You are the Dev.',
      isOrchestrator: false,
      model: 'subscription/sonnet',
      effort: 'medium',
      workspaceDir,
    });

    assert.equal(record.id, 'abcdef0123');
    assert.equal(record.emoji, '🧪');
    assert.equal(record.color, '#abcdef');
    assert.equal(record.instructions, 'You are the Dev.');
    assert.equal(record.workspaceDir, workspaceDir);
    assert.equal(record.model, 'subscription/sonnet');
    assert.equal(record.effort, 'medium');
    assert.equal((await fs.stat(workspaceDir)).isDirectory(), true, 'workspace created on create');

    await assertCodedRejection(
      () => store.create({ id: 'abcdef0123', name: 'Duplicado' }),
      'BOT_ID_EXISTS',
      'duplicate id',
    );
  }));

await test('create uses a deterministic palette color derived from the id', () =>
  withTempDir(async (tmp) => {
    const store = await makeStore(tmp);
    const first = await store.create({ id: '0011223344', name: 'A' });
    const firstColor = first.color;
    await store.remove(first.id);
    const again = await store.create({ id: '0011223344', name: 'A again' });
    assert.equal(again.color, firstColor, 'palette color is derived from the id');
  }));

await test('create keeps the bit when the workspace mkdir fails', () =>
  withTempDir(async (tmp) => {
    const blocker = path.join(tmp, 'blocker');
    await fs.writeFile(blocker, 'not a directory');
    const store = await makeStore(tmp);
    const record = await store.create({ name: 'No workspace', workspaceDir: path.join(blocker, 'workspace') });
    assert.equal(record.name, 'No workspace');
    assert.equal((await readStoreFile(store.file)).bits.length, 1);
  }));

await test('orchestrator bits require a DSH chat route (subscription models are rejected)', () =>
  withTempDir(async (tmp) => {
    const store = await makeStore(tmp);

    // Create: every subscription spelling is refused for an orchestrator.
    const invalid = [
      { name: 'Bad Orchestrator', isOrchestrator: true, model: 'subscription/opus' },
      { name: 'Bad Orchestrator', isOrchestrator: true, model: 'opus' },
      { name: 'Bad Orchestrator', isOrchestrator: true, model: '  subscription/sonnet  ' },
      { name: 'Bad Orchestrator', character: 'bit-manager', isOrchestrator: true, model: 'subscription/haiku' },
      { name: 'Bad Orchestrator', character: 'bit-manager', model: 'sonnet' },
    ];
    for (const input of invalid) {
      await assertCodedRejection(() => store.create(input), 'BOT_INVALID', JSON.stringify(input));
    }
    await assert.rejects(
      () => store.create({ name: 'Bad Orchestrator', isOrchestrator: true, model: 'subscription/opus' }),
      (error) => {
        assert.equal(error.code, 'BOT_INVALID');
        assert.equal(
          error.message,
          'model: an orchestrator bit needs a DSH chat route (<provider>/<model>); "subscription/opus" is a subscription model (workers only)',
        );
        return true;
      },
    );
    assert.deepEqual(store.list(), [], 'rejected creations are never persisted');

    // Valid families: orchestrator on a DSH-like route, worker on subscription.
    const orchestrator = await store.create({
      name: 'Chefe',
      isOrchestrator: true,
      model: 'custom-provider/custom-model',
    });
    assert.equal(orchestrator.isOrchestrator, true);
    assert.equal(orchestrator.model, 'custom-provider/custom-model');
    const worker = await store.create({ name: 'Worker', model: 'subscription/opus' });
    assert.equal(worker.model, 'subscription/opus');

    // Update: promoting a worker without re-pointing the model is refused...
    await assertCodedRejection(() => store.update(worker.id, { isOrchestrator: true }), 'BOT_INVALID', 'promote');
    assert.equal(store.get(worker.id).isOrchestrator, false, 'failed update leaves the record untouched');
    assert.equal(store.get(worker.id).model, 'subscription/opus');
    // ... and an orchestrator cannot be re-pointed at a subscription model.
    await assertCodedRejection(() => store.update(orchestrator.id, { model: 'opus' }), 'BOT_INVALID', 'repoint');
    assert.equal(store.get(orchestrator.id).model, 'custom-provider/custom-model');

    // The coherent patches are accepted.
    const promoted = await store.update(worker.id, {
      isOrchestrator: true,
      model: 'deepseek-account/deepseek-flash',
      effort: 'max',
    });
    assert.equal(promoted.isOrchestrator, true);
    assert.equal(promoted.model, 'deepseek-account/deepseek-flash');
    const demoted = await store.update(promoted.id, { isOrchestrator: false, model: 'subscription/opus' });
    assert.equal(demoted.isOrchestrator, false);
    assert.equal(demoted.model, 'subscription/opus');
  }));

await test('create validates every field with stable coded errors', () =>
  withTempDir(async (tmp) => {
    const store = await makeStore(tmp);
    const cases = [
      [{}, 'BOT_INVALID_NAME'],
      [{ name: '   ' }, 'BOT_INVALID_NAME'],
      [{ name: 'x'.repeat(61) }, 'BOT_INVALID_NAME'],
      [{ name: 'ok', emoji: 'x'.repeat(9) }, 'BOT_INVALID_PATCH'],
      [{ name: 'ok', emoji: 42 }, 'BOT_INVALID_PATCH'],
      [{ name: 'ok', color: 'purple' }, 'BOT_INVALID_PATCH'],
      [{ name: 'ok', instructions: 'x'.repeat(20001) }, 'BOT_INVALID_PATCH'],
      [{ name: 'ok', instructions: 42 }, 'BOT_INVALID_PATCH'],
      [{ name: 'ok', character: '../etc' }, 'BOT_INVALID_PATCH'],
      [{ name: 'ok', character: 42 }, 'BOT_INVALID_PATCH'],
      [{ name: 'ok', workspaceDir: 'relative/path' }, 'BOT_INVALID_PATCH'],
      [{ name: 'ok', workspaceDir: `/${'x'.repeat(1024)}` }, 'BOT_INVALID_PATCH'],
      [{ name: 'ok', isOrchestrator: 'yes' }, 'BOT_INVALID_PATCH'],
      [{ name: 'ok', model: 42 }, 'BOT_INVALID_PATCH'],
      [{ name: 'ok', model: 'x'.repeat(121) }, 'BOT_INVALID_PATCH'],
      [{ name: 'ok', effort: 42 }, 'BOT_INVALID_PATCH'],
      [{ name: 'ok', effort: 'x'.repeat(21) }, 'BOT_INVALID_PATCH'],
      [{ name: 'ok', unknown: true }, 'BOT_INVALID_PATCH'],
      [{ name: 'ok', vm: { enabled: true } }, 'BOT_INVALID_PATCH'],
      [{ name: 'ok', id: 'SHORT' }, 'BOT_INVALID_PATCH'],
    ];
    for (const [input, code] of cases) {
      await assertCodedRejection(() => store.create(input), code, JSON.stringify(input));
    }
    assert.deepEqual(store.list(), [], 'failed creations must not be persisted');
  }));

await test('create enforces the 200-bit limit with BOT_LIMIT', () =>
  withTempDir(async (tmp) => {
    const store = await makeStore(tmp);
    for (let index = 0; index < 200; index += 1) {
      await store.create({ name: `Bit ${index}` });
    }
    await assertCodedRejection(() => store.create({ name: 'Um a mais' }), 'BOT_LIMIT', 'limit');
    assert.equal(store.list().length, 200);
  }));

// ---------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------

await test('get and list return deep copies in stable creation order', () =>
  withTempDir(async (tmp) => {
    const store = await makeStore(tmp);
    const first = await store.create({ name: 'Primeiro', character: 'bit-scout' });
    const second = await store.create({ name: 'Segundo' });
    assert.deepEqual(
      store.list().map((bit) => bit.id),
      [first.id, second.id],
    );

    const listed = store.list();
    listed[0].name = 'HACKED';
    listed[0].model = 'hacked/model';
    listed[0].isOrchestrator = true;
    listed.push({ id: 'ffffffffff', name: 'Intruso' });
    assert.equal(store.list()[0].name, 'Primeiro');
    assert.equal(store.list()[0].model, 'subscription/haiku');
    assert.equal(store.list()[0].isOrchestrator, false);
    assert.equal(store.list().length, 2);

    const got = store.get(first.id);
    got.instructions = 'HACKED';
    assert.equal(store.get(first.id).instructions, '');
    assert.equal(store.get('ffffffffff'), undefined);
    assert.equal(store.get(undefined), undefined);
  }));

await test('getByWorkspace compares resolved paths and real paths (symlinks)', () =>
  withTempDir(async (tmp) => {
    const store = await makeStore(tmp);
    const record = await store.create({ name: 'Com workspace' });
    const workspace = await store.ensureWorkspace(record);
    assert.equal(workspace, record.workspaceDir);

    assert.equal(store.getByWorkspace(workspace)?.id, record.id);
    assert.equal(store.getByWorkspace(`${store.botsRoot}/./${record.id}/workspace/../workspace`)?.id, record.id);
    assert.equal(store.getByWorkspace(path.join(tmp, 'nope')), undefined);
    assert.equal(store.getByWorkspace(undefined), undefined);

    const link = path.join(store.botsRoot, 'workspace-link');
    await fs.symlink(workspace, link, 'dir');
    assert.equal(store.getByWorkspace(link)?.id, record.id, 'symlinked workspace directory is matched');
  }));

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

await test('update patches v5 fields, persists and bumps only updatedAt', () =>
  withTempDir(async (tmp) => {
    const store = await makeStore(tmp);
    const created = await store.create({ name: 'Original', instructions: 'instructions', character: 'bit-scout' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const updated = await store.update(created.id, {
      name: '  Renomeado  ',
      character: 'bit-builder',
      emoji: '🛠️',
      color: '#123456',
      instructions: 'new instructions',
      isOrchestrator: true,
      model: 'deepseek-account/deepseek-flash',
      effort: 'max',
    });

    assertV5RecordShape(updated);
    assert.equal(updated.id, created.id);
    assert.equal(updated.name, 'Renomeado');
    assert.equal(updated.character, 'bit-builder');
    assert.equal(updated.emoji, '🛠️');
    assert.equal(updated.color, '#123456');
    assert.equal(updated.instructions, 'new instructions');
    assert.equal(updated.isOrchestrator, true);
    assert.equal(updated.model, 'deepseek-account/deepseek-flash');
    assert.equal(updated.effort, 'max');
    assert.equal(updated.createdAt, created.createdAt);
    assert.notEqual(updated.updatedAt, created.updatedAt);
    assert.deepEqual(store.get(created.id), updated);

    const file = await readStoreFile(store.file);
    assert.deepEqual(file.bits[0], updated);
    await assertNoTempFiles(store.botsRoot);

    // The patch can also clear the character and re-point a worker model.
    const cleared = await store.update(created.id, { character: null });
    assert.equal(cleared.character, null);
    assert.equal(cleared.model, 'deepseek-account/deepseek-flash', 'model is untouched by a character clear');
    const worker = await store.update(created.id, { isOrchestrator: false, model: 'subscription/sonnet', effort: 'high' });
    assert.equal(worker.isOrchestrator, false);
    assert.equal(worker.model, 'subscription/sonnet');
  }));

await test('update validates the patch and rejects unknown/immutable fields', () =>
  withTempDir(async (tmp) => {
    const store = await makeStore(tmp);
    const record = await store.create({ name: 'Alvo' });
    await assertCodedRejection(() => store.update('ffffffffff', { name: 'x' }), 'BOT_NOT_FOUND', 'unknown id');
    await assertCodedRejection(() => store.update(record.id, 'nope'), 'BOT_INVALID_PATCH', 'non-object patch');
    await assertCodedRejection(() => store.update(record.id, { id: 'aaaaaaaaaa' }), 'BOT_INVALID_PATCH', 'immutable id');
    await assertCodedRejection(() => store.update(record.id, { workspaceDir: tmp }), 'BOT_INVALID_PATCH', 'immutable workspaceDir');
    await assertCodedRejection(() => store.update(record.id, { createdAt: '2020-01-01T00:00:00.000Z' }), 'BOT_INVALID_PATCH', 'immutable createdAt');
    await assertCodedRejection(() => store.update(record.id, { vm: { enabled: true } }), 'BOT_INVALID_PATCH', 'removed vm field');
    await assertCodedRejection(() => store.update(record.id, { bogus: 1 }), 'BOT_INVALID_PATCH', 'unknown field');
    await assertCodedRejection(() => store.update(record.id, { name: '' }), 'BOT_INVALID_NAME', 'invalid name');
    await assertCodedRejection(() => store.update(record.id, { isOrchestrator: 1 }), 'BOT_INVALID_PATCH', 'invalid isOrchestrator');
    await assertCodedRejection(() => store.update(record.id, { model: 42 }), 'BOT_INVALID_PATCH', 'invalid model');
    await assertCodedRejection(() => store.update(record.id, { effort: 'x'.repeat(21) }), 'BOT_INVALID_PATCH', 'invalid effort');
    assert.deepEqual(store.get(record.id), record, 'failed updates leave the record untouched');
  }));

await test('update with an empty patch only refreshes updatedAt', () =>
  withTempDir(async (tmp) => {
    const store = await makeStore(tmp);
    const record = await store.create({ name: 'Alvo' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const updated = await store.update(record.id, {});
    assert.equal(updated.name, record.name);
    assert.notEqual(updated.updatedAt, record.updatedAt);
  }));

// ---------------------------------------------------------------------------
// remove / workspace
// ---------------------------------------------------------------------------

await test('remove keeps the workspace by default and returns the removed record', () =>
  withTempDir(async (tmp) => {
    const store = await makeStore(tmp);
    const record = await store.create({ name: 'Removable' });
    const workspace = await store.ensureWorkspace(record);

    const removed = await store.remove(record.id);
    assert.deepEqual(removed, record);
    assert.equal(store.get(record.id), undefined);
    assert.deepEqual(store.list(), []);
    assert.equal((await fs.stat(workspace)).isDirectory(), true, 'workspace directory is preserved');
    assert.deepEqual(await readStoreFile(store.file), { statusVersion: 2, bits: [] });
    await assertCodedRejection(() => store.remove(record.id), 'BOT_NOT_FOUND', 'already removed');
  }));

await test('remove with deleteWorkspace deletes a workspace inside the bits root', () =>
  withTempDir(async (tmp) => {
    const store = await makeStore(tmp);
    const record = await store.create({ name: 'With files' });
    const workspace = await store.ensureWorkspace(record);
    await fs.writeFile(path.join(workspace, 'note.txt'), 'hello');

    await store.remove(record.id, { deleteWorkspace: true });
    await assert.rejects(fs.stat(workspace), (error) => error?.code === 'ENOENT');
    await assertNoTempFiles(store.botsRoot);
  }));

await test('remove with deleteWorkspace refuses workspaces outside the bits root', () =>
  withTempDir(async (tmp) => {
    const store = await makeStore(tmp);
    const outside = path.join(tmp, 'outside-ws');
    const record = await store.create({ name: 'Forasteiro', workspaceDir: outside });
    await store.ensureWorkspace(record);
    await fs.writeFile(path.join(outside, 'keep.txt'), 'do not delete');

    await assertCodedRejection(
      () => store.remove(record.id, { deleteWorkspace: true }),
      'BOT_WORKSPACE_OUTSIDE_ROOT',
      'outside root',
    );
    assert.equal(store.get(record.id)?.id, record.id, 'refused deletion keeps the record');
    assert.equal(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8'), 'do not delete');

    await store.remove(record.id);
    assert.equal(store.get(record.id), undefined);
    assert.equal(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8'), 'do not delete');
  }));

await test('remove with deleteWorkspace refuses a workspace that escapes through a symlink', () =>
  withTempDir(async (tmp) => {
    const store = await makeStore(tmp);
    const outside = path.join(tmp, 'outside-ws');
    await fs.mkdir(outside, { recursive: true });
    const escape = path.join(store.botsRoot, 'escape');
    await fs.symlink(outside, escape, 'dir');
    const record = await store.create({ name: 'Symlink', workspaceDir: path.join(escape, 'workspace') });
    await store.ensureWorkspace(record);
    await fs.writeFile(path.join(outside, 'workspace', 'keep.txt'), 'do not delete');

    await assertCodedRejection(
      () => store.remove(record.id, { deleteWorkspace: true }),
      'BOT_WORKSPACE_OUTSIDE_ROOT',
      'symlink escape',
    );
    assert.equal(store.get(record.id)?.id, record.id);
    assert.equal(await fs.readFile(path.join(outside, 'workspace', 'keep.txt'), 'utf8'), 'do not delete');
  }));

await test('ensureWorkspace creates nested directories and accepts a bit id', () =>
  withTempDir(async (tmp) => {
    const store = await makeStore(tmp);
    const record = await store.create({ name: 'Workspace' });
    const workspace = await store.ensureWorkspace(record.id);
    assert.equal(workspace, record.workspaceDir);
    assert.equal((await fs.stat(workspace)).isDirectory(), true);
    assert.equal(await store.ensureWorkspace(record), workspace, 'idempotent');
    await assertCodedRejection(() => store.ensureWorkspace('ffffffffff'), 'BOT_NOT_FOUND', 'unknown id');
  }));

await test('deleteWorkspace validates the target before deleting it', () =>
  withTempDir(async (tmp) => {
    const store = await makeStore(tmp);
    const inside = await store.create({ name: 'Dentro' });
    const workspace = await store.ensureWorkspace(inside);
    await fs.writeFile(path.join(workspace, 'note.txt'), 'bye');
    assert.equal(await store.deleteWorkspace(inside.id), path.resolve(workspace));
    await assert.rejects(fs.stat(workspace), (error) => error?.code === 'ENOENT');
    assert.equal(store.get(inside.id)?.id, inside.id, 'the record is kept');

    const outside = path.join(tmp, 'outside');
    const stranger = await store.create({ name: 'Fora', workspaceDir: outside });
    await store.ensureWorkspace(stranger);
    await assertCodedRejection(() => store.deleteWorkspace(stranger), 'BOT_WORKSPACE_OUTSIDE_ROOT', 'outside');
    assert.equal((await fs.stat(outside)).isDirectory(), true);
    await assertCodedRejection(() => store.deleteWorkspace('ffffffffff'), 'BOT_NOT_FOUND', 'unknown id');
  }));

// ---------------------------------------------------------------------------
// Persistence / corruption
// ---------------------------------------------------------------------------

await test('records survive a new store instance', () =>
  withTempDir(async (tmp) => {
    const botsRoot = path.join(tmp, 'bots');
    const first = new BitStore({ botsRoot, catalog: CATALOG });
    await first.init();
    const a = await first.create({ name: 'A', character: 'bit-scout' });
    const b = await first.create({ name: 'B', isOrchestrator: true });
    await first.update(a.id, { instructions: 'persistida' });

    const second = new BitStore({ botsRoot, catalog: CATALOG });
    await second.init();
    assert.deepEqual(
      second.list().map((bit) => [bit.id, bit.name, bit.instructions, bit.isOrchestrator, bit.model, bit.effort]),
      [
        [a.id, 'A', 'persistida', false, 'subscription/haiku', 'low'],
        [b.id, 'B', '', true, 'deepseek-account/deepseek-flash', 'max'],
      ],
    );
  }));

await test('corrupt JSON is renamed to bits.json.corrupt-<ts> and the store starts empty', () =>
  withTempDir(async (tmp) => {
    const botsRoot = path.join(tmp, 'bots');
    await fs.mkdir(botsRoot, { recursive: true });
    await fs.writeFile(path.join(botsRoot, 'bits.json'), '{ this is not json');
    const store = new BitStore({ botsRoot, catalog: CATALOG });
    await store.init();
    assert.deepEqual(store.list(), []);
    assert.equal((await entriesMatching(botsRoot, /^bits\.json\.corrupt-\d+$/)).length, 1);

    // The recovered store keeps working.
    const record = await store.create({ name: 'After the chaos' });
    assert.deepEqual(await readStoreFile(store.file), { statusVersion: 2, bits: [record] });
    assert.equal((await entriesMatching(botsRoot, /^bits\.json\.corrupt-\d+$/)).length, 1);
  }));

await test('a valid-JSON document with the wrong shape is also quarantined', () =>
  withTempDir(async (tmp) => {
    const botsRoot = path.join(tmp, 'bots');
    await fs.mkdir(botsRoot, { recursive: true });
    await fs.writeFile(path.join(botsRoot, 'bits.json'), JSON.stringify({ statusVersion: 2, bits: 'nope' }));
    const store = new BitStore({ botsRoot, catalog: CATALOG });
    await store.init();
    assert.deepEqual(store.list(), []);
    assert.equal((await entriesMatching(botsRoot, /^bits\.json\.corrupt-\d+$/)).length, 1);
  }));

await test('loadable documents drop unusable entries and repair v5 fields', () =>
  withTempDir(async (tmp) => {
    const botsRoot = path.join(tmp, 'bots');
    await fs.mkdir(botsRoot, { recursive: true });
    const base = {
      id: 'a1b2c3d4e5',
      name: 'Valid',
      character: 'bit-scout',
      emoji: 'nope-not-an-emoji-too-long',
      color: 'red',
      instructions: 'instructions',
      vm: { enabled: true, image: 'bad image!' },
      createdAt: '2026-11-08T20:00:00.000Z',
      updatedAt: '2026-11-08T20:00:00.000Z',
    };
    const v5 = {
      id: 'b2c3d4e5f6',
      name: 'Already v5',
      character: 'bit-manager',
      isOrchestrator: true,
      model: 'custom/provider-model',
      effort: 'xhigh',
    };
    await fs.writeFile(
      path.join(botsRoot, 'bits.json'),
      JSON.stringify({
        statusVersion: 2,
        bits: [
          base,
          v5,
          { id: 'c3d4e5f6a7', name: 'Duplicado', character: 'bit-builder' },
          { id: 'a1b2c3d4e5', name: 'Id repetido' },
          'garbage',
          null,
          { name: '' },
        ],
      }),
    );

    const store = new BitStore({ botsRoot, catalog: CATALOG });
    await store.init();
    const list = store.list();
    assert.equal(list.length, 4, 'unusable entries are dropped, duplicate ids regenerated');
    const byName = new Map(list.map((bit) => [bit.name, bit]));

    const valid = byName.get('Valid');
    assertV5RecordShape(valid, 'loaded v4-shaped record');
    assert.equal(valid.id, base.id);
    assert.equal(valid.character, 'bit-scout');
    assert.equal(valid.emoji, '🤖', 'invalid emoji falls back to the default');
    assert.match(valid.color, /^#[0-9a-f]{6}$/, 'invalid color falls back to the palette');
    assert.equal(valid.isOrchestrator, false, 'catalog defaults fill the flag');
    assert.equal(valid.model, 'subscription/haiku', 'catalog defaults fill the model');
    assert.equal(valid.effort, 'low', 'catalog defaults fill the effort');
    assert.equal(valid.createdAt, base.createdAt);
    assert.equal(valid.vm, undefined, 'v4 vm field is dropped');

    const alreadyV5 = byName.get('Already v5');
    assert.equal(alreadyV5.isOrchestrator, true);
    assert.equal(alreadyV5.model, 'custom/provider-model', 'explicit model is preserved');
    assert.equal(alreadyV5.effort, 'xhigh', 'explicit effort is preserved');

    const duplicate = byName.get('Id repetido');
    assert.notEqual(duplicate.id, base.id, 'a duplicate id gets a fresh id');
    assert.match(duplicate.id, /^[0-9a-f]{10}$/);
    assert.equal(duplicate.model, 'subscription/sonnet', 'unknown character falls back to worker defaults');
    assert.equal(byName.get('Duplicado').model, 'subscription/sonnet');
  }));

// ---------------------------------------------------------------------------
// v4 -> v5 migration
// ---------------------------------------------------------------------------

/**
 * @param {string} botsRoot
 * @returns {Promise<Record<string, any>>} the persisted v4 fixture
 */
async function writeV4Fixture(botsRoot) {
  const iso = '2026-11-08T20:00:00.000Z';
  const fixture = {
    statusVersion: 1,
    bots: [
      {
        id: 'a1b2c3d4e5',
        name: 'Old Scout',
        character: 'bit-scout',
        emoji: '🔎',
        color: '#c88f36',
        instructions: 'Scout context.',
        workspaceDir: path.join(botsRoot, 'a1b2c3d4e5', 'workspace'),
        vm: { enabled: true, image: 'node:24-bookworm' },
        createdAt: iso,
        updatedAt: iso,
      },
      {
        id: 'b2c3d4e5f6',
        name: 'No character',
        instructions: '',
        vm: { enabled: false, image: 'ubuntu:24.04' },
        createdAt: iso,
        updatedAt: iso,
      },
      {
        id: 'c3d4e5f6a7',
        name: 'Old Manager',
        character: 'bit-manager',
        emoji: '🧭',
        color: '#123456',
        instructions: 'Coordinates everything.',
        vm: { enabled: true, image: 'ubuntu:24.04' },
        createdAt: iso,
        updatedAt: iso,
      },
    ],
  };
  await fs.mkdir(botsRoot, { recursive: true });
  await fs.writeFile(path.join(botsRoot, 'bots.json'), JSON.stringify(fixture, null, 2));
  return fixture;
}

await test('migrates a v4 bots.json to bits.json once, with a backup and a log line', () =>
  withTempDir(async (tmp) => {
    const botsRoot = path.join(tmp, 'bots');
    const fixture = await writeV4Fixture(botsRoot);
    const logs = [];
    const store = new BitStore({ botsRoot, catalog: CATALOG, log: (message) => logs.push(message) });
    await store.init();

    const list = store.list();
    assert.equal(list.length, 3);
    assert.deepEqual(list.map((bit) => bit.id), fixture.bots.map((bot) => bot.id), 'ids are preserved');

    const [scout, plain, manager] = list;
    assertV5RecordShape(scout, 'migrated scout');
    assert.equal(scout.name, 'Old Scout');
    assert.equal(scout.character, 'bit-scout');
    assert.equal(scout.emoji, '🔎');
    assert.equal(scout.color, '#c88f36');
    assert.equal(scout.instructions, 'Scout context.');
    assert.equal(scout.workspaceDir, path.join(botsRoot, 'a1b2c3d4e5', 'workspace'));
    assert.equal(scout.isOrchestrator, false);
    assert.equal(scout.model, 'subscription/haiku');
    assert.equal(scout.effort, 'low');
    assert.equal(scout.createdAt, fixture.bots[0].createdAt);

    assert.equal(plain.character, null);
    assert.equal(plain.isOrchestrator, false);
    assert.equal(plain.model, 'subscription/sonnet');
    assert.equal(plain.effort, 'high');
    assert.equal(plain.workspaceDir, path.join(botsRoot, 'b2c3d4e5f6', 'workspace'), 'missing workspace gets a default');

    assert.equal(manager.isOrchestrator, true);
    assert.equal(manager.model, 'deepseek-account/deepseek-flash');
    assert.equal(manager.effort, 'max');

    for (const bit of list) assert.equal(bit.vm, undefined, 'vm is dropped by migration');

    const file = await readStoreFile(store.file);
    assert.equal(file.statusVersion, 2);
    assert.deepEqual(file.bits, list);

    const backups = await entriesMatching(botsRoot, /^bots\.json\.migrated-\d+$/);
    assert.equal(backups.length, 1, 'legacy file is kept as a backup');
    assert.deepEqual(await entriesMatching(botsRoot, /^bots\.json$/), []);
    assert.ok(logs.some((line) => line.includes('migrated 3')), `expected a migration log line: ${logs.join(' | ')}`);
    await assertNoTempFiles(botsRoot);

    // Idempotent: a second init keeps the migrated bits and makes no new backup.
    const again = new BitStore({ botsRoot, catalog: CATALOG });
    await again.init();
    assert.deepEqual(
      again.list().map((bit) => bit.id),
      list.map((bit) => bit.id),
    );
    assert.equal((await entriesMatching(botsRoot, /^bots\.json\.migrated-\d+$/)).length, 1);
  }));

await test('a corrupt legacy bots.json is quarantined and the store starts empty', () =>
  withTempDir(async (tmp) => {
    const botsRoot = path.join(tmp, 'bots');
    await fs.mkdir(botsRoot, { recursive: true });
    await fs.writeFile(path.join(botsRoot, 'bots.json'), '{ nope');
    const store = new BitStore({ botsRoot, catalog: CATALOG });
    await store.init();
    assert.deepEqual(store.list(), []);
    assert.equal((await entriesMatching(botsRoot, /^bots\.json\.corrupt-\d+$/)).length, 1);
    assert.deepEqual(await entriesMatching(botsRoot, /^bots\.json$/), []);

    const record = await store.create({ name: 'After' });
    assert.deepEqual(await readStoreFile(store.file), { statusVersion: 2, bits: [record] });
  }));

await test('a shape-invalid legacy bots.json is quarantined instead of migrated', () =>
  withTempDir(async (tmp) => {
    const botsRoot = path.join(tmp, 'bots');
    await fs.mkdir(botsRoot, { recursive: true });
    await fs.writeFile(path.join(botsRoot, 'bots.json'), JSON.stringify({ statusVersion: 1, bots: 'nope' }));
    const store = new BitStore({ botsRoot, catalog: CATALOG });
    await store.init();
    assert.deepEqual(store.list(), []);
    assert.equal((await entriesMatching(botsRoot, /^bots\.json\.corrupt-\d+$/)).length, 1);
  }));

await test('an existing bits.json wins over a leftover v4 bots.json', () =>
  withTempDir(async (tmp) => {
    const botsRoot = path.join(tmp, 'bots');
    await fs.mkdir(botsRoot, { recursive: true });
    const visible = {
      id: 'a1b2c3d4e5',
      name: 'V5',
      character: null,
      emoji: '👾',
      color: '#7c3aed',
      instructions: '',
      isOrchestrator: false,
      model: 'subscription/sonnet',
      effort: 'high',
      workspaceDir: path.join(botsRoot, 'a1b2c3d4e5', 'workspace'),
      createdAt: '2026-11-08T20:00:00.000Z',
      updatedAt: '2026-11-08T20:00:00.000Z',
    };
    await fs.writeFile(path.join(botsRoot, 'bits.json'), JSON.stringify({ statusVersion: 2, bits: [visible] }));
    await fs.writeFile(path.join(botsRoot, 'bots.json'), JSON.stringify({ statusVersion: 1, bots: [{ name: 'Velho' }] }));
    const store = new BitStore({ botsRoot, catalog: CATALOG });
    await store.init();
    assert.deepEqual(store.list().map((bit) => bit.name), ['V5']);
    assert.deepEqual(await entriesMatching(botsRoot, /^bots\.json$/), ['bots.json'], 'legacy file is left untouched');
  }));

await test('init throws for unusable paths but never for corrupt JSON', () =>
  withTempDir(async (tmp) => {
    const blocker = path.join(tmp, 'blocker');
    await fs.writeFile(blocker, 'not a directory');
    const broken = new BitStore({ botsRoot: blocker });
    await assert.rejects(broken.init());

    if (typeof process.getuid === 'function' && process.getuid() !== 0) {
      const botsRoot = path.join(tmp, 'unreadable');
      await fs.mkdir(botsRoot, { recursive: true });
      const file = path.join(botsRoot, 'bits.json');
      await fs.writeFile(file, JSON.stringify({ statusVersion: 2, bits: [] }));
      await fs.chmod(file, 0o000);
      try {
        const store = new BitStore({ botsRoot });
        await assert.rejects(store.init(), (error) => error?.code === 'EACCES');
      } finally {
        await fs.chmod(file, 0o600);
      }
    }
  }));

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

await test('concurrent updates are serialized and never lose data', () =>
  withTempDir(async (tmp) => {
    const store = await makeStore(tmp);
    const record = await store.create({ name: 'Concorrente' });

    const updates = [];
    for (let index = 0; index < 20; index += 1) {
      updates.push(store.update(record.id, { instructions: `update-${index}` }));
    }
    const results = await Promise.all(updates);
    assert.equal(results.length, 20);
    assert.equal(store.get(record.id).instructions, 'update-19');

    const creates = [];
    for (let index = 0; index < 10; index += 1) {
      creates.push(store.create({ name: `Bit ${index}` }));
    }
    await Promise.all(creates);
    assert.equal(store.list().length, 11);

    const file = await readStoreFile(store.file);
    assert.equal(file.bits.length, 11);
    assert.equal(file.bits.find((bit) => bit.id === record.id).instructions, 'update-19');
    await assertNoTempFiles(store.botsRoot);

    const reloaded = new BitStore({ botsRoot: store.botsRoot, catalog: CATALOG });
    await reloaded.init();
    assert.equal(reloaded.list().length, 11);
  }));

await test('concurrent flushes stay atomic and readable', () =>
  withTempDir(async (tmp) => {
    const store = await makeStore(tmp);
    const record = await store.create({ name: 'Flush' });
    await Promise.all(Array.from({ length: 10 }, () => store.flush()));
    const file = await readStoreFile(store.file);
    assert.equal(file.bits.length, 1);
    assert.equal(file.bits[0].id, record.id);
    await assertNoTempFiles(store.botsRoot);
  }));

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

if (failures.length > 0) {
  console.error(`\nstore: ${failures.length} failed, ${passed} passed`);
  process.exitCode = 1;
} else {
  console.log(`\nstore: ${passed} tests passed`);
}
