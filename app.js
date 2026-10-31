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
async function callGemini(messages) {
  const apiKey = cleanKey(store.get(KEYS.apiKey, ''));
  if (!apiKey) throw new Error('APIキーが未設定です。右上の ⚙️ から設定してください。');
  const model = store.get(KEYS.model, DEFAULT_MODEL).trim() || DEFAULT_MODEL;

  const body = {
    systemInstruction: { parts: [{ text: store.get(KEYS.systemPrompt, DEFAULT_SYSTEM_PROMPT) }] },
    contents: messages.slice(-MAX_CONTEXT_MESSAGES).map((m) => ({ role: m.role, parts: [{ text: m.text }] })),
  };

  const res = await fetch(`${API_BASE}/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(explainError(res.status, data));

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

function explainError(status, data) {
  const msg = (data && data.error && data.error.message) || '';
  if (status === 400 && /API key/i.test(msg)) {
    const hint = keyProblem(store.get(KEYS.apiKey, ''));
    return `APIキーが正しくないようです。${hint || 'キーを作り直して貼り直してください。'}（Googleの応答: ${msg}）`;
  }
  if (status === 403) return 'APIキーに権限がありません。キーを作り直すか、設定を確認してください。';
  if (status === 404) return `モデル「${store.get(KEYS.model, DEFAULT_MODEL)}」が見つかりません。設定の「一覧取得」で使えるモデルを選んでください。`;
  if (status === 429) return '無料枠の利用上限に達しました。少し時間をおいてから試してください（1日の上限は太平洋時間の0時＝日本時間16〜17時ごろにリセット）。';
  if (status >= 500) return 'Google側で一時的なエラーが出ています。少し待ってから試してください。';
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
  addBubble('user', text);
  input.value = '';
  autoResize();

  const thinking = addBubble('model thinking', '考えています…');
  try {
    const reply = await callGemini(history);
    thinking.remove();
    history.push({ role: 'model', text: reply });
    saveHistory();
    addBubble('model', reply);
    speak(reply);
  } catch (e) {
    thinking.remove();
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

// ===== 起動 =====
updateSpeakButton();
renderAll();
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => { /* オフラインキャッシュなしでも動く */ });
}
