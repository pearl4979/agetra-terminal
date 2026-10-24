import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpServer } from '../src/server.mjs';
import { createTradeService } from '../src/trades.mjs';
import { createDemo } from '../src/demo.mjs';

test('完整演示HTTP流程，跨站失败，确认后仅产生无hash的演示订单', async t => {
  const deps = createDemo();
  const trades = createTradeService({ ...deps, demo: true });
  const server = createHttpServer({ ...deps, trades, demo: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/session`, { headers: { Origin: 'https://evil.example' } })).status, 403);
  const session = await (await fetch(`${base}/api/session`)).json();
  assert.equal(session.mode, 'demo');
  const tokens = await (await fetch(`${base}/api/tokens`)).json();
  const headers = { Origin: base, 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf };
  const preview = await (await fetch(`${base}/api/preview`, { method: 'POST', headers, body: JSON.stringify({ token: tokens.tokens[0].address, side: 'buy', amount: '0.01', slippageBps: 100 }) })).json();
  assert.equal(preview.demo, true);
  assert.equal(preview.transaction.value, '10000000000000000');
  const execute = await (await fetch(`${base}/api/execute`, { method: 'POST', headers, body: JSON.stringify({ previewId: preview.id, confirmed: true }) })).json();
  assert.equal(execute.status, 'DEMO_COMPLETED');
  assert.equal(execute.txHash, null);
  assert.equal((await fetch(`${base}/api/execute`, { method: 'POST', headers: { ...headers, 'X-CSRF-Token': '' }, body: '{}' })).status, 403);
});
