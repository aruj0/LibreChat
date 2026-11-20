/**
 * Aralab patch 10b — neutral token for an OpenRouter parameter set.
 *
 * The server never sends `customParams.defaultParamsEndpoint: 'openrouter'` to users: it
 * sends this token instead (packages/api `aliasPayload`). The client maps it back to
 * `Providers.OPENROUTER` once, in `dataService.getAIEndpoints`, the only fetch of
 * `/api/endpoints` and the queryFn behind every `[QueryKeys.endpoints]` cache read, so
 * every client branch on `Providers.OPENROUTER` (parameter sets, agent-builder pruning,
 * per-model reasoning catalogs) behaves exactly as before.
 */
import type { TEndpointsConfig } from './types';
import { Providers } from './schemas';

export const ARALAB_ROUTER_PARAMS_ENDPOINT = 'aralab-router';

/** Returns the config with every `aralab-router` `defaultParamsEndpoint` restored to `openrouter`. */
export function restoreAralabRouterParams(config: TEndpointsConfig): TEndpointsConfig {
  if (config == null || typeof config !== 'object') {
    return config;
  }
  let restored: Record<string, unknown> | undefined;
  for (const [name, endpoint] of Object.entries(config)) {
    if (endpoint?.customParams?.defaultParamsEndpoint !== ARALAB_ROUTER_PARAMS_ENDPOINT) {
      continue;
    }
    restored ??= { ...config };
    restored[name] = {
      ...endpoint,
      customParams: { ...endpoint.customParams, defaultParamsEndpoint: Providers.OPENROUTER },
    };
  }
  return (restored as TEndpointsConfig) ?? config;
}
