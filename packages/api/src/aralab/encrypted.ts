/**
 * Aralab patch 15 — say plainly that an upload failed because the file is password-protected.
 *
 * A password-protected Word, Excel or PowerPoint file is not a zip package: Office wraps the
 * encrypted package in an OLE (Compound File) container with an `EncryptionInfo` stream. The
 * document reader fails on it and upstream reports only "Error processing file". This
 * recognises such a file after the reader has failed, so the user is told what to do.
 */
import { open } from 'node:fs/promises';

const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const ENCRYPTION_MARK = Buffer.from('EncryptionInfo', 'utf16le');
/** An Office Open XML name: an OLE container under this name can only be an encrypted package. */
const OOXML_NAME = /\.(docx|docm|dotx|xlsx|xlsm|xltx|pptx|pptm|potx)$/i;
const SCAN_BYTES = 1024 * 1024;

export const PASSWORD_PROTECTED_MESSAGE =
  'This file is password-protected. Save a copy without the password and attach that.';

/** Whether the file at `filePath` is a password-protected Office file. Never throws. */
export async function isPasswordProtectedOffice(
  filePath: string | undefined,
  fileName?: string,
): Promise<boolean> {
  if (!filePath) {
    return false;
  }
  let handle;
  try {
    handle = await open(filePath, 'r');
    const buffer = Buffer.alloc(SCAN_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, SCAN_BYTES, 0);
    const head = buffer.subarray(0, bytesRead);
    if (head.length < OLE_MAGIC.length || !head.subarray(0, OLE_MAGIC.length).equals(OLE_MAGIC)) {
      return false;
    }
    return (fileName != null && OOXML_NAME.test(fileName)) || head.includes(ENCRYPTION_MARK);
  } catch {
    return false;
  } finally {
    await handle?.close();
  }
}
