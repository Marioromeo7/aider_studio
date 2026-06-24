// ── Aider Studio Webview (loaded via <script src> — NOT embedded in a template literal) ──
// This file is a real .js file, so \n, backticks, quotes, etc. all work normally.
// No template-literal escaping bugs possible here.

const vscode = acquireVsCodeApi();

// ── Embedded init data (injected by extension host via <script> tag before this file) ──
const providers = window.__INIT__ ? window.__INIT__.providers || {} : {};
const activeId = window.__INIT__ ? window.__INIT__.activeProviderId || '' : '';
let keyStatus = {};
let selectedSetupProvider = '';

// ── Elements ──
const setupEl = document.getElementById('setup');
const chatEl = document.getElementById('chat');
const providerList = document.getElementById('provider-list');
const keySection = document.getElementById('key-section');
const keyLabel = document.getElementById('key-label');
const keyInput = document.getElementById('key-input');
const saveKeyBtn = document.getElementById('save-key-btn');
const setupHint = document.getElementById('setup-hint');
const providerSelect = document.getElementById('provider-select');
const messagesEl = document.getElementById('messages');
const inputEl = document.getElementById('msg-input');
const sendBtn = document.getElementById('send-btn');
const statusBar = document.getElementById('status-bar');
const contextFiles = document.getElementById('context-files');
const emptyState = document.getElementById('empty-state');
const keyBar = document.getElementById('key-bar');
const keyBarInput = document.getElementById('key-bar-input');
const keyBarLabel = document.getElementById('key-bar-label');

// ── Message handler ──
window.addEventListener('message', ({ data: msg }) => {
  switch (msg.type) {
    case 'init':
    case 'asyncInit':
      keyStatus = msg.keyStatus || keyStatus;
      if (msg.hasKey && Object.keys(providers).length > 0) {
        showChat(msg.messages || [], msg.status || 'stopped');
      } else if (Object.keys(keyStatus).length > 0) {
        renderProviderList(selectedSetupProvider || activeId);
      }
      break;
    case 'sessions':
      renderSessions(msg.sessions, msg.activeId);
      break;
    case 'show-setup':
      // providers could be updated here too
      showSetup(msg.providerId);
      break;
    case 'transition':
      if (msg.screen === 'chat') showChat([], 'stopped');
      break;
    case 'customProviderResult':
      handleCustomProviderResult(msg);
      break;
    case 'user': appendMessage('user', msg.text); break;
    case 'assistant': appendMessage('assistant', msg.text); break;
    case 'system': appendMessage('system', msg.text); break;
    case 'error': appendMessage('error', msg.text); break;
    case 'commit': showCommit(msg.text); break;
    case 'file-changed': appendMessage('file-changed', msg.text, msg.filePath); break;
    case 'confirm':
      showConfirm(msg.text);
      break;
    case 'stream-start':
      // Close any prior bubble; the new one is created lazily on first real
      // content (so a no-output turn doesn't leave an empty "Aider" bubble).
      if (streamDiv) endStreaming();
      break;
    case 'stream':
      appendStream(msg.text);
      break;
    case 'stream-end':
      endStreaming();
      break;
    case 'clearMessages':
      messagesEl.innerHTML = '';
      messagesEl.appendChild(emptyState);
      emptyState.style.display = 'flex';
      break;
    case 'status': setStatus(msg.status); break;
    case 'modelWarnings': setWarningsButton(msg.enabled); break;
    case 'contextFiles': renderContextFiles(msg.files || []); break;
    case 'files': allFiles = msg.files || []; break;
    case 'diff': renderDiffCard(msg.file, msg.path, msg.hunks || []); break;
  }
});

// ── Setup screen ──
function showSetup(preselect) {
  chatEl.style.display = 'none';
  setupEl.style.display = 'flex';
  renderProviderList(preselect);
}

function renderProviderList(preselect) {
  providerList.innerHTML = '';
  Object.entries(providers).forEach(([id, p]) => {
    const card = document.createElement('div');
    card.className = 'provider-card' + (id === preselect ? ' selected' : '');
    card.dataset.id = id;
    const hasKey = keyStatus[id];
    card.innerHTML =
      '<div class="name">' + p.label + '</div>' +
      '<div class="meta">' + (p.freetier ? 'Free tier available' : 'Paid') + '</div>' +
      '<div class="badge ' + (hasKey ? '' : 'missing') + '">' + (hasKey ? '✓ Key set' : 'No key') + '</div>';
    card.addEventListener('click', () => selectSetupProvider(id));
    providerList.appendChild(card);
  });
  // Trailing card to add a custom provider from the setup screen too.
  const customCard = document.createElement('div');
  customCard.className = 'provider-card';
  customCard.innerHTML =
    '<div class="name">＋ Add custom provider…</div>' +
    '<div class="meta">Any aider/LiteLLM model (OpenRouter, DeepSeek, Mistral…)</div>';
  customCard.addEventListener('click', openCustomModal);
  providerList.appendChild(customCard);
  if (preselect) selectSetupProvider(preselect);
}

function selectSetupProvider(id) {
  selectedSetupProvider = id;
  document.querySelectorAll('.provider-card').forEach(c => {
    c.classList.toggle('selected', c.dataset.id === id);
  });
  const p = providers[id];
  if (!p) return;
  keySection.style.display = 'flex';
  keyLabel.textContent = 'API Key for ' + p.label;
  keyInput.placeholder = 'Paste your ' + p.label + ' API key...';
  keyInput.value = '';
  keyInput.focus();

  const hints = {
    'gemini': 'Get a free key at <a href="https://aistudio.google.com">aistudio.google.com</a> — 1500 req/day free',
    'groq-llama': 'Get a free key at <a href="https://console.groq.com">console.groq.com</a> — fast, per-minute limits',
    'groq-deepseek': 'Get a free key at <a href="https://console.groq.com">console.groq.com</a>',
  };
  setupHint.innerHTML = hints[id] || '';

  if (keyStatus[id]) {
    keyInput.placeholder = 'Enter new key to replace existing...';
    saveKeyBtn.textContent = 'Update Key';
  } else {
    saveKeyBtn.textContent = 'Connect';
  }
}

saveKeyBtn.addEventListener('click', () => {
  const key = keyInput.value.trim();
  if (!key) { keyInput.focus(); return; }
  saveKeyBtn.disabled = true;
  saveKeyBtn.textContent = 'Saving...';
  vscode.postMessage({ type: 'saveKey', providerId: selectedSetupProvider, key });
});

keyInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') saveKeyBtn.click();
});

// ── Chat screen ──
function showChat(messages, status) {
  setupEl.style.display = 'none';
  chatEl.style.display = 'flex';

  refreshProviderOptions(activeId);

  if (messages && messages.length) {
    emptyState.style.display = 'none';
    messages.forEach(m => appendMessage(m.role, m.content));
  }

  setStatus(status || 'stopped');
  saveKeyBtn.disabled = false;
  saveKeyBtn.textContent = 'Connect';
}

// Rebuild the provider dropdown from the current `providers` map, always with a
// trailing "add custom" entry. Selects `selectId` if given.
function refreshProviderOptions(selectId) {
  providerSelect.innerHTML = '';
  Object.entries(providers).forEach(([id, p]) => {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = p.label + (keyStatus[id] ? '' : ' ⚠');
    providerSelect.appendChild(opt);
  });
  const customOpt = document.createElement('option');
  customOpt.value = '__custom__';
  customOpt.textContent = '＋ Add custom provider…';
  providerSelect.appendChild(customOpt);
  if (selectId && providers[selectId]) {
    providerSelect.value = selectId;
    providerSelect.dataset.prev = selectId;
  }
}

providerSelect.addEventListener('change', () => {
  const newId = providerSelect.value;
  if (newId === '__custom__') {
    // Don't actually switch — open the modal and restore the previous selection.
    providerSelect.value = providerSelect.dataset.prev || activeId;
    openCustomModal();
    return;
  }
  providerSelect.dataset.prev = newId;
  vscode.postMessage({ type: 'switchProvider', providerId: newId });
});

// ── Key bar (inline update) ──
document.getElementById('btn-key').addEventListener('click', () => {
  const p = providers[activeId];
  keyBarLabel.textContent = 'New key for ' + (p ? p.label : 'provider') + ':';
  keyBar.classList.add('visible');
  keyBarInput.value = '';
  keyBarInput.focus();
});
document.getElementById('key-bar-save').addEventListener('click', () => {
  const key = keyBarInput.value.trim();
  if (!key) return;
  vscode.postMessage({ type: 'updateKey', key });
  keyStatus[activeId] = true;
  keyBar.classList.remove('visible');
});
document.getElementById('key-bar-cancel').addEventListener('click', () => {
  keyBar.classList.remove('visible');
});
keyBarInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('key-bar-save').click();
  if (e.key === 'Escape') keyBar.classList.remove('visible');
});

// ── Status ──
let workTimer = null, workStart = 0;
function setStatus(status) {
  statusBar.className = status;
  const labels = {
    stopped: '⬤ Stopped — send a message to start',
    starting: '◌ Starting…',
    ready: '● Ready',
    thinking: '◌ Working…',
    error: '⚠ Error',
  };
  const busy = status === 'thinking' || status === 'starting';
  if (workTimer) { clearInterval(workTimer); workTimer = null; }
  if (busy) {
    workStart = Date.now();
    const tick = () => {
      const s = Math.round((Date.now() - workStart) / 1000);
      statusBar.textContent = (status === 'starting' ? '◌ Starting… ' : '◌ Working… ') + s + 's';
    };
    tick();
    workTimer = setInterval(tick, 1000);
    sendBtn.textContent = '■ Stop';
    sendBtn.dataset.mode = 'stop';
    sendBtn.disabled = false;
  } else {
    statusBar.textContent = labels[status] || status;
    sendBtn.textContent = 'Send';
    sendBtn.dataset.mode = 'send';
    sendBtn.disabled = false;
  }
}

// ── Messages ──
function appendMessage(role, text, filePath) {
  if (emptyState) emptyState.style.display = 'none';
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  if (!['system', 'commit', 'file-changed'].includes(role)) {
    const roleEl = document.createElement('div');
    roleEl.className = 'msg-role';
    roleEl.textContent = role === 'user' ? 'You' : role === 'assistant' ? 'Aider' : role;
    div.appendChild(roleEl);
  }
  const body = document.createElement('div');
  body.className = 'msg-body';
  body.innerHTML = role === 'assistant' ? renderMarkdown(text) : formatText(text);
  if (role === 'file-changed' && filePath) {
    body.title = 'Click to view diff';
    body.addEventListener('click', () => vscode.postMessage({ type: 'openDiff', filePath }));
  }
  div.appendChild(body);
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Plain escaping for user/system lines (no markdown).
function formatText(text) {
  return escapeHtml(text);
}

// Lightweight streaming markdown → HTML for assistant output.
// Handles fenced code (with copy), headings, lists, hr, bold/italic/code/links.
// Tolerates an unclosed code fence mid-stream.
const SEP = String.fromCharCode(31);
function renderMarkdown(src) {
  const blocks = [];
  const BT = String.fromCharCode(96);
  const fence = new RegExp(BT + BT + BT + '(\\w*)\\n?([\\s\\S]*?)(' + BT + BT + BT + '|$)', 'g');
  src = src.replace(fence, (m, lang, code) => {
    blocks.push(code.replace(/\n$/, ''));
    return SEP + 'CODE' + (blocks.length - 1) + SEP;
  });

  const lines = escapeHtml(src).split('\n');
  const out = [];
  let list = null;
  const closeList = () => { if (list) { out.push(list === 'ul' ? '</ul>' : '</ol>'); list = null; } };
  for (const line of lines) {
    const t = line.trim();
    let m;
    if (new RegExp('^' + SEP + 'CODE\\d+' + SEP + '$').test(t)) { closeList(); out.push(t); continue; }
    if ((m = t.match(/^(#{1,4})\s+(.*)$/))) { closeList(); const n = m[1].length; out.push('<h' + n + '>' + inlineMd(m[2]) + '</h' + n + '>'); continue; }
    if (/^[-*]\s+/.test(t)) { if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; } out.push('<li>' + inlineMd(t.replace(/^[-*]\s+/, '')) + '</li>'); continue; }
    if (/^\d+\.\s+/.test(t)) { if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; } out.push('<li>' + inlineMd(t.replace(/^\d+\.\s+/, '')) + '</li>'); continue; }
    if (/^(---|\*\*\*|___)$/.test(t)) { closeList(); out.push('<hr>'); continue; }
    if (!t) { closeList(); out.push(''); continue; }
    closeList(); out.push('<p>' + inlineMd(line) + '</p>');
  }
  closeList();
  let html = out.join('\n');
  html = html.replace(new RegExp(SEP + 'CODE(\\d+)' + SEP, 'g'), (m, i) => {
    const code = blocks[i] || '';
    return '<div class="codeblock"><button class="copy-btn" data-code="' +
      encodeURIComponent(code) + '">Copy</button><pre><code>' + escapeHtml(code) + '</code></pre></div>';
  });
  return html;
}

function inlineMd(s) {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
}

// Copy buttons inside code blocks (event-delegated).
document.getElementById('messages').addEventListener('click', (e) => {
  const btn = e.target.closest && e.target.closest('.copy-btn');
  if (!btn) return;
  const code = decodeURIComponent(btn.dataset.code || '');
  navigator.clipboard?.writeText(code).then(() => {
    const prev = btn.textContent; btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = prev; }, 1200);
  }).catch(() => {});
});

// ── Context pills ──
const contextFileSet = new Set();
function trackContextFile(filePath) {
  if (!filePath || contextFileSet.has(filePath)) return;
  contextFileSet.add(filePath);
  const pill = document.createElement('div');
  pill.className = 'file-pill';
  const name = filePath.split(/[\\/]/).pop();
  pill.innerHTML = '<span>' + name + '</span><button title="Drop">×</button>';
  pill.querySelector('button').addEventListener('click', () => {
    vscode.postMessage({ type: 'dropFile', path: filePath });
    pill.remove();
    contextFileSet.delete(filePath);
  });
  contextFiles.appendChild(pill);
}

// ── Context-files strip (chips of what aider currently has loaded) ──
function renderContextFiles(files) {
  contextFiles.innerHTML = '';
  (files || []).forEach(rel => {
    if (/(^|\/)REPO_MAP\.md$/.test(rel)) return; // map is implicit/pinned
    const name = rel.split('/').pop();
    const pill = document.createElement('div');
    pill.className = 'file-pill';
    const span = document.createElement('span');
    span.textContent = name; span.title = rel;
    const btn = document.createElement('button');
    btn.textContent = '×'; btn.title = 'Drop from context';
    btn.addEventListener('click', () => vscode.postMessage({ type: 'dropContext', rel }));
    pill.appendChild(span); pill.appendChild(btn);
    contextFiles.appendChild(pill);
  });
}

// ── @file autocomplete ──
let allFiles = [];
let acItems = [], acIndex = -1;
const acBox = document.getElementById('at-complete');

function currentAtQuery() {
  const v = inputEl.value, pos = inputEl.selectionStart;
  const upto = v.slice(0, pos);
  const m = upto.match(/@([^\s@]*)$/);
  return m ? { q: m[1].toLowerCase(), start: pos - m[0].length, end: pos } : null;
}

function updateAutocomplete() {
  const at = currentAtQuery();
  if (!at) { hideAutocomplete(); return; }
  const q = at.q;
  acItems = allFiles
    .filter(f => { const b = f.toLowerCase(); return q === '' ? true : b.includes(q) || b.split('/').pop().includes(q); })
    .slice(0, 8);
  if (!acItems.length) { hideAutocomplete(); return; }
  acIndex = 0;
  acBox.innerHTML = '';
  acItems.forEach((f, i) => {
    const row = document.createElement('div');
    row.className = 'ac-item' + (i === 0 ? ' active' : '');
    row.textContent = f;
    row.addEventListener('mousedown', e => { e.preventDefault(); pickAutocomplete(i); });
    acBox.appendChild(row);
  });
  acBox.style.display = 'block';
}

function hideAutocomplete() { acBox.style.display = 'none'; acItems = []; acIndex = -1; }

function refreshAcActive() {
  [...acBox.children].forEach((c, i) => c.classList.toggle('active', i === acIndex));
  const el = acBox.children[acIndex];
  if (el) el.scrollIntoView({ block: 'nearest' });
}

function acVisible() { return acBox.style.display === 'block' && acItems.length > 0; }

function pickAutocomplete(i) {
  const at = currentAtQuery();
  if (!at || !acItems[i]) { hideAutocomplete(); return; }
  const v = inputEl.value;
  const name = acItems[i].split('/').pop();
  inputEl.value = v.slice(0, at.start) + '@' + name + ' ' + v.slice(at.end);
  const caret = at.start + name.length + 2;
  inputEl.setSelectionRange(caret, caret);
  hideAutocomplete();
  inputEl.focus();
}

inputEl.addEventListener('input', updateAutocomplete);

// ── Send ──
function send() {
  const text = inputEl.value.trim();
  if (!text) return;
  vscode.postMessage({ type: 'send', text });
  inputEl.value = '';
  inputEl.style.height = 'auto';
}
sendBtn.addEventListener('click', () => {
  if (sendBtn.dataset.mode === 'stop') { vscode.postMessage({ type: 'stopAider' }); return; }
  send();
});
inputEl.addEventListener('keydown', e => {
  if (acVisible()) {
    if (e.key === 'ArrowDown') { e.preventDefault(); acIndex = (acIndex + 1) % acItems.length; refreshAcActive(); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); acIndex = (acIndex - 1 + acItems.length) % acItems.length; refreshAcActive(); return; }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickAutocomplete(acIndex); return; }
    if (e.key === 'Escape') { e.preventDefault(); hideAutocomplete(); return; }
  }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
inputEl.addEventListener('input', () => {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
});

// ── Header buttons ──
document.getElementById('btn-new').addEventListener('click', () => vscode.postMessage({ type: 'newSession' }));
document.getElementById('btn-memory').addEventListener('click', () => vscode.postMessage({ type: 'saveMemory' }));
document.getElementById('btn-undo').addEventListener('click', () => vscode.postMessage({ type: 'undo' }));
document.getElementById('btn-stop').addEventListener('click', () => vscode.postMessage({ type: 'stopAider' }));

// Model-warnings debug toggle (sidebar control, backed by the setting)
const btnWarnings = document.getElementById('btn-warnings');
let modelWarningsOn = window.__INIT__ ? !!window.__INIT__.modelWarnings : false;
function setWarningsButton(on) {
  modelWarningsOn = on;
  btnWarnings.classList.toggle('active', on);
  btnWarnings.title = on
    ? 'Debug: model warnings ON — click to hide (restarts aider)'
    : 'Debug: show aider model warnings (restarts aider)';
}
setWarningsButton(modelWarningsOn);
btnWarnings.addEventListener('click', () => vscode.postMessage({ type: 'toggleModelWarnings' }));

document.querySelectorAll('.hint-btn').forEach(btn => {
  btn.addEventListener('click', () => { inputEl.value += btn.dataset.insert; inputEl.focus(); });
});

// ── Sessions panel ──
let allSessions = [];
let activeSessionId = '';

document.getElementById('btn-sessions').addEventListener('click', () => {
  vscode.postMessage({ type: 'getSessions' });
  document.getElementById('sessions-panel').style.display = 'flex';
  document.getElementById('messages').style.display = 'none';
  document.getElementById('input-area').style.display = 'none';
  document.getElementById('context-files').style.display = 'none';
});

document.getElementById('btn-close-sessions').addEventListener('click', closeSessions);

function closeSessions() {
  document.getElementById('sessions-panel').style.display = 'none';
  document.getElementById('messages').style.display = 'flex';
  document.getElementById('input-area').style.display = 'flex';
  document.getElementById('context-files').style.display = 'flex';
}

function renderSessions(sessions, aId) {
  allSessions = sessions;
  activeSessionId = aId;
  const list = document.getElementById('sessions-list');
  list.innerHTML = '';
  if (!sessions.length) {
    list.innerHTML = '<div style="opacity:.5;font-size:11px;padding:8px">No sessions yet.</div>';
    return;
  }
  sessions.forEach(s => {
    const card = document.createElement('div');
    card.className = 'session-card' + (s.id === aId ? ' active' : '');
    const date = new Date(s.createdAt).toLocaleString();
    const preview = s.messages.length
      ? s.messages.find(m => m.role === 'user')?.content?.slice(0, 60) + '...'
      : 'Empty session';
    card.innerHTML =
      '<div class="sc-title">' + (s.providerLabel || 'Session') + (s.id === aId ? ' ● active' : '') + '</div>' +
      '<div class="sc-meta">' + date + ' · ' + s.messages.length + ' messages</div>' +
      '<div class="sc-meta" style="margin-top:2px;opacity:.5">' + (preview || '') + '</div>' +
      '<div class="sc-actions">' +
        '<button data-id="' + s.id + '" data-action="load">Load</button>' +
        '<button data-id="' + s.id + '" data-action="clear">Clear</button>' +
        '<button data-id="' + s.id + '" data-action="delete" style="color:var(--vscode-errorForeground)">Delete</button>' +
      '</div>';
    list.appendChild(card);
  });

  list.querySelectorAll('.sc-actions button').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const id = btn.dataset.id;
      const action = btn.dataset.action;
      vscode.postMessage({ type: 'sessionAction', action, sessionId: id });
      if (action === 'load') closeSessions();
    });
  });
}

// ── Streaming ──
let streamDiv = null;
let streamBody = null;
let streamContent = '';

function startStreaming() {
  if (streamDiv) endStreaming();
  if (emptyState) emptyState.style.display = 'none';
  streamDiv = document.createElement('div');
  streamDiv.className = 'msg assistant streaming';
  streamBody = document.createElement('div');
  streamBody.className = 'msg-body';
  streamDiv.appendChild(streamBody);
  messagesEl.appendChild(streamDiv);
  streamContent = '';
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function appendStream(text) {
  const noiseStarts = ["Can't initialize", 'Warning:', 'Tokens:', 'Cost:', 'Aider v0', 'Model:',
    'Git repo:', 'Repo-map:', 'Added ', 'Aider respects', 'For more info', 'https://aider.chat',
    'You can use /undo', 'aider>'];
  const clean = text.split('\n').filter(l => {
    const t = l.trim();
    if (!t) return true;
    if (t === '>') return false;
    if (/\(read only\)\s*$/.test(t)) return false;       // read-only files bar
    return !noiseStarts.some(n => t.startsWith(n));
  }).join('\n');
  if (!clean.trim()) return;
  if (!streamDiv) startStreaming();                        // create the bubble lazily
  streamContent += clean;
  streamBody.innerHTML = renderMarkdown(streamContent);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function endStreaming() {
  if (!streamDiv) return;
  streamDiv.classList.remove('streaming');
  streamDiv = null;
  streamBody = null;
  streamContent = '';
}

// ── Confirm dialog ──
function showConfirm(promptText) {
  endStreaming();
  const div = document.createElement('div');
  div.className = 'msg confirm';
  div.innerHTML =
    '<div class="msg-role">Aider wants to apply edits</div>' +
    '<div class="msg-body" style="background:var(--vscode-inputValidation-warningBackground);border:1px solid var(--vscode-inputValidation-warningBorder);border-radius:6px;padding:10px">' +
      '<div style="font-size:11px;margin-bottom:8px;opacity:.8">' + formatText(promptText) + '</div>' +
      '<div style="display:flex;gap:8px">' +
        '<button id="confirm-yes" style="background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;border-radius:4px;padding:5px 14px;cursor:pointer;font-size:12px">✓ Apply</button>' +
        '<button id="confirm-no" style="background:none;border:1px solid var(--vscode-input-border);color:var(--vscode-foreground);border-radius:4px;padding:5px 14px;cursor:pointer;font-size:12px">✗ Reject</button>' +
      '</div>' +
    '</div>';
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  div.querySelector('#confirm-yes').addEventListener('click', () => {
    vscode.postMessage({ type: 'confirmEdit' });
    div.querySelector('#confirm-yes').disabled = true;
    div.querySelector('#confirm-no').disabled = true;
    div.querySelector('#confirm-yes').textContent = '✓ Applied';
  });
  div.querySelector('#confirm-no').addEventListener('click', () => {
    vscode.postMessage({ type: 'denyEdit' });
    div.querySelector('#confirm-yes').disabled = true;
    div.querySelector('#confirm-no').disabled = true;
    div.querySelector('#confirm-no').textContent = '✗ Rejected';
  });
}

// ── Inline diff card (accept/reject) ──
function renderDiffCard(file, fullPath, hunks) {
  if (emptyState) emptyState.style.display = 'none';
  endStreaming();
  const adds = hunks.filter(h => h.t === 'add').length;
  const dels = hunks.filter(h => h.t === 'del').length;
  const body = hunks.map(h => {
    const cls = h.t === 'add' ? 'd-add' : h.t === 'del' ? 'd-del' : 'd-ctx';
    const pfx = h.t === 'add' ? '+' : h.t === 'del' ? '-' : ' ';
    return '<div class="' + cls + '">' + escapeHtml(pfx + ' ' + h.s) + '</div>';
  }).join('');
  const div = document.createElement('div');
  div.className = 'msg diff-card';
  div.innerHTML =
    '<div class="diff-head"><span class="diff-file">✏️ ' + escapeHtml(file) + '</span>' +
      '<span class="diff-stat"><span class="d-addc">+' + adds + '</span> <span class="d-delc">−' + dels + '</span></span></div>' +
    '<div class="diff-body">' + body + '</div>' +
    '<div class="diff-actions">' +
      '<button class="diff-keep">✓ Keep</button>' +
      '<button class="diff-undo">↩ Undo</button>' +
      '<button class="diff-view">⤢ Open full diff</button>' +
    '</div>';
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;

  const collapse = (label) => {
    const b = div.querySelector('.diff-body'); if (b) b.style.display = 'none';
    const a = div.querySelector('.diff-actions'); if (a) a.remove();
    const s = div.querySelector('.diff-stat'); if (s) s.textContent = label;
  };
  div.querySelector('.diff-keep').addEventListener('click', () => collapse('✓ Kept'));
  div.querySelector('.diff-undo').addEventListener('click', () => { vscode.postMessage({ type: 'undo' }); collapse('↩ Undone'); });
  div.querySelector('.diff-view').addEventListener('click', () => vscode.postMessage({ type: 'openDiff', filePath: fullPath }));
}

// ── Commit card ──
function showCommit(commitMsg) {
  if (emptyState) emptyState.style.display = 'none';
  const div = document.createElement('div');
  div.className = 'msg commit-card';
  div.innerHTML =
    '<div class="msg-body" style="background:var(--vscode-editor-background);border:1px solid var(--vscode-gitDecoration-addedResourceForeground);border-radius:6px;padding:8px 10px;display:flex;align-items:center;justify-content:space-between;gap:8px">' +
      '<span style="font-size:11px;color:var(--vscode-gitDecoration-addedResourceForeground)">✓ Committed: ' + formatText(commitMsg) + '</span>' +
      '<button id="undo-btn-' + Date.now() + '" style="background:none;border:1px solid var(--vscode-input-border);color:var(--vscode-foreground);border-radius:3px;padding:2px 8px;font-size:10px;cursor:pointer;flex-shrink:0">↩ Undo</button>' +
    '</div>';
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  div.querySelector('button').addEventListener('click', function () {
    vscode.postMessage({ type: 'undo' });
    this.textContent = 'Undone';
    this.disabled = true;
    div.querySelector('span').style.textDecoration = 'line-through';
    div.querySelector('span').style.opacity = '.5';
  });
}

// ── Custom provider modal ──
const customModal = document.getElementById('custom-modal');
const cpLabel = document.getElementById('cp-label');
const cpModel = document.getElementById('cp-model');
const cpEnv = document.getElementById('cp-env');
const cpKey = document.getElementById('cp-key');
const cpFree = document.getElementById('cp-free');
const cpError = document.getElementById('cp-error');
const cpSave = document.getElementById('cp-save');

// Mirror of registry.inferApiKeyEnv — pre-fills the env var from the model id.
function inferEnv(model) {
  const prefix = (model.split('/')[0] || '').toLowerCase();
  const map = {
    openrouter: 'OPENROUTER_API_KEY', openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY',
    claude: 'ANTHROPIC_API_KEY', gemini: 'GEMINI_API_KEY', google: 'GEMINI_API_KEY',
    groq: 'GROQ_API_KEY', deepseek: 'DEEPSEEK_API_KEY', mistral: 'MISTRAL_API_KEY',
    codestral: 'MISTRAL_API_KEY', together: 'TOGETHER_API_KEY', cohere: 'COHERE_API_KEY',
    fireworks: 'FIREWORKS_API_KEY', xai: 'XAI_API_KEY', ollama: 'OLLAMA_API_KEY',
  };
  if (map[prefix]) return map[prefix];
  return prefix ? prefix.toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_API_KEY' : '';
}

function openCustomModal() {
  cpLabel.value = ''; cpModel.value = ''; cpEnv.value = ''; cpKey.value = '';
  cpFree.checked = false; cpError.textContent = '';
  cpEnv.dataset.touched = '';
  cpSave.disabled = false; cpSave.textContent = 'Add & Connect';
  customModal.style.display = 'flex';
  cpLabel.focus();
}

cpModel.addEventListener('input', () => {
  if (!cpEnv.dataset.touched) cpEnv.value = inferEnv(cpModel.value.trim());
});
cpEnv.addEventListener('input', () => { cpEnv.dataset.touched = '1'; });

document.getElementById('cp-cancel').addEventListener('click', () => {
  customModal.style.display = 'none';
});

cpSave.addEventListener('click', () => {
  const label = cpLabel.value.trim();
  const model = cpModel.value.trim();
  const apiKeyEnv = cpEnv.value.trim();
  const key = cpKey.value.trim();
  if (!label || !model || !key) {
    cpError.textContent = 'Name, model id, and API key are all required.';
    return;
  }
  cpSave.disabled = true; cpSave.textContent = 'Resolving…';
  cpError.textContent = '';
  vscode.postMessage({ type: 'addCustomProvider', label, model, apiKeyEnv, key, freetier: cpFree.checked });
});

function handleCustomProviderResult(msg) {
  if (msg.providers) Object.assign(providers, msg.providers);
  if (msg.keyStatus) keyStatus = msg.keyStatus;
  const selected = msg.activeProviderId || msg.providerId;
  if (msg.ok) {
    if (msg.providerId) keyStatus[msg.providerId] = true;
    customModal.style.display = 'none';
    showChat([], 'starting');
    refreshProviderOptions(selected);
  } else {
    // Couldn't resolve — keep the modal open and print the error, but also reflect
    // the (now-saved) provider in the dropdown so it's selectable to retry/fix.
    cpError.textContent = msg.error || 'Could not resolve this provider.';
    cpSave.disabled = false; cpSave.textContent = 'Add & Connect';
    if (selected) refreshProviderOptions(selected);
  }
}

// ── Boot ──
// Setup screen is visible by default in HTML (display:flex via CSS).
// Provider cards are rendered here from embedded data.
if (Object.keys(providers).length > 0) {
  renderProviderList(activeId);
  if (activeId) selectSetupProvider(activeId);
} else {
  setupEl.innerHTML = '<h2 style="font-size:13px;font-weight:600;opacity:.8">⚠ No Providers Configured</h2>' +
    '<p style="font-size:11px;opacity:.6;line-height:1.5">Check your VS Code settings under aiderStudio.providers.</p>';
}
