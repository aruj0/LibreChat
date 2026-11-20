/**
 * Aralab patch 10a — confidentiality inheritance.
 *
 * Every agent whose served endpoint is listed in `ARALAB_CONFIDENTIAL_PROVIDERS`
 * (e.g. `Aralab GPT,Large File Agents`) gets the "Model confidentiality" text from
 * `ARALAB_CONFIDENTIAL_INSTRUCTIONS_FILE` appended to its stable `instructions`.
 * The call sits in `initializeAgent`, so saved agents, ephemeral spec agents,
 * subagents, handoff agents and the Agents API all inherit it without each
 * agent's prompt having to repeat the section.
 *
 * Where it goes (decided per agent, after instructions are resolved):
 * - non-empty `instructions` (stable block): append there. With prompt caching on (OpenRouter's
 *   default params, Anthropic) and both blocks non-empty, `@librechat/agents` moves
 *   `additional_instructions` out of the system message into a trailing user-role
 *   `<system_context>` message (`AgentContext.buildSystemRunnable`), so the text must not sit in
 *   the dynamic block next to a stable persona.
 * - empty `instructions` (no prompt, or a persona with `{{current_date}}`-style vars that
 *   `initializeAgent` moved to `additional_instructions`): append to `additional_instructions`.
 *   The stable block stays empty, and the SDK renders persona + text as one system message.
 */
import { readFileSync } from 'fs';
import { logger } from '@librechat/data-schemas';

export type ConfidentialConfig = { providers: Set<string>; text: string };

const PROVIDERS_VAR = 'ARALAB_CONFIDENTIAL_PROVIDERS';
const FILE_VAR = 'ARALAB_CONFIDENTIAL_INSTRUCTIONS_FILE';

/**
 * Keyed by the two env values, so the file is read (and a misconfiguration warned
 * about) once per process for a given configuration. A `null` result is cached too.
 */
const cache = new Map<string, ConfidentialConfig | null>();

function resolve(
  providersRaw: string | undefined,
  file: string | undefined,
): ConfidentialConfig | null {
  if (!providersRaw?.trim() || !file?.trim()) {
    logger.warn(
      `[aralab/confidential] ${PROVIDERS_VAR} or ${FILE_VAR} is unset; confidentiality instructions are disabled`,
    );
    return null;
  }

  const providers = new Set(
    providersRaw
      .split(',')
      .map((provider) => provider.trim())
      .filter(Boolean),
  );

  let text: string;
  try {
    text = readFileSync(file, 'utf8').trim();
  } catch (error) {
    logger.warn(
      `[aralab/confidential] Cannot read ${FILE_VAR} (${file}): ${(error as Error).message}; confidentiality instructions are disabled`,
    );
    return null;
  }
  if (text === '') {
    logger.warn(
      `[aralab/confidential] ${FILE_VAR} (${file}) is empty; confidentiality instructions are disabled`,
    );
    return null;
  }

  return { providers, text };
}

export function loadConfidentialConfig(
  env: NodeJS.ProcessEnv = process.env,
): ConfidentialConfig | null {
  const providersRaw = env[PROVIDERS_VAR];
  const file = env[FILE_VAR];
  const key = `${providersRaw ?? ''}\u0000${file ?? ''}`;
  if (cache.has(key)) {
    return cache.get(key) ?? null;
  }
  const config = resolve(providersRaw, file);
  cache.set(key, config);
  return config;
}

/**
 * Appends `cfg.text` for a listed endpoint name (exact match on `agent.provider`): to the stable
 * `instructions` when they are non-empty, otherwise to `additional_instructions` (see the module
 * comment). Idempotent: an agent object whose either field already carries the text — a cached or
 * re-initialized one — is left as is.
 */
export function applyConfidentialInstructions(
  agent: {
    provider?: string;
    instructions?: string | null;
    additional_instructions?: string | null;
  },
  cfg: ConfidentialConfig | null,
): void {
  if (cfg == null || agent.provider == null || !cfg.providers.has(agent.provider)) {
    return;
  }
  if (
    agent.instructions?.includes(cfg.text) === true ||
    agent.additional_instructions?.includes(cfg.text) === true
  ) {
    return;
  }
  const append = (existing: string | null | undefined): string =>
    existing == null || existing === '' ? cfg.text : `${existing}\n\n${cfg.text}`;
  if (agent.instructions != null && agent.instructions.trim() !== '') {
    agent.instructions = append(agent.instructions);
  } else {
    agent.additional_instructions = append(agent.additional_instructions);
  }
}
