import type { AppConfig } from '@librechat/data-schemas';
import {
  aliasJsonText,
  aliasSseChunk,
  aliasPayload,
  buildModelAliasMap,
  resolveAliasedBody,
  resolveAliasedModel,
  sanitizeUpstreamError,
} from './modelAlias';

const GLM = 'z-ai/glm-5.3-flash';
const LEAK = /z-?ai|glm|openrouter|baseten/i;

/** The 4 custom endpoints of stacks/librechat/config/librechat.yaml (20/11/2026). */
const appConfig = {
  endpoints: {
    custom: [
      {
        name: 'Aralab GPT',
        apiKey: '${OPENROUTER_KEY}',
        baseURL: 'https://openrouter.ai/api/v1',
        models: { default: [GLM], fetch: false },
        titleConvo: true,
        titleModel: GLM,
        addParams: { provider: { order: ['baseten'], allow_fallbacks: true, zdr: true } },
        modelDisplayLabel: 'Aralab GPT',
      },
      {
        name: 'Large File Agents',
        apiKey: '${OPENROUTER_KEY}',
        baseURL: 'https://openrouter.ai/api/v1',
        models: { default: [GLM], fetch: false },
        titleModel: GLM,
        modelDisplayLabel: 'Aralab GPT',
      },
      {
        name: 'Aralab (dev)',
        apiKey: '${OPENROUTER_DEV_KEY}',
        baseURL: 'https://openrouter.ai/api/v1',
        models: {
          default: [
            'anthropic/claude-sonnet-5.5',
            'anthropic/claude-opus-5.5',
            'google/gemini-3.8-flash',
          ],
          fetch: false,
        },
        titleEndpoint: 'Aralab GPT',
        titleModel: GLM,
        modelDisplayLabel: 'Aralab (dev)',
      },
      {
        name: 'Large File Agents (dev)',
        apiKey: '${OPENROUTER_DEV_KEY}',
        baseURL: 'https://openrouter.ai/api/v1',
        models: { default: ['anthropic/claude-opus-5.5'], fetch: false },
        titleModel: GLM,
        modelDisplayLabel: 'Aralab (dev)',
      },
    ],
  },
} as unknown as AppConfig;

describe('aralab model alias (patch 10b)', () => {
  const map = buildModelAliasMap(appConfig);

  it('map covers only glm', () => {
    expect(map.toAlias.get(GLM)).toBe('Aralab GPT');
    expect([...map.toAlias.keys()].some((id) => id.startsWith('anthropic/'))).toBe(false);
    expect([...map.toAlias.keys()].some((id) => id.startsWith('google/'))).toBe(false);
    expect(map.toReal.get('Aralab GPT::Aralab GPT')).toBe(GLM);
    expect(map.toReal.get('Large File Agents::Aralab GPT')).toBe(GLM);
  });

  it('aliases nested model fields', () => {
    const input = {
      conversation: { model: GLM, endpoint: 'Aralab GPT' },
      messages: [{ model: GLM, text: GLM }],
    };
    const out = aliasPayload(input, map);
    expect(out.conversation.model).toBe('Aralab GPT');
    expect(out.conversation.endpoint).toBe('Aralab GPT');
    expect(out.messages[0].model).toBe('Aralab GPT');
    expect(out.messages[0].text).toBe(GLM);
    /* a copy: the stored object keeps the real id */
    expect(input.conversation.model).toBe(GLM);
  });

  it('leaves model content (text/content/reasoning/think) untouched', () => {
    const out = aliasPayload(
      {
        content: [
          { type: 'text', text: GLM },
          { type: 'think', think: GLM },
        ],
        reasoning: GLM,
        think: GLM,
      },
      map,
    );
    expect(out.content).toEqual([
      { type: 'text', text: GLM },
      { type: 'think', think: GLM },
    ]);
    expect(out.reasoning).toBe(GLM);
    expect(out.think).toBe(GLM);
  });

  it('drops baseURL', () => {
    const out = aliasPayload(appConfig, map) as unknown as {
      endpoints: { custom: Array<Record<string, unknown>> };
    };
    expect('baseURL' in out.endpoints.custom[0]).toBe(false);
    expect(out.endpoints.custom[0].titleModel).toBe('Aralab GPT');
    expect(JSON.stringify(out)).not.toMatch(/openrouter\.ai/);
  });

  it('blanks openrouter URLs under any key and drops providerId openrouter', () => {
    const out = aliasPayload(
      {
        docs: 'https://openrouter.ai/settings/privacy',
        'Aralab GPT': { providerId: 'openrouter' },
      },
      map,
    );
    expect(out.docs).toBe('');
    expect('providerId' in out['Aralab GPT']).toBe(false);
  });

  it('dev ids pass through', () => {
    const out = aliasPayload(
      { model: 'anthropic/claude-opus-5.5', other: 'google/gemini-3.8-flash' },
      map,
    );
    expect(out.model).toBe('anthropic/claude-opus-5.5');
    expect(out.other).toBe('google/gemini-3.8-flash');
  });

  it('aliases suffixed z-ai ids and model-id object keys', () => {
    const out = aliasPayload(
      {
        model: 'z-ai/glm-5.3-flash-20260826',
        rates: {
          'Aralab GPT': { [GLM]: { prompt: 1 }, 'anthropic/claude-opus-5.5': { prompt: 2 } },
        },
      },
      map,
    );
    expect(out.model).toBe('Aralab GPT');
    expect(out.rates['Aralab GPT']).toEqual({
      'Aralab GPT': { prompt: 1 },
      'anthropic/claude-opus-5.5': { prompt: 2 },
    });
  });

  it('falls back to Aralab GPT for a z-ai id when no config maps it', () => {
    const empty = buildModelAliasMap({} as AppConfig);
    expect(aliasPayload({ model: GLM }, empty).model).toBe('Aralab GPT');
  });

  it('sanitises server error fields, not model text', () => {
    const err = `No endpoints found matching your data policy (Zero data retention) for ${GLM}`;
    const out = aliasPayload(
      {
        error: err,
        responseMessage: { error: true, text: err, model: GLM },
        okMessage: { text: err },
        content: [
          { type: 'error', error: err },
          { type: 'text', text: err },
        ],
      },
      map,
    );
    expect(out.error).not.toMatch(LEAK);
    expect(out.responseMessage.text).not.toMatch(LEAK);
    expect(out.responseMessage.model).toBe('Aralab GPT');
    expect(out.okMessage.text).toBe(err);
    expect((out.content[0] as { error: string }).error).not.toMatch(LEAK);
    expect((out.content[1] as { text: string }).text).toBe(err);
  });

  it('round-trip', () => {
    expect(resolveAliasedModel('Aralab GPT', 'Aralab GPT', map)).toBe(GLM);
    expect(resolveAliasedModel('Large File Agents', 'Aralab GPT', map)).toBe(GLM);
    expect(resolveAliasedModel('Aralab GPT', GLM, map)).toBe(GLM);
    expect(resolveAliasedModel('anthropic', 'claude-opus-5-5', map)).toBe('claude-opus-5-5');
    expect(resolveAliasedModel('Aralab (dev)', 'anthropic/claude-opus-5.5', map)).toBe(
      'anthropic/claude-opus-5.5',
    );
  });

  it('resolves aliased models in request bodies (agents, presets, schedules)', () => {
    const body = {
      provider: 'Aralab GPT',
      model: 'Aralab GPT',
      preset: { endpoint: 'Large File Agents', model: 'Aralab GPT', text: 'Aralab GPT' },
      other: { endpoint: 'Aralab (dev)', model: 'anthropic/claude-opus-5.5' },
      orphan: { model: 'Aralab GPT' },
    };
    resolveAliasedBody(body, map);
    expect(body.model).toBe(GLM);
    expect(body.preset.model).toBe(GLM);
    expect(body.preset.text).toBe('Aralab GPT');
    expect(body.other.model).toBe('anthropic/claude-opus-5.5');
    /* the label maps to a single real id across endpoints */
    expect(body.orphan.model).toBe(GLM);
  });

  it('sanitizes data-policy error', () => {
    const out = sanitizeUpstreamError(
      `No endpoints found matching your data policy (Zero data retention) for ${GLM} via https://openrouter.ai/api/v1`,
      map,
    );
    expect(out).not.toMatch(LEAK);
    expect(out).toContain('data policy');
  });

  it('sanitizes the no-allowed-providers error and drops the provider list (R5)', () => {
    const providers = ['relace', 'wafer', 'open-inference', 'darkbloom', 'baseten', 'novita'];
    const input = `No allowed providers are available for the selected model. Providers serving z-ai/glm-5.3-flash-20260826: ${providers.join(', ')}`;
    const out = sanitizeUpstreamError(input, map);
    expect(out).not.toMatch(LEAK);
    for (const name of providers) {
      expect(out.toLowerCase()).not.toContain(name);
    }
    expect(out).toContain('No allowed providers are available');
  });

  it('keeps text after the provider list', () => {
    const out = sanitizeUpstreamError(
      'OpenRouter: No allowed providers are available. Providers serving z-ai/glm-5.3-flash: baseten, wafer. Please try again later.',
      map,
    );
    expect(out).not.toMatch(LEAK);
    expect(out).not.toMatch(/wafer/i);
    expect(out).toContain('No allowed providers are available');
    expect(out).toContain('Please try again later.');
    expect(sanitizeUpstreamError(`404 No endpoints found for ${GLM}.`, map)).toBe(
      '404 No endpoints found for Aralab GPT.',
    );
  });

  it('aliases serialised JSON and SSE chunks, leaving other text alone', () => {
    expect(JSON.parse(aliasJsonText(JSON.stringify({ model: GLM }), map))).toEqual({
      model: 'Aralab GPT',
    });
    expect(aliasJsonText('not json about glm', map)).toBe('not json about glm');
    const frame = `event: message\ndata: ${JSON.stringify({ model: GLM, text: GLM })}\n\n`;
    expect(aliasSseChunk(frame, map)).toBe(
      `event: message\ndata: ${JSON.stringify({ model: 'Aralab GPT', text: GLM })}\n\n`,
    );
    expect(aliasSseChunk('data: [DONE]\n\n', map)).toBe('data: [DONE]\n\n');
    const plain = 'data: {"delta":"hello"}\n\n';
    expect(aliasSseChunk(plain, map)).toBe(plain);
  });
});
