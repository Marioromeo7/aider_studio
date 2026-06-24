import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { AiderProcess } from './aiderProcess';
import { getActiveProvider, resolveApiKey } from '../providers/registry';
import { summarizeFile, complete } from '../providers/llm';

interface MapEntry {
  rel: string;        // workspace-relative path (forward slashes)
  hash: string;       // content/stat hash — invalidates summary/outline when it changes
  size: number;
  skeleton: string[]; // deterministic outline lines, with line numbers for provenance
  summary?: string;   // model-generated one-liner (optional, cached)
  meta?: string[];    // metadata for data/binary files (columns, dims, type) — never raw content
}

/**
 * Builds and maintains REPO_MAP.md — an always-loaded index of every file in the
 * workspace. It holds ONLY summaries + metadata + outlines (with line numbers as
 * provenance) — never literal file content. The literal code stays in the real
 * files; the model `/read`s a specific file when it needs exact detail. This is
 * what keeps the always-loaded context small enough for free-tier token limits.
 *
 * Layers per file:
 *   1. Outline — deterministic, instant, free. Symbols + line numbers ("where").
 *   2. Summary — one line from the *currently active* model, content-hash cached.
 *   3. Metadata — for data/binary docs (xlsx/docx/csv): type, size, columns, rows.
 */
export class RepoMapManager {
  private cache = new Map<string, MapEntry>();
  private readonly enabled: boolean;
  private readonly contextDir: string;
  private readonly legacyChunkDir: string;
  private readonly cachePath: string;
  private readonly mapPath: string;
  private summarizing = false;
  private gitignoreEnsured = false;
  private refreshDebounce: ReturnType<typeof setTimeout> | null = null;

  private static readonly CACHE_VERSION = 3; // bump to invalidate stale caches
  private static readonly MAX_FILES = 400;
  private static readonly HARD_MAX_BYTES = 1024 * 1024; // above this: stub only, don't read
  private static readonly IGNORE_DIRS = new Set([
    'node_modules', '.git', '.aider', '.hg', '.svn', 'out', 'dist', 'build',
    '.next', '.nuxt', '__pycache__', '.venv', 'venv', 'env', '.mypy_cache',
    '.pytest_cache', '.ruff_cache', 'coverage', '.idea', '.vscode-test',
  ]);
  // Pure media/archives/models — skipped entirely (no useful text or metadata).
  private static readonly BINARY_EXT = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg',
    '.zip', '.gz', '.tar', '.7z', '.rar', '.exe', '.dll', '.so', '.dylib', '.bin',
    '.woff', '.woff2', '.ttf', '.eot', '.mp4', '.mov', '.mp3', '.wav', '.ogg',
    '.parquet', '.pkl', '.pt', '.pth', '.onnx', '.h5', '.npy', '.npz', '.db', '.sqlite',
    '.bz2', '.xz', '.jar', '.class', '.wasm',
  ]);
  // Documents we keep as METADATA-only (never read the bytes as text).
  private static readonly DOC_EXT = new Set([
    '.xlsx', '.xls', '.xlsm', '.xlsb', '.docx', '.doc', '.pptx', '.ppt',
    '.odt', '.ods', '.odp', '.pdf',
  ]);

  constructor(
    private context: vscode.ExtensionContext,
    private workspaceRoot: string,
    private aider: AiderProcess
  ) {
    this.enabled =
      !!workspaceRoot &&
      (vscode.workspace.getConfiguration('aiderStudio').get<boolean>('repoMap.enabled') ?? true);
    this.contextDir = path.join(workspaceRoot, '.aider', 'studio');
    this.legacyChunkDir = path.join(this.contextDir, 'chunks'); // old literal chunks → cleaned up
    this.cachePath = path.join(this.contextDir, 'repomap-cache.json');
    this.mapPath = path.join(workspaceRoot, 'REPO_MAP.md');
    this.loadCache();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Build (or refresh) the deterministic map for the whole workspace. No model
   * calls — instant and free. Returns the number of entries that changed.
   */
  async buildSkeleton(): Promise<number> {
    if (!this.enabled) return 0;
    this.ensureGitignore();
    const files = this.listFiles();
    const seen = new Set<string>();
    let changed = 0;

    for (const abs of files) {
      const rel = this.toRel(abs);
      seen.add(rel);
      const ext = path.extname(rel).toLowerCase();
      let stat: fs.Stats;
      try {
        stat = fs.statSync(abs);
      } catch {
        continue;
      }

      // Binary documents → metadata only, never read the bytes as text.
      if (RepoMapManager.DOC_EXT.has(ext)) {
        const hash = `doc:${stat.size}:${Math.round(stat.mtimeMs)}`;
        const existing = this.cache.get(rel);
        if (existing && existing.hash === hash) continue;
        this.cache.set(rel, {
          rel, hash, size: stat.size,
          skeleton: ['(document — metadata only, not loaded)'],
          meta: this.docMetadata(ext, stat),
        });
        changed++;
        continue;
      }

      if (stat.size > RepoMapManager.HARD_MAX_BYTES) {
        this.cache.set(rel, {
          rel, hash: 'oversize:' + stat.size, size: stat.size,
          skeleton: [`(large file, ${Math.round(stat.size / 1024)} KB — not indexed)`],
        });
        continue;
      }

      let content: string;
      try {
        content = fs.readFileSync(abs, 'utf8');
      } catch {
        continue;
      }
      const hash = this.hash(content);
      const existing = this.cache.get(rel);
      if (existing && existing.hash === hash) continue;

      // Binary despite a text-y extension (the .xlsx-as-text disaster) — skip.
      if (this.looksBinary(content)) {
        this.cache.set(rel, {
          rel, hash, size: stat.size,
          skeleton: ['(binary or non-text file — not indexed)'],
        });
        changed++;
        continue;
      }

      // Tabular data → metadata (columns + row count + sample), not an outline.
      if (ext === '.csv' || ext === '.tsv') {
        this.cache.set(rel, {
          rel, hash, size: stat.size,
          skeleton: ['(data file)'],
          meta: this.csvMetadata(content, ext === '.tsv' ? '\t' : ','),
        });
        changed++;
        continue;
      }

      this.cache.set(rel, {
        rel, hash, size: stat.size,
        skeleton: this.buildOutline(rel, content),
        summary: undefined, // content changed → regenerate summary
      });
      changed++;
    }

    // Drop entries for files that no longer exist.
    for (const rel of [...this.cache.keys()]) {
      if (!seen.has(rel)) this.cache.delete(rel);
    }

    this.persistCache();
    this.renderMap();
    return changed;
  }

  /**
   * Generate model summaries for entries that don't have one yet, using the
   * currently active provider. Throttled and capped to protect free-tier limits;
   * stops and checkpoints on a rate-limit instead of burning the rest of the quota.
   */
  async generateSummaries(): Promise<void> {
    if (!this.enabled || this.summarizing) return;
    const provider = getActiveProvider();
    if (!provider) return;
    const key = await resolveApiKey(this.context, provider);
    if (!key) return; // no key — outlines/metadata still work

    const cfg = vscode.workspace.getConfiguration('aiderStudio');
    if (!(cfg.get<boolean>('repoMap.summaries') ?? true)) return;
    const perRunCap = cfg.get<number>('repoMap.summaryBudget') ?? 150;

    this.summarizing = true;
    try {
      // Only real text files get summaries — stub/doc/data entries start with "(".
      const pending = [...this.cache.values()].filter(
        (e) => e.summary === undefined && !(e.skeleton[0] ?? '').startsWith('(')
      );
      if (pending.length > perRunCap) {
        this.log(`Summarizing ${perRunCap}/${pending.length} files this pass (budget). Rest fill in on next build.`);
      }
      const batch = pending.slice(0, perRunCap);
      let done = 0;
      let rateLimited = false;
      for (const entry of batch) {
        const abs = path.join(this.workspaceRoot, entry.rel);
        let content: string;
        try {
          content = fs.readFileSync(abs, 'utf8');
        } catch {
          continue;
        }
        const result = await summarizeFile(provider, key, entry.rel, content);
        if (result.ok) {
          entry.summary = result.summary;
          done++;
          if (done % 10 === 0) {
            this.persistCache();
            this.renderMap();
          }
        } else if (result.rateLimited) {
          rateLimited = true;
          break;
        }
        await this.sleep(200); // throttle — be gentle on free rate limits
      }
      this.persistCache();
      this.renderMap();
      if (done > 0) {
        this.log(`Summarized ${done} file(s) with ${provider.label}.`);
        this.loadIntoAider();
      }
      if (rateLimited) {
        const left = [...this.cache.values()].filter(
          (e) => e.summary === undefined && !(e.skeleton[0] ?? '').startsWith('(')
        ).length;
        this.log(
          `Rate limit reached — checkpointed ${done} summaries to REPO_MAP.md. ` +
          `${left} file(s) remain outline-only and fill in on the next pass.`
        );
      }
    } finally {
      this.summarizing = false;
    }
  }

  /** Refresh a single file (on save) — recompute its entry, re-render, reload. */
  refreshFileSoon(absPath: string): void {
    if (!this.enabled) return;
    const rel = this.toRel(absPath);
    if (rel.startsWith('..') || this.isIgnored(absPath)) return;
    if (path.basename(absPath) === 'REPO_MAP.md') return;
    if (this.refreshDebounce) clearTimeout(this.refreshDebounce);
    this.refreshDebounce = setTimeout(async () => {
      this.refreshDebounce = null;
      const changed = await this.buildSkeleton();
      if (changed > 0) {
        this.loadIntoAider();
        this.generateSummaries();
      }
    }, 800);
  }

  /** Tell aider to (re)read the map so it's in context (pinned — never dropped). */
  loadIntoAider(): void {
    if (!this.enabled) return;
    if (!fs.existsSync(this.mapPath)) return;
    if (!this.aider.isRunning()) return;
    this.aider.readPath(this.mapPath, true);
  }

  getSummary(absPath: string): string | undefined {
    return this.cache.get(this.toRel(absPath))?.summary;
  }

  /** Indexed file paths (workspace-relative) — used for @file autocomplete. */
  getFileList(): string[] {
    return [...this.cache.keys()].sort();
  }

  /**
   * Find which indexed file a user message refers to (e.g. "explain
   * efficient_frontier.ipynb" or "explain egx100"). Matches by full basename
   * first, then by name-without-extension. Returns the absolute path.
   */
  resolveFromText(text: string): string | undefined {
    // Normalize separators so "efficient_frontier" matches "efficient frontier"
    // (spaces/underscores/hyphens collapsed) — that mismatch silently failed before.
    const norm = (s: string) => s.toLowerCase().replace(/[\s_\-]+/g, '');
    const nt = norm(text);
    const ranked = [...this.cache.keys()]
      .map((f) => ({
        f,
        base: norm(path.basename(f)),
        stem: norm(path.basename(f, path.extname(f))),
      }))
      .sort((a, b) => b.base.length - a.base.length); // prefer the most specific match
    for (const r of ranked) {
      if (r.base.length >= 4 && nt.includes(r.base)) return path.join(this.workspaceRoot, r.f);
    }
    for (const r of ranked) {
      if (r.stem.length >= 5 && nt.includes(r.stem)) return path.join(this.workspaceRoot, r.f);
    }
    return undefined;
  }

  /**
   * Find the file a message most likely refers to. Tries an exact/normalized
   * match first; if none, falls back to the CLOSEST fuzzy match (so a typo or
   * loose reference still resolves "in confusion"). Returns abs path + a score
   * (1 = exact, <1 = fuzzy).
   */
  resolveClosest(text: string): { abs: string; score: number } | undefined {
    const exact = this.resolveFromText(text);
    if (exact) return { abs: exact, score: 1 };

    const norm = (s: string) => s.toLowerCase().replace(/[\s_\-]+/g, '');
    const tokens = text.toLowerCase().split(/[^a-z0-9.]+/).filter((t) => t.length >= 4);
    if (!tokens.length) return undefined;

    let best: string | undefined;
    let bestScore = 0;
    for (const f of this.cache.keys()) {
      const stem = norm(path.basename(f, path.extname(f)));
      const base = norm(path.basename(f));
      for (const tok of tokens) {
        const nt = norm(tok);
        const s = Math.max(this.dice(nt, stem), this.dice(nt, base));
        if (s > bestScore) { bestScore = s; best = f; }
      }
    }
    return best && bestScore >= 0.5
      ? { abs: path.join(this.workspaceRoot, best), score: bestScore }
      : undefined;
  }

  /** Dice coefficient over character bigrams — cheap fuzzy string similarity. */
  private dice(a: string, b: string): number {
    if (a === b) return 1;
    if (a.length < 2 || b.length < 2) return 0;
    const bigrams = (s: string) => {
      const m = new Map<string, number>();
      for (let i = 0; i < s.length - 1; i++) {
        const g = s.slice(i, i + 2);
        m.set(g, (m.get(g) ?? 0) + 1);
      }
      return m;
    };
    const A = bigrams(a);
    const B = bigrams(b);
    let inter = 0;
    for (const [g, c] of A) {
      const d = B.get(g);
      if (d) inter += Math.min(c, d);
    }
    return (2 * inter) / ((a.length - 1) + (b.length - 1));
  }

  /**
   * Build (or reuse) a per-file DIGEST: split the file into chunks, summarize
   * each chunk with the active model, then have the model gather those into one
   * coherent .md under .aider/studio/summaries/. That digest is the file's
   * "direct reference" — pulled in when the user asks to explain the file.
   * Cached by content hash; returns the digest's workspace-relative path.
   */
  async ensureFileDigest(absPath: string): Promise<string | null> {
    if (!this.enabled) return null;
    const cfg = vscode.workspace.getConfiguration('aiderStudio');
    if (!(cfg.get<boolean>('repoMap.summaries') ?? true)) return null;
    const provider = getActiveProvider();
    if (!provider) return null;
    const key = await resolveApiKey(this.context, provider);
    if (!key) return null;

    const rel = this.toRel(absPath);
    let content: string;
    try {
      content = fs.readFileSync(absPath, 'utf8');
    } catch {
      return null;
    }
    if (this.looksBinary(content)) return null;

    const safe = rel.replace(/[/\\:<>|?*\s]/g, '_');
    const digestRel = path.join('.aider', 'studio', 'summaries', safe + '.md').replace(/\\/g, '/');
    const digestAbs = path.join(this.workspaceRoot, digestRel);
    const hash = this.hash(content);

    // Reuse a cached digest if the file hasn't changed.
    try {
      if (fs.existsSync(digestAbs) && fs.readFileSync(digestAbs, 'utf8').slice(0, 200).includes('hash:' + hash)) {
        return digestRel;
      }
    } catch {
      /* rebuild */
    }

    const text = this.readableForDigest(rel, content);
    const chunks = this.splitChunks(text, 4000, 10);
    this.log(`Building digest for ${rel} (${chunks.length} chunk${chunks.length === 1 ? '' : 's'})…`);

    const parts: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const r = await complete(
        provider, key,
        `This is part ${i + 1} of ${chunks.length} of the file "${rel}". Summarize what this part ` +
        `defines and does — functions, classes, key logic and notable details. Be specific and concise.\n\n${chunks[i]}`,
        220
      );
      if (r.ok && r.text.trim()) {
        parts.push(`### Part ${i + 1}\n${r.text.trim()}`);
      } else if (!r.ok && r.rateLimited) {
        this.log(`Rate limit while building digest for ${rel} — using the ${parts.length} part(s) gathered so far.`);
        break;
      }
      await this.sleep(200);
    }
    if (!parts.length) return null;

    // Gather the chunk-summaries into one coherent explanation.
    let body: string;
    if (parts.length === 1) {
      body = parts[0].replace(/^### Part 1\n/, '');
    } else {
      const g = await complete(
        provider, key,
        `Combine these part-summaries of the file "${rel}" into ONE clear, structured explanation of ` +
        `what the file does overall, its main components, and how they fit together. Concise markdown.\n\n${parts.join('\n\n')}`,
        700
      );
      body = g.ok && g.text.trim() ? g.text.trim() : parts.join('\n\n');
    }

    const md =
      `<!-- Aider Studio file digest · hash:${hash} -->\n# Digest: ${rel}\n\n` +
      `_Built from ${parts.length} chunk-summaries. Reference for explaining this file; ` +
      `\`/read\` the file itself for exact code._\n\n${body}\n`;
    try {
      if (!fs.existsSync(path.dirname(digestAbs))) fs.mkdirSync(path.dirname(digestAbs), { recursive: true });
      fs.writeFileSync(digestAbs, md, 'utf8');
    } catch {
      return null;
    }
    return digestRel;
  }

  dispose(): void {
    if (this.refreshDebounce) clearTimeout(this.refreshDebounce);
  }

  // ── internals ──────────────────────────────────────────────────────────

  private listFiles(): string[] {
    const out: string[] = [];
    const extraIgnores = this.readGitignoreNames();
    const walk = (dir: string) => {
      if (out.length >= RepoMapManager.MAX_FILES) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of entries) {
        if (out.length >= RepoMapManager.MAX_FILES) return;
        const name = ent.name;
        const abs = path.join(dir, name);
        if (ent.isDirectory()) {
          if (RepoMapManager.IGNORE_DIRS.has(name) || extraIgnores.has(name)) continue;
          if (name.startsWith('.') && name !== '.github') continue;
          walk(abs);
        } else if (ent.isFile()) {
          const ext = path.extname(name).toLowerCase();
          if (RepoMapManager.BINARY_EXT.has(ext)) continue; // pure media/archive — skip
          if (name === 'REPO_MAP.md') continue;
          out.push(abs);
        }
      }
    };
    walk(this.workspaceRoot);
    if (out.length >= RepoMapManager.MAX_FILES) {
      this.log(`Repo map capped at ${RepoMapManager.MAX_FILES} files — some files not indexed.`);
    }
    return out;
  }

  /** Deterministic outline with line numbers as provenance ("where it came from"). */
  private buildOutline(rel: string, content: string): string[] {
    const ext = path.extname(rel).toLowerCase();
    const cap = (arr: string[]) => arr.slice(0, 10);

    if (ext === '.ipynb') {
      try {
        const nb = JSON.parse(content);
        const cells = Array.isArray(nb.cells) ? nb.cells : [];
        const out: string[] = [];
        const md = cells.find((c: any) => c.cell_type === 'markdown');
        if (md) {
          const text = (Array.isArray(md.source) ? md.source.join('') : md.source || '')
            .split('\n').map((s: string) => s.trim()).filter(Boolean).slice(0, 2);
          out.push(...text);
        }
        const codeCells = cells.filter((c: any) => c.cell_type === 'code').length;
        out.push(`notebook: ${cells.length} cells (${codeCells} code)`);
        return cap(out);
      } catch {
        return ['notebook (unparseable)'];
      }
    }

    const lines = content.split('\n');
    const out: string[] = [];
    const add = (label: string, i: number) => out.push(`${label.trim()}  ·L${i + 1}`);

    if (ext === '.py') {
      lines.forEach((ln, i) => {
        if (/^\s*(?:class|def|async\s+def)\s+[A-Za-z_]\w*/.test(ln)) add(ln, i);
      });
    } else if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
      const re = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|const|interface|type|enum)\s+[A-Za-z_$][\w$]*/;
      lines.forEach((ln, i) => { if (re.test(ln)) add(ln, i); });
    } else if (ext === '.md') {
      lines.forEach((ln, i) => { if (/^#{1,3}\s+\S/.test(ln)) add(ln, i); });
    }
    return cap(out.length ? out : [this.firstLine(content)]);
  }

  /** Metadata for a binary document — type + size only (we never read the bytes). */
  private docMetadata(ext: string, stat: fs.Stats): string[] {
    const labels: Record<string, string> = {
      '.xlsx': 'Excel workbook', '.xls': 'Excel workbook (legacy)', '.xlsm': 'Excel workbook (macro)',
      '.xlsb': 'Excel workbook (binary)', '.docx': 'Word document', '.doc': 'Word document (legacy)',
      '.pptx': 'PowerPoint deck', '.ppt': 'PowerPoint deck (legacy)', '.pdf': 'PDF document',
      '.odt': 'OpenDocument text', '.ods': 'OpenDocument spreadsheet', '.odp': 'OpenDocument presentation',
    };
    return [`${labels[ext] || 'binary document'} · ${Math.round(stat.size / 1024)} KB · process with code, not by reading into context`];
  }

  /** Metadata for a CSV/TSV — columns, row count, one sample row (not the data). */
  private csvMetadata(content: string, delim: string): string[] {
    const lines = content.split(/\r?\n/).filter((l) => l.length > 0);
    if (!lines.length) return ['(empty data file)'];
    const cols = lines[0].split(delim);
    const meta: string[] = [`${lines.length} rows × ${cols.length} columns`];
    const shown = cols.slice(0, 12).map((c) => c.trim()).join(', ');
    meta.push(`columns: ${shown}${cols.length > 12 ? ', …' : ''}`);
    if (lines[1]) meta.push(`sample row: ${lines[1].slice(0, 120)}`);
    return meta;
  }

  private renderMap(): void {
    const entries = [...this.cache.values()].sort((a, b) => a.rel.localeCompare(b.rel));
    const withSummary = entries.filter((e) => e.summary).length;
    const out: string[] = [];
    out.push('<!-- Aider Studio repo map — auto-generated. Do not edit by hand. -->');
    out.push('# Repository Map');
    out.push('');
    out.push(
      `_${entries.length} files indexed · ${withSummary} summarized. Summaries, outlines (with ` +
      `line numbers) and metadata only — NOT file contents. To work on a file's actual code, ` +
      `\`/read\` or \`/add\` it by the path shown._`
    );
    out.push('');
    for (const e of entries) {
      out.push(`## ${e.rel}`);
      if (e.summary) out.push(`> ${e.summary}`);
      for (const s of e.skeleton) {
        if (s && s.trim()) out.push(`- ${s.trim()}`);
      }
      if (e.meta) {
        for (const m of e.meta) out.push(`- ${m}`);
      }
      out.push('');
    }
    try {
      fs.writeFileSync(this.mapPath, out.join('\n'), 'utf8');
    } catch {
      /* ignore write failures */
    }
  }

  private loadCache(): void {
    try {
      if (fs.existsSync(this.cachePath)) {
        const raw = JSON.parse(fs.readFileSync(this.cachePath, 'utf8'));
        if (raw && raw.version === RepoMapManager.CACHE_VERSION && Array.isArray(raw.entries)) {
          for (const e of raw.entries as MapEntry[]) {
            if (e && e.rel) this.cache.set(e.rel, e);
          }
        } else {
          // Old/incompatible cache (e.g. the literal-chunk era) — clean up.
          this.wipeLegacyChunks();
        }
      }
    } catch {
      this.wipeLegacyChunks();
    }
  }

  /** Remove the old literal-content chunk directory from previous versions. */
  private wipeLegacyChunks(): void {
    try {
      if (fs.existsSync(this.legacyChunkDir)) {
        fs.rmSync(this.legacyChunkDir, { recursive: true, force: true });
      }
    } catch {
      /* ignore */
    }
  }

  private persistCache(): void {
    try {
      if (!fs.existsSync(this.contextDir)) fs.mkdirSync(this.contextDir, { recursive: true });
      fs.writeFileSync(
        this.cachePath,
        JSON.stringify({ version: RepoMapManager.CACHE_VERSION, entries: [...this.cache.values()] }),
        'utf8'
      );
    } catch {
      /* ignore */
    }
  }

  /** Make sure our artifacts are git-ignored in the user's workspace. Idempotent. */
  private ensureGitignore(): void {
    if (this.gitignoreEnsured) return;
    this.gitignoreEnsured = true;
    try {
      const giPath = path.join(this.workspaceRoot, '.gitignore');
      const current = fs.existsSync(giPath) ? fs.readFileSync(giPath, 'utf8') : '';
      const lines = new Set(current.split(/\r?\n/).map((l) => l.trim()));
      const has = (p: string) => lines.has(p);
      const missing: string[] = [];
      if (!has('REPO_MAP.md') && !has('/REPO_MAP.md')) missing.push('REPO_MAP.md');
      if (!has('.aider/') && !has('.aider') && !has('.aider*')) missing.push('.aider/');
      if (missing.length === 0) return;
      const prefix = current && !current.endsWith('\n') ? '\n' : '';
      fs.appendFileSync(giPath, `${prefix}\n# Aider Studio (auto-added)\n${missing.join('\n')}\n`);
    } catch {
      /* ignore — gitignore is a nicety, not required */
    }
  }

  private readGitignoreNames(): Set<string> {
    const names = new Set<string>();
    try {
      const gi = path.join(this.workspaceRoot, '.gitignore');
      if (!fs.existsSync(gi)) return names;
      for (const raw of fs.readFileSync(gi, 'utf8').split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#') || line.includes('*')) continue;
        names.add(line.replace(/^\//, '').replace(/\/$/, ''));
      }
    } catch {
      /* ignore */
    }
    return names;
  }

  private isIgnored(abs: string): boolean {
    const rel = this.toRel(abs);
    if (rel.startsWith('..')) return true;
    return rel.split('/').some((s) => RepoMapManager.IGNORE_DIRS.has(s));
  }

  private toRel(abs: string): string {
    return path.relative(this.workspaceRoot, abs).replace(/\\/g, '/');
  }

  /** Readable text for digesting — unwrap notebook JSON into cell text. */
  private readableForDigest(rel: string, content: string): string {
    if (path.extname(rel).toLowerCase() !== '.ipynb') return content;
    try {
      const nb = JSON.parse(content);
      const cells = Array.isArray(nb.cells) ? nb.cells : [];
      return cells
        .map((c: any, i: number) =>
          `# --- cell ${i + 1} (${c.cell_type}) ---\n` +
          (Array.isArray(c.source) ? c.source.join('') : c.source || ''))
        .join('\n\n');
    } catch {
      return content;
    }
  }

  /** Split text into up to maxChunks line-aligned pieces of ~size chars each. */
  private splitChunks(text: string, size: number, maxChunks: number): string[] {
    const lines = text.split('\n');
    const chunks: string[] = [];
    let buf: string[] = [];
    let n = 0;
    for (const ln of lines) {
      if (n + ln.length > size && buf.length) {
        chunks.push(buf.join('\n'));
        buf = []; n = 0;
        if (chunks.length >= maxChunks) break;
      }
      buf.push(ln);
      n += ln.length + 1;
    }
    if (buf.length && chunks.length < maxChunks) chunks.push(buf.join('\n'));
    return chunks;
  }

  private firstLine(content: string): string {
    const line = content.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '(empty)';
    return line.length > 100 ? line.slice(0, 97) + '…' : line;
  }

  private hash(content: string): string {
    return crypto.createHash('sha1').update(content).digest('hex').slice(0, 16);
  }

  /** Heuristic: does this content look binary (many control chars)? */
  private looksBinary(content: string): boolean {
    const sample = content.slice(0, 4000);
    if (!sample.length) return false;
    let nonText = 0;
    for (let i = 0; i < sample.length; i++) {
      const c = sample.charCodeAt(i);
      if (c === 9 || c === 10 || c === 13) continue; // tab/newline/cr
      if (c < 32 || c === 0xfffd) nonText++;          // controls / replacement char
    }
    return nonText / sample.length > 0.15;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  private log(msg: string): void {
    this.aider.emit('output', { type: 'status', data: '🗺 ' + msg });
  }
}
