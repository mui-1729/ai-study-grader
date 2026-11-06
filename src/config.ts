import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { defaultCredentialVault, type CredentialVault } from './credentials.js';
export const INIAD_BASE_URL = 'https://api.openai.iniad.org/api/v1';
const configSchema = z.object({
  apiKey: z.string().max(500),
  model: z.string().regex(/^[a-zA-Z0-9._:/-]{1,100}$/),
});
export type AIConfig = z.infer<typeof configSchema> & {
  credentialStorage?: 'windows-protected' | 'session' | 'environment' | 'unset';
};
function metadata(directory: string, model: string, keyDisabled = false) {
  writeFileSync(
    join(directory, 'ai-config.json'),
    JSON.stringify({ model, ...(keyDisabled ? { keyDisabled: true } : {}) }),
    {
      encoding: 'utf8',
      mode: 0o600,
    },
  );
}
export function loadConfig(
  directory: string,
  vault: CredentialVault = defaultCredentialVault(directory),
): AIConfig {
  const file = join(directory, 'ai-config.json');
  const saved = existsSync(file)
    ? z
        .object({
          apiKey: z.string().max(500).optional(),
          model: configSchema.shape.model,
          keyDisabled: z.boolean().optional(),
        })
        .parse(JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')))
    : {
        model: process.env.INIAD_MODEL?.trim() || 'gpt-6-luna',
        apiKey: undefined,
        keyDisabled: false,
      };
  if (saved.apiKey?.trim()) {
    vault.write(saved.apiKey.trim());
    metadata(directory, saved.model);
  } else if (saved.apiKey !== undefined) metadata(directory, saved.model, saved.keyDisabled);
  const protectedKey = vault.read();
  const apiKey = protectedKey || (!saved.keyDisabled && process.env.INIAD_API_KEY?.trim()) || '';
  return {
    model: saved.model,
    apiKey,
    credentialStorage: protectedKey ? vault.kind : apiKey ? 'environment' : 'unset',
  };
}
export function saveConfig(
  directory: string,
  value: AIConfig,
  vault: CredentialVault = defaultCredentialVault(directory),
) {
  const config = configSchema.parse(value);
  if (config.apiKey) vault.write(config.apiKey);
  else vault.remove();
  metadata(directory, config.model, !config.apiKey);
  return { ...config, credentialStorage: config.apiKey ? vault.kind : 'unset' } as AIConfig;
}
