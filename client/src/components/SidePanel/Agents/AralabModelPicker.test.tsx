/**
 * @jest-environment jsdom
 */
import 'test/matchMedia.mock';
import React from 'react';
import { FormProvider, useForm } from 'react-hook-form';
import { LocalStorageKeys } from 'librechat-data-provider';
import { render, screen, within } from '@testing-library/react';
import type { TModelSpec, TStartupConfig } from 'librechat-data-provider';
import type { UseFormReturn } from 'react-hook-form';
import type { AgentForm } from '~/common';
import AralabModelPicker, {
  ARALAB_PROVIDER_TWINS,
  getPickerSpecs,
  groupPickerSpecs,
} from './AralabModelPicker';
import { clickDropdown, flushDropdownEffects } from 'test/dropdown';
import enTranslation from '~/locales/en/translation.json';
import { Panel } from '~/common';

const mockSetActivePanel = jest.fn();
const mockUser = jest.fn<{ role: string } | undefined, []>(() => ({ role: 'USER' }));
const mockStartupConfig = jest.fn<Partial<TStartupConfig>, []>(() => ({}));

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: mockStartupConfig() }),
}));

jest.mock('~/Providers', () => ({
  useAgentPanelContext: () => ({ setActivePanel: mockSetActivePanel, endpointsConfig: {} }),
}));

jest.mock('~/hooks', () => {
  const translations = jest.requireActual('~/locales/en/translation.json') as Record<
    string,
    string
  >;
  return {
    useLocalize: () => (key: string, vars?: Record<string, string>) =>
      (translations[key] ?? key).replace(/\{\{(\w+)\}\}/g, (_m, name: string) =>
        String(vars?.[name] ?? ''),
      ),
    useAuthContext: () => ({ user: mockUser() }),
  };
});

jest.mock('~/hooks/Endpoint', () => ({
  useProviderIcon: () => ({ provider: undefined, imageURL: undefined }),
}));

jest.mock('~/components/Chat/Menus/Endpoints/components/SpecIcon', () => ({
  __esModule: true,
  default: ({ currentSpec }: { currentSpec: TModelSpec }) => (
    <span data-testid={`spec-icon-${currentSpec.name}`} />
  ),
}));

jest.mock('~/components/Chat/Menus/Endpoints/components/GroupIcon', () => ({
  __esModule: true,
  default: ({ groupName }: { groupName: string }) => (
    <span data-testid={`group-icon-${groupName}`} />
  ),
}));

jest.mock('~/components/Endpoints/ResolvedProviderIcon', () => ({
  ResolvedProviderIcon: () => <span data-testid="provider-icon" />,
}));

const ARALAB_ICON = 'data:image/svg+xml;base64,PHN2Zy8+';

/** The startup config as the client receives it: Aralab model ids arrive aliased. */
const specs: TModelSpec[] = [
  {
    name: 'aralab-gpt',
    label: 'Aralab Fast',
    description: 'Quick answers',
    group: 'Aralab',
    groupIcon: ARALAB_ICON,
    iconURL: ARALAB_ICON,
    preset: { endpoint: 'Aralab GPT', model: 'Aralab GPT', reasoning_effort: 'medium' },
  },
  {
    name: 'aralab-thinker',
    label: 'Aralab Thinker',
    group: 'Aralab',
    iconURL: ARALAB_ICON,
    preset: { endpoint: 'Aralab GPT', model: 'Aralab GPT', reasoning_effort: 'high' },
  },
  {
    name: 'some-agent',
    label: 'Some Agent',
    group: 'Aralab',
    preset: { endpoint: 'agents', agent_id: 'agent_123' },
  },
  {
    name: 'aralab-alt-thinker',
    label: 'Aralab Alternative Thinker',
    group: 'Aralab',
    iconURL: ARALAB_ICON,
    preset: { endpoint: 'Aralab Alternative Thinker', model: 'Aralab Alternative Thinker' },
  },
  {
    name: 'pinned-agent',
    label: 'Pinned Agent',
    preset: { endpoint: 'Aralab GPT', agent_id: 'agent_456' },
  },
  {
    name: 'claude-sonnet-5-5',
    label: 'Claude Sonnet 5.5',
    group: 'Claude',
    iconURL: 'anthropic',
    preset: {
      endpoint: 'Claude',
      model: 'anthropic/claude-sonnet-5.5',
      reasoning_effort: 'medium',
    },
  },
  {
    name: 'claude-opus-5-5',
    label: 'Claude Opus 5.5',
    group: 'Claude',
    iconURL: 'anthropic',
    preset: { endpoint: 'Claude', model: 'anthropic/claude-opus-5.5', reasoning_effort: 'medium' },
  },
] as TModelSpec[];

function TestForm({
  provider = '',
  model = '',
  modelParameters = {},
  formRef,
}: {
  provider?: AgentForm['provider'] | string;
  model?: string;
  modelParameters?: Record<string, unknown>;
  formRef: React.MutableRefObject<UseFormReturn<AgentForm> | null>;
}) {
  const methods = useForm<AgentForm>({
    defaultValues: {
      provider: provider as AgentForm['provider'],
      model,
      model_parameters: modelParameters as AgentForm['model_parameters'],
    },
  });
  formRef.current = methods;
  return (
    <FormProvider {...methods}>
      <AralabModelPicker />
    </FormProvider>
  );
}

const providerOf = (value: AgentForm['provider'] | string | undefined) =>
  typeof value === 'string' ? value : value?.value;

async function renderPicker(props: Omit<React.ComponentProps<typeof TestForm>, 'formRef'> = {}) {
  const formRef: React.MutableRefObject<UseFormReturn<AgentForm> | null> = { current: null };
  const utils = render(<TestForm {...props} formRef={formRef} />);
  await flushDropdownEffects();
  return { ...utils, form: () => formRef.current as UseFormReturn<AgentForm> };
}

async function pick(label: string) {
  await clickDropdown(screen.getByTestId('agent-model-picker'));
  await clickDropdown(screen.getByRole('option', { name: new RegExp(`^${label}`) }));
}

const displayed = () => screen.getByTestId('agent-model-picker-value').textContent;

describe('AralabModelPicker', () => {
  beforeEach(() => {
    mockSetActivePanel.mockReset();
    mockUser.mockReturnValue({ role: 'USER' });
    mockStartupConfig.mockReturnValue({ modelSpecs: { list: specs } } as Partial<TStartupConfig>);
    localStorage.clear();
  });

  it('has the twin map the builder relies on', () => {
    expect(ARALAB_PROVIDER_TWINS).toEqual({ 'Large File Agents': 'Aralab GPT' });
  });

  describe('options', () => {
    it('offers the non-agent specs, grouped, in list order', async () => {
      expect(getPickerSpecs(specs).map((spec) => spec.name)).toEqual([
        'aralab-gpt',
        'aralab-thinker',
        'aralab-alt-thinker',
        'claude-sonnet-5-5',
        'claude-opus-5-5',
      ]);
      expect(
        groupPickerSpecs(getPickerSpecs(specs)).map((group) => [
          group.name,
          group.icon,
          group.specs.map((spec) => spec.name),
        ]),
      ).toEqual([
        ['Aralab', ARALAB_ICON, ['aralab-gpt', 'aralab-thinker', 'aralab-alt-thinker']],
        ['Claude', 'anthropic', ['claude-sonnet-5-5', 'claude-opus-5-5']],
      ]);

      await renderPicker({ provider: 'Aralab GPT', model: 'Aralab GPT' });
      await clickDropdown(screen.getByTestId('agent-model-picker'));

      const options = screen.getAllByRole('option');
      expect(options.map((option) => option.getAttribute('data-testid'))).toEqual([
        'agent-model-option-aralab-gpt',
        'agent-model-option-aralab-thinker',
        'agent-model-option-aralab-alt-thinker',
        'agent-model-option-claude-sonnet-5-5',
        'agent-model-option-claude-opus-5-5',
      ]);
      expect(screen.queryByText('Some Agent')).toBeNull();
      expect(screen.queryByText('Pinned Agent')).toBeNull();

      const groups = screen.getAllByRole('group');
      expect(groups).toHaveLength(2);
      expect(within(groups[0]).getByText('Aralab')).toBeTruthy();
      expect(within(groups[0]).getAllByRole('option')).toHaveLength(3);
      expect(within(groups[1]).getByText('Claude')).toBeTruthy();
      expect(within(groups[1]).getAllByRole('option')).toHaveLength(2);
      expect(within(groups[0]).getByText('Quick answers')).toBeTruthy();
    });
  });

  describe('picking a spec', () => {
    it('Aralab Thinker sets provider, model and high effort, keeping other parameters', async () => {
      const { form } = await renderPicker({
        provider: 'Claude',
        model: 'anthropic/claude-opus-5.5',
        modelParameters: { maxContextTokens: 500000, fileTokenLimit: 1000, resendFiles: true },
      });

      await pick('Aralab Thinker');

      expect(providerOf(form().getValues('provider'))).toBe('Aralab GPT');
      expect(form().getValues('model')).toBe('Aralab GPT');
      expect(form().getValues('model_parameters')).toEqual({
        maxContextTokens: 500000,
        fileTokenLimit: 1000,
        resendFiles: true,
        reasoning_effort: 'high',
      });
      expect(form().getFieldState('provider').isDirty).toBe(true);
      expect(form().getFieldState('model').isDirty).toBe(true);
      expect(displayed()).toBe('Aralab Thinker');
      expect(localStorage.getItem(LocalStorageKeys.LAST_AGENT_PROVIDER)).toBe('Aralab GPT');
      expect(localStorage.getItem(LocalStorageKeys.LAST_AGENT_MODEL)).toBe('Aralab GPT');
    });

    it('Aralab Alternative Thinker removes reasoning_effort', async () => {
      const { form } = await renderPicker({
        provider: 'Aralab GPT',
        model: 'Aralab GPT',
        modelParameters: { reasoning_effort: 'high', maxContextTokens: 500000 },
      });

      await pick('Aralab Alternative Thinker');

      expect(providerOf(form().getValues('provider'))).toBe('Aralab Alternative Thinker');
      expect(form().getValues('model')).toBe('Aralab Alternative Thinker');
      const parameters = form().getValues('model_parameters') as Record<string, unknown>;
      expect(parameters).toEqual({ maxContextTokens: 500000 });
      expect('reasoning_effort' in parameters).toBe(false);
    });

    it('an agent on Large File Agents keeps its provider when picking an Aralab GPT spec', async () => {
      const { form } = await renderPicker({
        provider: { label: 'Large File Agents', value: 'Large File Agents' },
        model: 'Aralab GPT',
        modelParameters: { reasoning_effort: 'medium', maxContextTokens: 500000 },
      });
      expect(displayed()).toBe('Aralab Fast · large files');

      await pick('Aralab Thinker');

      expect(providerOf(form().getValues('provider'))).toBe('Large File Agents');
      expect(form().getValues('model')).toBe('Aralab GPT');
      expect(form().getValues('model_parameters')).toEqual({
        reasoning_effort: 'high',
        maxContextTokens: 500000,
      });
      expect(displayed()).toBe('Aralab Thinker · large files');
    });

    it('an agent on Large File Agents moves off it when picking another endpoint', async () => {
      const { form } = await renderPicker({
        provider: 'Large File Agents',
        model: 'Aralab GPT',
      });

      await pick('Claude Opus 5.5');

      expect(providerOf(form().getValues('provider'))).toBe('Claude');
      expect(form().getValues('model')).toBe('anthropic/claude-opus-5.5');
    });

    it('re-picking the closest spec of a custom configuration resets its effort', async () => {
      const { form } = await renderPicker({
        provider: 'Aralab GPT',
        model: 'Aralab GPT',
        modelParameters: { reasoning_effort: 'low' },
      });
      expect(displayed()).toBe('Aralab Fast · custom settings');

      await pick('Aralab Fast');

      expect(form().getValues('model_parameters')).toEqual({ reasoning_effort: 'medium' });
      expect(displayed()).toBe('Aralab Fast');
    });
  });

  describe('display', () => {
    it('shows the label of the exact match', async () => {
      await renderPicker({
        provider: 'Claude',
        model: 'anthropic/claude-sonnet-5.5',
        modelParameters: { reasoning_effort: 'medium' },
      });
      expect(displayed()).toBe('Claude Sonnet 5.5');
    });

    it('matches a spec without effort only when the agent has none either', async () => {
      await renderPicker({
        provider: 'Aralab Alternative Thinker',
        model: 'Aralab Alternative Thinker',
      });
      expect(displayed()).toBe('Aralab Alternative Thinker');
    });

    it('flags same endpoint and model with other settings as custom, naming the first such spec', async () => {
      await renderPicker({
        provider: 'Aralab GPT',
        model: 'Aralab GPT',
        modelParameters: { reasoning_effort: 'low' },
      });
      expect(displayed()).toBe('Aralab Fast · custom settings');
    });

    it('treats a missing effort as custom when every spec of that model sets one', async () => {
      await renderPicker({ provider: 'Claude', model: 'anthropic/claude-opus-5.5' });
      expect(displayed()).toBe('Claude Opus 5.5 · custom settings');
    });

    it('appends "large files" on the twin provider', async () => {
      await renderPicker({
        provider: 'Large File Agents',
        model: 'Aralab GPT',
        modelParameters: { reasoning_effort: 'low' },
      });
      expect(displayed()).toBe('Aralab Fast · custom settings · large files');
    });

    it('falls back to "<provider> / <model>" when no spec matches', async () => {
      await renderPicker({ provider: 'OpenRouter', model: 'some/other-model' });
      expect(displayed()).toBe('OpenRouter / some/other-model');
      expect(screen.getByTestId('provider-icon')).toBeTruthy();
    });

    it('falls back when the endpoint matches but the model does not', async () => {
      await renderPicker({ provider: 'Claude', model: 'anthropic/claude-haiku-5' });
      expect(displayed()).toBe('Claude / anthropic/claude-haiku-5');
    });

    it('shows the placeholder before a model is chosen', async () => {
      await renderPicker();
      expect(displayed()).toBe('Select a model');
      /** The trigger sits inside the agent form and must never submit it. */
      expect(screen.getByTestId('agent-model-picker').getAttribute('type')).toBe('button');
    });
  });

  describe('admin advanced settings', () => {
    it('admins see "Advanced settings", which opens the model panel', async () => {
      mockUser.mockReturnValue({ role: 'ADMIN' });
      await renderPicker({ provider: 'Aralab GPT', model: 'Aralab GPT' });

      const button = screen.getByRole('button', { name: 'Advanced settings' });
      await clickDropdown(button);

      expect(mockSetActivePanel).toHaveBeenCalledWith(Panel.model);
    });

    it('regular users get no path to the model panel', async () => {
      await renderPicker({ provider: 'Aralab GPT', model: 'Aralab GPT' });

      expect(screen.queryByRole('button', { name: 'Advanced settings' })).toBeNull();
      await clickDropdown(screen.getByTestId('agent-model-picker'));
      expect(screen.queryByText('Advanced settings')).toBeNull();
      expect(mockSetActivePanel).not.toHaveBeenCalled();
    });
  });

  describe('no side effects', () => {
    it('rendering and opening the picker leave the form untouched', async () => {
      const initialParameters = { reasoning_effort: 'low', maxContextTokens: 500000 };
      const { form } = await renderPicker({
        provider: 'Large File Agents',
        model: 'Aralab GPT',
        modelParameters: initialParameters,
      });

      await clickDropdown(screen.getByTestId('agent-model-picker'));
      expect(screen.getAllByRole('option')).toHaveLength(5);

      expect(providerOf(form().getValues('provider'))).toBe('Large File Agents');
      expect(form().getValues('model')).toBe('Aralab GPT');
      expect(form().getValues('model_parameters')).toEqual(initialParameters);
      expect(form().getFieldState('provider').isDirty).toBe(false);
      expect(form().getFieldState('model').isDirty).toBe(false);
      expect(form().getFieldState('model_parameters').isDirty).toBe(false);
      expect(localStorage.getItem(LocalStorageKeys.LAST_AGENT_PROVIDER)).toBeNull();
    });
  });

  it('uses only English strings that exist in the locale file', () => {
    const keys = [
      'com_agents_model_advanced_settings',
      'com_agents_model_custom_settings',
      'com_agents_model_large_files',
      'com_agents_model_no_options',
    ];
    for (const key of keys) {
      expect((enTranslation as Record<string, string>)[key]).toBeTruthy();
    }
  });
});
