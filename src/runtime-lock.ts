import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';

// One owner for a data directory: a running app or an offline update.
export function acquireDataLock(directory: string, mode: 'server' | 'update') {
  const dataDir = resolve(directory);
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, '.study-studio.lock');
  const token = randomUUID();
  for (let attempt = 0; attempt < 3; attempt++) {
    let fd: number;
    try {
      fd = openSync(file, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let previous: { pid: number; token: string }, original: string;
      try {
        original = readFileSync(file, 'utf8');
        previous = JSON.parse(original);
      } catch {
        throw new Error('データの使用状況を確認できません。ロックファイルを確認してください。');
      }
      if (
        !Number.isInteger(previous.pid) ||
        previous.pid <= 0 ||
        typeof previous.token !== 'string'
      )
        throw new Error('データのロック情報が不正です。自動で変更しません。');
      let active = true;
      try {
        process.kill(previous.pid, 0);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ESRCH') active = false;
        else throw new Error('データを使用中のアプリがあるか確認できません。');
      }
      if (active)
        throw new Error(
          'このデータはアプリまたは別の更新処理が使用中です。停止してから実行してください。',
        );
      if (readFileSync(file, 'utf8') !== original) continue;
      // Retain a stale record instead of deleting it.
      renameSync(file, join(dataDir, `.study-studio.stale-${randomUUID()}.lock`));
      continue;
    }
    try {
      writeFileSync(
        fd,
        JSON.stringify({ pid: process.pid, mode, token, createdAt: new Date().toISOString() }),
      );
    } finally {
      closeSync(fd);
    }
    return {
      release() {
        if (!existsSync(file)) return;
        try {
          const owner = JSON.parse(readFileSync(file, 'utf8'));
          if (owner.token === token) unlinkSync(file);
        } catch {
          /* Never remove a lock owned by someone else. */
        }
      },
    };
  }
  throw new Error('別の処理と競合したため更新を中止しました。');
}
