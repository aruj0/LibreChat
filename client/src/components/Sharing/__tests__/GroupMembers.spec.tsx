/** Aralab patch 9: group members in the share dialog. */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { AccessRoleIds, PrincipalType } from 'librechat-data-provider';
import type { TPrincipal } from 'librechat-data-provider';
import PeoplePickerSearchItem from '../PeoplePicker/PeoplePickerSearchItem';
import SelectedPrincipalsList from '../PeoplePicker/SelectedPrincipalsList';
import GroupMembers from '../PeoplePicker/GroupMembers';

const mockUseGroupMemberNamesQuery = jest.fn();
jest.mock('librechat-data-provider/react-query', () => ({
  useGroupMemberNamesQuery: (...args: unknown[]) => mockUseGroupMemberNamesQuery(...args),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}));

jest.mock('../AccessRolesPicker', () => ({ __esModule: true, default: () => <div /> }));
jest.mock('../PrincipalAvatar', () => ({ __esModule: true, default: () => <div /> }));
jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  TooltipAnchor: ({ render: trigger }: { render: React.ReactNode }) => trigger,
  useMediaQuery: () => false,
}));

const idle = { data: undefined, isLoading: false, isError: false };

beforeEach(() => {
  mockUseGroupMemberNamesQuery.mockReset();
  mockUseGroupMemberNamesQuery.mockReturnValue(idle);
});

describe('GroupMembers', () => {
  it('does not fetch until opened', () => {
    render(<GroupMembers groupId="g1" />);

    expect(mockUseGroupMemberNamesQuery).toHaveBeenLastCalledWith('g1', { enabled: false });
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'false');
  });

  it('lists the names once opened and counts members it cannot show', () => {
    mockUseGroupMemberNamesQuery.mockReturnValue({
      ...idle,
      data: {
        members: [
          { userId: 'u1', name: 'Ana Costa' },
          { userId: 'u2', name: 'Rui Lopes' },
        ],
        total: 3,
        truncated: false,
      },
    });
    render(<GroupMembers groupId="g1" />);

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_group_show_members' }));

    expect(mockUseGroupMemberNamesQuery).toHaveBeenLastCalledWith('g1', { enabled: true });
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Ana Costa')).toBeInTheDocument();
    expect(screen.getByText('Rui Lopes')).toBeInTheDocument();
    expect(screen.getByText('com_ui_group_members_more:{"0":1}')).toBeInTheDocument();
  });

  it('says so when the group is empty or the request fails', () => {
    mockUseGroupMemberNamesQuery.mockReturnValue({
      ...idle,
      data: { members: [], total: 0, truncated: false },
    });
    const { unmount } = render(<GroupMembers groupId="g1" />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('com_ui_group_members_empty')).toBeInTheDocument();
    unmount();

    mockUseGroupMemberNamesQuery.mockReturnValue({ ...idle, isError: true });
    render(<GroupMembers groupId="g1" />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('com_ui_group_members_error')).toBeInTheDocument();
  });
});

describe('patch 9 wiring', () => {
  it('shows a group search result with its description and member count', () => {
    render(
      <PeoplePickerSearchItem
        principal={{
          type: PrincipalType.GROUP,
          id: 'g1',
          name: 'Calibração',
          source: 'local',
          description: 'Lab team',
          memberCount: 8,
        }}
      />,
    );

    expect(screen.getByText('Lab team · com_ui_group_member_count:{"0":8}')).toBeInTheDocument();
  });

  it('offers the members disclosure on local groups only', () => {
    const shares: TPrincipal[] = [
      {
        type: PrincipalType.GROUP,
        id: 'g1',
        name: 'Local',
        accessRoleId: AccessRoleIds.AGENT_VIEWER,
      },
      { type: PrincipalType.GROUP, name: 'Entra only', source: 'entra' },
      { type: PrincipalType.USER, id: 'u1', name: 'Ana', accessRoleId: AccessRoleIds.AGENT_VIEWER },
    ];

    render(<SelectedPrincipalsList principles={shares} onRemoveHandler={jest.fn()} />);

    expect(screen.getAllByRole('button', { name: 'com_ui_group_show_members' })).toHaveLength(1);
  });
});
