import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createRpcSettings, probeRpc, validateRpcUrl, DEFAULT_RPC_URL } from '../src/rpc-settings.mjs';
import { createRpcRuntime } from '../src/rpc-runtime.mjs';
import { createHttpServer } from '../src/server.mjs';
import { createDemo } from '../src/demo.mjs';
import { createTradeService } from '../src/trades.mjs';

async function temp(t) {
  const directory = await mkdtemp(join(tmpdir(), 'agetra-rpc-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, 'rpc-settings.json');
}
const check = { chainId: 56, blockNumber: 123456, latencyMs: 25, logsSupported: true };
const secretUrl = 'https://nodes.example/v1/secret-path-key?apikey=secret-query-key';

function rpcFetch({ chain = '0x38', logs = [], error } = {}) {
  const methods = [];
  return { methods, fetchImpl: async (_url, options) => {
    const request = JSON.parse(options.body); methods.push(request.method);
    return Response.json({ jsonrpc: '2.0', id: request.id, ...(error ? { error } : { result: request.method === 'eth_chainId' ? chain : request.method === 'eth_blockNumber' ? '0x1e240' : logs }) });
  } };
}

test('connection test verifies BSC, a fresh block and logs using only read methods', async () => {
  const mock = rpcFetch();
  const result = await probeRpc(secretUrl, mock);
  assert.equal(result.chainId, 56); assert.equal(result.blockNumber, 123456); assert.equal(result.logsSupported, true);
  assert.deepEqual(mock.methods, ['eth_chainId', 'eth_blockNumber', 'eth_getLogs']);
  const wrongChain = rpcFetch({ chain: '0x1' });
  await assert.rejects(probeRpc(secretUrl, wrongChain), /Chain ID 56/);
  assert.deepEqual(wrongChain.methods, ['eth_chainId']);
  await assert.rejects(probeRpc(secretUrl, rpcFetch({ logs: null })), /日志/);
});

test('transport errors, RPC errors and oversized bodies cannot disclose a paid node key', async () => {
  for (const fetchImpl of [
    async () => { throw new Error(`fetch failed ${secretUrl}`); },
    rpcFetch({ error: { message: secretUrl } }).fetchImpl,
    async () => new Response('x'.repeat(140 * 1024)),
  ]) {
    await assert.rejects(probeRpc(secretUrl, { fetchImpl }), error => !error.message.includes('secret-'));
  }
  await assert.rejects(probeRpc(secretUrl, { timeoutMs: 10, fetchImpl: async (_url, { signal }) => {
    await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } }), /超时/);
});

test('custom configuration survives restart, masks keys and can restore the default over env', async t => {
  const file = await temp(t);
  let applied;
  const settings = await createRpcSettings({ file, envUrl: 'https://env.example/key', probe: async () => check, onApply: async (url, persist) => { applied = url; await persist(); } });
  await settings.test({ mode: 'custom', url: secretUrl });
  await assert.rejects(readFile(file), { code: 'ENOENT' });
  await settings.apply({ mode: 'custom', url: secretUrl });
  assert.equal(applied, secretUrl);
  assert.equal(JSON.parse(await readFile(file)).url, secretUrl);
  assert.ok(!JSON.stringify(settings.snapshot()).includes('secret-'));
  assert.match(settings.snapshot().displayUrl, /nodes\.example/);
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
  const restarted = await createRpcSettings({ file, probe: async () => check });
  assert.equal(restarted.getUrl(), secretUrl);
  await restarted.apply({ mode: 'custom', url: '' });
  assert.equal(restarted.getUrl(), secretUrl);
  await restarted.apply({ mode: 'default' });
  assert.equal((await createRpcSettings({ file, envUrl: 'https://env.example/key' })).getUrl(), DEFAULT_RPC_URL);
});

test('failed checks and failed activation preserve the previous saved node', async t => {
  const file = await temp(t);
  const settings = await createRpcSettings({ file, probe: async () => check });
  await settings.apply({ mode: 'custom', url: secretUrl });
  const before = await readFile(file, 'utf8');
  const broken = await createRpcSettings({ file, probe: async () => { throw new Error('节点不支持日志读取'); } });
  await assert.rejects(broken.apply({ mode: 'default' }), /日志/);
  assert.equal(await readFile(file, 'utf8'), before);
  const activation = await createRpcSettings({ file, probe: async () => check, onApply: async (_url, persist) => { await persist(); throw new Error('activation failed'); } });
  await assert.rejects(activation.apply({ mode: 'default' }), /未应用/);
  assert.equal(await readFile(file, 'utf8'), before);
  assert.equal(activation.getUrl(), secretUrl);
  for (const value of ['http://nodes.example', 'file:///etc/passwd', 'https://user:password@nodes.example', 'https://nodes.example/#secret']) assert.throws(() => validateRpcUrl(value));
});

test('live runtime switches both facades after validation, persistence and draining the old monitor', async () => {
  const events = [];
  const makeProtocol = ({ rpcUrl }) => ({
    provider: { url: rpcUrl, destroy: () => events.push(`destroy:${rpcUrl}`) },
    initialize: async () => { events.push(`validate:${rpcUrl}`); if (rpcUrl === 'bad') throw new Error('bad'); },
    positions: async () => rpcUrl,
  });
  const runtime = createRpcRuntime({ rpcUrl: 'old', createProtocol: makeProtocol, createMonitor: ({ protocol }) => ({
    snapshot: () => protocol.provider.url,
    start: async () => events.push(`start:${protocol.provider.url}`),
    stop: async () => events.push(`stop:${protocol.provider.url}`),
  }) });
  const oldRead = runtime.protocol.positions;
  await assert.rejects(runtime.apply('bad', async () => assert.fail('must not save')));
  assert.equal(runtime.monitor.snapshot(), 'old');
  await runtime.apply('new', async () => { assert.equal(runtime.protocol.provider.url, 'old'); events.push('persist'); });
  assert.equal(runtime.monitor.snapshot(), 'new');
  assert.equal(await runtime.protocol.positions(), 'new');
  assert.equal(await oldRead(), 'old');
  assert.ok(events.indexOf('persist') < events.indexOf('stop:old'));
  assert.ok(events.indexOf('stop:old') < events.indexOf('destroy:old'));
  const stalled = createRpcRuntime({ rpcUrl: 'old', validationTimeoutMs: 10, createProtocol: ({ rpcUrl }) => ({
    provider: { url: rpcUrl, destroy() {} }, initialize: () => new Promise(() => {}),
  }), createMonitor: () => ({ stop() {}, start() {} }) });
  await assert.rejects(stalled.apply('slow', async () => assert.fail('must not persist a timed out node')), /未应用/);
  assert.equal(stalled.protocol.provider.url, 'old');
});

test('RPC HTTP writes require CSRF, block unfinished orders and serialize changes against trading', async t => {
  const file = await temp(t);
  let release, began, probing = 0;
  const ready = new Promise(resolve => { began = resolve; });
  const rpcSettings = await createRpcSettings({ file, probe: async () => { probing++; return check; }, onApply: async (_url, persist) => { began(); await new Promise(resolve => { release = resolve; }); await persist(); } });
  const deps = createDemo();
  const realTrades = createTradeService({ ...deps, demo: true });
  let unfinished = true;
  const trades = { ...realTrades, list: () => unfinished ? [{ status: 'UNKNOWN' }] : realTrades.list() };
  const server = createHttpServer({ ...deps, trades, rpcSettings, demo: true });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const session = await (await fetch(`${base}/api/session`)).json();
  const headers = { Origin: base, 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf };
  const post = (path, body, extra = {}) => fetch(`${base}${path}`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  assert.equal((await post('/api/settings/rpc', { mode: 'default' }, { 'X-CSRF-Token': '' })).status, 403);
  assert.equal((await post('/api/settings/rpc', { mode: 'default' })).status, 409); assert.equal(probing, 0);
  unfinished = false;
  const preview = await realTrades.preview({ token: deps.monitor.snapshot().tokens[0].address, side: 'buy', amount: '0.01', slippageBps: 100 });
  const applying = post('/api/settings/rpc', { mode: 'custom', url: secretUrl }); await ready;
  assert.equal((await post('/api/execute', { previewId: preview.id, confirmed: true })).status, 409);
  assert.equal((await post('/api/settings/rpc', { mode: 'default' })).status, 409);
  release(); assert.equal((await applying).status, 200);
  const result = await (await fetch(`${base}/api/settings/rpc`)).json();
  assert.equal(result.mode, 'custom'); assert.ok(!JSON.stringify(result).includes('secret-'));
  await assert.rejects(realTrades.execute({ previewId: preview.id, confirmed: true }), /过期/);
});
