import { GraphRecursionError } from '@langchain/langgraph';
import { ErrorTypes } from 'librechat-data-provider';
import {
  AGENT_EXPECTED_MCP_TOOLS_UNAVAILABLE,
  isFatalAgentInitializationError,
  isStepLimitError,
} from './errors';

describe('isFatalAgentInitializationError', () => {
  it.each([
    ErrorTypes.RESOURCE_RECOVERY_REQUIRED,
    ErrorTypes.STATEFUL_CODE_ENVIRONMENT_NOT_ALLOWED,
    AGENT_EXPECTED_MCP_TOOLS_UNAVAILABLE,
  ])('classifies %s as fatal', (code) => {
    expect(isFatalAgentInitializationError({ code })).toBe(true);
  });

  it('allows skill-added MCP tools to fall back while keeping resource recovery fatal', () => {
    const options = { allowExpectedMCPFallback: true };
    expect(
      isFatalAgentInitializationError({ code: AGENT_EXPECTED_MCP_TOOLS_UNAVAILABLE }, options),
    ).toBe(false);
    expect(
      isFatalAgentInitializationError({ code: ErrorTypes.RESOURCE_RECOVERY_REQUIRED }, options),
    ).toBe(true);
  });

  it.each([undefined, null, new Error('optional tool failed'), { code: 'OPTIONAL_TOOL_FAILED' }])(
    'keeps non-fatal failures eligible for legacy soft handling',
    (error) => {
      expect(isFatalAgentInitializationError(error)).toBe(false);
    },
  );
});

describe('isStepLimitError', () => {
  it('recognizes the real error LangGraph throws when a graph runs out of supersteps', () => {
    /** Constructed exactly as `pregel/index.js` does on `loop.status === 'out_of_steps'`. */
    const thrown = new GraphRecursionError(
      'Recursion limit of 50 reached without hitting a stop condition. You can increase the limit by setting the "recursionLimit" config key.',
      { lc_error_code: 'GRAPH_RECURSION_LIMIT' },
    );

    expect(isStepLimitError(thrown)).toBe(true);
  });

  it('matches on `lc_error_code` alone, so a minified class name cannot break detection', () => {
    expect(isStepLimitError({ lc_error_code: 'GRAPH_RECURSION_LIMIT' })).toBe(true);
  });

  it('matches on `name` alone, so an error rebuilt without fields is still recognized', () => {
    expect(isStepLimitError({ name: 'GraphRecursionError' })).toBe(true);
  });

  it('unwraps a graph error rethrown inside a wrapper', () => {
    const wrapper = new Error('agent run failed', {
      cause: new Error('node failed', {
        cause: new GraphRecursionError('Recursion limit of 50 reached', {
          lc_error_code: 'GRAPH_RECURSION_LIMIT',
        }),
      }),
    });

    expect(isStepLimitError(wrapper)).toBe(true);
  });

  it('terminates on a self-referential cause chain instead of looping forever', () => {
    const looping: { name: string; cause?: unknown } = { name: 'SomeError' };
    looping.cause = looping;

    expect(isStepLimitError(looping)).toBe(false);
  });

  it.each([
    undefined,
    null,
    'GraphRecursionError',
    new Error('rate limited'),
    { lc_error_code: 'GRAPH_VALUE_ERROR' },
    { name: 'GraphInterrupt' },
  ])('leaves case %# on the ordinary error path', (error) => {
    expect(isStepLimitError(error)).toBe(false);
  });
});
