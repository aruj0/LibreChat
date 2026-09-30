import {
  withRateLimitRetry,
  isRateLimitResponse,
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
