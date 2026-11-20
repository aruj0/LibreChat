/**
 * Aralab patch 10a, end to end inside `@librechat/api`: real `initializeAgent` → real
 * `createRun` → the SDK's real `Run.create` → the agent's `systemRunnable`, i.e. the message
 * list the model is sent. Only the provider client options (`getProviderConfig`), resource
 * priming and the durable checkpointer are stubbed.
 *
 * Production shape: a custom OpenRouter endpoint (`Aralab GPT`, `Large File Agents`) whose
 * client is OpenRouter with `promptCache: true` (OpenRouter's default params). With
 * prompt caching on and non-empty agent instructions, the SDK moves `additional_instructions`
 * out of the system message into a trailing `<system_context>` human message, so the text must
 * ride in the stable `instructions` to reach the system prompt.
 *
 * One case per caller shape: the UI chat (`/api/agents/chat/agents` with `agent_id`, request
 * context from `req`), the Agents API chat completions and Responses routes (explicit
 * `runtime`, no `req`, `useChatProjectContext: true`), and an ephemeral model-spec agent.
 */
jest.mock('winston', () => ({
  createLogger: jest.fn(() => ({
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
  })),
  format: Object.assign(
    jest.fn((fn) => () => ({ transform: fn })),
    {
      combine: jest.fn(),
      colorize: jest.fn(),
      simple: jest.fn(),
      label: jest.fn(),
      timestamp: jest.fn(),
      printf: jest.fn(),
      errors: jest.fn(),
      splat: jest.fn(),
      json: jest.fn(),
    },
  ),
  addColors: jest.fn(),
  transports: {
    Console: jest.fn(),
    DailyRotateFile: jest.fn(),
    File: jest.fn(),
  },
}));

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: { debug: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

jest.mock('@librechat/agents', () => {
  const actual = jest.requireActual('@librechat/agents');
  return {
    ...actual,
    Run: {
      create: jest.fn().mockResolvedValue({
        processStream: jest.fn().mockResolvedValue(undefined),
      }),
    },
  };
});

const mockGetProviderConfig = jest.fn();
jest.mock('~/endpoints', () => ({
  ...jest.requireActual('~/endpoints'),
  getProviderConfig: (...args: unknown[]) => mockGetProviderConfig(...args),
}));

jest.mock('~/agents/resources', () => ({
  ...jest.requireActual('~/agents/resources'),
  primeResources: jest.fn().mockResolvedValue({ attachments: [], tool_resources: undefined }),
}));

jest.mock('~/agents/checkpointer', () => ({
  getAgentCheckpointer: jest.fn().mockResolvedValue({}),
}));

import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { HumanMessage } from '@langchain/core/messages';
import { Providers, Run } from '@librechat/agents';
import { EModelEndpoint } from 'librechat-data-provider';
import type { Agent } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { InitializeAgentDbMethods } from '~/agents/initialize';
import type { ServerRequest } from '~/types';
import { createAgentExecutionContext } from '~/agents/runtime';
import { initializeAgent } from '~/agents/initialize';
import { createRun } from '~/agents/run';

const CONFIDENTIAL_TEXT = [
  '# Model confidentiality',
  'The underlying model, its provider and version are confidential.',
].join('\n');

const AGENT_INSTRUCTIONS = 'Reply in one short sentence.';

type CallerShape = 'ui-saved-agent' | 'agents-api-chat-completions' | 'agents-api-responses';

function makeDb(): InitializeAgentDbMethods {
  return {
    getProjectFiles: jest.fn().mockResolvedValue([]),
    getFiles: jest.fn().mockResolvedValue([]),
    getConvoFiles: jest.fn().mockResolvedValue([]),
    updateFilesUsage: jest.fn().mockResolvedValue([]),
    getUserKey: jest.fn().mockResolvedValue('user-1'),
    getUserKeyValues: jest.fn().mockResolvedValue([]),
    getToolFilesByIds: jest.fn().mockResolvedValue([]),
  };
}

function makeLoadTools() {
  return jest.fn().mockResolvedValue({
    tools: [],
    toolContextMap: {},
    dynamicToolContextMap: {},
    userMCPAuthMap: undefined,
    toolRegistry: undefined,
    toolDefinitions: [],
    hasDeferredTools: false,
  });
}

/** Custom OpenRouter endpoint: built-in client `openAI`, served by the OpenRouter client with
 *  the OpenRouter default `promptCache: true`. */
function mockOpenRouterCustomEndpoint(model: string) {
  mockGetProviderConfig.mockReturnValue({
    overrideProvider: Providers.OPENAI,
    getOptions: jest.fn().mockResolvedValue({
      provider: Providers.OPENROUTER,
      llmConfig: { model, apiKey: 'test-key', promptCache: true, maxTokens: 1024 },
    }),
  });
}

async function initializeFor(shape: CallerShape, agent: Agent) {
  const user = { id: 'user-1' };
  const appConfig = {} as AppConfig;
  const common = {
    agent,
    loadTools: makeLoadTools(),
    requestFiles: [],
    conversationId: 'convo-1',
    parentMessageId: null,
    endpointOption: { endpoint: EModelEndpoint.agents },
    allowedProviders: new Set<string>(),
    isInitialAgent: true,
  };
  if (shape === 'ui-saved-agent') {
    /* services/Endpoints/agents/initialize.js: request context comes from `req`. */
    const req = { user, config: appConfig, body: {} } as unknown as ServerRequest;
    return initializeAgent({ ...common, req, res: {} as never } as never, makeDb());
  }
  /* controllers/agents/openai.js and responses.js: explicit runtime, no req. */
  const runtime = createAgentExecutionContext({
    user: user as never,
    appConfig,
    requestBody: {} as never,
    turnStartedAt: Date.now(),
  });
  return initializeAgent(
    { ...common, runtime, requestBody: {}, useChatProjectContext: true } as never,
    makeDb(),
  );
}

/** Builds the run exactly as the controllers do and renders the prompt the model receives. */
async function renderPrompt(config: Awaited<ReturnType<typeof initializeAgent>>) {
  (Run.create as jest.Mock).mockClear();
  await createRun({
    agents: [config] as never,
    signal: new AbortController().signal,
    streaming: true,
    streamUsage: true,
  });
  const runConfig = (Run.create as jest.Mock).mock.calls[0][0];
  const inputs = runConfig.graphConfig.agents[0];
  const actual = jest.requireActual<typeof import('@librechat/agents')>('@librechat/agents');
  const run = await actual.Run.create(runConfig);
  const context = run.Graph!.agentContexts.get(inputs.agentId)!;
  return context.systemRunnable!.invoke([new HumanMessage('Automated check: reply OK')]);
}

function textOf(content: unknown): string {
  return typeof content === 'string' ? content : JSON.stringify(content);
}

describe('Aralab patch 10a — confidentiality text reaches the system prompt', () => {
  const savedEnv = {
    providers: process.env.ARALAB_CONFIDENTIAL_PROVIDERS,
    file: process.env.ARALAB_CONFIDENTIAL_INSTRUCTIONS_FILE,
  };
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'aralab-confidential-run-'));
    const file = join(dir, 'confidentiality.md');
    writeFileSync(file, `${CONFIDENTIAL_TEXT}\n`);
    process.env.ARALAB_CONFIDENTIAL_PROVIDERS = 'Aralab GPT,Large File Agents';
    process.env.ARALAB_CONFIDENTIAL_INSTRUCTIONS_FILE = file;
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const [name, value] of [
      ['ARALAB_CONFIDENTIAL_PROVIDERS', savedEnv.providers],
      ['ARALAB_CONFIDENTIAL_INSTRUCTIONS_FILE', savedEnv.file],
    ] as const) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockOpenRouterCustomEndpoint('z-ai/glm-5.3-flash');
  });

  function savedAgent(provider: string): Agent {
    return {
      id: 'agent_saved_1',
      name: 'leak-probe',
      provider,
      model: 'z-ai/glm-5.3-flash',
      instructions: AGENT_INSTRUCTIONS,
      tools: [],
      model_parameters: { model: 'z-ai/glm-5.3-flash' },
    } as unknown as Agent;
  }

  it.each<[CallerShape, string]>([
    ['ui-saved-agent', 'Aralab GPT'],
    ['agents-api-chat-completions', 'Aralab GPT'],
    ['agents-api-responses', 'Aralab GPT'],
    ['ui-saved-agent', 'Large File Agents'],
  ])('%s on %s: system message carries the text', async (shape, provider) => {
    const config = await initializeFor(shape, savedAgent(provider));
    expect(config.provider).toBe(Providers.OPENROUTER);

    const prompt = await renderPrompt(config);
    expect(prompt[0].getType()).toBe('system');
    const system = textOf(prompt[0].content);
    expect(system).toContain(AGENT_INSTRUCTIONS);
    expect(system).toContain('# Model confidentiality');
    /* Not relocated into a user-role tail message. */
    for (const message of prompt.slice(1)) {
      expect(textOf(message.content)).not.toContain('# Model confidentiality');
    }
    /* Exactly one copy. */
    expect(system.split('# Model confidentiality').length - 1).toBe(1);
  });

  it('ephemeral model-spec agent: system message carries the text after the spec prompt', async () => {
    const ephemeral = {
      ...savedAgent('Aralab GPT'),
      id: 'Aralab GPT__z-ai/glm-5.3-flash___Aralab GPT',
      instructions: 'You are an AI, deployed for Aralab.',
    } as unknown as Agent;
    const prompt = await renderPrompt(await initializeFor('ui-saved-agent', ephemeral));
    const system = textOf(prompt[0].content);
    expect(system.indexOf('You are an AI, deployed for Aralab.')).toBeLessThan(
      system.indexOf('# Model confidentiality'),
    );
  });

  it.each<CallerShape>(['ui-saved-agent', 'agents-api-chat-completions', 'agents-api-responses'])(
    '%s: temporal-var persona and text share the single system message',
    async (shape) => {
      /* Supply Chain agent shape: `- Current Date & Time: {{current_datetime}}` in its prompt. */
      const persona =
        'You are the Supply Chain agent.\n- Current Date & Time: {{current_datetime}}';
      const prompt = await renderPrompt(
        await initializeFor(shape, { ...savedAgent('Aralab GPT'), instructions: persona } as Agent),
      );
      expect(prompt[0].getType()).toBe('system');
      const system = textOf(prompt[0].content);
      expect(system).toContain('You are the Supply Chain agent.');
      expect(system).toContain('- Current Date & Time: ');
      expect(system).not.toContain('{{current_datetime}}');
      expect(system).toContain('# Model confidentiality');
      expect(system.indexOf('You are the Supply Chain agent.')).toBeLessThan(
        system.indexOf('# Model confidentiality'),
      );
      for (const message of prompt.slice(1)) {
        expect(message.getType()).not.toBe('system');
        expect(textOf(message.content)).not.toContain('Supply Chain agent');
        expect(textOf(message.content)).not.toContain('# Model confidentiality');
      }
    },
  );

  it('agent without instructions: the text is the system message', async () => {
    const prompt = await renderPrompt(
      await initializeFor('agents-api-chat-completions', {
        ...savedAgent('Aralab GPT'),
        instructions: '',
      } as Agent),
    );
    expect(prompt[0].getType()).toBe('system');
    expect(textOf(prompt[0].content)).toContain('# Model confidentiality');
    for (const message of prompt.slice(1)) {
      expect(textOf(message.content)).not.toContain('# Model confidentiality');
    }
  });

  it('agent on another provider: no confidentiality text anywhere in the prompt', async () => {
    mockGetProviderConfig.mockReturnValue({
      overrideProvider: Providers.ANTHROPIC,
      getOptions: jest.fn().mockResolvedValue({
        llmConfig: { model: 'claude-sonnet-5-5', apiKey: 'test-key', promptCache: true },
      }),
    });
    const config = await initializeFor('agents-api-chat-completions', {
      ...savedAgent(Providers.ANTHROPIC),
      model: 'claude-sonnet-5-5',
    } as unknown as Agent);
    const prompt = await renderPrompt(config);
    for (const message of prompt) {
      expect(textOf(message.content)).not.toContain('# Model confidentiality');
    }
  });
});
