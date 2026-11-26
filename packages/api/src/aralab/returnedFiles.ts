/**
 * Aralab patch 16 — only finished files reach the user from the code sandbox.
 *
 * Upstream hands the user every file the code tool writes or changes in /mnt/data. On
 * the Alternative Thinker that sent working scripts (`apply_aralab_template.py`), the
 * empty template a document was started from, and preview pictures next to the file the
 * user asked for (production, 26/11/2026). With `ARALAB_CODE_RETURN_EXTENSIONS` set
 * (comma-separated, without dots), a code output reaches the user only when
 *
 * - it sits directly in /mnt/data, not in a folder (the skills work in /mnt/data/work/
 *   and render previews in /mnt/data/preview/), and
 * - its extension is listed.
 *
 * Anything else stays in the sandbox, where the model can still use it in the same turn.
 * Unset = upstream behaviour.
 */
import path from 'node:path';

const EXTENSIONS_VAR = 'ARALAB_CODE_RETURN_EXTENSIONS';

/** The listed extensions (lower case, with the dot), or null when the patch is off. */
export function getAralabReturnExtensions(
  env: NodeJS.ProcessEnv = process.env,
): Set<string> | null {
  const list = (env[EXTENSIONS_VAR] ?? '')
    .split(',')
    .map((ext) => ext.trim().toLowerCase().replace(/^\./, ''))
    .filter(Boolean)
    .map((ext) => `.${ext}`);
  return list.length > 0 ? new Set(list) : null;
}

/** Why a code output is kept from the user, or null when it may be returned. */
export function aralabHeldBackReason(
  name: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const extensions = getAralabReturnExtensions(env);
  if (extensions === null) {
    return null;
  }
  const clean = String(name ?? '')
    .replace(/^\/?mnt\/data\//, '')
    .replace(/^\.\//, '');
  if (clean === '' || clean.includes('/') || clean.includes('\\')) {
    return 'in a folder';
  }
  const ext = path.extname(clean).toLowerCase();
  if (!extensions.has(ext)) {
    return `${ext || 'no extension'} is not a returned type`;
  }
  return null;
}
