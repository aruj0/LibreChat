/**
 * Aralab patch 8: save Agents API calls as ordinary agent conversations.
 *
 * Upstream's OpenAI-compatible endpoint (`/api/agents/v1/chat/completions`) never saves, and
 * the Responses endpoint saves only on `store: true`. With `AGENTS_API_PERSIST_ALL` enabled,
 * both save every successful call under the API key's owner, so the turns show up in the
 * conversation list and in reporting built on the `messages` collection. Unset, behaviour is
 * exactly upstream.
 *
 * Writes go through the same `saveConvo` / `saveMessage` primitives and write context as UI
 * chats, so retention and temporary-chat rules apply unchanged.
 */
const { v4: uuidv4 } = require('uuid');
const { logger } = require('@librechat/data-schemas');
const { Constants, EModelEndpoint } = require('librechat-data-provider');
const { getConversationWriteContext, getSafeErrorMetadata } = require('@librechat/api');
const { resolveConversationTitle } = require('~/server/services/Endpoints/titlePolicy');
const db = require('~/models');

/** `metadata.source` on every message this module writes. */
const API_SOURCE = 'agents-api';
const TITLE_MAX_LENGTH = 80;
const TITLE_FALLBACK = 'Agents API';

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
function isPersistAllEnabled(env = process.env) {
  return /^(true|1|yes)$/i.test(String(env.AGENTS_API_PERSIST_ALL ?? '').trim());
}

/**
 * Responses API save gate: upstream's `store: true`, or always with the flag on.
 * @param {{ store?: boolean }} request
 * @param {NodeJS.ProcessEnv} [env]
 */
function shouldPersistApiCall(request, env = process.env) {
  return request?.store === true || isPersistAllEnabled(env);
}

/**
 * Text of an OpenAI / Open Responses message `content`: strings as is, text parts joined,
 * image and file parts dropped.
 * @param {unknown} content
 * @returns {string}
 */
function contentToText(content) {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .filter(
      (part) =>
        part != null &&
        (part.type === 'text' || part.type === 'input_text') &&
        typeof part.text === 'string',
    )
    .map((part) => part.text)
    .join('\n\n');
}

/**
 * Chat-completions callers resend the whole history on every call; only the last user
 * message is this call's new turn.
 * @param {Array<{ role?: string, content?: unknown }> | undefined} messages
 * @returns {string}
 */
function lastUserText(messages) {
  if (!Array.isArray(messages)) {
    return '';
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') {
      return contentToText(messages[i].content);
    }
  }
  return '';
}

/**
 * One line, at most {@link TITLE_MAX_LENGTH} characters.
 * @param {string | undefined} text
 * @returns {string}
 */
function deriveTitle(text) {
  const line = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (line.length <= TITLE_MAX_LENGTH) {
    return line;
  }
  return `${line.slice(0, TITLE_MAX_LENGTH - 1).trimEnd()}…`;
}

/**
 * @param {import('express').Request} req
 * @param {'chat.completions' | 'responses'} api
 * @param {{ getAgentApiKeyById?: Function }} [deps]
 * @returns {Promise<{ source: string, api: string, apiKeyName?: string }>}
 */
async function buildApiMetadata(req, api, deps = db) {
  const metadata = { source: API_SOURCE, api };
  const keyId = req?.apiKeyId?.toString();
  const userId = req?.user?.id;
  if (!keyId || !userId || typeof deps.getAgentApiKeyById !== 'function') {
    return metadata;
  }
  try {
    const key = await deps.getAgentApiKeyById(keyId, userId);
    if (typeof key?.name === 'string' && key.name !== '') {
      metadata.apiKeyName = key.name;
    }
  } catch (error) {
    logger.debug('[Agents API persist] API key name lookup failed', getSafeErrorMetadata(error));
  }
  return metadata;
}

/**
 * Saves one API turn: the conversation, this turn's user message(s) chained in order, and the
 * reply hanging off the last of them. Never throws; a failed save is logged and the caller's
 * response is unaffected.
 *
 * @param {import('express').Request} req
 * @param {object} params
 * @param {'chat.completions' | 'responses'} params.api
 * @param {string} params.conversationId - must be a UUID (`saveMessage` drops anything else)
 * @param {{ id?: string, name?: string, model?: string } | null | undefined} params.agent
 * @param {string} params.agentId
 * @param {boolean} params.isNewConversation - titles are only set on new conversations
 * @param {string[]} params.userTexts
 * @param {string | null | undefined} params.firstParentMessageId
 * @param {string} params.responseMessageId
 * @param {string} params.responseText
 * @param {number} [params.tokenCount]
 * @param {string} [params.finishReason]
 * @param {object} [deps] - `saveConvo`, `saveMessage`, `getAgentApiKeyById`; defaults to `~/models`
 * @returns {Promise<{ userMessageIds: string[], replyMessageId: string } | null>}
 */
async function persistApiTurn(req, params, deps = db) {
  const { api, conversationId, agent, agentId } = params;
  try {
    const userTexts = (params.userTexts ?? []).filter(
      (text) => typeof text === 'string' && text.trim() !== '',
    );
    if (userTexts.length === 0) {
      logger.debug(`[Agents API persist] ${api} conversation=${conversationId}: no user text`);
      return null;
    }

    const ctx = getConversationWriteContext(req);
    const metadata = await buildApiMetadata(req, api, deps);
    const context = `Agents API persist - ${api}`;

    let title;
    if (params.isNewConversation) {
      title = resolveConversationTitle(
        req,
        deriveTitle(userTexts[userTexts.length - 1]),
        agent?.name || TITLE_FALLBACK,
      );
    }

    await deps.saveConvo(
      ctx,
      {
        conversationId,
        endpoint: EModelEndpoint.agents,
        agent_id: agentId,
        model: agent?.model,
        ...(title != null && title !== '' && { title }),
      },
      { context, initialAgentId: agent?.id === agentId ? agentId : null },
    );

    let parentMessageId = params.firstParentMessageId || Constants.NO_PARENT;
    const userMessageIds = [];
    for (const text of userTexts) {
      const messageId = uuidv4();
      await deps.saveMessage(
        ctx,
        {
          messageId,
          conversationId,
          parentMessageId,
          isCreatedByUser: true,
          text,
          sender: 'User',
          endpoint: EModelEndpoint.agents,
          model: agentId,
          metadata,
        },
        { context },
      );
      userMessageIds.push(messageId);
      parentMessageId = messageId;
    }

    await deps.saveMessage(
      ctx,
      {
        messageId: params.responseMessageId,
        conversationId,
        parentMessageId,
        isCreatedByUser: false,
        text: params.responseText ?? '',
        sender: agent?.name || 'Agent',
        endpoint: EModelEndpoint.agents,
        model: agentId,
        metadata,
        ...(params.tokenCount != null && { tokenCount: params.tokenCount }),
        ...(params.finishReason && { finish_reason: params.finishReason }),
      },
      { context },
    );

    logger.debug(
      `[Agents API persist] ${api} conversation=${conversationId} saved ${userMessageIds.length + 1} message(s)`,
    );
    return { userMessageIds, replyMessageId: params.responseMessageId };
  } catch (error) {
    logger.error(
      `[Agents API persist] ${api} conversation=${conversationId}:`,
      getSafeErrorMetadata(error),
    );
    return null;
  }
}

/**
 * Responses API (v0.8.9+): upstream now persists through `createResponseTurn` and its own
 * input/output savers, and already chains `parentMessageId`. Patch 8 only wraps the
 * `saveMessage` dependency handed to `turn.stage` so every saved row carries
 * `metadata.{source, api, apiKeyName}` (merged over upstream's `responseInputRole`) and the
 * reply's `sender` is the agent name instead of the constant 'Agent'.
 * With the flag off it returns `saveMessage` untouched (exact upstream).
 * @param {Function} saveMessage - db.saveMessage
 * @param {import('express').Request} req
 * @param {string | undefined} agentName
 * @param {object} [deps]
 */
function withApiMetadata(saveMessage, req, agentName, deps = db, env = process.env) {
  if (!isPersistAllEnabled(env)) {
    return saveMessage;
  }
  let metadataPromise;
  return async (context, message, options) => {
    metadataPromise ??= buildApiMetadata(req, 'responses', deps);
    const apiMetadata = await metadataPromise;
    const tagged = {
      ...message,
      metadata: { ...(message?.metadata ?? {}), ...apiMetadata },
      ...(message?.isCreatedByUser !== true &&
        message?.sender === 'Agent' &&
        typeof agentName === 'string' &&
        agentName !== '' && { sender: agentName }),
    };
    return saveMessage(context, tagged, options);
  };
}

module.exports = {
  API_SOURCE,
  isPersistAllEnabled,
  shouldPersistApiCall,
  contentToText,
  lastUserText,
  deriveTitle,
  buildApiMetadata,
  persistApiTurn,
  withApiMetadata,
};
