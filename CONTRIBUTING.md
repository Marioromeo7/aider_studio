# Contributing to Aider Studio

Thanks for your interest! Aider Studio is a VS Code extension that wraps
[Aider](https://aider.chat) in a Claude Code-style chat sidebar.

## Prerequisites

- **Node.js** 18+ (20 recommended)
- **VS Code** 1.85+
- **Docker Desktop** *or* a local Aider (`pip install aider-chat`) to actually run it

## Setup

```bash
git clone https://github.com/Marioromeo7/aider_studio.git
cd aider_studio
npm install
npm run compile
```

Then open the folder in VS Code and press **F5** — this launches an Extension
Development Host with Aider Studio loaded. Open the Aider Studio view in the
Activity Bar, add a provider, and try it.

## Project layout

| Path | What it is |
|------|-----------|
| `src/extension.ts` | Activation, command registration, wiring |
| `src/utils/aiderProcess.ts` | Spawns/manages Aider (Docker or native), parses its output |
| `src/utils/repoMap.ts` | Builds `REPO_MAP.md`, file digests, fuzzy file resolution |
| `src/utils/diff.ts` / `diffManager.ts` | Line diff + inline diff cards |
| `src/providers/registry.ts` | Config-driven provider registry |
| `src/providers/llm.ts` | Direct provider calls (for summaries) |
| `src/panels/chatPanel.ts` | Webview host (HTML/CSS + message routing) |
| `media/chat.js` | Webview UI (vanilla JS — no build step) |
| `test/` | `node:test` unit + smoke tests |

## Build & test

```bash
npm run compile     # tsc → out/
npm test            # compile + node:test (unit + smoke)
node --check media/chat.js   # quick webview syntax check
npx @vscode/vsce package --allow-missing-repository   # build a .vsix
```

CI (`.github/workflows/ci.yml`) runs compile → test → package on every push/PR.

## Adding a provider

No code needed — providers are config. Add an entry to `aiderStudio.providers`
(or use the **＋ Add custom provider** UI). The `aiderModel` is any
Aider/LiteLLM model id; `apiKeyEnv` is the env var that model expects. Local
Ollama models (`ollama*`) need no key.

## Conventions

- **Match the surrounding style** — small, focused functions; comments explain
  *why*, not *what*.
- **The webview output is scraped from Aider's TUI.** If you change parsing,
  update the noise scrubber (`scrubAiderOutput`) and the webview filters together.
- **Paths sent to Aider must be workspace-relative POSIX** (`toAiderPath`) so they
  resolve in both native and Docker (`/workspace`) modes.
- Keep `media/chat.js` dependency-free (it loads directly in the webview).
- Add/adjust a test under `test/` when you touch pure logic (e.g. `diff.ts`).

## Pull requests

1. Branch from `main`.
2. `npm test` must pass and `npx @vscode/vsce package` must succeed.
3. Describe the change and how you verified it. Screenshots help for UI changes.

## License

By contributing you agree your contributions are licensed under the MIT License.
