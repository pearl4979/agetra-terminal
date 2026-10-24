import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Interface, id, parseEther, ZeroAddress } from 'ethers';
import { createTradeService, validateInput } from '../src/trades.mjs';
import { createProtocol, manifest } from '../src/protocol.mjs';

const token = '0x1111111111111111111111111111111111111111';
const address = '0x2222222222222222222222222222222222222222';
const input = { token, side: 'buy', amount: '0.1', slippageBps: 100 };
const interfaces = Object.fromEntries(['Core', 'Registry', 'Tools', 'Runtime'].map(name => [name, new Interface(JSON.parse(readFileSync(new URL(`../abi/${name}.json`, import.meta.url))))]));

// Only the chain boundary is replaced; encoding, protocol checks and trade service run normally.
function chain() {
  const modules = Object.values(manifest.modules);
  const state = { buyOutput: parseEther('1000'), sellOutput: parseEther('0.08'), wrongPreset: false, balance: 123456789012345678901234n, allowance: parseEther('2000') };
  const provider = {
    getNetwork: async () => ({ chainId: 56n }), getBlockNumber: async () => 129400000,
    getBalance: async () => parseEther('2'), getFeeData: async () => ({ gasPrice: 50000000n }), estimateGas: async () => 100000n,
    async call({ to, data }) {
      let iface, decoded;
      for (const candidate of Object.values(interfaces)) { try { const result = candidate.parseTransaction({ data }); if (result) { iface = candidate; decoded = result; break; } } catch {} }
      if (!decoded) throw new Error('Unexpected RPC call');
      const { name, args } = decoded;
      const result = values => iface.encodeFunctionResult(name, values);
      if (name === 'openFourCore') return result([manifest.core]);
      if (name === 'openFourTool') return result([manifest.tools]);
      if (name === 'registry') return result([manifest.registry]);
      if (name === 'wrappedNative') return result([manifest.wrappedNative]);
      if (name === 'getPreset') return result([[manifest.templateId, 'Agent', '', '1.0.0', true, true, address, ...modules.map(x => x.id), manifest.tokenImplId, '0x' + '00'.repeat(32), address]]);
      if (name === 'getPresetTokenImpl') return result([manifest.tokenImplementation]);
      if (name === 'getModuleImplementation') return result([modules.find(x => x.id === args[0]).implementation]);
      if (name === 'getModule') return result([[address, 0, [args[0], '1.0.0', 'module', '', address, 0], true]]);
      if (name === 'tokens') return result([1, address, state.wrongPreset ? 1 : manifest.templateId, token, 'Test', 'TEST', parseEther('1000000000'), parseEther('800000000'), parseEther('18'), manifest.wrappedNative, modules[1].implementation, modules[2].implementation, modules[3].implementation, modules[4].implementation, modules[0].implementation, ZeroAddress, 129390000, true, false, false]);
      if (name === 'descriptor') { const tag = to.toLowerCase() === token ? manifest.tokenTag : modules.find(x => x.implementation.toLowerCase() === to.toLowerCase()).tag; return result([id(tag).slice(0, 18), tag, '1.0.0']); }
      if (name === 'decimals') return result([18]);
      if (name === 'phase') return result([1]);
      if (name === 'buyFeeRate' || name === 'sellFeeRate') return result([300]);
      if (name === 'getCurveLiquiditySnapshot') return result([[false, 0, 0, 0, 0, 0, 0, 0]]);
      if (name === 'balanceOf') { assert.equal(args[0].toLowerCase(), address); return result([state.balance]); }
      if (name === 'allowance') { assert.equal(args[0].toLowerCase(), address); assert.equal(args[1], manifest.core); return result([state.allowance]); }
      if (name === 'estimateBuyByBudget') return result([[parseEther('0.097'), parseEther('0.003'), parseEther('0.1'), 0, state.buyOutput, 97000000000000n]]);
      if (name === 'estimateSell') return result([[parseEther('0.083'), parseEther('0.003'), 0, state.sellOutput, args[2], 83000000000000n]]);
      if (name === 'buyByBudget' || name === 'sell') return '0x';
      if (name === 'approve') return result([true]);
      throw new Error(`Unexpected RPC method ${name}`);
    },
  };
  return { state, protocol: createProtocol({ provider }) };
}

function serviceHarness({ protocol, buildDelay = 0, previewDelay = 0, walletDelay = 0 } = {}) {
  let time = 1000, broadcasts = 0;
  const basic = { buildTrade: async () => { time += buildDelay; return { transaction: { from: address, to: token, value: '1', data: '0x' }, kind: 'buy', summary: {} }; } };
  const baw = {
    wallet: async () => { time += walletDelay; return { available: true, address }; },
    preview: async () => { time += previewDelay; return { requestId: 'preview-1', expiresAt: time + 60000 }; },
    execute: async () => { broadcasts++; return { status: 'PENDING_CONFIRMATION', txHash: null }; },
  };
  const service = createTradeService({ protocol: protocol ?? basic, baw, liveExecution: true, now: () => time });
  return { service, broadcasts: () => broadcasts };
}

test('quote TTL includes build and wallet preview latency but starts after wallet loading', async () => {
  const { service } = serviceHarness({ walletDelay: 60000, buildDelay: 5000, previewDelay: 7000 });
  const preview = await service.preview(input);
  assert.equal(preview.quotedAt, 61000);
  assert.equal(preview.expiresAt, 91000);
});

test('slow preview cannot resurrect an already stale quote', async () => {
  const { service, broadcasts } = serviceHarness({ buildDelay: 20000, previewDelay: 11000 });
  await assert.rejects(service.preview(input), /过期/);
  assert.equal(broadcasts(), 0);
});

test('both input and protocol refuse slip tolerance beyond 5 percent', async () => {
  assert.throws(() => validateInput({ ...input, slippageBps: 501 }), /滑点/);
  const { protocol } = chain();
  await assert.rejects(protocol.buildTrade({ ...input, walletAddress: address, slippageBps: 501 }), /滑点/);
});

for (const side of ['buy', 'sell']) {
  test(`${side} stops before wallet execution when fresh output moves beyond half the allowed slippage`, async () => {
    const { state, protocol } = chain();
    const { service, broadcasts } = serviceHarness({ protocol });
    const preview = await service.preview({ ...input, side, amount: side === 'buy' ? '0.1' : '1000', slippageBps: 20 });
    if (side === 'buy') state.buyOutput = parseEther('998.9');
    else state.sellOutput = parseEther('0.079912');
    await assert.rejects(service.execute({ previewId: preview.id, confirmed: true }), /报价.*变化|漂移/);
    assert.equal(broadcasts(), 0);
    assert.equal(service.list().length, 0);
    state.buyOutput = parseEther('1000'); state.sellOutput = parseEther('0.08');
    await assert.rejects(service.execute({ previewId: preview.id, confirmed: true }), /过期|失效/);
  });
}

test('fresh output at the drift threshold executes the original calldata and request', async () => {
  const { state, protocol } = chain();
  const { service, broadcasts } = serviceHarness({ protocol });
  const preview = await service.preview({ ...input, slippageBps: 100 });
  state.buyOutput = parseEther('995');
  const order = await service.execute({ previewId: preview.id, confirmed: true });
  assert.deepEqual(order.transaction, preview.transaction);
  assert.equal(order.requestId, 'preview-1');
  assert.equal(broadcasts(), 1);
});

test('large allowed slippage does not widen fresh quote drift beyond 50 bps', async () => {
  const { state, protocol } = chain();
  const trade = await protocol.buildTrade({ ...input, walletAddress: address, slippageBps: 500 });
  state.buyOutput = parseEther('994.9');
  await assert.rejects(protocol.validateExecution(trade.transaction, trade.summary), /报价.*变化|漂移/);
});

test('preview exposes unverified MEV protection and leaves unavailable price impact unknown', async () => {
  const { protocol } = chain();
  const trade = await protocol.buildTrade({ ...input, walletAddress: address });
  assert.equal(trade.summary.mevProtection, 'unverified');
  assert.equal(trade.summary.priceImpactBps, null);
});

test('positions preserve raw precision and reject tokens outside the verified template', async () => {
  const { state, protocol } = chain();
  const position = await protocol.positions(token, address);
  assert.equal(position.balance, '123456789012345678901234');
  assert.equal(position.allowance, '2000000000000000000000');
  assert.equal(position.decimals, 18);
  assert.equal(position.verified, true);
  state.wrongPreset = true;
  await assert.rejects(protocol.positions(token, address), /不是目标/);
});

test('switching real execution off invalidates previews even after enabling it again', async () => {
  const { service, broadcasts } = serviceHarness();
  const preview = await service.preview(input);
  service.setLiveExecution(false);
  assert.equal(service.isLiveExecution(), false);
  service.setLiveExecution(true);
  assert.equal(service.isLiveExecution(), true);
  await assert.rejects(service.execute({ previewId: preview.id, confirmed: true }), /过期|失效/);
  assert.equal(broadcasts(), 0);
});

test('turning execution off during asynchronous guards prevents the pending submit', async () => {
  let service;
  const protocol = {
    buildTrade: async () => ({ transaction: { from: address, to: token, value: '1', data: '0x' }, kind: 'buy', summary: {} }),
    validateExecution: async () => { service.setLiveExecution(false); service.setLiveExecution(true); },
  };
  const harness = serviceHarness({ protocol }); service = harness.service;
  const preview = await service.preview(input);
  await assert.rejects(service.execute({ previewId: preview.id, confirmed: true }), /开关|失效|关闭/);
  assert.equal(harness.broadcasts(), 0);
  assert.equal(service.list().length, 0);
});

test('demo execution cannot enable real wallet broadcasting', () => {
  const service = createTradeService({ protocol: {}, baw: {}, demo: true });
  assert.equal(service.isLiveExecution(), false);
  assert.throws(() => service.setLiveExecution(true), /演示/);
});

test('a preview still running when the switch changes cannot be used afterwards', async () => {
  let service;
  const protocol = { buildTrade: async () => {
    service.setLiveExecution(false); service.setLiveExecution(true);
    return { transaction: { from: address, to: token, value: '1', data: '0x' }, kind: 'buy', summary: {} };
  } };
  ({ service } = serviceHarness({ protocol }));
  await assert.rejects(service.preview(input), /开关|失效/);
});
