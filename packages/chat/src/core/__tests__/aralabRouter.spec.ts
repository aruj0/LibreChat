import { ARALAB_ROUTER_PARAMS_ENDPOINT, restoreAralabRouterParams } from 'librechat-data-provider';
import type { TEndpointsConfig } from 'librechat-data-provider';
import { usesReasoningCapabilities } from '../turns/reasoning';

/**
 * Aralab patch 10b (R18): the server serves `defaultParamsEndpoint: 'aralab-router'` for the
 * OpenRouter endpoints; `dataService.getAIEndpoints` restores `openrouter`, so the per-model
 * reasoning catalog is still used.
 */
describe('usesReasoningCapabilities with the served aralab-router token', () => {
  const served: TEndpointsConfig = {
    'Aralab (dev)': {
      type: 'custom',
      customParams: { defaultParamsEndpoint: ARALAB_ROUTER_PARAMS_ENDPOINT },
    } as NonNullable<TEndpointsConfig>[string],
  };

  it('is true for an OpenRouter endpoint once the config came through the transform', () => {
    expect(usesReasoningCapabilities(restoreAralabRouterParams(served), 'Aralab (dev)')).toBe(true);
  });

  it('would be false on the raw served token (why the client must restore it)', () => {
    expect(usesReasoningCapabilities(served, 'Aralab (dev)')).toBe(false);
  });
});
