/**
 * Aralab patch 10b — edge aliasing of `z-ai/*` model ids.
 *
 * Users must never see the vendor or model behind "Aralab GPT": no `z-ai/…` id, no
 * OpenRouter URL or provider name. Stored data (Mongo, logs, Langfuse) keeps the real
 * ids; these helpers run only where a payload leaves the server (`res.json`, SSE frames,
 * error text) and, in reverse, where a client sends the label back as a model id.
 *
 * Only ids starting with `z-ai/` are aliased, to the owning custom endpoint's
 * `modelDisplayLabel`. Claude/Gemini ids, including the "(dev)" `anthropic/…` and
 * `google/…` ids, pass through. Model-generated content (`text`, `content`,
 * `reasoning`, `think`) is never rewritten; only server-authored error text is
 * sanitised.
 */
import {
  encodeEphemeralAgentId,
  parseEphemeralAgentId,
  ARALAB_ROUTER_PARAMS_ENDPOINT,
} from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';

/** `toAlias`: real id → label. `toReal`: `${endpoint}::${label}` → real id. */
export type ModelAliasMap = { toAlias: Map<string, string>; toReal: Map<string, string> };

/** Used when a `z-ai/` id has no single owning label (or no config is at hand). */
const FALLBACK_LABEL = 'Aralab GPT';
/** A whole value shaped like a GLM id (`z-ai/glm-5.3-flash`, `…-20260826`), not text that starts with one. */
const ALIASED_ID = /^z-ai\/[\w.:-]+$/i;
/** Text that may carry an upstream identity; anything else is never sanitised. */
const UPSTREAM_TRIGGER = /z-ai|openrouter|baseten|glm/i;
/** Keys whose values are model-generated content: never rewritten. */
const CONTENT_KEYS = new Set(['text', 'content', 'reasoning', 'think']);
/** Keys whose string values are server-authored error text. */
const ERROR_KEYS = new Set(['error', 'errorText', 'errorMessage', 'message']);
const OPENROUTER_URL = /^\s*(?:https?:)?\/\/(?:[^/?#\s]*\.)?openrouter\.ai(?:[:/?#]|\s*$)/i;
const MAX_BODY_DEPTH = 6;
/** A bare upstream gateway name as a value (`provider`, `defaultParamsEndpoint`, …). */
const OPENROUTER_VALUE = /^\s*openrouter\s*$/i;
/**
 * What a bare `openrouter` value becomes (`contextUsage.provider`, `accounting.calls[].provider`,
 * …): display/API metadata the client does not branch on. `customParams.defaultParamsEndpoint`
 * is the exception: the client branches on it (parameter sets, agent-builder pruning, per-model
 * reasoning catalogs), so it gets `ARALAB_ROUTER_PARAMS_ENDPOINT`, which
 * `dataService.getAIEndpoints` maps back to `openrouter` (ruling R18).
 */
const NEUTRAL_PROVIDER = 'custom';
/** Request keys that may carry an ephemeral agent id (`<endpoint>__<model>___<sender>`). */
const AGENT_ID_KEYS = new Set(['agent_id', 'agentId']);

type CustomEndpointLike = {
  name?: unknown;
  modelDisplayLabel?: unknown;
  models?: { default?: unknown };
};

function modelIds(models: CustomEndpointLike['models']): string[] {
  const list = Array.isArray(models?.default) ? (models?.default as unknown[]) : [];
  return list.flatMap((item) => {
    if (typeof item === 'string') {
      return [item];
    }
    if (
      item != null &&
      typeof item === 'object' &&
      typeof (item as { name?: unknown }).name === 'string'
    ) {
      return [(item as { name: string }).name];
    }
    return [];
  });
}

/**
 * Builds the alias map from the custom endpoints whose `models.default` holds `z-ai/`
 * ids and that set a `modelDisplayLabel`. An id claimed by endpoints with different
 * labels maps to the fallback label.
 */
export function buildModelAliasMap(appConfig?: AppConfig | null): ModelAliasMap {
  const toAlias = new Map<string, string>();
  const toReal = new Map<string, string>();
  const endpoints = (appConfig?.endpoints as { custom?: unknown } | undefined)?.custom;
  if (!Array.isArray(endpoints)) {
    return { toAlias, toReal };
  }
  for (const endpoint of endpoints as CustomEndpointLike[]) {
    const { name, modelDisplayLabel: label } = endpoint ?? {};
    if (typeof name !== 'string' || typeof label !== 'string' || label.trim() === '') {
      continue;
    }
    for (const id of modelIds(endpoint.models)) {
      if (!ALIASED_ID.test(id)) {
        continue;
      }
      const existing = toAlias.get(id);
      toAlias.set(id, existing == null || existing === label ? label : FALLBACK_LABEL);
      const key = `${name}::${label}`;
      if (!toReal.has(key)) {
        toReal.set(key, id);
      }
    }
  }
  return { toAlias, toReal };
}

const mapCache = new WeakMap<object, ModelAliasMap>();
let emptyMap: ModelAliasMap | undefined;

/** `buildModelAliasMap`, memoised per config object (configs are immutable once resolved). */
export function getModelAliasMap(appConfig?: AppConfig | null): ModelAliasMap {
  if (appConfig == null || typeof appConfig !== 'object') {
    emptyMap ??= buildModelAliasMap(null);
    return emptyMap;
  }
  let map = mapCache.get(appConfig);
  if (map == null) {
    map = buildModelAliasMap(appConfig);
    mapCache.set(appConfig, map);
  }
  return map;
}

/** The label for a `z-ai/` id, including ids with a suffix (`…-20260826`). */
function labelFor(id: string, map: ModelAliasMap): string {
  const exact = map.toAlias.get(id);
  if (exact != null) {
    return exact;
  }
  let best: [string, string] | undefined;
  for (const entry of map.toAlias) {
    if (id.startsWith(entry[0]) && (best == null || entry[0].length > best[0].length)) {
      best = entry;
    }
  }
  if (best != null) {
    return best[1];
  }
  const labels = new Set(map.toAlias.values());
  return labels.size === 1 ? [...labels][0] : FALLBACK_LABEL;
}

function isAliasedId(value: string, map: ModelAliasMap): boolean {
  return map.toAlias.has(value) || ALIASED_ID.test(value);
}

/**
 * An ephemeral agent id whose model segment is a GLM id, with that segment aliased:
 * `Aralab GPT__z-ai/glm-5.3-flash___Aralab GPT` → `Aralab GPT__Aralab GPT___Aralab GPT`.
 */
function aliasEphemeralId(value: string, map: ModelAliasMap): string | undefined {
  if (!value.includes('__')) {
    return undefined;
  }
  const parsed = parseEphemeralAgentId(value);
  if (parsed == null || !isAliasedId(parsed.model, map)) {
    return undefined;
  }
  return encodeEphemeralAgentId({ ...parsed, model: labelFor(parsed.model, map) });
}

/** A value or key that names a GLM model: a bare id or an ephemeral agent id carrying one. */
function aliasIdToken(value: string, map: ModelAliasMap): string | undefined {
  if (isAliasedId(value, map)) {
    return labelFor(value, map);
  }
  return aliasEphemeralId(value, map);
}

function aliasString(value: string, map: ModelAliasMap): string {
  const token = aliasIdToken(value, map);
  if (token != null) {
    return token;
  }
  if (OPENROUTER_URL.test(value)) {
    return '';
  }
  if (OPENROUTER_VALUE.test(value)) {
    return NEUTRAL_PROVIDER;
  }
  return value;
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function sanitizeErrorPart(part: unknown, map: ModelAliasMap): unknown {
  if (
    part != null &&
    typeof part === 'object' &&
    (part as { type?: unknown }).type === 'error' &&
    typeof (part as { error?: unknown }).error === 'string'
  ) {
    return { ...part, error: sanitizeUpstreamError((part as { error: string }).error, map) };
  }
  return part;
}

/**
 * `memo` maps each input object to its aliased copy: a reference shared by two branches is
 * aliased once and reused, and a true cycle resolves to the copy under construction.
 */
function aliasValue(value: unknown, map: ModelAliasMap, memo: WeakMap<object, unknown>): unknown {
  if (typeof value === 'string') {
    return aliasString(value, map);
  }
  if (value == null || typeof value !== 'object') {
    return value;
  }
  if (memo.has(value)) {
    return memo.get(value);
  }
  if (Array.isArray(value)) {
    const outArray: unknown[] = [];
    memo.set(value, outArray);
    for (const item of value) {
      outArray.push(aliasValue(item, map, memo));
    }
    return outArray;
  }
  if (!isPlainObject(value)) {
    /* Mongoose documents serialise through toJSON; Date, ObjectId, Buffer stay as they are. */
    const toJSON = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === 'function' && !(value instanceof Date)) {
      const json = toJSON.call(value);
      if (json != null && typeof json === 'object' && json !== value) {
        const aliased = aliasValue(json, map, memo);
        memo.set(value, aliased);
        return aliased;
      }
    }
    return value;
  }

  const isErrorMessage = value.error === true;
  const out: Record<string, unknown> = {};
  memo.set(value, out);
  for (const [key, child] of Object.entries(value)) {
    if (key === 'baseURL') {
      continue;
    }
    if (key === 'providerId' && typeof child === 'string' && /openrouter/i.test(child)) {
      continue;
    }
    if (CONTENT_KEYS.has(key)) {
      if (key === 'text' && isErrorMessage && typeof child === 'string') {
        out[key] = sanitizeUpstreamError(child, map);
      } else if (key === 'content' && Array.isArray(child)) {
        out[key] = child.map((part) => sanitizeErrorPart(part, map));
      } else {
        out[key] = child;
      }
      continue;
    }
    if (
      key === 'defaultParamsEndpoint' &&
      typeof child === 'string' &&
      OPENROUTER_VALUE.test(child)
    ) {
      out[key] = ARALAB_ROUTER_PARAMS_ENDPOINT;
      continue;
    }
    if (ERROR_KEYS.has(key) && typeof child === 'string') {
      out[key] = sanitizeUpstreamError(child, map);
      continue;
    }
    const outKey = aliasIdToken(key, map) ?? key;
    if (outKey !== key && Object.prototype.hasOwnProperty.call(out, outKey)) {
      continue;
    }
    out[outKey] = aliasValue(child, map, memo);
  }
  return out;
}

/**
 * Deep copy for the wire: `z-ai/` ids (values and object keys) become the label,
 * `baseURL` keys and an OpenRouter `providerId` are dropped, OpenRouter URLs become `''`,
 * and server error text is sanitised. Model content keys are copied untouched, except
 * error parts (`{type:'error'}`) inside `content` and `text` on an `error: true` message.
 */
export function aliasPayload<T>(value: T, map: ModelAliasMap): T {
  return aliasValue(value, map, new WeakMap()) as T;
}

/** The real id for `(endpoint, label)`; any other input (including real ids) unchanged. */
export function resolveAliasedModel(endpoint: string, model: string, map: ModelAliasMap): string {
  if (typeof endpoint !== 'string' || typeof model !== 'string') {
    return model;
  }
  return map.toReal.get(`${endpoint}::${model}`) ?? model;
}

/**
 * Inbound counterpart of the composite alias: an ephemeral agent id whose model segment is a
 * label owned by its endpoint segment gets the real id back
 * (`Aralab GPT__Aralab GPT___Aralab GPT` → `Aralab GPT__z-ai/glm-5.3-flash___Aralab GPT`).
 * Real ids, saved agent ids and other composites are returned unchanged.
 */
export function resolveAliasedEphemeralId(agentId: string, map: ModelAliasMap): string {
  if (typeof agentId !== 'string' || !agentId.includes('__')) {
    return agentId;
  }
  const parsed = parseEphemeralAgentId(agentId);
  if (parsed == null) {
    return agentId;
  }
  const real = map.toReal.get(`${parsed.endpoint}::${parsed.model}`);
  return real == null ? agentId : encodeEphemeralAgentId({ ...parsed, model: real });
}

/** A label the client sent without (or with a non-owning) endpoint: resolve it only if unambiguous. */
function resolveLabel(endpoint: string | undefined, model: string, map: ModelAliasMap): string {
  if (endpoint != null) {
    const real = map.toReal.get(`${endpoint}::${model}`);
    if (real != null) {
      return real;
    }
  }
  const suffix = `::${model}`;
  const candidates = new Set<string>();
  for (const [key, real] of map.toReal) {
    if (key.endsWith(suffix)) {
      candidates.add(real);
    }
  }
  return candidates.size === 1 ? [...candidates][0] : model;
}

function resolveBodyValue(
  value: unknown,
  map: ModelAliasMap,
  endpoint: string | undefined,
  depth: number,
  seen: WeakSet<object>,
): void {
  if (value == null || typeof value !== 'object' || depth > MAX_BODY_DEPTH || seen.has(value)) {
    return;
  }
  /* `seen` is the current recursion stack (cycle guard), not every visited object. */
  seen.add(value);
  try {
    resolveBodyRecord(value, map, endpoint, depth, seen);
  } finally {
    seen.delete(value);
  }
}

function resolveBodyRecord(
  value: object,
  map: ModelAliasMap,
  endpoint: string | undefined,
  depth: number,
  seen: WeakSet<object>,
): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      resolveBodyValue(item, map, endpoint, depth + 1, seen);
    }
    return;
  }
  const record = value as Record<string, unknown>;
  let scope = endpoint;
  if (typeof record.endpoint === 'string') {
    scope = record.endpoint;
  } else if (typeof record.provider === 'string') {
    scope = record.provider;
  }
  for (const key of Object.keys(record)) {
    if (CONTENT_KEYS.has(key)) {
      continue;
    }
    const child = record[key];
    if (key === 'model' && typeof child === 'string') {
      record[key] = resolveLabel(scope, child, map);
    } else if (AGENT_ID_KEYS.has(key) && typeof child === 'string') {
      record[key] = resolveAliasedEphemeralId(child, map);
    } else if (child != null && typeof child === 'object') {
      resolveBodyValue(child, map, scope, depth + 1, seen);
    }
  }
}

/**
 * Inbound counterpart of `aliasPayload`, in place: a `model` field holding a label is
 * restored to the real id, scoped by the nearest `endpoint`/`provider`, so aliased
 * config/conversations sent back by the client (chat, agents, presets, schedules)
 * never store or run the label.
 */
export function resolveAliasedBody<T>(body: T, map: ModelAliasMap): T {
  if (map.toReal.size > 0) {
    resolveBodyValue(body, map, undefined, 0, new WeakSet());
  }
  return body;
}

/**
 * Error text for the client: real ids become the label; the "Providers serving <id>:
 * <list>" clause, upstream URLs (host matching openrouter/z-ai/glm/baseten) and the words
 * OpenRouter, z-ai/z.ai, GLM… and baseten are removed. Text that mentions none of
 * `z-ai|openrouter|baseten|glm` is returned unchanged. Log the original before calling this.
 */
export function sanitizeUpstreamError(text: string, map: ModelAliasMap): string {
  if (typeof text !== 'string' || !UPSTREAM_TRIGGER.test(text)) {
    return text;
  }
  let out = text
    .replace(/\s*\bProviders? serving\b[^:\n"]*:[^\n"]*?(?=\.\s+[A-Z]|["\n]|$)/gi, '')
    .replace(/\bz-ai\/[\w.:-]*\w/gi, (id) => labelFor(id, map));
  for (const [id, label] of map.toAlias) {
    out = out.split(id).join(label);
  }
  out = out
    .replace(/\b(?:https?:\/\/|www\.)[^\s"'<>]+/gi, (url) =>
      UPSTREAM_TRIGGER.test(urlHost(url)) ? '' : url,
    )
    .replace(/\bopenrouter(?:\.ai)?\b/gi, '')
    .replace(/\bz[-.]?ai\b/gi, '')
    .replace(/\bglm[-\w.]*/gi, '')
    .replace(/\bbaseten\b/gi, '')
    .replace(/\b(?:via|from|on|at|by)\s*(?=[.,;:)"\n]|$)/gi, '')
    .replace(/\(\s*\)/g, '')
    .replace(/[ \t]+([.,;:)])/g, '$1')
    .replace(/\.(?:\s*\.)+/g, '.')
    .replace(/^\s*[:,;–-]\s*/, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  return out === '' ? 'An error occurred while processing your request.' : out;
}

function urlHost(url: string): string {
  return url.replace(/^(?:https?:\/\/)?/i, '').split(/[/?#]/, 1)[0] ?? '';
}

/** Cheap pre-check so ordinary token deltas are written without a parse. */
const SSE_TRIGGER = /z-ai|openrouter|baseten|glm|baseURL|providerId/i;

/**
 * Aliases the JSON `data:` lines of one SSE write (any writer: chat, resumable
 * streams, Agents API chunks, Responses events). Non-JSON lines (`[DONE]`, `event:`)
 * are kept; a top-level JSON string (an error frame) is sanitised.
 */
export function aliasSseChunk(chunk: string, map: ModelAliasMap): string {
  if (!SSE_TRIGGER.test(chunk)) {
    return chunk;
  }
  return chunk.replace(/^(data: ?)(.+)$/gm, (line, prefix: string, body: string) => {
    try {
      const parsed: unknown = JSON.parse(body);
      const out =
        typeof parsed === 'string' ? sanitizeUpstreamError(parsed, map) : aliasPayload(parsed, map);
      return `${prefix}${JSON.stringify(out)}`;
    } catch {
      return line;
    }
  });
}

/**
 * `aliasPayload` for a body already serialised to JSON (`res.send(JSON.stringify(…))`, as
 * `EndpointController` and `abortMessage` do). Text that is not JSON is returned unchanged.
 */
export function aliasJsonText(text: string, map: ModelAliasMap): string {
  if (!SSE_TRIGGER.test(text)) {
    return text;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed == null || typeof parsed !== 'object') {
      return text;
    }
    return JSON.stringify(aliasPayload(parsed, map));
  } catch {
    return text;
  }
}
