/** Base Langfuse trace name for a user-facing agent run. */
export const AGENT_RUN_NAME = 'AgentRun';

type NamedAgent = { name?: string | null } | null | undefined;

/**
 * Langfuse trace name for an agent run, carrying the custom agent's name.
 *
 * `traceName` is a first-class groupable metrics dimension; trace `metadata`
 * (where `agentName` already lives) is filter-only, and `tags` group by the
 * whole array — so the trace name is the only place agent identity yields a
 * clean "cost per custom agent" breakdown. Keeping the `AgentRun` prefix
 * preserves the existing split against `TitleRun` / `MemoryRun`.
 *
 * Accepts a single agent or a run's agent list (the primary agent is the one
 * `@librechat/agents` attributes the trace to).
 */
export function agentRunName(agent: NamedAgent | NamedAgent[]): string {
  const primary = Array.isArray(agent) ? agent[0] : agent;
  const name = typeof primary?.name === 'string' ? primary.name.trim() : '';
  return name === '' ? AGENT_RUN_NAME : `${AGENT_RUN_NAME}: ${name}`;
}
