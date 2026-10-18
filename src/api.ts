// Tiny HTTP client for the amodb API (TMDB v3 compatible). No dependencies.

export const DEFAULT_BASE_URL = 'https://api.amodb.dev/3';
export const MISSING_KEY_MESSAGE = 'AMODB_API_KEY is not set. Get a key at https://amodb.dev/pricing';

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RETRIES_CAP = 3;
const MAX_WAIT_MS = 10_000;

export type QueryValue = string | number | boolean | null | undefined | Array<string | number | boolean>;
export type Query = Record<string, QueryValue>;

/** Raised when a tool is called without a key. */
export class MissingApiKeyError extends Error {
  constructor() {
    super(MISSING_KEY_MESSAGE);
    this.name = 'MissingApiKeyError';
  }
}

/** Raised for any failed call. `status` is the HTTP status, or 0 when no response arrived. */
export class AmodbApiError extends Error {
  readonly status: number;
  readonly statusCode: number | null;
  readonly statusMessage: string | null;
  readonly retryAfter: number | null;

  constructor(
    message: string,
    details: { status: number; statusCode?: number | null; statusMessage?: string | null; retryAfter?: number | null },
  ) {
    super(message);
    this.name = 'AmodbApiError';
    this.status = details.status;
    this.statusCode = details.statusCode ?? null;
    this.statusMessage = details.statusMessage ?? null;
    this.retryAfter = details.retryAfter ?? null;
  }
}

/** Percent-encode one path segment. */
export function seg(value: string | number): string {
  return encodeURIComponent(String(value));
}

/** Build a query string: arrays are comma joined, null and undefined are dropped. */
export function buildQuery(params: Query): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    let text: string;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      text = value.join(',');
    } else {
      text = String(value);
    }
    const encoded = encodeURIComponent(text).replace(/%2C/gi, ',').replace(/%2F/gi, '/');
    parts.push(`${encodeURIComponent(key)}=${encoded}`);
  }
  return parts.join('&');
}

/** Parse a Retry-After header (integer seconds or an HTTP date) into seconds, or null. */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const when = Date.parse(trimmed);
  if (Number.isNaN(when)) return null;
  return Math.max(0, Math.ceil((when - now) / 1000));
}

export interface ClientOptions {
  apiKey?: string;
  baseUrl?: string;
  /** Default language tag, for example ru-RU. A per call `language` wins. */
  language?: string;
  timeoutMs?: number;
  /** Retries on HTTP 429. Capped at 3. */
  maxRetries?: number;
  userAgent?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

interface RawResponse {
  status: number;
  headers: Headers;
  text: string;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class AmodbClient {
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly language: string | undefined;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly userAgent: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: ClientOptions = {}) {
    this.apiKey = options.apiKey?.trim() || undefined;
    this.baseUrl = (options.baseUrl?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.language = options.language?.trim() || undefined;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = Math.max(0, Math.min(options.maxRetries ?? MAX_RETRIES_CAP, MAX_RETRIES_CAP));
    this.userAgent = options.userAgent ?? 'amodb-mcp/0.1.0';
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /** GET `path` (starting with a slash) and return the parsed JSON body. */
  async get(path: string, params: Query = {}): Promise<unknown> {
    if (!this.apiKey) throw new MissingApiKeyError();
    const query = buildQuery({ language: this.language, ...dropUndefined(params) });
    const url = `${this.baseUrl}${path}${query ? `?${query}` : ''}`;

    for (let attempt = 0; ; attempt++) {
      const response = await this.once(url);
      if (response.status === 429 && attempt < this.maxRetries) {
        await this.sleep(retryWaitMs(response.headers.get('retry-after'), attempt));
        continue;
      }
      return this.parse(response);
    }
  }

  private async once(url: string): Promise<RawResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
          'User-Agent': this.userAgent,
        },
        signal: controller.signal,
      });
      const text = await res.text();
      return { status: res.status, headers: res.headers, text };
    } catch (err) {
      if (controller.signal.aborted) {
        throw new AmodbApiError(`The request to amodb timed out after ${Math.round(this.timeoutMs / 1000)} s. Try again.`, {
          status: 0,
        });
      }
      const reason = err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err);
      throw new AmodbApiError(`Could not reach amodb at ${hostOf(url)}: ${reason}`, { status: 0 });
    } finally {
      clearTimeout(timer);
    }
  }

  private parse(response: RawResponse): unknown {
    let body: unknown;
    let isJson = false;
    try {
      body = response.text.length > 0 ? JSON.parse(response.text) : undefined;
      isJson = body !== undefined;
    } catch {
      body = undefined;
    }

    if (response.status >= 200 && response.status < 300) {
      if (!isJson) {
        throw new AmodbApiError(`amodb returned an empty or non JSON body (HTTP ${response.status}).`, {
          status: response.status,
        });
      }
      return body;
    }

    const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
    const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const statusMessage = typeof record.status_message === 'string' ? record.status_message : null;
    const statusCode = typeof record.status_code === 'number' ? record.status_code : null;

    let message: string;
    if (statusMessage) {
      message = `amodb API error (HTTP ${response.status}${statusCode !== null ? `, status_code ${statusCode}` : ''}): ${statusMessage}`;
    } else {
      const snippet = response.text.replace(/\s+/g, ' ').trim().slice(0, 200);
      message = `amodb API error (HTTP ${response.status})${snippet ? `: ${snippet}` : ''}`;
    }
    if (response.status === 401) message += ' Check the AMODB_API_KEY value.';
    if (response.status === 429 && retryAfter !== null) message += ` Wait about ${retryAfter} s before retrying.`;

    throw new AmodbApiError(message, { status: response.status, statusCode, statusMessage, retryAfter });
  }
}

function retryWaitMs(header: string | null, attempt: number): number {
  const seconds = parseRetryAfter(header);
  const ms = seconds !== null ? seconds * 1000 : 2 ** attempt * 1000;
  return Math.min(Math.max(ms, 0), MAX_WAIT_MS);
}

function dropUndefined(params: Query): Query {
  const out: Query = {};
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'the configured base URL';
  }
}
