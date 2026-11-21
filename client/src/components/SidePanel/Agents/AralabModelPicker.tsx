/**
 * Aralab patch 11: the Agent Builder's Model field mirrors the chat model picker.
 *
 * The choices are the chat menu's model specs (`startupConfig.modelSpecs.list`, already
 * filtered per role/group by the server) minus agent specs. Picking one writes the spec's
 * endpoint, model and `reasoning_effort` into the agent form and keeps every other
 * `model_parameters` key. Admins keep the full parameter panel behind "Advanced settings";
 * regular users have no path to it.
 *
 * Model values are compared exactly as the client receives them: the server aliases the
 * Aralab model ids in both the spec presets and the agents it returns, so the two sides
 * stay comparable without the client knowing the real ids.
 */
import React, { useMemo } from 'react';
import * as Ariakit from '@ariakit/react';
import { ChevronDown } from 'lucide-react';
import { usePopoverZIndex } from '@librechat/client';
import { useWatch, useFormContext } from 'react-hook-form';
import { SystemRoles, LocalStorageKeys } from 'librechat-data-provider';
import type * as t from 'librechat-data-provider';
import type { AgentForm, StringOption } from '~/common';
import SpecDescription from '~/components/Chat/Menus/Endpoints/components/SpecDescription';
import { ResolvedProviderIcon } from '~/components/Endpoints/ResolvedProviderIcon';
import GroupIcon from '~/components/Chat/Menus/Endpoints/components/GroupIcon';
import SpecIcon from '~/components/Chat/Menus/Endpoints/components/SpecIcon';
import { useLocalize, useAuthContext } from '~/hooks';
import { useGetStartupConfig } from '~/data-provider';
import { useAgentPanelContext } from '~/Providers';
import { useProviderIcon } from '~/hooks/Endpoint';
import { cn, createProviderOption } from '~/utils';
import { Panel } from '~/common';

/**
 * Providers that serve the same models as another provider and differ only in how
 * uploads are routed. An agent on a twin keeps its twin when the user picks a spec of
 * the base provider.
 */
export const ARALAB_PROVIDER_TWINS: Readonly<Record<string, string>> = {
  'Large File Agents': 'Aralab GPT',
};

export type PickerGroup = {
  /** Empty for specs without a `group`; those render without a heading. */
  name: string;
  icon?: string;
  specs: t.TModelSpec[];
};

type EffortValue = string | null | undefined;

const normalizeEffort = (value: EffortValue): string | undefined =>
  value == null || value === '' ? undefined : String(value);

const getProviderValue = (provider: AgentForm['provider'] | string | null | undefined) =>
  (typeof provider === 'string' ? provider : (provider as StringOption | undefined)?.value) ?? '';

/** Model specs the builder offers: the chat menu's list without agent specs. */
export function getPickerSpecs(list: t.TModelSpec[] | undefined): t.TModelSpec[] {
  return (list ?? []).filter(
    (spec) =>
      spec.showInMenu !== false &&
      spec.preset?.endpoint != null &&
      spec.preset.endpoint !== 'agents' &&
      !spec.preset.agent_id,
  );
}

/** Groups specs by `group` in first-seen order, keeping list order inside each group. */
export function groupPickerSpecs(specs: t.TModelSpec[]): PickerGroup[] {
  const groups: PickerGroup[] = [];
  const byName = new Map<string, PickerGroup>();
  for (const spec of specs) {
    const name = spec.group ?? '';
    let group = byName.get(name);
    if (!group) {
      group = { name, specs: [] };
      byName.set(name, group);
      groups.push(group);
    }
    group.specs.push(spec);
    if (!group.icon) {
      const icon = spec.groupIcon ?? spec.iconURL;
      group.icon = icon ? String(icon) : undefined;
    }
  }
  return groups;
}

const specServesProvider = (spec: t.TModelSpec, provider: string) =>
  spec.preset.endpoint === provider || spec.preset.endpoint === ARALAB_PROVIDER_TWINS[provider];

export type PickerDisplay = {
  /** The spec whose endpoint, model and reasoning effort all match. */
  exactSpec?: t.TModelSpec;
  /** The spec shown for the current value (exact, or same endpoint + model). */
  spec?: t.TModelSpec;
  customSettings: boolean;
  largeFiles: boolean;
};

/** Which spec, if any, the agent's current provider/model/effort corresponds to. */
export function resolvePickerDisplay({
  specs,
  provider,
  model,
  reasoningEffort,
}: {
  specs: t.TModelSpec[];
  provider: string;
  model: string;
  reasoningEffort?: EffortValue;
}): PickerDisplay {
  const largeFiles = Object.prototype.hasOwnProperty.call(ARALAB_PROVIDER_TWINS, provider);
  if (!provider || !model) {
    return { customSettings: false, largeFiles };
  }
  const sameModel = specs.filter(
    (spec) => specServesProvider(spec, provider) && spec.preset.model === model,
  );
  const effort = normalizeEffort(reasoningEffort);
  const exactSpec = sameModel.find(
    (spec) => normalizeEffort(spec.preset.reasoning_effort) === effort,
  );
  if (exactSpec) {
    return { exactSpec, spec: exactSpec, customSettings: false, largeFiles };
  }
  const closest = sameModel[0];
  return { spec: closest, customSettings: closest != null, largeFiles };
}

/** The provider an agent ends up on when `spec` is picked (twins keep their twin). */
export function resolvePickedProvider(spec: t.TModelSpec, currentProvider: string): string {
  const endpoint = spec.preset.endpoint as string;
  if (ARALAB_PROVIDER_TWINS[currentProvider] === endpoint) {
    return currentProvider;
  }
  return endpoint;
}

/** `model_parameters` after picking `spec`: only `reasoning_effort` changes. */
export function applySpecParameters(
  current: t.AgentModelParameters | undefined,
  spec: t.TModelSpec,
): t.AgentModelParameters {
  const next = { ...(current ?? {}) } as t.AgentModelParameters & {
    reasoning_effort?: unknown;
  };
  const effort = normalizeEffort(spec.preset.reasoning_effort);
  if (effort === undefined) {
    delete next.reasoning_effort;
  } else {
    next.reasoning_effort = effort;
  }
  return next as t.AgentModelParameters;
}

export default function AralabModelPicker() {
  const localize = useLocalize();
  const { user } = useAuthContext();
  const popoverZIndex = usePopoverZIndex();
  const { data: startupConfig } = useGetStartupConfig();
  const { setActivePanel, endpointsConfig } = useAgentPanelContext();
  const { control, getValues, setValue } = useFormContext<AgentForm>();

  const providerOption = useWatch({ control, name: 'provider' });
  const model = useWatch({ control, name: 'model' }) ?? '';
  const modelParameters = useWatch({ control, name: 'model_parameters' });
  const provider = getProviderValue(providerOption);
  const reasoningEffort = (modelParameters as { reasoning_effort?: EffortValue } | undefined)
    ?.reasoning_effort;

  const specs = useMemo(
    () => getPickerSpecs(startupConfig?.modelSpecs?.list),
    [startupConfig?.modelSpecs?.list],
  );
  const groups = useMemo(() => groupPickerSpecs(specs), [specs]);
  const display = useMemo(
    () => resolvePickerDisplay({ specs, provider, model, reasoningEffort }),
    [specs, provider, model, reasoningEffort],
  );

  const { provider: providerId, imageURL } = useProviderIcon({
    endpoint: provider,
    endpointsConfig,
  });

  const isAdmin = user?.role === SystemRoles.ADMIN;

  const handlePick = (specName: string) => {
    const spec = specs.find((candidate) => candidate.name === specName);
    if (!spec) {
      return;
    }
    const currentProvider = getProviderValue(getValues('provider'));
    const nextProvider = resolvePickedProvider(spec, currentProvider);
    const nextModel = spec.preset.model ?? '';
    if (nextProvider !== currentProvider) {
      setValue('provider', createProviderOption(nextProvider), { shouldDirty: true });
    }
    if (nextModel !== (getValues('model') ?? '')) {
      setValue('model', nextModel, { shouldDirty: true });
    }
    setValue('model_parameters', applySpecParameters(getValues('model_parameters'), spec), {
      shouldDirty: true,
    });
    localStorage.setItem(LocalStorageKeys.LAST_AGENT_PROVIDER, nextProvider);
    if (nextModel) {
      localStorage.setItem(LocalStorageKeys.LAST_AGENT_MODEL, nextModel);
    } else {
      localStorage.removeItem(LocalStorageKeys.LAST_AGENT_MODEL);
    }
  };

  /** Only an exact match is "selected": re-picking the closest spec of a custom
   *  configuration must still reach `setValue` and reset its settings. */
  const select = Ariakit.useSelectStore({
    value: display.exactSpec?.name ?? '',
    setValue: (value) => handlePick(String(value)),
  });

  let label: string;
  if (!model) {
    label = localize('com_ui_select_model');
  } else if (display.spec) {
    label = display.customSettings
      ? localize('com_agents_model_custom_settings', { 0: display.spec.label })
      : display.spec.label;
  } else {
    label = `${provider} / ${model}`;
  }
  if (model && display.largeFiles) {
    label = localize('com_agents_model_large_files', { 0: label });
  }

  return (
    <div className="flex min-w-0 flex-col">
      <Ariakit.Select
        id="provider"
        store={select}
        aria-label={`${localize('com_ui_model')}: ${label}`}
        data-testid="agent-model-picker"
        className={cn(
          'border-border-control bg-surface-secondary text-text-primary hover:bg-surface-tertiary focus-visible:ring-ring-primary relative flex h-9 w-full min-w-0 items-center overflow-hidden rounded-lg border text-sm font-medium transition-colors focus:outline-hidden focus-visible:ring-2',
          model ? 'px-1' : 'px-3',
        )}
      >
        <div className="flex w-full min-w-0 items-center gap-2">
          {model && display.spec ? (
            <div className="shrink-0" aria-hidden="true">
              <SpecIcon currentSpec={display.spec} endpointsConfig={endpointsConfig ?? {}} />
            </div>
          ) : (
            model &&
            provider && (
              <div className="avatar-stroke bg-surface-primary text-text-primary relative flex h-6 w-6 shrink-0 items-center justify-center rounded-full">
                <ResolvedProviderIcon
                  provider={providerId}
                  imageURL={imageURL}
                  size={16}
                  className="h-2/3 w-2/3"
                />
              </div>
            )
          )}
          <span className="truncate" title={label} data-testid="agent-model-picker-value">
            {label}
          </span>
        </div>
        <ChevronDown className="text-text-secondary ms-1 size-4 shrink-0" aria-hidden="true" />
      </Ariakit.Select>
      <Ariakit.SelectPopover
        store={select}
        gutter={4}
        portal={true}
        sameWidth={false}
        style={{ zIndex: popoverZIndex }}
        className="popover-ui [pointer-events:auto] max-h-[min(24rem,var(--popover-available-height,24rem))] w-72 max-w-[calc(100vw-1rem)] overflow-y-auto text-sm"
      >
        {groups.length === 0 && (
          <div className="text-text-secondary px-2 py-1.5 text-sm">
            {localize('com_agents_model_no_options')}
          </div>
        )}
        {groups.map((group) => (
          <Ariakit.SelectGroup key={group.name || '__ungrouped'} className="flex flex-col">
            {group.name && (
              <Ariakit.SelectGroupLabel className="text-text-secondary flex items-center gap-2 px-2 pt-1.5 pb-1 text-xs font-medium">
                {group.icon && (
                  <span className="shrink-0" aria-hidden="true">
                    <GroupIcon iconURL={group.icon} groupName={group.name} />
                  </span>
                )}
                <span className="truncate">{group.name}</span>
              </Ariakit.SelectGroupLabel>
            )}
            {group.specs.map((spec) => (
              <Ariakit.SelectItem
                key={spec.name}
                value={spec.name}
                data-testid={`agent-model-option-${spec.name}`}
                className="select-item flex w-full cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 text-sm"
              >
                {spec.showIconInMenu !== false && (
                  <span className="shrink-0" aria-hidden="true">
                    <SpecIcon currentSpec={spec} endpointsConfig={endpointsConfig ?? {}} />
                  </span>
                )}
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate text-start">{spec.label}</span>
                  <SpecDescription description={spec.description} />
                </span>
              </Ariakit.SelectItem>
            ))}
          </Ariakit.SelectGroup>
        ))}
      </Ariakit.SelectPopover>
      {isAdmin && (
        <button
          type="button"
          onClick={() => setActivePanel(Panel.model)}
          className="text-text-secondary hover:text-text-primary focus-visible:ring-ring-primary mt-1 self-start rounded text-xs underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:outline-hidden"
        >
          {localize('com_agents_model_advanced_settings')}
        </button>
      )}
    </div>
  );
}
