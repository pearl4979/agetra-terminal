import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { isAddress } from 'ethers';

const unfinished = new Set(['SUBMITTING', 'UNKNOWN', 'BROADCASTED', 'PENDING_CONFIRMATION', 'MINED']);
const publicCopy = value => JSON.parse(JSON.stringify(value));

export function validateInput(input) {
  if (!input || Object.keys(input).some(k => !['token', 'side', 'amount', 'slippageBps'].includes(k))) throw new Error('未知请求字段');
  if (!isAddress(input.token) || !['buy', 'sell'].includes(input.side)) throw new Error('代币地址或买卖方向不合法');
  if (typeof input.amount !== 'string' || input.amount.length > 80 || !/^(0|[1-9]\d*)(\.\d{1,18})?$/.test(input.amount) || !/[1-9]/.test(input.amount)) throw new Error('金额必须为正十进制字符串，最多18位小数');
  if (!Number.isInteger(input.slippageBps) || input.slippageBps < 1 || input.slippageBps > 500) throw new Error('滑点必须为 1–500 bps');
}

// 日志只存公开交易参数，不存认证信息。落盘先于发送，进程崩溃后不自动重发。
export function createTradeService({ protocol, baw, liveExecution = false, demo = false, journalPath, now = Date.now }) {
  const previews = new Map();
  let orders = [];
  let executing = false;
  let refreshing = false;
  let executionVersion = 0;
  const isLiveExecution = () => !demo && liveExecution === true;
  function setLiveExecution(enabled) {
    if (typeof enabled !== 'boolean') throw new Error('实盘开关必须为布尔值');
    if (demo && enabled) throw new Error('演示模式不能开启实盘');
    liveExecution = enabled;
    executionVersion++;
    previews.clear();
    return isLiveExecution();
  }
  function assertExecutionEnabled(version) {
    if (!demo && !isLiveExecution()) throw new Error('实盘执行未开启：请开启实盘开关（ENABLE_LIVE_TRADING）后重新预览');
    if (version !== executionVersion) throw new Error('实盘开关已变化，原预览失效，请重新预览');
  }
  if (journalPath && existsSync(journalPath)) {
    orders = JSON.parse(readFileSync(journalPath, 'utf8'));
    for (const o of orders) if (o.status === 'SUBMITTING') { o.status = 'UNKNOWN'; o.error = '服务在提交过程中重启；请核对钱包历史，禁止自动重发。'; }
  }
  const save = () => {
    if (!journalPath) return;
    mkdirSync(dirname(journalPath), { recursive: true, mode: 0o700 });
    writeFileSync(`${journalPath}.tmp`, JSON.stringify(orders, null, 2), { mode: 0o600 });
    renameSync(`${journalPath}.tmp`, journalPath);
  };

  async function preview(input) {
    validateInput(input);
    const version = executionVersion;
    for (const [id, p] of previews) if (p.expiresAt < now()) previews.delete(id);
    if (previews.size >= 100) throw new Error('预览过多，请稍后再试');
    const wallet = await baw.wallet();
    if (!wallet.available || !wallet.address) throw new Error(wallet.error || '请先安装 baw 并登录 Agent Wallet');
    // 从构建/报价开始计时，包含 RPC 模拟和 Binance 预览的耗时。
    // 这只限制本地提交，不会为已提交或 App 待确认交易添加链上 deadline。
    const quotedAt = now();
    const built = await protocol.buildTrade({ ...input, walletAddress: wallet.address });
    if (now() >= quotedAt + 30_000) throw new Error('报价已过期，请重新预览');
    const raw = await baw.preview(built.transaction);
    if (version !== executionVersion) throw new Error('实盘开关已变化，原预览失效，请重新预览');
    if (!raw?.requestId) throw new Error('钱包预览没有返回 requestId，禁止执行');
    const upstreamExpiry = typeof raw.expiresAt === 'number' ? raw.expiresAt : Date.parse(raw.expiresAt);
    const expiresAt = Math.min(quotedAt + 30_000, Number.isFinite(upstreamExpiry) ? upstreamExpiry : quotedAt + 30_000);
    if (expiresAt <= now()) throw new Error('钱包预览已过期');
    const p = { id: randomUUID(), quotedAt, expiresAt, executionVersion: version, transaction: built.transaction, summary: built.summary, kind: built.kind || input.side, raw, demo, input: { ...input }, walletAddress: wallet.address };
    previews.set(p.id, p);
    return publicCopy(p);
  }

  async function execute({ previewId, confirmed }) {
    if (confirmed !== true) throw new Error('必须明确确认预览交易');
    assertExecutionEnabled(executionVersion);
    const prior = orders.find(o => o.previewId === previewId);
    if (prior) return publicCopy(prior);
    const p = previews.get(previewId);
    if (!p || now() >= p.expiresAt) throw new Error('预览已过期，请重新预览');
    assertExecutionEnabled(p.executionVersion);
    if (executing || orders.some(o => unfinished.has(o.status))) throw new Error('存在未完成或结果未知的订单，请先核对结果');
    executing = true;
    const order = { id: randomUUID(), previewId, token: p.input.token, side: p.input.side, kind: p.kind, amount: p.input.amount, status: 'SUBMITTING', createdAt: new Date(now()).toISOString(), txHash: null, transaction: p.transaction, requestId: p.raw.requestId, demo };
    orders.unshift(order);
    try {
      const wallet = await baw.wallet();
      if (!wallet.address || wallet.address.toLowerCase() !== p.walletAddress.toLowerCase()) throw new Error('当前钱包与预览钱包不一致，请重新预览');
      if (protocol.validateExecution) await protocol.validateExecution(p.transaction, p.summary);
      // 开关可能在任意 await 期间被关闭，或关闭后重新开启。
      assertExecutionEnabled(p.executionVersion);
      if (now() >= p.expiresAt) throw new Error('预览已过期，请重新预览');
      save(); // 不能成功记录提交意图时，不发送。
    } catch (error) {
      orders = orders.filter(o => o !== order);
      previews.delete(previewId);
      executing = false;
      throw error;
    }
    try {
      const result = await baw.execute(p.raw.requestId);
      order.raw = result;
      order.orderId = result.orderId ?? null;
      order.txHash = /^0x[0-9a-fA-F]{64}$/.test(result.txHash || '') ? result.txHash : null;
      order.status = demo ? 'DEMO_COMPLETED' : result.status === 'PENDING_CONFIRMATION' ? 'PENDING_CONFIRMATION' : order.txHash ? 'BROADCASTED' : 'UNKNOWN';
      order.message = result.message ?? null;
    } catch (error) {
      // 网络超时有可能已发送。保留请求ID，绝不把它当可重试失败。
      order.status = 'UNKNOWN';
      order.error = error.message;
      if (error.cliError) order.cliError = error.cliError;
    } finally {
      executing = false;
      previews.delete(previewId);
      save();
    }
    return publicCopy(order);
  }

  function recoveryOrder(orderId, { allowReleased = false } = {}) {
    if (typeof orderId !== 'string') throw new Error('订单 ID 无效');
    const order = orders.find(item => item.id === orderId);
    const allowed = ['UNKNOWN', 'PENDING_CONFIRMATION', ...(allowReleased ? ['MANUALLY_RELEASED'] : [])];
    if (!order || !allowed.includes(order.status) || order.txHash) throw new Error('此订单不支持手动恢复');
    if (demo) throw new Error('演示订单不需要恢复');
    if (executing || refreshing) throw new Error('订单正在处理或查询中，请稍后恢复');
    return order;
  }

  // 恢复状态必须先可靠落盘；失败则恢复内存，不能悄悄解除订单锁。
  function persistRecovery(order, changes) {
    const previous = publicCopy(order);
    try { Object.assign(order, changes); save(); }
    catch (error) {
      for (const key of Object.keys(order)) delete order[key];
      Object.assign(order, previous);
      throw error;
    }
    return publicCopy(order);
  }

  async function linkTransaction({ orderId, txHash, nonce, confirmed } = {}) {
    if (confirmed !== true) throw new Error('必须明确确认手动关联交易');
    if (typeof txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new Error('交易 hash 无效');
    if (typeof nonce === 'string' && /^(0|[1-9]\d*)$/.test(nonce)) nonce = Number(nonce);
    if (!Number.isSafeInteger(nonce) || nonce < 0) throw new Error('请输入从交易详情核实的非负整数 nonce');
    const order = recoveryOrder(orderId, { allowReleased: true });
    if (!protocol.provider) throw new Error('RPC 不可用，无法验证手动关联');
    if (orders.some(other => other !== order && other.txHash?.toLowerCase() === txHash.toLowerCase())) throw new Error('此 hash 已关联到其他订单');
    executing = true;
    try {
      const provider = protocol.provider;
      const network = await provider.getNetwork();
      if (network.chainId !== 56n) throw new Error('恢复必须使用 BSC 主网（56）');
      const [tx, receipt] = await Promise.all([provider.getTransaction(txHash), provider.getTransactionReceipt(txHash)]);
      const expected = order.transaction;
      if (!tx || tx.hash?.toLowerCase() !== txHash.toLowerCase() || tx.chainId !== 56n || tx.nonce !== nonce || tx.from?.toLowerCase() !== expected.from.toLowerCase() || tx.to?.toLowerCase() !== expected.to.toLowerCase() || tx.data?.toLowerCase() !== expected.data.toLowerCase() || BigInt(tx.value) !== BigInt(expected.value)) {
        throw new Error('链上交易的 chain/from/to/value/data/nonce 与订单或用户输入不匹配');
      }
      if (!Number.isSafeInteger(tx.blockNumber) || !receipt || receipt.hash?.toLowerCase() !== txHash.toLowerCase() || receipt.blockNumber !== tx.blockNumber || ![0, 1].includes(receipt.status)) throw new Error('交易尚未打包或回执无效，请稍后再关联');
      const block = await provider.getBlock(receipt.blockNumber);
      const createdAt = Date.parse(order.createdAt);
      const timestamp = block?.timestamp * 1000;
      if (!block || block.number !== receipt.blockNumber || block.hash?.toLowerCase() !== receipt.blockHash?.toLowerCase() || block.hash?.toLowerCase() !== tx.blockHash?.toLowerCase() || !Number.isFinite(createdAt) || !Number.isFinite(timestamp) || timestamp < createdAt - 120_000 || timestamp > now() + 120_000) {
        throw new Error('交易区块不在当前链上，或交易时间不符合订单提交时间');
      }
      return persistRecovery(order, {
        txHash: tx.hash, status: 'BROADCASTED', manualLinked: true,
        manualLinkedAt: new Date(now()).toISOString(), linkedNonce: nonce,
        linkEvidence: { chainId: 56, nonce, blockNumber: block.number, blockHash: block.hash, blockTimestamp: block.timestamp },
        message: '用户手动关联 hash；已核对链上参数，等待回执确认。此关联不代表 CLI 提供了该 hash。',
      });
    } finally { executing = false; }
  }

  async function releaseOrder({ orderId, confirmed, chainHistoryChecked } = {}) {
    if (confirmed !== true || chainHistoryChecked !== true) throw new Error('必须明确确认已在 App 和链上历史核对订单，才能解除本地锁');
    const order = recoveryOrder(orderId);
    if (typeof baw.txLock !== 'function') throw new Error('钱包不支持实时交易锁查询，不能解除本地锁');
    executing = true;
    try {
      const wallet = await baw.wallet();
      if (!wallet.available || !wallet.address || wallet.address.toLowerCase() !== order.transaction.from.toLowerCase()) throw new Error('当前钱包与原订单不一致，不能解除本地锁');
      const lock = await baw.txLock();
      if (lock?.status !== 'UNLOCKED') throw new Error('Binance 钱包仍有交易或 App 确认锁，不能解除本地锁');
      const checkedAt = new Date(now()).toISOString();
      return persistRecovery(order, {
        status: 'MANUALLY_RELEASED', manuallyReleasedAt: checkedAt,
        releaseCheck: { status: 'UNLOCKED', address: wallet.address, checkedAt, chainHistoryChecked: true },
        message: '用户已核对历史并解除本地阻塞。这不是链上取消或失败证明；原请求不会重发，继续交易必须重新预览。',
      });
    } finally { executing = false; }
  }

  async function refresh() {
    if (!protocol.provider || demo || refreshing || executing) return;
    refreshing = true;
    try {
      for (const order of orders.filter(o => o.txHash && unfinished.has(o.status))) {
        try {
          const receipt = await protocol.provider.getTransactionReceipt(order.txHash);
          if (!receipt) continue;
          const tx = await protocol.provider.getTransaction(order.txHash);
          const expected = order.transaction;
          if (!tx || tx.from.toLowerCase() !== expected.from.toLowerCase() || tx.to?.toLowerCase() !== expected.to.toLowerCase() || tx.data.toLowerCase() !== expected.data.toLowerCase() || BigInt(tx.value) !== BigInt(expected.value)) {
            order.status = 'UNKNOWN'; order.error = '链上交易与预览参数不匹配'; continue;
          }
          const head = await protocol.provider.getBlockNumber();
          order.confirmations = head - receipt.blockNumber + 1;
          order.status = order.confirmations >= 3 ? receipt.status === 1 ? 'CONFIRMED' : 'REVERTED' : 'MINED';
          order.receiptBlock = receipt.blockNumber;
          delete order.error;
        } catch (error) { order.error = `回执查询失败：${error.shortMessage || error.message}`; }
      }
      save();
    } finally { refreshing = false; }
  }

  return { preview, execute, linkTransaction, releaseOrder, refresh, setLiveExecution, isLiveExecution, list: () => publicCopy(orders) };
}
