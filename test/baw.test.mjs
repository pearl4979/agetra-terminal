import test from 'node:test';
import assert from 'node:assert/strict';
import { createBaw } from '../src/baw.mjs';

const ACCOUNT = '0x1111111111111111111111111111111111111111';
const TARGET = '0x2222222222222222222222222222222222222222';
const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const TX = { from: ACCOUNT, to: TARGET, value: '100000000000000001', data: '0x12345678' };
const ok = data => ({ stdout: JSON.stringify({ success: true, data }), stderr: '' });
const fixtures = () => ({
  'wallet status': { status: 'CONNECTED' },
  'wallet address': { addresses: [{ binanceChainId: '56', chainName: 'BSC', address: ACCOUNT }] },
  'wallet balance': [{ symbol: 'BNB', address: NATIVE, binanceChainId: '56', balance: '1.000000000000000001', price: '600', value: '600' }],
  'wallet left-quota': { quotaUsed: 10, quotaLeft: 90, dailyLimit: 100, date: '2026-10-24' },
  'wallet settings': { devMode: { enabled: true, expiresAt: '2099-01-01T00:00:00+08:00', dailyLimit: 100, balanceExceeded: false }, developerModeQuotaUsed: 12, developerModeQuotaDate: '2026-10-24' },
  'wallet tx-lock': { status: 'UNLOCKED' },
  'contract-call preview': { requestId: 'preview-123', parsedTx: { transactionType: 'ContractInteraction' }, simulationResult: { simulationCode: '000000000', authorityChanges: [{ account: ACCOUNT, authority: TARGET }], balanceChanges: [] }, risks: { riskDetails: [{ code: 'CAUTION_1', title: 'Custom contract', description: 'Review this call', riskType: 'CAUTION' }], addresses: {} }, requireConfirmation: true, expiresAt: 4070880000000 },
  'contract-call execute': { orderId: 'order-123', status: 'PENDING_CONFIRMATION', txHash: null, message: 'Please confirm in the Binance App' },
});

function harness(overrides = {}) {
  const data = { ...fixtures(), ...overrides };
  const calls = [];
  const baw = createBaw({ binary: '/trusted path/baw', run: async (binary, args, options) => {
    calls.push({ binary, args, options });
    const value = data[args.slice(0, 2).join(' ')];
    if (value instanceof Error) throw value;
    if (typeof value === 'function') return value();
    return ok(value);
  } });
  return { baw, calls, data };
}

test('maps BSC account, exact native balance, independent quota and Developer Mode', async () => {
  const { baw, calls } = harness();
  const result = await baw.wallet();
  assert.equal(result.available, true);
  assert.equal(result.status, 'CONNECTED');
  assert.equal(result.address, ACCOUNT);
  assert.equal(result.balance, '1.000000000000000001');
  assert.deepEqual(result.quota, { quotaUsed: 10, quotaLeft: 90, dailyLimit: 100, date: '2026-10-24' });
  assert.equal(result.devMode.expiresAt, '2099-01-01T00:00:00+08:00');
  assert.equal(result.devMode.quotaUsed, 12);
  assert.equal(result.devMode.quotaDate, '2026-10-24');
  assert.equal(Object.hasOwn(result.raw.settings.devMode, 'quotaUsed'), false);
  assert.equal(result.raw.settings.developerModeQuotaUsed, 12);
  assert.ok(calls.every(call => call.options.shell === false && call.args.at(-1) === '--json'));
});

test('hidden BNB balance and a failed quota query stay unknown instead of zero', async () => {
  const error = Object.assign(new Error('exit'), { code: 1, stdout: JSON.stringify({ success: false, error: { code: 351999, name: 'QUOTA_UNAVAILABLE', message: 'Quota lookup unavailable', data: { retry: true } } }) });
  const { baw } = harness({ 'wallet balance': [], 'wallet left-quota': error });
  const result = await baw.wallet();
  assert.equal(result.balance, null);
  assert.equal(result.quota, null);
  assert.equal(result.address, ACCOUNT);
  assert.equal(result.error, 'Quota lookup unavailable');
  assert.equal(result.errors.quota.code, 351999);
  assert.deepEqual(result.errors.quota.data, { retry: true });
});

test('token symbol alone cannot impersonate native BNB', async () => {
  const { baw } = harness({ 'wallet balance': [{ symbol: 'BNB', address: TARGET, binanceChainId: '56', balance: '99' }] });
  assert.equal((await baw.wallet()).balance, null);
});

test('numeric BSC chain IDs map to the same wallet and native asset', async () => {
  const { baw } = harness({
    'wallet address': { addresses: [{ binanceChainId: 56, chainName: 'BSC', address: ACCOUNT }] },
    'wallet balance': [{ binanceChainId: 56, address: NATIVE, symbol: 'BNB', balance: '0.5' }],
  });
  const result = await baw.wallet();
  assert.equal(result.address, ACCOUNT);
  assert.equal(result.balance, '0.5');
  assert.equal((await baw.preview(TX)).requestId, 'preview-123');
});

test('unconnected state is available without querying balances or starting authentication', async () => {
  const { baw, calls } = harness({ 'wallet status': { status: 'UNCONNECTED' } });
  const result = await baw.wallet();
  assert.equal(result.available, true);
  assert.equal(result.status, 'UNCONNECTED');
  assert.equal(result.address, null);
  assert.equal(result.balance, null);
  assert.equal(calls.length, 1);
});

test('missing executable is reported without fabricating wallet data', async () => {
  const { baw } = harness({ 'wallet status': Object.assign(new Error('spawn baw ENOENT'), { code: 'ENOENT' }) });
  const result = await baw.wallet();
  assert.equal(result.available, false);
  assert.equal(result.balance, null);
  assert.equal(result.quota, null);
});

test('preview preserves risks and authority changes and does not execute', async () => {
  const { baw, calls } = harness();
  const result = await baw.preview(TX);
  assert.equal(result.requestId, 'preview-123');
  assert.equal(result.requireConfirmation, true);
  assert.deepEqual(result.simulationResult.authorityChanges, [{ account: ACCOUNT, authority: TARGET }]);
  assert.equal(result.risks.riskDetails[0].description, 'Review this call');
  assert.deepEqual(calls.at(-1).args, ['contract-call', 'preview', '--binanceChainId', '56', '--from', ACCOUNT, '--to', TARGET, '--value', '100000000000000001', '--inputData', '0x12345678', '--json']);
  assert.equal(calls.some(call => call.args.includes('execute')), false);
});

test('preview rejects disconnected or mismatched account before contract invocation', async () => {
  for (const overrides of [
    { 'wallet status': { status: 'UNCONNECTED' } },
    { 'wallet address': { addresses: [{ binanceChainId: '56', address: TARGET }] } },
  ]) {
    const { baw, calls } = harness(overrides);
    await assert.rejects(baw.preview(TX));
    assert.equal(calls.some(call => call.args[0] === 'contract-call'), false);
  }
});

test('each preview rechecks current Developer Mode instead of reusing wallet cache', async () => {
  const { baw, calls, data } = harness();
  await baw.wallet();
  data['wallet settings'] = { devMode: { enabled: false, expiresAt: null } };
  await assert.rejects(baw.preview(TX), /Developer Mode/);
  assert.equal(calls.some(call => call.args[0] === 'contract-call'), false);
});

test('expired, missing expiry, and balance-exceeded Developer Mode stop preview', async () => {
  for (const devMode of [
    null,
    { enabled: true, expiresAt: '2020-01-01T00:00:00Z' },
    { enabled: true, expiresAt: 1577836800 },
    { enabled: true, expiresAt: null },
    { enabled: true, expiresAt: 'not-a-date' },
    { enabled: true, expiresAt: '2099-01-01T00:00:00Z', balanceExceeded: true },
  ]) {
    const { baw, calls } = harness({ 'wallet settings': { devMode } });
    await assert.rejects(baw.preview(TX), /Developer Mode/);
    assert.equal(calls.some(call => call.args[0] === 'contract-call'), false);
  }
});

test('Developer Mode numeric Unix seconds are accepted', async () => {
  const { baw } = harness({ 'wallet settings': { devMode: { enabled: true, expiresAt: 4070908800, balanceExceeded: false } } });
  assert.equal((await baw.preview(TX)).requestId, 'preview-123');
});

test('unsafe transaction inputs never reach the CLI', async () => {
  for (const tx of [
    { ...TX, from: ACCOUNT + ';echo pwned' }, { ...TX, to: '0x0' },
    { ...TX, value: '0.1' }, { ...TX, value: -1 }, { ...TX, value: '-1' },
    { ...TX, value: '1e18' }, { ...TX, value: '0x' },
    { ...TX, value: (2n ** 256n).toString() },
    { ...TX, data: '0x123' }, { ...TX, data: '0xzz' },
  ]) {
    const { baw, calls } = harness();
    await assert.rejects(baw.preview(tx));
    assert.equal(calls.length, 0);
  }
});

test('execute uses only a validated request ID, without extra confirmation flags', async () => {
  const { baw, calls } = harness();
  const result = await baw.execute('preview-123');
  assert.equal(result.status, 'PENDING_CONFIRMATION');
  assert.equal(result.txHash, null);
  assert.deepEqual(calls[0].args, ['contract-call', 'execute', '--requestId', 'preview-123', '--json']);
  assert.equal(calls[0].options.shell, false);
  for (const bad of ['', '--yes', 'hello world', 'id;touch /tmp/no', '../id', 'a'.repeat(257), null]) {
    await assert.rejects(baw.execute(bad));
  }
  assert.equal(calls.length, 1);
});

test('nonzero CLI exit keeps exact API error message, code, data and raw output', async () => {
  const stdout = JSON.stringify({ success: false, error: { code: 351803, name: 'AGENT_DEV_MODE_RISK_BLOCKED', message: 'High risk transaction', data: { blockLevel: 'Block', risks: { riskDetails: [{ code: 'RISK_001' }] } } } });
  const { baw } = harness({ 'contract-call execute': Object.assign(new Error('Command failed'), { code: 1, stdout, stderr: 'diagnostic' }) });
  await assert.rejects(baw.execute('preview-123'), error => {
    assert.equal(error.message, 'High risk transaction');
    assert.equal(error.code, 351803);
    assert.equal(error.name, 'AGENT_DEV_MODE_RISK_BLOCKED');
    assert.equal(error.data.blockLevel, 'Block');
    assert.equal(error.stdout, stdout);
    assert.deepEqual(error.cliError, { code: 351803, name: 'AGENT_DEV_MODE_RISK_BLOCKED', message: 'High risk transaction', data: { blockLevel: 'Block', risks: { riskDetails: [{ code: 'RISK_001' }] } } });
    return true;
  });
});

test('malformed JSON, timeout, and nonzero success envelopes cannot look successful', async () => {
  for (const response of [
    () => ({ stdout: 'not json' }),
    () => ({ stdout: '{"success":true}' }),
    () => ({ ...ok({ status: 'BROADCASTED' }), code: 1 }),
    Object.assign(new Error('timed out'), { code: 'ETIMEDOUT', killed: true, stdout: ok({ status: 'BROADCASTED' }).stdout }),
  ]) {
    const { baw } = harness({ 'contract-call execute': response });
    await assert.rejects(baw.execute('preview-123'));
  }
});

test('successful preview envelope still requires a usable request ID and expiry', async () => {
  for (const output of [{ requestId: 'preview-123' }, { expiresAt: 4070908800000 }, { requestId: 'preview-123', expiresAt: 1 }]) {
    const { baw } = harness({ 'contract-call preview': output });
    await assert.rejects(baw.preview(TX));
  }
});

test('txLock uses the official BSC command and rejects unknown status shapes', async () => {
  const { baw, calls } = harness();
  assert.deepEqual(await baw.txLock(), { status: 'UNLOCKED' });
  assert.deepEqual(calls[0].args, ['wallet', 'tx-lock', '--binanceChainId', '56', '--json']);
  for (const data of [{ status: 'unknown' }, null, { unlocked: true }]) {
    const { baw: invalid } = harness({ 'wallet tx-lock': data });
    await assert.rejects(invalid.txLock());
  }
});
