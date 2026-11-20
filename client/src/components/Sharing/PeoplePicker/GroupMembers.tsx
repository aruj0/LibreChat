import React, { useId, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Spinner } from '@librechat/client';
import { useGroupMemberNamesQuery } from 'librechat-data-provider/react-query';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

/**
 * Aralab patch 9: a "Show members" disclosure under a group in the share dialog, so the person
 * sharing can see who the group reaches. Names load only when it is opened; the endpoint returns
 * display names only and needs the same People Picker permission that found the group.
 */
export default function GroupMembers({ groupId }: { groupId: string }) {
  const localize = useLocalize();
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const { data, isLoading, isError } = useGroupMemberNamesQuery(groupId, { enabled: open });

  const unresolved = data ? data.total - data.members.length : 0;

  return (
    <div className="w-full">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        className="text-text-secondary hover:text-text-primary flex items-center gap-1 text-xs"
      >
        <ChevronDown
          className={cn('size-3.5 transition-transform', open && 'rotate-180')}
          aria-hidden="true"
        />
        {localize(open ? 'com_ui_group_hide_members' : 'com_ui_group_show_members')}
      </button>
      {open && (
        <div id={panelId} className="mt-2 text-xs" aria-live="polite">
          {isLoading && <Spinner className="size-4" aria-label={localize('com_ui_loading')} />}
          {isError && (
            <p className="text-text-destructive">{localize('com_ui_group_members_error')}</p>
          )}
          {data && data.members.length === 0 && (
            <p className="text-text-secondary">{localize('com_ui_group_members_empty')}</p>
          )}
          {data && data.members.length > 0 && (
            <ul
              className="text-text-primary flex max-h-40 flex-wrap gap-1.5 overflow-y-auto"
              aria-label={localize('com_ui_group_member_count', { 0: data.total })}
            >
              {data.members.map((member) => (
                <li
                  key={member.userId}
                  className="border-border-light bg-surface-secondary rounded-full border px-2 py-0.5"
                >
                  {member.name}
                </li>
              ))}
            </ul>
          )}
          {data && unresolved > 0 && (
            <p className="text-text-secondary mt-1">
              {localize('com_ui_group_members_more', { 0: unresolved })}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
