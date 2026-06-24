import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import { ProviderConfig, resolveApiKey } from '../providers/registry';

export type AiderStatus = 'stopped' | 'starting' | 'ready' | 'thinking' | 'error';

export interface AiderOutputEvent {
  type: 'stdout' | 'stderr' | 'status' | 'file-changed' | 'commit' | 'confirm';
  data: string;
  filePath?: string;
  commitMsg?: string;
}

export class AiderProcess extends EventEmitter {
  private process: cp.ChildProcess | null = null;
  private status: AiderStatus = 'stopped';
  private workspaceRoot: string;
  private context: vscode.ExtensionContext;
  private statusBarItem: vscode.StatusBarItem;
  private startupResolve: ((value: boolean) => void) | null = null;
  private assistantBuffer = '';
  private assistantTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly ASSISTANT_BUFFER_MS = 300;
  private _processGeneration = 0;
  // Paths currently /read into aider's context that we're allowed to /drop to free
  // the window (the repo map is loaded "pinned" and deliberately excluded).
  private loadedContext = new Set<string>();
  private _lastRateLimitAt = 0;

  constructor(context: vscode.ExtensionContext, workspaceRoot: string) {
    super();
    this.context = context;
    this.workspaceRoot = workspaceRoot;
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );
    this.statusBarItem.command = 'aider-studio.openChat';
    context.subscriptions.push(this.statusBarItem);
    this.updateStatusBar();
  }

  async start(provider: ProviderConfig, forcePrompt = false): Promise<boolean> {
    if (this.process) {
      this.stop();
    }

    // Local models (Ollama) need no API key — they run on your machine.
    const isLocal = /^ollama(_chat)?\//.test(provider.aiderModel);

    let resolvedKey = await resolveApiKey(this.context, provider);
    if (!isLocal && (!resolvedKey || forcePrompt)) {
      const entered = await vscode.window.showInputBox({
        prompt: `Enter API key for ${provider.label}`,
        password: true,
        placeHolder: 'Paste your API key here',
        ignoreFocusOut: true,
      });
      if (!entered) return false;
      const { storeApiKey } = await import('../providers/registry.js');
      await storeApiKey(this.context, provider, entered);
      resolvedKey = entered;
    }
    if (!isLocal && !resolvedKey) return false;

    const config = vscode.workspace.getConfiguration('aiderStudio');
    const aiderPath = config.get<string>('aiderPath') ?? 'aider';
    const autoCommit = config.get<boolean>('autoCommit') ?? true;
    const useDocker = config.get<boolean>('useDocker') ?? true;
    const dockerImage = config.get<string>('dockerImage') ?? 'aider-studio-aider';
    // Driven by the sidebar toggle (global-state), not a VS Code setting.
    const showModelWarnings =
      this.context.globalState.get<boolean>('aiderStudio.showModelWarnings') ?? false;

    const args = [
      '--model', provider.aiderModel,
      '--no-pretty',
      // Disable token streaming: piped into a non-TTY, aider's live markdown
      // renderer mangles inter-word spacing (e.g. "You'veprovidedtherules").
      // We buffer output for 300ms before display anyway, so nothing is lost.
      '--no-stream',
      '--yes',
      '--no-suggest-shell-commands',
      '--map-tokens', '1024',
    ];

    // Respect the user's autoCommit setting instead of hardcoding --no-auto-commits
    if (!autoCommit) {
      args.push('--no-auto-commits');
    }

    // Mute aider's "this model may not work well" warnings unless the user wants
    // them for debugging (e.g. to see why a weak model misbehaves).
    if (!showModelWarnings) {
      args.push('--no-show-model-warnings');
    }

    // FIX: Only set the provider-specific env var, never leak keys to unrelated env vars
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (resolvedKey) env[provider.apiKeyEnv] = resolvedKey;
    if (resolvedKey && provider.aiderModel.startsWith('gemini/')) {
      env['GEMINI_API_KEY'] = resolvedKey;
      env['GOOGLE_API_KEY'] = resolvedKey;
    }
    if (resolvedKey && provider.aiderModel.startsWith('groq/')) {
      env['GROQ_API_KEY'] = resolvedKey;
    }
    // Local models via Ollama — point aider at the Ollama server. A provider can
    // specify a custom URL (e.g. a remote GPU box); otherwise default to the host.
    if (isLocal) {
      let base = (provider.ollamaBaseUrl ?? '').trim();
      if (!base) {
        base = useDocker ? 'http://host.docker.internal:11434' : 'http://localhost:11434';
      } else if (useDocker && /\/\/(localhost|127\.0\.0\.1)\b/i.test(base)) {
        // A localhost URL can't reach the host from inside the container.
        base = base.replace(/(localhost|127\.0\.0\.1)/i, 'host.docker.internal');
      }
      env['OLLAMA_API_BASE'] = base;
    }

    // Build the list of env vars to pass to the aider process (or Docker container)
    const aiderEnvVars: string[] = [];
    for (const [k, v] of Object.entries(env)) {
      // Only pass API keys and essential vars — skip bloated host env
      if (v === undefined || v === '') continue;
      const lk = k.toUpperCase();
      if (lk.includes('API_KEY') || lk.includes('TOKEN') || lk === 'OLLAMA_API_BASE' ||
          lk === 'HOME' || lk === 'PATH' || lk === 'LANG' || lk === 'TERM' ||
          lk === 'http_proxy' || lk === 'https_proxy') {
        aiderEnvVars.push('-e', k + '=' + v);
      }
    }

    // In Docker, give the container a route back to the host's Ollama server.
    const dockerExtraArgs = isLocal ? ['--add-host', 'host.docker.internal:host-gateway'] : [];

    // Ensure a git repo exists before starting aider (aider requires git)
    await this.ensureGitRepo();

    // First launch attempt, honoring the configured mode.
    // Suppress the failure message on a native attempt so we can quietly fall
    // back to Docker on ENOENT instead of alarming the user.
    let result = await this.launchAider({
      mode: useDocker ? 'docker' : 'native',
      args, env, aiderEnvVars, aiderPath, dockerImage, dockerExtraArgs,
      suppressStartupError: !useDocker,
    });

    // FIX: Auto-fall back to Docker when native aider isn't installed (ENOENT),
    // so the extension still works without a local `pip install aider-chat`.
    if (!result.ok && !useDocker) {
      if (result.enoent) {
        this.emit('output', {
          type: 'status',
          data: `Aider not found on PATH — falling back to Docker mode for this session ` +
                `(image: ${dockerImage}). Set "aiderStudio.useDocker": true to make this the default.`,
        } as AiderOutputEvent);
        result = await this.launchAider({
          mode: 'docker',
          args, env, aiderEnvVars, aiderPath, dockerImage, dockerExtraArgs,
          suppressStartupError: false,
        });
      } else if (result.failureMessage) {
        // Native failed for some other reason — surface the message we held back.
        this.emit('output', { type: 'status', data: result.failureMessage } as AiderOutputEvent);
      }
    }

    if (!result.ok) {
      this.setStatus('error');
      return false;
    }
    return true;
  }

  /**
   * Spawn aider (native or in Docker) and wait until it's ready, exits, or errors.
   * Shared by start()'s initial attempt and its Docker fallback.
   *
   * When suppressStartupError is true, a spawn failure is NOT emitted to the UI —
   * the composed message is returned in failureMessage so the caller can decide
   * whether to surface it or retry (e.g. fall back to Docker on ENOENT).
   */
  private launchAider(opts: {
    mode: 'native' | 'docker';
    args: string[];
    env: NodeJS.ProcessEnv;
    aiderEnvVars: string[];
    aiderPath: string;
    dockerImage: string;
    dockerExtraArgs?: string[];
    suppressStartupError: boolean;
  }): Promise<{ ok: boolean; enoent: boolean; failureMessage?: string }> {
    const { mode, args, env, aiderEnvVars, aiderPath, dockerImage, suppressStartupError } = opts;
    const dockerExtraArgs = opts.dockerExtraArgs ?? [];
    const useDocker = mode === 'docker';

    this.setStatus('starting');

    // Track process generation to ignore stale close events after stop()+start()
    const thisGeneration = ++this._processGeneration;
    let sawEnoent = false;
    let failureMessage: string | undefined;

    try {
      if (useDocker) {
        // Docker mode: run aider inside a container
        // Normalize path for Docker volume mount (Windows backslashes → forward)
        const workspaceVolume = this.workspaceRoot.replace(/\\/g, '/');

        const dockerArgs = [
          'run', '-i', '--rm',
          ...dockerExtraArgs,
          '-v', workspaceVolume + ':/workspace',
          '-w', '/workspace',
          ...aiderEnvVars,
          dockerImage,
          ...args,
        ];

        this.process = cp.spawn('docker', dockerArgs, {
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } else {
        // Native mode: run aider directly on the host
        this.process = cp.spawn(aiderPath, args, {
          cwd: this.workspaceRoot,
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      }

      // FIX: Register stdout/stderr handlers BEFORE the startup promise
      // so handleOutput can fire _startupReady during the wait
      this.process.stdout?.on('data', (data: Buffer) => {
        this.handleOutput(data.toString());
      });

      this.process.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();
        this.emit('output', { type: 'stderr', data: text } as AiderOutputEvent);
      });

      // FIX: Use generation counter to ignore stale close events from old processes
      this.process.on('close', (code) => {
        if (this._processGeneration !== thisGeneration) return; // stale event
        this.setStatus('stopped');
        this.emit('output', {
          type: 'status',
          data: `Aider process exited (code ${code})`
        } as AiderOutputEvent);
        this.process = null;
      });

      this.process.on('error', (err) => {
        if (this._processGeneration !== thisGeneration) return;
        sawEnoent = (err as NodeJS.ErrnoException).code === 'ENOENT' || err.message.includes('ENOENT');
        this.setStatus('error');
        let hint = '';
        if (useDocker) {
          hint = sawEnoent
            ? ' Is Docker installed and running? Open Docker Desktop, then try again. ' +
              'You can also build a custom image from the included Dockerfile.'
            : ' Check Docker Desktop is running and the image exists.';
        } else if (sawEnoent) {
          hint = ' Is aider installed? Run: pip install aider-chat. ' +
                 'Alternatively, enable "aiderStudio.useDocker" in settings to run Aider in Docker without installing it locally.';
        }
        failureMessage = `Failed to start Aider: ${err.message}.${hint}`;
        // When suppressed (native attempt that may fall back to Docker), stay quiet
        // and let the caller decide whether to surface this or retry.
        if (!suppressStartupError) {
          this.emit('output', { type: 'status', data: failureMessage } as AiderOutputEvent);
        }
        this.process = null;
      });

      // Detect readiness from aider's actual output instead of a hardcoded sleep
      return new Promise<{ ok: boolean; enoent: boolean; failureMessage?: string }>((resolve) => {
        // Timeout after 5s — aider typically starts in 1-3s
        const timeout = setTimeout(() => {
          if (this.process && this.status === 'starting') {
            this.setStatus('ready');
          }
          resolve({ ok: true, enoent: false });
        }, 5000);

        this.once('_startupReady', () => {
          clearTimeout(timeout);
          resolve({ ok: true, enoent: false });
        });

        // If the process exits or errors before ready, the launch failed.
        // The 'error' handler above runs first (registered earlier), so by the
        // time these fire sawEnoent/failureMessage are already set.
        this.process?.once('close', () => {
          clearTimeout(timeout);
          resolve({ ok: false, enoent: sawEnoent, failureMessage });
        });
        this.process?.once('error', () => {
          clearTimeout(timeout);
          resolve({ ok: false, enoent: sawEnoent, failureMessage });
        });
      });
    } catch (err) {
      this.setStatus('error');
      return Promise.resolve({ ok: false, enoent: false });
    }
  }

  confirmEdit(): void {
    this.sendRaw('y\n');
  }

  denyEdit(): void {
    this.sendRaw('n\n');
  }

  /**
   * Scan aider's output for provider rate-limit / overload signals and emit a
   * throttled 'rate-limit' event. The extension reacts by unloading context to
   * shrink the window (the user's "on rate-limit, spill to disk" step).
   */
  private maybeDetectRateLimit(text: string): void {
    if (!/rate.?limit|RateLimitError|\b429\b|RESOURCE_EXHAUSTED|quota exceeded|overloaded|InternalServerError/i.test(text)) {
      return;
    }
    const now = Date.now();
    if (now - this._lastRateLimitAt < 15000) return; // throttle bursts of retry lines
    this._lastRateLimitAt = now;
    this.emit('rate-limit');
  }

  private sendRaw(text: string): void {
    if (!this.process?.stdin) return;
    try { this.process.stdin.write(text); } catch (e) { /* ignore */ }
  }

  sendMessage(message: string): void {
    if (!this.process || !this.process.stdin) {
      this.emit('output', {
        type: 'status',
        data: 'Aider is not running. Start it first.'
      } as AiderOutputEvent);
      return;
    }
    this.setStatus('thinking');
    this.flushAssistantBuffer();
    this.process.stdin.write(message + '\n');
  }

  addFile(filePath: string): void {
    this.sendMessage(`/add ${this.toAiderPath(filePath)}`);
  }

  dropFile(filePath: string): void {
    this.sendMessage(`/drop ${this.toAiderPath(filePath)}`);
  }

  runCommand(cmd: string): void {
    this.sendMessage(`/run ${cmd}`);
  }

  /**
   * Convert a host absolute path into the form aider resolves in BOTH native and
   * Docker modes: workspace-relative with forward slashes. Relative paths resolve
   * against aider's working dir — the repo root natively, and /workspace inside
   * the container — so the same string works either way. (Absolute host paths
   * like C:\...\REPO_MAP.md don't exist inside the container and fail.)
   */
  private toAiderPath(absPath: string): string {
    const rel = path.relative(this.workspaceRoot, absPath).replace(/\\/g, '/');
    return rel || path.basename(absPath);
  }

  /**
   * Load a file into aider's read-only context via `/read` without treating it
   * as a chat message. `pinned` files (e.g. REPO_MAP.md) are kept out of the
   * droppable set so they survive an unload.
   */
  readPath(absPath: string, pinned = false): void {
    if (!this.process?.stdin) return;
    const rel = this.toAiderPath(absPath);
    this.sendRaw('/read ' + rel + '\n');
    if (!pinned) { this.loadedContext.add(rel); this.emitContext(); }
  }

  /**
   * Add a real file to aider's editable context via `/add` (raw, no chat churn).
   * Used to auto-attach the file a user refers to, so the model isn't blind.
   */
  addPath(absPath: string): void {
    if (!this.process?.stdin) return;
    const rel = this.toAiderPath(absPath);
    this.sendRaw('/add ' + rel + '\n');
    this.loadedContext.add(rel);
    this.emitContext();
  }

  /** Drop a single loaded file from context (from the context-strip × button). */
  dropContextPath(rel: string): void {
    if (!this.loadedContext.has(rel)) return;
    this.sendRaw('/drop ' + rel + '\n');
    this.loadedContext.delete(rel);
    this.emitContext();
  }

  /** Notify listeners (the chat panel) of the current loaded-context file list. */
  private emitContext(): void {
    this.emit('context-changed', [...this.loadedContext]);
  }

  /**
   * Unload droppable context from aider's window (`/drop`), keeping pinned files
   * like the repo map. The map still points to everything, so the model can
   * re-`/read` any file on demand. This is the "spill to disk" step — nothing is
   * lost, context just moves from the window back to the indexed chunks on disk.
   */
  dropLoadedContext(reason = ''): number {
    if (this.loadedContext.size === 0) return 0;
    const n = this.loadedContext.size;
    for (const p of this.loadedContext) {
      this.sendRaw('/drop ' + p + '\n');
    }
    this.loadedContext.clear();
    this.emitContext();
    this.emit('output', {
      type: 'status',
      data: `🧹 Unloaded ${n} file(s) from context${reason ? ' (' + reason + ')' : ''}. ` +
            `The repo map stays loaded — ask to re-open any file to pull it back.`,
    } as AiderOutputEvent);
    return n;
  }

  undoLastCommit(): void {
    this.sendMessage('/undo');
  }

  // FIX: Graceful shutdown — send /exit before killing the process
  stop(): void {
    if (this.process) {
      // Try graceful exit first
      try {
        if (this.process.stdin && !this.process.killed) {
          this.process.stdin.write('/exit\n');
        }
      } catch {
        // stdin may already be closed
      }

      // Give aider a moment to shut down gracefully, then force kill
      const proc = this.process;
      const forceKillTimer = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          // already dead
        }
      }, 2000);

      proc.once('close', () => {
        clearTimeout(forceKillTimer);
      });

      // Send SIGTERM first (graceful)
      try {
        proc.kill('SIGTERM');
      } catch {
        // already dead
      }

      this.process = null;
    }
    this.loadedContext.clear(); // context dies with the process
    this.emitContext();
    this.flushAssistantBuffer();
    this.setStatus('stopped');
  }

  getStatus(): AiderStatus {
    return this.status;
  }

  isRunning(): boolean {
    return this.process !== null && this.status !== 'stopped' && this.status !== 'error';
  }

  private handleOutput(text: string): void {
    // Detect provider rate-limit / overload in aider's output stream
    this.maybeDetectRateLimit(text);

    // Detect file edits
    const fileEditRegex = /^Editing\s+(.+)$/gm;
    let match;
    while ((match = fileEditRegex.exec(text)) !== null) {
      this.emit('output', {
        type: 'file-changed',
        data: `Editing: ${match[1]}`,
        filePath: path.join(this.workspaceRoot, match[1])
      } as AiderOutputEvent);
    }

    // Detect commits
    const commitRegex = /^Commit\s+([a-f0-9]+)\s+(.+)$/gm;
    while ((match = commitRegex.exec(text)) !== null) {
      this.emit('output', {
        type: 'commit',
        data: text,
        commitMsg: match[2]
      } as AiderOutputEvent);
    }

    // FIX: Detect readiness from aider's actual prompt output during startup
    if (this.status === 'starting') {
      // Use strict line-level patterns to avoid false positives from code content
      const readyPatterns = /\baider>\s*$|^\s*>\s*$|^Model:/m;
      if (readyPatterns.test(text)) {
        this.setStatus('ready');
        this.emit('_startupReady');
      }
    }

    // Detect ready state (aider prompt) — response finished
    // Use strict line-level patterns to avoid false positives from code content
    const promptPattern = /\baider>\s*$|^\s*>\s*$/m;
    if (promptPattern.test(text) && this.status === 'thinking') {
      this.setStatus('ready');
      this.flushAssistantBuffer();
      this.dropChunkFiles();
      if (this._memoryCapture && this._memoryCaptureBuffer.trim()) {
        this.writeMemory(this._memoryCaptureBuffer.trim());
        this._memoryCapture = false;
        this._memoryCaptureBuffer = '';
        this.emit('output', { type: 'status', data: '✓ Memory saved to MEMORY.md' } as AiderOutputEvent);
      }
    } else if (this.status === 'thinking') {
      // Use buffered output for smoother streaming instead of raw emit
      this.bufferAssistantOutput(text);
      return;
    }

    // Non-thinking output (startup banners, the trailing prompt chunk) — scrub
    // the TUI noise; only emit if anything meaningful remains.
    const scrubbed = this.scrubAiderOutput(text);
    if (scrubbed) {
      this.emit('output', { type: 'stdout', data: scrubbed } as AiderOutputEvent);
    }
  }

  /**
   * FIX: Buffer assistant output so multi-line responses appear as a single message
   * instead of many separate chat bubbles.
   */
  private bufferAssistantOutput(text: string): void {
    this.assistantBuffer += text;

    // Reset the flush timer on each new chunk
    if (this.assistantTimer) {
      clearTimeout(this.assistantTimer);
    }
    this.assistantTimer = setTimeout(() => {
      this.flushAssistantBuffer();
    }, AiderProcess.ASSISTANT_BUFFER_MS);
  }

  private flushAssistantBuffer(): void {
    if (this.assistantTimer) {
      clearTimeout(this.assistantTimer);
      this.assistantTimer = null;
    }
    if (this.assistantBuffer.trim()) {
      const cleaned = this.scrubAiderOutput(this.assistantBuffer);
      if (cleaned) {
        this.emit('output', { type: 'stdout', data: cleaned } as AiderOutputEvent);
      }
      this.assistantBuffer = '';
    }
  }

  /**
   * Strip the terminal-UI artifacts that leak through when we pipe aider's TUI:
   * the prompt line and echoed input, the "(read only)"/editable file bars, the
   * startup banners, and runs of blank lines. Returns clean assistant text.
   */
  private scrubAiderOutput(text: string): string {
    // Names of files currently in context — aider prints these as bare bars.
    const fileBars = new Set<string>();
    for (const p of this.loadedContext) {
      fileBars.add(p);
      fileBars.add(path.basename(p));
    }
    const noise: RegExp[] = [
      /^>\s*$/,                                   // bare prompt
      /^aider>/,                                  // aider prompt
      /^>\s+\S/,                                  // prompt + echoed input
      /\(read only\)\s*$/,                        // read-only files bar
      /^Aider v\d/i,
      /^(Model|Main model|Weak model|Git repo|Repo-map|Tokens|Cost):/i,
      /^Added .+ to (read-only files|the chat)/i,
      /^Aider respects your privacy/i,
      /^For more info:\s*https?:\/\//i,
      /^https?:\/\/aider\.chat/i,
      /^Warning: Input is not a terminal/i,
      /^You can use \/undo/i,
      /prompt[_ ]?toolkit/i,
      /^Use \/help/i,
      /HF_HUB|symlink/i,
    ];
    const out: string[] = [];
    let blanks = 0;
    for (const raw of text.split('\n')) {
      const line = raw.replace(/\s+$/, '');
      const trimmed = line.trim();
      if (!trimmed) {
        blanks++;
        if (blanks <= 1) out.push('');
        continue;
      }
      blanks = 0;
      if (fileBars.has(trimmed)) continue;                // editable-file bar
      if (noise.some((re) => re.test(trimmed))) continue;
      out.push(line);
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }


  private async ensureGitRepo(): Promise<void> {
    const gitDir = path.join(this.workspaceRoot, '.git');
    if (!fs.existsSync(gitDir)) {
      await new Promise<void>(r => cp.exec(
        'git init && git config user.email "aider@local" && git config user.name "Aider"',
        { cwd: this.workspaceRoot }, () => r()
      ));
    }
    await new Promise<void>(r => cp.exec('git add -A', { cwd: this.workspaceRoot }, () => r()));
    await new Promise<void>(r => {
      cp.exec('git diff --cached --quiet', { cwd: this.workspaceRoot }, (err) => {
        if (err) {
          cp.exec(
            'git -c user.email="aider@local" -c user.name="Aider" commit -m "aider-studio: sync" --allow-empty',
            { cwd: this.workspaceRoot }, () => r()
          );
        } else r();
      });
    });
  }

  private dropChunkFiles(): void {
    const aiderChunksDir = path.join(this.workspaceRoot, '.aider', 'context');
    if (!fs.existsSync(aiderChunksDir)) return;
    const chunks = fs.readdirSync(aiderChunksDir).filter((f: string) => f.endsWith('.md'));
    for (const chunk of chunks) {
      this.sendRaw('/drop ' + this.toAiderPath(path.join(aiderChunksDir, chunk)) + '\n');
    }
  }

  /**
   * Save a file as compact context chunks in .aider/context/.
   * Each chunk is a standalone MD file ~2000 chars.
   * These persist across turns — no re-chunking needed.
   * Returns list of chunk file paths.
   */
  chunkFileToAiderDir(filePath: string, maxCharsPerChunk = 2000): string[] {
    const contextDir = path.join(this.workspaceRoot, '.aider', 'context');
    if (!fs.existsSync(contextDir)) fs.mkdirSync(contextDir, { recursive: true });
    let raw: string;
    try { raw = fs.readFileSync(filePath, 'utf8'); } catch { return []; }
    const relPath = path.relative(this.workspaceRoot, filePath);
    const safeName = relPath.replace(/[/\\:<>|?*]/g, '_');

    // Check if we already have up-to-date chunks for this file
    const existingChunks = fs.readdirSync(contextDir)
      .filter((f: string) => f.startsWith(safeName + '.chunk') && f.endsWith('.md'))
      .sort()
      .map((f: string) => path.join(contextDir, f));

    if (existingChunks.length > 0) {
      // Verify first chunk exists and file hasn't changed
      const firstChunk = fs.readFileSync(existingChunks[0], 'utf8');
      const fileSize = raw.length.toString();
      if (firstChunk.includes('size:' + fileSize)) {
        return existingChunks; // Already chunked and up to date
      }
      // File changed — remove old chunks
      for (const c of existingChunks) {
        try { fs.unlinkSync(c); } catch { /* ignore */ }
      }
    }

    const lines = raw.split('\n');
    const chunks: string[] = [];
    let current = '';
    let chunkIdx = 0;

    const writeChunk = (body: string, idx: number) => {
      const chunkPath = path.join(contextDir, safeName + '.chunk' + idx + '.md');
      const header = '<!-- size:' + raw.length + ' part:' + (idx + 1) + ' -->\n# ' +
        relPath + ' (part ' + (idx + 1) + ')\n```\n';
      fs.writeFileSync(chunkPath, header + body + '\n```\n');
      chunks.push(chunkPath);
    };

    for (const line of lines) {
      if ((current + line).length > maxCharsPerChunk && current.length > 0) {
        writeChunk(current, chunkIdx);
        current = '';
        chunkIdx++;
      }
      current += line + '\n';
    }
    if (current.trim()) writeChunk(current, chunkIdx);

    return chunks;
  }

  async addFilesViaChunks(files: string[]): Promise<void> {
    // Context dir persists — chunks are reused if file unchanged
    const allChunks: string[] = [];
    for (const filePath of files) {
      const chunks = this.chunkFileToAiderDir(filePath);
      const rel = path.relative(this.workspaceRoot, filePath);
      this.emit('output', { type: 'status', data: '📄 ' + rel + ' → ' + chunks.length + ' chunk(s)' } as AiderOutputEvent);
      allChunks.push(...chunks);
    }
    this.emit('output', { type: 'status', data: '📦 Loading ' + allChunks.length + ' chunks...' } as AiderOutputEvent);
    for (let i = 0; i < allChunks.length; i++) {
      const chunkRel = this.toAiderPath(allChunks[i]);
      this.sendRaw('/read ' + chunkRel + '\n');
      this.loadedContext.add(chunkRel);
      await new Promise(r => setTimeout(r, 300));
      this.emit('output', { type: 'status', data: '  [' + (i + 1) + '/' + allChunks.length + '] loaded' } as AiderOutputEvent);
    }
    this.emit('output', { type: 'status', data: '✓ ' + allChunks.length + ' chunks loaded' } as AiderOutputEvent);
    this.emitContext();
  }

  private readMemoryFile(): string | null {
    const memPath = path.join(this.workspaceRoot, 'MEMORY.md');
    try { if (fs.existsSync(memPath)) return fs.readFileSync(memPath, 'utf8'); } catch { /* ignore */ }
    return null;
  }

  writeMemory(content: string): void {
    const memPath = path.join(this.workspaceRoot, 'MEMORY.md');
    const ts = new Date().toISOString().slice(0, 16).replace('T', ' ');
    try { fs.writeFileSync(memPath, '# Aider Studio Memory\n_Updated: ' + ts + '_\n\n' + content, 'utf8'); } catch { /* ignore */ }
  }

  saveMemory(): void {
    if (!this.isRunning()) return;
    this._memoryCapture = true;
    this._memoryCaptureBuffer = '';
    this.sendMessage('Summarize everything you know about this codebase into a concise MEMORY.md. Include: purpose, architecture, key files, current state. Output ONLY the markdown content, no preamble.');
  }

  private _memoryCapture = false;
  private _memoryCaptureBuffer = '';

  private setStatus(status: AiderStatus): void {
    this.status = status;
    this.updateStatusBar();
    this.emit('status', status);
  }

  private updateStatusBar(): void {
    const icons: Record<AiderStatus, string> = {
      stopped: '$(circle-slash)',
      starting: '$(sync~spin)',
      ready: '$(check)',
      thinking: '$(loading~spin)',
      error: '$(error)',
    };
    const labels: Record<AiderStatus, string> = {
      stopped: 'Aider: Off',
      starting: 'Aider: Starting...',
      ready: 'Aider: Ready',
      thinking: 'Aider: Thinking...',
      error: 'Aider: Error',
    };
    this.statusBarItem.text = `${icons[this.status]} ${labels[this.status]}`;
    this.statusBarItem.show();
  }
}
