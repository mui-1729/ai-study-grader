import { mkdirSync } from 'node:fs';
import { z } from 'zod';
import { saveConfig } from '../src/config.js';
let input = '';
for await (const chunk of process.stdin) input += chunk;
try {
  const value = z
    .object({
      apiKey: z.string().trim().min(1).max(500),
      model: z.string().regex(/^[a-zA-Z0-9._:/-]{1,100}$/),
    })
    .strict()
    .parse(JSON.parse(input));
  mkdirSync('data', { recursive: true });
  saveConfig('data', value);
  console.log('キーを保護して保存しました。アプリを起動し直してください。');
} catch {
  console.error('キーを保存できませんでした。入力とWindowsの保護機能を確認してください。');
  process.exitCode = 1;
}
