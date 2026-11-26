import { aralabHeldBackReason, getAralabReturnExtensions } from './returnedFiles';

describe('Aralab patch 16: only finished files reach the user', () => {
  const env = { ARALAB_CODE_RETURN_EXTENSIONS: 'docx, .XLSX,pptx,pdf,png' };

  it('is off when the variable is unset or blank', () => {
    expect(getAralabReturnExtensions({})).toBeNull();
    expect(getAralabReturnExtensions({ ARALAB_CODE_RETURN_EXTENSIONS: ' , ' })).toBeNull();
    expect(aralabHeldBackReason('apply_aralab_template.py', {})).toBeNull();
    expect(aralabHeldBackReason('preview/x.jpg', {})).toBeNull();
  });

  it('returns listed types at the top of /mnt/data', () => {
    expect(aralabHeldBackReason('Nota_Diagnostico_Aralab.docx', env)).toBeNull();
    expect(aralabHeldBackReason('Quote.XLSX', env)).toBeNull();
    expect(aralabHeldBackReason('/mnt/data/Deck.pptx', env)).toBeNull();
  });

  it('keeps scripts, other types and anything in a folder', () => {
    expect(aralabHeldBackReason('apply_aralab_template.py', env)).toMatch(/\.py/);
    expect(aralabHeldBackReason('notes', env)).toMatch(/no extension/);
    expect(aralabHeldBackReason('preview/Nota-overview.jpg', env)).toBe('in a folder');
    expect(aralabHeldBackReason('work/Nota.docx', env)).toBe('in a folder');
    expect(aralabHeldBackReason('', env)).toBe('in a folder');
    expect(aralabHeldBackReason(undefined, env)).toBe('in a folder');
  });
});
