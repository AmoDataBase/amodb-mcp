import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import Ajv from 'ajv';

const ENTRY = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const KEY = '0123456789abcdef0123456789abcdef';
const EXPECTED_TOOLS = [
  'discover_movies',
  'find_by_external_id',
  'get_movie',
  'get_person',
  'get_season',
  'get_tv_show',
  'search_titles',
  'trending',
];

// Strip AMODB_* variables of the developer machine unless a test sets them on purpose.
function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const name of ['AMODB_API_KEY', 'AMODB_LANGUAGE', 'AMODB_BASE_URL']) {
    if (!(name in extra)) delete env[name];
  }
  return env;
}

// ---- raw stdio, no SDK on the client side ----
function rawSession(env) {
  const child = spawn(process.execPath, [ENTRY], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map();
  const seen = new Map();
  let buffer = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => (stderr += chunk));
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const message = JSON.parse(line); // any non JSON on stdout would throw here
      if (message.id !== undefined) {
        seen.set(message.id, message);
        waiting.get(message.id)?.(message);
      }
    }
  });
  return {
    send: (message) => child.stdin.write(JSON.stringify(message) + '\n'),
    reply: (id) =>
      new Promise((resolve, reject) => {
        if (seen.has(id)) return resolve(seen.get(id));
        const timer = setTimeout(() => reject(new Error(`no reply for id ${id}; stderr: ${stderr}`)), 10_000);
        waiting.set(id, (message) => {
          clearTimeout(timer);
          resolve(message);
        });
      }),
    stderr: () => stderr,
    close: () => child.kill(),
  };
}

test('tools/list over raw stdio returns the 8 tools with descriptions and valid schemas', async () => {
  const session = rawSession(childEnv());
  try {
    session.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0.0.0' } },
    });
    const init = await session.reply(1);
    assert.equal(init.result.serverInfo.name, 'amodb-mcp');
    assert.equal(init.result.serverInfo.version, '0.1.0');
    session.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    session.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const list = await session.reply(2);

    const tools = list.result.tools;
    assert.deepEqual(tools.map((t) => t.name).sort(), EXPECTED_TOOLS);
    const ajv = new Ajv({ strict: false });
    for (const tool of tools) {
      assert.match(tool.name, /^[a-z]+(_[a-z]+)*$/);
      assert.ok(tool.description && tool.description.length > 40, `${tool.name} needs a description`);
      assert.equal(tool.inputSchema.type, 'object');
      assert.doesNotThrow(() => ajv.compile(tool.inputSchema), `${tool.name} schema compiles`);
      for (const [field, schema] of Object.entries(tool.inputSchema.properties ?? {})) {
        assert.ok(schema.description, `${tool.name}.${field} needs a description`);
      }
      assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name} is read only`);
    }
    assert.match(session.stderr(), /AMODB_API_KEY is not set/);
  } finally {
    session.close();
  }
});

// ---- stub API ----
const requests = [];
let rateLimitHits = 0;
let stub;
let baseUrl;

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

function items(count) {
  return Array.from({ length: count }, (_, i) => ({ id: i + 1, title: `Title ${i + 1}`, media_type: 'movie' }));
}

before(async () => {
  stub = createServer((req, res) => {
    const url = new URL(req.url, 'http://stub.local');
    requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers });
    const { pathname } = url;
    if (pathname === '/3/search/multi' || pathname === '/3/search/movie') {
      return sendJson(res, 200, { page: 1, results: items(15), total_pages: 3, total_results: 55 });
    }
    if (pathname === '/3/movie/550') return sendJson(res, 200, { id: 550, title: 'Fight Club', runtime: 139 });
    if (pathname === '/3/movie/404404') {
      return sendJson(res, 404, { success: false, status_code: 34, status_message: 'The resource you requested could not be found.' });
    }
    if (pathname === '/3/movie/777') {
      if (rateLimitHits++ === 0) {
        return sendJson(res, 429, { success: false, status_code: 25, status_message: 'Over the limit.' }, { 'Retry-After': '0' });
      }
      return sendJson(res, 200, { id: 777, title: 'Retried' });
    }
    if (pathname === '/3/find/tt0137523') {
      return sendJson(res, 200, { movie_results: [{ id: 550, title: 'Fight Club' }], tv_results: [], person_results: [] });
    }
    if (pathname === '/3/tv/1399') return sendJson(res, 200, { id: 1399, name: 'Game of Thrones' });
    if (pathname === '/3/tv/1399/season/1') {
      return sendJson(res, 200, { id: 3624, season_number: 1, episodes: [{ episode_number: 1, name: 'Winter Is Coming' }] });
    }
    if (pathname === '/3/person/287') return sendJson(res, 200, { id: 287, name: 'Brad Pitt' });
    if (pathname === '/3/trending/tv/week') return sendJson(res, 200, { page: 1, results: items(20) });
    if (pathname === '/3/discover/movie') return sendJson(res, 200, { page: 1, results: items(20), total_results: 20 });
    sendJson(res, 404, { success: false, status_code: 34, status_message: 'The resource you requested could not be found.' });
  });
  await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${stub.address().port}/3`;
});

after(async () => {
  await new Promise((resolve) => stub.close(resolve));
});

async function withClient(env, fn) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [ENTRY], env, stderr: 'ignore' });
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

const keyed = (extra = {}) => ({ AMODB_API_KEY: KEY, AMODB_BASE_URL: baseUrl, ...extra });
const textOf = (result) => result.content[0].text;
const last = () => requests[requests.length - 1];

describe('tool calls against a stub API', () => {
  test('search_titles sends Bearer auth, the right path and query, and trims to 10', async () => {
    await withClient(keyed(), async (client) => {
      const result = await client.callTool({ name: 'search_titles', arguments: { query: 'fight club', page: 2 } });
      assert.ok(!result.isError);
      const data = JSON.parse(textOf(result));
      assert.equal(data.results.length, 10);
      assert.equal(data.returned, 10);
      assert.equal(data.total_results, 55);
      assert.equal(last().path, '/3/search/multi');
      assert.equal(last().query.query, 'fight club');
      assert.equal(last().query.page, '2');
      assert.equal(last().headers.authorization, `Bearer ${KEY}`);
      assert.ok(!('api_key' in last().query));
    });
  });

  test('search_titles honours limit and maps year to the movie parameter', async () => {
    await withClient(keyed(), async (client) => {
      const result = await client.callTool({
        name: 'search_titles',
        arguments: { query: 'fight club', media_type: 'movie', year: 1999, limit: 3 },
      });
      assert.equal(JSON.parse(textOf(result)).results.length, 3);
      assert.equal(last().path, '/3/search/movie');
      assert.equal(last().query.year, '1999');
    });
  });

  test('get_movie joins append and passes language, and keeps the full object', async () => {
    await withClient(keyed(), async (client) => {
      const result = await client.callTool({
        name: 'get_movie',
        arguments: { id: 550, append: ['credits', 'watch/providers'], language: 'ru-RU' },
      });
      assert.deepEqual(JSON.parse(textOf(result)), { id: 550, title: 'Fight Club', runtime: 139 });
      assert.equal(last().path, '/3/movie/550');
      assert.equal(last().query.append_to_response, 'credits,watch/providers');
      assert.equal(last().query.language, 'ru-RU');
    });
  });

  test('AMODB_LANGUAGE is the default and a call can override it', async () => {
    await withClient(keyed({ AMODB_LANGUAGE: 'uk-UA' }), async (client) => {
      await client.callTool({ name: 'get_movie', arguments: { id: 550 } });
      assert.equal(last().query.language, 'uk-UA');
      await client.callTool({ name: 'get_movie', arguments: { id: 550, language: 'pt-BR' } });
      assert.equal(last().query.language, 'pt-BR');
    });
  });

  test('find_by_external_id passes external_source', async () => {
    await withClient(keyed(), async (client) => {
      const result = await client.callTool({
        name: 'find_by_external_id',
        arguments: { external_id: 'tt0137523', external_source: 'imdb_id' },
      });
      assert.equal(JSON.parse(textOf(result)).movie_results[0].id, 550);
      assert.equal(last().path, '/3/find/tt0137523');
      assert.equal(last().query.external_source, 'imdb_id');
    });
  });

  test('get_tv_show, get_season and get_person hit the right paths', async () => {
    await withClient(keyed(), async (client) => {
      await client.callTool({ name: 'get_tv_show', arguments: { id: 1399, append: ['content_ratings'] } });
      assert.equal(last().path, '/3/tv/1399');
      assert.equal(last().query.append_to_response, 'content_ratings');

      const season = await client.callTool({ name: 'get_season', arguments: { tv_id: 1399, season_number: 1 } });
      assert.equal(last().path, '/3/tv/1399/season/1');
      assert.equal(JSON.parse(textOf(season)).episodes.length, 1);

      await client.callTool({ name: 'get_person', arguments: { id: 287, append: ['combined_credits'] } });
      assert.equal(last().path, '/3/person/287');
      assert.equal(last().query.append_to_response, 'combined_credits');
    });
  });

  test('trending uses the media type and window and trims the list', async () => {
    await withClient(keyed(), async (client) => {
      const result = await client.callTool({
        name: 'trending',
        arguments: { media_type: 'tv', time_window: 'week', limit: 5 },
      });
      assert.equal(last().path, '/3/trending/tv/week');
      assert.equal(JSON.parse(textOf(result)).results.length, 5);
    });
  });

  test('discover_movies maps filters to TMDB query names', async () => {
    await withClient(keyed(), async (client) => {
      const result = await client.callTool({
        name: 'discover_movies',
        arguments: {
          with_genres: [878, 12],
          primary_release_year: 2010,
          sort_by: 'vote_average.desc',
          vote_average_gte: 7.5,
          vote_count_gte: 500,
          with_original_language: 'en',
          region: 'US',
        },
      });
      assert.equal(JSON.parse(textOf(result)).results.length, 10);
      assert.equal(last().path, '/3/discover/movie');
      assert.equal(last().query.with_genres, '878,12');
      assert.equal(last().query.primary_release_year, '2010');
      assert.equal(last().query.sort_by, 'vote_average.desc');
      assert.equal(last().query['vote_average.gte'], '7.5');
      assert.equal(last().query['vote_count.gte'], '500');
      assert.equal(last().query.with_original_language, 'en');
      assert.equal(last().query.region, 'US');
    });
  });

  test('a 429 with Retry-After 0 is retried once and the call succeeds', async () => {
    rateLimitHits = 0;
    await withClient(keyed(), async (client) => {
      const before = requests.length;
      const result = await client.callTool({ name: 'get_movie', arguments: { id: 777 } });
      assert.ok(!result.isError);
      assert.equal(JSON.parse(textOf(result)).title, 'Retried');
      assert.equal(requests.length - before, 2);
    });
  });

  test('a 404 TMDB error returns an isError result with a readable message', async () => {
    await withClient(keyed(), async (client) => {
      const result = await client.callTool({ name: 'get_movie', arguments: { id: 404404 } });
      assert.equal(result.isError, true);
      assert.equal(
        textOf(result),
        'amodb API error (HTTP 404, status_code 34): The resource you requested could not be found.',
      );
    });
  });

  test('invalid arguments come back as an error result, not a crash', async () => {
    await withClient(keyed(), async (client) => {
      const result = await client.callTool({ name: 'get_movie', arguments: { id: 'abc' } });
      assert.equal(result.isError, true);
    });
  });

  test('a missing key returns the AMODB_API_KEY error and sends no request', async () => {
    const env = { AMODB_BASE_URL: baseUrl };
    await withClient(env, async (client) => {
      const before = requests.length;
      const tools = await client.listTools();
      assert.equal(tools.tools.length, 8);
      for (const call of [
        { name: 'search_titles', arguments: { query: 'x' } },
        { name: 'get_movie', arguments: { id: 550 } },
      ]) {
        const result = await client.callTool(call);
        assert.equal(result.isError, true);
        assert.equal(textOf(result), 'AMODB_API_KEY is not set. Get a key at https://amodb.dev/pricing');
      }
      assert.equal(requests.length, before);
    });
  });
});
