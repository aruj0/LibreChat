import { Providers } from '../src/schemas';
import { ARALAB_ROUTER_PARAMS_ENDPOINT, restoreAralabRouterParams } from '../src/aralabRouter';

jest.mock('../src/request', () => ({
  __esModule: true,
  default: { get: jest.fn() },
}));

import request from '../src/request';
import { getAIEndpoints } from '../src/data-service';

/** A slice of `/api/endpoints` as patch 10b serves it. */
const served = () => ({
  agents: { type: 'agents' },
  'Aralab GPT': {
    type: 'custom',
    modelDisplayLabel: 'Aralab GPT',
    customParams: { defaultParamsEndpoint: ARALAB_ROUTER_PARAMS_ENDPOINT },
  },
  'Aralab (dev)': {
    type: 'custom',
    modelDisplayLabel: 'Aralab (dev)',
    customParams: { defaultParamsEndpoint: ARALAB_ROUTER_PARAMS_ENDPOINT, reasoningFormat: 'auto' },
  },
  native: { type: 'custom', customParams: { defaultParamsEndpoint: 'anthropic' } },
});

describe('aralab-router token (Aralab patch 10b, R18)', () => {
  it('is the shared neutral token', () => {
    expect(ARALAB_ROUTER_PARAMS_ENDPOINT).toBe('aralab-router');
    expect(ARALAB_ROUTER_PARAMS_ENDPOINT).not.toMatch(/z-?ai|glm|openrouter|baseten/i);
  });

  it('restores openrouter for every endpoint carrying the token, nothing else', () => {
    const input = served();
    const out = restoreAralabRouterParams(input);
    expect(out?.['Aralab GPT']?.customParams?.defaultParamsEndpoint).toBe(Providers.OPENROUTER);
    expect(out?.['Aralab (dev)']?.customParams).toEqual({
      defaultParamsEndpoint: 'openrouter',
      reasoningFormat: 'auto',
    });
    expect(out?.native?.customParams?.defaultParamsEndpoint).toBe('anthropic');
    expect(out?.agents).toBe(input.agents);
    /* the served object is not mutated */
    expect(input['Aralab GPT'].customParams.defaultParamsEndpoint).toBe('aralab-router');
  });

  it('returns configs without the token (and undefined) as they are', () => {
    const plain = { openAI: { type: 'openAI' } };
    expect(restoreAralabRouterParams(plain)).toBe(plain);
    expect(restoreAralabRouterParams(undefined)).toBeUndefined();
  });

  it('getAIEndpoints (the endpoints queryFn) exposes openrouter after the transform', async () => {
    jest.mocked(request.get).mockResolvedValueOnce(served());
    const config = await getAIEndpoints();
    expect(request.get).toHaveBeenCalledWith('/api/endpoints');
    expect(config?.['Aralab GPT']?.customParams?.defaultParamsEndpoint).toBe('openrouter');
    expect(config?.['Aralab (dev)']?.customParams?.defaultParamsEndpoint).toBe('openrouter');
  });
});
