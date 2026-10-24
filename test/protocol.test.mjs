import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDecimalAmount, slippageFloor, decodeCreationTags, createProtocol, manifest } from '../src/protocol.mjs';
import { createMonitor } from '../src/monitor.mjs';
import { readFileSync } from 'node:fs';
import { Interface, id, parseEther, ZeroAddress } from 'ethers';

const abis = Object.fromEntries(['Core', 'Registry', 'Tools', 'Runtime'].map(name => [name, JSON.parse(readFileSync(new URL(`../abi/${name}.json`, import.meta.url)))]));
const interfaces = Object.fromEntries(Object.entries(abis).map(([key, abi]) => [key, new Interface(abi)]));
const token = '0x1111111111111111111111111111111111111111';
const walletAddress = '0x2222222222222222222222222222222222222222';

// Real ethers contract encoding/decoding is exercised; only the external RPC boundary is replaced.
function runner({ allowance = 0n, denyExecution = false, wrongModule = false, wrongTokenImplementation = false, unavailableSnapshot = false } = {}) {
  const modules = Object.values(manifest.modules);
  const result = (iface, method, values) => iface.encodeFunctionResult(method, values);
  return {
    getNetwork: async () => ({ chainId: 56n }),
    getBlockNumber: async () => 129400000,
    getBalance: async () => parseEther('2'),
    getFeeData: async () => ({ gasPrice: 50000000n, maxFeePerGas: null }),
    estimateGas: async () => 100000n,
    call: async ({ to, data }) => {
      let iface, decoded;
      for (const current of Object.values(interfaces)) { try { const x = current.parseTransaction({ data }); if (x) { iface = current; decoded = x; break; } } catch {} }
      if (!decoded) throw new Error('Unknown test RPC request');
      const name = decoded.name;
      if (name === 'openFourCore') return result(iface, name, [manifest.core]);
      if (name === 'openFourTool') return result(iface, name, [manifest.tools]);
      if (name === 'registry') return result(iface, name, [manifest.registry]);
      if (name === 'wrappedNative') return result(iface, name, [manifest.wrappedNative]);
      if (name === 'getPreset') return result(iface, name, [[manifest.templateId, 'Binance Agent ID Exclusive', '', '1.0.0', true, true, walletAddress, ...modules.map(x => x.id), manifest.tokenImplId, '0x' + '00'.repeat(32), walletAddress]]);
      if (name === 'getModuleImplementation') return result(iface, name, [wrongModule ? token : modules.find(x => x.id === decoded.args[0]).implementation]);
      if (name === 'getModule') return result(iface, name, [[walletAddress, 0, [decoded.args[0], '1.0.0', 'module', '', walletAddress, 0], true]]);
      if (name === 'getPresetTokenImpl') return result(iface, name, [wrongTokenImplementation ? token : manifest.tokenImplementation]);
      if (name === 'tokens') return result(iface, name, [1, walletAddress, manifest.templateId, token, 'Test', 'TEST', parseEther('1000000000'), parseEther('800000000'), parseEther('18'), manifest.wrappedNative, modules[1].implementation, modules[2].implementation, modules[3].implementation, modules[4].implementation, modules[0].implementation, ZeroAddress, 129390000, true, false, false]);
      if (name === 'descriptor') {
        const tag = to.toLowerCase() === token.toLowerCase() ? manifest.tokenTag : modules.find(x => x.implementation.toLowerCase() === to.toLowerCase()).tag;
        return result(iface, name, [id(tag).slice(0, 18), tag, '1.0.0']);
      }
      if (name === 'decimals') return result(iface, name, [18]);
      if (name === 'phase') return result(iface, name, [1]);
      if (name === 'buyFeeRate' || name === 'sellFeeRate') return result(iface, name, [300]);
      if (name === 'getCurveLiquiditySnapshot') return result(iface, name, [unavailableSnapshot ? [false, 0, 0, 0, 0, 0, 0, 0] : [true, parseEther('1'), parseEther('1000000000'), parseEther('2'), parseEther('900000000'), parseEther('700000000'), parseEther('1'), 1000000000n]]);
      if (name === 'balanceOf') return result(iface, name, [parseEther('2000')]);
      if (name === 'allowance') return result(iface, name, [allowance]);
      if (name === 'estimateBuyByBudget') return result(iface, name, [[parseEther('0.097'), parseEther('0.003'), parseEther('0.1'), 0, parseEther('1000'), 97000000000000n]]);
      if (name === 'estimateSell') return result(iface, name, [[parseEther('0.083'), parseEther('0.003'), 0, parseEther('0.08'), decoded.args[2], 83000000000000n]]);
      if (name === 'approve') return result(iface, name, [true]);
      if (name === 'buyByBudget' || name === 'sell') { if (denyExecution) throw new Error('Agent identity or cumulative purchase limit rejected'); return '0x'; }
      throw new Error(`Unhandled RPC method ${name}`);
    },
  };
}

test('decimal amounts preserve all 18 decimals and reject exponential or excess precision', () => {
  assert.equal(parseDecimalAmount('0.123456789012345678'), 123456789012345678n);
  for (const value of ['1e-3', '-1', '0', '0.0000000000000000001', 'Infinity', '01']) {
    assert.throws(() => parseDecimalAmount(value));
  }
});

test('slippage uses integer floors without converting token values to Number', () => {
  assert.equal(slippageFloor(123456789012345678901234567n, 100), 122222221122222222112222221n);
  assert.throws(() => slippageFloor(1n, 10000));
  assert.throws(() => slippageFloor(1n, 0.5));
});

test('tag decoding enforces the exact schema and all seven tag slots', () => {
  const decoded = decodeCreationTags(manifest.encodedTags);
  assert.equal(decoded.token, '0x81df3253a0717815');
  assert.equal(decoded.curve, '0x54a8e7f1c2a9d6c8');
  assert.throws(() => decodeCreationTags('0x02' + manifest.encodedTags.slice(4)));
  assert.throws(() => decodeCreationTags('0x01'));
});

test('trade construction rejects invalid input before making RPC calls', async () => {
  const protocol = createProtocol({ rpcUrl: 'http://127.0.0.1:1' });
  await assert.rejects(protocol.buildTrade({ token: 'bad', walletAddress: 'bad', side: 'buy', amount: '1', slippageBps: 100 }));
  protocol.provider.destroy();
});

test('failed log requests never move the monitor checkpoint or claim an empty completed scan', async () => {
  const protocol = {
    provider: { getBlockNumber: async () => manifest.deploymentBlock + 100, getLogs: async () => { throw new Error('limit exceeded'); } },
    initialize: async () => ({ manager: manifest.core }),
    get manager() { return manifest.core; },
    createdTopic: '0x01', tradeTopic: '0x02', presetTopic: '0x03',
  };
  const monitor = createMonitor({ protocol, persist: false, pollMs: 100000 });
  await monitor.start();
  const result = monitor.snapshot();
  monitor.stop();
  assert.equal(result.monitor.lastBlock, manifest.deploymentBlock - 1);
  assert.equal(result.monitor.status, 'error');
  assert.match(result.monitor.message, /limit exceeded/);
});

test('buy calldata carries a nonzero slippage floor and exact BNB budget', async () => {
  const protocol = createProtocol({ provider: runner() });
  const result = await protocol.buildTrade({ token, walletAddress, side: 'buy', amount: '0.1', slippageBps: 100 });
  assert.equal(result.kind, 'buy');
  assert.equal(result.transaction.value, '100000000000000000');
  const decoded = interfaces.Core.parseTransaction(result.transaction);
  assert.equal(decoded.name, 'buyByBudget');
  assert.equal(decoded.args.minAmountOut, 990000000000000000000n);
  assert.equal(result.summary.simulated, true);
});

test('insufficient sell allowance produces only exact approval and requires another preview', async () => {
  const protocol = createProtocol({ provider: runner() });
  const result = await protocol.buildTrade({ token, walletAddress, side: 'sell', amount: '1000', slippageBps: 100 });
  const decoded = interfaces.Runtime.parseTransaction(result.transaction);
  assert.equal(result.kind, 'approve');
  assert.equal(result.transaction.to, token);
  assert.equal(decoded.args[0], manifest.core);
  assert.equal(decoded.args[1], 1000000000000000000000n);
  assert.equal(result.summary.requiresNewPreview, true);
});

test('authorized sale protects the net BNB received after fees', async () => {
  const protocol = createProtocol({ provider: runner({ allowance: parseEther('1000') }) });
  const result = await protocol.buildTrade({ token, walletAddress, side: 'sell', amount: '1000', slippageBps: 100 });
  const decoded = interfaces.Core.parseTransaction(result.transaction);
  assert.equal(result.kind, 'sell');
  assert.equal(decoded.args[2], 79200000000000000n);
  assert.equal(result.transaction.value, '0');
});

test('a successful quote cannot bypass account restrictions in the real execution simulation', async () => {
  const protocol = createProtocol({ provider: runner({ denyExecution: true }) });
  await assert.rejects(protocol.buildTrade({ token, walletAddress, side: 'buy', amount: '0.1', slippageBps: 100 }), /Agent identity/);
});

test('module implementation changes disable trade preparation', async () => {
  const protocol = createProtocol({ provider: runner({ wrongModule: true }) });
  await assert.rejects(protocol.buildTrade({ token, walletAddress, side: 'buy', amount: '0.1', slippageBps: 100 }), /实现已变化/);
});

test('changing the token implementation under the same registry ID disables trading', async () => {
  const protocol = createProtocol({ provider: runner({ wrongTokenImplementation: true }) });
  await assert.rejects(protocol.buildTrade({ token, walletAddress, side: 'buy', amount: '0.1', slippageBps: 100 }), /代币实现已变化/);
});

test('execution revalidation rejects a transaction with zero minimum output', async () => {
  const protocol = createProtocol({ provider: runner() });
  await assert.rejects(protocol.validateExecution({ to: manifest.core, from: walletAddress, value: '100000000000000000', data: interfaces.Core.encodeFunctionData('buyByBudget', [token, parseEther('0.1'), 0, 0, '0x']) }), /最少收到/);
});

test('execution revalidation performs the exact account simulation again', async () => {
  const protocol = createProtocol({ provider: runner({ denyExecution: true }) });
  await assert.rejects(protocol.validateExecution({ to: manifest.core, from: walletAddress, value: '100000000000000000', data: interfaces.Core.encodeFunctionData('buyByBudget', [token, parseEther('0.1'), parseEther('990'), 0, '0x']) }), /Agent identity/);
});

test('unavailable curve snapshots expose unknown accounting instead of zero funds and a completed curve', async () => {
  const protocol = createProtocol({ provider: runner({ unavailableSnapshot: true }) });
  const state = await protocol.getTokenState(token);
  assert.equal(state.price, null);
  assert.equal(state.progress, null);
  assert.equal(state.totalRaised, null);
  assert.equal(state.remainingForSale, null);
  // Eligibility is determined separately; a fresh quote and Core simulation remain mandatory.
  assert.equal(state.tradable, true);
  const trade = await protocol.buildTrade({ token, walletAddress, side: 'buy', amount: '0.1', slippageBps: 100 });
  assert.equal(trade.summary.simulated, true);
});

test('each monitor poll revalidates registry configuration and disables cached tokens on failure', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const createdTopic = interfaces.Core.getEvent('TokenCreated').topicHash;
  const encoded = interfaces.Core.encodeEventLog('TokenCreated', [1, manifest.templateId, walletAddress, token, 'Test', 'TEST', parseEther('1000000000'), parseEther('800000000'), parseEther('18'), 1000000000n, manifest.wrappedNative, walletAddress, walletAddress, walletAddress, walletAddress, ZeroAddress, walletAddress, '', 0, manifest.encodedTags]);
  const log = { ...encoded, blockNumber: manifest.deploymentBlock, blockHash: '0x' + '11'.repeat(32), transactionHash: '0x' + '22'.repeat(32), index: 0 };
  let changed = false;
  const protocol = {
    manager: manifest.core, coreInterface: interfaces.Core, createdTopic,
    tradeTopic: interfaces.Core.getEvent('TradeExecuted').topicHash, presetTopic: encoded.topics[1],
    initialize: async () => { if (changed) throw new Error('curve module implementation changed'); },
    provider: {
      getBlockNumber: async () => manifest.deploymentBlock + manifest.confirmations,
      getLogs: async ({ topics }) => topics[0] === createdTopic ? [log] : [],
    },
    getTokenState: async () => ({ address: token, name: 'Test', symbol: 'TEST', verified: true, tradable: true, phase: 'bonding' }),
  };
  const monitor = createMonitor({ protocol, persist: false, pollMs: 6000 });
  t.after(() => monitor.stop());
  await monitor.start();
  assert.equal(monitor.snapshot().tokens[0].tradable, true);
  assert.equal(monitor.snapshot().monitor.status, 'live');
  changed = true;
  t.mock.timers.tick(6000);
  await new Promise(setImmediate);
  const after = monitor.snapshot();
  assert.equal(after.monitor.status, 'error');
  assert.match(after.monitor.message, /curve module implementation changed/);
  assert.equal(after.tokens[0].tradable, false);
  assert.equal(after.monitor.lastBlock, manifest.deploymentBlock);
});
