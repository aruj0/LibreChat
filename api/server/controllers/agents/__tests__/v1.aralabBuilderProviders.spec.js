/**
 * Aralab patch 10c — the Agent Builder offers regular users only the chat menu's
 * providers (`ARALAB_BUILDER_PROVIDERS`); admins and `ARALAB_BUILDER_FULL_GROUPS`
 * members keep the full `endpoints.agents.allowedProviders` list. The runtime
 * allow-list is untouched, so an agent already on a hidden provider keeps running and
 * stays editable while its provider is unchanged (plan Review Focus 5).
 */
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const { createModels } = require('@librechat/data-schemas');
const { MongoMemoryServer } = require('mongodb-memory-server');

jest.mock('~/server/services/Config', () => ({
  getCachedTools: jest.fn().mockResolvedValue({}),
}));
jest.mock('~/server/services/Files/strategies', () => ({ getStrategyFunctions: jest.fn() }));
jest.mock('~/server/services/Files/images/avatar', () => ({ resizeAvatar: jest.fn() }));
jest.mock('sharp', () =>
  jest.fn(() => ({
    metadata: jest.fn().mockResolvedValue({}),
    toFormat: jest.fn().mockReturnThis(),
    toBuffer: jest.fn().mockResolvedValue(Buffer.alloc(0)),
  })),
);
jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  mergeDeploymentSkillIds: jest.fn((ids) => ids),
  refreshS3Url: jest.fn(),
}));
jest.mock('~/server/services/Files/process', () => ({ filterFile: jest.fn() }));
jest.mock('~/server/services/PermissionService', () => ({
  findAccessibleResources: jest.fn().mockResolvedValue([]),
  findPubliclyAccessibleResources: jest.fn().mockResolvedValue([]),
  getResourcePermissionsMap: jest.fn().mockResolvedValue(new Map()),
  grantPermission: jest.fn(),
  hasPublicPermission: jest.fn().mockResolvedValue(false),
}));
jest.mock('~/models', () => {
  const mongoose = require('mongoose');
  const { createMethods } = require('@librechat/data-schemas');
  const methods = createMethods(mongoose, {
    removeAllPermissions: jest.fn().mockResolvedValue(undefined),
  });
  return { ...methods, getCategoriesWithCounts: jest.fn(), deleteFileByFilter: jest.fn() };
});
jest.mock('~/cache', () => ({
  getLogStores: jest.fn(() => ({ get: jest.fn(), set: jest.fn(), delete: jest.fn() })),
}));

const { createAgent: createAgentHandler, updateAgent: updateAgentHandler } = require('../v1');

const ALLOWED = [
  'Aralab GPT',
  'anthropic',
  'google',
  'Large File Agents',
  'Aralab (dev)',
  'Large File Agents (dev)',
];

describe('Aralab patch 10c — builder provider validation', () => {
  let mongoServer;
  let Agent;
  let Group;
  let req;
  let res;
  const savedEnv = {};

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    createModels(mongoose);
    Agent = mongoose.models.Agent;
    Group = mongoose.models.Group;
    for (const key of ['ARALAB_BUILDER_PROVIDERS', 'ARALAB_BUILDER_FULL_GROUPS']) {
      savedEnv[key] = process.env[key];
    }
  }, 20000);

  afterAll(async () => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await mongoose.disconnect();
    await mongoServer?.stop();
  });

  beforeEach(async () => {
    await Agent.deleteMany({});
    await Group.deleteMany({});
    jest.clearAllMocks();
    process.env.ARALAB_BUILDER_PROVIDERS = 'Aralab GPT,anthropic';
    process.env.ARALAB_BUILDER_FULL_GROUPS = 'LLM_TEST';
    req = {
      user: { id: new mongoose.Types.ObjectId().toString(), role: 'USER' },
      body: {},
      params: {},
      query: {},
      config: { endpoints: { agents: { allowedProviders: ALLOWED } } },
      app: { locals: { fileStrategy: 'local' } },
    };
    res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
  });

  const createExistingAgent = async (provider, model) => {
    const agent = await Agent.create({
      id: `agent_${uuidv4()}`,
      name: 'Fault Finder',
      provider,
      model,
      author: new mongoose.Types.ObjectId(req.user.id),
      versions: [
        { name: 'Fault Finder', provider, model, createdAt: new Date(), updatedAt: new Date() },
      ],
    });
    return agent.id;
  };

  /** Every status the handler set, plus the last JSON body it sent. */
  const outcome = () => ({
    statuses: res.status.mock.calls.map(([status]) => status),
    body: res.json.mock.calls.at(-1)?.[0],
  });
  const REFUSED = { statuses: [403], body: { error: 'Provider not available' } };

  describe('update', () => {
    test('a USER saving an agent on Large File Agents without changing provider → 200', async () => {
      const id = await createExistingAgent('Large File Agents', 'z-ai/glm-5.3-flash');
      req.params.id = id;
      req.body = {
        name: 'Fault Finder v2',
        provider: 'Large File Agents',
        model: 'z-ai/glm-5.3-flash',
      };

      await updateAgentHandler(req, res);

      expect(outcome().statuses).toEqual([]);
      expect(outcome().body).toEqual(expect.objectContaining({ id: req.params.id }));
      const stored = await Agent.findOne({ id });
      expect(stored.name).toBe('Fault Finder v2');
      expect(stored.provider).toBe('Large File Agents');
    });

    test('a USER saving an agent on a hidden provider without sending provider → 200', async () => {
      const id = await createExistingAgent('Aralab (dev)', 'anthropic/claude-sonnet-5.5');
      req.params.id = id;
      req.body = { description: 'IT help' };

      await updateAgentHandler(req, res);

      expect(outcome().statuses).toEqual([]);
      expect(outcome().body).toEqual(expect.objectContaining({ id: req.params.id }));
    });

    test('a USER updating an agent to google → 403 Provider not available', async () => {
      const id = await createExistingAgent('anthropic', 'claude-sonnet-5-5');
      req.params.id = id;
      req.body = { provider: 'google', model: 'gemini-3.8-flash' };

      await updateAgentHandler(req, res);

      expect(outcome()).toEqual(REFUSED);
      const stored = await Agent.findOne({ id });
      expect(stored.provider).toBe('anthropic');
    });

    test('a USER moving an agent from one hidden provider to another → 403', async () => {
      const id = await createExistingAgent('Large File Agents', 'z-ai/glm-5.3-flash');
      req.params.id = id;
      req.body = { provider: 'google', model: 'gemini-3.8-flash' };

      await updateAgentHandler(req, res);

      expect(outcome()).toEqual(REFUSED);
    });

    test('a USER moving an agent from a hidden provider to a menu provider → 200', async () => {
      const id = await createExistingAgent('google', 'gemini-3.8-flash');
      req.params.id = id;
      req.body = { provider: 'anthropic', model: 'claude-sonnet-5-5' };

      await updateAgentHandler(req, res);

      expect(outcome().statuses).toEqual([]);
      expect(outcome().body).toEqual(expect.objectContaining({ id: req.params.id }));
    });

    test('an ADMIN updating an agent to google → 200', async () => {
      req.user.role = 'ADMIN';
      const id = await createExistingAgent('anthropic', 'claude-sonnet-5-5');
      req.params.id = id;
      req.body = { provider: 'google', model: 'gemini-3.8-flash' };

      await updateAgentHandler(req, res);

      expect(outcome().statuses).toEqual([]);
      expect(outcome().body).toEqual(expect.objectContaining({ id: req.params.id }));
      const stored = await Agent.findOne({ id });
      expect(stored.provider).toBe('google');
    });
  });

  describe('create', () => {
    test('a USER creating an agent on google → 403 Provider not available', async () => {
      req.body = { name: 'Gemini agent', provider: 'google', model: 'gemini-3.8-flash' };

      await createAgentHandler(req, res);

      expect(outcome()).toEqual(REFUSED);
      expect(await Agent.countDocuments()).toBe(0);
    });

    test('a USER creating an agent on Aralab GPT → 201', async () => {
      req.body = { name: 'GLM agent', provider: 'Aralab GPT', model: 'z-ai/glm-5.3-flash' };

      await createAgentHandler(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
    });

    test('an ADMIN creating an agent on google → 201', async () => {
      req.user.role = 'ADMIN';
      req.body = { name: 'Gemini agent', provider: 'google', model: 'gemini-3.8-flash' };

      await createAgentHandler(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
    });

    test('an LLM_TEST member creating an agent on google → 201', async () => {
      await Group.create({ name: 'LLM_TEST', source: 'local', memberIds: [req.user.id] });
      req.body = { name: 'Gemini agent', provider: 'google', model: 'gemini-3.8-flash' };

      await createAgentHandler(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
    });

    test('a member of another group creating an agent on google → 403', async () => {
      await Group.create({ name: 'Comercial', source: 'local', memberIds: [req.user.id] });
      req.body = { name: 'Gemini agent', provider: 'google', model: 'gemini-3.8-flash' };

      await createAgentHandler(req, res);

      expect(outcome()).toEqual(REFUSED);
    });

    test('env unset leaves the upstream behaviour → 201', async () => {
      delete process.env.ARALAB_BUILDER_PROVIDERS;
      req.body = { name: 'Gemini agent', provider: 'google', model: 'gemini-3.8-flash' };

      await createAgentHandler(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
    });
  });
});
