# Publishing Aider Studio — checklist

Two phases, in order: **(1) prove it works, then (2) create the account & publish.**
Everything here is **free**.

---

## ✅ Already done
- [x] Code on GitHub: https://github.com/Marioromeo7/aider_studio (public)
- [x] Packaging metadata (license, icon, README, changelog, `.vscodeignore`)
- [x] Tests + builds a valid `.vsix` (`npm test`, `npx @vscode/vsce package`)

---

## Phase 1 — Verify it actually works (do this first)

Don't publish something you've never seen answer a question.

- [ ] **Get a capable model key.** Free + global: **OpenRouter** → https://openrouter.ai/keys
- [ ] Run the extension (open the project in VS Code, press **F5**).
- [ ] In the Extension Development Host window, open the **Aider Studio** sidebar → dropdown → **"＋ Add custom provider"**:
  - Name: `OpenRouter — Qwen3 Coder`
  - Model: `openrouter/qwen/qwen3-coder:free`  _(free models change; see openrouter.ai/models?max_price=0)_
  - Env var: `OPENROUTER_API_KEY` (auto-fills)
  - Key: *your OpenRouter key*
- [ ] Confirm a real end-to-end flow:
  - [ ] Ask a question → get a streamed, formatted answer (no rule-reciting).
  - [ ] "explain `<a file>`" → it auto-attaches the file (`📎 Added …`) and explains it.
  - [ ] Ask for an edit → an **inline diff card** appears with Keep / Undo.
- [ ] Fix anything that misbehaves before moving on.

> Prerequisite reminder: the extension runs Aider in **Docker** (default) — Docker Desktop must be running — or natively if you set `aiderStudio.useDocker: false` and have `pip install aider-chat`.

---

## Phase 2 — Create the publisher & publish

The Marketplace is Microsoft's, **separate from GitHub**. You need a Microsoft account.

### 2a. Create your publisher (this is your "ID")
- [ ] Go to https://marketplace.visualstudio.com/manage → sign in with a Microsoft account.
- [ ] **Create publisher** → choose an **ID** (lowercase, permanent, e.g. `marioromeo7`) + display name.
- [ ] Tell Claude the ID → it sets `"publisher"` in `package.json`, commits, pushes.
      *(Or edit `package.json` yourself: replace `"publisher": "your-publisher-id"`.)*

### 2b. Get a Personal Access Token (PAT) — this is a SECRET
- [ ] Go to https://dev.azure.com → sign in with the **same** Microsoft account (create a free org if asked).
- [ ] **User settings → Personal access tokens → New Token**:
  - Organization: **All accessible organizations** ⚠️ (single-org will fail)
  - Scopes: **Custom defined → Marketplace → Manage**
  - Copy the token (shown once). **Never commit it.**

### 2c. Publish
```bash
npx @vscode/vsce login <your-publisher-id>   # paste the PAT
npx @vscode/vsce publish                     # compiles, packages, uploads
```
- [ ] Live within minutes at:
      `https://marketplace.visualstudio.com/items?itemName=<publisher>.aider-studio`

Future updates: `npx @vscode/vsce publish patch` (auto-bumps the version).

---

## Optional / later
- [ ] **CI** — the GitHub Actions workflow (`.github/workflows/ci.yml`) isn't pushed yet (token lacked the `workflow` scope). To enable:
  ```bash
  gh auth refresh -h github.com -s workflow
  git add .github/workflows/ci.yml && git commit -m "Add CI" && git push
  ```
- [ ] **Open VSX** (for Cursor / VSCodium users): publish separately with `npx ovsx publish` (free account at https://open-vsx.org).
- [ ] Add screenshots/GIF to the README (big help on the Marketplace listing).

---

## Cost
**$0.** Marketplace, Microsoft account, Azure DevOps free tier, Open VSX — all free.
The only money anywhere is paid LLM API usage, which is the *user's* own key, not yours.
