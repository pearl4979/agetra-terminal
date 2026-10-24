import { expiryMs } from './baw.mjs';

// 登录状态只在本机进程内存保留。verify 子进程持续运行直至完成/超时，
// HTTP轮询只读取状态，不重复启动 CLI，也不记录配对信息到日志或磁盘。
export function createAuthService({ baw, onConnected = () => {}, now = Date.now }) {
  let state = { status: 'IDLE' }, starting, verifying, controller, lastStart = 0;
  const snapshot = () => {
    if (state.status === 'WAITING_APP' && (expiryMs(state.expireAt) ?? 0) <= now()) {
      return { status: 'EXPIRED', pendingVerification: Boolean(verifying), message: '配对码已过期，等待本次验证进程结束后重新登录' };
    }
    return { ...state };
  };
  async function connected() {
    if ((await baw.status()).status !== 'CONNECTED') throw new Error('App 已响应，但本机 CLI 尚未连接。请重新发起登录');
    state = { status: 'CONNECTED', message: 'Agentic Wallet 已连接' };
    onConnected();
  }
  async function start() {
    if (starting) return starting;
    if (verifying) return snapshot();
    if (lastStart && now() - lastStart < 5000) throw new Error('请稍候再发起登录');
    lastStart = now();
    starting = (async () => {
      try {
        const data = await baw.authStart();
        if (data.status === 'ALREADY_CONNECTED') { await connected(); return snapshot(); }
        state = { status: 'WAITING_APP', urlForWeb: data.urlForWeb, qrCodeId: data.qrCodeId, pairingCode: data.pairingCode, expireAt: data.expireAt, message: '打开官方登录页，在 Binance App 核对配对码并确认' };
        controller = new AbortController();
        verifying = (async () => {
          try { await baw.authVerify(data.qrCodeId, { signal: controller.signal }); await connected(); }
          catch (e) { state = { status: (expiryMs(data.expireAt) ?? 0) <= now() ? 'EXPIRED' : 'ERROR', message: e.message }; }
          finally { verifying = null; controller = null; }
        })();
        return snapshot();
      } catch (e) { state = { status: 'ERROR', message: e.message }; throw e; }
      finally { starting = null; }
    })();
    return starting;
  }
  return { start, snapshot, stop() { controller?.abort(); } };
}
