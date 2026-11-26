import {
  getAralabCodeEndpoints,
  isAralabCodeBySpec,
  isAralabCodeAllowedForProvider,
} from './codeEndpoints';
import { resolveEphemeralTools } from '../agents/toggles';

const ALT = 'Aralab Alternative Thinker';

describe('Aralab patch 14: code only where a model spec turns it on', () => {
  const saved = process.env.ARALAB_CODE_ENDPOINTS;
  afterEach(() => {
    if (saved === undefined) {
      delete process.env.ARALAB_CODE_ENDPOINTS;
    } else {
      process.env.ARALAB_CODE_ENDPOINTS = saved;
    }
  });

  it('is off when the variable is unset or blank', () => {
    expect(getAralabCodeEndpoints({})).toBeNull();
    expect(getAralabCodeEndpoints({ ARALAB_CODE_ENDPOINTS: ' , ' })).toBeNull();
    expect(isAralabCodeBySpec({})).toBe(false);
    expect(isAralabCodeAllowedForProvider('Claude', {})).toBe(true);
  });

  it('allows only the listed endpoints', () => {
    const env = { ARALAB_CODE_ENDPOINTS: ` ${ALT} , Other ` };
    expect(isAralabCodeBySpec(env)).toBe(true);
    expect(isAralabCodeAllowedForProvider(ALT, env)).toBe(true);
    expect(isAralabCodeAllowedForProvider('Other', env)).toBe(true);
    expect(isAralabCodeAllowedForProvider('Aralab GPT', env)).toBe(false);
    expect(isAralabCodeAllowedForProvider('Claude', env)).toBe(false);
    expect(isAralabCodeAllowedForProvider(undefined, env)).toBe(false);
  });

  it('upstream: the user toggle beats the spec default', () => {
    delete process.env.ARALAB_CODE_ENDPOINTS;
    expect(resolveEphemeralTools({ execute_code: true }, {})).toContain('execute_code');
    expect(resolveEphemeralTools({ execute_code: false }, { executeCode: true })).not.toContain(
      'execute_code',
    );
  });

  it('patched: the spec alone decides code; other toggles are untouched', () => {
    process.env.ARALAB_CODE_ENDPOINTS = ALT;
    expect(resolveEphemeralTools({ execute_code: true }, {})).not.toContain('execute_code');
    expect(resolveEphemeralTools({ execute_code: true }, { executeCode: false })).not.toContain(
      'execute_code',
    );
    expect(resolveEphemeralTools({ execute_code: false }, { executeCode: true })).toContain(
      'execute_code',
    );
    expect(resolveEphemeralTools({}, { executeCode: true })).toContain('execute_code');
    expect(resolveEphemeralTools({ web_search: true }, { webSearch: false })).toContain(
      'web_search',
    );
  });
});
