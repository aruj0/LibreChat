/**
 * Aralab patch 10b — alias `z-ai/*` model ids at the response edge.
 *
 * Mounted on `/api` (see `api/server/index.js`); `/api/admin/*` is exempt. For every other
 * request it:
 * - restores labels the client sends back as `model` to the real id (`resolveAliasedBody`),
 *   so stored conversations, agents, presets and schedules keep the real id;
 * - wraps `res.json` (and so `res.send(object)`) with `aliasPayload`, and `res.send(string)`
 *   with `aliasJsonText` for pre-serialised JSON (`EndpointController`, `abortMessage`);
 * - wraps `res.write` for SSE frames with `aliasSseChunk`. Every stream writer (`sendEvent`,
 *   the resumable chat stream, Agents API chat-completion chunks, Responses events,
 *   attachments) ends in `res.write`, so this one wrap covers them all.
 *
 * The map comes from `req.config` when a route resolved it, else from the YAML base config
 * (read once per request, cached in-process by the config service).
 */
const { logger } = require('@librechat/data-schemas');
const {
  aliasPayload,
  aliasSseChunk,
  aliasJsonText,
  getModelAliasMap,
  resolveAliasedBody,
  isModelAliasEnabled,
} = require('@librechat/api');

/* Kill switch (ARALAB_MODEL_ALIAS=false): the helpers above return their input unchanged, so
 * outbound payloads carry the real ids; request-side resolution below stays on. Say so loudly
 * at boot, since vendor names then reach users. */
if (!isModelAliasEnabled()) {
  logger.warn(
    '[aralab/modelAlias] Response aliasing DISABLED by ARALAB_MODEL_ALIAS: model ids and upstream names reach users',
  );
}

const ADMIN_PATH = /^\/api\/admin(?:[/?#]|$)/;

/** @type {import('@librechat/api').ModelAliasMap | undefined} */
let lastBaseMap;

function mapFor(config) {
  return config != null && typeof config === 'object' ? getModelAliasMap(config) : undefined;
}

/**
 * The alias map for a request: `req.config` if set, else the base config captured by the
 * middleware, else an empty map (z-ai ids still alias to "Aralab GPT"; labels do not resolve).
 * @param {import('express').Request} req
 */
function getRequestAliasMap(req) {
  const scoped = mapFor(req?.config);
  if (scoped != null && scoped.toAlias.size > 0) {
    return scoped;
  }
  /* No req.config, or a partial one without custom endpoints (e.g. a route-specific config). */
  return req?.aralabBaseAliasMap ?? lastBaseMap ?? scoped ?? getModelAliasMap(null);
}

function isEventStream(res, chunk) {
  const type = res.getHeader?.('Content-Type');
  if (typeof type === 'string' && type.toLowerCase().includes('text/event-stream')) {
    return true;
  }
  return /^(?:event|data):/.test(chunk);
}

/** Only an untyped or JSON body; never a download (text files carry user content). */
function isJsonBody(res) {
  if (res.getHeader?.('Content-Disposition') != null) {
    return false;
  }
  const type = res.getHeader?.('Content-Type');
  return type == null || /json/i.test(String(type));
}

async function aliasJsonResponses(req, res, next) {
  if (ADMIN_PATH.test(req.originalUrl ?? '')) {
    return next();
  }

  try {
    /* Lazy: modules that only need getRequestAliasMap (error.js, buildEndpointOption) must
     * not pull the config service in at require time. */
    const { getAppConfig } = require('~/server/services/Config/app');
    const base = await getAppConfig({ baseOnly: true });
    const baseMap = mapFor(base);
    if (baseMap != null) {
      lastBaseMap = baseMap;
      req.aralabBaseAliasMap = baseMap;
    }
  } catch (error) {
    logger.warn('[aralab/modelAlias] Base config unavailable; using the last known alias map', {
      message: error?.message,
    });
  }

  try {
    if (req.body != null && typeof req.body === 'object') {
      resolveAliasedBody(req.body, getRequestAliasMap(req));
    }
  } catch (error) {
    logger.warn('[aralab/modelAlias] Could not resolve aliased models in the request body', {
      message: error?.message,
    });
  }

  /* res.json → res.send(string): the flag keeps the serialised copy from being parsed again. */
  let inJson = false;
  const json = res.json.bind(res);
  res.json = (body) => {
    let out = body;
    try {
      out = aliasPayload(body, getRequestAliasMap(req));
    } catch (error) {
      logger.error('[aralab/modelAlias] Could not alias a JSON response', {
        message: error?.message,
      });
    }
    inJson = true;
    try {
      return json(out);
    } finally {
      inJson = false;
    }
  };

  /* Pre-serialised JSON bodies (`res.send(JSON.stringify(…))`). */
  const send = res.send.bind(res);
  res.send = (body) => {
    let out = body;
    if (!inJson && typeof body === 'string' && isJsonBody(res)) {
      try {
        out = aliasJsonText(body, getRequestAliasMap(req));
      } catch (error) {
        logger.error('[aralab/modelAlias] Could not alias a serialised JSON response', {
          message: error?.message,
        });
      }
    }
    return send(out);
  };

  const write = res.write.bind(res);
  res.write = (chunk, ...rest) => {
    let out = chunk;
    if (typeof chunk === 'string' && isEventStream(res, chunk)) {
      try {
        out = aliasSseChunk(chunk, getRequestAliasMap(req));
      } catch (error) {
        logger.error('[aralab/modelAlias] Could not alias an SSE frame', {
          message: error?.message,
        });
      }
    }
    return write(out, ...rest);
  };

  return next();
}

module.exports = aliasJsonResponses;
module.exports.aliasJsonResponses = aliasJsonResponses;
module.exports.getRequestAliasMap = getRequestAliasMap;
