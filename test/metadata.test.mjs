import test from 'node:test';
import assert from 'node:assert/strict';
import { createMetadataService, createPublicResolver } from '../src/metadata.mjs';

const TOKEN = '0xc81880b885a0e354857cd7799ba6f35929b44444';
const OTHER = '0x86bb94ddd16efc8bc58e6b056e8df71d9e666429';
const IMAGE = 'https://static.four.meme/market/1024I2jn9BM1FC.jpg';
const META = 'https://static.four.meme/market/token.json';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const json = (data, init) => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' }, ...init });
const api = (data = {}) => json({ code: 0, msg: 'success', data: { address: TOKEN, image: IMAGE, name: 'fourball', descr: '111', ...data } });
const state = { address: TOKEN, verified: true, tokenMetaUri: META };

test('uses the exact full CA endpoint and parses observed Four API shape', async () => {
  const service = createMetadataService({ fetchImpl: async (url, options) => {
    assert.equal(url, `https://four.meme/meme-api/v1/private/token/get/v2?address=${TOKEN}`);
    assert.equal(options.redirect, 'manual');
    return api();
  } });
  const result = await service.getMetadata(TOKEN);
  assert.equal(result.imageUrl, IMAGE);
  assert.equal(result.name, 'fourball');
  assert.equal(result.description, '111');
  assert.equal(result.source, 'four.meme-api');
  assert.ok(Number.isFinite(Date.parse(result.updatedAt)));
});

test('rejects a returned token address mismatch and empty API result', async () => {
  for (const response of [api({ address: OTHER }), json({ code: 0, msg: 'success' }), json({ code: 1, data: { address: TOKEN, image: IMAGE } })]) {
    const service = createMetadataService({ fetchImpl: async () => response });
    assert.equal((await service.getMetadata(TOKEN)).imageUrl, null);
    assert.equal(await service.getImage(TOKEN), null);
  }
});

test('requires a valid nonzero CA before issuing any request', async () => {
  const service = createMetadataService({ fetchImpl: () => assert.fail('invalid CA reached network') });
  for (const token of ['fourball', '0x1234', '0x' + '0'.repeat(40), TOKEN + '?url=http://localhost']) {
    await assert.rejects(service.getMetadata(token), /address/i);
    await assert.rejects(service.getImage(token), /address/i);
  }
});

test('reads metadata only from matching verified state and resolves its image', async () => {
  const service = createMetadataService({ fetchImpl: async url => {
    assert.equal(url, META);
    return json({ name: 'chain metadata', description: 'original description', image: IMAGE });
  } });
  const result = await service.getMetadata(TOKEN, state);
  assert.equal(result.source, 'tokenMetaUri');
  assert.equal(result.imageUrl, IMAGE);
  assert.equal(result.description, 'original description');
  for (const badState of [{ ...state, verified: false }, { ...state, address: OTHER }]) {
    const fallback = createMetadataService({ fetchImpl: async url => {
      assert.match(url, /\/private\/token\/get\/v2\?address=/);
      return api();
    } });
    assert.equal((await fallback.getMetadata(TOKEN, badState)).source, 'four.meme-api');
  }
});

test('rewrites an IPFS URI to one fixed gateway and keeps the content path', async () => {
  const cid = 'QmYwAPJzv5CZsnAzt8auVTLpX5L6iAYz6Q8nR4GNzZ6U8n';
  const service = createMetadataService({ fetchImpl: async url => {
    assert.equal(url, `https://ipfs.io/ipfs/${cid}/metadata.json`);
    return json({ image: IMAGE });
  } });
  assert.equal((await service.getMetadata(TOKEN, { ...state, tokenMetaUri: `ipfs://${cid}/metadata.json` })).imageUrl, IMAGE);
});

test('blocks arbitrary hosts, credentials, ports and non-HTTPS image URLs', async () => {
  for (const image of ['http://static.four.meme/a.png', 'https://localhost/a.png', 'https://127.0.0.1/a.png', 'https://2130706433/a.png', 'https://[::1]/a.png', 'https://static.four.meme.evil.example/a.png', 'https://static.four.meme@evil.example/a.png', 'https://user:pass@static.four.meme/a.png', 'https://static.four.meme:8443/a.png', 'data:image/png;base64,abc', 'https://arbitrary.example/a.png']) {
    const service = createMetadataService({ fetchImpl: async () => api({ image }) });
    assert.equal((await service.getMetadata(TOKEN)).imageUrl, null, image);
  }
});

test('never follows a redirect to an unsafe host', async () => {
  let requests = 0;
  const service = createMetadataService({ fetchImpl: async url => {
    requests++;
    if (url.includes('/get/v2?')) return api();
    assert.equal(url, IMAGE);
    return new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/secret' } });
  } });
  assert.equal(await service.getImage(TOKEN), null);
  assert.equal(requests, 2);
});

test('caps allowed redirects and accepts a safe relative redirect', async () => {
  const service = createMetadataService({ fetchImpl: async url => {
    if (url.includes('/get/v2?')) return api();
    if (url === IMAGE) return new Response(null, { status: 302, headers: { location: '/market/safe.png' } });
    assert.equal(url, 'https://static.four.meme/market/safe.png');
    return new Response(PNG);
  } });
  assert.equal((await service.getImage(TOKEN)).contentType, 'image/png');
  let redirects = 0;
  const loop = createMetadataService({ fetchImpl: async url => {
    if (url.includes('/get/v2?')) return api();
    redirects++;
    return new Response(null, { status: 302, headers: { location: IMAGE } });
  } });
  assert.equal(await loop.getImage(TOKEN), null);
  assert.ok(redirects <= 4);
});

test('rejects private, reserved, mapped and mixed DNS answers before connecting', async () => {
  for (const addresses of [['127.0.0.1'], ['10.0.0.1'], ['169.254.169.254'], ['172.16.1.1'], ['192.168.1.1'], ['100.64.0.1'], ['0.0.0.0'], ['192.0.2.1'], ['::1'], ['fc00::1'], ['fe80::1'], ['::ffff:127.0.0.1'], ['8.8.8.8', '127.0.0.1']]) {
    const service = createMetadataService({ resolveHost: async () => addresses.map(address => ({ address, family: address.includes(':') ? 6 : 4 })), timeoutMs: 100 });
    const result = await service.getMetadata(TOKEN);
    assert.equal(result.imageUrl, null);
    assert.match(result.error, /address|DNS|network/i);
  }
});

test('image output uses magic bytes instead of the supplied content type', async () => {
  const service = createMetadataService({ fetchImpl: async url => url.includes('/get/v2?') ? api() : new Response(PNG, { headers: { 'content-type': 'text/html' } }) });
  const result = await service.getImage(TOKEN);
  assert.ok(Buffer.isBuffer(result.body));
  assert.deepEqual(result.body, PNG);
  assert.equal(result.contentType, 'image/png');
  assert.match(result.cacheControl, /max-age=/);
  for (const body of ['<svg xmlns="http://www.w3.org/2000/svg"/>', '<html>not an image</html>', 'GIF89a']) {
    const bad = createMetadataService({ fetchImpl: async url => url.includes('/get/v2?') ? api() : new Response(body, { headers: { 'content-type': 'image/png' } }) });
    assert.equal(await bad.getImage(TOKEN), null);
  }
});

test('rejects oversized streamed JSON and image bodies without trusting content-length', async () => {
  const hugeJson = createMetadataService({ fetchImpl: async () => new Response(' '.repeat(256 * 1024 + 1)) });
  assert.equal((await hugeJson.getMetadata(TOKEN)).imageUrl, null);
  const hugeImage = createMetadataService({ fetchImpl: async url => url.includes('/get/v2?') ? api() : new Response(Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)])) });
  assert.equal(await hugeImage.getImage(TOKEN), null);
});

test('deduplicates concurrent work and expires successful metadata and image caches', async () => {
  let time = 1000, requests = 0;
  const service = createMetadataService({ now: () => time, ttlMs: 100, fetchImpl: async url => {
    requests++;
    await new Promise(resolve => setTimeout(resolve, 1));
    return url.includes('/get/v2?') ? api() : new Response(PNG);
  } });
  const images = await Promise.all(Array.from({ length: 6 }, () => service.getImage(TOKEN)));
  assert.ok(images.every(image => image.contentType === 'image/png'));
  assert.equal(requests, 2);
  await service.getImage(TOKEN);
  assert.equal(requests, 2);
  time += 101;
  await service.getImage(TOKEN);
  assert.equal(requests, 4);
});

test('negative cache suppresses repeated failures but recovers after its TTL', async () => {
  let time = 1000, requests = 0;
  const service = createMetadataService({ now: () => time, negativeTtlMs: 20, fetchImpl: async () => {
    requests++;
    return requests === 1 ? json({ code: 0 }) : api();
  } });
  assert.equal((await service.getMetadata(TOKEN)).imageUrl, null);
  assert.equal((await service.getMetadata(TOKEN)).imageUrl, null);
  assert.equal(requests, 1);
  time += 21;
  assert.equal((await service.getMetadata(TOKEN)).imageUrl, IMAGE);
  assert.equal(requests, 2);
});

test('times out a fetch or a stalled response body instead of hanging the caller', async () => {
  for (const fetchImpl of [async () => new Promise(() => {}), async () => new Response(new ReadableStream({ start() {} }))]) {
    const service = createMetadataService({ timeoutMs: 20, fetchImpl });
    const started = Date.now();
    assert.equal((await service.getMetadata(TOKEN)).imageUrl, null);
    assert.ok(Date.now() - started < 300);
  }
});

test('public resolver replaces fake-IP answers with HTTPS DNS answers and rejects poisoned fallback', async () => {
  const resolveHost = createPublicResolver({
    systemLookup: async () => [{ address: '198.18.3.189', family: 4 }],
    queryDns: async (hostname, { signal }) => {
      assert.equal(hostname, 'four.meme');
      assert.ok(signal instanceof AbortSignal);
      return { Status: 0, Answer: [{ type: 1, data: '104.20.47.25' }, { type: 1, data: '172.66.148.41' }] };
    },
  });
  assert.deepEqual(await resolveHost('four.meme'), [{ address: '104.20.47.25', family: 4 }, { address: '172.66.148.41', family: 4 }]);
  const poisoned = createPublicResolver({
    systemLookup: async () => [{ address: '198.18.3.189', family: 4 }],
    queryDns: async () => ({ Status: 0, Answer: [{ type: 1, data: '127.0.0.1' }] }),
  });
  await assert.rejects(poisoned('four.meme'), /DNS/);
  await assert.rejects(resolveHost('localhost'), /host/);
});
