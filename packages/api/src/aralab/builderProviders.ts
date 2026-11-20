/**
 * Aralab patch 10c — Agent Builder provider list.
 *
 * Regular users building agents are offered the chat menu's providers only
 * (`ARALAB_BUILDER_PROVIDERS`, e.g. `Aralab GPT,anthropic`). Role `ADMIN` and members
 * of any group named in `ARALAB_BUILDER_FULL_GROUPS` (e.g. `LLM_TEST`) keep the full
 * `endpoints.agents.allowedProviders` list.
 *
 * This is a builder-only restriction. `endpoints.agents.allowedProviders` is never
 * narrowed: it is enforced at runtime, and agents already on a hidden provider
 * (Fault Finder on `Large File Agents`, IT Assistant on `Aralab (dev)`) must keep
 * running and stay editable while their provider is unchanged.
 *
 * As with `allowedProviders`, an empty list means "unrestricted".
 */
import { logger } from '@librechat/data-schemas';
import { PrincipalType, SystemRoles } from 'librechat-data-provider';
import type { Types } from 'mongoose';

const PROVIDERS_VAR = 'ARALAB_BUILDER_PROVIDERS';
const FULL_GROUPS_VAR = 'ARALAB_BUILDER_FULL_GROUPS';

function parseList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * The providers this user may pick in the Agent Builder.
 * - env unset, role `ADMIN`, or a member of a full group → `allowed`;
 * - otherwise `allowed ∩ ARALAB_BUILDER_PROVIDERS`, in `allowed` order.
 *
 * Two degenerate inputs never fail open to "every provider" for a restricted user:
 * an empty (unrestricted) `allowed` and an empty intersection both give the menu
 * list itself.
 */
export function getBuilderProviders(args: {
  role: string;
  groupNames: string[];
  allowed: string[];
  env?: NodeJS.ProcessEnv;
}): string[] {
  const { role, groupNames, allowed, env = process.env } = args;
  const menu = parseList(env[PROVIDERS_VAR]);
  if (menu.length === 0 || role === SystemRoles.ADMIN) {
    return allowed;
  }
  const fullGroups = new Set(parseList(env[FULL_GROUPS_VAR]));
  if (groupNames.some((name) => fullGroups.has(name))) {
    return allowed;
  }
  if (allowed.length === 0) {
    return menu;
  }
  const menuSet = new Set(menu);
  const offered = allowed.filter((provider) => menuSet.has(provider));
  if (offered.length === 0) {
    logger.warn(
      `[aralab/builderProviders] No ${PROVIDERS_VAR} entry is in endpoints.agents.allowedProviders; offering ${PROVIDERS_VAR} as is`,
    );
    return menu;
  }
  return offered;
}

/** Same convention as `allowedProviders`: an empty list allows every provider. */
export function isBuilderProviderAllowed(list: string[], provider: string): boolean {
  return list.length === 0 || list.includes(provider);
}

type Principal = { principalType: PrincipalType | string; principalId?: string | Types.ObjectId };

export type BuilderUserLike = {
  id?: string;
  _id?: { toString(): string };
  role?: string | null;
  idOnTheSource?: string | null;
};

/**
 * Resolves the user's builder providers, looking up group membership only when it can
 * change the answer (env set, not an admin, full groups configured).
 *
 * Membership comes from `getUserPrincipals`, the ACL resolver, whose group ids are
 * cached per member (USER_PRINCIPALS cache) and invalidated on membership changes.
 * The full-group check is then one `_id`-indexed `findOne` limited to the configured
 * names. A failed lookup is logged and treated as "no full group" (fail closed).
 */
export async function resolveBuilderProviders(args: {
  user: BuilderUserLike;
  allowed: string[];
  env?: NodeJS.ProcessEnv;
  getUserPrincipals: (params: {
    userId: string;
    role?: string | null;
    idOnTheSource?: string | null;
  }) => Promise<Principal[]>;
  findGroupByQuery: (filter: Record<string, unknown>) => Promise<{ name?: string } | null>;
}): Promise<string[]> {
  const { user, allowed, env = process.env, getUserPrincipals, findGroupByQuery } = args;
  const role = user.role ?? '';
  const fullGroups = parseList(env[FULL_GROUPS_VAR]);
  const needsGroups =
    parseList(env[PROVIDERS_VAR]).length > 0 && role !== SystemRoles.ADMIN && fullGroups.length > 0;

  const groupNames: string[] = [];
  const userId = user.id ?? user._id?.toString();
  if (needsGroups && userId) {
    try {
      const hasSourceIdentity = Object.prototype.hasOwnProperty.call(user, 'idOnTheSource');
      const principals = await getUserPrincipals({
        userId,
        role: user.role,
        idOnTheSource: hasSourceIdentity ? (user.idOnTheSource ?? null) : undefined,
      });
      const groupIds = principals
        .filter((p) => p.principalType === PrincipalType.GROUP && p.principalId != null)
        .map((p) => p.principalId);
      if (groupIds.length > 0) {
        const group = await findGroupByQuery({
          _id: { $in: groupIds },
          name: { $in: fullGroups },
        });
        if (group?.name) {
          groupNames.push(group.name);
        }
      }
    } catch (error) {
      logger.warn(
        `[aralab/builderProviders] Group lookup failed for user ${userId}; using the menu providers: ${(error as Error).message}`,
      );
    }
  }

  return getBuilderProviders({ role, groupNames, allowed, env });
}
