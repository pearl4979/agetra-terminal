import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseEther } from 'ethers';

// 演示使用已核验 test 代币的离线快照，不创建 RPC 或 baw 实例。
const snapshot = JSON.parse(readFileSync(new URL('../config/demo-tokens.json', import.meta.url), 'utf8'));
const tokenImage = readFileSync(new URL('../public/assets/demo-test.jpg', import.meta.url));
export function createDemo() {
  const localDate = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const address = '0x000000000000000000000000000000000000dEaD';
  const tokens = snapshot.tokens.map(token => ({ ...token,
    imageUrl: `/api/token-image/${token.address}`, imageSource: 'four.meme-snapshot', metadataStatus: 'demo-snapshot',
    demo: true, snapshotAt: snapshot.capturedAt,
    volumeLabel: '快照成交量 · BNB', reason: token.tradable ? '演示快照，不可实盘交易' : token.reason,
  }));
  const metadata = {
    async getImage(token) {
      return tokens.some(t => t.address.toLowerCase() === token.toLowerCase())
        ? { body: tokenImage, contentType: 'image/jpeg', cacheControl: 'public, max-age=3600' } : null;
    },
  };
  const protocol = {
    async positions(token, walletAddress) {
      if (!tokens.some(t => t.address.toLowerCase() === token.toLowerCase())) throw new Error('演示代币不存在');
      return { address: walletAddress, token, balance: parseEther('12345.678901234567890123').toString(), allowance: '0', decimals: 18, demo: true };
    },
    async buildTrade({ token, side, amount, walletAddress }) {
      const t = tokens.find(t => t.address.toLowerCase() === token.toLowerCase());
      if (!t?.tradable) throw new Error('演示代币当前不可交易');
      return { transaction: { from: walletAddress, to: address, value: side === 'buy' ? parseEther(amount).toString() : '0', data: '0x' }, summary: { mode: '纯演示，不会发送到钱包或区块链', side, token, amount, symbol: t.symbol }, kind: side };
    },
  };
  const baw = {
    async wallet() { return { available: true, status: 'CONNECTED', address, balance: '1.2500', quota: { quotaUsed: '25', quotaLeft: '475', dailyLimit: '500', date: localDate() }, devMode: { enabled: true, expiresAt: '2099-01-01', dailyLimit: '100', quotaUsed: '10', quotaDate: localDate(), demo: true }, raw: { note: '全部为演示数据' } }; },
    async preview(transaction) { return { requestId: `DEMO-${randomUUID()}`, expiresAt: Date.now() + 30000, parsedTx: { transactionType: 'DEMO_ONLY', ...transaction }, simulationResult: { balanceChanges: [], allowanceChanges: [], authorityChanges: [] }, risks: { riskDetails: [{ title: '演示模式', description: '此预览没有调用 baw，也不会签名或广播。' }], addresses: {} }, requireConfirmation: false }; },
    async execute() { return { status: 'DEMO_COMPLETED', orderId: `demo-${randomUUID()}`, txHash: null, message: '演示完成 · 没有发生真实交易' }; },
  };
  const monitor = { start() {}, stop() {}, snapshot() { return { tokens, monitor: { status: 'demo', message: 'Test 代币快照 · 不读取实时行情，不发送真实交易', lastBlock: null, updatedAt: new Date().toISOString(), templateId: '1778027615735', registry: '0x912cef0c3ae9ab6eb3ec87cab69371cfb317ab94', manager: '0xebe7b6C1089D9F72aD07f34E36d898e44E5e27f3' } }; } };
  return { protocol, baw, monitor, metadata };
}
