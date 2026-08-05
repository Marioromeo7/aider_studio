/**
 * Local (on-device) runtime backends.
 *
 * Every local LLM server we support — Ollama, LM Studio, llama.cpp's server,
 * text-generation-webui, vLLM, LocalAI, etc. — speaks (at minimum) the
 * OpenAI-compatible `/v1/chat/completions` API, so OpenAICompatibleBackend is
 * the generic strategy: any of them works out of the box with just a base URL.
 *
 * Ollama additionally exposes its own native API (`/api/tags`, `/api/chat`)
 * which aider/LiteLLM talks to via the `ollama_chat/` model prefix. That path
 * has real niceties over the generic one (correct context-window handling, no
 * placeholder API key, richer model listing) so OllamaBackend specializes the
 * generic strategy rather than replacing it — same base-URL/Docker plumbing,
 * different wire protocol.
 */

export type LocalKind = 'ollama' | 'openai-compatible';

export interface LocalConnection {
  /** Env vars to inject into the aider process/container. */
  env: Record<string, string>;
  /** The --model value aider should be given, e.g. "openai/qwen2.5-coder" or "ollama_chat/qwen2.5-coder:3b". */
  aiderModel: string;
  /** Extra `docker run` args needed for the container to reach the host server. */
  dockerExtraArgs: string[];
}

export interface LocalModelInfo {
  id: string;
}

const LOCALHOST_RE = /\/\/(localhost|127\.0\.0\.1)\b/i;
const PROBE_TIMEOUT_MS = 4000;

export abstract class LocalBackend {
  abstract readonly kind: LocalKind;
  protected abstract readonly defaultPort: number;

  constructor(protected baseUrl: string, protected useDocker: boolean) {}

  /** Given a bare or already-prefixed model id, produce everything aider needs to reach this server. */
  abstract resolveConnection(modelId: string): LocalConnection;

  /** List models currently available on the server (for a picker, so users don't have to guess ids). */
  abstract listModels(): Promise<LocalModelInfo[]>;

  /** Reachability probe used by the "Test connection" button in the Add Provider modal. */
  async testConnection(): Promise<{ ok: boolean; message: string }> {
    try {
      const models = await this.listModels();
      return models.length
        ? { ok: true, message: `Connected — ${models.length} model(s) available.` }
        : { ok: true, message: 'Connected, but no models are loaded on the server yet.' };
    } catch (e: any) {
      return { ok: false, message: `Could not reach server: ${e?.message ?? String(e)}` };
    }
  }

  /** Base URL as the server actually sees it — no Docker rewriting. Used when *we* call it directly. */
  protected rawBaseUrl(): string {
    const base = (this.baseUrl || `http://localhost:${this.defaultPort}`).trim();
    return base.replace(/\/+$/, '');
  }

  /**
   * Base URL for the env var handed to aider. When aider runs inside Docker, a
   * "localhost" URL means the container itself, not the host — rewrite it to
   * Docker's host-gateway alias so the container can still reach a server
   * running on the user's machine.
   */
  protected dockerAwareBaseUrl(): string {
    let base = this.rawBaseUrl();
    if (this.useDocker && LOCALHOST_RE.test(base)) {
      base = base.replace(/(localhost|127\.0\.0\.1)/i, 'host.docker.internal');
    }
    return base;
  }

  protected dockerExtraArgs(): string[] {
    return this.useDocker ? ['--add-host', 'host.docker.internal:host-gateway'] : [];
  }

  protected async fetchJson(url: string): Promise<any> {
    const res = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
}

/** Generic strategy: any OpenAI-compatible local server (LM Studio, llama.cpp, vLLM, text-gen-webui, ...). */
export class OpenAICompatibleBackend extends LocalBackend {
  readonly kind: LocalKind = 'openai-compatible';
  protected readonly defaultPort: number = 1234; // LM Studio's default; most others default near here too

  resolveConnection(modelId: string): LocalConnection {
    const base = this.dockerAwareBaseUrl();
    return {
      env: {
        OPENAI_API_BASE: base.endsWith('/v1') ? base : base + '/v1',
        // LiteLLM's OpenAI client requires *a* key to build the request even
        // though local servers generally don't check it.
        OPENAI_API_KEY: 'not-needed',
      },
      aiderModel: modelId.startsWith('openai/') ? modelId : `openai/${modelId}`,
      dockerExtraArgs: this.dockerExtraArgs(),
    };
  }

  async listModels(): Promise<LocalModelInfo[]> {
    const base = this.rawBaseUrl();
    const url = base.endsWith('/v1') ? `${base}/models` : `${base}/v1/models`;
    const data = await this.fetchJson(url);
    const list = Array.isArray(data?.data) ? data.data : [];
    return list.map((m: any) => ({ id: String(m.id) }));
  }
}

/** Specialized strategy: Ollama's native API, for the niceties the generic path can't offer. */
export class OllamaBackend extends OpenAICompatibleBackend {
  readonly kind: LocalKind = 'ollama';
  protected readonly defaultPort: number = 11434;

  resolveConnection(modelId: string): LocalConnection {
    const base = this.dockerAwareBaseUrl();
    return {
      env: { OLLAMA_API_BASE: base },
      aiderModel: /^ollama(_chat)?\//.test(modelId) ? modelId : `ollama_chat/${modelId}`,
      dockerExtraArgs: this.dockerExtraArgs(),
    };
  }

  async listModels(): Promise<LocalModelInfo[]> {
    const data = await this.fetchJson(`${this.rawBaseUrl()}/api/tags`);
    const list = Array.isArray(data?.models) ? data.models : [];
    return list.map((m: any) => ({ id: String(m.name ?? m.model) }));
  }
}

export function getLocalBackend(kind: LocalKind, baseUrl: string | undefined, useDocker: boolean): LocalBackend {
  return kind === 'ollama'
    ? new OllamaBackend(baseUrl ?? '', useDocker)
    : new OpenAICompatibleBackend(baseUrl ?? '', useDocker);
}
