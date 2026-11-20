/**
 * Aralab patch 9: lets anyone who may search groups in the people picker see who is in a
 * group before sharing with it.
 *
 * The only upstream member listing is the admin API (`/api/admin/groups/:id/members`), which
 * needs the `read:groups` system capability and returns emails and avatars too. Granting that
 * to every user would open the whole admin read surface, so this endpoint is gated by the
 * People Picker's own `VIEW_GROUPS` permission (the one that already lets the caller find the
 * group) and returns display names only.
 */
import { logger } from '@librechat/data-schemas';
import { Permissions, SystemRoles, PermissionTypes } from 'librechat-data-provider';
import type { TGroupMemberNamesResponse } from 'librechat-data-provider';
import type { IGroup, IUser } from '@librechat/data-schemas';
import type { FilterQuery, Types } from 'mongoose';
import type { Request, Response } from 'express';
import type { PeoplePickerRole } from './search';

/** Most names returned for one group; `total` still reports the full membership. */
export const GROUP_MEMBER_NAMES_LIMIT = 200;

const OBJECT_ID = /^[0-9a-f]{24}$/i;

export interface GroupMemberNamesDeps {
  getRoleByName: (roleName: string) => Promise<PeoplePickerRole | null>;
  findGroupById: (
    groupId: string | Types.ObjectId,
    projection?: Record<string, 0 | 1>,
  ) => Promise<Pick<IGroup, 'memberIds'> | null>;
  findUsers: (
    searchCriteria: FilterQuery<IUser>,
    fieldsToSelect?: string | string[] | null,
  ) => Promise<Pick<IUser, '_id' | 'name' | 'username' | 'idOnTheSource'>[]>;
}

export type GroupMemberNamesRequest = Pick<Request, 'params'> & {
  user?: { id?: string; role?: string };
};

export function createGroupMemberNames(deps: GroupMemberNamesDeps) {
  const canViewGroups = async (role: string): Promise<boolean> => {
    if (role === SystemRoles.ADMIN) {
      return true;
    }
    const record = await deps.getRoleByName(role);
    return record?.permissions?.[PermissionTypes.PEOPLE_PICKER]?.[Permissions.VIEW_GROUPS] === true;
  };

  return async (req: GroupMemberNamesRequest, res: Response): Promise<Response> => {
    try {
      const role = req.user?.role;
      if (!req.user?.id || !role) {
        return res.status(401).json({ error: 'Unauthorized', message: 'Authentication required' });
      }
      if (!(await canViewGroups(role))) {
        return res.status(403).json({
          error: 'Forbidden',
          message: 'Insufficient permissions to view groups',
        });
      }

      const groupId = req.params?.groupId;
      if (typeof groupId !== 'string' || !OBJECT_ID.test(groupId)) {
        return res.status(400).json({ error: 'Invalid group ID format' });
      }

      const group = await deps.findGroupById(groupId, { memberIds: 1 });
      if (!group) {
        return res.status(404).json({ error: 'Group not found' });
      }

      /* Members are stored as `idOnTheSource` (Entra / OpenID id) or as a local user id. */
      const memberIds = [...new Set((group.memberIds ?? []).map(String))];
      if (memberIds.length === 0) {
        const empty: TGroupMemberNamesResponse = { members: [], total: 0, truncated: false };
        return res.status(200).json(empty);
      }

      const localIds = memberIds.filter((id) => OBJECT_ID.test(id));
      const conditions: FilterQuery<IUser>[] = [{ idOnTheSource: { $in: memberIds } }];
      if (localIds.length > 0) {
        conditions.push({ _id: { $in: localIds } });
      }
      const users = await deps.findUsers({ $or: conditions }, 'name username idOnTheSource');

      const byMemberId = new Map<string, (typeof users)[number]>();
      for (const user of users) {
        if (user.idOnTheSource) {
          byMemberId.set(user.idOnTheSource, user);
        }
        if (user._id) {
          byMemberId.set(user._id.toString(), user);
        }
      }

      /* A member id with no matching user (left the company, never signed in) is skipped:
       * its raw id means nothing to the person sharing. `total` still counts it. */
      const seen = new Set<string>();
      const members: TGroupMemberNamesResponse['members'] = [];
      for (const memberId of memberIds) {
        const user = byMemberId.get(memberId);
        const userId = user?._id?.toString();
        if (!user || !userId || seen.has(userId)) {
          continue;
        }
        seen.add(userId);
        const name = user.name?.trim() || user.username?.trim();
        if (name) {
          members.push({ userId, name });
        }
      }
      members.sort((a, b) => a.name.localeCompare(b.name, 'pt', { sensitivity: 'base' }));

      const response: TGroupMemberNamesResponse = {
        members: members.slice(0, GROUP_MEMBER_NAMES_LIMIT),
        total: memberIds.length,
        truncated: members.length > GROUP_MEMBER_NAMES_LIMIT,
      };
      return res.status(200).json(response);
    } catch (error) {
      logger.error('[groupMemberNames] Failed to list group members', error);
      return res.status(500).json({ error: 'Failed to get group members' });
    }
  };
}
