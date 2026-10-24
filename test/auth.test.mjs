import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthService } from '../src/auth.mjs';
import { createBaw } from '../src/baw.mjs';

const response = { urlForWeb: 'https://web3.binance.com/en/agent-login?url=exact%2Bvalue', qrCodeId: 'qr-123', pairingCode: '001234', expireAt: String(Date.now() + 300000) };
const tick = () => new Promise(resolve => setImmediate(resolve));

test('认证去重，原样显示配对信息，verify完成后仍以wallet status为准', async () => {
  let finish, starts = 0, changed = 0;
  const baw = { authStart: async () => { starts++; return response; }, authVerify: () => new Promise(resolve => { finish = resolve; }), status: async () => ({ status: 'CONNECTED' }) };
  const auth = createAuthService({ baw, onConnected: () => changed++ });
  const [a, b] = await Promise.all([auth.start(), auth.start()]);
  assert.equal(starts, 1); assert.equal(a.urlForWeb, response.urlForWeb); assert.equal(b.pairingCode, '001234');
  finish({ status: 'SUCCESS' }); await tick();
  assert.equal(auth.snapshot().status, 'CONNECTED');
  assert.equal(auth.snapshot().pairingCode, undefined); assert.equal(changed, 1);
});

test('App成功但本地仍未连接，不宣告已登录；失败后移除配对信息', async () => {
  const baw = { authStart: async () => response, authVerify: async () => ({ status: 'SUCCESS' }), status: async () => ({ status: 'UNCONNECTED' }) };
  const auth = createAuthService({ baw }); await auth.start(); await tick();
  assert.equal(auth.snapshot().status, 'ERROR'); assert.equal(auth.snapshot().urlForWeb, undefined);
});

test('配对码过期但verify仍收尾时继续报告待验证，最终成功仍可观察', async () => {
  let now = Date.now(), finish;
  const auth = createAuthService({ now: () => now, baw: {
    authStart: async () => ({ ...response, expireAt: String(now + 100) }),
    authVerify: () => new Promise(resolve => { finish = resolve; }),
    status: async () => ({ status: 'CONNECTED' }),
  } });
  await auth.start(); now += 101;
  assert.equal(auth.snapshot().status, 'EXPIRED');
  assert.equal(auth.snapshot().pendingVerification, true);
  assert.equal(auth.snapshot().pairingCode, undefined);
  finish({ status: 'SUCCESS' }); await tick();
  assert.equal(auth.snapshot().status, 'CONNECTED');
});

test('认证CLI仅接受官方HTTPS链接且verify有完整5分钟生命周期', async () => {
  const calls = [];
  let data = response;
  const baw = createBaw({ binary: 'baw', run: async (_, args, options) => { calls.push({ args, options }); return { stdout: JSON.stringify({ success: true, data }) }; } });
  assert.equal((await baw.authStart()).pairingCode, '001234');
  data = { status: 'SUCCESS' }; await baw.authVerify('qr-123');
  assert.deepEqual(calls.at(-1).args, ['auth', 'verify', '--qrCodeId', 'qr-123', '--json']);
  assert.ok(calls.at(-1).options.timeout >= 300000);
  for (const urlForWeb of ['https://binance.com.evil.example/login', 'http://web3.binance.com/login', 'https://user@web3.binance.com/login']) {
    data = { ...response, urlForWeb }; await assert.rejects(baw.authStart());
  }
  await assert.rejects(baw.authVerify('--yes'));
});
