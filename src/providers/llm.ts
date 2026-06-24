import { ProviderConfig } from './registry';

/**
 * Lightweight, direct LLM calls to the *currently active* provider.
 *
 * Used to generate repo-map summaries WITHOUT going through aider — so it
 * doesn't pollute the chat, can be throttled independently, and reuses whatever
 * model the user is already on (read from the provider registry). aider stays
 * the editing harness; this is just a side-channel for cheap metadata.
 */

const MAX_SUMMARY_TOKENS = 120;

/**
 * Result of a summary attempt. `rateLimited` is the important signal: it tells
 * the caller to STOP the ingestion pass and checkpoint, instead of burning the
 * rest of a free-tier daily quota against a wall.
 */
export type SummaryResult =
  | { ok: true; summary: string }
  | { ok: false; rateLimited: boolean };

/** Generic completion result (raw text — caller decides how to use/trim it). */
export type CompletionResult =
  | { ok: true; text: string }
  | { ok: false; rateLimited: boolean };

/**
 * Low-level call to the currently active provider. Used both for one-line file
 * summaries and for the multi-step digest (per-chunk summaries + a gather call).
 */
export async function complete(
  provider: ProviderConfig,
  apiKey: string,
  prompt: string,
  maxTokens = 400
): Promise<CompletionResult> {
  const model = provider.aiderModel; // e.g. "gemini/gemini-2.0-flash"
  try {
    if (model.startsWith('gemini/')) {
      return await callGemini(model.slice('gemini/'.length), apiKey, prompt, maxTokens);
    }
    if (model.startsWith('groq/')) {
      return await callOpenAICompatible(
        'https://api.groq.com/openai/v1/chat/completions',
        model.slice('groq/'.length), apiKey, prompt, maxTokens
      );
    }
    if (model.startsWith('openai/')) {
      return await callOpenAICompatible(
        'https://api.openai.com/v1/chat/completions',
        model.slice('openai/'.length), apiKey, prompt, maxTokens
      );
    }
    if (model.startsWith('openrouter/')) {
      return await callOpenAICompatible(
        'https://openrouter.ai/api/v1/chat/completions',
        model.slice('openrouter/'.length), apiKey, prompt, maxTokens
      );
    }
    return { ok: false, rateLimited: false };
  } catch {
    return { ok: false, rateLimited: false };
  }
}

/** Summarize a single file's contents into one or two plain sentences. */
export async function summarizeFile(
  provider: ProviderConfig,
  apiKey: string,
  fileLabel: string,
  content: string,
  maxChars = 6000
): Promise<SummaryResult> {
  const snippet = content.length > maxChars ? content.slice(0, maxChars) : content;
  const prompt =
    `Summarize this file in ONE or TWO plain sentences: its purpose and key contents. ` +
    `No preamble, no code fences, no bullet points, no markdown.\n\n` +
    `File: ${fileLabel}\n\n${snippet}`;
  const r = await complete(provider, apiKey, prompt, MAX_SUMMARY_TOKENS);
  if (!r.ok) return { ok: false, rateLimited: r.rateLimited };
  const summary = clean(r.text);
  return summary ? { ok: true, summary } : { ok: false, rateLimited: false };
}

/** HTTP statuses that mean "back off" rather than "permanent failure". */
function isRateLimitStatus(status: number): boolean {
  return status === 429 || status === 503; // 503 = provider overloaded (Gemini/Groq)
}

async function callGemini(
  model: string, apiKey: string, prompt: string, maxTokens: number
): Promise<CompletionResult> {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: maxTokens, temperature: 0.2 },
    }),
  });
  if (!res.ok) return { ok: false, rateLimited: isRateLimitStatus(res.status) };
  const data = (await res.json()) as any;
  const parts = data?.candidates?.[0]?.content?.parts;
  const text = Array.isArray(parts) ? parts.map((p: any) => p?.text ?? '').join('') : '';
  return text.trim() ? { ok: true, text } : { ok: false, rateLimited: false };
}

async function callOpenAICompatible(
  endpoint: string, model: string, apiKey: string, prompt: string, maxTokens: number
): Promise<CompletionResult> {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens,
      temperature: 0.2,
    }),
  });
  if (!res.ok) return { ok: false, rateLimited: isRateLimitStatus(res.status) };
  const data = (await res.json()) as any;
  const text = data?.choices?.[0]?.message?.content ?? '';
  return text.trim() ? { ok: true, text } : { ok: false, rateLimited: false };
}

/** Collapse a model response into a single tidy line for the map. */
function clean(text: string): string | null {
  if (!text) return null;
  const oneLine = text
    .replace(/```[\s\S]*?```/g, ' ')   // strip code fences
    .replace(/\s+/g, ' ')
    .trim();
  if (!oneLine) return null;
  return oneLine.length > 240 ? oneLine.slice(0, 237).trimEnd() + '…' : oneLine;
}
