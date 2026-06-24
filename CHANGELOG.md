# Changelog

All notable changes to Aider Studio are documented here.

## [0.1.1]

### Added
- **Local (Ollama) models** as a first-class option — no API key, no rate
  limits. The provider modal has **Cloud / Local tabs**; Local accepts a bare
  model name (auto-prefixes `ollama_chat/`).
- **Remote Ollama** — optional **Ollama URL** in the Local tab to point at a
  model running on another machine (with automatic `host.docker.internal`
  rewrite for localhost URLs in Docker mode).
- **Remove providers** from a "Your providers" list in the modal — including the
  built-in defaults (tracked via `aiderStudio.hiddenProviders`).

### Changed
- Default free OpenRouter model is now **Qwen3 Coder** (the previous DeepSeek
  free tier was discontinued upstream).

## [0.1.0] — Initial release

First public release. A Claude Code-style chat sidebar for VS Code, powered by
Aider and your own LLM provider.

### Features
- **Chat sidebar** with a flat, streamed transcript and live markdown rendering
  (headings, lists, fenced code blocks with copy).
- **Bring-your-own model** — extensible provider registry; add any
  Aider/LiteLLM model from the UI (OpenRouter, Gemini, Groq, OpenAI, Mistral…)
  with no code changes. Keys stored in VS Code secret storage.
- **Run Aider in Docker** (default) so no local `pip install` is required, or
  natively if `aider` is on your PATH; automatic fallback to Docker when the
  native binary is missing.
- **Repo map** — an always-loaded `REPO_MAP.md` index (per-file summary +
  outline with line numbers + metadata), built lazily and cached, so the model
  is aware of the whole workspace without loading every file.
- **Auto-attach files** — referencing a file (or its closest fuzzy match)
  auto-adds it to context.
- **Inline diff cards** with accept / undo / open when Aider edits a file.
- **Context-files strip**, **`@file` autocomplete**, **working/elapsed
  indicator with Stop**, and a **debug toggle** for Aider model warnings.
- **Rate-limit aware** — checkpoints summaries and unloads context to protect
  free-tier limits.
