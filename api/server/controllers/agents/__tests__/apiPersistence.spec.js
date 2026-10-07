/**
 * Aralab patch 8: Agents API calls are saved as ordinary agent conversations.
 */

const { Constants } = require('librechat-data-provider');

let mockUuidCounter = 0;
jest.mock('uuid', () => ({
  v4: jest.fn(() => `00000000-0000-4000-8000-${String(++mockUuidCounter).padStart(12, '0')}`),
}));

jest.mock('@librechat/data-schemas', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('@librechat/api', () => ({
  getConversationWriteContext: (req) => ({
    userId: req?.user?.id ?? '',
    isTemporary: undefined,
    expiredAt: undefined,
    interfaceConfig: req?.config?.interfaceConfig,
  }),
  getSafeErrorMetadata: (error) => ({ type: error instanceof Error ? 'Error' : 'UnknownError' }),
}));

const mockResolveConversationTitle = jest.fn((_req, candidate, fallback) =>
  typeof candidate === 'string' && candidate.trim() !== '' ? candidate : (fallback ?? null),
);
jest.mock('~/server/services/Endpoints/titlePolicy', () => ({
  resolveConversationTitle: (...args) => mockResolveConversationTitle(...args),
}));

jest.mock('~/models', () => ({}));

const { logger } = require('@librechat/data-schemas');
const {
  API_SOURCE,
  isPersistAllEnabled,
  shouldPersistApiCall,
  contentToText,
  lastUserText,
  deriveTitle,
  buildApiMetadata,
  persistApiTurn,
} = require('../apiPersistence');

const CONVO_ID = '11111111-1111-4111-8111-111111111111';

function makeDeps(overrides = {}) {
  return {
    saveConvo: jest.fn().mockResolvedValue({ conversationId: CONVO_ID }),
    saveMessage: jest.fn(async (_ctx, params) => params),
    getAgentApiKeyById: jest.fn().mockResolvedValue({ name: 'power-automate' }),
    ...overrides,
  };
}

function makeReq(overrides = {}) {
  return {
    user: { id: 'user-1' },
    apiKeyId: 'key-1',
    config: { interfaceConfig: {} },
    ...overrides,
  };
}

const agent = { id: 'agent_abc', name: 'Aralab Sales Knowledge Agent', model: 'claude-opus-5-5' };

beforeEach(() => {
  mockUuidCounter = 0;
  jest.clearAllMocks();
});

describe('isPersistAllEnabled / shouldPersistApiCall', () => {
  it.each([
    ['true', true],
    ['TRUE', true],
    ['1', true],
    ['yes', true],
    ['false', false],
    ['0', false],
    ['', false],
    [undefined, false],
  ])('AGENTS_API_PERSIST_ALL=%p -> %p', (value, expected) => {
    expect(isPersistAllEnabled({ AGENTS_API_PERSIST_ALL: value })).toBe(expected);
  });

  it('keeps upstream store:true semantics when the flag is off', () => {
    expect(shouldPersistApiCall({ store: true }, {})).toBe(true);
    expect(shouldPersistApiCall({ store: false }, {})).toBe(false);
    expect(shouldPersistApiCall({}, {})).toBe(false);
  });

  it('saves whatever store says when the flag is on', () => {
    const env = { AGENTS_API_PERSIST_ALL: 'true' };
    expect(shouldPersistApiCall({ store: false }, env)).toBe(true);
    expect(shouldPersistApiCall({}, env)).toBe(true);
  });
});

describe('contentToText / lastUserText', () => {
  it('returns string content as is', () => {
    expect(contentToText('Olá')).toBe('Olá');
  });

  it('joins text parts and drops image/file parts', () => {
    expect(
      contentToText([
        { type: 'text', text: 'first' },
        { type: 'image_url', image_url: { url: 'data:...' } },
        { type: 'input_text', text: 'second' },
        { type: 'file', file: { file_id: 'f' } },
      ]),
    ).toBe('first\n\nsecond');
  });

  it('returns empty for unsupported content', () => {
    expect(contentToText(null)).toBe('');
    expect(contentToText(42)).toBe('');
  });

  it('picks only the last user message of a resent history', () => {
    const messages = [
      { role: 'system', content: 'You are helpful' },
      { role: 'user', content: 'turn one' },
      { role: 'assistant', content: 'answer one' },
      { role: 'user', content: [{ type: 'text', text: 'turn two' }] },
    ];
    expect(lastUserText(messages)).toBe('turn two');
  });

  it('returns empty when there is no user message', () => {
    expect(lastUserText([{ role: 'system', content: 'x' }])).toBe('');
    expect(lastUserText(undefined)).toBe('');
  });
});

describe('deriveTitle', () => {
  it('collapses whitespace onto one line', () => {
    expect(deriveTitle('  Qual a\n\ngama   de\ttemperatura?  ')).toBe(
      'Qual a gama de temperatura?',
    );
  });

  it('cuts at 80 characters with an ellipsis', () => {
    const title = deriveTitle('a'.repeat(200));
    expect(title).toHaveLength(80);
    expect(title.endsWith('…')).toBe(true);
  });

  it('keeps an 80-character text intact', () => {
    expect(deriveTitle('b'.repeat(80))).toBe('b'.repeat(80));
  });

  it('returns empty for blank input', () => {
    expect(deriveTitle('   ')).toBe('');
    expect(deriveTitle(undefined)).toBe('');
  });
});

describe('buildApiMetadata', () => {
  it('names the source, the API and the key', async () => {
    const deps = makeDeps();
    await expect(buildApiMetadata(makeReq(), 'chat.completions', deps)).resolves.toEqual({
      source: API_SOURCE,
      api: 'chat.completions',
      apiKeyName: 'power-automate',
    });
    expect(deps.getAgentApiKeyById).toHaveBeenCalledWith('key-1', 'user-1');
  });

  it('omits the key name when the request has no API key', async () => {
    const deps = makeDeps();
    const metadata = await buildApiMetadata(makeReq({ apiKeyId: undefined }), 'responses', deps);
    expect(metadata).toEqual({ source: API_SOURCE, api: 'responses' });
    expect(deps.getAgentApiKeyById).not.toHaveBeenCalled();
  });

  it('omits the key name when the lookup throws', async () => {
    const deps = makeDeps({ getAgentApiKeyById: jest.fn().mockRejectedValue(new Error('db')) });
    await expect(buildApiMetadata(makeReq(), 'responses', deps)).resolves.toEqual({
      source: API_SOURCE,
      api: 'responses',
    });
  });
});

describe('persistApiTurn', () => {
  const base = {
    api: 'chat.completions',
    conversationId: CONVO_ID,
    agent,
    agentId: agent.id,
    isNewConversation: true,
    firstParentMessageId: Constants.NO_PARENT,
    responseMessageId: 'chatcmpl-xyz',
    responseText: 'A gama é de -70 °C a +180 °C.',
    tokenCount: 42,
    finishReason: 'stop',
  };

  it('saves the conversation, the user message and the reply, chained', async () => {
    const deps = makeDeps();
    const result = await persistApiTurn(
      makeReq(),
      { ...base, userTexts: ['Qual a gama de temperatura?'] },
      deps,
    );

    expect(deps.saveConvo).toHaveBeenCalledTimes(1);
    const [convoCtx, convo, convoMeta] = deps.saveConvo.mock.calls[0];
    expect(convoCtx.userId).toBe('user-1');
    expect(convo).toEqual({
      conversationId: CONVO_ID,
      endpoint: 'agents',
      agent_id: agent.id,
      model: agent.model,
      title: 'Qual a gama de temperatura?',
    });
    expect(convoMeta).toEqual(expect.objectContaining({ initialAgentId: agent.id }));

    expect(deps.saveMessage).toHaveBeenCalledTimes(2);
    const [, userMsg] = deps.saveMessage.mock.calls[0];
    const [, reply] = deps.saveMessage.mock.calls[1];
    const metadata = { source: API_SOURCE, api: 'chat.completions', apiKeyName: 'power-automate' };

    expect(userMsg).toEqual({
      messageId: '00000000-0000-4000-8000-000000000001',
      conversationId: CONVO_ID,
      parentMessageId: Constants.NO_PARENT,
      isCreatedByUser: true,
      text: 'Qual a gama de temperatura?',
      sender: 'User',
      endpoint: 'agents',
      model: agent.id,
      metadata,
    });
    expect(reply).toEqual({
      messageId: 'chatcmpl-xyz',
      conversationId: CONVO_ID,
      parentMessageId: userMsg.messageId,
      isCreatedByUser: false,
      text: base.responseText,
      sender: agent.name,
      endpoint: 'agents',
      model: agent.id,
      metadata,
      tokenCount: 42,
      finish_reason: 'stop',
    });
    expect(result).toEqual({ userMessageIds: [userMsg.messageId], replyMessageId: 'chatcmpl-xyz' });
  });

  it('chains several user messages and hangs the reply off the last one', async () => {
    const deps = makeDeps();
    await persistApiTurn(
      makeReq(),
      { ...base, api: 'responses', firstParentMessageId: 'prev-reply', userTexts: ['a', 'b'] },
      deps,
    );
    const [first, second, reply] = deps.saveMessage.mock.calls.map(([, params]) => params);
    expect(first.parentMessageId).toBe('prev-reply');
    expect(second.parentMessageId).toBe(first.messageId);
    expect(reply.parentMessageId).toBe(second.messageId);
  });

  it('falls back to NO_PARENT when no parent is given', async () => {
    const deps = makeDeps();
    await persistApiTurn(
      makeReq(),
      { ...base, firstParentMessageId: undefined, userTexts: ['q'] },
      deps,
    );
    expect(deps.saveMessage.mock.calls[0][1].parentMessageId).toBe(Constants.NO_PARENT);
  });

  it('does not retitle a continued conversation', async () => {
    const deps = makeDeps();
    await persistApiTurn(
      makeReq(),
      { ...base, isNewConversation: false, userTexts: ['follow-up'] },
      deps,
    );
    expect(deps.saveConvo.mock.calls[0][1]).not.toHaveProperty('title');
    expect(mockResolveConversationTitle).not.toHaveBeenCalled();
  });

  it('falls back to the agent name when the title filter rejects the question', async () => {
    mockResolveConversationTitle.mockImplementationOnce((_req, _candidate, fallback) => fallback);
    const deps = makeDeps();
    await persistApiTurn(makeReq(), { ...base, userTexts: ['secret question'] }, deps);
    expect(mockResolveConversationTitle).toHaveBeenCalledWith(
      expect.anything(),
      'secret question',
      agent.name,
    );
    expect(deps.saveConvo.mock.calls[0][1].title).toBe(agent.name);
  });

  it('uses "Agent" as sender and "Agents API" as title fallback without an agent name', async () => {
    mockResolveConversationTitle.mockImplementationOnce((_req, _candidate, fallback) => fallback);
    const deps = makeDeps();
    const nameless = { id: 'agent_x', model: 'm' };
    await persistApiTurn(
      makeReq(),
      { ...base, agent: nameless, agentId: 'agent_x', userTexts: ['q'] },
      deps,
    );
    expect(deps.saveConvo.mock.calls[0][1].title).toBe('Agents API');
    expect(deps.saveMessage.mock.calls[1][1].sender).toBe('Agent');
  });

  it('omits tokenCount and finish_reason when not given', async () => {
    const deps = makeDeps();
    await persistApiTurn(
      makeReq(),
      { ...base, tokenCount: undefined, finishReason: undefined, userTexts: ['q'] },
      deps,
    );
    const reply = deps.saveMessage.mock.calls[1][1];
    expect(reply).not.toHaveProperty('tokenCount');
    expect(reply).not.toHaveProperty('finish_reason');
  });

  it('writes nothing when there is no user text', async () => {
    const deps = makeDeps();
    await expect(
      persistApiTurn(makeReq(), { ...base, userTexts: ['  ', ''] }, deps),
    ).resolves.toBeNull();
    expect(deps.saveConvo).not.toHaveBeenCalled();
    expect(deps.saveMessage).not.toHaveBeenCalled();
  });

  it('never throws: a failing save is logged and resolves null', async () => {
    const deps = makeDeps({ saveMessage: jest.fn().mockRejectedValue(new Error('mongo down')) });
    await expect(
      persistApiTurn(makeReq(), { ...base, userTexts: ['q'] }, deps),
    ).resolves.toBeNull();
    expect(logger.error).toHaveBeenCalledWith(
      `[Agents API persist] chat.completions conversation=${CONVO_ID}:`,
      expect.objectContaining({ type: 'Error' }),
    );
  });
});
