import { randomUUID } from 'node:crypto';
import { parseEther } from 'ethers';

// 故意独立的演示数据；不与实时列表合并，也不创建 baw 实例。
export function createDemo() {
  const localDate = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const address = '0x000000000000000000000000000000000000dEaD';
  const tokens = [
    ['SIGNAL', 'Signal Agent · 演示', '0.0000000142', 24.6, '3.42'],
    ['NEXUS', 'Nexus.ai · 演示', '0.0000000821', 78.1, '12.87'],
    ['CIRCUIT', 'Circuit Agent · 演示', '0.0000000063', 8.4, '0.96'],
    ['ORBIT', 'Orbit.ai · 演示', '0.000000196', 100, '27.30'],
  ].map((t, i) => ({ symbol: t[0], name: t[1], imageUrl: `/assets/demo-${t[0].toLowerCase()}.svg`, imageSource: 'local-demo', metadataStatus: 'demo', address: `0x${String(i + 1).padStart(40, '0')}`, price: t[2], progress: t[3], volume: t[4], volumeLabel: '演示成交量 · BNB', phase: i === 3 ? 'graduated' : 'bonding', verified: true, tradable: i !== 3, reason: i === 3 ? '已毕业，MVP仅支持内盘' : '演示数据，不可实盘交易', createdAt: new Date(Date.now() - (i + 1) * 180000).toISOString() }));
  const protocol = {
    async positions(token, walletAddress) {
      if (!tokens.some(t => t.address.toLowerCase() === token.toLowerCase())) throw new Error('演示代币不存在');
      return { address: walletAddress, token, balance: parseEther('12345.678901234567890123').toString(), allowance: '0', decimals: 18, demo: true };
    },
    async buildTrade({ token, side, amount, walletAddress }) {
      const t = tokens.find(t => t.address === token);
      if (!t?.tradable) throw new Error('演示代币当前不可交易');
      return { transaction: { from: walletAddress, to: address, value: side === 'buy' ? parseEther(amount).toString() : '0', data: '0x' }, summary: { mode: '纯演示，不会发送到钱包或区块链', side, token, amount, symbol: t.symbol }, kind: side };
    },
  };
  const baw = {
    async wallet() { return { available: true, status: 'CONNECTED', address, balance: '1.2500', quota: { quotaUsed: '25', quotaLeft: '475', dailyLimit: '500', date: localDate() }, devMode: { enabled: true, expiresAt: '2099-01-01', dailyLimit: '100', quotaUsed: '10', quotaDate: localDate(), demo: true }, raw: { note: '全部为演示数据' } }; },
    async preview(transaction) { return { requestId: `DEMO-${randomUUID()}`, expiresAt: Date.now() + 30000, parsedTx: { transactionType: 'DEMO_ONLY', ...transaction }, simulationResult: { balanceChanges: [], allowanceChanges: [], authorityChanges: [] }, risks: { riskDetails: [{ title: '演示模式', description: '此预览没有调用 baw，也不会签名或广播。' }], addresses: {} }, requireConfirmation: false }; },
    async execute() { return { status: 'DEMO_COMPLETED', orderId: `demo-${randomUUID()}`, txHash: null, message: '演示完成 · 没有发生真实交易' }; },
  };
  const monitor = { start() {}, stop() {}, snapshot() { return { tokens, monitor: { status: 'demo', message: '演示数据 · 不读取真实行情，不发送真实交易', lastBlock: null, updatedAt: new Date().toISOString(), templateId: '1778027615735', registry: '0x912cef0c3ae9ab6eb3ec87cab69371cfb317ab94', manager: '0xebe7b6C1089D9F72aD07f34E36d898e44E5e27f3' } }; } };
  return { protocol, baw, monitor };
}
