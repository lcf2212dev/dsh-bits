/**
 * Unit tests for host/store.js (BotStore).
 *
 * Plain `node test/store.test.mjs`; only Node built-ins are used. Every test gets
 * its own temporary directory, removed afterwards.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { BotStore } from '../host/store.js';

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
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-bots-store-'));
  try {
    return await fn(tmp);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

/**
 * @param {string} dir
 * @returns {Promise<BotStore>} initialized store rooted at `<dir>/bots`
 */
async function makeStore(dir, options = {}) {
  const store = new BotStore({ botsRoot: path.join(dir, 'bots'), ...options });
  await store.init();
  return store;
}

/**
 * @param {string} dir
 * @returns {Promise<string | null>} backup name of the quarantined file
 */
async function findCorruptBackup(dir) {
  const entries = await fs.readdir(dir);
  const match = entries.find((entry) => /^bots\.json\.corrupt-\d+$/.test(entry));
  return match ?? null;
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
  const entries = await fs.readdir(dir);
  const leftovers = entries.filter((entry) => entry.includes('.tmp-'));
  assert.deepEqual(leftovers, [], `no temporary files should remain in ${dir}`);
}

/**
 * @param {string} code
 * @param {string} message
 * @returns {Error & { code: string }}
 */
function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Register a coded-error assertion.
 *
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

await test('init creates the root directory with owner-only mode and an empty list', () =>
  withTempDir(async (tmp) => {
    const botsRoot = path.join(tmp, 'nested', 'bots');
    const store = new BotStore({ botsRoot });
    assert.equal(store.botsRoot, path.resolve(botsRoot));
    assert.ok(path.isAbsolute(store.botsRoot));
    assert.equal(store.file, path.join(store.botsRoot, 'bots.json'));
    assert.equal(store.defaultImage, 'ubuntu:24.04');

    await store.init();
    assert.deepEqual(store.list(), []);
    const stat = await fs.stat(botsRoot);
    assert.equal(stat.mode & 0o777, 0o700, 'botsRoot should be created 0700');
    assert.deepEqual(await fs.readdir(botsRoot), []);
  }));

await test('create applies defaults, persists atomically and returns the record', () =>
  withTempDir(async (tmp) => {
    const store = await makeStore(tmp);
    const record = await store.create({ name: '  Pesquisador  ' });

    assert.match(record.id, /^[0-9a-f]{10}$/);
    assert.equal(record.name, 'Pesquisador');
    assert.equal(record.emoji, '🤖');
    assert.match(record.color, /^#[0-9a-f]{6}$/);
    assert.equal(record.instructions, '');
    assert.equal(record.workspaceDir, path.join(store.botsRoot, record.id, 'workspace'));
    assert.deepEqual(record.vm, { enabled: false, image: 'ubuntu:24.04' });
    assert.equal(record.createdAt, record.updatedAt);
    assert.ok(!Number.isNaN(Date.parse(record.createdAt)));

    const file = await readStoreFile(store.file);
    assert.equal(file.statusVersion, 1);
    assert.equal(file.bots.length, 1);
    assert.deepEqual(file.bots[0], record);

    const stat = await fs.stat(store.file);
    assert.equal(stat.mode & 0o777, 0o600, 'store file should be 0600');
    await assertNoTempFiles(store.botsRoot);
  }));

await test('create accepts explicit emoji/color/instructions/vm/workspaceDir and a caller id', () =>
  withTempDir(async (tmp) => {
    const store = await makeStore(tmp);
    const workspaceDir = path.join(tmp, 'custom-ws');
    const record = await store.create({
      id: 'abcdef0123',
      name: 'Dev',
      emoji: '🧪',
      color: '#ABCDEF',
      instructions: 'Você é o Dev.',
      workspaceDir,
      vm: { enabled: true, image: 'node:24-bookworm' },
    });

    assert.equal(record.id, 'abcdef0123');
    assert.equal(record.emoji, '🧪');
    assert.equal(record.color, '#abcdef');
    assert.equal(record.instructions, 'Você é o Dev.');
    assert.equal(record.workspaceDir, workspaceDir);
    assert.deepEqual(record.vm, { enabled: true, image: 'node:24-bookworm' });

    await assertCodedRejection(
      () => store.create({ id: 'abcdef0123', name: 'Duplicado' }),
      'BOT_ID_EXISTS',
      'duplicate id',
    );
  }));

await test('create uses the configured default image and a deterministic palette color', () =>
  withTempDir(async (tmp) => {
    const store = await makeStore(tmp, { defaultImage: 'alpine:3.20' });
    const first = await store.create({ id: '0011223344', name: 'A' });
    assert.equal(first.vm.image, 'alpine:3.20');
    const firstColor = first.color;
    await store.remove(first.id);
    const again = await store.create({ id: '0011223344', name: 'A de novo' });
    assert.equal(again.color, firstColor, 'palette color is derived from the id');
  }));

await test('create validates every field with stable error codes', () =>
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
      [{ name: 'ok', workspaceDir: 'relative/path' }, 'BOT_INVALID_PATCH'],
      [{ name: 'ok', unknown: true }, 'BOT_INVALID_PATCH'],
      [{ name: 'ok', vm: 'yes' }, 'BOT_INVALID_PATCH'],
      [{ name: 'ok', vm: { enabled: 'yes' } }, 'BOT_INVALID_PATCH'],
      [{ name: 'ok', vm: { image: 'not a valid image!' } }, 'BOT_INVALID_IMAGE'],
      [{ name: 'ok', vm: { bogus: 1 } }, 'BOT_INVALID_PATCH'],
      [{ name: 'ok', id: 'SHORT' }, 'BOT_INVALID_PATCH'],
    ];
    for (const [input, code] of cases) {
      await assertCodedRejection(() => store.create(input), code, JSON.stringify(input));
    }
    assert.deepEqual(store.list(), [], 'failed creations must not be persisted');
  }));

await test('get and list return deep copies in stable creation order', () =>
  withTempDir(async (tmp) => {
    const store = await makeStore(tmp);
    const first = await store.create({ name: 'Primeiro' });
    const second = await store.create({ name: 'Segundo' });
    assert.deepEqual(
      store.list().map((bot) => bot.id),
      [first.id, second.id],
    );

    const listed = store.list();
    listed[0].name = 'HACKED';
    listed.push({ id: 'ffffffffff', name: 'Intruso' });
    listed[0].vm.enabled = true;
    assert.equal(store.list()[0].name, 'Primeiro');
    assert.equal(store.list()[0].vm.enabled, false);
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

await test('update patches fields, merges vm and bumps updatedAt only', () =>
  withTempDir(async (tmp) => {
    const store = await makeStore(tmp);
    const created = await store.create({
      name: 'Original',
      instructions: 'instruções',
      vm: { enabled: true, image: 'ubuntu:24.04' },
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const updated = await store.update(created.id, {
      name: '  Renomeado  ',
      emoji: '🛠️',
      color: '#123456',
      instructions: 'novas instruções',
      vm: { enabled: false },
    });

    assert.equal(updated.id, created.id);
    assert.equal(updated.name, 'Renomeado');
    assert.equal(updated.emoji, '🛠️');
    assert.equal(updated.color, '#123456');
    assert.equal(updated.instructions, 'novas instruções');
    assert.deepEqual(updated.vm, { enabled: false, image: 'ubuntu:24.04' }, 'vm.image is preserved');
    assert.equal(updated.createdAt, created.createdAt);
    assert.notEqual(updated.updatedAt, created.updatedAt);
    assert.deepEqual(store.get(created.id), updated);

    const file = await readStoreFile(store.file);
    assert.deepEqual(file.bots[0], updated);
    await assertNoTempFiles(store.botsRoot);
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
    await assertCodedRejection(() => store.update(record.id, { bogus: 1 }), 'BOT_INVALID_PATCH', 'unknown field');
    await assertCodedRejection(() => store.update(record.id, { name: '' }), 'BOT_INVALID_NAME', 'invalid name');
    await assertCodedRejection(() => store.update(record.id, { vm: { image: '!' } }), 'BOT_INVALID_IMAGE', 'invalid image');
    await assertCodedRejection(() => store.update(record.id, { vm: { enabled: 1 } }), 'BOT_INVALID_PATCH', 'invalid enabled');
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

await test('remove keeps the workspace by default and returns the removed record', () =>
  withTempDir(async (tmp) => {
    const store = await makeStore(tmp);
    const record = await store.create({ name: 'Removível' });
    const workspace = await store.ensureWorkspace(record);

    const removed = await store.remove(record.id);
    assert.deepEqual(removed, record);
    assert.equal(store.get(record.id), undefined);
    assert.deepEqual(store.list(), []);
    assert.equal((await fs.stat(workspace)).isDirectory(), true, 'workspace directory is preserved');
    assert.deepEqual(await readStoreFile(store.file), { statusVersion: 1, bots: [] });
    await assertCodedRejection(() => store.remove(record.id), 'BOT_NOT_FOUND', 'already removed');
  }));

await test('remove with deleteWorkspace deletes a workspace inside the bots root', () =>
  withTempDir(async (tmp) => {
    const store = await makeStore(tmp);
    const record = await store.create({ name: 'Com arquivos' });
    const workspace = await store.ensureWorkspace(record);
    await fs.writeFile(path.join(workspace, 'note.txt'), 'hello');

    await store.remove(record.id, { deleteWorkspace: true });
    await assert.rejects(fs.stat(workspace), (error) => error?.code === 'ENOENT');
    await assertNoTempFiles(store.botsRoot);
  }));

await test('remove with deleteWorkspace refuses workspaces outside the bots root', () =>
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

await test('ensureWorkspace creates nested directories and accepts a bot id', () =>
  withTempDir(async (tmp) => {
    const store = await makeStore(tmp);
    const record = await store.create({ name: 'Workspace' });
    const workspace = await store.ensureWorkspace(record.id);
    assert.equal(workspace, record.workspaceDir);
    assert.equal((await fs.stat(workspace)).isDirectory(), true);
    assert.equal(await store.ensureWorkspace(record), workspace, 'idempotent');
    await assertCodedRejection(() => store.ensureWorkspace('ffffffffff'), 'BOT_NOT_FOUND', 'unknown id');
  }));

await test('records survive a new store instance and corrupt files are quarantined', () =>
  withTempDir(async (tmp) => {
    const botsRoot = path.join(tmp, 'bots');
    const first = new BotStore({ botsRoot });
    await first.init();
    const a = await first.create({ name: 'A' });
    const b = await first.create({ name: 'B' });
    await first.update(a.id, { instructions: 'persistida' });

    const second = new BotStore({ botsRoot });
    await second.init();
    assert.deepEqual(
      second.list().map((bot) => [bot.id, bot.name, bot.instructions]),
      [
        [a.id, 'A', 'persistida'],
        [b.id, 'B', ''],
      ],
    );
  }));

await test('corrupt JSON is renamed to bots.json.corrupt-<ts> and the store starts empty', () =>
  withTempDir(async (tmp) => {
    const botsRoot = path.join(tmp, 'bots');
    await fs.mkdir(botsRoot, { recursive: true });
    await fs.writeFile(path.join(botsRoot, 'bots.json'), '{ this is not json');
    const store = new BotStore({ botsRoot });
    await store.init();
    assert.deepEqual(store.list(), []);
    assert.notEqual(await findCorruptBackup(botsRoot), null, 'corrupt file is renamed aside');

    // The recovered store keeps working.
    const record = await store.create({ name: 'Depois do caos' });
    assert.deepEqual(await readStoreFile(store.file), { statusVersion: 1, bots: [record] });
    const entries = await fs.readdir(botsRoot);
    assert.equal(entries.filter((entry) => entry.startsWith('bots.json.corrupt-')).length, 1);
  }));

await test('a valid-JSON document with the wrong shape is also quarantined', () =>
  withTempDir(async (tmp) => {
    const botsRoot = path.join(tmp, 'bots');
    await fs.mkdir(botsRoot, { recursive: true });
    await fs.writeFile(path.join(botsRoot, 'bots.json'), JSON.stringify({ statusVersion: 1, bots: 'nope' }));
    const store = new BotStore({ botsRoot });
    await store.init();
    assert.deepEqual(store.list(), []);
    assert.notEqual(await findCorruptBackup(botsRoot), null);
  }));

await test('loadable documents drop unusable entries and repair optional fields', () =>
  withTempDir(async (tmp) => {
    const botsRoot = path.join(tmp, 'bots');
    await fs.mkdir(botsRoot, { recursive: true });
    const valid = {
      id: 'a1b2c3d4e5',
      name: 'Válido',
      emoji: 'nope-not-an-emoji-too-long',
      color: 'red',
      instructions: 'instruções',
      workspaceDir: path.join(botsRoot, 'a1b2c3d4e5', 'workspace'),
      vm: { enabled: true, image: 'bad image!' },
      createdAt: '2026-11-08T20:00:00.000Z',
      updatedAt: '2026-11-08T20:00:00.000Z',
    };
    await fs.writeFile(
      path.join(botsRoot, 'bots.json'),
      JSON.stringify({ statusVersion: 1, bots: [valid, 'garbage', null, { name: '' }] }),
    );

    const store = new BotStore({ botsRoot });
    await store.init();
    const list = store.list();
    assert.equal(list.length, 1, 'unusable entries are dropped');
    assert.equal(list[0].id, valid.id);
    assert.equal(list[0].name, 'Válido');
    assert.equal(list[0].emoji, '🤖', 'invalid emoji falls back to the default');
    assert.match(list[0].color, /^#[0-9a-f]{6}$/, 'invalid color falls back to the palette');
    assert.deepEqual(list[0].vm, { enabled: true, image: 'ubuntu:24.04' });
    assert.equal(list[0].createdAt, valid.createdAt);
  }));

await test('init throws for unusable paths but never for corrupt JSON', () =>
  withTempDir(async (tmp) => {
    const blocker = path.join(tmp, 'blocker');
    await fs.writeFile(blocker, 'not a directory');
    const broken = new BotStore({ botsRoot: blocker });
    await assert.rejects(broken.init());

    await assert.throws(() => new BotStore({ botsRoot: 'relative/dir' }), TypeError);
    await assert.throws(() => new BotStore({ botsRoot: path.join(tmp, 'x'), defaultImage: 'bad image!' }), TypeError);

    if (typeof process.getuid === 'function' && process.getuid() !== 0) {
      const botsRoot = path.join(tmp, 'unreadable');
      await fs.mkdir(botsRoot, { recursive: true });
      const file = path.join(botsRoot, 'bots.json');
      await fs.writeFile(file, JSON.stringify({ statusVersion: 1, bots: [] }));
      await fs.chmod(file, 0o000);
      try {
        const store = new BotStore({ botsRoot });
        await assert.rejects(store.init(), (error) => error?.code === 'EACCES');
      } finally {
        await fs.chmod(file, 0o600);
      }
    }
  }));

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
      creates.push(store.create({ name: `Bot ${index}` }));
    }
    await Promise.all(creates);
    assert.equal(store.list().length, 11);

    const file = await readStoreFile(store.file);
    assert.equal(file.bots.length, 11);
    assert.equal(file.bots.find((bot) => bot.id === record.id).instructions, 'update-19');
    await assertNoTempFiles(store.botsRoot);

    const reloaded = new BotStore({ botsRoot: store.botsRoot });
    await reloaded.init();
    assert.equal(reloaded.list().length, 11);
  }));

await test('concurrent flushes stay atomic and readable', () =>
  withTempDir(async (tmp) => {
    const store = await makeStore(tmp);
    const record = await store.create({ name: 'Flush' });
    await Promise.all(Array.from({ length: 10 }, () => store.flush()));
    const file = await readStoreFile(store.file);
    assert.equal(file.bots.length, 1);
    assert.equal(file.bots[0].id, record.id);
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
