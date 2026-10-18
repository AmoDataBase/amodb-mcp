import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AmodbApiError, AmodbClient, MissingApiKeyError, buildQuery, parseRetryAfter, seg } from '../dist/api.js';

const KEY = '0123456789abcdef0123456789abcdef';

function jsonResponse(status, body, headers = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
}

function scripted(responses) {
  const calls = [];
  const fetchStub = async (url, init) => {
    calls.push({ url, init });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    return typeof next === 'function' ? next(url, init) : next();
  };
  return { calls, fetchStub };
}

test('buildQuery joins arrays, drops undefined and null, encodes values', () => {
  const q = buildQuery({
    append_to_response: ['credits', 'watch/providers'],
    a: undefined,
    b: null,
    empty: [],
    query: 'fight club & more',
    page: 2,
    flag: false,
  });
  assert.equal(q, 'append_to_response=credits,watch/providers&query=fight%20club%20%26%20more&page=2&flag=false');
});

test('seg percent-encodes path segments', () => {
  assert.equal(seg('tt01/37'), 'tt01%2F37');
  assert.equal(seg(550), '550');
});

test('parseRetryAfter reads seconds and HTTP dates', () => {
  assert.equal(parseRetryAfter('7'), 7);
  assert.equal(parseRetryAfter(null), null);
  assert.equal(parseRetryAfter('soon'), null);
  const now = Date.parse('2026-10-18T10:00:00Z');
  assert.equal(parseRetryAfter('Sun, 18 Oct 2026 10:00:05 GMT', now), 5);
});

test('get sends the Bearer header, the default language and no key in the URL', async () => {
  const { calls, fetchStub } = scripted([() => jsonResponse(200, { id: 550 })]);
  const client = new AmodbClient({ apiKey: KEY, language: 'ru-RU', fetch: fetchStub });
  assert.deepEqual(await client.get('/movie/550', { language: undefined }), { id: 550 });
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(calls[0].url, 'https://api.amodb.dev/3/movie/550?language=ru-RU');
  assert.ok(!calls[0].url.includes(KEY));
});

test('a per call language overrides the default', async () => {
  const { calls, fetchStub } = scripted([() => jsonResponse(200, {})]);
  const client = new AmodbClient({ apiKey: KEY, language: 'ru-RU', fetch: fetchStub });
  await client.get('/movie/550', { language: 'pt-BR' });
  assert.equal(calls[0].url, 'https://api.amodb.dev/3/movie/550?language=pt-BR');
});

test('a missing key throws before any request', async () => {
  const { calls, fetchStub } = scripted([() => jsonResponse(200, {})]);
  const client = new AmodbClient({ apiKey: '  ', fetch: fetchStub });
  await assert.rejects(client.get('/movie/550'), MissingApiKeyError);
  assert.equal(calls.length, 0);
});

test('429 is retried using Retry-After and then succeeds', async () => {
  const waits = [];
  const { calls, fetchStub } = scripted([
    () => jsonResponse(429, { status_code: 25, status_message: 'Over the limit.' }, { 'Retry-After': '2' }),
    () => jsonResponse(200, { ok: true }),
  ]);
  const client = new AmodbClient({ apiKey: KEY, fetch: fetchStub, sleep: async (ms) => waits.push(ms) });
  assert.deepEqual(await client.get('/movie/1'), { ok: true });
  assert.deepEqual(waits, [2000]);
  assert.equal(calls.length, 2);
});

test('Retry-After is clamped to 10 seconds', async () => {
  const waits = [];
  const { fetchStub } = scripted([
    () => jsonResponse(429, {}, { 'Retry-After': '120' }),
    () => jsonResponse(200, {}),
  ]);
  const client = new AmodbClient({ apiKey: KEY, fetch: fetchStub, sleep: async (ms) => waits.push(ms) });
  await client.get('/movie/1');
  assert.deepEqual(waits, [10000]);
});

test('a missing Retry-After backs off 1, 2, 4 seconds and stops after 3 retries', async () => {
  const waits = [];
  const { calls, fetchStub } = scripted([
    () => jsonResponse(429, { status_code: 25, status_message: 'Your request count (21) is over the allowed limit of (20).' }),
  ]);
  const client = new AmodbClient({ apiKey: KEY, fetch: fetchStub, sleep: async (ms) => waits.push(ms), maxRetries: 9 });
  await assert.rejects(client.get('/movie/1'), (err) => {
    assert.ok(err instanceof AmodbApiError);
    assert.equal(err.status, 429);
    assert.equal(err.statusCode, 25);
    return true;
  });
  assert.deepEqual(waits, [1000, 2000, 4000]);
  assert.equal(calls.length, 4);
});

test('a TMDB error body becomes a readable message with status_code', async () => {
  const { fetchStub } = scripted([
    () => jsonResponse(404, { success: false, status_code: 34, status_message: 'The resource you requested could not be found.' }),
  ]);
  const client = new AmodbClient({ apiKey: KEY, fetch: fetchStub });
  await assert.rejects(client.get('/movie/0'), (err) => {
    assert.equal(err.status, 404);
    assert.equal(err.statusCode, 34);
    assert.equal(err.message, 'amodb API error (HTTP 404, status_code 34): The resource you requested could not be found.');
    return true;
  });
});

test('an invalid key error points at AMODB_API_KEY', async () => {
  const { fetchStub } = scripted([
    () => jsonResponse(401, { success: false, status_code: 7, status_message: 'Invalid API key: You must be granted a valid key.' }),
  ]);
  const client = new AmodbClient({ apiKey: KEY, fetch: fetchStub });
  await assert.rejects(client.get('/movie/1'), /status_code 7.*AMODB_API_KEY/);
});

test('a non JSON error body still gives an error with the HTTP status', async () => {
  const { fetchStub } = scripted([() => new Response('<html>Bad gateway</html>', { status: 502 })]);
  const client = new AmodbClient({ apiKey: KEY, fetch: fetchStub });
  await assert.rejects(client.get('/movie/1'), (err) => {
    assert.equal(err.status, 502);
    assert.equal(err.statusCode, null);
    assert.match(err.message, /HTTP 502/);
    return true;
  });
});

test('a request that exceeds the timeout is aborted', async () => {
  const hang = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
  const client = new AmodbClient({ apiKey: KEY, fetch: hang, timeoutMs: 20 });
  await assert.rejects(client.get('/movie/1'), (err) => {
    assert.equal(err.status, 0);
    assert.match(err.message, /timed out/);
    return true;
  });
});

test('a network failure names the host and not the key', async () => {
  const boom = async () => {
    throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:1') });
  };
  const client = new AmodbClient({ apiKey: KEY, baseUrl: 'http://127.0.0.1:1/3', fetch: boom });
  await assert.rejects(client.get('/movie/1'), (err) => {
    assert.match(err.message, /127\.0\.0\.1:1/);
    assert.match(err.message, /ECONNREFUSED/);
    assert.ok(!err.message.includes(KEY));
    return true;
  });
});
