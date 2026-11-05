import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
export const INIAD_BASE_URL = 'https://api.openai.iniad.org/api/v1';
const configSchema = z.object({
  apiKey: z.string().max(500),
  model: z.string().regex(/^[a-zA-Z0-9._:/-]{1,100}$/),
});
export type AIConfig = z.infer<typeof configSchema>;
export function loadConfig(directory: string): AIConfig {
  const file = join(directory, 'ai-config.json');
  if (existsSync(file)) return configSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  return {
    apiKey: process.env.INIAD_API_KEY?.trim() || '',
    model: process.env.INIAD_MODEL?.trim() || 'gpt-6-luna',
  };
}
export function saveConfig(directory: string, value: AIConfig) {
  const config = configSchema.parse(value);
  writeFileSync(join(directory, 'ai-config.json'), JSON.stringify(config), {
    encoding: 'utf8',
    mode: 0o600,
  });
  return config;
}
