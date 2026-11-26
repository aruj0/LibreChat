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
 *   (`aralabCodeBySpec` in the startup config).
 *
 * Unset = upstream behaviour everywhere. RUN_CODE is still required on top.
 */

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
