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
};

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
      response = await baseFetch(input, init);
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
