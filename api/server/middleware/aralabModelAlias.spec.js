const express = require('express');
const request = require('supertest');

const GLM = 'z-ai/glm-5.3-flash';
const LEAK = /z-?ai|glm|openrouter|baseten/i;

const baseConfig = {
  endpoints: {
    custom: [
      {
        name: 'Aralab GPT',
        baseURL: 'https://openrouter.ai/api/v1',
        models: { default: [GLM] },
        titleModel: GLM,
        modelDisplayLabel: 'Aralab GPT',
      },
      {
        name: 'Large File Agents',
        baseURL: 'https://openrouter.ai/api/v1',
        models: { default: [GLM] },
        modelDisplayLabel: 'Aralab GPT',
      },
      {
        name: 'Aralab (dev)',
        baseURL: 'https://openrouter.ai/api/v1',
        models: { default: ['anthropic/claude-opus-5.5', 'google/gemini-3.8-flash'] },
        titleModel: GLM,
        modelDisplayLabel: 'Aralab (dev)',
      },
    ],
  },
};

const mockGetAppConfig = jest.fn(async () => baseConfig);
jest.mock('~/server/services/Config/app', () => ({
  getAppConfig: (...args) => mockGetAppConfig(...args),
}));

const { sendEvent, writeSSE } = require('@librechat/api');
const { aliasJsonResponses, getRequestAliasMap } = require('./aralabModelAlias');

const payload = () => ({
  model: GLM,
  conversation: { endpoint: 'Aralab GPT', model: GLM },
  messages: [{ model: GLM, text: `I run on ${GLM}` }],
  endpoints: { custom: [{ name: 'Aralab GPT', baseURL: 'https://openrouter.ai/api/v1' }] },
  dev: 'anthropic/claude-opus-5.5',
});

function buildApp(register) {
  const app = express();
  app.use(express.json());
  app.use('/api', aliasJsonResponses);
  register(app);
  return app;
}

const sse = (res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.flushHeaders();
};

describe('aralabModelAlias middleware (patch 10b)', () => {
  beforeEach(() => mockGetAppConfig.mockClear());

  const aliasedPaths = [
    '/api/config',
    '/api/endpoints',
    '/api/models',
    '/api/convos',
    '/api/messages',
    '/api/agents',
    '/api/share/x',
    '/api/search',
    '/api/schedules',
  ];

  it.each(aliasedPaths)('aliases res.json on %s', async (path) => {
    const app = buildApp((a) => a.get(path, (_req, res) => res.json(payload())));
    const { body } = await request(app).get(path).expect(200);
    expect(body.model).toBe('Aralab GPT');
    expect(body.conversation).toEqual({ endpoint: 'Aralab GPT', model: 'Aralab GPT' });
    expect(body.messages[0]).toEqual({ model: 'Aralab GPT', text: `I run on ${GLM}` });
    expect(body.endpoints.custom[0]).toEqual({ name: 'Aralab GPT' });
    expect(body.dev).toBe('anthropic/claude-opus-5.5');
  });

  it('aliases res.send(object) and status().json() error bodies', async () => {
    const app = buildApp((a) => {
      a.get('/api/convos/a', (_req, res) => res.send({ model: GLM }));
      a.get('/api/convos/b', (_req, res) =>
        res.status(500).json({
          error: `No endpoints found matching your data policy (Zero data retention) for ${GLM} via https://openrouter.ai/api/v1`,
        }),
      );
    });
    expect((await request(app).get('/api/convos/a')).body.model).toBe('Aralab GPT');
    const { body } = await request(app).get('/api/convos/b').expect(500);
    expect(body.error).not.toMatch(LEAK);
    expect(body.error).toContain('data policy');
  });

  it('aliases pre-serialised JSON (EndpointController / abortMessage use res.send(string))', async () => {
    const app = buildApp((a) => {
      a.get('/api/endpoints', (_req, res) =>
        res.send(
          JSON.stringify({
            'Aralab GPT': {
              type: 'custom',
              providerId: 'openrouter',
              modelDisplayLabel: 'Aralab GPT',
              customParams: { defaultParamsEndpoint: 'openrouter' },
            },
            'Aralab (dev)': {
              type: 'custom',
              providerId: 'openrouter',
              modelDisplayLabel: 'Aralab (dev)',
              customParams: { defaultParamsEndpoint: 'openrouter' },
            },
          }),
        ),
      );
      a.post('/api/agents/chat/abort', (_req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.send(JSON.stringify({ final: true, conversation: { model: GLM } }));
      });
      a.get('/api/convos/plain', (_req, res) => res.send('plain glm text'));
      a.get('/api/files/download/x', (_req, res) => {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="x.txt"');
        res.send(JSON.stringify({ model: GLM }));
      });
    });
    const endpoints = await request(app).get('/api/endpoints').expect(200);
    expect(JSON.parse(endpoints.text)).toEqual({
      'Aralab GPT': {
        type: 'custom',
        modelDisplayLabel: 'Aralab GPT',
        customParams: { defaultParamsEndpoint: 'aralab-router' },
      },
      'Aralab (dev)': {
        type: 'custom',
        modelDisplayLabel: 'Aralab (dev)',
        customParams: { defaultParamsEndpoint: 'aralab-router' },
      },
    });
    expect(endpoints.text).not.toMatch(/openrouter/i);
    const abort = await request(app).post('/api/agents/chat/abort').expect(200);
    expect(abort.body.conversation.model).toBe('Aralab GPT');
    expect((await request(app).get('/api/convos/plain')).text).toBe('plain glm text');
    /* a user's text file is content, not a payload */
    expect((await request(app).get('/api/files/download/x')).text).toBe(
      JSON.stringify({ model: GLM }),
    );
  });

  it('leaves the /api/banner payload (admin HTML with links) unchanged', async () => {
    const banner = {
      bannerId: 'b1',
      message:
        '<p>Maintenance — see <a href="https://intranet.aralab.pt/policy">the policy</a>. Logged on.</p>',
      type: 'banner',
      isPublic: true,
    };
    const app = buildApp((a) => a.get('/api/banner', (_req, res) => res.json(banner)));
    const { body } = await request(app).get('/api/banner').expect(200);
    expect(body).toEqual(banner);
  });

  it('leaves /api/admin/config untouched', async () => {
    const app = buildApp((a) => a.get('/api/admin/config', (_req, res) => res.json(payload())));
    const { body } = await request(app).get('/api/admin/config').expect(200);
    expect(body).toEqual(payload());
  });

  it('prefers req.config over the base config', async () => {
    const app = buildApp((a) =>
      a.get('/api/endpoints', (req, res) => {
        req.config = {
          endpoints: {
            custom: [{ name: 'X', models: { default: [GLM] }, modelDisplayLabel: 'Label X' }],
          },
        };
        res.json({ model: GLM });
      }),
    );
    expect((await request(app).get('/api/endpoints')).body.model).toBe('Label X');
  });

  it('writes an SSE sendEvent payload aliased', async () => {
    const app = buildApp((a) =>
      a.get('/api/agents/chat/stream/1', (_req, res) => {
        sse(res);
        sendEvent(res, {
          final: true,
          conversation: { model: GLM, endpoint: 'Aralab GPT' },
          responseMessage: { model: GLM, text: GLM, content: [{ type: 'text', text: GLM }] },
        });
        res.end();
      }),
    );
    const { text } = await request(app).get('/api/agents/chat/stream/1').expect(200);
    const data = JSON.parse(text.match(/^data: (.*)$/m)[1]);
    expect(data.conversation.model).toBe('Aralab GPT');
    expect(data.responseMessage.model).toBe('Aralab GPT');
    expect(data.responseMessage.text).toBe(GLM);
    expect(data.responseMessage.content[0].text).toBe(GLM);
    expect(text.startsWith('event: message\n')).toBe(true);
  });

  it('writes resumable-stream frames (raw res.write) aliased and sanitises error frames', async () => {
    const app = buildApp((a) =>
      a.get('/api/agents/chat/stream/2', (_req, res) => {
        sse(res);
        res.write(
          `event: message\ndata: ${JSON.stringify({ final: true, conversation: { model: GLM } })}\n\n`,
        );
        res.write(
          `event: error\ndata: ${JSON.stringify({
            error:
              'No allowed providers are available for the selected model. Providers serving z-ai/glm-5.3-flash-20260826: relace, wafer, baseten, darkbloom',
          })}\n\n`,
        );
        res.write(`event: error\ndata: ${JSON.stringify(`failed for ${GLM} on OpenRouter`)}\n\n`);
        res.end();
      }),
    );
    const { text } = await request(app).get('/api/agents/chat/stream/2').expect(200);
    expect(text).not.toMatch(LEAK);
    expect(text).not.toMatch(/relace|wafer|darkbloom/);
    expect(text).toContain('"model":"Aralab GPT"');
    expect(text).toContain('No allowed providers are available');
  });

  it('aliases composite agent ids and neutralises openrouter provider values in SSE frames (R16)', async () => {
    const composite = 'Aralab GPT__z-ai/glm-5.3-flash___Aralab GPT';
    const app = buildApp((a) => {
      a.get('/api/agents/chat/stream/3', (_req, res) => {
        sse(res);
        res.write(
          `event: message\ndata: ${JSON.stringify({
            event: 'on_context_usage',
            data: { agentId: composite, provider: 'openrouter', model: GLM },
          })}\n\n`,
        );
        res.write(
          `event: message\ndata: ${JSON.stringify({ final: true, conversation: { agent_id: composite } })}\n\n`,
        );
        res.end();
      });
      a.post('/api/agents/v1/responses', (_req, res) => {
        sse(res);
        res.write('event: response.completed\n');
        res.write(
          `data: ${JSON.stringify({
            type: 'response.completed',
            response: { accounting: { calls: [{ provider: 'openrouter', model: GLM }] } },
          })}\n\n`,
        );
        res.end();
      });
    });
    const chat = await request(app).get('/api/agents/chat/stream/3').expect(200);
    expect(chat.text).not.toMatch(LEAK);
    const [delta, final] = [...chat.text.matchAll(/^data: (.*)$/gm)].map((m) => JSON.parse(m[1]));
    expect(delta.data).toEqual({
      agentId: 'Aralab GPT__Aralab GPT___Aralab GPT',
      provider: 'custom',
      model: 'Aralab GPT',
    });
    expect(final.conversation.agent_id).toBe('Aralab GPT__Aralab GPT___Aralab GPT');
    const responses = await request(app).post('/api/agents/v1/responses').expect(200);
    expect(responses.text).not.toMatch(LEAK);
    expect(responses.text).toContain('"provider":"custom"');
  });

  it('resolves an aliased composite agent_id in request bodies (R16)', async () => {
    let seen;
    const app = buildApp((a) =>
      a.post('/api/agents/chat/Aralab%20GPT', (req, res) => {
        seen = { ...req.body };
        res.json({ ok: true });
      }),
    );
    await request(app)
      .post('/api/agents/chat/Aralab%20GPT')
      .send({ endpoint: 'Aralab GPT', agent_id: 'Aralab GPT__Aralab GPT___Aralab GPT' })
      .expect(200);
    expect(seen.agent_id).toBe('Aralab GPT__z-ai/glm-5.3-flash___Aralab GPT');
  });

  it('writes an Agents API stream chunk aliased', async () => {
    const app = buildApp((a) =>
      a.post('/api/agents/v1/chat/completions', (_req, res) => {
        sse(res);
        writeSSE(res, {
          id: 'chatcmpl-1',
          object: 'chat.completion.chunk',
          model: GLM,
          choices: [{ index: 0, delta: { content: GLM }, finish_reason: null }],
        });
        writeSSE(res, '[DONE]');
        res.end();
      }),
    );
    const { text } = await request(app).post('/api/agents/v1/chat/completions').expect(200);
    const chunk = JSON.parse(text.match(/^data: (\{.*)$/m)[1]);
    expect(chunk.model).toBe('Aralab GPT');
    expect(chunk.choices[0].delta.content).toBe(GLM);
    expect(text).toContain('data: [DONE]');
  });

  it('writes Responses API events (event and data lines written separately) aliased', async () => {
    const app = buildApp((a) =>
      a.post('/api/agents/v1/responses', (_req, res) => {
        sse(res);
        res.write('event: response.created\n');
        res.write(
          `data: ${JSON.stringify({ type: 'response.created', response: { model: GLM } })}\n\n`,
        );
        res.end();
      }),
    );
    const { text } = await request(app).post('/api/agents/v1/responses').expect(200);
    expect(text).toContain('event: response.created\n');
    expect(text).toContain('"model":"Aralab GPT"');
    expect(text).not.toMatch(LEAK);
  });

  it('resolves aliased models in request bodies before the route sees them', async () => {
    let seen;
    const app = buildApp((a) => {
      a.post('/api/agents', (req, res) => {
        seen = { ...req.body };
        res.json({ ok: true });
      });
      a.post('/api/admin/config', (req, res) => {
        seen = { ...req.body };
        res.json({ ok: true });
      });
    });
    await request(app)
      .post('/api/agents')
      .send({ provider: 'Aralab GPT', model: 'Aralab GPT' })
      .expect(200);
    expect(seen.model).toBe(GLM);
    await request(app).post('/api/agents').send({ provider: 'Aralab GPT', model: GLM }).expect(200);
    expect(seen.model).toBe(GLM);
    await request(app)
      .post('/api/admin/config')
      .send({ endpoint: 'Aralab GPT', model: 'Aralab GPT' })
      .expect(200);
    expect(seen.model).toBe('Aralab GPT');
  });

  it('getRequestAliasMap works without the middleware having run', () => {
    const map = getRequestAliasMap({ config: baseConfig });
    expect(map.toReal.get('Aralab GPT::Aralab GPT')).toBe(GLM);
    expect(getRequestAliasMap({}).toAlias).toBeInstanceOf(Map);
  });
});

describe('aralabModelAlias kill switch (ARALAB_MODEL_ALIAS)', () => {
  const saved = process.env.ARALAB_MODEL_ALIAS;
  afterEach(() => {
    if (saved === undefined) {
      delete process.env.ARALAB_MODEL_ALIAS;
    } else {
      process.env.ARALAB_MODEL_ALIAS = saved;
    }
  });

  it('off: responses pass through unaliased, request labels still resolve to the real id', async () => {
    process.env.ARALAB_MODEL_ALIAS = 'false';
    const app = buildApp((a) =>
      a.post('/api/agents/chat', (req, res) => res.json({ got: req.body.model, model: GLM })),
    );
    const { body } = await request(app)
      .post('/api/agents/chat')
      .send({ endpoint: 'Aralab GPT', model: 'Aralab GPT' })
      .expect(200);
    expect(body).toEqual({ got: GLM, model: GLM });
  });

  it('off: SSE frames pass through unaliased', async () => {
    process.env.ARALAB_MODEL_ALIAS = '0';
    const app = buildApp((a) =>
      a.get('/api/agents/chat/stream', (_req, res) => {
        sse(res);
        res.write(`data: ${JSON.stringify({ model: GLM })}\n\n`);
        res.end();
      }),
    );
    const { text } = await request(app).get('/api/agents/chat/stream').expect(200);
    expect(text).toContain(GLM);
  });

  it('on (unset): the same route is aliased (positive control)', async () => {
    delete process.env.ARALAB_MODEL_ALIAS;
    const app = buildApp((a) =>
      a.post('/api/agents/chat', (req, res) => res.json({ got: req.body.model, model: GLM })),
    );
    const { body } = await request(app)
      .post('/api/agents/chat')
      .send({ endpoint: 'Aralab GPT', model: 'Aralab GPT' })
      .expect(200);
    expect(body).toEqual({ got: 'Aralab GPT', model: 'Aralab GPT' });
  });
});
