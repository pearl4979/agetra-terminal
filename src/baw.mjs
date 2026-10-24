import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const CHAIN = '56';
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/;
const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const UINT256_MAX = (1n << 256n) - 1n;
const TIMEOUT_MS = 60_000;
const bundledEntry = fileURLToPath(new URL('../node_modules/@binance/agentic-wallet/dist/index.js', import.meta.url));

function fail(message, code = 'BAW_INVALID_RESPONSE', extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validRequestId(value) {
  return typeof value === 'string' && REQUEST_ID.test(value);
}

// 文档曾返回 Unix 秒；CLI 1.11.0 把 Developer Mode 到期时间转为 ISO 字符串。
export function expiryMs(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === 'string' && value.length > 0) {
    if (/^\d+$/.test(value)) return expiryMs(Number(value));
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function errorDetails(error) {
  return {
    message: error.message,
    code: error.code,
    name: error.name,
    ...(error.data !== undefined && { data: error.data }),
    ...(error.cliError !== undefined && { cliError: error.cliError }),
    ...(error.stdout !== undefined && { stdout: error.stdout }),
    ...(error.raw !== undefined && { raw: error.raw }),
  };
}

function validateTransaction(tx) {
  if (!object(tx) || !ADDRESS.test(tx.from ?? '') || !ADDRESS.test(tx.to ?? '')) {
    throw fail('Transaction from and to must be full EVM addresses', 'BAW_INVALID_INPUT');
  }
  if (typeof tx.value !== 'string' || !/^(?:\d+|0[xX][0-9a-fA-F]+)$/.test(tx.value) || tx.value.length > 80) {
    throw fail('Transaction value must be a non-negative integer string in wei', 'BAW_INVALID_INPUT');
  }
  if (BigInt(tx.value) > UINT256_MAX) {
    throw fail('Transaction value exceeds uint256', 'BAW_INVALID_INPUT');
  }
  if (typeof tx.data !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(tx.data) || tx.data.length > 262146) {
    throw fail('Transaction data must be byte-aligned 0x-prefixed calldata', 'BAW_INVALID_INPUT');
  }
}

function walletAddress(data) {
  if (!object(data) || !Array.isArray(data.addresses)) throw fail('Malformed baw wallet address response');
  const entry = data.addresses.find(item => object(item) && String(item.binanceChainId) === CHAIN);
  if (!entry) return null;
  if (typeof entry.address !== 'string' || !ADDRESS.test(entry.address)) throw fail('Malformed BSC wallet address');
  return entry.address;
}

function nativeBalance(data) {
  if (!Array.isArray(data)) throw fail('Malformed baw wallet balance response');
  const native = data.find(item => object(item) && String(item.binanceChainId) === CHAIN && typeof item.address === 'string' && /^0x[eE]{40}$/.test(item.address));
  // CLI 会隐藏低于 $0.01 的余额。缺失条目只能视为未知，不能当作 0。
  if (!native) return null;
  if (typeof native.balance !== 'string' || !DECIMAL.test(native.balance)) throw fail('Malformed native BNB balance');
  return native.balance;
}

function walletQuota(data) {
  if (!object(data) || !['quotaUsed', 'quotaLeft', 'dailyLimit'].every(key => typeof data[key] === 'number' && Number.isFinite(data[key])) || typeof data.date !== 'string') {
    throw fail('Malformed baw wallet quota response');
  }
  const { quotaUsed, quotaLeft, dailyLimit, date } = data;
  return { quotaUsed, quotaLeft, dailyLimit, date };
}

function developerMode(data) {
  if (!object(data) || !Object.hasOwn(data, 'devMode') || (data.devMode !== null && !object(data.devMode))) {
    throw fail('Malformed baw Developer Mode response');
  }
  if (data.devMode === null) return null;
  return {
    ...data.devMode,
    ...(Object.hasOwn(data, 'developerModeQuotaUsed') && { quotaUsed: data.developerModeQuotaUsed }),
    ...(Object.hasOwn(data, 'developerModeQuotaDate') && { quotaDate: data.developerModeQuotaDate }),
  };
}

/**
 * run(binary, args, options) returns { stdout, stderr, code? } or rejects with
 * an execFile-style error containing stdout/stderr. All CLI calls use argv,
 * shell:false, bounded output, and a timeout. This adapter never reads session files.
 */
export function createBaw({ binary = process.env.BAW_BIN || undefined, run = execFileAsync } = {}) {
  const useBundledEntry = binary === undefined && existsSync(bundledEntry);
  if (binary === undefined) binary = useBundledEntry ? process.execPath : 'baw';
  if (typeof binary !== 'string' || !binary || /[\0\r\n]/.test(binary) || typeof run !== 'function') {
    throw fail('Invalid baw executable or runner', 'BAW_INVALID_INPUT');
  }

  async function command(args, { timeout = TIMEOUT_MS, signal } = {}) {
    let result;
    let executionError;
    try {
      // Run the bundled JS with Node directly; npm's shell shims cannot be execFile'd on Windows.
      result = await run(binary, [...(useBundledEntry ? [bundledEntry] : []), ...args, '--json'], {
        shell: false,
        encoding: 'utf8',
        timeout,
        ...(signal ? { signal } : {}),
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
      });
    } catch (error) {
      executionError = error;
      // 超时/进程中断不能仅凭一段 success 输出宣告成功。
      if (error.killed || error.signal || error.code === 'ETIMEDOUT' || error.code === 'ENOENT' || error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw error;
      result = { stdout: error.stdout, stderr: error.stderr, code: error.code };
    }
    const stdout = typeof result?.stdout === 'string' ? result.stdout : '';
    const stderr = typeof result?.stderr === 'string' ? result.stderr : '';
    const exitCode = result?.code ?? result?.exitCode ?? 0;
    let envelope;
    try {
      envelope = JSON.parse(stdout);
    } catch {
      throw fail('baw returned malformed JSON', 'BAW_MALFORMED_JSON', { stdout, stderr, exitCode, cause: executionError });
    }
    if (!object(envelope) || typeof envelope.success !== 'boolean') {
      throw fail('baw returned an invalid response envelope', 'BAW_INVALID_RESPONSE', { stdout, stderr, raw: envelope });
    }
    if (!envelope.success) {
      if (!object(envelope.error) || typeof envelope.error.message !== 'string') {
        throw fail('baw returned a malformed error response', 'BAW_INVALID_RESPONSE', { stdout, stderr, raw: envelope });
      }
      const upstream = envelope.error;
      throw fail(upstream.message, upstream.code, {
        name: typeof upstream.name === 'string' ? upstream.name : 'BawError',
        data: upstream.data,
        cliError: upstream,
        stdout,
        stderr,
        raw: envelope,
        exitCode,
      });
    }
    if (executionError || exitCode !== 0) {
      throw fail('baw exited unsuccessfully despite a success response', 'BAW_PROCESS_FAILED', { stdout, stderr, raw: envelope, exitCode, cause: executionError });
    }
    if (!Object.hasOwn(envelope, 'data')) {
      throw fail('baw response is missing data', 'BAW_INVALID_RESPONSE', { stdout, stderr, raw: envelope });
    }
    return envelope.data;
  }

  async function status() {
    const data = await command(['wallet', 'status']);
    if (!object(data) || !['UNCONNECTED', 'CREATING', 'CONNECTED'].includes(data.status)) throw fail('Malformed baw wallet status response');
    return data;
  }

  async function wallet() {
    const state = { available: true, status: null, address: null, balance: null, quota: null, devMode: null, raw: {} };
    let connection;
    try {
      connection = await status();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return { ...state, available: false, error: error.message, errors: { status: errorDetails(error) } };
    }
    state.status = connection.status;
    state.raw.status = connection;
    if (connection.status !== 'CONNECTED') return state;
    const queries = [
      ['address', 'address', ['wallet', 'address'], walletAddress],
      ['balance', 'balance', ['wallet', 'balance', '--binanceChainId', CHAIN], nativeBalance],
      ['quota', 'quota', ['wallet', 'left-quota'], walletQuota],
      ['devMode', 'settings', ['wallet', 'settings'], developerMode],
    ];
    const results = await Promise.allSettled(queries.map(async ([, , args, normalize]) => {
      const raw = await command(args);
      return { raw, value: normalize(raw) };
    }));
    const errors = {};
    for (let index = 0; index < results.length; index++) {
      const [field, rawField] = queries[index];
      const result = results[index];
      if (result.status === 'fulfilled') {
        state[field] = result.value.value;
        state.raw[rawField] = result.value.raw;
      } else {
        errors[field] = errorDetails(result.reason);
      }
    }
    if (Object.keys(errors).length) {
      state.errors = errors;
      state.error = Object.values(errors).map(error => error.message).join('; ');
    }
    return state;
  }

  async function preview(transaction) {
    validateTransaction(transaction);
    // 不用 wallet() 的缓存；每次预览都重新核对账户及用户在 App 设置的权限。
    if ((await status()).status !== 'CONNECTED') throw fail('Agentic Wallet is not connected', 'BAW_NOT_CONNECTED');
    const [addressData, settingsData] = await Promise.all([
      command(['wallet', 'address']),
      command(['wallet', 'settings']),
    ]);
    const address = walletAddress(addressData);
    if (!address || address.toLowerCase() !== transaction.from.toLowerCase()) {
      throw fail('Transaction from does not match the current Agentic Wallet BSC address', 'BAW_ACCOUNT_MISMATCH');
    }
    const devMode = developerMode(settingsData);
    if (devMode?.enabled !== true) throw fail('Developer Mode must be enabled in the Binance App', 'BAW_DEV_MODE_DISABLED');
    const expiry = expiryMs(devMode.expiresAt);
    if (expiry === null || expiry <= Date.now()) throw fail('Developer Mode expiry is missing, invalid or expired', 'BAW_DEV_MODE_EXPIRED');
    if (devMode.balanceExceeded === true) throw fail('Developer Mode wallet balance exceeds its configured limit', 'BAW_DEV_MODE_BALANCE_EXCEEDED');
    const data = await command([
      'contract-call', 'preview', '--binanceChainId', CHAIN,
      '--from', transaction.from, '--to', transaction.to,
      '--value', transaction.value, '--inputData', transaction.data,
    ]);
    const previewExpiry = object(data) ? expiryMs(data.expiresAt) : null;
    if (!object(data) || !validRequestId(data.requestId) || previewExpiry === null || previewExpiry <= Date.now()) {
      throw fail('baw preview is missing a usable requestId or has invalid/expired expiry', 'BAW_INVALID_PREVIEW', { data });
    }
    return data;
  }

  async function execute(requestId) {
    if (!validRequestId(requestId)) throw fail('Invalid preview requestId', 'BAW_INVALID_INPUT');
    // 调用者负责一次性确认、预览绑定与过期检查；这里不添加 --yes 或自动确认逻辑。
    return command(['contract-call', 'execute', '--requestId', requestId]);
  }

  async function txLock() {
    const data = await command(['wallet', 'tx-lock', '--binanceChainId', CHAIN]);
    if (!object(data) || !['LOCKED', 'UNLOCKED'].includes(data.status)) throw fail('Malformed baw transaction lock response');
    return data;
  }

  async function authStart() {
    const data = await command(['auth', 'signin']);
    if (data?.status === 'ALREADY_CONNECTED') return data;
    let url;
    try { url = new URL(data?.urlForWeb); } catch { throw fail('登录响应缺少有效链接'); }
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !(url.hostname === 'binance.com' || url.hostname.endsWith('.binance.com'))) throw fail('登录响应不是 Binance 官方 HTTPS 链接');
    if (!validRequestId(data.qrCodeId) || typeof data.pairingCode !== 'string' || !/^[A-Za-z0-9-]{1,32}$/.test(data.pairingCode) || (expiryMs(data.expireAt) ?? 0) <= Date.now()) throw fail('登录响应缺少有效配对码或已过期');
    // 保留原始 URL、配对码和 expireAt，不重组查询串。
    return data;
  }

  async function authVerify(qrCodeId, { signal } = {}) {
    if (!validRequestId(qrCodeId)) throw fail('Invalid QR code ID', 'BAW_INVALID_INPUT');
    const data = await command(['auth', 'verify', '--qrCodeId', qrCodeId], { timeout: 330_000, signal });
    if (data?.status !== 'SUCCESS') throw fail('钱包登录验证未成功');
    return data;
  }

  return { wallet, status, preview, execute, txLock, authStart, authVerify };
}
