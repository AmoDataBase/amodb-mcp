import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AmodbClient, DEFAULT_BASE_URL } from './api.js';
import { registerTools } from './tools.js';

export const SERVER_NAME = 'amodb-mcp';

function readVersion(): string {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? '0.1.0';
  } catch {
    return '0.1.0';
  }
}

export const SERVER_VERSION = readVersion();

const INSTRUCTIONS =
  'Movie and TV metadata from amodb. Use search_titles to turn a name into a numeric id, ' +
  'then get_movie, get_tv_show, get_season or get_person for details. ' +
  'Use find_by_external_id for IMDb, Kinopoisk and Wikidata ids, trending for what is popular, discover_movies for filters, ' +
  'and get_showtimes for cinema times. get_movie and get_tv_show can append ratings, moods, soundtracks and wikidata.';

export interface ServerOptions {
  /** Environment to read AMODB_API_KEY, AMODB_LANGUAGE and AMODB_BASE_URL from. Defaults to process.env. */
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export function createServer(options: ServerOptions = {}): McpServer {
  const env = options.env ?? process.env;
  const client = new AmodbClient({
    apiKey: env.AMODB_API_KEY,
    baseUrl: env.AMODB_BASE_URL?.trim() || DEFAULT_BASE_URL,
    language: env.AMODB_LANGUAGE,
    userAgent: `${SERVER_NAME}/${SERVER_VERSION}`,
    fetch: options.fetch,
    sleep: options.sleep,
  });
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });
  registerTools(server, client);
  return server;
}
