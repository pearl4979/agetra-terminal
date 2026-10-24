import { timingSafeEqual } from 'node:crypto';

// 本地钱包桥接服务：防止恶意网页跨站调用，以及 DNS rebinding。
export function guardRequest(req, { port, csrf }) {
  const host = req.headers.host;
  if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(host)) throw new Error('Host 不允许');
  const expectedOrigin = `http://${host}`;
  const origin = req.headers.origin;
  if (origin && origin !== expectedOrigin) throw new Error('Origin 不允许');
  if (req.headers['sec-fetch-site'] === 'cross-site') throw new Error('Origin 跨站访问被拒绝');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    if (origin !== expectedOrigin) throw new Error('Origin 必须为本地面板');
    const supplied = req.headers['x-csrf-token'];
    if (typeof supplied !== 'string' || supplied.length !== csrf.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(csrf))) throw new Error('CSRF token 不匹配');
  }
}

export async function readJson(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('必须使用 application/json');
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 8192) throw new Error('请求超过 8KB');
    chunks.push(chunk);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString());
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JSON 必须是对象');
  return value;
}
