import { Permissions, SystemRoles, PermissionTypes } from 'librechat-data-provider';
import type { Response } from 'express';
import type { GroupMemberNamesDeps, GroupMemberNamesRequest } from './groupMembers';
import { createGroupMemberNames, GROUP_MEMBER_NAMES_LIMIT } from './groupMembers';

jest.mock('@librechat/data-schemas', () => ({
  logger: { error: jest.fn() },
}));

const GROUP_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const oid = (n: number) => n.toString(16).padStart(24, '0');

const user = (n: number, name: string, extra: Record<string, unknown> = {}) => ({
  _id: { toString: () => oid(n) },
  name,
  ...extra,
});

function setup({
  role = SystemRoles.USER,
  viewGroups = true,
  memberIds = [] as string[],
  users = [] as ReturnType<typeof user>[],
  group = true,
}: {
  role?: string | null;
  viewGroups?: boolean;
  memberIds?: string[];
  users?: ReturnType<typeof user>[];
  group?: boolean;
} = {}) {
  const deps = {
    getRoleByName: jest.fn(async () => ({
      permissions: { [PermissionTypes.PEOPLE_PICKER]: { [Permissions.VIEW_GROUPS]: viewGroups } },
    })),
    findGroupById: jest.fn(async () => (group ? { memberIds } : null)),
    findUsers: jest.fn(async () => users),
  };
  const req = {
    params: { groupId: GROUP_ID },
    user: role ? { id: 'caller', role } : undefined,
  } as unknown as GroupMemberNamesRequest;
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
  const handler = createGroupMemberNames(deps as unknown as GroupMemberNamesDeps);
  return {
    deps,
    req,
    res,
    run: () => handler(req, res as unknown as Response),
    body: () => res.json.mock.calls[0][0],
  };
}

describe('createGroupMemberNames (Aralab patch 9)', () => {
  it('rejects an unauthenticated caller', async () => {
    const t = setup({ role: null });
    await t.run();
    expect(t.res.status).toHaveBeenCalledWith(401);
    expect(t.deps.findGroupById).not.toHaveBeenCalled();
  });

  it('rejects a role without People Picker VIEW_GROUPS', async () => {
    const t = setup({ viewGroups: false });
    await t.run();
    expect(t.res.status).toHaveBeenCalledWith(403);
    expect(t.deps.findGroupById).not.toHaveBeenCalled();
  });

  it('lets ADMIN through without reading the role', async () => {
    const t = setup({ role: SystemRoles.ADMIN, viewGroups: false });
    await t.run();
    expect(t.deps.getRoleByName).not.toHaveBeenCalled();
    expect(t.res.status).toHaveBeenCalledWith(200);
  });

  it('rejects a malformed group id before touching the database', async () => {
    const t = setup();
    (t.req.params as Record<string, string>).groupId = 'not-an-id';
    await t.run();
    expect(t.res.status).toHaveBeenCalledWith(400);
    expect(t.deps.findGroupById).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown group', async () => {
    const t = setup({ group: false });
    await t.run();
    expect(t.res.status).toHaveBeenCalledWith(404);
  });

  it('returns names only, sorted, resolving both source ids and local ids', async () => {
    const t = setup({
      memberIds: ['entra-1', oid(2), 'gone-user', 'entra-1'],
      users: [
        user(1, 'Zé Silva', { idOnTheSource: 'entra-1', email: 'ze@x.pt' }),
        user(2, 'ana Costa', { email: 'ana@x.pt' }),
      ],
    });
    await t.run();

    expect(t.res.status).toHaveBeenCalledWith(200);
    expect(t.body()).toEqual({
      members: [
        { userId: oid(2), name: 'ana Costa' },
        { userId: oid(1), name: 'Zé Silva' },
      ],
      total: 3,
      truncated: false,
    });
    expect(JSON.stringify(t.body())).not.toContain('@');
    const [criteria, fields] = t.deps.findUsers.mock.calls[0] as unknown as [unknown, string];
    expect(fields).toBe('name username idOnTheSource');
    expect(criteria).toEqual({
      $or: [
        { idOnTheSource: { $in: ['entra-1', oid(2), 'gone-user'] } },
        { _id: { $in: [oid(2)] } },
      ],
    });
  });

  it('falls back to the username and skips nameless users', async () => {
    const t = setup({
      memberIds: [oid(1), oid(2)],
      users: [user(1, '', { username: 'jdoe' }), user(2, '  ')],
    });
    await t.run();
    expect(t.body().members).toEqual([{ userId: oid(1), name: 'jdoe' }]);
  });

  it('caps the names and reports truncation', async () => {
    const count = GROUP_MEMBER_NAMES_LIMIT + 5;
    const ids = Array.from({ length: count }, (_, i) => oid(i + 1));
    const t = setup({
      memberIds: ids,
      users: ids.map((_, i) => user(i + 1, `User ${String(i).padStart(4, '0')}`)),
    });
    await t.run();
    expect(t.body().members).toHaveLength(GROUP_MEMBER_NAMES_LIMIT);
    expect(t.body().total).toBe(count);
    expect(t.body().truncated).toBe(true);
  });

  it('answers an empty group without a user query', async () => {
    const t = setup({ memberIds: [] });
    await t.run();
    expect(t.body()).toEqual({ members: [], total: 0, truncated: false });
    expect(t.deps.findUsers).not.toHaveBeenCalled();
  });

  it('returns 500 when the lookup fails', async () => {
    const t = setup();
    t.deps.findGroupById.mockRejectedValueOnce(new Error('db down'));
    await t.run();
    expect(t.res.status).toHaveBeenCalledWith(500);
  });
});
