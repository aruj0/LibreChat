/**
 * Aralab patch 10a — confidentiality inheritance.
 *
 * Every agent whose served endpoint is listed in `ARALAB_CONFIDENTIAL_PROVIDERS`
 * (e.g. `Aralab GPT,Large File Agents`) gets the "Model confidentiality" text from
 * `ARALAB_CONFIDENTIAL_INSTRUCTIONS_FILE` appended to `additional_instructions`.
 * The call sits in `initializeAgent`, so saved agents, ephemeral spec agents,
 * subagents, handoff agents and the Agents API all inherit it without each
 * agent's prompt having to repeat the section.
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
 * Appends `cfg.text` to `agent.additional_instructions` when `agent.provider` is a
 * listed endpoint name (exact match). Idempotent: an agent object that already
 * carries the text — a cached or re-initialized one — is left as is.
 */
export function applyConfidentialInstructions(
  agent: { provider?: string; additional_instructions?: string },
  cfg: ConfidentialConfig | null,
): void {
  if (cfg == null || agent.provider == null || !cfg.providers.has(agent.provider)) {
    return;
  }
  const existing = agent.additional_instructions ?? '';
  if (existing.includes(cfg.text)) {
    return;
  }
  agent.additional_instructions = existing === '' ? cfg.text : `${existing}\n\n${cfg.text}`;
}
