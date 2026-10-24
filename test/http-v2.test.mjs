import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpServer } from '../src/server.mjs';
import { createDemo } from '../src/demo.mjs';
import { createTradeService } from '../src/trades.mjs';

async function harness(t, extra = {}) {
  const deps = createDemo();
  const trades = createTradeService({ ...deps, demo: true });
  const server = createHttpServer({ ...deps, trades, demo: true, ...extra });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const session = await (await fetch(`${base}/api/session`)).json();
  const headers = { Origin: base, 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf };
  return { base, headers, session, post: (path, body) => fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) }) };
}

test('像素版本返回真实边界和原始持仓，不接受任意图片CA', async t => {
  let imageCalls = 0;
  const h = await harness(t, { metadata: { getImage: async () => { imageCalls++; return { body: Buffer.from('image'), contentType: 'image/png' }; } } });
  assert.equal(h.session.mev.status, 'unverified');
  const positions = await (await fetch(`${h.base}/api/positions?token=0x0000000000000000000000000000000000000001`)).json();
  assert.equal(positions.decimals, 18); assert.match(positions.balance, /^\d+$/);
  assert.equal((await fetch(`${h.base}/api/token-image/0x1111111111111111111111111111111111111111`)).status, 404);
  assert.equal(imageCalls, 0);
});

test('实盘开关必须连接并开启有效Developer Mode；关闭可立即生效', async t => {
  const deps = createDemo();
  const trades = createTradeService({ ...deps });
  const h = await harness(t, { demo: false, trades, baw: { wallet: async () => ({ status: 'UNCONNECTED' }) } });
  assert.equal((await h.post('/api/settings/execution', { enabled: true })).status, 400);
  assert.equal(trades.isLiveExecution(), false);
  assert.equal((await h.post('/api/settings/execution', { enabled: false })).status, 200);
});

test('关闭请求不能被早先仍等待钱包检查的开启请求覆盖', async t => {
  const deps = createDemo(); const trades = createTradeService({ ...deps });
  let finish, began;
  const ready = new Promise(resolve => { began = resolve; });
  const h = await harness(t, { demo: false, trades, baw: { wallet: () => new Promise(resolve => { finish = resolve; began(); }) } });
  const enabling = h.post('/api/settings/execution', { enabled: true }); await ready;
  await h.post('/api/settings/execution', { enabled: false });
  finish({ status: 'CONNECTED', address: '0x1111111111111111111111111111111111111111', devMode: { enabled: true, expiresAt: '2099-01-01' } });
  assert.equal((await enabling).status, 400); assert.equal(trades.isLiveExecution(), false);
});

test('刷新钱包不会复用旧查询，晚返回的旧结果不能覆盖新缓存', async t => {
  let release, began, calls = 0;
  const ready = new Promise(resolve => { began = resolve; });
  const baw = { wallet: async () => {
    calls++;
    if (calls === 1) return new Promise(resolve => { release = resolve; began(); });
    return { status: 'CONNECTED', address: '0x1111111111111111111111111111111111111111' };
  } };
  const h = await harness(t, { demo: false, baw });
  const old = fetch(`${h.base}/api/wallet`); await ready;
  const fresh = await (await fetch(`${h.base}/api/wallet?refresh=1`)).json();
  assert.equal(fresh.status, 'CONNECTED');
  release({ status: 'UNCONNECTED' }); await old;
  const cached = await (await fetch(`${h.base}/api/wallet`)).json();
  assert.equal(cached.status, 'CONNECTED'); assert.equal(calls, 2);
});
