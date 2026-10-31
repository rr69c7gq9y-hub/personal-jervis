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
ルール:
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
