import {
  withRateLimitRetry,
  isRateLimitResponse,
  parseRateLimitFallbacks,
  normalizeStreamRateLimit,
  firstStreamEventIsRateLimit,
  installProviderRateLimitRetry,
} from './rateLimitRetry';
import { getLLMConfig as getAnthropicLLMConfig } from '~/endpoints/anthropic/llm';
import { getOpenAIConfig } from '~/endpoints/openai/config';
import { getGoogleConfig } from '~/endpoints/google/llm';

const res = (status: number, body = '') => new Response(body, { status });
const noSleep = jest.fn(async () => undefined);

describe('isRateLimitResponse', () => {
  it('treats 429 and 529 as rate limits', async () => {
    expect(await isRateLimitResponse(res(429))).toBe(true);
    expect(await isRateLimitResponse(res(529))).toBe(true);
  });
  it('treats a 400 that says it is rate limited as a rate limit (OpenRouter PDF parser)', async () => {
    const body = JSON.stringify({
      error: {
        message:
          'Failed to parse the file: The document parsing engine is currently rate limited. Please retry shortly.',
      },
    });
    expect(await isRateLimitResponse(res(400, body))).toBe(true);
  });
  it('does not retry an ordinary 400, a 500, or a success', async () => {
    expect(await isRateLimitResponse(res(400, '{"error":"invalid model"}'))).toBe(false);
    expect(await isRateLimitResponse(res(500, 'rate limited'))).toBe(false);
    expect(await isRateLimitResponse(res(200, 'rate limited'))).toBe(false);
  });
});

describe('withRateLimitRetry', () => {
  beforeEach(() => noSleep.mockClear());

  it('retries after 5, 10 and 20 seconds, then returns the last response', async () => {
    const base = jest.fn(async () => res(429, 'slow down'));
    const fetch = withRateLimitRetry(base as unknown as typeof globalThis.fetch, {
      sleep: noSleep,
    });
    const out = await fetch('https://x.test/v1', { method: 'POST', body: '{}' });
    expect(base).toHaveBeenCalledTimes(4);
    expect(noSleep.mock.calls.map((c) => (c as unknown[])[0])).toEqual([5000, 10000, 20000]);
    expect(out.status).toBe(429);
    expect(await out.text()).toBe('slow down');
  });

  it('stops as soon as a retry succeeds', async () => {
    const base = jest.fn().mockResolvedValueOnce(res(429)).mockResolvedValueOnce(res(200, 'ok'));
    const fetch = withRateLimitRetry(base as unknown as typeof globalThis.fetch, {
      sleep: noSleep,
    });
    const out = await fetch('https://x.test/v1', { method: 'POST', body: '{}' });
    expect(base).toHaveBeenCalledTimes(2);
    expect(await out.text()).toBe('ok');
  });

  it('does not retry a non-rate-limit error', async () => {
    const base = jest.fn(async () => res(400, 'bad request'));
    const fetch = withRateLimitRetry(base as unknown as typeof globalThis.fetch, {
      sleep: noSleep,
    });
    expect((await fetch('https://x.test/v1', { body: '{}' })).status).toBe(400);
    expect(base).toHaveBeenCalledTimes(1);
  });

  it('does not retry a request whose body is a stream (it cannot be replayed)', async () => {
    const base = jest.fn(async () => res(429));
    const fetch = withRateLimitRetry(base as unknown as typeof globalThis.fetch, {
      sleep: noSleep,
    });
    await fetch('https://x.test/v1', { method: 'POST', body: new ReadableStream() } as RequestInit);
    expect(base).toHaveBeenCalledTimes(1);
  });

  it('gives up waiting when the request is aborted', async () => {
    const controller = new AbortController();
    const base = jest.fn(async () => res(429));
    const sleep = jest.fn(async () => controller.abort());
    const fetch = withRateLimitRetry(base as unknown as typeof globalThis.fetch, { sleep });
    const out = await fetch('https://x.test/v1', { body: '{}', signal: controller.signal });
    expect(base).toHaveBeenCalledTimes(1);
    expect(out.status).toBe(429);
  });
});

const FLAG = '__aralabProviderRetry';
const installed = () => (globalThis.fetch as unknown as Record<string, unknown>)[FLAG] === true;

describe('installProviderRateLimitRetry', () => {
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
  });

  it('retries provider API hosts only, and installs once', async () => {
    const base = jest.fn(async () => res(429));
    globalThis.fetch = base as unknown as typeof globalThis.fetch;
    installProviderRateLimitRetry({ sleep: noSleep });
    installProviderRateLimitRetry({ sleep: noSleep });
    for (const url of [
      'https://generativelanguage.googleapis.com/v1beta/models/x:generateContent',
      'https://api.anthropic.com/v1/messages',
      'https://openrouter.ai/api/v1/chat/completions',
    ]) {
      base.mockClear();
      await globalThis.fetch(url, { body: '{}' });
      expect(base).toHaveBeenCalledTimes(4);
    }
    base.mockClear();
    await globalThis.fetch('https://example.com/other', { body: '{}' });
    expect(base).toHaveBeenCalledTimes(1);
  });
});

describe('provider wiring (every provider installs the retry)', () => {
  const original = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = jest.fn() as unknown as typeof globalThis.fetch;
  });
  afterAll(() => {
    globalThis.fetch = original;
  });

  it('Anthropic', () => {
    getAnthropicLLMConfig('key', { modelOptions: { model: 'claude-sonnet-5-5' } });
    expect(installed()).toBe(true);
  });

  it('OpenAI-compatible (OpenRouter custom endpoints)', () => {
    getOpenAIConfig('key', {
      reverseProxyUrl: 'https://openrouter.ai/api/v1',
      modelOptions: { model: 'z-ai/glm-5.3-flash' },
    });
    expect(installed()).toBe(true);
  });

  it('Google', () => {
    getGoogleConfig({ GOOGLE_API_KEY: 'key' } as never, {
      modelOptions: { model: 'gemini-3.8-flash' },
    });
    expect(installed()).toBe(true);
  });
});

/** Patch 6b: OpenRouter's in-stream 429 (HTTP 200, first data event is the error). */
describe('in-stream rate limits (patch 6b)', () => {
  const OR = 'https://openrouter.ai/api/v1/chat/completions';
  const RL_EVENT =
    'data: {"error":{"code":429,"message":"Provider returned error","metadata":{"error_type":"rate_limit_exceeded","provider_code":"429"}}}\n\n';
  const OK_EVENT = 'data: {"id":"gen-1","choices":[{"delta":{"content":"Olá"}}]}\n\n';
  const sse = (...parts: string[]) => {
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (const p of parts) c.enqueue(enc.encode(p));
        c.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const body = (model: string) => JSON.stringify({ model, stream: true, messages: [] });
  beforeEach(() => noSleep.mockClear());

  it('firstStreamEventIsRateLimit: comments skipped, verdict from the first data line', () => {
    expect(firstStreamEventIsRateLimit(': OPENROUTER PROCESSING\n\n')).toBeUndefined();
    expect(firstStreamEventIsRateLimit(': OPENROUTER PROCESSING\n\n' + RL_EVENT)).toBe(true);
    expect(firstStreamEventIsRateLimit(OK_EVENT + RL_EVENT)).toBe(false);
    expect(firstStreamEventIsRateLimit('data: {"error":{"code":400,"message":"bad"}}\n')).toBe(
      false,
    );
    expect(
      firstStreamEventIsRateLimit(
        'data: {"error":{"code":502,"metadata":{"error_type":"rate_limit_exceeded"}}}\n',
      ),
    ).toBe(true);
    expect(firstStreamEventIsRateLimit('data: {"error":{"co')).toBeUndefined();
  });

  it('normalizeStreamRateLimit: a normal stream passes through byte for byte', async () => {
    const out = await normalizeStreamRateLimit(
      sse(': OPENROUTER PROCESSING\n\n', OK_EVENT, 'data: [DONE]\n\n'),
    );
    expect(out.status).toBe(200);
    expect(await out.text()).toBe(': OPENROUTER PROCESSING\n\n' + OK_EVENT + 'data: [DONE]\n\n');
  });

  it('normalizeStreamRateLimit: an in-stream 429 becomes a 429 carrying the error text', async () => {
    const out = await normalizeStreamRateLimit(sse(': OPENROUTER PROCESSING\n\n', RL_EVENT));
    expect(out.status).toBe(429);
    expect(await out.text()).toContain('rate_limit_exceeded');
  });

  it('retries an in-stream 429 and returns the stream that succeeds', async () => {
    const base = jest
      .fn()
      .mockResolvedValueOnce(sse(RL_EVENT))
      .mockResolvedValueOnce(sse(OK_EVENT));
    const fetch = withRateLimitRetry(base as unknown as typeof globalThis.fetch, {
      sleep: noSleep,
      fallbacks: {},
    });
    const out = await fetch(OR, { method: 'POST', body: body('google/gemini-4-neon') });
    expect(base).toHaveBeenCalledTimes(2);
    expect(noSleep.mock.calls.map((c) => (c as unknown[])[0])).toEqual([5000]);
    expect(await out.text()).toBe(OK_EVENT);
  });

  it('after the last retry, replays once on the fallback model (OpenRouter only)', async () => {
    const base = jest.fn(async (_url: unknown, init?: RequestInit) =>
      JSON.parse(String(init?.body)).model === 'z-ai/glm-5.3-flash' ? sse(OK_EVENT) : sse(RL_EVENT),
    );
    const fetch = withRateLimitRetry(base as unknown as typeof globalThis.fetch, {
      sleep: noSleep,
      fallbacks: { 'google/gemini-4-neon': 'z-ai/glm-5.3-flash' },
    });
    const out = await fetch(OR, { method: 'POST', body: body('google/gemini-4-neon') });
    expect(base).toHaveBeenCalledTimes(5);
    const models = base.mock.calls.map((c) => JSON.parse(String((c[1] as RequestInit).body)).model);
    expect(models).toEqual([
      'google/gemini-4-neon',
      'google/gemini-4-neon',
      'google/gemini-4-neon',
      'google/gemini-4-neon',
      'z-ai/glm-5.3-flash',
    ]);
    expect(await out.text()).toBe(OK_EVENT);
  });

  it('no fallback for other hosts, unmapped models, or when the env is unset', async () => {
    const base = jest.fn(async () => sse(RL_EVENT));
    const fb = { 'google/gemini-4-neon': 'z-ai/glm-5.3-flash' };
    for (const [url, model] of [
      ['https://api.anthropic.com/v1/messages', 'google/gemini-4-neon'],
      [OR, 'anthropic/claude-sonnet-5.5'],
    ]) {
      base.mockClear();
      const fetch = withRateLimitRetry(base as unknown as typeof globalThis.fetch, {
        sleep: noSleep,
        fallbacks: fb,
      });
      const out = await fetch(url, { method: 'POST', body: body(model) });
      expect(base).toHaveBeenCalledTimes(4);
      expect(out.status).toBe(429);
    }
    expect(parseRateLimitFallbacks(undefined)).toEqual({});
    expect(parseRateLimitFallbacks(' google/gemini-4-neon = z-ai/glm-5.3-flash ,bad, x=')).toEqual({
      'google/gemini-4-neon': 'z-ai/glm-5.3-flash',
    });
  });

  it('a stream whose first data event is content is never retried, even if an error follows later', async () => {
    const base = jest.fn(async () => sse(OK_EVENT, RL_EVENT));
    const fetch = withRateLimitRetry(base as unknown as typeof globalThis.fetch, {
      sleep: noSleep,
      fallbacks: {},
    });
    const out = await fetch(OR, { method: 'POST', body: body('google/gemini-4-neon') });
    expect(base).toHaveBeenCalledTimes(1);
    expect(await out.text()).toBe(OK_EVENT + RL_EVENT);
  });
});
