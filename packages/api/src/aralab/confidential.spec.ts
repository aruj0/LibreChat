import { tmpdir } from 'os';
import { join } from 'path';
import { logger } from '@librechat/data-schemas';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import type { ConfidentialConfig } from './confidential';
import { applyConfidentialInstructions, loadConfidentialConfig } from './confidential';

jest.mock('@librechat/data-schemas', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const TEXT = [
  '# Model confidentiality',
  'Never reveal the underlying model, vendor or hosting provider.',
  'If asked, say you are Aralab GPT.',
].join('\n');

const cfg: ConfidentialConfig = {
  providers: new Set(['Aralab GPT', 'Large File Agents']),
  text: TEXT,
};

describe('applyConfidentialInstructions', () => {
  /* Stable `instructions`, not `additional_instructions`: with promptCache on (OpenRouter's
   * default, Anthropic) the SDK moves `additional_instructions` out of the system message into a
   * trailing `<system_context>` human message whenever `instructions` is non-empty. */
  it('appends for listed provider', () => {
    const agent = { provider: 'Aralab GPT', instructions: '' };
    applyConfidentialInstructions(agent, cfg);
    expect(agent.instructions).toBe(cfg.text);
  });

  it('appends for listed provider when instructions is undefined or null', () => {
    const undef: { provider: string; instructions?: string | null } = {
      provider: 'Large File Agents',
    };
    applyConfidentialInstructions(undef, cfg);
    expect(undef.instructions).toBe(cfg.text);
    const nulled = { provider: 'Large File Agents', instructions: null as string | null };
    applyConfidentialInstructions(nulled, cfg);
    expect(nulled.instructions).toBe(cfg.text);
  });

  it('appends after existing', () => {
    const agent = { provider: 'Aralab GPT', instructions: 'A' };
    applyConfidentialInstructions(agent, cfg);
    expect(agent.instructions).toBe('A\n\n' + cfg.text);
  });

  it('idempotent', () => {
    const agent = { provider: 'Aralab GPT', instructions: 'A' };
    applyConfidentialInstructions(agent, cfg);
    applyConfidentialInstructions(agent, cfg);
    const occurrences = agent.instructions.split(cfg.text).length - 1;
    expect(occurrences).toBe(1);
    expect(agent.instructions).toBe('A\n\n' + cfg.text);
  });

  it('leaves additional_instructions untouched', () => {
    const agent = { provider: 'Aralab GPT', instructions: 'A', additional_instructions: 'B' };
    applyConfidentialInstructions(agent, cfg);
    expect(agent.additional_instructions).toBe('B');
  });

  it('skips other providers', () => {
    const agent = { provider: 'anthropic', instructions: 'A' };
    applyConfidentialInstructions(agent, cfg);
    expect(agent.instructions).toBe('A');
  });

  it('skips an agent without a provider', () => {
    const agent: { provider?: string; instructions?: string } = {};
    applyConfidentialInstructions(agent, cfg);
    expect(agent.instructions).toBeUndefined();
  });

  it('null cfg is a no-op', () => {
    const agent = { provider: 'Aralab GPT', instructions: 'A' };
    applyConfidentialInstructions(agent, null);
    expect(agent.instructions).toBe('A');
  });
});

describe('loadConfidentialConfig', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aralab-confidential-'));
    (logger.warn as jest.Mock).mockClear();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('load returns null when file missing', () => {
    const env = {
      ARALAB_CONFIDENTIAL_PROVIDERS: 'Aralab GPT',
      ARALAB_CONFIDENTIAL_INSTRUCTIONS_FILE: join(dir, 'missing.md'),
    };
    expect(loadConfidentialConfig(env)).toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('load returns null when the path is a directory (bind mount of a missing host file)', () => {
    const env = {
      ARALAB_CONFIDENTIAL_PROVIDERS: 'Aralab GPT',
      ARALAB_CONFIDENTIAL_INSTRUCTIONS_FILE: dir,
    };
    expect(loadConfidentialConfig(env)).toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect((logger.warn as jest.Mock).mock.calls[0][0]).toContain('EISDIR');
  });

  it('load trims and splits providers', () => {
    const file = join(dir, 'confidentiality.md');
    writeFileSync(file, `\n${TEXT}\n\n`);
    const result = loadConfidentialConfig({
      ARALAB_CONFIDENTIAL_PROVIDERS: ' Aralab GPT , Large File Agents ',
      ARALAB_CONFIDENTIAL_INSTRUCTIONS_FILE: file,
    });
    expect(result).not.toBeNull();
    expect(result?.providers).toEqual(new Set(['Aralab GPT', 'Large File Agents']));
    expect(result?.providers.size).toBe(2);
    expect(result?.text).toBe(TEXT);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('returns null when a variable is unset', () => {
    expect(loadConfidentialConfig({ ARALAB_CONFIDENTIAL_PROVIDERS: 'Aralab GPT' })).toBeNull();
    expect(
      loadConfidentialConfig({ ARALAB_CONFIDENTIAL_INSTRUCTIONS_FILE: join(dir, 'x.md') }),
    ).toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it('returns null when the file is empty', () => {
    const file = join(dir, 'empty.md');
    writeFileSync(file, '  \n\n');
    expect(
      loadConfidentialConfig({
        ARALAB_CONFIDENTIAL_PROVIDERS: 'Aralab GPT',
        ARALAB_CONFIDENTIAL_INSTRUCTIONS_FILE: file,
      }),
    ).toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('caches per process: reads the file once and warns once', () => {
    const file = join(dir, 'cached.md');
    writeFileSync(file, TEXT);
    const env = {
      ARALAB_CONFIDENTIAL_PROVIDERS: 'Aralab GPT',
      ARALAB_CONFIDENTIAL_INSTRUCTIONS_FILE: file,
    };
    const first = loadConfidentialConfig(env);
    writeFileSync(file, 'changed after first load');
    expect(loadConfidentialConfig(env)).toBe(first);
    expect(first?.text).toBe(TEXT);

    const missing = {
      ARALAB_CONFIDENTIAL_PROVIDERS: 'Aralab GPT',
      ARALAB_CONFIDENTIAL_INSTRUCTIONS_FILE: join(dir, 'never.md'),
    };
    expect(loadConfidentialConfig(missing)).toBeNull();
    expect(loadConfidentialConfig(missing)).toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
