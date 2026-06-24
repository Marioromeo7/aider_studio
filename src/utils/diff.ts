// Pure line-diff used by the inline accept/reject card. No VS Code imports, so
// it's unit-testable in plain Node.

export interface DiffHunk {
  t: 'add' | 'del' | 'ctx';
  s: string;
}

/**
 * Simple LCS line diff (before → after) returning changed lines with a little
 * surrounding context, capped so a huge edit doesn't flood the UI. Guards the
 * O(n*m) table against very large files.
 */
export function computeLineDiff(before: string, after: string): DiffHunk[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const n = a.length, m = b.length;

  if (n > 1500 || m > 1500) {
    return [{ t: 'ctx', s: `(large change: ${n} → ${m} lines — open the full diff to view)` }];
  }

  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const full: DiffHunk[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { full.push({ t: 'ctx', s: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { full.push({ t: 'del', s: a[i] }); i++; }
    else { full.push({ t: 'add', s: b[j] }); j++; }
  }
  while (i < n) full.push({ t: 'del', s: a[i++] });
  while (j < m) full.push({ t: 'add', s: b[j++] });

  // Keep only changed lines + 1 line of context, capped at 80.
  const keep = new Array(full.length).fill(false);
  full.forEach((h, k) => {
    if (h.t !== 'ctx') {
      keep[k] = true;
      if (k > 0) keep[k - 1] = true;
      if (k < full.length - 1) keep[k + 1] = true;
    }
  });
  const out: DiffHunk[] = [];
  for (let k = 0; k < full.length && out.length < 80; k++) {
    if (keep[k]) out.push(full[k]);
  }
  return out;
}
