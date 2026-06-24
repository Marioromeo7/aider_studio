import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import { ChatPanel } from './panels/chatPanel';
import { AiderProcess } from './utils/aiderProcess';
import { SessionManager } from './utils/sessionManager';
import { DiffManager } from './utils/diffManager';
import { RepoMapManager } from './utils/repoMap';
import {
  getProviders,
  getActiveProviderId,
  setActiveProvider,
  getActiveProvider,
  storeApiKey,
} from './providers/registry';

export function activate(context: vscode.ExtensionContext): void {
  const workspaceRoot =
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

  const aider = new AiderProcess(context, workspaceRoot);
  const sessions = new SessionManager(context);
  const diffManager = new DiffManager(workspaceRoot);
  const repoMap = new RepoMapManager(context, workspaceRoot, aider);

  // Build the deterministic skeleton map on activation (instant, free) so aider
  // can see every file, then backfill model summaries in the background.
  if (repoMap.isEnabled()) {
    repoMap.buildSkeleton().then(() => repoMap.generateSummaries());
  }

  // Load REPO_MAP.md into aider's context once it finishes starting (once per
  // process — 'ready' also fires after every response, so gate on the transition).
  let prevAiderStatus = 'stopped';
  aider.on('status', (status: string) => {
    if (status === 'ready' && prevAiderStatus === 'starting') {
      repoMap.loadIntoAider();
    }
    prevAiderStatus = status;
  });

  // Keep the map fresh as files are edited/saved.
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => repoMap.refreshFileSoon(doc.uri.fsPath))
  );

  // On a provider rate-limit/overload, spill loaded context to disk: unload the
  // droppable files from aider's window (the pinned repo map stays) so it can
  // re-read exactly what it needs. Nothing is lost — it's all still on disk.
  aider.on('rate-limit', () => {
    const dropped = aider.dropLoadedContext('rate limit — freeing the window');
    if (dropped > 0) repoMap.loadIntoAider(); // make sure the locator is still present
  });

  // Wire diff manager to aider file-changed events
  aider.on('output', (event) => {
    if (event.type === 'file-changed' && event.filePath) {
      // FIX: Snapshot + FileSystemWatcher-based diff instead of fragile setTimeout
      diffManager.snapshot(event.filePath);
    }
  });

  // Register the sidebar chat view
  const chatPanel = new ChatPanel(context, aider, sessions);
  // FIX: Pass diff manager reference so openDiff clicks work
  chatPanel.setDiffManager(diffManager);
  // Give the chat the repo map so "explain <file>" can build/attach its digest.
  chatPanel.setRepoMap(repoMap);
  // Render inline accept/reject diff cards when aider edits a file.
  diffManager.setOnDiff((filePath, hunks) => chatPanel.showInlineDiff(filePath, hunks));
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ChatPanel.viewType,
      chatPanel,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  // ── Commands ──

  context.subscriptions.push(
    vscode.commands.registerCommand('aider-studio.openChat', () => {
      vscode.commands.executeCommand('aider-studio.chatView.focus');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('aider-studio.sendCurrentFile', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage('No active file to add to Aider context.');
        return;
      }
      chatPanel.addFileToContext(editor.document.uri.fsPath);
      vscode.commands.executeCommand('aider-studio.chatView.focus');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('aider-studio.newSession', async () => {
      const provider = getActiveProvider();
      if (!provider) {
        vscode.window.showErrorMessage('No active provider configured.');
        return;
      }
      aider.stop();
      sessions.newSession(getActiveProviderId(), provider.label);
      diffManager.clearSnapshots();
      vscode.window.showInformationMessage('New Aider Studio session started.');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('aider-studio.switchProvider', async () => {
      const providers = getProviders();
      const activeId = getActiveProviderId();

      const items = Object.entries(providers).map(([id, p]) => ({
        label: p.label,
        description: p.freetier ? 'Free tier' : '',
        detail: id === activeId ? '<< currently active' : undefined,
        id,
      }));

      const picked = await vscode.window.showQuickPick(items, {
        title: 'Switch Aider Provider',
        placeHolder: 'Select a provider / model',
      });

      if (!picked) return;

      await setActiveProvider(picked.id);

      // Restart aider with the new provider if it was running
      if (aider.isRunning()) {
        aider.stop();
        const newProvider = providers[picked.id];
        const started = await aider.start(newProvider);
        if (!started) {
          vscode.window.showErrorMessage(`Failed to start Aider with ${newProvider.label}`);
          return;
        }
      }

      vscode.window.showInformationMessage(`Switched to ${providers[picked.id].label}`);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('aider-studio.stopAider', () => {
      aider.stop();
      vscode.window.showInformationMessage('Aider process stopped.');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('aider-studio.saveMemory', () => {
      if (!aider.isRunning()) {
        vscode.window.showWarningMessage('Aider must be running to save memory.');
        return;
      }
      aider.saveMemory();
    })
  );


  context.subscriptions.push(
    vscode.commands.registerCommand('aider-studio.resetApiKey', async () => {
      const provider = getActiveProvider();
      if (!provider) return;
      // Clear existing key
      await storeApiKey(context, provider, '');
      aider.stop();
      // Restart with forcePrompt=true so it always asks for new key
      const started = await aider.start(provider, true);
      if (started) {
        vscode.window.showInformationMessage('API key updated and Aider restarted.');
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('aider-studio.buildDockerImage', async () => {
      const extDir = context.extensionUri.fsPath;
      const composeFile = vscode.Uri.joinPath(vscode.Uri.file(extDir), 'docker-compose.yml').fsPath;
      if (!fs.existsSync(composeFile)) {
        vscode.window.showErrorMessage('docker-compose.yml not found in extension directory.');
        return;
      }
      const statusMsg = vscode.window.setStatusBarMessage('$(container) Building Aider Docker image...');
      try {
        await new Promise<string>((resolve, reject) => {
          cp.exec('docker compose build --no-cache 2>&1', { cwd: extDir }, (err, stdout) => {
            if (err) reject(stdout || err.message);
            else resolve(stdout);
          });
        });
        statusMsg.dispose();
        vscode.window.showInformationMessage(
          'Aider Docker image built (aider-studio-aider). Enable "aiderStudio.useDocker" in settings to use it.'
        );
      } catch (err: any) {
        statusMsg.dispose();
        vscode.window.showErrorMessage(
          'Docker build failed: ' + (typeof err === 'string' ? err.slice(0, 200) : err.message) + '. Make sure Docker Desktop is running.'
        );
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('aider-studio.rebuildRepoMap', async () => {
      if (!repoMap.isEnabled()) {
        vscode.window.showInformationMessage(
          'Repo map is disabled. Enable "aiderStudio.repoMap.enabled" (and open a folder) to use it.'
        );
        return;
      }
      const status = vscode.window.setStatusBarMessage('$(sync~spin) Building repo map...');
      const changed = await repoMap.buildSkeleton();
      repoMap.loadIntoAider();
      repoMap.generateSummaries();
      status.dispose();
      vscode.window.showInformationMessage(
        `Repo map rebuilt (${changed} file(s) changed). Summaries filling in...`
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('aider-studio.unloadContext', () => {
      if (!aider.isRunning()) {
        vscode.window.showInformationMessage('Aider is not running.');
        return;
      }
      const n = aider.dropLoadedContext('manual unload');
      repoMap.loadIntoAider();
      vscode.window.showInformationMessage(
        n > 0 ? `Unloaded ${n} file(s) from context.` : 'Nothing loaded to unload.'
      );
    })
  );

  // Stop aider cleanly on extension deactivate
  context.subscriptions.push(
    new vscode.Disposable(() => {
      aider.stop();
      diffManager.dispose();
      repoMap.dispose();
    })
  );
}

export function deactivate(): void {
  // Cleanup handled via disposables
}
