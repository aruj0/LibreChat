import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { isPasswordProtectedOffice, PASSWORD_PROTECTED_MESSAGE } from './encrypted';
import { resolveUploadErrorMessage } from '../utils/files';

const OLE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

describe('Aralab patch 15: password-protected Office files', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'aralab-enc-'));
  });

  const file = async (name: string, bytes: Buffer) => {
    const target = path.join(dir, name);
    await writeFile(target, bytes);
    return target;
  };

  it('recognises an OLE container under an Office Open XML name', async () => {
    const target = await file('protected.xlsx', Buffer.concat([OLE, Buffer.alloc(600)]));
    expect(await isPasswordProtectedOffice(target, 'protected.xlsx')).toBe(true);
  });

  it('recognises the EncryptionInfo stream whatever the name', async () => {
    const bytes = Buffer.concat([OLE, Buffer.alloc(100), Buffer.from('EncryptionInfo', 'utf16le')]);
    const target = await file('upload.bin', bytes);
    expect(await isPasswordProtectedOffice(target, 'upload.bin')).toBe(true);
  });

  it('leaves zip packages and old unencrypted files alone', async () => {
    const zip = await file('plain.xlsx', Buffer.from('PK\u0003\u0004 not encrypted'));
    expect(await isPasswordProtectedOffice(zip, 'plain.xlsx')).toBe(false);
    const legacy = await file(
      'legacy.xls',
      Buffer.concat([OLE, Buffer.from('Workbook', 'utf16le')]),
    );
    expect(await isPasswordProtectedOffice(legacy, 'legacy.xls')).toBe(false);
    expect(await isPasswordProtectedOffice(path.join(dir, 'missing.xlsx'), 'missing.xlsx')).toBe(
      false,
    );
    expect(await isPasswordProtectedOffice(undefined)).toBe(false);
  });

  it('reaches the user, with or without content protection', () => {
    const error = new Error(PASSWORD_PROTECTED_MESSAGE);
    expect(resolveUploadErrorMessage(error)).toBe(PASSWORD_PROTECTED_MESSAGE);
    expect(resolveUploadErrorMessage(error, 'Error processing file', true)).toBe(
      PASSWORD_PROTECTED_MESSAGE,
    );
  });
});
