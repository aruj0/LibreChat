import { Types } from 'mongoose';
import { PrincipalType } from 'librechat-data-provider';
import {
  getBuilderProviders,
  isBuilderProviderAllowed,
  resolveBuilderProviders,
} from './builderProviders';

jest.mock('@librechat/data-schemas', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const ALLOWED = [
  'Aralab GPT',
  'anthropic',
  'google',
  'Large File Agents',
  'Aralab (dev)',
  'Large File Agents (dev)',
];
const ENV = {
  ARALAB_BUILDER_PROVIDERS: 'Aralab GPT, anthropic',
  ARALAB_BUILDER_FULL_GROUPS: 'LLM_TEST',
} as NodeJS.ProcessEnv;

describe('getBuilderProviders', () => {
  it('user gets menu providers', () => {
    expect(
      getBuilderProviders({ role: 'USER', groupNames: [], allowed: ALLOWED, env: ENV }),
    ).toEqual(['Aralab GPT', 'anthropic']);
  });

  it('admin gets all', () => {
    expect(
      getBuilderProviders({ role: 'ADMIN', groupNames: [], allowed: ALLOWED, env: ENV }),
    ).toEqual(ALLOWED);
  });

  it('LLM_TEST member gets all', () => {
    expect(
      getBuilderProviders({
        role: 'USER',
        groupNames: ['Comercial', 'LLM_TEST'],
        allowed: ALLOWED,
        env: ENV,
      }),
    ).toEqual(ALLOWED);
  });

  it('env unset gets all', () => {
    expect(
      getBuilderProviders({ role: 'USER', groupNames: [], allowed: ALLOWED, env: {} }),
    ).toEqual(ALLOWED);
  });

  it('keeps the allow-list order and drops menu providers the runtime does not allow', () => {
    expect(
      getBuilderProviders({
        role: 'USER',
        groupNames: [],
        allowed: ['anthropic', 'google'],
        env: ENV,
      }),
    ).toEqual(['anthropic']);
  });

  it('an unrestricted (empty) allow-list gives a regular user the menu providers', () => {
    expect(getBuilderProviders({ role: 'USER', groupNames: [], allowed: [], env: ENV })).toEqual([
      'Aralab GPT',
      'anthropic',
    ]);
  });

  it('never fails open when no menu provider is runtime-allowed', () => {
    expect(
      getBuilderProviders({ role: 'USER', groupNames: [], allowed: ['google'], env: ENV }),
    ).toEqual(['Aralab GPT', 'anthropic']);
  });

  it('a group name that only resembles a full group does not count', () => {
    expect(
      getBuilderProviders({ role: 'USER', groupNames: ['llm_test'], allowed: ALLOWED, env: ENV }),
    ).toEqual(['Aralab GPT', 'anthropic']);
  });
});

describe('isBuilderProviderAllowed', () => {
  it('an empty list means unrestricted, as for allowedProviders', () => {
    expect(isBuilderProviderAllowed([], 'google')).toBe(true);
  });

  it('checks membership otherwise', () => {
    expect(isBuilderProviderAllowed(['Aralab GPT', 'anthropic'], 'anthropic')).toBe(true);
    expect(isBuilderProviderAllowed(['Aralab GPT', 'anthropic'], 'google')).toBe(false);
  });
});

describe('resolveBuilderProviders', () => {
  const userId = new Types.ObjectId().toString();
  const groupId = new Types.ObjectId();

  const deps = (groupName: string | null) => ({
    getUserPrincipals: jest
      .fn()
      .mockResolvedValue([
        { principalType: PrincipalType.USER, principalId: new Types.ObjectId(userId) },
        { principalType: PrincipalType.ROLE, principalId: 'USER' },
        { principalType: PrincipalType.GROUP, principalId: groupId },
        { principalType: PrincipalType.PUBLIC },
      ]),
    findGroupByQuery: jest.fn().mockResolvedValue(groupName ? { name: groupName } : null),
  });

  it('a regular user outside the full groups gets the menu providers', async () => {
    const d = deps(null);
    const result = await resolveBuilderProviders({
      user: { id: userId, role: 'USER', idOnTheSource: 'entra-oid' },
      allowed: ALLOWED,
      env: ENV,
      ...d,
    });
    expect(result).toEqual(['Aralab GPT', 'anthropic']);
    expect(d.getUserPrincipals).toHaveBeenCalledWith({
      userId,
      role: 'USER',
      idOnTheSource: 'entra-oid',
    });
    expect(d.findGroupByQuery).toHaveBeenCalledWith({
      _id: { $in: [groupId] },
      name: { $in: ['LLM_TEST'] },
    });
  });

  it('an LLM_TEST member gets all', async () => {
    const result = await resolveBuilderProviders({
      user: { id: userId, role: 'USER' },
      allowed: ALLOWED,
      env: ENV,
      ...deps('LLM_TEST'),
    });
    expect(result).toEqual(ALLOWED);
  });

  it('an admin gets all without a group lookup', async () => {
    const d = deps(null);
    const result = await resolveBuilderProviders({
      user: { id: userId, role: 'ADMIN' },
      allowed: ALLOWED,
      env: ENV,
      ...d,
    });
    expect(result).toEqual(ALLOWED);
    expect(d.getUserPrincipals).not.toHaveBeenCalled();
  });

  it('env unset gets all without a group lookup', async () => {
    const d = deps(null);
    const result = await resolveBuilderProviders({
      user: { id: userId, role: 'USER' },
      allowed: ALLOWED,
      env: {},
      ...d,
    });
    expect(result).toEqual(ALLOWED);
    expect(d.getUserPrincipals).not.toHaveBeenCalled();
  });

  it('leaves idOnTheSource to the lookup when the user object does not carry it', async () => {
    const d = deps(null);
    await resolveBuilderProviders({
      user: { id: userId, role: 'USER' },
      allowed: ALLOWED,
      env: ENV,
      ...d,
    });
    expect(d.getUserPrincipals).toHaveBeenCalledWith({
      userId,
      role: 'USER',
      idOnTheSource: undefined,
    });
  });

  it('skips the group query when the user is in no group', async () => {
    const d = deps(null);
    d.getUserPrincipals.mockResolvedValue([
      { principalType: PrincipalType.USER, principalId: new Types.ObjectId(userId) },
    ]);
    const result = await resolveBuilderProviders({
      user: { id: userId, role: 'USER' },
      allowed: ALLOWED,
      env: ENV,
      ...d,
    });
    expect(result).toEqual(['Aralab GPT', 'anthropic']);
    expect(d.findGroupByQuery).not.toHaveBeenCalled();
  });

  it('fails closed to the menu providers when the group lookup throws', async () => {
    const d = deps(null);
    d.getUserPrincipals.mockRejectedValue(new Error('mongo down'));
    const result = await resolveBuilderProviders({
      user: { id: userId, role: 'USER' },
      allowed: ALLOWED,
      env: ENV,
      ...d,
    });
    expect(result).toEqual(['Aralab GPT', 'anthropic']);
  });
});
