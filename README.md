# Aider Studio

A **Claude Code-style chat sidebar for VS Code**, powered by [Aider](https://aider.chat) and **your own LLM provider**. Bring your own key — Aider Studio is the experience layer; you choose the model.

> **Heads-up:** This extension orchestrates Aider, which runs either in **Docker** (default, recommended) or natively. You need **one** of those installed — see Requirements. It also sends file summaries to whichever LLM provider you configure.

## Screenshots

<!--
  Marketplace note: README images MUST be absolute HTTPS URLs to render on the
  Marketplace listing (relative paths do not work there). Drop your PNGs/GIFs
  into media/screenshots/ with these names and the links below will work.
-->

| Chat & streamed answers | Inline diff (accept / undo) |
|---|---|
| ![Chat](https://raw.githubusercontent.com/Marioromeo7/aider_studio/main/media/screenshots/chat.png) | ![Inline diff](https://raw.githubusercontent.com/Marioromeo7/aider_studio/main/media/screenshots/diff.png) |

![Add a provider](https://raw.githubusercontent.com/Marioromeo7/aider_studio/main/media/screenshots/provider.png)

> _Replace the placeholders above by adding `chat.png`, `diff.png`, and `provider.png` (a short `.gif` works too) to `media/screenshots/`. A 10–15s demo GIF at the top dramatically improves the listing._

## Requirements

You need **either**:

- **Docker Desktop** (recommended) — Aider runs in a container, nothing else to install. On first use, build the image once: `docker compose build` (or run the *"Aider Studio: Build Docker Image"* command), or it falls back to pulling/using the default image. Enabled by default (`aiderStudio.useDocker`).
- **or** a local Aider: `pip install aider-chat`, with `aider` on your PATH. Set `aiderStudio.useDocker` to `false`.

And an **API key** for at least one provider (see below).

## Getting a key (bring your own model)

Aider Studio works with any Aider/LiteLLM model. The quality of answers is the **model's** job — pick a capable one. Good free, globally-available options:

- **OpenRouter** — [openrouter.ai/keys](https://openrouter.ai/keys). Works everywhere; strong free models (e.g. Qwen3 Coder). Preconfigured as a provider. Free models come and go — see the current list at [openrouter.ai/models?max_price=0](https://openrouter.ai/models?max_price=0).
- **Gemini** — [aistudio.google.com](https://aistudio.google.com). Generous token limits **where the free tier is available** (regional restrictions apply).
- **Groq** — [console.groq.com](https://console.groq.com). Very fast, but small daily/per-minute limits and weaker models.

> The default models are free tiers with real limits. For a Claude Code-like experience, use a capable model (DeepSeek V3, GPT-4-class, Claude via your own key).

## Usage

1. Open the **Aider Studio** view in the Activity Bar.
2. Pick a provider, paste your key (stored in VS Code secret storage — never in plaintext).
3. Ask away. Reference a file by name and it's auto-added to context; when Aider edits a file you get an inline **accept / undo** diff.

| Action | Shortcut |
|--------|----------|
| Open chat | `Ctrl+Shift+A` |
| Add current file to context | `Ctrl+Shift+F` |
| Switch / add provider | dropdown in the chat header |

## Features

- Flat, streamed transcript with live **markdown** (code blocks + copy)
- **Repo map** (`REPO_MAP.md`) so the model is aware of every file, cheaply
- **`@file` autocomplete**, **context-files strip**, **inline diff** accept/undo
- **Run in Docker** with automatic fallback; **rate-limit aware**
- Add any provider/model from the UI — no code changes

## Adding a custom provider

Use the **"＋ Add custom provider"** entry in the dropdown, or add to `settings.json`:

```json
"aiderStudio.providers": {
  "openrouter-claude": {
    "label": "OpenRouter — Claude Haiku",
    "aiderModel": "openrouter/anthropic/claude-3.5-haiku",
    "apiKeyEnv": "OPENROUTER_API_KEY",
    "apiKeySettingKey": "aiderStudio.openrouterApiKey",
    "freetier": false
  }
}
```

## Privacy & what it does in your repo

- Your prompts and **file contents/summaries are sent to the LLM provider you configure**.
- Aider is git-native: Aider Studio ensures a git repo exists (`git init` if needed) and Aider **auto-commits** its edits (toggle with `aiderStudio.autoCommit`). Use `↩ Undo` / `/undo` to revert.
- It writes `REPO_MAP.md` and a `.aider/` folder to your workspace and **auto-adds them to `.gitignore`**.
- Keys are stored in VS Code secret storage.

## Configuration

`aiderStudio.useDocker`, `aiderStudio.dockerImage`, `aiderStudio.aiderPath`, `aiderStudio.autoCommit`, `aiderStudio.showDiffOnChange`, `aiderStudio.repoMap.enabled`, `aiderStudio.repoMap.summaries`, `aiderStudio.repoMap.summaryBudget`.

## Credits & license

Built on [Aider](https://aider.chat) by Paul Gauthier (Apache-2.0), installed separately. Aider Studio itself is MIT licensed.
