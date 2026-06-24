import * as vscode from 'vscode';

export interface ProviderConfig {
  label: string;
  aiderModel: string;
  apiKeyEnv: string;
  apiKeySettingKey: string;
  freetier: boolean;
  /** For local (Ollama) providers: optional base URL (e.g. a remote box). */
  ollamaBaseUrl?: string;
}

export interface ProviderRegistry {
  [id: string]: ProviderConfig;
}

/**
 * Returns all configured providers from settings.
 * Adding a new provider = adding an entry to aiderStudio.providers in settings.json.
 * No code changes needed.
 */
export function getProviders(): ProviderRegistry {
  const config = vscode.workspace.getConfiguration('aiderStudio');
  const all = config.get<ProviderRegistry>('providers') ?? {};
  // VS Code re-merges built-in defaults from package.json, so deletes don't stick.
  // A separate "hidden" list lets us remove defaults too.
  const hidden = config.get<string[]>('hiddenProviders') ?? [];
  if (!hidden.length) return all;
  const out: ProviderRegistry = {};
  for (const [id, p] of Object.entries(all)) {
    if (!hidden.includes(id)) out[id] = p;
  }
  return out;
}

export function getActiveProviderId(): string {
  const config = vscode.workspace.getConfiguration('aiderStudio');
  return config.get<string>('activeProvider') ?? 'gemini';
}

export function getActiveProvider(): ProviderConfig | undefined {
  const providers = getProviders();
  const activeId = getActiveProviderId();
  return providers[activeId];
}

export async function setActiveProvider(id: string): Promise<void> {
  const config = vscode.workspace.getConfiguration('aiderStudio');
  await config.update('activeProvider', id, vscode.ConfigurationTarget.Global);
}

/**
 * Resolves the API key for a provider.
 * Checks VS Code secrets storage first, then falls back to the settings key.
 */
export async function resolveApiKey(
  context: vscode.ExtensionContext,
  provider: ProviderConfig
): Promise<string | undefined> {
  // Check secrets first
  const secret = await context.secrets.get(provider.apiKeySettingKey);
  if (secret && secret.trim()) return secret.trim();

  // Fall back to settings — try both full key and last segment
  const config = vscode.workspace.getConfiguration('aiderStudio');
  
  // Try last segment e.g. "groqApiKey"
  const parts = provider.apiKeySettingKey.split('.');
  const settingKey = parts[parts.length - 1];
  const fromSettings = config.get<string>(settingKey);
  if (fromSettings && fromSettings.trim()) return fromSettings.trim();

  // Try full setting key directly on workspace config
  const allConfig = vscode.workspace.getConfiguration();
  const full = allConfig.get<string>(provider.apiKeySettingKey);
  if (full && full.trim()) return full.trim();

  return undefined;
}

export async function storeApiKey(
  context: vscode.ExtensionContext,
  provider: ProviderConfig,
  key: string
): Promise<void> {
  await context.secrets.store(provider.apiKeySettingKey, key);
}

/**
 * Infer the conventional API-key env var name from an aider/LiteLLM model id,
 * e.g. "openrouter/anthropic/claude-3.5-haiku" → "OPENROUTER_API_KEY".
 * Used to pre-fill the custom-provider form; the user can override it.
 */
export function inferApiKeyEnv(aiderModel: string): string {
  const prefix = (aiderModel.split('/')[0] || '').toLowerCase();
  const map: Record<string, string> = {
    openrouter: 'OPENROUTER_API_KEY',
    openai: 'OPENAI_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    claude: 'ANTHROPIC_API_KEY',
    gemini: 'GEMINI_API_KEY',
    google: 'GEMINI_API_KEY',
    groq: 'GROQ_API_KEY',
    deepseek: 'DEEPSEEK_API_KEY',
    mistral: 'MISTRAL_API_KEY',
    codestral: 'MISTRAL_API_KEY',
    together: 'TOGETHER_API_KEY',
    cohere: 'COHERE_API_KEY',
    fireworks: 'FIREWORKS_API_KEY',
    xai: 'XAI_API_KEY',
    ollama: 'OLLAMA_API_KEY',
  };
  if (map[prefix]) return map[prefix];
  return prefix ? prefix.toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_API_KEY' : 'OPENAI_API_KEY';
}

/**
 * Persist a new custom provider into aiderStudio.providers (Global) and store its
 * key in secret storage. Returns the generated id + the provider config so the
 * caller can activate and resolve (start) it like any built-in provider.
 */
export async function addCustomProvider(
  context: vscode.ExtensionContext,
  input: { label: string; aiderModel: string; apiKeyEnv?: string; freetier?: boolean; apiKey: string; ollamaBaseUrl?: string }
): Promise<{ id: string; provider: ProviderConfig }> {
  const config = vscode.workspace.getConfiguration('aiderStudio');
  const providers: ProviderRegistry = { ...(config.get<ProviderRegistry>('providers') ?? {}) };

  const slug =
    input.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'provider';
  const baseId = 'custom-' + slug;
  let id = baseId;
  let n = 2;
  while (providers[id]) id = baseId + '-' + n++;

  const provider: ProviderConfig = {
    label: input.label.trim(),
    aiderModel: input.aiderModel.trim(),
    apiKeyEnv: (input.apiKeyEnv && input.apiKeyEnv.trim()) || inferApiKeyEnv(input.aiderModel),
    apiKeySettingKey: 'aiderStudio.customKey.' + id,
    freetier: !!input.freetier,
  };
  if (input.ollamaBaseUrl && input.ollamaBaseUrl.trim()) {
    provider.ollamaBaseUrl = input.ollamaBaseUrl.trim();
  }

  providers[id] = provider;
  await config.update('providers', providers, vscode.ConfigurationTarget.Global);
  await storeApiKey(context, provider, input.apiKey.trim());
  // If this id was previously hidden, un-hide it.
  const hidden = config.get<string[]>('hiddenProviders') ?? [];
  if (hidden.includes(id)) {
    await config.update('hiddenProviders', hidden.filter((h) => h !== id), vscode.ConfigurationTarget.Global);
  }
  return { id, provider };
}

/**
 * Remove a provider. Marks it hidden (so built-in defaults stay gone despite
 * VS Code re-merging them), and for custom providers also deletes the entry and
 * its stored key.
 */
export async function removeProvider(
  context: vscode.ExtensionContext,
  id: string
): Promise<void> {
  const config = vscode.workspace.getConfiguration('aiderStudio');

  const hidden = new Set(config.get<string[]>('hiddenProviders') ?? []);
  hidden.add(id);
  await config.update('hiddenProviders', [...hidden], vscode.ConfigurationTarget.Global);

  const providers: ProviderRegistry = { ...(config.get<ProviderRegistry>('providers') ?? {}) };
  const removed = providers[id];
  if (removed) {
    delete providers[id];
    await config.update('providers', providers, vscode.ConfigurationTarget.Global);
    if (removed.apiKeySettingKey) {
      try { await context.secrets.delete(removed.apiKeySettingKey); } catch { /* ignore */ }
    }
  }
}
