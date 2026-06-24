import * as vscode from 'vscode';
import * as path from 'path';
import { AiderProcess, AiderOutputEvent, AiderStatus } from '../utils/aiderProcess';
import { SessionManager } from '../utils/sessionManager';
import { RepoMapManager } from '../utils/repoMap';
import { getProviders, getActiveProviderId, getActiveProvider, setActiveProvider, storeApiKey, resolveApiKey, addCustomProvider, removeProvider } from '../providers/registry';

export class ChatPanel implements vscode.WebviewViewProvider {
  public static readonly viewType = 'aider-studio.chatView';

  private view?: vscode.WebviewView;
  private aider: AiderProcess;
  private sessions: SessionManager;
  private context: vscode.ExtensionContext;

  private lastUserMessage = '';
  private chunkingInProgress = false;
  private workspaceRoot: string | undefined;

  constructor(
    context: vscode.ExtensionContext,
    aider: AiderProcess,
    sessions: SessionManager
  ) {
    this.context = context;
    this.aider = aider;
    this.sessions = sessions;
    this.workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    this.aider.on('output', (event: AiderOutputEvent) => {
      this.handleAiderOutput(event);
    });

    this.aider.on('context-changed', (files: string[]) => {
      this.postMessage({ type: 'contextFiles', files });
    });

    this.aider.on('status', (status: AiderStatus) => {
      this.postMessage({ type: 'status', status });
      if (status === 'thinking') {
        this.postMessage({ type: 'stream-start' });
      }
      if (status === 'ready') {
        this.postMessage({ type: 'stream-end' });
      }
      if (status === 'stopped') {
        this.addedFiles.clear(); // context died with the process — allow re-adding
      }
    });
  }

  private diffManager: { snapshot(filePath: string): void; showDiff(filePath: string): Promise<void> } | null = null;

  setDiffManager(dm: { snapshot(filePath: string): void; showDiff(filePath: string): Promise<void> }): void {
    this.diffManager = dm;
  }

  private repoMap: RepoMapManager | null = null;

  setRepoMap(rm: RepoMapManager): void {
    this.repoMap = rm;
  }

  /** Render an inline accept/reject diff card in the transcript. */
  showInlineDiff(filePath: string, hunks: { t: string; s: string }[]): void {
    const file = filePath.split(/[\\/]/).pop();
    this.postMessage({ type: 'diff', file, path: filePath, hunks });
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };

    // Get sync data NOW and embed it directly into the HTML.
    // Zero postMessage needed for the initial render.
    const providers = getProviders();
    const activeId = getActiveProviderId();
    webviewView.webview.html = this.getHtml(providers, activeId);

    // After the webview renders, try to push async data (key status, session messages)
    // If this fails, the setup screen is already fully visible and usable.
    setTimeout(() => {
      this.pushAsyncState();
    }, 300);

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'send':
          await this.handleSend(msg.text);
          break;
        case 'addFile':
          this.aider.addFile(msg.path);
          break;
        case 'dropFile':
          this.aider.dropFile(msg.path);
          break;
        case 'dropContext':
          this.aider.dropContextPath(msg.rel);
          break;
        case 'undo':
          this.aider.undoLastCommit();
          break;
        case 'newSession':
          this.chunkingInProgress = false;
          this.lastUserMessage = '';
          this.aider.stop();
          const p = getActiveProvider();
          if (p) this.sessions.newSession(getActiveProviderId(), p.label);
          this.postMessage({ type: 'clearMessages' });
          this.postMessage({ type: 'system', text: 'New session started.' });
          break;
        case 'stopAider':
          this.chunkingInProgress = false;
          this.aider.stop();
          break;

        case 'saveMemory':
          this.aider.saveMemory();
          this.postMessage({ type: 'system', text: '💾 Saving memory...' });
          break;

        // Sidebar toggle for aider's model warnings (debug). Stored in global
        // state (not a VS Code setting) and read by start().
        case 'toggleModelWarnings': {
          const next = !(this.context.globalState.get<boolean>('aiderStudio.showModelWarnings') ?? false);
          await this.context.globalState.update('aiderStudio.showModelWarnings', next);
          this.postMessage({ type: 'modelWarnings', enabled: next });
          this.postMessage({
            type: 'system',
            text: next ? '🐞 Model warnings ON — restarting aider to apply.'
                       : '🐞 Model warnings OFF — restarting aider to apply.',
          });
          if (this.aider.isRunning()) {
            const p = getActiveProvider();
            this.aider.stop();
            if (p) await this.aider.start(p);
          }
          break;
        }

        case 'confirmEdit':
          this.aider.confirmEdit();
          this.postMessage({ type: 'system', text: '✓ Edit applied' });
          break;

        case 'denyEdit':
          this.aider.denyEdit();
          this.postMessage({ type: 'system', text: '✗ Edit rejected' });
          break;

        // Handle openDiff clicks from the webview (was missing)
        case 'openDiff':
          if (msg.filePath && this.diffManager) {
            this.diffManager.showDiff(msg.filePath);
          }
          break;

        case 'getSessions': {
          const allSess = this.sessions.getAllSessions();
          const activeS = this.sessions.getActive();
          this.postMessage({ type: 'sessions', sessions: allSess, activeId: activeS?.id });
          break;
        }

        case 'sessionAction': {
          if (msg.action === 'load') {
            this.sessions.setActive(msg.sessionId);
            const sess = this.sessions.getActive();
            // Clear and reload messages
            this.postMessage({ type: 'clearMessages' });
            sess?.messages.forEach((m: {role: string; content: string}) =>
              this.postMessage({ type: m.role === 'user' ? 'user' : m.role === 'assistant' ? 'assistant' : 'system', text: m.content })
            );
          } else if (msg.action === 'clear') {
            this.sessions.clearActive();
            this.postMessage({ type: 'clearMessages' });
          } else if (msg.action === 'delete') {
            this.sessions.deleteSession(msg.sessionId);
            const allSess2 = this.sessions.getAllSessions();
            const activeS2 = this.sessions.getActive();
            this.postMessage({ type: 'sessions', sessions: allSess2, activeId: activeS2?.id });
          }
          break;
        }

        // User submitted the custom-provider modal: persist it, then resolve it
        // by actually starting aider — same path as a normal run. Any failure is
        // sent back so the modal can show why it didn't resolve.
        case 'addCustomProvider': {
          try {
            const { id, provider } = await addCustomProvider(this.context, {
              label: msg.label,
              aiderModel: msg.model,
              apiKeyEnv: msg.apiKeyEnv,
              freetier: msg.freetier,
              apiKey: msg.key,
            });
            await setActiveProvider(id);
            this.postMessage({ type: 'system', text: `Added "${provider.label}" — resolving…` });
            this.aider.stop();
            const started = await this.aider.start(provider);
            const providers = getProviders();
            if (started) {
              this.sessions.newSession(id, provider.label);
              this.postMessage({
                type: 'customProviderResult', ok: true,
                providerId: id, providers, activeProviderId: id,
              });
            } else {
              this.postMessage({
                type: 'customProviderResult', ok: false,
                providerId: id, providers, activeProviderId: id,
                error: `Couldn't resolve "${provider.label}". Check the model id "${provider.aiderModel}" ` +
                       `and the key/env var (${provider.apiKeyEnv}). See the chat for aider's exact error.`,
              });
            }
          } catch (e: any) {
            this.postMessage({
              type: 'customProviderResult', ok: false,
              error: 'Failed to add provider: ' + (e?.message ?? String(e)),
            });
          }
          break;
        }

        // Remove a provider from the list (from the modal's manage section).
        case 'removeProvider': {
          const ids = Object.keys(getProviders());
          if (ids.length <= 1) {
            this.postMessage({ type: 'system', text: "Can't remove the last provider." });
            break;
          }
          const wasActive = getActiveProviderId() === msg.id;
          await removeProvider(this.context, msg.id);
          if (wasActive) {
            const remaining = Object.keys(getProviders());
            if (remaining[0]) await setActiveProvider(remaining[0]);
          }
          this.postMessage({
            type: 'providersUpdated',
            providers: getProviders(),
            activeProviderId: getActiveProviderId(),
          });
          this.postMessage({ type: 'system', text: 'Provider removed.' });
          break;
        }

        // Setup screen: user selected a provider
        case 'selectProvider':
          await setActiveProvider(msg.providerId);
          await this.pushAsyncState();
          break;

        // Setup screen: user submitted their key
        case 'saveKey': {
          const providers = getProviders();
          const provider = providers[msg.providerId];
          if (!provider) break;
          await storeApiKey(this.context, provider, msg.key.trim());
          await setActiveProvider(msg.providerId);
          // Try starting aider immediately
          this.postMessage({ type: 'transition', screen: 'chat' });
          await this.pushAsyncState();
          break;
        }

        // Chat: user wants to update key for current provider
        case 'updateKey': {
          const cur = getActiveProvider();
          if (!cur) break;
          await storeApiKey(this.context, cur, msg.key.trim());
          this.aider.stop();
          this.postMessage({ type: 'system', text: `Key updated for ${cur.label}. Send a message to restart.` });
          break;
        }

        // Chat: switch provider from dropdown
        case 'switchProvider': {
          const providers = getProviders();
          const newProvider = providers[msg.providerId];
          if (!newProvider) break;
          const hasKey = await resolveApiKey(this.context, newProvider);
          if (!hasKey) {
            // No key yet — show setup screen for this provider
            await setActiveProvider(msg.providerId);
            this.postMessage({ type: 'show-setup', providerId: msg.providerId, providers });
          } else {
            await setActiveProvider(msg.providerId);
            if (this.aider.isRunning()) {
              this.postMessage({ type: 'system', text: `Switching to ${newProvider.label}...` });
              this.aider.stop();
              const started = await this.aider.start(newProvider);
              if (!started) {
                this.postMessage({ type: 'error', text: `Failed to start Aider with ${newProvider.label}.` });
                break;
              }
            }
            this.postMessage({ type: 'system', text: `Switched to ${newProvider.label}` });
          }
          break;
        }
      }
    });
  }

  addFileToContext(filePath: string): void {
    this.aider.addFile(filePath);
    this.postMessage({ type: 'system', text: `Added: ${filePath.split(/[\\/]/).pop()}` });
  }

  private async handleSend(text: string): Promise<void> {
    if (!text.trim()) return;

    if (!this.aider.isRunning()) {
      const provider = getActiveProvider();
      if (!provider) {
        this.postMessage({ type: 'error', text: 'No provider selected.' });
        return;
      }

      const key = await resolveApiKey(this.context, provider);
      if (!key) {
        // No key — push back to setup for this provider
        const providers = getProviders();
        this.postMessage({ type: 'show-setup', providerId: getActiveProviderId(), providers });
        return;
      }

      this.postMessage({ type: 'system', text: `Starting Aider with ${provider.label}...` });
      const started = await this.aider.start(provider);
      if (!started) {
        this.postMessage({ type: 'error', text: 'Failed to start Aider. Check your key.' });
        return;
      }
      this.sessions.newSession(getActiveProviderId(), provider.label);
    }

    // If the message refers to a file, auto-/add it (closest match on a loose
    // reference) so the model isn't blind. This is free — no model call needed.
    this.maybeAttachFile(text);

    this.lastUserMessage = text;
    this.sessions.addMessage({ role: 'user', content: text });
    this.postMessage({ type: 'user', text });
    this.aider.sendMessage(text);
  }

  private addedFiles = new Set<string>();

  private maybeAttachFile(text: string): void {
    if (!this.repoMap) return;
    const match = this.repoMap.resolveClosest(text);
    if (!match) return;
    if (this.addedFiles.has(match.abs)) return; // already in context this session
    this.addedFiles.add(match.abs);
    const name = match.abs.split(/[\\/]/).pop();
    this.aider.addPath(match.abs);
    this.postMessage({
      type: 'system',
      text: match.score >= 1 ? `📎 Added ${name} to the chat.` : `📎 Added closest match: ${name}.`,
    });
  }

  private handleAiderOutput(event: AiderOutputEvent): void {
    switch (event.type) {
      case 'stdout': {
        const text = event.data.trim();
        if (text && !text.startsWith('>')) {
          // When the repo map is on, it's the source of file awareness — the old
          // reactive "parse aider's text for file requests and auto-chunk" path
          // just matched the map's own chunk-link lines and looped. Disable it.
          const repoMapOn =
            vscode.workspace.getConfiguration('aiderStudio').get<boolean>('repoMap.enabled') ?? true;
          const fileRequests = repoMapOn ? [] : this.parseFileRequests(event.data);
          if (fileRequests.length > 0 && !this.chunkingInProgress) {
            this.chunkingInProgress = true;
            const fullPaths = fileRequests.map(f =>
              path.join(this.workspaceRoot ?? '', f.replace(/\\/g, '/'))
            );
            this.postMessage({
              type: 'system',
              text: `📦 Chunking ${fileRequests.length} file(s) into .aider/chunks/ to fit token limits...`
            });
            this.aider.addFilesViaChunks(fullPaths).then(() => {
              this.chunkingInProgress = false;
              if (this.lastUserMessage) {
                this.postMessage({ type: 'system', text: '▶ All chunks loaded — sending your request now...' });
                // Give Aider 1s to settle after all /read commands before model call
                setTimeout(() => {
                  this.aider.sendMessage(this.lastUserMessage);
                  this.lastUserMessage = ''; // clear so retries don't resend
                }, 1000);
              }
            });
          } else if (fileRequests.length === 0) {
            this.sessions.addMessage({ role: 'assistant', content: event.data });
            // Stream token by token into the current assistant bubble
            this.postMessage({ type: 'stream', text: event.data });
          }
        }
        break;
      }
      case 'stderr':
        if (!event.data.includes('HF Hub') && !event.data.includes('symlinks') && !event.data.includes('prompt toolkit')) {
          this.postMessage({ type: 'error', text: event.data });
        }
        break;
      case 'confirm':
        this.postMessage({ type: 'confirm', text: event.data });
        break;
      case 'file-changed':
        this.postMessage({ type: 'file-changed', text: event.data, filePath: event.filePath });
        break;
      case 'commit':
        this.postMessage({ type: 'commit', text: event.commitMsg ?? '', sha: event.data });
        break;
      case 'status':
        this.postMessage({ type: 'system', text: event.data });
        break;
    }
  }

  /** Push async data (key status, messages) to an already-rendered webview. */
  private async pushAsyncState(): Promise<void> {
    try {
      const activeProvider = getActiveProvider();
      const session = this.sessions.getActive();
      const status = this.aider.getStatus();

      let hasKey = false;
      if (activeProvider) {
        const key = await resolveApiKey(this.context, activeProvider);
        hasKey = !!key;
      }

      const keyStatus: Record<string, boolean> = {};
      const providers = getProviders();
      for (const [id, prov] of Object.entries(providers)) {
        const k = await resolveApiKey(this.context, prov);
        keyStatus[id] = !!k;
      }

      this.postMessage({
        type: 'asyncInit',
        hasKey,
        keyStatus,
        messages: session?.messages ?? [],
        status,
      });
      // File list for @file autocomplete.
      this.postMessage({ type: 'files', files: this.repoMap?.getFileList() ?? [] });
    } catch (err: any) {
      console.error('[Aider Studio] pushAsyncState failed:', err);
    }
  }

  /**
   * Parse Aider's "please add these files" response.
   * Aider lists files it needs as relative paths, one per line.
   * Patterns:
   *   agents\blue.py
   *   Please add agents/blue.py to the chat
   */
  private parseFileRequests(text: string): string[] {
    const files: string[] = [];

    // Pattern 1: explicit "please add X to the chat"
    const explicitRegex = /please (?:add|share) ["`']?([^\s`'"]+\.[a-z]+)["`']? to the chat/gi;
    let m;
    while ((m = explicitRegex.exec(text)) !== null) {
      files.push(m[1]);
    }
    if (files.length > 0) return [...new Set(files)];

    // Pattern 2: lines that look like file paths (have extension, no spaces)
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (/^[\w\\/\.\-]+\.[a-zA-Z]{1,6}$/.test(trimmed) && !trimmed.startsWith('#')) {
        files.push(trimmed.replace(/\\/g, '/'));
      }
    }

    return [...new Set(files)];
  }

  private postMessage(msg: unknown): void {
    this.view?.webview.postMessage(msg);
  }

  private getHtml(providers: Record<string, any>, activeId: string): string {
    const scriptUri = this.view!.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'chat.js')
    );
    const modelWarnings =
      this.context.globalState.get<boolean>('aiderStudio.showModelWarnings') ?? false;
    const initJson = JSON.stringify({ providers, activeProviderId: activeId, modelWarnings });
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline' ${this.view!.webview.cspSource};">
<title>Aider Studio</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);background:var(--vscode-sideBar-background);display:flex;flex-direction:column;height:100vh;overflow:hidden}

/* ── Setup screen ── */
#setup{display:flex;flex-direction:column;height:100%;padding:16px;gap:12px}
#setup h2{font-size:13px;font-weight:600;opacity:.8}
#setup p{font-size:11px;opacity:.6;line-height:1.5}
.provider-list{display:flex;flex-direction:column;gap:6px}
.provider-card{border:1px solid var(--vscode-input-border);border-radius:6px;padding:10px 12px;cursor:pointer;transition:background .15s,border-color .15s;position:relative}
.provider-card:hover{background:var(--vscode-list-hoverBackground)}
.provider-card.selected{border-color:var(--vscode-focusBorder);background:var(--vscode-list-activeSelectionBackground)}
.provider-card .name{font-size:12px;font-weight:600}
.provider-card .meta{font-size:10px;opacity:.6;margin-top:2px}
.provider-card .badge{position:absolute;top:8px;right:10px;font-size:10px;padding:1px 6px;border-radius:8px;background:var(--vscode-testing-iconPassed);color:#fff}
.provider-card .badge.missing{background:var(--vscode-inputValidation-warningBorder)}
.key-section{display:flex;flex-direction:column;gap:6px}
.key-section label{font-size:11px;opacity:.7}
.key-input-row{display:flex;gap:6px}
#key-input{flex:1;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:4px;padding:6px 8px;font-family:monospace;font-size:11px;outline:none}
#key-input:focus{border-color:var(--vscode-focusBorder)}
#save-key-btn{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;border-radius:4px;padding:6px 14px;cursor:pointer;font-size:12px;white-space:nowrap}
#save-key-btn:hover{background:var(--vscode-button-hoverBackground)}
#save-key-btn:disabled{opacity:.5;cursor:not-allowed}
.setup-hint{font-size:10px;opacity:.5;line-height:1.5}
.setup-hint a{color:var(--vscode-textLink-foreground)}

/* ── Header ── */
#header{display:flex;align-items:center;justify-content:space-between;padding:6px 10px;border-bottom:1px solid var(--vscode-sideBarSectionHeader-border);background:var(--vscode-sideBarSectionHeader-background);flex-shrink:0}
#provider-select{background:var(--vscode-dropdown-background);color:var(--vscode-dropdown-foreground);border:1px solid var(--vscode-dropdown-border);border-radius:3px;padding:2px 6px;font-size:11px;cursor:pointer;max-width:160px}
#header-actions{display:flex;gap:4px}
.icon-btn{background:none;border:none;color:var(--vscode-foreground);cursor:pointer;padding:3px 5px;border-radius:3px;font-size:13px;opacity:.7;transition:opacity .15s}
.icon-btn:hover{opacity:1;background:var(--vscode-toolbar-hoverBackground)}
.icon-btn.active{opacity:1;color:var(--vscode-testing-iconPassed)}

/* ── Status bar ── */
#status-bar{padding:3px 10px;font-size:11px;color:var(--vscode-descriptionForeground);background:var(--vscode-editor-background);border-bottom:1px solid var(--vscode-sideBarSectionHeader-border);flex-shrink:0}
#status-bar.thinking{color:var(--vscode-progressBar-background)}
#status-bar.error{color:var(--vscode-errorForeground)}
#status-bar.ready{color:var(--vscode-testing-iconPassed)}

/* ── Context pills ── */
#context-files{padding:4px 10px;display:flex;flex-wrap:wrap;gap:4px;border-bottom:1px solid var(--vscode-sideBarSectionHeader-border);flex-shrink:0}
#context-files:empty{display:none}
.file-pill{display:flex;align-items:center;gap:4px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);border-radius:10px;padding:1px 8px;font-size:11px}
.file-pill button{background:none;border:none;color:inherit;cursor:pointer;padding:0;font-size:12px;opacity:.7}
.file-pill button:hover{opacity:1}

/* ── Messages ── */
/* Flat transcript — no bubbles. User input is a subtle prompt line; the
   assistant streams as plain flowing text, like Claude Code. */
#messages{flex:1;overflow-y:auto;padding:12px 14px 24px;display:flex;flex-direction:column;gap:14px;font-size:13px;line-height:1.6}
.msg{display:block;max-width:100%}
.msg-role{display:none}
.msg-body{white-space:pre-wrap;word-break:break-word;color:var(--vscode-foreground)}
/* User input keeps a bubble; aider streams flat into the transcript. */
.msg.user{display:flex;justify-content:flex-end}
.msg.user .msg-body{background:var(--vscode-input-background);border:1px solid var(--vscode-input-border);border-radius:10px;padding:7px 11px;max-width:85%}
.msg.assistant .msg-body{color:var(--vscode-foreground)}
.msg.system .msg-body{color:var(--vscode-descriptionForeground);font-size:11px;font-style:italic;opacity:.85}
.msg.error .msg-body{color:var(--vscode-errorForeground);font-size:12px}
.msg.commit .msg-body{color:var(--vscode-gitDecoration-addedResourceForeground);font-size:11px}
.msg.file-changed .msg-body{color:var(--vscode-gitDecoration-modifiedResourceForeground);font-size:11px;cursor:pointer;text-decoration:underline dotted}
.msg.assistant.streaming .msg-body::after{content:'▋';animation:blink .7s step-end infinite;opacity:.7}
@keyframes blink{50%{opacity:0}}
/* inline diff card */
.msg.diff-card{border:1px solid var(--vscode-input-border);border-radius:8px;overflow:hidden}
.diff-head{display:flex;justify-content:space-between;align-items:center;padding:6px 10px;background:var(--vscode-editor-background);font-size:11px}
.diff-file{font-weight:600}
.diff-stat .d-addc{color:var(--vscode-gitDecoration-addedResourceForeground)}
.diff-stat .d-delc{color:var(--vscode-gitDecoration-deletedResourceForeground)}
.diff-body{max-height:240px;overflow:auto;font-family:var(--vscode-editor-font-family);font-size:11px;white-space:pre;line-height:1.45}
.diff-body>div{padding:0 10px}
.d-add{background:rgba(46,160,67,.16)}
.d-del{background:rgba(248,81,73,.16)}
.d-ctx{opacity:.55}
.diff-actions{display:flex;gap:6px;padding:6px 10px;background:var(--vscode-editor-background)}
.diff-actions button{font-size:11px;padding:3px 10px;border:1px solid var(--vscode-input-border);background:none;color:var(--vscode-foreground);border-radius:4px;cursor:pointer}
.diff-actions .diff-keep{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none}
.diff-actions button:hover{background:var(--vscode-toolbar-hoverBackground)}
.msg-body code{font-family:var(--vscode-editor-font-family);font-size:11px;background:var(--vscode-textCodeBlock-background);padding:1px 4px;border-radius:3px}
.msg-body pre{background:var(--vscode-textCodeBlock-background);padding:8px;border-radius:4px;overflow-x:auto;margin:4px 0}
.msg-body pre code{background:none;padding:0}
/* markdown */
.msg-body h1,.msg-body h2,.msg-body h3,.msg-body h4{font-weight:600;margin:10px 0 4px;line-height:1.3}
.msg-body h1{font-size:16px}.msg-body h2{font-size:14px}.msg-body h3{font-size:13px}.msg-body h4{font-size:12px;opacity:.85}
.msg-body p{margin:5px 0}
.msg-body ul,.msg-body ol{margin:5px 0;padding-left:20px}
.msg-body li{margin:2px 0}
.msg-body hr{border:none;border-top:1px solid var(--vscode-input-border);margin:8px 0}
.msg-body a{color:var(--vscode-textLink-foreground);text-decoration:none}
.msg-body a:hover{text-decoration:underline}
.msg-body .codeblock{position:relative;margin:6px 0}
.msg-body .codeblock pre{margin:0}
.msg-body .copy-btn{position:absolute;top:5px;right:5px;font-size:10px;padding:1px 7px;background:var(--vscode-button-secondaryBackground,var(--vscode-button-background));color:var(--vscode-button-secondaryForeground,var(--vscode-button-foreground));border:none;border-radius:3px;cursor:pointer;opacity:0;transition:opacity .15s}
.msg-body .codeblock:hover .copy-btn{opacity:.85}
.msg-body .copy-btn:hover{opacity:1}
#empty-state{display:flex;flex-direction:column;align-items:center;justify-content:center;flex:1;gap:8px;opacity:.5;font-size:12px;text-align:center;padding:20px}
#empty-state .big{font-size:32px}
.session-card{padding:8px 10px;border:1px solid var(--vscode-input-border);border-radius:5px;margin-bottom:6px;cursor:pointer;transition:background .15s}
.session-card:hover{background:var(--vscode-list-hoverBackground)}
.session-card.active{border-color:var(--vscode-focusBorder);background:var(--vscode-list-activeSelectionBackground)}
.session-card .sc-title{font-size:12px;font-weight:600}
.session-card .sc-meta{font-size:10px;opacity:.6;margin-top:2px}
.session-card .sc-actions{display:flex;gap:4px;margin-top:6px}
.session-card .sc-actions button{background:none;border:1px solid var(--vscode-input-border);color:var(--vscode-foreground);border-radius:3px;padding:1px 6px;font-size:10px;cursor:pointer}
.session-card .sc-actions button:hover{background:var(--vscode-toolbar-hoverBackground)}

/* ── Input ── */
#input-area{position:relative;padding:8px 10px;border-top:1px solid var(--vscode-sideBarSectionHeader-border);display:flex;flex-direction:column;gap:6px;flex-shrink:0}
#at-complete{display:none;position:absolute;left:10px;right:10px;bottom:100%;max-height:180px;overflow-y:auto;background:var(--vscode-dropdown-background);border:1px solid var(--vscode-dropdown-border);border-radius:6px;margin-bottom:4px;z-index:20;box-shadow:0 2px 10px rgba(0,0,0,.35)}
.ac-item{padding:5px 10px;font-size:11px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:var(--vscode-editor-font-family)}
.ac-item.active{background:var(--vscode-list-activeSelectionBackground)}
#input-row{display:flex;gap:6px;align-items:flex-end}
#msg-input{flex:1;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:4px;padding:6px 8px;font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);resize:none;min-height:36px;max-height:120px;outline:none}
#msg-input:focus{border-color:var(--vscode-focusBorder)}
#send-btn{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;border-radius:4px;padding:6px 12px;cursor:pointer;font-size:13px;flex-shrink:0}
#send-btn:hover{background:var(--vscode-button-hoverBackground)}
#send-btn:disabled{opacity:.5;cursor:not-allowed}
#input-hints{display:flex;gap:6px;flex-wrap:wrap}
.hint-btn{background:none;border:1px solid var(--vscode-input-border);color:var(--vscode-descriptionForeground);border-radius:3px;padding:1px 7px;font-size:11px;cursor:pointer}
.hint-btn:hover{background:var(--vscode-toolbar-hoverBackground);color:var(--vscode-foreground)}

/* ── Key update bar (inline in chat) ── */
#key-bar{display:none;padding:6px 10px;gap:6px;align-items:center;border-bottom:1px solid var(--vscode-sideBarSectionHeader-border);background:var(--vscode-inputValidation-warningBackground);flex-shrink:0}
#key-bar.visible{display:flex}
#key-bar span{font-size:11px;flex:1;opacity:.8}
#key-bar input{background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:3px;padding:3px 6px;font-size:11px;font-family:monospace;width:140px;outline:none}
#key-bar button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;border-radius:3px;padding:3px 8px;cursor:pointer;font-size:11px}

/* ── Custom provider modal (full-page overlay) ── */
#custom-modal{position:fixed;inset:0;background:var(--vscode-sideBar-background);display:none;flex-direction:column;z-index:50;overflow-y:auto}
#custom-modal-inner{display:flex;flex-direction:column;gap:8px;padding:18px;max-width:520px;width:100%;margin:0 auto}
#custom-modal h2{font-size:14px;font-weight:600}
#custom-modal p{font-size:11px;opacity:.65;line-height:1.5;margin-bottom:4px}
#custom-modal label{font-size:11px;opacity:.8;margin-top:6px}
#custom-modal label .cp-hint{opacity:.5;font-weight:400;margin-left:4px}
#custom-modal input[type=text],#custom-modal input[type=password]{background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:4px;padding:7px 9px;font-size:12px;font-family:var(--vscode-font-family);outline:none}
#custom-modal input:focus{border-color:var(--vscode-focusBorder)}
#custom-modal .cp-examples{font-size:10px;opacity:.55;line-height:1.6}
#custom-modal .cp-examples code{background:var(--vscode-textCodeBlock-background);padding:1px 4px;border-radius:3px}
#custom-modal .cp-check{display:flex;align-items:center;gap:6px;flex-direction:row;font-size:11px;opacity:.85}
#custom-modal .cp-check input{margin:0}
#cp-error{color:var(--vscode-errorForeground);font-size:11px;min-height:14px;line-height:1.4}
#cp-error:not(:empty){background:var(--vscode-inputValidation-errorBackground);border:1px solid var(--vscode-inputValidation-errorBorder);border-radius:4px;padding:6px 8px;margin-top:4px}
.cp-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:10px}
.cp-btn-primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;border-radius:4px;padding:7px 16px;cursor:pointer;font-size:12px}
.cp-btn-primary:hover{background:var(--vscode-button-hoverBackground)}
.cp-btn-primary:disabled{opacity:.5;cursor:not-allowed}
.cp-btn-secondary{background:none;border:1px solid var(--vscode-input-border);color:var(--vscode-foreground);border-radius:4px;padding:7px 16px;cursor:pointer;font-size:12px}
.cp-tabs{display:flex;gap:0;margin:4px 0 2px;border:1px solid var(--vscode-input-border);border-radius:6px;overflow:hidden}
.cp-tab{flex:1;background:none;border:none;color:var(--vscode-foreground);padding:7px 10px;font-size:12px;cursor:pointer;opacity:.7}
.cp-tab.active{background:var(--vscode-button-background);color:var(--vscode-button-foreground);opacity:1}
#cp-local-note{font-size:11px;line-height:1.5;background:var(--vscode-textBlockQuote-background,var(--vscode-editor-background));border-left:2px solid var(--vscode-focusBorder);padding:8px 10px;border-radius:4px;opacity:.9}
#cp-manage{margin-top:18px;border-top:1px solid var(--vscode-input-border);padding-top:12px}
.cp-manage-title{font-size:11px;font-weight:600;opacity:.7;margin-bottom:6px}
.cp-list-item{display:flex;align-items:center;justify-content:space-between;padding:5px 8px;border:1px solid var(--vscode-input-border);border-radius:5px;margin-bottom:5px;font-size:11px}
.cp-list-item span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cp-list-item .cp-active-dot{color:var(--vscode-testing-iconPassed);font-weight:700;margin-left:6px}
.cp-list-item button{background:none;border:none;color:var(--vscode-errorForeground);cursor:pointer;font-size:13px;padding:2px 6px;border-radius:3px;flex-shrink:0}
.cp-list-item button:hover:not(:disabled){background:var(--vscode-toolbar-hoverBackground)}
.cp-list-item button:disabled{opacity:.3;cursor:not-allowed}
</style>
</head>
<body>

<!-- SETUP SCREEN — visible by default, NO JS needed to show it -->
<div id="setup">
  <h2>⚡ Aider Studio Setup</h2>
  <p>Choose your provider and paste your API key. You only do this once per provider.</p>
  <div class="provider-list" id="provider-list"></div>
  <div class="key-section" id="key-section" style="display:none">
    <label id="key-label">API Key</label>
    <div class="key-input-row">
      <input type="password" id="key-input" placeholder="Paste your API key..." autocomplete="off" spellcheck="false">
      <button id="save-key-btn">Connect</button>
    </div>
    <div class="setup-hint" id="setup-hint"></div>
  </div>
</div>

<!-- CHAT SCREEN -->
<div id="chat" style="display:none;flex-direction:column;height:100%">
  <div id="header">
    <select id="provider-select" title="Switch provider"></select>
    <div id="header-actions">
      <button class="icon-btn" id="btn-key" title="Update API key for current provider">🔑</button>
      <button class="icon-btn" id="btn-memory" title="Save memory to MEMORY.md">💾</button>
      <button class="icon-btn" id="btn-sessions" title="Sessions">🗂</button>
      <button class="icon-btn" id="btn-new" title="New session">⊕</button>
      <button class="icon-btn" id="btn-undo" title="Undo last commit">↩</button>
      <button class="icon-btn" id="btn-warnings" title="Debug: show aider model warnings (restarts aider)">🐞</button>
      <button class="icon-btn" id="btn-stop" title="Stop Aider">■</button>
    </div>
  </div>

  <!-- SESSIONS PANEL (slide in over messages) -->
  <div id="sessions-panel" style="display:none;flex-direction:column;flex:1;overflow:hidden">
    <div style="padding:8px 10px;font-size:11px;font-weight:600;opacity:.7;border-bottom:1px solid var(--vscode-sideBarSectionHeader-border);display:flex;justify-content:space-between;align-items:center">
      <span>Sessions</span>
      <button class="icon-btn" id="btn-close-sessions" style="font-size:11px">✕ Close</button>
    </div>
    <div id="sessions-list" style="flex:1;overflow-y:auto;padding:8px"></div>
  </div>

  <div id="key-bar">
    <span id="key-bar-label">Update key:</span>
    <input type="password" id="key-bar-input" placeholder="New API key..." spellcheck="false">
    <button id="key-bar-save">Save</button>
    <button id="key-bar-cancel" style="background:none;border:1px solid var(--vscode-input-border);color:var(--vscode-foreground)">✕</button>
  </div>

  <div id="status-bar">⬤ Stopped</div>
  <div id="context-files"></div>

  <div id="messages">
    <div id="empty-state">
      <div class="big">⚡</div>
      <div>Aider Studio</div>
      <div style="font-size:11px">Send a message to start Aider.</div>
    </div>
  </div>

  <div id="input-area">
    <div id="at-complete"></div>
    <div id="input-row">
      <textarea id="msg-input" placeholder="Ask Aider to edit your code..." rows="1"></textarea>
      <button id="send-btn">Send</button>
    </div>
    <div id="input-hints">
      <button class="hint-btn" data-insert="/run ">⚡ /run</button>
      <button class="hint-btn" data-insert="Write tests for ">🧪 tests</button>
      <button class="hint-btn" data-insert="Fix the bug: ">🐛 fix</button>
      <button class="hint-btn" data-insert="Refactor ">♻️ refactor</button>
      <button class="hint-btn" data-insert="Explain this code: ">🔍 explain</button>
    </div>
  </div>
</div>

<!-- CUSTOM PROVIDER MODAL — full-page overlay over setup or chat -->
<div id="custom-modal">
  <div id="custom-modal-inner">
    <h2>➕ Add Provider / Model</h2>
    <p>Use any model aider/LiteLLM supports. Cloud needs an API key; Local runs on your machine via Ollama (no key, no rate limits).</p>

    <div class="cp-tabs">
      <button id="cp-mode-cloud" class="cp-tab active" type="button">☁ Cloud API</button>
      <button id="cp-mode-local" class="cp-tab" type="button">💻 Local (Ollama)</button>
    </div>

    <label>Display name</label>
    <input type="text" id="cp-label" placeholder="e.g. OpenRouter — Claude Haiku" autocomplete="off" spellcheck="false">

    <label>Model id <span class="cp-hint" id="cp-model-hint">aider/LiteLLM format</span></label>
    <input type="text" id="cp-model" placeholder="e.g. openrouter/anthropic/claude-3.5-haiku" autocomplete="off" spellcheck="false">
    <div class="cp-examples" id="cp-examples-cloud">Examples: <code>openrouter/...</code> · <code>deepseek/deepseek-chat</code> · <code>mistral/codestral-latest</code> · <code>openai/gpt-4o-mini</code></div>
    <div class="cp-examples" id="cp-examples-local" style="display:none">Examples: <code>qwen2.5-coder:3b</code> · <code>llama3.2</code> · <code>qwen3:8b</code> &nbsp;·&nbsp; run <code>ollama pull &lt;model&gt;</code> first, with Ollama running.</div>

    <div id="cp-cloud-fields">
      <label>API key env var <span class="cp-hint">auto-filled from the model id</span></label>
      <input type="text" id="cp-env" placeholder="e.g. OPENROUTER_API_KEY" autocomplete="off" spellcheck="false">

      <label>API key</label>
      <input type="password" id="cp-key" placeholder="Paste the key for this provider" autocomplete="off" spellcheck="false">

      <label class="cp-check"><input type="checkbox" id="cp-free"> Free tier</label>
    </div>

    <div id="cp-local-note" style="display:none">💻 No API key needed — runs locally via Ollama (the extension connects to it automatically). Make sure Ollama is running and you've pulled the model.</div>

    <div id="cp-error"></div>

    <div class="cp-actions">
      <button id="cp-cancel" class="cp-btn-secondary" type="button">Cancel</button>
      <button id="cp-save" class="cp-btn-primary" type="button">Add &amp; Connect</button>
    </div>

    <div id="cp-manage">
      <div class="cp-manage-title">Your providers</div>
      <div id="cp-list"></div>
    </div>
  </div>
</div>

<script>window.__INIT__ = ${initJson};</script>
<script src="${scriptUri}"></script>
</body>
</html>`;
  }
}