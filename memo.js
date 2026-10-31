'use strict';
// ===== メモ・ToDo =====
// 会話の中でJervisが返答の末尾に書く命令（<<memo-add|...>> など）を読み取り、端末内のメモを更新する。
// API呼び出しを増やさないよう、関数呼び出しではなく返答内の目印で操作する。

const MEMO_KEY = 'jervis.memos';
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

const Memo = {
  load() {
    try {
      const m = JSON.parse(localStorage.getItem(MEMO_KEY) || '[]');
      return Array.isArray(m) ? m : [];
    } catch { return []; }
  },
  save(list) {
    try { localStorage.setItem(MEMO_KEY, JSON.stringify(list)); } catch { /* 保存できない環境でも落とさない */ }
  },
  nextId(list) {
    return list.reduce((max, m) => Math.max(max, m.id), 0) + 1;
  },
  add(text, due = '') {
    const list = Memo.load();
    const memo = { id: Memo.nextId(list), text: text.trim(), due: normalizeDate(due), done: false, createdAt: Date.now() };
    if (!memo.text) return null;
    list.push(memo);
    Memo.save(list);
    return memo;
  },
  setDone(id, done = true) {
    const list = Memo.load();
    const m = list.find((x) => x.id === Number(id));
    if (!m) return null;
    m.done = done;
    m.doneAt = done ? Date.now() : undefined;
    Memo.save(list);
    return m;
  },
  remove(id) {
    const list = Memo.load();
    const m = list.find((x) => x.id === Number(id));
    if (!m) return null;
    Memo.save(list.filter((x) => x.id !== m.id));
    return m;
  },
  open() {
    return Memo.load().filter((m) => !m.done).sort(compareMemo);
  },
};

// 期限ありを先（日付順）、期限なしは登録順
function compareMemo(a, b) {
  if (a.due && b.due) return a.due.localeCompare(b.due) || a.id - b.id;
  if (a.due) return -1;
  if (b.due) return 1;
  return a.id - b.id;
}

function pad(n) { return String(n).padStart(2, '0'); }
function toYmd(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function todayYmd() { return toYmd(new Date()); }

function normalizeDate(s) {
  s = String(s || '').trim().replace(/[／/.]/g, '-');
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  return m ? `${m[1]}-${pad(m[2])}-${pad(m[3])}` : '';
}

// 「10/31(金)」「今日」「明日」「期限切れ」のような表示
function dueLabel(due) {
  if (!due) return '';
  const today = todayYmd();
  const d = new Date(`${due}T00:00:00`);
  const base = `${d.getMonth() + 1}/${d.getDate()}(${WEEKDAYS[d.getDay()]})`;
  const tomorrow = toYmd(new Date(Date.now() + 86400000));
  if (due < today) return `${base} 期限切れ`;
  if (due === today) return `${base} 今日`;
  if (due === tomorrow) return `${base} 明日`;
  return base;
}

// Jervisに渡す説明（毎回の会話の前提に付け足す）
function memoSystemPrompt() {
  const now = new Date();
  const open = Memo.open();
  const lines = open.length
    ? open.map((m) => `- [${m.id}] ${m.text}${m.due ? `（期限: ${m.due}）` : ''}`).join('\n')
    : '（なし）';
  return `
# メモ・ToDo機能
今日は ${toYmd(now)}（${WEEKDAYS[now.getDay()]}曜日）、現在 ${pad(now.getHours())}:${pad(now.getMinutes())} です。
ボスのメモ（未完了）:
${lines}

ボスが「覚えておいて」「メモして」「〇〇をやる」「〇〇は終わった」「〇〇を消して」などと頼んだときは、返答の最後に次の命令を1行ずつ書いてください。命令はアプリが読み取って処理し、ボスには表示されません。
<<memo-add|期限|内容>>  … 期限は YYYY-MM-DD。「明日」「来週月曜」などは今日の日付から計算する。期限がなければ空にする（例: <<memo-add||牛乳を買う>>）
<<memo-done|番号>>  … 完了にする（番号は上の一覧の[ ]内の数字）
<<memo-del|番号>>   … 削除する
例: ボス「明日の朝礼で安全運転を呼びかける、覚えておいて」→ あなた「承知しました。明日の朝礼の件、メモしました。」の次の行に <<memo-add|(明日の日付)|朝礼で安全運転を呼びかける>>
ルール:
・「メモしました」「記憶しました」「完了にしました」と言うときは、必ず対応する命令を書く。命令がなければメモは保存されない。
・頼まれていないのに命令を書かない。どのメモか曖昧なら、命令は書かずにボスに確認する。
・命令以外の本文では「メモしました」「完了にしました」のように短く伝える。
・「今日やることは？」「メモを見せて」と聞かれたら、上の一覧から答える（命令は不要）。`;
}

const MEMO_CMD = /<<\s*memo-(add|done|del)\s*\|([^>]*?)>>/gi;

// 返答から命令を取り出して実行し、表示用の本文と実行結果を返す
function applyMemoCommands(reply) {
  const results = [];
  const clean = reply.replace(MEMO_CMD, (_, cmd, args) => {
    cmd = cmd.toLowerCase();
    if (cmd === 'add') {
      const i = args.indexOf('|');
      const due = i >= 0 ? args.slice(0, i) : '';
      const text = i >= 0 ? args.slice(i + 1) : args;
      const m = Memo.add(text, due);
      if (m) results.push(`📝 追加: ${m.text}${m.due ? `（${dueLabel(m.due)}）` : ''}`);
    } else if (cmd === 'done') {
      const m = Memo.setDone(args.trim());
      if (m) results.push(`✅ 完了: ${m.text}`);
    } else if (cmd === 'del') {
      const m = Memo.remove(args.trim());
      if (m) results.push(`🗑 削除: ${m.text}`);
    }
    return '';
  }).replace(/\n{3,}/g, '\n\n').trim();
  return { text: clean, results };
}

// ===== 書き忘れ対策：メモ抽出専用の呼び出し =====
const MEMO_REQUEST_WORDS = /(覚えて|おぼえて|憶えて|メモ|記憶|忘れ|リマインド|控えて|登録|やること|ToDo|todo|タスク|終わった|おわった|済んだ|すんだ|済み|完了|やった|消して|けして|削除)/i;
function looksLikeMemoRequest(text) {
  return MEMO_REQUEST_WORDS.test(text);
}

function memoExtractRequest(userText, replyText) {
  const now = new Date();
  const open = Memo.open();
  const list = open.length ? open.map((m) => `[${m.id}] ${m.text}${m.due ? `（期限: ${m.due}）` : ''}`).join('\n') : '（なし）';
  const system = `あなたはメモ帳の操作だけを判断する係です。今日は ${toYmd(now)}（${WEEKDAYS[now.getDay()]}曜日）です。
現在の未完了メモ:
${list}

ユーザーの発言から、メモ帳に対して行う操作をJSONで返してください。
- 新しく覚えておくこと → {"op":"add","text":"内容（短く）","due":"YYYY-MM-DD または空文字"}。「明日」「来週月曜」などは今日から計算する
- 終わった・済んだこと → {"op":"done","id":番号}
- 消してほしいこと → {"op":"del","id":番号}
- 質問や雑談など、操作が不要なら actions は空配列
- どのメモか判断できない場合は操作しない`;
  return {
    system,
    contents: [{ role: 'user', parts: [{ text: `ユーザーの発言: ${userText}\n（アシスタントの返事: ${replyText}）` }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          actions: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                op: { type: 'STRING', enum: ['add', 'done', 'del'] },
                text: { type: 'STRING' },
                due: { type: 'STRING' },
                id: { type: 'INTEGER' },
              },
              required: ['op'],
            },
          },
        },
        required: ['actions'],
      },
    },
  };
}

function applyMemoActions(json) {
  let data;
  try { data = JSON.parse(String(json).replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { return []; }
  const results = [];
  for (const a of (data && Array.isArray(data.actions) ? data.actions : [])) {
    if (a.op === 'add' && a.text) {
      const m = Memo.add(a.text, a.due || '');
      if (m) results.push(`📝 追加: ${m.text}${m.due ? `（${dueLabel(m.due)}）` : ''}`);
    } else if (a.op === 'done' && a.id != null) {
      const m = Memo.setDone(a.id);
      if (m) results.push(`✅ 完了: ${m.text}`);
    } else if (a.op === 'del' && a.id != null) {
      const m = Memo.remove(a.id);
      if (m) results.push(`🗑 削除: ${m.text}`);
    }
  }
  return results;
}

// 表示用：完成した命令を消し、書きかけの「<<」以降も隠す（少しずつ表示するとき用）
function visibleText(acc) {
  let t = String(acc || '').replace(MEMO_CMD, '');
  const i = t.lastIndexOf('<<');
  if (i >= 0 && t.indexOf('>>', i) < 0) t = t.slice(0, i);
  if (/<$/.test(t)) t = t.slice(0, -1);
  return t.replace(/\n{3,}/g, '\n\n').trimEnd();
}
