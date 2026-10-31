'use strict';

// ===== 設定 =====
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_MODEL = 'gemini-flash-latest';
const MAX_CONTEXT_MESSAGES = 30; // APIに送る直近の会話数（無料枠のトークン節約）
const MAX_STORED_MESSAGES = 200;
const DEFAULT_SYSTEM_PROMPT = `あなたは「Jervis（ジャーヴィス）」という名前の、ユーザー専属のAIアシスタントです。
・日本語で、落ち着いた丁寧な口調で話します。ユーザーのことは「ボス」と呼びます。
・結論から先に、短く答えます。長い説明が必要なときだけ詳しくします。
・ユーザーは音声入力を使うため、誤変換や言い直しがあっても文脈から意図を汲み取ります。
・わからないこと、確かでないことは推測で断定せず、その旨を伝えます。
・必要なら、次にやるべきことを1つ提案します。`;

const KEYS = {
  apiKey: 'jervis.apiKey',
  model: 'jervis.model',
  systemPrompt: 'jervis.systemPrompt',
  history: 'jervis.history',
  speak: 'jervis.speak',
};

// ===== 保存（使えない環境でも落ちないように） =====
const store = {
  get(k, fallback = null) {
    try { const v = localStorage.getItem(k); return v === null ? fallback : v; } catch { return fallback; }
  },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* 保存できなくても動作は続ける */ } },
  remove(k) { try { localStorage.removeItem(k); } catch { /* noop */ } },
};

function loadHistory() {
  try { const h = JSON.parse(store.get(KEYS.history, '[]')); return Array.isArray(h) ? h : []; } catch { return []; }
}
function saveHistory() {
  store.set(KEYS.history, JSON.stringify(history.slice(-MAX_STORED_MESSAGES)));
}

// ===== 状態 =====
let history = loadHistory(); // [{role:'user'|'model', text:string}]
let busy = false;

const $ = (id) => document.getElementById(id);
const log = $('log');
const input = $('input');
const sendBtn = $('sendBtn');
const micBtn = $('micBtn');
const speakToggle = $('speakToggle');
const settings = $('settings');

// ===== 表示 =====
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// 最低限のMarkdown（コード、太字）だけ表示を整える
function renderText(text) {
  let html = escapeHtml(text);
  html = html.replace(/```[\w-]*\n?([\s\S]*?)```/g, (_, code) => `<pre>${code}</pre>`);
  html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  return html;
}

function addBubble(role, text) {
  const empty = log.querySelector('.empty');
  if (empty) empty.remove();
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  div.innerHTML = renderText(text);
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
  return div;
}

function renderAll() {
  log.innerHTML = '';
  if (history.length === 0) {
    const p = document.createElement('div');
    p.className = 'empty';
    p.innerHTML = store.get(KEYS.apiKey)
      ? 'おかえりなさい、ボス。<br>何をお手伝いしましょうか。'
      : 'はじめまして、Jervisです。<br>右上の ⚙️ からGemini APIキーを設定してください。';
    log.appendChild(p);
    return;
  }
  history.forEach((m) => addBubble(m.role, m.text));
}

// ===== APIキーの整形とチェック =====
// コピー時に混ざりやすい空白・改行・見えない文字を除き、全角英数字を半角にする
function cleanKey(raw) {
  return String(raw || '')
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[\s\u200B-\u200D\uFEFF]/g, '');
}
// Googleのキーは通常「AIza」で始まる39文字
function keyProblem(key) {
  if (!key) return 'APIキーが未入力です。';
  if (!key.startsWith('AIza')) return `キーが「AIza」で始まっていません（先頭: ${key.slice(0, 4)}…）。キー以外の文字列をコピーしている可能性があります。`;
  if (key.length !== 39) return `キーの文字数が${key.length}文字です（正しいキーは39文字）。コピーが途中で切れているか、余分な文字が入っています。`;
  return '';
}

// ===== Gemini API =====
// 混雑（5xx）や回数上限（429）のときに順に試す予備のモデル
const FALLBACK_MODELS = ['gemini-2.5-flash', 'gemini-flash-lite-latest', 'gemini-2.5-flash-lite'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class ApiError extends Error {
  constructor(status, data, model) {
    super(explainError(status, data, model));
    this.status = status;
  }
}

const REQUEST_TIMEOUT_MS = 40000; // これを過ぎても返事がなければ、混雑とみなして次のモデルへ

async function requestModel(model, body, apiKey) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  let res, data;
  try {
    res = await fetch(`${API_BASE}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    data = await res.json().catch(() => ({}));
  } catch (e) {
    // 時間切れ・通信断は「一時的なエラー」と同じ扱いにして再試行・切り替えさせる
    const reason = e.name === 'AbortError' ? `${REQUEST_TIMEOUT_MS / 1000}秒以内に返事がありませんでした` : '通信できませんでした（電波を確認してください）';
    throw new ApiError(504, { error: { message: reason } }, model);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new ApiError(res.status, data, model);

  const cand = data.candidates && data.candidates[0];
  const text = cand && cand.content && cand.content.parts
    ? cand.content.parts.map((p) => p.text || '').join('').trim()
    : '';
  if (!text) {
    const reason = (cand && cand.finishReason) || (data.promptFeedback && data.promptFeedback.blockReason) || '不明';
    throw new Error(`返答が空でした（理由: ${reason}）。言い方を変えてもう一度試してください。`);
  }
  return text;
}

// onStatus: 再試行中などの状況を画面に出すためのコールバック
async function callGemini(messages, onStatus = () => {}) {
  const apiKey = cleanKey(store.get(KEYS.apiKey, ''));
  if (!apiKey) throw new Error('APIキーが未設定です。右上の ⚙️ から設定してください。');
  const primary = store.get(KEYS.model, DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const models = [primary, ...FALLBACK_MODELS.filter((m) => m !== primary)];

  const body = {
    systemInstruction: { parts: [{ text: store.get(KEYS.systemPrompt, DEFAULT_SYSTEM_PROMPT) + '\n' + memoSystemPrompt() }] },
    contents: messages.slice(-MAX_CONTEXT_MESSAGES).map((m) => ({ role: m.role, parts: [{ text: m.text }] })),
  };

  let lastError;
  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const text = await requestModel(model, body, apiKey);
        return { text, model };
      } catch (e) {
        lastError = e;
        const s = e.status;
        if (!s || s === 400 || s === 401 || s === 403) throw e; // キーや内容の問題は再試行しても直らない
        if (s >= 500 && s !== 504 && attempt === 0) {
          onStatus(`混み合っています。もう一度試しています…（${model}）`);
          await sleep(1500);
          continue;
        }
        break; // 404・429・再度の5xx → 次のモデルへ
      }
    }
    const next = models[models.indexOf(model) + 1];
    if (next) onStatus(`別のモデルで試しています…（${next}）`);
  }
  throw lastError;
}

function explainError(status, data, model) {
  const msg = (data && data.error && data.error.message) || '';
  model = model || store.get(KEYS.model, DEFAULT_MODEL);
  if (status === 400 && /API key/i.test(msg)) {
    const hint = keyProblem(store.get(KEYS.apiKey, ''));
    return `APIキーが正しくないようです。${hint || 'キーを作り直して貼り直してください。'}（Googleの応答: ${msg}）`;
  }
  if (status === 403) return 'APIキーに権限がありません。キーを作り直すか、設定を確認してください。';
  if (status === 404) return `モデル「${model}」が見つかりません。設定の「一覧取得」で使えるモデルを選んでください。`;
  if (status === 429) return '無料枠の利用上限に達しました。少し時間をおいてから試してください（1日の上限は太平洋時間の0時＝日本時間16〜17時ごろにリセット）。';
  if (status >= 500) return `Google側が混み合っているか、一時的なエラーです。予備のモデルでも返事がありませんでした。数分待ってから試してください。（${status}: ${msg || '詳細なし'}）`;
  return `エラー（${status}）: ${msg || '原因不明'}`;
}

async function listModels() {
  const apiKey = cleanKey(store.get(KEYS.apiKey, ''));
  if (!apiKey) throw new Error('先にAPIキーを入力してください。');
  const res = await fetch(`${API_BASE}/models?pageSize=200`, { headers: { 'x-goog-api-key': apiKey } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(explainError(res.status, data));
  return (data.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => m.name.replace(/^models\//, ''))
    .filter((n) => /gemini/i.test(n) && !/(image|tts|embedding|audio|live|vision)/i.test(n));
}

// ===== 送信 =====
async function send(text) {
  text = text.trim();
  if (!text || busy) return;
  busy = true;
  sendBtn.disabled = true;

  history.push({ role: 'user', text });
  saveHistory();
  const userBubble = addBubble('user', text);
  input.value = '';
  autoResize();

  const thinking = addBubble('model thinking', '考えています…');
  try {
    const { text: raw, model } = await callGemini(history, (msg) => { thinking.textContent = msg; });
    thinking.remove();
    // 返答に含まれるメモ操作の命令を実行し、命令部分は表示しない
    const { text: shown, results } = applyMemoCommands(raw);
    const reply = shown || results.join('\n') || '（返答なし）';
    history.push({ role: 'model', text: reply });
    saveHistory();
    addBubble('model', reply);
    results.forEach((r) => addBubble('note memo-note', r));
    if (results.length) renderMemos();
    const primary = store.get(KEYS.model, DEFAULT_MODEL).trim() || DEFAULT_MODEL;
    if (model !== primary) addBubble('note', `※混雑のため ${model} で返答しました`);
    speak(reply);
  } catch (e) {
    thinking.remove();
    userBubble.remove(); // 入力欄に戻すので、送れなかった発言は画面からも消す
    // 失敗した発言は履歴から外す（次回送信時にuserが連続しないように）
    history.pop();
    saveHistory();
    addBubble('error', e.message || String(e));
    input.value = text; // 打ち直さなくて済むように戻す
    autoResize();
  } finally {
    busy = false;
    sendBtn.disabled = false;
  }
}

$('composer').addEventListener('submit', (e) => {
  e.preventDefault();
  send(input.value);
});

function autoResize() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 140) + 'px';
}
input.addEventListener('input', autoResize);

// ===== 読み上げ =====
function speakEnabled() { return store.get(KEYS.speak) === '1'; }
function updateSpeakButton() {
  const on = speakEnabled();
  speakToggle.textContent = on ? '🔊' : '🔇';
  speakToggle.setAttribute('aria-pressed', String(on));
}
function speak(text) {
  if (!speakEnabled() || !('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();
  const plain = text.replace(/```[\s\S]*?```/g, '（コードは省略）').replace(/[*`#]/g, '');
  const u = new SpeechSynthesisUtterance(plain);
  u.lang = 'ja-JP';
  u.rate = 1.1;
  window.speechSynthesis.speak(u);
}
speakToggle.addEventListener('click', () => {
  store.set(KEYS.speak, speakEnabled() ? '0' : '1');
  updateSpeakButton();
  if (!speakEnabled() && 'speechSynthesis' in window) window.speechSynthesis.cancel();
  // iOSは最初の読み上げをタップ操作の中で始める必要があるため、ここで短く鳴らしておく
  if (speakEnabled() && 'speechSynthesis' in window) {
    const u = new SpeechSynthesisUtterance('読み上げをオンにしました');
    u.lang = 'ja-JP';
    window.speechSynthesis.speak(u);
  }
});

// ===== 音声入力（対応ブラウザのみ。非対応ならキーボードのマイクを使う） =====
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
if (Recognition) {
  micBtn.hidden = false;
  let rec = null;
  micBtn.addEventListener('click', () => {
    if (rec) { rec.stop(); return; }
    rec = new Recognition();
    rec.lang = 'ja-JP';
    rec.interimResults = true;
    rec.continuous = false;
    const base = input.value;
    rec.onresult = (ev) => {
      let t = '';
      for (const r of ev.results) t += r[0].transcript;
      input.value = base + t;
      autoResize();
    };
    rec.onerror = (ev) => {
      if (ev.error === 'not-allowed') addBubble('error', 'マイクの使用が許可されていません。キーボードのマイクボタンでも音声入力できます。');
    };
    rec.onend = () => {
      micBtn.classList.remove('listening');
      rec = null;
      if (input.value.trim() && input.value !== base) send(input.value);
    };
    micBtn.classList.add('listening');
    rec.start();
  });
}

// ===== 設定画面 =====
$('openSettings').addEventListener('click', () => {
  $('apiKey').value = store.get(KEYS.apiKey, '');
  $('model').value = store.get(KEYS.model, DEFAULT_MODEL);
  $('systemPrompt').value = store.get(KEYS.systemPrompt, DEFAULT_SYSTEM_PROMPT);
  settings.showModal();
});
settings.addEventListener('close', () => {
  store.set(KEYS.apiKey, cleanKey($('apiKey').value));
  store.set(KEYS.model, $('model').value.trim() || DEFAULT_MODEL);
  store.set(KEYS.systemPrompt, $('systemPrompt').value.trim() || DEFAULT_SYSTEM_PROMPT);
  if (history.length === 0) renderAll();
});
$('resetPrompt').addEventListener('click', () => { $('systemPrompt').value = DEFAULT_SYSTEM_PROMPT; });
$('clearHistory').addEventListener('click', () => {
  if (!confirm('会話履歴をすべて消します。よろしいですか？')) return;
  history = [];
  store.remove(KEYS.history);
  renderAll();
});
$('loadModels').addEventListener('click', async () => {
  const hint = $('modelHint');
  const key = cleanKey($('apiKey').value);
  $('apiKey').value = key;
  store.set(KEYS.apiKey, key);
  const problem = keyProblem(key);
  hint.textContent = '取得中…';
  try {
    const names = await listModels();
    $('modelList').innerHTML = names.map((n) => `<option value="${escapeHtml(n)}">`).join('');
    hint.textContent = names.length
      ? `使えるモデル: ${names.join(', ')}（入力欄をタップすると候補が出ます）`
      : '使えるモデルが見つかりませんでした。';
  } catch (e) {
    hint.textContent = problem && !e.message.includes(problem) ? `${e.message} ${problem}` : e.message;
  }
});

// キーの表示・非表示（貼り付けた内容を目で確認できるように）
$('toggleKey').addEventListener('click', () => {
  const el = $('apiKey');
  const show = el.type === 'password';
  el.type = show ? 'text' : 'password';
  $('toggleKey').textContent = show ? '隠す' : '表示';
});

// ===== メモ画面 =====
const memoDialog = $('memoDialog');

function memoItem(m) {
  const li = document.createElement('li');
  li.className = 'memo-item' + (m.done ? ' done' : '') + (!m.done && m.due && m.due < todayYmd() ? ' overdue' : '') + (!m.done && m.due === todayYmd() ? ' today' : '');
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = !!m.done;
  cb.setAttribute('aria-label', '完了');
  cb.addEventListener('change', () => { Memo.setDone(m.id, cb.checked); renderMemos(); });
  const body = document.createElement('div');
  body.className = 'memo-body';
  const t = document.createElement('div');
  t.textContent = m.text;
  body.appendChild(t);
  if (m.due) {
    const d = document.createElement('div');
    d.className = 'memo-due';
    d.textContent = dueLabel(m.due);
    body.appendChild(d);
  }
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'memo-del';
  del.textContent = '削除';
  del.addEventListener('click', () => {
    if (!confirm(`「${m.text}」を削除しますか？`)) return;
    Memo.remove(m.id);
    renderMemos();
  });
  li.append(cb, body, del);
  return li;
}

function renderMemos() {
  const open = Memo.open();
  const done = Memo.load().filter((m) => m.done).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0)).slice(0, 10);
  const openList = $('memoOpen');
  const doneList = $('memoDone');
  openList.replaceChildren(...open.map(memoItem));
  doneList.replaceChildren(...done.map(memoItem));
  $('memoEmpty').hidden = open.length > 0;
  $('memoDoneWrap').hidden = done.length === 0;
  const badge = $('memoBadge');
  badge.textContent = open.length;
  badge.hidden = open.length === 0;
}

$('openMemo').addEventListener('click', () => { renderMemos(); memoDialog.showModal(); });
$('memoAddForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('memoText').value.trim();
  if (!text) return;
  Memo.add(text, $('memoDue').value);
  $('memoText').value = '';
  $('memoDue').value = '';
  renderMemos();
});

// ===== 起動 =====
renderMemos();
updateSpeakButton();
renderAll();
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => { /* オフラインキャッシュなしでも動く */ });
}
