import test from 'node:test';
import assert from 'node:assert/strict';
import { createTradeService } from '../src/trades.mjs';

const FROM = '0x1111111111111111111111111111111111111111';
const TO = '0x2222222222222222222222222222222222222222';
const HASH = `0x${'ab'.repeat(32)}`;
const BLOCK_HASH = `0x${'cd'.repeat(32)}`;
const NOW = Date.parse('2026-10-24T12:00:00Z');
const input = { token: TO, side: 'buy', amount: '0.01', slippageBps: 100 };
const transaction = { from: FROM, to: TO, value: '10000000000000000', data: '0x12345678' };

async function setup({ tx = {}, receipt = {}, block = {}, lock = 'UNLOCKED', chainId = 56n, currentAddress = FROM, rpcError } = {}) {
  let executions = 0;
  const provider = {
    getNetwork: async () => ({ chainId }),
    getTransaction: async () => {
      if (rpcError) throw new Error('RPC unavailable');
      return { ...transaction, hash: HASH, value: 10000000000000000n, nonce: 9, chainId: 56n, blockNumber: 100, blockHash: BLOCK_HASH, ...tx };
    },
    getTransactionReceipt: async () => ({ hash: HASH, blockNumber: 100, blockHash: BLOCK_HASH, status: 1, ...receipt }),
    getBlock: async () => ({ number: 100, hash: BLOCK_HASH, timestamp: NOW / 1000, ...block }),
    getBlockNumber: async () => 102,
  };
  let addr = FROM;
  const baw = {
    wallet: async () => ({ available: true, address: addr }),
    preview: async () => ({ requestId: 'preview-upstream', expiresAt: NOW + 60_000 }),
    execute: async () => { executions++; return { status: 'PENDING_CONFIRMATION', orderId: 'remote-order', txHash: null }; },
    txLock: async () => typeof lock === 'string' ? { status: lock } : lock(),
  };
  const service = createTradeService({ protocol: { provider, buildTrade: async () => ({ transaction, summary: {} }) }, baw, liveExecution: true, now: () => NOW });
  const preview = await service.preview(input);
  const order = await service.execute({ previewId: preview.id, confirmed: true });
  addr = currentAddress;
  return { service, order, preview, executions: () => executions };
}

test('manual link requires full transaction identity and records explicit provenance before receipt confirmation', async () => {
  const { service, order, executions } = await setup();
  const linked = await service.linkTransaction({ orderId: order.id, txHash: HASH, nonce: '9', confirmed: true });
  assert.equal(linked.status, 'BROADCASTED');
  assert.equal(linked.txHash, HASH);
  assert.equal(linked.manualLinked, true);
  assert.equal(linked.linkedNonce, 9);
  assert.equal(linked.linkEvidence.blockHash, BLOCK_HASH);
  await service.refresh();
  assert.equal(service.list()[0].status, 'CONFIRMED');
  assert.equal(executions(), 1);
});

test('manual link rejects wrong parameters, nonce, chain, old transactions and noncanonical receipt', async () => {
  for (const config of [
    { tx: { from: TO } }, { tx: { to: FROM } }, { tx: { data: '0xdeadbeef' } },
    { tx: { value: 2n } }, { tx: { nonce: 10 } }, { tx: { chainId: 1n } },
    { tx: { hash: `0x${'ef'.repeat(32)}` } }, { tx: { blockNumber: null } },
    { chainId: 1n }, { block: { timestamp: NOW / 1000 - 121 } },
    { block: { hash: `0x${'ee'.repeat(32)}` } }, { receipt: { status: null } },
    { rpcError: true },
  ]) {
    const { service, order, executions } = await setup(config);
    await assert.rejects(service.linkTransaction({ orderId: order.id, txHash: HASH, nonce: 9, confirmed: true }));
    assert.equal(service.list()[0].status, 'PENDING_CONFIRMATION');
    assert.equal(service.list()[0].txHash, null);
    assert.equal(executions(), 1);
  }
});

test('manual link rejects absent explicit consent or nonce without changing order', async () => {
  const { service, order } = await setup();
  for (const extra of [{ nonce: 9 }, { nonce: -1, confirmed: true }, { confirmed: true }, { nonce: '1e2', confirmed: true }]) {
    await assert.rejects(service.linkTransaction({ orderId: order.id, txHash: HASH, ...extra }));
  }
  assert.equal(service.list()[0].txHash, null);
});

test('release requires current original account, explicit history check and fresh UNLOCKED state', async () => {
  for (const config of [{ lock: 'LOCKED' }, { lock: 'unknown' }, { lock: async () => ({}) }, { lock: async () => { throw new Error('CLI unavailable'); } }, { currentAddress: TO }]) {
    const { service, order } = await setup(config);
    await assert.rejects(service.releaseOrder({ orderId: order.id, confirmed: true, chainHistoryChecked: true }));
    assert.equal(service.list()[0].status, 'PENDING_CONFIRMATION');
  }
  const { service, order } = await setup();
  await assert.rejects(service.releaseOrder({ orderId: order.id, confirmed: true }));
  assert.equal(service.list()[0].status, 'PENDING_CONFIRMATION');
});

test('manual release never resends old preview and permits only a fresh confirmed order', async () => {
  const { service, order, preview, executions } = await setup();
  const released = await service.releaseOrder({ orderId: order.id, confirmed: true, chainHistoryChecked: true });
  assert.equal(released.status, 'MANUALLY_RELEASED');
  assert.equal(released.requestId, 'preview-upstream');
  assert.equal((await service.execute({ previewId: preview.id, confirmed: true })).status, 'MANUALLY_RELEASED');
  assert.equal(executions(), 1);
  const next = await service.preview(input);
  await service.execute({ previewId: next.id, confirmed: true });
  assert.equal(executions(), 2);
});

test('manual release cannot discard an already linked transaction', async () => {
  const { service, order } = await setup();
  await service.linkTransaction({ orderId: order.id, txHash: HASH, nonce: 9, confirmed: true });
  await assert.rejects(service.releaseOrder({ orderId: order.id, confirmed: true, chainHistoryChecked: true }));
  assert.equal(service.list()[0].txHash, HASH);
});

test('a second recovery and execution cannot race an in-flight lock check', async () => {
  let finishLock;
  const lockPending = new Promise(resolve => { finishLock = resolve; });
  const { service, order, executions } = await setup({ lock: async () => lockPending });
  const preview = await service.preview(input);
  const release = service.releaseOrder({ orderId: order.id, confirmed: true, chainHistoryChecked: true });
  await assert.rejects(service.releaseOrder({ orderId: order.id, confirmed: true, chainHistoryChecked: true }), /处理/);
  await assert.rejects(service.execute({ previewId: preview.id, confirmed: true }), /未完成/);
  finishLock({ status: 'UNLOCKED' });
  await release;
  assert.equal(executions(), 1);
});

test('the same chain transaction cannot be manually linked to two local orders', async () => {
  const { service, order } = await setup();
  await service.linkTransaction({ orderId: order.id, txHash: HASH, nonce: 9, confirmed: true });
  await service.refresh();
  const preview = await service.preview(input);
  const next = await service.execute({ previewId: preview.id, confirmed: true });
  await assert.rejects(service.linkTransaction({ orderId: next.id, txHash: HASH, nonce: 9, confirmed: true }), /其他订单/);
  assert.equal(service.list()[0].txHash, null);
});
