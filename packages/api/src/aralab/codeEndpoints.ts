/**
 * Aralab patch 14 — code execution only where a model spec turns it on.
 *
 * Upstream treats a model spec's `executeCode` as the DEFAULT of the user's Run Code
 * toggle, and shows that toggle in every chat to anyone whose role holds RUN_CODE. For
 * Aralab the sandbox is a capability of one model (the "Aralab Alternative Thinker"
 * works with Office files), not a switch users should see. With
 * `ARALAB_CODE_ENDPOINTS` set (comma-separated endpoint names):
 *
 * - a model-spec chat runs code exactly when its spec says `executeCode: true`; the
 *   request's toggle is ignored for code (toggles.ts);
 * - any agent, ephemeral or saved, whose provider is not listed gets no code
 *   environment (initialize.ts), so a toggle, an agent built on another model, or a
 *   crafted request cannot reach the sandbox elsewhere;
 * - the direct "run this code block" route refuses code (controllers/tools.js);
 * - the client hides the Run Code toggle and the code-block Run button
 *   (`aralabCodeBySpec` in the startup config);
 * - a spec on a listed endpoint that names its `skills` keeps them: the user's Skills
 *   toggle is ignored for it (initialize.js, addedConvo.js, load.ts, added.ts) and the
 *   client hides that toggle for it (`aralabFixedSkillSpecs`). The Office skills carry
 *   the procedures and scripts the file work depends on; switching them off left code
 *   running without them.
 *
 * Unset = upstream behaviour everywhere. RUN_CODE is still required on top.
 */

import type { TModelSpec } from 'librechat-data-provider';

const ENDPOINTS_VAR = 'ARALAB_CODE_ENDPOINTS';

/** The listed endpoints, or null when the patch is off. */
export function getAralabCodeEndpoints(env: NodeJS.ProcessEnv = process.env): Set<string> | null {
  const names = (env[ENDPOINTS_VAR] ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  return names.length > 0 ? new Set(names) : null;
}

/** Whether code follows the model spec only (the patch is on). */
export function isAralabCodeBySpec(env: NodeJS.ProcessEnv = process.env): boolean {
  return getAralabCodeEndpoints(env) !== null;
}

/** Whether an agent on this provider/endpoint may have a code environment. */
export function isAralabCodeAllowedForProvider(
  provider: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const endpoints = getAralabCodeEndpoints(env);
  if (endpoints === null) {
    return true;
  }
  return typeof provider === 'string' && endpoints.has(provider);
}

type SpecSkillsShape = Pick<TModelSpec, 'name' | 'skills'> & {
  preset?: { endpoint?: string | null } | null;
};

/** Whether this spec's `skills` are fixed: the patch is on, the spec names its
 *  skills, and it runs on a listed endpoint. */
export function isAralabSkillsFixedBySpec(
  modelSpec: SpecSkillsShape | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (modelSpec == null || !Object.hasOwn(modelSpec, 'skills')) {
    return false;
  }
  const endpoints = getAralabCodeEndpoints(env);
  const endpoint = modelSpec.preset?.endpoint;
  return endpoints !== null && typeof endpoint === 'string' && endpoints.has(endpoint);
}

/** The user's Skills toggle, or undefined (the spec decides) when the spec's skills are fixed. */
export function resolveAralabSkillsToggle<T>(
  userValue: T | undefined,
  modelSpec: SpecSkillsShape | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): T | undefined {
  return isAralabSkillsFixedBySpec(modelSpec, env) ? undefined : userValue;
}

/** Names of the specs whose skills are fixed, for the client to hide the toggle. */
export function getAralabFixedSkillSpecs(
  specs: ReadonlyArray<SpecSkillsShape> | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return (specs ?? []).filter((spec) => isAralabSkillsFixedBySpec(spec, env)).map((s) => s.name);
}
