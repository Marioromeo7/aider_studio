# Aider Studio v0.1.0

A **Claude Code-style chat sidebar for VS Code**, powered by [Aider](https://aider.chat) with **bring-your-own-model**. Aider Studio is the experience layer — you pick the LLM (and key); it makes the workflow feel like Claude Code.

## ✨ Highlights

- **Flat, streamed transcript** with live **markdown** — headings, lists, and fenced code blocks with a copy button.
- **Bring your own model** — add any Aider/LiteLLM model from the UI (OpenRouter, Gemini, Groq, OpenAI, Mistral, **local Ollama**…). Keys live in VS Code secret storage.
- **Local models, no key, no rate limits** — point it at **Ollama** and run fully offline/private (`ollama_chat/<model>`); the extension wires up the Ollama endpoint and Docker networking for you.
- **Run Aider in Docker** by default (no local `pip install`), with automatic fallback to native if a binary is present.
- **Repo map** — an always-loaded `REPO_MAP.md` (per-file summary + outline with line numbers + metadata) so the model is aware of the whole workspace, cheaply. Cached, rate-limit-aware, built lazily.
- **Auto-attach files** — mention a file (or its closest fuzzy match) and it's added to context.
- **Inline diff cards** — when Aider edits a file, accept (`Keep`), `Undo`, or open the full diff, right in the chat.
- **`@file` autocomplete**, **context-files strip**, **working/elapsed indicator with Stop**, and a **debug toggle** for Aider's model warnings.

## ✅ Verified

End-to-end on both paths: **cloud** (OpenRouter → model) and **local** (Docker → Aider → host Ollama → model). Builds a clean `.vsix`; unit + smoke tests pass.

## Requirements

- **Docker Desktop** (recommended, default) **or** a local Aider (`pip install aider-chat`).
- An **API key** for a provider — or **Ollama** for local, no key needed.

## Quick start

1. Open the **Aider Studio** view in the Activity Bar.
2. Pick a provider (or **＋ Add custom provider**), paste your key.
3. Ask away — reference a file to auto-attach it; edits show as inline accept/undo diffs.

Good free, global model: **OpenRouter** → `openrouter/qwen/qwen3-coder:free` (free models change — see [openrouter.ai/models?max_price=0](https://openrouter.ai/models?max_price=0)).

## Known limitations (honest)

- **Answer quality is the model's job.** Aider Studio is the harness; a weak model gives weak results. Use a capable model for a Claude Code-like experience.
- **Free API tiers rate-limit** (Groq, Gemini, OpenRouter free) — that's the nature of free shared pools. A few dollars of credit (e.g. DeepSeek V3 on OpenRouter) removes that.
- **Local on a small GPU is slow.** A 7–8B model on ~4 GB VRAM works but spills to CPU (minutes per turn); smaller models are faster but weaker.
- Output is parsed from Aider's terminal UI, so a future Aider release could need a parser update (the Docker image pins Aider for stability).

## Install

- **From the Marketplace:** search "Aider Studio" (once published).
- **From the `.vsix`:** Extensions panel → `…` → *Install from VSIX…*, or `code --install-extension aider-studio-0.1.0.vsix`.

## Privacy

Your prompts and file contents/summaries are sent to the provider you configure. Aider auto-commits its edits (toggle with `aiderStudio.autoCommit`; revert with `↩ Undo`). It writes `REPO_MAP.md` + `.aider/` to your workspace and auto-adds them to `.gitignore`.

## Credits

Built on [Aider](https://aider.chat) by Paul Gauthier (Apache-2.0), installed separately. Aider Studio is MIT licensed.
