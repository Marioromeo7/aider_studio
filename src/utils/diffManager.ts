import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { computeLineDiff } from './diff';

export class DiffManager {
  private fileSnapshots = new Map<string, string>();
  private watchers = new Map<string, vscode.FileSystemWatcher>();
  private pendingSnapshotPaths = new Set<string>();
  private workspaceRoot: string;
  private contentProviderDisposable: vscode.Disposable | null = null;
  private static contentProvider: BeforeContentProvider | null = null;

  private onDiffCb: ((filePath: string, hunks: { t: string; s: string }[]) => void) | null = null;

  /** Register a callback that receives an inline line-diff when a file settles. */
  setOnDiff(cb: (filePath: string, hunks: { t: string; s: string }[]) => void): void {
    this.onDiffCb = cb;
  }

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
    // Register a single shared content provider for all diffs
    if (!DiffManager.contentProvider) {
      DiffManager.contentProvider = new BeforeContentProvider();
      this.contentProviderDisposable = vscode.workspace.registerTextDocumentContentProvider(
        'aider-studio-before',
        DiffManager.contentProvider
      );
    }
  }

  /**
   * Take a snapshot of a file before Aider touches it.
   * Called when Aider reports it's about to edit a file.
   * Uses async file read to avoid blocking the extension host.
   */
  async snapshot(filePath: string): Promise<void> {
    try {
      const content = await fs.promises.readFile(filePath, 'utf8');
      this.fileSnapshots.set(filePath, content);
    } catch {
      // File may not exist yet (new file creation)
      this.fileSnapshots.set(filePath, '');
    }

    // FIX: Use FileSystemWatcher to detect when Aider finishes writing the file,
    // instead of the fragile 800ms setTimeout heuristic.
    this.watchForChanges(filePath);
  }

  /**
   * Watch for file changes and show diff when the file settles.
   * Debounces rapid writes and only triggers after the file stops changing.
   */
  private watchForChanges(filePath: string): void {
    // Clean up any existing watcher for this file
    this.removeWatcher(filePath);

    this.pendingSnapshotPaths.add(filePath);

    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(
        vscode.Uri.file(path.dirname(filePath)),
        path.basename(filePath)
      )
    );

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const triggerDiff = () => {
      debounceTimer = null;
      // Only show diff if we have a snapshot and the file was pending
      if (this.pendingSnapshotPaths.has(filePath) && this.fileSnapshots.has(filePath)) {
        this.pendingSnapshotPaths.delete(filePath);
        this.showDiff(filePath);
        // Clean up watcher after showing diff
        this.removeWatcher(filePath);
      }
    };

    watcher.onDidChange(() => {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      // Wait 500ms after the last change before showing diff
      debounceTimer = setTimeout(triggerDiff, 500);
    });

    watcher.onDidCreate(() => {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      debounceTimer = setTimeout(triggerDiff, 500);
    });

    this.watchers.set(filePath, watcher);

    // Safety timeout: if no change detected after 5s, show diff anyway
    // (in case the file was already written before watcher was set up)
    setTimeout(() => {
      if (this.pendingSnapshotPaths.has(filePath)) {
        this.pendingSnapshotPaths.delete(filePath);
        this.emitInlineDiff(filePath);
        this.removeWatcher(filePath);
      }
    }, 5000);
  }

  private removeWatcher(filePath: string): void {
    const existing = this.watchers.get(filePath);
    if (existing) {
      existing.dispose();
      this.watchers.delete(filePath);
    }
  }

  /**
   * Compute a compact line diff (before snapshot → current file) and hand it to
   * the inline-diff callback so the chat can render an accept/reject card.
   */
  private emitInlineDiff(filePath: string): void {
    if (!this.onDiffCb) return;
    const before = this.fileSnapshots.get(filePath);
    if (before === undefined) return;
    let after = '';
    try { after = fs.readFileSync(filePath, 'utf8'); } catch { /* deleted */ }
    if (before === after) return;
    this.onDiffCb(filePath, computeLineDiff(before, after));
  }

  /**
   * Show a diff between the snapshot and current file content.
   */
  async showDiff(filePath: string): Promise<void> {
    const config = vscode.workspace.getConfiguration('aiderStudio');
    if (!config.get<boolean>('showDiffOnChange')) return;

    const before = this.fileSnapshots.get(filePath);
    if (before === undefined) return;

    const afterUri = vscode.Uri.file(filePath);

    // Use the shared content provider — set content for this file
    if (DiffManager.contentProvider) {
      DiffManager.contentProvider.setContent(filePath, before);
    }

    const beforeUri = vscode.Uri.parse(
      `aider-studio-before:${encodeURIComponent(filePath)}`
    );

    const fileName = filePath.split(/[\\/]/).pop() ?? filePath;

    await vscode.commands.executeCommand(
      'vscode.diff',
      beforeUri,
      afterUri,
      `Aider: ${fileName} (before -> after)`,
      { preview: true }
    );
  }

  clearSnapshots(): void {
    this.fileSnapshots.clear();
    this.pendingSnapshotPaths.clear();
    for (const [_, watcher] of this.watchers) {
      watcher.dispose();
    }
    this.watchers.clear();
  }

  dispose(): void {
    this.clearSnapshots();
    if (this.contentProviderDisposable) {
      this.contentProviderDisposable.dispose();
      this.contentProviderDisposable = null;
      DiffManager.contentProvider = null;
    }
  }
}

class BeforeContentProvider implements vscode.TextDocumentContentProvider {
  private contents = new Map<string, string>();

  setContent(filePath: string, content: string): void {
    this.contents.set(filePath, content);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    // Decode the file path from the URI
    const filePath = decodeURIComponent(uri.path);
    return this.contents.get(filePath) ?? '';
  }
}
