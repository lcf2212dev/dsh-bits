/**
 * Unit tests for host/routes.js (registerBotRoutes).
 *
 * Plain `node test/routes.test.mjs`; only Node built-ins are used. Routes are
 * captured through a fake `ctx.connection.fetch.register`, driven with real
 * Fetch `Request`/`Response` objects, and backed by an in-memory fake store and
 * fake VM adapter (no Docker, no DSH runtime).
 */

import assert from 'node:assert/strict';

import { registerBotRoutes } from '../host/routes.js';

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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ISO = '2026-11-08T20:00:00.000Z';

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
 * @template T
 * @param {T} value
 * @returns {T}
 */
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * @param {Record<string, any>} [overrides]
 * @returns {Record<string, any>}
 */
function makeRecord(overrides = {}) {
  const id = overrides.id ?? 'a1b2c3d4e5';
  return {
    id,
    name: 'Pesquisador',
    emoji: '🤖',
    color: '#7c3aed',
    instructions: 'Você é o Pesquisador.',
    workspaceDir: `/tmp/dsh-bots-tests/${id}/workspace`,
    vm: { enabled: true, image: 'ubuntu:24.04' },
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides,
  };
}

/**
 * @param {Record<string, any>} record
 * @returns {Record<string, any>} the VmStatus the fake VM reports by default
 */
function defaultStatus(record) {
  const enabled = record.vm?.enabled === true;
  return {
    id: record.id,
    containerName: `dsh-bot-${record.id}`,
    enabled,
    state: enabled ? 'running' : 'missing',
    running: enabled,
    image: record.vm?.image ?? 'ubuntu:24.04',
    startedAt: enabled ? ISO : null,
    exitCode: null,
    detail: null,
    error: null,
  };
}

// ---------------------------------------------------------------------------
// Fake store / fake VM
// ---------------------------------------------------------------------------

class FakeStore {
  /**
   * @param {Array<Record<string, any>>} records
   */
  constructor(records = []) {
    this.defaultImage = 'ubuntu:24.04';
    this.records = records.map(clone);
    this.calls = [];
    this.listError = null;
    this.createError = null;
    this.updateError = null;
    this.removeError = null;
    this.ensureWorkspaceError = null;
    this.createdId = 'f00dfeed11';
  }

  list() {
    this.calls.push(['list']);
    if (this.listError) throw this.listError;
    return this.records.map(clone);
  }

  get(id) {
    this.calls.push(['get', id]);
    const found = this.records.find((record) => record.id === id);
    return found === undefined ? undefined : clone(found);
  }

  getByWorkspace() {
    return undefined;
  }

  async create(input) {
    this.calls.push(['create', clone(input)]);
    if (this.createError) throw this.createError;
    const record = makeRecord({
      id: this.createdId,
      name: typeof input.name === 'string' ? input.name.trim() : '',
      emoji: input.emoji ?? '🤖',
      color: input.color ?? '#7c3aed',
      instructions: input.instructions ?? '',
      vm: { enabled: input.vm?.enabled === true, image: input.vm?.image ?? this.defaultImage },
    });
    this.records.push(record);
    return clone(record);
  }

  async update(id, patch) {
    this.calls.push(['update', id, clone(patch)]);
    if (this.updateError) throw this.updateError;
    const index = this.records.findIndex((record) => record.id === id);
    if (index < 0) throw coded('BOT_NOT_FOUND', `Bot "${id}" was not found`);
    const current = this.records[index];
    const next = { ...current, vm: { ...current.vm } };
    if (patch.name !== undefined) next.name = patch.name;
    if (patch.emoji !== undefined) next.emoji = patch.emoji;
    if (patch.color !== undefined) next.color = patch.color;
    if (patch.instructions !== undefined) next.instructions = patch.instructions;
    if (patch.vm !== undefined) next.vm = { ...next.vm, ...patch.vm };
    next.updatedAt = '2026-11-08T21:00:00.000Z';
    this.records[index] = next;
    return clone(next);
  }

  async remove(id, options = {}) {
    this.calls.push(['remove', id, clone(options)]);
    if (this.removeError) throw this.removeError;
    const index = this.records.findIndex((record) => record.id === id);
    if (index < 0) throw coded('BOT_NOT_FOUND', `Bot "${id}" was not found`);
    const [removed] = this.records.splice(index, 1);
    return clone(removed);
  }

  async ensureWorkspace(record) {
    this.calls.push(['ensureWorkspace', record.id]);
    if (this.ensureWorkspaceError) throw this.ensureWorkspaceError;
    return record.workspaceDir;
  }
}

class FakeVm {
  constructor() {
    this.defaultImage = 'ubuntu:24.04';
    this.availableResult = { available: true, version: '27.1.0', error: null };
    this.availableError = null;
    this.images = [{ name: 'ubuntu', tag: '24.04', id: 'sha256:abc', size: 123, reference: 'ubuntu:24.04' }];
    this.imagesError = null;
    this.statusError = null;
    this.statusImpl = null;
    this.statuses = new Map();
    this.actionCalls = [];
    this.actionErrors = new Map();
  }

  async available() {
    if (this.availableError) throw this.availableError;
    return clone(this.availableResult);
  }

  async listImages() {
    if (this.imagesError) throw this.imagesError;
    return clone(this.images);
  }

  async status(record) {
    if (this.statusImpl !== null) return this.statusImpl(record);
    if (this.statusError) throw this.statusError;
    const override = this.statuses.get(record.id);
    if (override !== undefined) return clone(override);
    return defaultStatus(record);
  }

  async start(record) {
    return this.#action('start', record);
  }

  async stop(record) {
    return this.#action('stop', record);
  }

  async restart(record) {
    return this.#action('restart', record);
  }

  async remove(record) {
    return this.#action('remove', record);
  }

  #action(name, record) {
    this.actionCalls.push([name, record.id]);
    const error = this.actionErrors.get(name);
    if (error !== undefined) throw error;
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// App wiring helpers
// ---------------------------------------------------------------------------

/**
 * @returns {{ ctx: any, routes: Map<string, any> }}
 */
function createContext() {
  const routes = new Map();
  const ctx = {
    connection: {
      fetch: {
        register(route) {
          assert.equal(typeof route.path, 'string');
          assert.ok(!routes.has(route.path), `duplicate route ${route.path}`);
          routes.set(route.path, route);
          return () => {
            routes.delete(route.path);
          };
        },
      },
    },
  };
  return { ctx, routes };
}

/**
 * @param {Record<string, any>} [options]
 * @returns {{ ctx: any, routes: Map<string, any>, dispose: () => void, deps: any,
 *   logs: string[], store: FakeStore, vm: FakeVm }}
 */
function setup(options = {}) {
  const { ctx, routes } = createContext();
  const store = options.store ?? new FakeStore(options.records ?? []);
  const vm = options.vm ?? new FakeVm();
  const logs = [];
  const deps = {
    store,
    vm,
    ready: Promise.resolve(),
    ensureWorkspaceId: async (record) => `ws-${record.id}`,
    log: (message) => {
      logs.push(message);
    },
  };
  if (options.ready !== undefined) deps.ready = options.ready;
  if (options.ensureWorkspaceId !== undefined) deps.ensureWorkspaceId = options.ensureWorkspaceId;
  const dispose = registerBotRoutes(ctx, deps);
  return { ctx, routes, dispose, deps, logs, store, vm };
}

/**
 * Invoke one registered route with a real Fetch request and parse the JSON body.
 *
 * @param {Map<string, any>} routes
 * @param {string} routePath
 * @param {{ method?: string, body?: unknown }} [options]
 * @returns {Promise<Record<string, any>>}
 */
async function call(routes, routePath, { method = 'GET', body } = {}) {
  const route = routes.get(routePath);
  assert.ok(route, `route ${routePath} is registered`);
  const request = new Request(`http://127.0.0.1:46181${routePath}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const response = await route.fetch(request);
  assert.equal(response.status, 200, 'handler-level responses are always HTTP 200');
  assert.match(response.headers.get('content-type') ?? '', /^application\/json/, 'JSON content type');
  return await response.json();
}

const ROUTES = Object.freeze([
  ['/api/bots.list', ['GET']],
  ['/api/bots.create', ['POST']],
  ['/api/bots.update', ['POST']],
  ['/api/bots.delete', ['POST']],
  ['/api/bots.vm', ['POST']],
  ['/api/bots.images', ['GET']],
  ['/api/bots.docker', ['GET']],
  ['/api/bots.catalog', ['GET']],
  ['/api/bots.avatar', ['GET']],
]);

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

await test('registers exactly the nine contracted routes and returns a disposer', async () => {
  const app = setup();
  assert.equal(app.routes.size, ROUTES.length);
  for (const [routePath, methods] of ROUTES) {
    const route = app.routes.get(routePath);
    assert.ok(route, `${routePath} registered`);
    assert.deepEqual(route.methods, methods, `${routePath} methods`);
    assert.equal(route.requestBody, 'buffered', `${routePath} buffered body`);
    assert.equal(typeof route.fetch, 'function', `${routePath} fetch handler`);
  }
  app.dispose();
  assert.equal(app.routes.size, 0, 'disposer removes every route');
  app.dispose(); // idempotent
});

await test('rejects a ctx without the fetch registry', async () => {
  assert.throws(() => registerBotRoutes({}, { store: {}, vm: {} }), TypeError);
  assert.throws(() => registerBotRoutes({ connection: { fetch: {} } }, { store: {}, vm: {} }), TypeError);
});

// ---------------------------------------------------------------------------
// /api/bots.list
// ---------------------------------------------------------------------------

await test('list returns every BotView plus docker status and defaultImage', async () => {
  const recordA = makeRecord();
  const recordB = makeRecord({ id: 'b2c3d4e5f6', name: 'Dev', vm: { enabled: false, image: 'alpine:3.20' } });
  const app = setup({ records: [recordA, recordB] });
  const payload = await call(app.routes, '/api/bots.list');

  assert.equal(payload.ok, true);
  assert.equal(payload.defaultImage, 'ubuntu:24.04');
  assert.deepEqual(payload.docker, { available: true, version: '27.1.0', error: null });
  assert.deepEqual(payload.bots, [
    {
      ...recordA,
      workspaceId: `ws-${recordA.id}`,
      workspaceError: null,
      vmStatus: defaultStatus(recordA),
    },
    {
      ...recordB,
      workspaceId: `ws-${recordB.id}`,
      workspaceError: null,
      vmStatus: defaultStatus(recordB),
    },
  ]);
});

await test('list degrades gracefully when workspace registry and docker probes fail', async () => {
  const record = makeRecord();
  const app = setup({ records: [record] });
  app.deps.ensureWorkspaceId = async () => {
    throw new Error('workspace registry offline');
  };
  app.vm.statusError = coded('VM_DOCKER_UNAVAILABLE', 'docker daemon unreachable');
  app.vm.availableError = new Error('docker not installed');
  const payload = await call(app.routes, '/api/bots.list');

  assert.equal(payload.ok, true, 'list-level degradation still returns ok');
  const view = payload.bots[0];
  assert.equal(view.workspaceId, null);
  assert.equal(view.workspaceError, 'workspace registry offline');
  assert.equal(view.vmStatus.state, 'unavailable');
  assert.equal(view.vmStatus.running, false);
  assert.equal(view.vmStatus.error, 'docker daemon unreachable');
  assert.equal(view.vmStatus.enabled, true);
  assert.deepEqual(payload.docker, { available: false, version: null, error: 'docker not installed' });
});

await test('list reports ordinary status failures as state "error"', async () => {
  const app = setup({ records: [makeRecord()] });
  app.vm.statusError = new Error('unexpected status failure');
  const payload = await call(app.routes, '/api/bots.list');
  assert.equal(payload.bots[0].vmStatus.state, 'error');
  assert.equal(payload.bots[0].vmStatus.error, 'unexpected status failure');
});

await test('list bounds a hanging VM status probe', async () => {
  const app = setup({ records: [makeRecord()] });
  app.vm.statusImpl = () => new Promise(() => {});
  const startedAt = Date.now();
  const payload = await call(app.routes, '/api/bots.list');
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed >= 3500, `list waited for the 4s bound (took ${elapsed}ms)`);
  assert.ok(elapsed < 15000, `list stayed bounded (took ${elapsed}ms)`);
  assert.equal(payload.ok, true);
  assert.equal(payload.bots[0].vmStatus.state, 'unavailable');
  assert.match(payload.bots[0].vmStatus.error, /timed out/);
});

await test('list reports INTERNAL and logs when the store explodes', async () => {
  const app = setup({ records: [makeRecord()] });
  app.store.listError = new Error('store exploded');
  const payload = await call(app.routes, '/api/bots.list');
  assert.deepEqual(payload, { ok: false, error: { code: 'INTERNAL', message: 'Internal server error' } });
  assert.ok(app.logs.some((line) => line.includes('store exploded')));
});

// ---------------------------------------------------------------------------
// /api/bots.create
// ---------------------------------------------------------------------------

await test('create returns a BotView and forwards only documented fields', async () => {
  const app = setup();
  const payload = await call(app.routes, '/api/bots.create', {
    method: 'POST',
    body: {
      name: 'Pesquisador',
      emoji: '🧪',
      instructions: 'persona',
      vm: { enabled: true, image: 'ubuntu:24.04' },
      id: 'aaaaaaaaaa',
      workspaceDir: '/tmp/evil',
    },
  });

  assert.equal(payload.ok, true);
  assert.equal(payload.bot.id, 'f00dfeed11');
  assert.equal(payload.bot.name, 'Pesquisador');
  assert.equal(payload.bot.emoji, '🧪');
  assert.deepEqual(payload.bot.vm, { enabled: true, image: 'ubuntu:24.04' });
  assert.equal(payload.bot.workspaceId, 'ws-f00dfeed11');
  assert.equal(payload.bot.workspaceError, null);
  assert.deepEqual(payload.bot.vmStatus, defaultStatus(payload.bot));

  const createCall = app.store.calls.find((entry) => entry[0] === 'create');
  assert.ok(createCall, 'store.create was called');
  assert.equal(createCall[1].id, undefined, 'route does not let callers force an id');
  assert.equal(createCall[1].workspaceDir, undefined, 'route does not let callers force a workspace');
  assert.equal(createCall[1].name, 'Pesquisador');
  assert.ok(app.store.calls.some((entry) => entry[0] === 'ensureWorkspace'));
});

await test('create returns BAD_REQUEST for malformed bodies', async () => {
  const app = setup();
  for (const body of ['{ not json', '42', 'null', '"text"', '[1,2]']) {
    const payload = await call(app.routes, '/api/bots.create', { method: 'POST', body });
    assert.equal(payload.ok, false, `body ${body}`);
    assert.equal(payload.error.code, 'BAD_REQUEST', `body ${body}`);
  }
  const noBody = await call(app.routes, '/api/bots.create', { method: 'POST' });
  assert.equal(noBody.error.code, 'BAD_REQUEST');
});

await test('create passes coded validation errors through and maps plain errors to INTERNAL', async () => {
  const app = setup();
  app.store.createError = coded('BOT_INVALID_NAME', 'Bot name must be 1-60 characters');
  let payload = await call(app.routes, '/api/bots.create', { method: 'POST', body: { name: '' } });
  assert.deepEqual(payload.error, {
    code: 'BOT_INVALID_NAME',
    message: 'Bot name must be 1-60 characters',
  });

  app.store.createError = new Error('disk full');
  payload = await call(app.routes, '/api/bots.create', { method: 'POST', body: { name: 'Ok' } });
  assert.deepEqual(payload, { ok: false, error: { code: 'INTERNAL', message: 'Internal server error' } });
  assert.ok(app.logs.some((line) => line.includes('disk full')));
});

await test('create keeps the bot when workspace creation fails (logged only)', async () => {
  const app = setup();
  app.store.ensureWorkspaceError = new Error('mkdir denied');
  const payload = await call(app.routes, '/api/bots.create', { method: 'POST', body: { name: 'Ok' } });
  assert.equal(payload.ok, true, 'record creation is not failed by mkdir');
  assert.ok(app.logs.some((line) => line.includes('mkdir denied')));
});

// ---------------------------------------------------------------------------
// /api/bots.update
// ---------------------------------------------------------------------------

await test('update returns the patched BotView', async () => {
  const record = makeRecord();
  const app = setup({ records: [record] });
  const payload = await call(app.routes, '/api/bots.update', {
    method: 'POST',
    body: { id: record.id, patch: { name: 'Novo nome', vm: { enabled: false } } },
  });

  assert.equal(payload.ok, true);
  assert.equal(payload.bot.id, record.id);
  assert.equal(payload.bot.name, 'Novo nome');
  assert.deepEqual(payload.bot.vm, { enabled: false, image: 'ubuntu:24.04' });
  assert.deepEqual(payload.bot.vmStatus, defaultStatus(payload.bot));
});

await test('update validates the request and maps unknown ids to BOT_NOT_FOUND', async () => {
  const record = makeRecord();
  const app = setup({ records: [record] });

  let payload = await call(app.routes, '/api/bots.update', {
    method: 'POST',
    body: { id: record.id, patch: { name: 'x' } },
  });
  assert.equal(payload.ok, true);

  payload = await call(app.routes, '/api/bots.update', {
    method: 'POST',
    body: { id: 'ffffffffff', patch: { name: 'x' } },
  });
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, 'BOT_NOT_FOUND');

  payload = await call(app.routes, '/api/bots.update', { method: 'POST', body: { patch: { name: 'x' } } });
  assert.equal(payload.error.code, 'BAD_REQUEST');

  payload = await call(app.routes, '/api/bots.update', {
    method: 'POST',
    body: { id: record.id, patch: 'not-an-object' },
  });
  assert.equal(payload.error.code, 'BAD_REQUEST');

  payload = await call(app.routes, '/api/bots.update', { method: 'POST', body: { id: record.id } });
  assert.equal(payload.error.code, 'BAD_REQUEST');

  app.store.updateError = coded('BOT_INVALID_PATCH', 'Cannot update bot field "id"');
  payload = await call(app.routes, '/api/bots.update', {
    method: 'POST',
    body: { id: record.id, patch: { id: 'aaaaaaaaaa' } },
  });
  assert.deepEqual(payload.error, { code: 'BOT_INVALID_PATCH', message: 'Cannot update bot field "id"' });
});

// ---------------------------------------------------------------------------
// /api/bots.delete
// ---------------------------------------------------------------------------

await test('delete removes the record, keeps the workspace and removes the container', async () => {
  const record = makeRecord();
  const app = setup({ records: [record] });
  const payload = await call(app.routes, '/api/bots.delete', { method: 'POST', body: { id: record.id } });

  assert.deepEqual(payload, {
    ok: true,
    deleted: true,
    workspaceRemoved: false,
    workspaceDir: record.workspaceDir,
  });
  assert.deepEqual(app.store.records, []);
  assert.deepEqual(app.vm.actionCalls, [['remove', record.id]]);
});

await test('delete reports workspaceRemoved when the workspace was deleted', async () => {
  const record = makeRecord();
  const app = setup({ records: [record] });
  const payload = await call(app.routes, '/api/bots.delete', {
    method: 'POST',
    body: { id: record.id, deleteWorkspace: true },
  });
  assert.equal(payload.ok, true);
  assert.equal(payload.workspaceRemoved, true);
  const removeCall = app.store.calls.find((entry) => entry[0] === 'remove');
  assert.deepEqual(removeCall[2], { deleteWorkspace: true });
});

await test('delete survives a failed container removal but refuses unsafe workspaces', async () => {
  const record = makeRecord();
  const app = setup({ records: [record] });
  app.vm.actionErrors.set('remove', new Error('docker rm failed'));
  let payload = await call(app.routes, '/api/bots.delete', { method: 'POST', body: { id: record.id } });
  assert.equal(payload.ok, true, 'record deletion wins over container cleanup');
  assert.equal(payload.deleted, true);
  assert.ok(app.logs.some((line) => line.includes('docker rm failed')));

  const another = makeRecord({ id: 'b2c3d4e5f6' });
  const unsafe = setup({ records: [another] });
  unsafe.store.removeError = coded('BOT_WORKSPACE_OUTSIDE_ROOT', 'Refusing to delete workspace outside bots root');
  payload = await call(unsafe.routes, '/api/bots.delete', {
    method: 'POST',
    body: { id: another.id, deleteWorkspace: true },
  });
  assert.deepEqual(payload.error, {
    code: 'BOT_WORKSPACE_OUTSIDE_ROOT',
    message: 'Refusing to delete workspace outside bots root',
  });
  assert.deepEqual(unsafe.vm.actionCalls, [], 'container is not touched when the delete is refused');
});

await test('delete validates its body and unknown ids', async () => {
  const record = makeRecord();
  const app = setup({ records: [record] });
  let payload = await call(app.routes, '/api/bots.delete', { method: 'POST', body: { id: 'ffffffffff' } });
  assert.equal(payload.error.code, 'BOT_NOT_FOUND');

  payload = await call(app.routes, '/api/bots.delete', { method: 'POST', body: {} });
  assert.equal(payload.error.code, 'BAD_REQUEST');

  payload = await call(app.routes, '/api/bots.delete', {
    method: 'POST',
    body: { id: record.id, deleteWorkspace: 'yes' },
  });
  assert.equal(payload.error.code, 'BAD_REQUEST');

  payload = await call(app.routes, '/api/bots.delete', { method: 'POST', body: '{ broken' });
  assert.equal(payload.error.code, 'BAD_REQUEST');
});

// ---------------------------------------------------------------------------
// /api/bots.vm
// ---------------------------------------------------------------------------

await test('vm dispatches every lifecycle action and returns the refreshed BotView', async () => {
  const record = makeRecord();
  for (const action of ['start', 'stop', 'restart', 'remove']) {
    const app = setup({ records: [record] });
    const payload = await call(app.routes, '/api/bots.vm', { method: 'POST', body: { id: record.id, action } });
    assert.equal(payload.ok, true, action);
    assert.equal(payload.bot.id, record.id, action);
    assert.deepEqual(app.vm.actionCalls, [[action, record.id]], action);
    assert.deepEqual(payload.bot.vmStatus, defaultStatus(payload.bot), action);
  }

  const app = setup({ records: [record] });
  const payload = await call(app.routes, '/api/bots.vm', {
    method: 'POST',
    body: { id: record.id, action: 'status' },
  });
  assert.equal(payload.ok, true);
  assert.deepEqual(app.vm.actionCalls, [], 'status does not trigger a lifecycle action');
});

await test('vm validates id/action and maps errors', async () => {
  const record = makeRecord();
  const app = setup({ records: [record] });

  let payload = await call(app.routes, '/api/bots.vm', {
    method: 'POST',
    body: { id: record.id, action: 'explode' },
  });
  assert.equal(payload.error.code, 'BAD_REQUEST');

  payload = await call(app.routes, '/api/bots.vm', { method: 'POST', body: { id: record.id } });
  assert.equal(payload.error.code, 'BAD_REQUEST');

  payload = await call(app.routes, '/api/bots.vm', {
    method: 'POST',
    body: { id: 'ffffffffff', action: 'start' },
  });
  assert.equal(payload.error.code, 'BOT_NOT_FOUND');

  app.vm.actionErrors.set('start', coded('VM_IMAGE_MISSING', 'image "ubuntu:24.04" is not present locally'));
  payload = await call(app.routes, '/api/bots.vm', {
    method: 'POST',
    body: { id: record.id, action: 'start' },
  });
  assert.deepEqual(payload.error, {
    code: 'VM_IMAGE_MISSING',
    message: 'image "ubuntu:24.04" is not present locally',
  });

  app.vm.actionErrors.set('start', new Error('docker spawn ENOENT'));
  payload = await call(app.routes, '/api/bots.vm', {
    method: 'POST',
    body: { id: record.id, action: 'start' },
  });
  assert.equal(payload.error.code, 'INTERNAL');
  assert.ok(app.logs.some((line) => line.includes('docker spawn ENOENT')));
});

await test('vm status probes degrade inside the BotView instead of failing the action', async () => {
  const record = makeRecord();
  const app = setup({ records: [record] });
  app.vm.statusError = coded('VM_DOCKER_UNAVAILABLE', 'docker daemon unreachable');
  const payload = await call(app.routes, '/api/bots.vm', {
    method: 'POST',
    body: { id: record.id, action: 'start' },
  });
  assert.equal(payload.ok, true);
  assert.equal(payload.bot.vmStatus.state, 'unavailable');
  assert.equal(payload.bot.vmStatus.error, 'docker daemon unreachable');
});

// ---------------------------------------------------------------------------
// /api/bots.images and /api/bots.docker
// ---------------------------------------------------------------------------

await test('images lists local images with the default image', async () => {
  const app = setup();
  const payload = await call(app.routes, '/api/bots.images');
  assert.deepEqual(payload, {
    ok: true,
    images: app.vm.images,
    defaultImage: 'ubuntu:24.04',
  });
});

await test('images degrades to an empty list when docker cannot be queried', async () => {
  const app = setup();
  app.vm.imagesError = coded('VM_DOCKER_UNAVAILABLE', 'docker daemon unreachable');
  const payload = await call(app.routes, '/api/bots.images');
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.images, []);
  assert.equal(payload.defaultImage, 'ubuntu:24.04');
  assert.ok(app.logs.some((line) => line.includes('docker daemon unreachable')));
});

await test('docker reports availability and degrades on probe errors', async () => {
  const app = setup();
  let payload = await call(app.routes, '/api/bots.docker');
  assert.deepEqual(payload, { ok: true, available: true, version: '27.1.0', error: null });

  app.vm.availableError = new Error('daemon down');
  payload = await call(app.routes, '/api/bots.docker');
  assert.deepEqual(payload, { ok: true, available: false, version: null, error: 'daemon down' });

  const disabled = setup();
  disabled.vm.availableResult = { available: false, version: null, error: 'docker missing' };
  payload = await call(disabled.routes, '/api/bots.docker');
  assert.deepEqual(payload, { ok: true, available: false, version: null, error: 'docker missing' });
});

// ---------------------------------------------------------------------------
// Readiness gating and logging safety
// ---------------------------------------------------------------------------

await test('every handler awaits deps.ready before touching the store', async () => {
  let releaseReady;
  const ready = new Promise((resolve) => {
    releaseReady = resolve;
  });
  const record = makeRecord();
  const app = setup({ records: [record], ready });
  let settled = false;
  const pending = call(app.routes, `/api/bots.list`).then((payload) => {
    settled = true;
    return payload;
  });

  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(settled, false, 'handler waits for ready');
  assert.deepEqual(app.store.calls, [], 'store is untouched before ready');
  releaseReady();
  const payload = await pending;
  assert.equal(payload.ok, true);
  assert.equal(app.store.calls.length > 0, true);
});

await test('a rejected ready gate produces INTERNAL instead of crashing the route', async () => {
  const app = setup({ ready: Promise.reject(new Error('store init failed')) });
  const payload = await call(app.routes, '/api/bots.list');
  assert.deepEqual(payload, { ok: false, error: { code: 'INTERNAL', message: 'Internal server error' } });
  assert.ok(app.logs.some((line) => line.includes('store init failed')));
});

await test('a throwing logger cannot break an INTERNAL response', async () => {
  const app = setup({ records: [makeRecord()] });
  app.deps.log = () => {
    throw new Error('logger exploded');
  };
  app.store.listError = new Error('store exploded');
  const payload = await call(app.routes, '/api/bots.list');
  assert.deepEqual(payload, { ok: false, error: { code: 'INTERNAL', message: 'Internal server error' } });
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

if (failures.length > 0) {
  console.error(`\nroutes: ${failures.length} failed, ${passed} passed`);
  process.exitCode = 1;
} else {
  console.log(`\nroutes: ${passed} tests passed`);
}
