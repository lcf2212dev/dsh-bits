/**
 * Unit tests for host/routes.js (registerBotRoutes v5).
 *
 * Plain `node test/routes.test.mjs`; only Node built-ins are used. Routes are
 * captured through a fake `ctx.connection.fetch.register`, driven with real
 * Fetch `Request`/`Response` objects, and backed by an in-memory fake bit store
 * and a fake bit runtime (no DSH runtime, no Claude Code, no Docker).
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
    character: null,
    emoji: '🤖',
    color: '#7c3aed',
    instructions: 'Você é o Pesquisador.',
    isOrchestrator: false,
    model: 'subscription/sonnet',
    effort: 'high',
    workspaceDir: `/tmp/dsh-bits-tests/${id}/workspace`,
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides,
  };
}

const SCOUT = Object.freeze({
  id: 'bit-scout',
  name: 'Scout',
  group: 'workers',
  emoji: '🔎',
  color: '#c88f36',
  summary: { pt: 'Localiza arquivos.', en: 'Finds files.' },
  instructions: 'Contexto do scout.',
  isOrchestrator: false,
  model: 'subscription/haiku',
  effort: 'low',
});

const COORDINATOR = Object.freeze({
  id: 'bit-coordinator',
  name: 'Coordinator',
  group: 'management',
  emoji: '🧭',
  color: '#2563eb',
  summary: { pt: 'Coordena o fluxo.', en: 'Coordinates the flow.' },
  instructions: 'Contexto do coordinator.',
  isOrchestrator: true,
  model: 'deepseek-account/deepseek-flash',
  effort: 'max',
});

/**
 * Minimal catalog double matching the shape `loadBitCatalog` exposes.
 *
 * @returns {Record<string, any>}
 */
function makeCatalog() {
  const bits = [SCOUT, COORDINATOR];
  const byId = new Map(bits.map((bit) => [bit.id, bit]));
  return {
    version: 2,
    groups: [
      { id: 'workers', label: { pt: 'Workers', en: 'Workers' } },
      { id: 'management', label: { pt: 'Gestão', en: 'Management' } },
    ],
    bits: bits.map(clone),
    error: null,
    has: (id) => typeof id === 'string' && byId.has(id),
    get: (id) => (typeof id === 'string' && byId.has(id) ? clone(byId.get(id)) : undefined),
    readAvatar: async (id) => {
      if (typeof id !== 'string' || !byId.has(id)) throw coded('BIT_NOT_FOUND', `Unknown bit "${String(id)}"`);
      return Buffer.from('RIFF0000WEBPdata');
    },
  };
}

const MODEL_OPTIONS = Object.freeze([
  {
    id: 'subscription/opus',
    label: 'Claude Opus 5.5 (assinatura)',
    group: 'subscription',
    backend: 'claude-code',
    alias: 'opus',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    tools: true,
    supportsOrchestrator: false,
  },
  {
    id: 'deepseek-account/deepseek-flash',
    label: 'DeepSeek V4.1 Flash',
    group: 'routes',
    backend: 'dsh',
    provider: 'deepseek-account',
    model: 'deepseek-flash',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    tools: false,
    supportsOrchestrator: true,
  },
]);

// ---------------------------------------------------------------------------
// Fake bit store / fake runtime
// ---------------------------------------------------------------------------

class FakeStore {
  /**
   * @param {Array<Record<string, any>>} records
   */
  constructor(records = []) {
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

  async create(input) {
    this.calls.push(['create', clone(input)]);
    if (this.createError) throw this.createError;
    const id = this.createdId;
    const record = makeRecord({
      id,
      name: typeof input.name === 'string' ? input.name.trim() : '',
      character: input.character ?? null,
      emoji: input.emoji ?? '🤖',
      color: input.color ?? '#7c3aed',
      instructions: input.instructions ?? '',
      isOrchestrator: input.isOrchestrator === true,
      model: input.model ?? 'subscription/sonnet',
      effort: input.effort ?? 'high',
      workspaceDir: `/tmp/dsh-bits-tests/${id}/workspace`,
    });
    this.records.push(record);
    return clone(record);
  }

  async update(id, patch) {
    this.calls.push(['update', id, clone(patch)]);
    if (this.updateError) throw this.updateError;
    const index = this.records.findIndex((record) => record.id === id);
    if (index < 0) throw coded('BOT_NOT_FOUND', `Bit "${id}" was not found`);
    const next = { ...this.records[index], ...patch, updatedAt: '2026-11-08T21:00:00.000Z' };
    this.records[index] = next;
    return clone(next);
  }

  async remove(id, options = {}) {
    this.calls.push(['remove', id, clone(options)]);
    if (this.removeError) throw this.removeError;
    const index = this.records.findIndex((record) => record.id === id);
    if (index < 0) throw coded('BOT_NOT_FOUND', `Bit "${id}" was not found`);
    const [removed] = this.records.splice(index, 1);
    return clone(removed);
  }

  async ensureWorkspace(record) {
    this.calls.push(['ensureWorkspace', record.id]);
    if (this.ensureWorkspaceError) throw this.ensureWorkspaceError;
    return record.workspaceDir;
  }
}

class FakeRuntime {
  constructor() {
    this.models = MODEL_OPTIONS.map(clone);
    this.listModelsCalls = [];
    this.runCalls = [];
    this.runSignals = [];
    this.listModelsError = null;
    this.runError = null;
    this.runImpl = null;
  }

  async listModels(options = {}) {
    this.listModelsCalls.push(options);
    if (this.listModelsError) throw this.listModelsError;
    return { models: clone(this.models) };
  }

  async runBit(params) {
    this.runCalls.push({
      bit: clone(params.bit),
      request: params.request,
      readOnly: params.readOnly,
      cwd: params.cwd,
    });
    this.runSignals.push(params.signal);
    if (this.runError) throw this.runError;
    if (typeof this.runImpl === 'function') return this.runImpl(params);
    return {
      response: 'resposta do bit',
      meta: { backend: 'claude-code', model: 'subscription/sonnet', effort: 'high', durationMs: 7 },
    };
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
 *   logs: string[], bits: FakeStore, runtime: FakeRuntime }}
 */
function setup(options = {}) {
  const { ctx, routes } = createContext();
  const bits = options.bits ?? new FakeStore(options.records ?? []);
  const runtime = 'runtime' in options ? options.runtime : new FakeRuntime();
  const logs = [];
  const deps = {
    bits,
    catalog: 'catalog' in options ? options.catalog : makeCatalog(),
    ready: Promise.resolve(),
    runtime,
    log: (message) => {
      logs.push(message);
    },
  };
  if (options.ready !== undefined) deps.ready = options.ready;
  if (options.runTimeoutMs !== undefined) deps.runTimeoutMs = options.runTimeoutMs;
  const dispose = registerBotRoutes(ctx, deps);
  return { ctx, routes, dispose, deps, logs, bits, runtime };
}

/**
 * Invoke one registered route and return the raw Fetch `Response`.
 *
 * @param {Map<string, any>} routes
 * @param {string} routePath
 * @param {{ method?: string, body?: unknown, signal?: AbortSignal }} [options]
 * @returns {Promise<Response>}
 */
async function call(routes, routePath, { method = 'GET', body, signal } = {}) {
  const route = routes.get(routePath.split('?')[0]);
  assert.ok(route, `route ${routePath} is registered`);
  const request = new Request(`http://127.0.0.1:46181${routePath}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    signal,
  });
  return route.fetch(request);
}

/**
 * Invoke one registered JSON route and parse its payload.
 *
 * @param {Map<string, any>} routes
 * @param {string} routePath
 * @param {{ method?: string, body?: unknown, signal?: AbortSignal }} [options]
 * @returns {Promise<Record<string, any>>}
 */
async function callJson(routes, routePath, options = {}) {
  const response = await call(routes, routePath, options);
  assert.equal(response.status, 200, 'handler-level responses are always HTTP 200');
  assert.match(response.headers.get('content-type') ?? '', /^application\/json/, 'JSON content type');
  return response.json();
}

const ROUTES = Object.freeze([
  ['/api/bots.list', ['GET']],
  ['/api/bots.create', ['POST']],
  ['/api/bots.update', ['POST']],
  ['/api/bots.delete', ['POST']],
  ['/api/bots.catalog', ['GET']],
  ['/api/bots.avatar', ['GET']],
  ['/api/bots.models', ['GET']],
  ['/api/bots.run', ['POST']],
]);

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

await test('registers exactly the eight contracted routes and returns a disposer', async () => {
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

await test('no v4 VM/docker/notify routes are registered anymore', async () => {
  const app = setup();
  for (const removed of [
    '/api/bots.vm',
    '/api/bots.images',
    '/api/bots.docker',
    '/api/bots.notify-test',
  ]) {
    assert.equal(app.routes.has(removed), false, `${removed} must be gone`);
  }
});

await test('rejects a ctx without the fetch registry or deps without bits', async () => {
  assert.throws(() => registerBotRoutes({}, { bits: {} }), TypeError);
  assert.throws(() => registerBotRoutes({ connection: { fetch: {} } }, { bits: {} }), TypeError);
  assert.throws(() => registerBotRoutes(createContext().ctx, {}), TypeError);
  // The v4 deps.store/vm names are not accepted anymore.
  assert.throws(() => registerBotRoutes(createContext().ctx, { store: {}, vm: {} }), TypeError);
});

// ---------------------------------------------------------------------------
// /api/bots.list
// ---------------------------------------------------------------------------

await test('list returns bits plus the bots alias without VM/workspace enrichment', async () => {
  const recordA = makeRecord();
  const recordB = makeRecord({ id: 'b2c3d4e5f6', name: 'Dev', character: 'bit-builder', model: 'subscription/opus' });
  const app = setup({ records: [recordA, recordB] });
  const payload = await callJson(app.routes, '/api/bots.list');

  assert.equal(payload.ok, true);
  assert.deepEqual(payload.bits, [recordA, recordB]);
  assert.deepEqual(payload.bots, payload.bits, 'bots is a clone of bits for older clients');
  for (const view of payload.bits) {
    assert.equal('workspaceId' in view, false, 'workspaceId is removed');
    assert.equal('workspaceError' in view, false);
    assert.equal('vmStatus' in view, false, 'vmStatus is removed');
    assert.equal('vm' in view, false, 'vm is removed');
  }
  for (const removed of ['docker', 'defaultImage']) {
    assert.equal(removed in payload, false, `${removed} is not part of the v5 list payload`);
  }
  assert.deepEqual(app.bits.calls, [['list']]);
});

await test('list returns independent copies (mutating the payload never touches the store)', async () => {
  const record = makeRecord();
  const app = setup({ records: [record] });
  const payload = await callJson(app.routes, '/api/bots.list');
  payload.bits[0].name = 'HACKED';
  payload.bits.push({ id: 'ffffffffff' });
  assert.equal(app.bits.records[0].name, record.name);
  assert.equal(app.bits.records.length, 1);
});

await test('list reports INTERNAL and logs when the store explodes', async () => {
  const app = setup({ records: [makeRecord()] });
  app.bits.listError = new Error('store exploded');
  const payload = await callJson(app.routes, '/api/bots.list');
  assert.deepEqual(payload, { ok: false, error: { code: 'INTERNAL', message: 'Internal server error' } });
  assert.ok(app.logs.some((line) => line.includes('store exploded')));
});

// ---------------------------------------------------------------------------
// /api/bots.create
// ---------------------------------------------------------------------------

await test('create returns bit and bot aliases from only documented fields', async () => {
  const app = setup();
  const payload = await callJson(app.routes, '/api/bots.create', {
    method: 'POST',
    body: {
      name: 'Pesquisador',
      character: 'bit-scout',
      emoji: '🧪',
      color: '#123456',
      instructions: 'persona',
      isOrchestrator: false,
      model: 'subscription/opus',
      effort: 'xhigh',
      // Fields the route must never forward:
      id: 'aaaaaaaaaa',
      workspaceDir: '/tmp/evil',
      vm: { enabled: true, image: 'ubuntu:24.04' },
    },
  });

  assert.equal(payload.ok, true);
  assert.equal(payload.bit.id, 'f00dfeed11');
  assert.equal(payload.bit.name, 'Pesquisador');
  assert.equal(payload.bit.character, 'bit-scout');
  assert.equal(payload.bit.emoji, '🧪');
  assert.equal(payload.bit.model, 'subscription/opus');
  assert.equal(payload.bit.effort, 'xhigh');
  assert.deepEqual(payload.bot, payload.bit, 'bot alias mirrors bit');

  const createCall = app.bits.calls.find((entry) => entry[0] === 'create');
  assert.ok(createCall, 'store.create was called');
  const forwarded = createCall[1];
  assert.equal(forwarded.id, undefined, 'route does not let callers force an id');
  assert.equal(forwarded.workspaceDir, undefined, 'route does not let callers force a workspace');
  assert.equal(forwarded.vm, undefined, 'route does not forward the removed vm field');
  assert.equal(forwarded.name, 'Pesquisador');
  assert.equal(forwarded.character, 'bit-scout');
  assert.equal(forwarded.isOrchestrator, false);
  assert.equal(forwarded.model, 'subscription/opus');
  assert.equal(forwarded.effort, 'xhigh');
  assert.equal(app.bits.calls.some((entry) => entry[0] === 'ensureWorkspace'), false, 'the store owns workspace creation');
});

await test('create returns BAD_REQUEST for malformed bodies', async () => {
  const app = setup();
  for (const body of ['{ not json', '42', 'null', '"text"', '[1,2]']) {
    const payload = await callJson(app.routes, '/api/bots.create', { method: 'POST', body });
    assert.equal(payload.ok, false, `body ${body}`);
    assert.equal(payload.error.code, 'BAD_REQUEST', `body ${body}`);
  }
  const noBody = await callJson(app.routes, '/api/bots.create', { method: 'POST' });
  assert.equal(noBody.error.code, 'BAD_REQUEST');
  assert.deepEqual(app.bits.calls, [], 'invalid requests never reach the store');
});

await test('create passes coded validation errors through and maps plain errors to INTERNAL', async () => {
  const app = setup();
  app.bits.createError = coded('BOT_INVALID_NAME', 'Bit name must be 1-60 characters');
  let payload = await callJson(app.routes, '/api/bots.create', { method: 'POST', body: { name: '' } });
  assert.deepEqual(payload.error, {
    code: 'BOT_INVALID_NAME',
    message: 'Bit name must be 1-60 characters',
  });

  app.bits.createError = coded('BOT_LIMIT', 'At most 200 bits are supported');
  payload = await callJson(app.routes, '/api/bots.create', { method: 'POST', body: { name: 'Ok' } });
  assert.equal(payload.error.code, 'BOT_LIMIT');

  app.bits.createError = new Error('disk full');
  payload = await callJson(app.routes, '/api/bots.create', { method: 'POST', body: { name: 'Ok' } });
  assert.deepEqual(payload, { ok: false, error: { code: 'INTERNAL', message: 'Internal server error' } });
  assert.ok(app.logs.some((line) => line.includes('disk full')));
});

await test('create rejects unknown catalog characters before touching the store', async () => {
  const app = setup();
  let payload = await callJson(app.routes, '/api/bots.create', {
    method: 'POST',
    body: { name: 'X', character: 'bit-unknown' },
  });
  assert.equal(payload.error.code, 'BOT_INVALID_CHARACTER');
  assert.deepEqual(app.bits.calls, [], 'nothing created');

  payload = await callJson(app.routes, '/api/bots.create', {
    method: 'POST',
    body: { name: 'Scout', character: 'bit-scout' },
  });
  assert.equal(payload.ok, true);
  assert.equal(payload.bit.character, 'bit-scout');

  payload = await callJson(app.routes, '/api/bots.create', {
    method: 'POST',
    body: { name: 'Sem personagem', character: null },
  });
  assert.equal(payload.ok, true, 'null clears the character');
});

// ---------------------------------------------------------------------------
// /api/bots.update
// ---------------------------------------------------------------------------

await test('update returns the patched bit and its bot alias', async () => {
  const record = makeRecord();
  const app = setup({ records: [record] });
  const patch = {
    name: 'Novo nome',
    isOrchestrator: true,
    model: 'deepseek-account/deepseek-flash',
    effort: 'max',
  };
  const payload = await callJson(app.routes, '/api/bots.update', {
    method: 'POST',
    body: { id: record.id, patch },
  });

  assert.equal(payload.ok, true);
  assert.equal(payload.bit.id, record.id);
  assert.equal(payload.bit.name, 'Novo nome');
  assert.equal(payload.bit.isOrchestrator, true);
  assert.equal(payload.bit.model, 'deepseek-account/deepseek-flash');
  assert.equal(payload.bit.effort, 'max');
  assert.deepEqual(payload.bot, payload.bit);

  const updateCall = app.bits.calls.find((entry) => entry[0] === 'update');
  assert.deepEqual(updateCall, ['update', record.id, patch]);
});

await test('update validates the request and maps unknown ids to BOT_NOT_FOUND', async () => {
  const record = makeRecord();
  const app = setup({ records: [record] });

  let payload = await callJson(app.routes, '/api/bots.update', {
    method: 'POST',
    body: { id: 'ffffffffff', patch: { name: 'x' } },
  });
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, 'BOT_NOT_FOUND');

  payload = await callJson(app.routes, '/api/bots.update', { method: 'POST', body: { patch: { name: 'x' } } });
  assert.equal(payload.error.code, 'BAD_REQUEST');

  payload = await callJson(app.routes, '/api/bots.update', {
    method: 'POST',
    body: { id: record.id, patch: 'not-an-object' },
  });
  assert.equal(payload.error.code, 'BAD_REQUEST');

  payload = await callJson(app.routes, '/api/bots.update', { method: 'POST', body: { id: record.id } });
  assert.equal(payload.error.code, 'BAD_REQUEST');

  payload = await callJson(app.routes, '/api/bots.update', {
    method: 'POST',
    body: { id: record.id, patch: { character: 'bit-unknown' } },
  });
  assert.equal(payload.error.code, 'BOT_INVALID_CHARACTER');

  app.bits.updateError = coded('BOT_INVALID_PATCH', 'Cannot update bit field "id"');
  payload = await callJson(app.routes, '/api/bots.update', {
    method: 'POST',
    body: { id: record.id, patch: { id: 'aaaaaaaaaa' } },
  });
  assert.deepEqual(payload.error, { code: 'BOT_INVALID_PATCH', message: 'Cannot update bit field "id"' });
});

await test('create/update pass the orchestrator-model BOT_INVALID through verbatim', async () => {
  const message =
    'model: an orchestrator bit needs a DSH chat route (<provider>/<model>); "subscription/opus" is a subscription model (workers only)';

  const createApp = setup();
  createApp.bits.createError = coded('BOT_INVALID', message);
  let payload = await callJson(createApp.routes, '/api/bots.create', {
    method: 'POST',
    body: { name: 'Bad Orchestrator', isOrchestrator: true, model: 'subscription/opus' },
  });
  assert.deepEqual(payload, { ok: false, error: { code: 'BOT_INVALID', message } });

  const record = makeRecord();
  const updateApp = setup({ records: [record] });
  updateApp.bits.updateError = coded(
    'BOT_INVALID',
    'model: an orchestrator bit needs a DSH chat route (<provider>/<model>); "opus" is a subscription model (workers only)',
  );
  payload = await callJson(updateApp.routes, '/api/bots.update', {
    method: 'POST',
    body: { id: record.id, patch: { isOrchestrator: true, model: 'opus' } },
  });
  assert.equal(payload.error.code, 'BOT_INVALID');
  assert.match(payload.error.message, /orchestrator bit needs a DSH chat route/);
  assert.equal(updateApp.bits.records[0].isOrchestrator, false, 'failed update keeps the record');
});

// ---------------------------------------------------------------------------
// /api/bots.delete
// ---------------------------------------------------------------------------

await test('delete removes the record and reports the workspace decision', async () => {
  const record = makeRecord();
  const app = setup({ records: [record] });
  const payload = await callJson(app.routes, '/api/bots.delete', { method: 'POST', body: { id: record.id } });

  assert.deepEqual(payload, {
    ok: true,
    deleted: true,
    id: record.id,
    workspaceRemoved: false,
    workspaceDir: record.workspaceDir,
  });
  assert.deepEqual(app.bits.records, []);
  const removeCall = app.bits.calls.find((entry) => entry[0] === 'remove');
  assert.deepEqual(removeCall, ['remove', record.id, { deleteWorkspace: false }]);
});

await test('delete reports workspaceRemoved when the workspace was deleted', async () => {
  const record = makeRecord();
  const app = setup({ records: [record] });
  const payload = await callJson(app.routes, '/api/bots.delete', {
    method: 'POST',
    body: { id: record.id, deleteWorkspace: true },
  });
  assert.equal(payload.ok, true);
  assert.equal(payload.workspaceRemoved, true);
  const removeCall = app.bits.calls.find((entry) => entry[0] === 'remove');
  assert.deepEqual(removeCall, ['remove', record.id, { deleteWorkspace: true }]);
});

await test('delete validates its body and passes coded refusals through', async () => {
  const record = makeRecord();
  const app = setup({ records: [record] });
  let payload = await callJson(app.routes, '/api/bots.delete', { method: 'POST', body: { id: 'ffffffffff' } });
  assert.equal(payload.error.code, 'BOT_NOT_FOUND');

  payload = await callJson(app.routes, '/api/bots.delete', { method: 'POST', body: {} });
  assert.equal(payload.error.code, 'BAD_REQUEST');

  payload = await callJson(app.routes, '/api/bots.delete', {
    method: 'POST',
    body: { id: record.id, deleteWorkspace: 'yes' },
  });
  assert.equal(payload.error.code, 'BAD_REQUEST');

  payload = await callJson(app.routes, '/api/bots.delete', { method: 'POST', body: '{ broken' });
  assert.equal(payload.error.code, 'BAD_REQUEST');

  app.bits.removeError = coded('BOT_WORKSPACE_OUTSIDE_ROOT', 'Refusing to delete workspace outside bits root');
  payload = await callJson(app.routes, '/api/bots.delete', {
    method: 'POST',
    body: { id: record.id, deleteWorkspace: true },
  });
  assert.deepEqual(payload.error, {
    code: 'BOT_WORKSPACE_OUTSIDE_ROOT',
    message: 'Refusing to delete workspace outside bits root',
  });
  assert.equal(app.bits.records.length, 1, 'refused deletion keeps the record');
});

// ---------------------------------------------------------------------------
// /api/bots.catalog and /api/bots.avatar
// ---------------------------------------------------------------------------

await test('catalog returns the v2 bits with model/effort/isOrchestrator and avatar URLs', async () => {
  const app = setup({ catalog: makeCatalog() });
  const payload = await callJson(app.routes, '/api/bots.catalog');
  assert.equal(payload.ok, true);
  assert.equal(payload.version, 2);
  assert.deepEqual(payload.groups, [
    { id: 'workers', label: { pt: 'Workers', en: 'Workers' } },
    { id: 'management', label: { pt: 'Gestão', en: 'Management' } },
  ]);
  assert.equal(payload.bits.length, 2);
  const scout = payload.bits.find((bit) => bit.id === 'bit-scout');
  assert.deepEqual(scout, {
    ...SCOUT,
    avatar: '/api/bots.avatar?id=bit-scout',
  });
  assert.equal(scout.isOrchestrator, false);
  assert.equal(scout.model, 'subscription/haiku');
  assert.equal(scout.effort, 'low');
  const coordinator = payload.bits.find((bit) => bit.id === 'bit-coordinator');
  assert.equal(coordinator.isOrchestrator, true);
  assert.equal(coordinator.model, 'deepseek-account/deepseek-flash');
  assert.equal(coordinator.effort, 'max');
  assert.equal(payload.error, null);
});

await test('catalog degrades without a catalog dependency', async () => {
  const app = setup({ catalog: null });
  const payload = await callJson(app.routes, '/api/bots.catalog');
  assert.equal(payload.ok, true);
  assert.equal(payload.version, 2);
  assert.deepEqual(payload.groups, []);
  assert.deepEqual(payload.bits, []);
  assert.equal(payload.error, 'catalog unavailable');
});

await test('avatar serves the catalog bytes and 404s unknown ids', async () => {
  const app = setup({ catalog: makeCatalog() });
  const ok = await call(app.routes, '/api/bots.avatar?id=bit-scout');
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'image/webp');
  assert.match(ok.headers.get('x-content-type-options') ?? '', /nosniff/);
  assert.match(ok.headers.get('cache-control') ?? '', /max-age/);
  assert.equal(Buffer.from(await ok.arrayBuffer()).toString('latin1'), 'RIFF0000WEBPdata');

  for (const query of ['?id=bit-nope', '?id=', '']) {
    const missing = await call(app.routes, `/api/bots.avatar${query}`);
    assert.equal(missing.status, 404, `404 for "${query}"`);
  }

  const noCatalog = setup({ catalog: null });
  assert.equal((await call(noCatalog.routes, '/api/bots.avatar?id=bit-scout')).status, 404);
});

// ---------------------------------------------------------------------------
// /api/bots.models
// ---------------------------------------------------------------------------

await test('models returns the runtime model list and forwards the abort signal', async () => {
  const app = setup();
  const payload = await callJson(app.routes, '/api/bots.models');
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.models, MODEL_OPTIONS);
  assert.equal(app.runtime.listModelsCalls.length, 1);
  assert.ok(app.runtime.listModelsCalls[0].signal instanceof AbortSignal, 'route forwards the request signal');
});

await test('models passes coded runtime errors through and maps uncoded errors to INTERNAL', async () => {
  const app = setup();
  app.runtime.listModelsError = coded('BIT_MODEL_INVALID', 'Unknown model');
  let payload = await callJson(app.routes, '/api/bots.models');
  assert.deepEqual(payload.error, { code: 'BIT_MODEL_INVALID', message: 'Unknown model' });

  app.runtime.listModelsError = new Error('llm exploded');
  payload = await callJson(app.routes, '/api/bots.models');
  assert.deepEqual(payload, { ok: false, error: { code: 'INTERNAL', message: 'Internal server error' } });
  assert.ok(app.logs.some((line) => line.includes('llm exploded')));
});

await test('models rejects a malformed runtime payload as INTERNAL', async () => {
  const app = setup();
  app.runtime.listModels = async () => ({ nope: true });
  const payload = await callJson(app.routes, '/api/bots.models');
  assert.equal(payload.error.code, 'INTERNAL');
});

await test('models and run report BIT_RUNTIME_UNAVAILABLE without a runtime', async () => {
  const app = setup({ runtime: null });
  let payload = await callJson(app.routes, '/api/bots.models');
  assert.equal(payload.error.code, 'BIT_RUNTIME_UNAVAILABLE');

  payload = await callJson(app.routes, '/api/bots.run', {
    method: 'POST',
    body: { id: 'a1b2c3d4e5', request: 'tarefa' },
  });
  assert.equal(payload.error.code, 'BOT_NOT_FOUND', 'validation still runs before the runtime check');

  const withRecord = setup({ runtime: null, records: [makeRecord()] });
  payload = await callJson(withRecord.routes, '/api/bots.run', {
    method: 'POST',
    body: { id: 'a1b2c3d4e5', request: 'tarefa' },
  });
  assert.equal(payload.error.code, 'BIT_RUNTIME_UNAVAILABLE');
});

// ---------------------------------------------------------------------------
// /api/bots.run
// ---------------------------------------------------------------------------

await test('run invokes a worker bit with the defaults (readOnly true, bit workspace as cwd)', async () => {
  const record = makeRecord();
  const app = setup({ records: [record] });
  const payload = await callJson(app.routes, '/api/bots.run', {
    method: 'POST',
    body: { id: record.id, request: '  implemente a feature  ' },
  });

  assert.equal(payload.ok, true);
  assert.equal(payload.response, 'resposta do bit');
  assert.deepEqual(payload.meta, {
    backend: 'claude-code',
    model: 'subscription/sonnet',
    effort: 'high',
    durationMs: 7,
  });

  assert.equal(app.runtime.runCalls.length, 1);
  const runCall = app.runtime.runCalls[0];
  assert.deepEqual(runCall.bit, record, 'the bit record is forwarded');
  assert.equal(runCall.request, '  implemente a feature  ', 'the request text is preserved');
  assert.equal(runCall.readOnly, true, 'ad-hoc runs default to read-only');
  assert.equal(runCall.cwd, record.workspaceDir, 'cwd defaults to the bit workspace');
  assert.ok(app.runtime.runSignals[0] instanceof AbortSignal, 'an AbortSignal is passed to the runtime');
  assert.equal(app.runtime.runSignals[0].aborted, false);
  assert.equal(app.bits.calls.some((entry) => entry[0] === 'ensureWorkspace'), true, 'workspace is ensured first');
});

await test('run forwards readOnly: false', async () => {
  const record = makeRecord();
  const app = setup({ records: [record] });
  const payload = await callJson(app.routes, '/api/bots.run', {
    method: 'POST',
    body: { id: record.id, request: 'tarefa', readOnly: false },
  });
  assert.equal(payload.ok, true);
  assert.equal(app.runtime.runCalls[0].readOnly, false);
});

await test('run refuses orchestrator bits without invoking the runtime', async () => {
  const record = makeRecord({ isOrchestrator: true, model: 'deepseek-account/deepseek-flash', effort: 'max' });
  const app = setup({ records: [record] });
  const payload = await callJson(app.routes, '/api/bots.run', {
    method: 'POST',
    body: { id: record.id, request: 'tarefa' },
  });
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, 'BIT_IS_ORCHESTRATOR');
  assert.equal(payload.error.message, 'Orquestradores executam em fluxos');
  assert.deepEqual(app.runtime.runCalls, [], 'the runtime is not called');
  assert.equal(app.bits.calls.some((entry) => entry[0] === 'ensureWorkspace'), false);
});

await test('run validates its body before invoking the runtime', async () => {
  const record = makeRecord();
  const app = setup({ records: [record] });
  const cases = [
    [{ id: record.id }, 'BAD_REQUEST'],
    [{ id: record.id, request: '' }, 'BAD_REQUEST'],
    [{ id: record.id, request: '   ' }, 'BAD_REQUEST'],
    [{ id: record.id, request: 42 }, 'BAD_REQUEST'],
    [{ id: record.id, request: 'x'.repeat(20001) }, 'BAD_REQUEST'],
    [{ id: record.id, request: 'ok', readOnly: 'yes' }, 'BAD_REQUEST'],
    [{ request: 'ok' }, 'BAD_REQUEST'],
    [{ id: 'ffffffffff', request: 'ok' }, 'BOT_NOT_FOUND'],
    [{ id: record.id, request: '' }, 'BAD_REQUEST'],
  ];
  for (const [body, code] of cases) {
    const payload = await callJson(app.routes, '/api/bots.run', { method: 'POST', body });
    assert.equal(payload.ok, false, JSON.stringify(body));
    assert.equal(payload.error.code, code, JSON.stringify(body));
  }
  assert.deepEqual(app.runtime.runCalls, [], 'invalid requests never reach the runtime');
});

await test('run passes coded runtime errors through verbatim', async () => {
  const record = makeRecord();
  for (const code of ['BIT_MODEL_INVALID', 'BIT_RUN_FAILED', 'BIT_DELEGATE_UNAVAILABLE']) {
    const app = setup({ records: [record] });
    app.runtime.runError = coded(code, `failure from ${code}`);
    const payload = await callJson(app.routes, '/api/bots.run', {
      method: 'POST',
      body: { id: record.id, request: 'tarefa' },
    });
    assert.deepEqual(payload.error, { code, message: `failure from ${code}` }, code);
  }
});

await test('run maps an uncoded runtime failure to BIT_RUN_FAILED', async () => {
  const record = makeRecord();
  const app = setup({ records: [record] });
  app.runtime.runError = new Error('delegate exploded');
  const payload = await callJson(app.routes, '/api/bots.run', {
    method: 'POST',
    body: { id: record.id, request: 'tarefa' },
  });
  assert.deepEqual(payload.error, { code: 'BIT_RUN_FAILED', message: 'delegate exploded' });
});

await test('run tolerates a plain-text runtime result and rejects a malformed one', async () => {
  const record = makeRecord();
  const app = setup({ records: [record] });
  app.runtime.runImpl = async () => 'texto simples';
  let payload = await callJson(app.routes, '/api/bots.run', {
    method: 'POST',
    body: { id: record.id, request: 'tarefa' },
  });
  assert.deepEqual(payload.response, 'texto simples');
  assert.deepEqual(payload.meta, {});

  app.runtime.runImpl = async () => ({ meta: {} });
  payload = await callJson(app.routes, '/api/bots.run', {
    method: 'POST',
    body: { id: record.id, request: 'tarefa' },
  });
  assert.equal(payload.error.code, 'BIT_RUN_FAILED');
  assert.match(payload.error.message, /invalid response/);
});

await test('run enforces a configurable route-level timeout and aborts the signal', async () => {
  const record = makeRecord();
  const app = setup({ records: [record], runTimeoutMs: 80 });
  app.runtime.runImpl = () => new Promise(() => {});
  const startedAt = Date.now();
  const payload = await callJson(app.routes, '/api/bots.run', {
    method: 'POST',
    body: { id: record.id, request: 'demorada' },
  });
  const elapsed = Date.now() - startedAt;
  assert.equal(payload.error.code, 'BIT_RUN_TIMEOUT');
  assert.ok(elapsed >= 60, `waited for the timeout (took ${elapsed}ms)`);
  assert.ok(elapsed < 5000, `stayed bounded (took ${elapsed}ms)`);
  assert.equal(app.runtime.runSignals[0].aborted, true, 'the runtime signal is aborted on timeout');
});

await test('run forwards a transport abort to the runtime', async () => {
  const record = makeRecord();
  const app = setup({ records: [record] });
  app.runtime.runImpl = (params) =>
    new Promise((_resolve, reject) => {
      params.signal.addEventListener('abort', () => reject(new Error('cancelada pelo cliente')));
    });
  const controller = new AbortController();
  const pending = callJson(app.routes, '/api/bots.run', {
    method: 'POST',
    body: { id: record.id, request: 'tarefa' },
    signal: controller.signal,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort();
  const payload = await pending;
  assert.equal(payload.error.code, 'BIT_RUN_FAILED', 'an aborted run is reported as a failed run');
  assert.equal(payload.error.message, 'cancelada pelo cliente');
  assert.equal(app.runtime.runSignals[0].aborted, true);
});

await test('run survives a failed workspace ensure (logged only)', async () => {
  const record = makeRecord();
  const app = setup({ records: [record] });
  app.bits.ensureWorkspaceError = new Error('mkdir denied');
  const payload = await callJson(app.routes, '/api/bots.run', {
    method: 'POST',
    body: { id: record.id, request: 'tarefa' },
  });
  assert.equal(payload.ok, true, 'the invocation is not failed by mkdir');
  assert.ok(app.logs.some((line) => line.includes('mkdir denied')));
});

// ---------------------------------------------------------------------------
// Readiness gating and logging safety
// ---------------------------------------------------------------------------

await test('every handler awaits deps.ready before touching the bits store', async () => {
  let releaseReady;
  const ready = new Promise((resolve) => {
    releaseReady = resolve;
  });
  const record = makeRecord();
  const app = setup({ records: [record], ready });
  let settled = false;
  const pending = callJson(app.routes, '/api/bots.list').then((payload) => {
    settled = true;
    return payload;
  });

  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(settled, false, 'handler waits for ready');
  assert.deepEqual(app.bits.calls, [], 'store is untouched before ready');
  releaseReady();
  const payload = await pending;
  assert.equal(payload.ok, true);
  assert.equal(app.bits.calls.length > 0, true);
});

await test('a rejected ready gate produces INTERNAL instead of crashing the route', async () => {
  const app = setup({ ready: Promise.reject(new Error('store init failed')) });
  const payload = await callJson(app.routes, '/api/bots.list');
  assert.deepEqual(payload, { ok: false, error: { code: 'INTERNAL', message: 'Internal server error' } });
  assert.ok(app.logs.some((line) => line.includes('store init failed')));
});

await test('a throwing logger cannot break an INTERNAL response', async () => {
  const app = setup({ records: [makeRecord()] });
  app.deps.log = () => {
    throw new Error('logger exploded');
  };
  app.bits.listError = new Error('store exploded');
  const payload = await callJson(app.routes, '/api/bots.list');
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
