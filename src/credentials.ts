import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
export interface CredentialVault {
  kind: 'windows-protected' | 'session';
  read(): string;
  write(key: string): void;
  remove(): void;
}
export function memoryCredentialVault(): CredentialVault {
  let key = '';
  return {
    kind: 'session',
    read: () => key,
    write: (value) => {
      key = value;
    },
    remove: () => {
      key = '';
    },
  };
}
function dpapi(value: string, decrypt: boolean): string {
  const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; [Console]::InputEncoding=New-Object Text.UTF8Encoding($false); [Console]::OutputEncoding=New-Object Text.UTF8Encoding($false); $value=[Console]::In.ReadToEnd(); ${decrypt ? '$bytes=[Convert]::FromBase64String($value); $plain=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain))' : '$bytes=[Text.Encoding]::UTF8.GetBytes($value); $protected=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($protected))'}`;
  const env = { ...process.env };
  delete env.INIAD_API_KEY;
  delete env.OPENAI_API_KEY;
  try {
    return execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      {
        input: value,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 15000,
        maxBuffer: 65536,
        stdio: ['pipe', 'pipe', 'ignore'],
        env,
      },
    ).trim();
  } catch {
    throw new Error('Windowsのキー保護機能を利用できませんでした。キーは表示・記録していません。');
  }
}
export function windowsCredentialVault(
  directory: string,
  root = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'),
): CredentialVault {
  const id = createHash('sha256').update(resolve(directory).toLowerCase()).digest('hex');
  const file = join(root, 'StudyStudio', 'credentials', `${id}.dpapi`);
  return {
    kind: 'windows-protected',
    read: () => (existsSync(file) ? dpapi(readFileSync(file, 'utf8'), true) : ''),
    write: (key) => {
      const encrypted = dpapi(key, false);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, encrypted, { encoding: 'utf8', mode: 0o600 });
    },
    remove: () => {
      if (existsSync(file)) unlinkSync(file);
    },
  };
}
export const defaultCredentialVault = (directory: string) =>
  process.platform === 'win32' ? windowsCredentialVault(directory) : memoryCredentialVault();
