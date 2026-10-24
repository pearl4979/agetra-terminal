import test from 'node:test';
import assert from 'node:assert/strict';
import { guardRequest } from '../src/security.mjs';
import { createTradeService } from '../src/trades.mjs';

const walletAddress = '0x1111111111111111111111111111111111111111';
const token = '0x2222222222222222222222222222222222222222';
const input = { token, side: 'buy', amount: '0.01', slippageBps: 100 };
function setup(overrides = {}) {
  let calls = 0;
  const protocol = { buildTrade: async () => ({ transaction: { from: walletAddress, to: token, value: '10000000000000000', data: '0x12345678' }, summary: {}, kind: 'buy' }) };
  const baw = {
    wallet: async () => ({ available: true, address: walletAddress }),
    preview: async () => ({ requestId: 'upstream-id', expiresAt: 900000, parsedTx: {}, risks: {}, simulationResult: {} }),
    execute: async () => { calls++; return { status: 'PENDING_CONFIRMATION', orderId: 'remote-1', txHash: null }; },
    ...overrides.baw,
  };
  const service = createTradeService({ protocol, baw, liveExecution: true, now: () => 1000, ...overrides, baw });
  return { service, count: () => calls };
}

test('跨站请求即使拥有 nonce 也无法调用本地钱包', () => {
  const headers = { host: '127.0.0.1:4318', origin: 'https://evil.example', 'x-csrf-token': 'secret' };
  assert.throws(() => guardRequest({ method: 'POST', headers }, { port: 4318, csrf: 'secret' }), /Origin/);
  assert.throws(() => guardRequest({ method: 'GET', headers: { host: 'evil.example:4318' } }, { port: 4318, csrf: 'secret' }), /Host/);
  headers.origin = 'http://127.0.0.1:4318';
  assert.doesNotThrow(() => guardRequest({ method: 'POST', headers }, { port: 4318, csrf: 'secret' }));
  delete headers['x-csrf-token'];
  assert.throws(() => guardRequest({ method: 'POST', headers }, { port: 4318, csrf: 'secret' }), /CSRF/);
});

test('执行必须确认，并拒绝已过期预览', async () => {
  let clock = 1000;
  const { service, count } = setup({ now: () => clock });
  const p = await service.preview(input);
  await assert.rejects(service.execute({ previewId: p.id, confirmed: false }), /确认/);
  clock = p.expiresAt + 1;
  await assert.rejects(service.execute({ previewId: p.id, confirmed: true }), /过期/);
  assert.equal(count(), 0);
});

test('同一个预览并发双击最多执行一次，待确认订单阻止重复下单', async () => {
  const { service, count } = setup();
  const p = await service.preview(input);
  const [a, b] = await Promise.all([service.execute({ previewId: p.id, confirmed: true }), service.execute({ previewId: p.id, confirmed: true })]);
  assert.equal(a.id, b.id);
  assert.equal(count(), 1);
  const p2 = await service.preview(input);
  await assert.rejects(service.execute({ previewId: p2.id, confirmed: true }), /未完成/);
});

test('执行超时保留未知状态，不自动重发', async () => {
  let calls = 0;
  const { service } = setup({ baw: { execute: async () => { calls++; throw new Error('timeout'); } } });
  const p = await service.preview(input);
  const result = await service.execute({ previewId: p.id, confirmed: true });
  assert.equal(result.status, 'UNKNOWN');
  assert.match(result.error, /timeout/);
  await service.execute({ previewId: p.id, confirmed: true });
  assert.equal(calls, 1);
});

test('预览后钱包更换，禁止向旧账户提交', async () => {
  let addr = walletAddress;
  const { service, count } = setup({ baw: { wallet: async () => ({ available: true, address: addr }) } });
  const p = await service.preview(input);
  addr = token;
  await assert.rejects(service.execute({ previewId: p.id, confirmed: true }), /钱包/);
  assert.equal(count(), 0);
});

test('普通启动默认不允许执行真实交易', async () => {
  const { service, count } = setup({ liveExecution: false });
  const p = await service.preview(input);
  await assert.rejects(service.execute({ previewId: p.id, confirmed: true }), /ENABLE_LIVE_TRADING/);
  assert.equal(count(), 0);
});

test('客户端不能注入任意 calldata 或 CLI 参数', async () => {
  const { service } = setup();
  await assert.rejects(service.preview({ ...input, data: '0xdeadbeef' }), /字段/);
  await assert.rejects(service.preview({ ...input, amount: '1e-3' }), /金额/);
  await assert.rejects(service.preview({ ...input, slippageBps: 10000 }), /滑点/);
});
