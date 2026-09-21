import { AGENT_RUN_NAME, agentRunName } from './traceName';

describe('agentRunName', () => {
  it('appends the agent name so traces group per custom agent', () => {
    expect(agentRunName({ name: 'Aralab Production Planning Agent' })).toBe(
      'AgentRun: Aralab Production Planning Agent',
    );
  });

  it('falls back to the bare run name when there is no agent', () => {
    expect(agentRunName(undefined)).toBe(AGENT_RUN_NAME);
    expect(agentRunName(null)).toBe(AGENT_RUN_NAME);
  });

  it('falls back when the name is empty or blank', () => {
    expect(agentRunName({ name: '' })).toBe(AGENT_RUN_NAME);
    expect(agentRunName({ name: '   ' })).toBe(AGENT_RUN_NAME);
    expect(agentRunName({})).toBe(AGENT_RUN_NAME);
  });

  it('trims surrounding whitespace', () => {
    expect(agentRunName({ name: '  Sales Knowledge Agent  ' })).toBe(
      'AgentRun: Sales Knowledge Agent',
    );
  });

  it('accepts the primary agent of a run agent list', () => {
    expect(agentRunName([{ name: 'First' }, { name: 'Second' }])).toBe('AgentRun: First');
    expect(agentRunName([])).toBe(AGENT_RUN_NAME);
  });
});
