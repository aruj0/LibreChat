import { logger } from '@librechat/data-schemas';

/**
 * Aralab patch 6: retry a provider request that was refused for a rate limit,
 * after 5 s, 10 s and 20 s, before the turn fails.
 *
 * Works at the HTTP layer, below the SDKs, so it resumes the exact model call
 * that failed (mid-run, after tools have executed) instead of rerunning the turn.
 * Only whole-request rejections are retried: nothing has streamed yet, so the
 * replay cannot duplicate output or tool calls.
 *
 * OpenRouter reports its PDF parser's rate limit as a 400, which no SDK retries,
 * so the body is checked too.
 */
export const RATE_LIMIT_RETRY_DELAYS_MS = [5000, 10000, 20000] as const;

const RATE_LIMIT_STATUSES = new Set([429, 529]);
const RATE_LIMIT_BODY = /rate[\s_-]?limit/i;

type FetchLike = typeof globalThis.fetch;
type RetryOptions = {
  delays?: readonly number[];
  sleep?: (ms: number, signal?: AbortSignal | null) => Promise<void>;
  /** Patch 6b: `from model → to model` replayed once after the last retry (OpenRouter only).
   *  Default: `ARALAB_RATE_LIMIT_FALLBACK` (`from=to[,from=to]`), read per request. */
  fallbacks?: Record<string, string>;
};

/** Patch 6b: how far into an event stream we look for an in-stream rate-limit error. */
const STREAM_PEEK_LIMIT = 64 * 1024;
const OPENROUTER_HOST = /(^|\.)openrouter\.ai$/i;

/** `ARALAB_RATE_LIMIT_FALLBACK=google/gemini-4-neon=z-ai/glm-5.3-flash[,a=b]` → `{from: to}`. */
export function parseRateLimitFallbacks(value?: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (value ?? '').split(',')) {
    const i = pair.indexOf('=');
    const from = pair.slice(0, i).trim();
    const to = pair.slice(i + 1).trim();
    if (i > 0 && from && to) {
      out[from] = to;
    }
  }
  return out;
}

/**
 * The verdict of the first complete, non-comment `data:` line of an event stream: true when it is
 * an error with code 429/529 (OpenRouter sends a provider's rate limit this way after HTTP 200),
 * false for anything else, undefined while no complete data line has arrived yet.
 */
export function firstStreamEventIsRateLimit(text: string): boolean | undefined {
  const end = text.lastIndexOf('\n');
  if (end < 0) {
    return undefined;
  }
  for (const raw of text.slice(0, end).split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith(':') || !line.startsWith('data:')) {
      continue;
    }
    const payload = line.slice(5).trim();
    try {
      const body = JSON.parse(payload) as {
        error?: { code?: unknown; metadata?: { provider_code?: unknown; error_type?: unknown } };
      };
      const err = body?.error;
      if (err == null || typeof err !== 'object') {
        return false;
      }
      const codes = [err.code, err.metadata?.provider_code].map((c) => Number(c));
      return (
        codes.some((c) => RATE_LIMIT_STATUSES.has(c)) ||
        /rate[\s_-]?limit/i.test(String(err.metadata?.error_type ?? ''))
      );
    } catch {
      return false;
    }
  }
  return undefined;
}

/**
 * Patch 6b: a 200 `text/event-stream` response is read up to its first data event. A rate-limit
 * error there (nothing streamed yet, so a replay cannot duplicate output) becomes a synthetic 429
 * carrying the original error text; any other stream is handed on with every byte intact.
 */
export async function normalizeStreamRateLimit(response: Response): Promise<Response> {
  const type = response.headers.get('content-type') ?? '';
  if (!response.ok || !/text\/event-stream/i.test(type) || response.body == null) {
    return response;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: Uint8Array[] = [];
  let text = '';
  let done = false;
  let verdict: boolean | undefined;
  while (verdict === undefined) {
    const read = await reader.read();
    if (read.done) {
      done = true;
      break;
    }
    chunks.push(read.value);
    text += decoder.decode(read.value, { stream: true });
    verdict = firstStreamEventIsRateLimit(text);
    if (verdict === undefined && text.length > STREAM_PEEK_LIMIT) {
      verdict = false;
    }
  }
  if (verdict === true) {
    reader.cancel().catch(() => undefined);
    const headers = new Headers(response.headers);
    headers.set('content-type', 'text/plain; charset=utf-8');
    return new Response(text, { status: 429, statusText: 'Rate limited (in stream)', headers });
  }
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      if (done) {
        controller.close();
      }
    },
    async pull(controller) {
      const read = await reader.read();
      if (read.done) {
        controller.close();
      } else {
        controller.enqueue(read.value);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/** The request again with its JSON body's `model` swapped, or undefined when no fallback applies. */
function fallbackInit(
  input: Parameters<FetchLike>[0],
  init: RequestInit | undefined,
  fallbacks: Record<string, string>,
): { init: RequestInit; from: string; to: string } | undefined {
  try {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (!OPENROUTER_HOST.test(url.hostname) || typeof init?.body !== 'string') {
      return undefined;
    }
    const body = JSON.parse(init.body) as { model?: unknown };
    const from = typeof body?.model === 'string' ? body.model : undefined;
    const to = from ? fallbacks[from] : undefined;
    if (!from || !to) {
      return undefined;
    }
    return { init: { ...init, body: JSON.stringify({ ...body, model: to }) }, from, to };
  } catch {
    return undefined;
  }
}

const defaultSleep = (ms: number, signal?: AbortSignal | null) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) {
      return resolve();
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

export async function isRateLimitResponse(response: Response): Promise<boolean> {
  if (RATE_LIMIT_STATUSES.has(response.status)) {
    return true;
  }
  if (response.status !== 400) {
    return false;
  }
  try {
    return RATE_LIMIT_BODY.test(await response.clone().text());
  } catch {
    return false;
  }
}

/** A body the SDKs send as a string or buffer can be sent again; a stream cannot. */
function isReplayable(input: Parameters<FetchLike>[0], init?: RequestInit): boolean {
  if (typeof Request !== 'undefined' && input instanceof Request && input.body != null) {
    return false;
  }
  const body = init?.body;
  return (
    body == null ||
    typeof body === 'string' ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body) ||
    body instanceof URLSearchParams
  );
}

function describe(input: Parameters<FetchLike>[0]): string {
  try {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    return `${url.host}${url.pathname}`;
  } catch {
    return 'provider request';
  }
}

type MarkedFetch = FetchLike & { __aralabRateLimitRetry?: true };

/** Whether a fetch already carries this retry layer. */
export function hasRateLimitRetry(fetch: unknown): boolean {
  return typeof fetch === 'function' && (fetch as MarkedFetch).__aralabRateLimitRetry === true;
}

export function withRateLimitRetry(baseFetch: FetchLike, options: RetryOptions = {}): FetchLike {
  if (hasRateLimitRetry(baseFetch)) {
    return baseFetch;
  }
  const delays = options.delays ?? RATE_LIMIT_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? defaultSleep;
  const wrapped = (async (input: Parameters<FetchLike>[0], init?: RequestInit) => {
    let response = await baseFetch(input, init);
    if (!isReplayable(input, init)) {
      return response;
    }
    response = await normalizeStreamRateLimit(response);
    for (let attempt = 0; attempt < delays.length; attempt++) {
      if (!(await isRateLimitResponse(response))) {
        return response;
      }
      const signal = init?.signal ?? null;
      logger.warn(
        `[rateLimitRetry] ${describe(input)} rate limited (${response.status}); retry ${attempt + 1}/${delays.length} in ${delays[attempt] / 1000}s`,
      );
      await sleep(delays[attempt], signal);
      if (signal?.aborted) {
        return response;
      }
      response = await normalizeStreamRateLimit(await baseFetch(input, init));
    }
    /* Patch 6b: still rate limited after the last retry → one replay on the fallback model. */
    if (await isRateLimitResponse(response)) {
      const fallbacks =
        options.fallbacks ?? parseRateLimitFallbacks(process.env.ARALAB_RATE_LIMIT_FALLBACK);
      const next = fallbackInit(input, init, fallbacks);
      if (next != null && !init?.signal?.aborted) {
        logger.warn(
          `[rateLimitRetry] ${describe(input)} still rate limited after ${delays.length} retries; fallback ${next.from} -> ${next.to}`,
        );
        response = await normalizeStreamRateLimit(await baseFetch(input, next.init));
      }
    }
    return response;
  }) as MarkedFetch;
  wrapped.__aralabRateLimitRetry = true;
  return wrapped;
}

/** Model-provider API hosts whose rate limits are retried. Nothing else is touched. */
const PROVIDER_API_HOST = /(^|\.)(googleapis\.com|anthropic\.com|openrouter\.ai|openai\.com)$/i;

type ScopedFetch = FetchLike & { __aralabProviderRetry?: true };

/**
 * The provider SDKs (OpenAI, Anthropic, Google) call the global fetch unless a
 * client is given its own, and the Google SDK accepts no per-client fetch at
 * all. One global wrapper scoped to provider API hosts covers every provider
 * without changing any client config. Idempotent; each provider's config
 * builder installs it before its client is created.
 */
export function installProviderRateLimitRetry(options: RetryOptions = {}): void {
  const current = globalThis.fetch as ScopedFetch;
  if (current.__aralabProviderRetry === true) {
    return;
  }
  const original = current;
  const retrying = withRateLimitRetry(original, options);
  const scoped = ((input: Parameters<FetchLike>[0], init?: RequestInit) => {
    try {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (PROVIDER_API_HOST.test(url.hostname)) {
        return retrying(input, init);
      }
    } catch {
      /* not a URL we can classify: pass through */
    }
    return original(input, init);
  }) as ScopedFetch;
  scoped.__aralabProviderRetry = true;
  globalThis.fetch = scoped;
}
