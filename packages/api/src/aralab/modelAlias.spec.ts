import { parseEphemeralAgentId } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import {
  aliasJsonText,
  aliasSseChunk,
  aliasPayload,
  buildModelAliasMap,
  resolveAliasedBody,
  resolveAliasedEphemeralId,
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

  describe('review fixes', () => {
    it('aliases a reference shared by two branches (object and array)', () => {
      const shared = { model: GLM };
      const out = aliasPayload({ a: shared, b: shared }, map);
      expect(out).toEqual({ a: { model: 'Aralab GPT' }, b: { model: 'Aralab GPT' } });
      expect(shared.model).toBe(GLM);

      const list = [GLM, { model: GLM }];
      const outList = aliasPayload({ x: list, y: { z: list } }, map);
      expect(outList.x).toEqual(['Aralab GPT', { model: 'Aralab GPT' }]);
      expect(outList.y.z).toEqual(['Aralab GPT', { model: 'Aralab GPT' }]);
      expect(list[0]).toBe(GLM);
    });

    it('still terminates on a true cycle', () => {
      const node: Record<string, unknown> = { model: GLM };
      node.self = node;
      const out = aliasPayload(node, map) as Record<string, unknown>;
      expect(out.model).toBe('Aralab GPT');
      expect(out.self).toBe(out);
      expect(node.model).toBe(GLM);
    });

    it('passes non-upstream error/message strings through unchanged', () => {
      const strings = ['Logged on.', 'see https://intranet.aralab.pt/policy for details', '- item'];
      for (const text of strings) {
        expect(sanitizeUpstreamError(text, map)).toBe(text);
        expect(aliasPayload({ message: text, error: text, errorText: text }, map)).toEqual({
          message: text,
          error: text,
          errorText: text,
        });
        expect(aliasPayload({ error: true, text }, map).text).toBe(text);
        expect(aliasPayload({ content: [{ type: 'error', error: text }] }, map).content).toEqual([
          { type: 'error', error: text },
        ]);
      }
    });

    it('leaves an admin banner payload unchanged', () => {
      const banner = {
        bannerId: 'b1',
        message:
          '<p>Maintenance on Friday — see <a href="https://intranet.aralab.pt/policy">the policy</a>. Logged on.</p>',
        displayFrom: '2026-11-20T00:00:00.000Z',
        type: 'banner',
        isPublic: true,
      };
      expect(aliasPayload(banner, map)).toEqual(banner);
    });

    it('removes only upstream URLs from upstream error text', () => {
      const out = sanitizeUpstreamError(
        `Failed for ${GLM} via https://openrouter.ai/api/v1; see https://intranet.aralab.pt/help`,
        map,
      );
      expect(out).not.toMatch(LEAK);
      expect(out).toContain('https://intranet.aralab.pt/help');
      expect(out).toContain('Aralab GPT');
    });

    it('aliases only whole id-shaped values, not text that starts with one', () => {
      const title = `${GLM} vs Claude: which is faster?`;
      expect(aliasPayload({ title }, map).title).toBe(title);
      expect(aliasPayload({ model: 'z-ai/glm-5.3-flash-20260826' }, map).model).toBe('Aralab GPT');
    });
  });

  describe('leak probe shapes (R16)', () => {
    const COMPOSITE = 'Aralab GPT__z-ai/glm-5.3-flash___Aralab GPT';
    const COMPOSITE_ALIASED = 'Aralab GPT__Aralab GPT___Aralab GPT';
    const NON_GLM = 'anthropic__claude-opus-5-5___Claude';
    const CONTENT_KEYS = new Set(['text', 'content', 'reasoning', 'think']);

    /** Like the probe's findLeaks: every key and string value outside content keys. */
    const findLeaks = (value: unknown, path = '$'): string[] => {
      if (typeof value === 'string') {
        return LEAK.test(value) ? [`${path}=${value}`] : [];
      }
      if (value == null || typeof value !== 'object') {
        return [];
      }
      if (Array.isArray(value)) {
        return value.flatMap((item, index) => findLeaks(item, `${path}[${index}]`));
      }
      return Object.entries(value).flatMap(([key, child]) => {
        if (CONTENT_KEYS.has(key)) {
          return [];
        }
        const keyLeak = LEAK.test(key) ? [`${path} key ${key}`] : [];
        return [...keyLeak, ...findLeaks(child, `${path}.${key}`)];
      });
    };

    it('aliases composite ephemeral agent ids at every probed path', () => {
      const convos = aliasPayload({ conversations: [{ agent_id: COMPOSITE }] }, map);
      expect(convos.conversations[0].agent_id).toBe(COMPOSITE_ALIASED);
      expect(aliasPayload({ agent_id: COMPOSITE }, map).agent_id).toBe(COMPOSITE_ALIASED);
      const messages = aliasPayload([{ metadata: { contextUsage: { agentId: COMPOSITE } } }], map);
      expect(messages[0].metadata.contextUsage.agentId).toBe(COMPOSITE_ALIASED);
      const sse = aliasPayload(
        { data: { agentId: COMPOSITE }, conversation: { agent_id: COMPOSITE } },
        map,
      );
      expect(sse.data.agentId).toBe(COMPOSITE_ALIASED);
      expect(sse.conversation.agent_id).toBe(COMPOSITE_ALIASED);
      expect(aliasPayload({ agents: { [COMPOSITE]: 1 } }, map).agents).toEqual({
        [COMPOSITE_ALIASED]: 1,
      });
      expect(aliasPayload({ agentId: `${COMPOSITE}____1` }, map).agentId).toBe(
        `${COMPOSITE_ALIASED}____1`,
      );
    });

    it('leaves a non-GLM composite unchanged both ways', () => {
      expect(aliasPayload({ agent_id: NON_GLM }, map).agent_id).toBe(NON_GLM);
      expect(resolveAliasedEphemeralId(NON_GLM, map)).toBe(NON_GLM);
      expect(resolveAliasedEphemeralId('agent_abc123', map)).toBe('agent_abc123');
    });

    it('resolves an aliased composite back to the real model id', () => {
      const resolved = resolveAliasedEphemeralId(COMPOSITE_ALIASED, map);
      expect(resolved).toBe(COMPOSITE);
      expect(parseEphemeralAgentId(resolved)?.model).toBe(GLM);
      /* real ids keep working */
      expect(resolveAliasedEphemeralId(COMPOSITE, map)).toBe(COMPOSITE);
      const body = {
        agent_id: COMPOSITE_ALIASED,
        addedConvo: { agentId: 'Large File Agents__Aralab GPT___Aralab GPT' },
        text: COMPOSITE_ALIASED,
      };
      resolveAliasedBody(body, map);
      expect(body.agent_id).toBe(COMPOSITE);
      expect(body.addedConvo.agentId).toBe('Large File Agents__z-ai/glm-5.3-flash___Aralab GPT');
      expect(body.text).toBe(COMPOSITE_ALIASED);
    });

    it('neutralises contextUsage.provider "openrouter" (messages and SSE)', () => {
      const messages = aliasPayload(
        [{ metadata: { contextUsage: { provider: 'openrouter', model: GLM } } }],
        map,
      );
      expect(messages[0].metadata.contextUsage).toEqual({
        provider: 'custom',
        model: 'Aralab GPT',
      });
      const sse = aliasPayload({ data: { provider: 'openrouter' } }, map);
      expect(sse.data.provider).toBe('custom');
    });

    it('neutralises Responses accounting.calls[].provider and aliases .model', () => {
      const body = aliasPayload(
        { accounting: { calls: [{ provider: 'openrouter', model: GLM, input_tokens: 10 }] } },
        map,
      );
      expect(body.accounting.calls[0]).toEqual({
        provider: 'custom',
        model: 'Aralab GPT',
        input_tokens: 10,
      });
      const event = aliasPayload(
        {
          type: 'response.completed',
          response: { accounting: { calls: [{ provider: 'openrouter', model: GLM }] } },
        },
        map,
      );
      expect(event.response.accounting.calls[0]).toEqual({
        provider: 'custom',
        model: 'Aralab GPT',
      });
    });

    it('sends customParams.defaultParamsEndpoint "openrouter" as the neutral aralab-router token (R18)', () => {
      const names = ['Aralab GPT', 'Large File Agents', 'Aralab (dev)', 'Large File Agents (dev)'];
      const endpoints = Object.fromEntries(
        names.map((name) => [
          name,
          { type: 'custom', customParams: { defaultParamsEndpoint: 'openrouter' } },
        ]),
      );
      const out = aliasPayload(endpoints, map);
      for (const name of names) {
        expect(out[name].customParams.defaultParamsEndpoint).toBe('aralab-router');
      }
      expect(JSON.stringify(out)).not.toMatch(/openrouter/i);
    });

    it('keeps "openrouter" inside content keys and only replaces exact values', () => {
      const out = aliasPayload(
        {
          text: 'openrouter',
          content: [{ type: 'text', text: 'openrouter' }],
          note: 'routed through openrouter later',
        },
        map,
      );
      expect(out.text).toBe('openrouter');
      expect(out.content).toEqual([{ type: 'text', text: 'openrouter' }]);
      expect(out.note).toBe('routed through openrouter later');
    });

    it('leaves nothing for findLeaks in a probe slice of /api/endpoints and messages', () => {
      const endpointsSlice = {
        agents: { type: 'agents' },
        'Aralab GPT': {
          type: 'custom',
          userProvide: false,
          userProvideURL: false,
          customParams: { defaultParamsEndpoint: 'openrouter' },
          modelDisplayLabel: 'Aralab GPT',
          providerId: 'openrouter',
        },
        'Large File Agents': {
          type: 'custom',
          customParams: { defaultParamsEndpoint: 'openrouter' },
          modelDisplayLabel: 'Aralab GPT',
          providerId: 'openrouter',
        },
        'Aralab (dev)': {
          type: 'custom',
          customParams: { defaultParamsEndpoint: 'openrouter' },
          modelDisplayLabel: 'Aralab (dev)',
          providerId: 'openrouter',
        },
        'Large File Agents (dev)': {
          type: 'custom',
          customParams: { defaultParamsEndpoint: 'openrouter' },
          modelDisplayLabel: 'Aralab (dev)',
          providerId: 'openrouter',
        },
      };
      const messagesSlice = [
        {
          messageId: 'm1',
          conversationId: 'c1',
          endpoint: 'Aralab GPT',
          model: GLM,
          sender: 'Aralab GPT',
          isCreatedByUser: false,
          text: '',
          content: [{ type: 'text', text: 'I am not GLM via OpenRouter' }],
          metadata: {
            contextUsage: {
              agentId: COMPOSITE,
              provider: 'openrouter',
              model: GLM,
              breakdown: { instructions: 10 },
            },
          },
        },
      ];
      expect(findLeaks(endpointsSlice)).not.toHaveLength(0);
      expect(findLeaks(messagesSlice)).not.toHaveLength(0);
      expect(findLeaks(aliasPayload(endpointsSlice, map))).toEqual([]);
      expect(findLeaks(aliasPayload(messagesSlice, map))).toEqual([]);
      /* content untouched */
      expect(aliasPayload(messagesSlice, map)[0].content).toEqual(messagesSlice[0].content);
    });
  });
});
