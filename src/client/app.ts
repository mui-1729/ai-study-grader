// Browser modules are served locally; no CDN or external requests.
// @ts-ignore Browser import path
import { marked } from '/vendor/marked.js';
// @ts-ignore Browser import path
import DOMPurify from '/vendor/purify.js';
import type { Course, Question } from '../schema.js';
import type { Attempt } from '../store.js';
import type { usageSummary } from '../usage.js';
type PublicQuestion = Omit<Question, 'modelAnswer' | 'rubric' | 'acceptedAnswers'>;
type PublicCourse = Omit<Course, 'questions'> & { questions: PublicQuestion[] };
type View =
  | 'home'
  | 'study'
  | 'question'
  | 'history'
  | 'attempt'
  | 'settings'
  | 'import'
  | 'editor'
  | 'usage';
let usageData: ReturnType<typeof usageSummary> | null = null;
let materialPromptText = '';
let courses: PublicCourse[] = [],
  history: Attempt[] = [],
  status = { aiConfigured: false, model: 'gpt-6-luna', token: '' };
let view: View = 'home',
  courseId = '',
  chapterId = '',
  questionId = '',
  tab = 'read',
  filter = 'all',
  answer = '',
  solution: { modelAnswer: string; rubric: string } | null = null,
  result: Attempt | null = null,
  busy = false;
const app = document.querySelector<HTMLDivElement>('#app')!;
const esc = (s: unknown) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
const md = (s: string) =>
  `<div class="markdown">${DOMPurify.sanitize(marked.parse(s), { FORBID_TAGS: ['img', 'iframe', 'style', 'form', 'input', 'button'], FORBID_ATTR: ['style', 'id', 'name'], ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|#)/i })}</div>`;
const modeName = (s: string) =>
  ({ ai: 'AI-MOP採点', self: '自己採点', exact: '厳密一致採点' })[s] ?? s;
const current = () => courses.find((c) => c.id === courseId)!;
const question = () => current()?.questions.find((q) => q.id === questionId)!;
const latest = (id: string) => history.find((a) => a.courseId === courseId && a.questionId === id);
function notice(message: string) {
  const el = document.querySelector<HTMLDivElement>('#notice')!;
  el.textContent = message;
  el.style.display = 'block';
  window.setTimeout(() => (el.style.display = 'none'), 6500);
}
async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set('x-study-token', status.token);
  if (options.body && !(options.body instanceof FormData))
    headers.set('Content-Type', 'application/json');
  const response = await fetch('/api' + path, { ...options, headers });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '処理できませんでした。');
  return data as T;
}
async function reload() {
  [status, courses, history, usageData] = await Promise.all([
    api<typeof status>('/status'),
    api<PublicCourse[]>('/courses'),
    api<Attempt[]>('/history'),
    api<ReturnType<typeof usageSummary>>('/usage'),
  ]);
}
function nav(viewName: View, label: string, symbol: string) {
  return `<button class="nav ${view === viewName || (viewName === 'study' && ['question', 'editor'].includes(view)) || (viewName === 'history' && view === 'attempt') ? 'active' : ''}" data-view="${viewName}"><span aria-hidden="true">${symbol}</span>${label}</button>`;
}
function render() {
  app.innerHTML = `<header><div class="brand"><span class="brandmark" aria-hidden="true">▤</span>Study Studio</div><span class="tag ${status.aiConfigured ? '' : 'warn'}">● ${status.aiConfigured ? 'INIAD AI-MOP' : 'AI-MOP 未設定'}</span></header><div class="shell"><aside>${nav('home', 'マイ教材', '▦')}${nav('study', '学習する', '▤')}${nav('history', '学習の記録', '◷')}${nav('usage', '利用状況', '◴')}${nav('settings', 'AIの設定', '⚙')}<div class="aside-label">MY LIBRARY</div>${courses
    .slice(0, 6)
    .map(
      (c) =>
        `<button class="flat aside-course" data-course="${esc(c.id)}">${esc(c.title)}</button>`,
    )
    .join(
      '',
    )}<div class="local">● このパソコンに保存<br>自分のペースで、一歩ずつ。</div></aside><main>${body()}</main></div>`;
  bind();
}
function body(): string {
  if (view === 'usage') return usageView();
  if (view === 'home') return home();
  if (view === 'import') return importForm();
  if (view === 'settings') return settings();
  if (view === 'history') return historyView();
  if (view === 'attempt' && result)
    return `<button class="flat back" data-view="history">← 学習の記録</button><h1>${esc(result.questionTitle)}</h1><div class="paper"><p class="muted">${esc(result.courseTitle)} · ${new Date(result.createdAt).toLocaleString('ja-JP')}</p><details><summary>提出した回答</summary>${md(result.answer)}</details>${resultView(result)}${retryButton(result)}</div>`;
  if (!current())
    return `<div class="empty">教材を追加して、学習を始めましょう。<p><button data-view="import" class="primary">教材を追加</button></p></div>`;
  if (view === 'editor') return editor();
  if (view === 'question') return questionView();
  return study();
}
function home() {
  const tried = new Set(history.map((a) => `${a.courseId}:${a.questionId}`)).size;
  return `<div class="topline"><div><span class="eyebrow">YOUR LEARNING SPACE</span><h1>今日も、ひとつ理解を深めよう。</h1><p>いつもの教材で、読む・解く・振り返る。</p></div><button data-view="import" class="primary">＋ 教材を追加</button></div><div class="hero"><div><span class="eyebrow">LEARN AT YOUR OWN PACE</span><h2>「分かったつもり」を、<br>自分の言葉で確かめる。</h2><p>考えた過程も書き残して、次の一歩へつなげましょう。</p></div><div class="art" aria-hidden="true"><div class="sheet"></div><div class="circle">✓</div></div></div><div class="stats"><div class="stat"><small>登録した教材</small><strong>${courses.length}<span>科目</span></strong></div><div class="stat"><small>取り組んだ問題</small><strong>${tried}<span>問</span></strong></div><div class="stat"><small>学習の記録</small><strong>${history.length}<span>回</span></strong></div></div><div class="section-heading"><h2>マイ教材</h2><small>何度でも、自分のペースで</small></div><div class="grid">${courses.map((c) => `<article class="card course-card"><div class="course-icon" aria-hidden="true">▤</div><h3>${esc(c.title)}</h3><p>${esc(c.description)}</p><div class="course-footer"><span class="muted">${c.chapters.length}章 · ${c.questions.length}問</span><button data-course="${esc(c.id)}">学習を開く →</button></div></article>`).join('')}<article class="card course-card import-card"><div class="course-icon" aria-hidden="true">＋</div><h3>次に学びたいものを。</h3><p>PDFやテキスト、問題付きの教材パッケージを追加。</p><button data-view="import">ファイルを選ぶ</button></article></div>`;
}
function study() {
  const c = current(),
    chapter = c.chapters.find((x) => x.id === chapterId) ?? c.chapters[0]!;
  chapterId = chapter.id;
  const qs = c.questions
    .filter((q) =>
      tab === 'mock'
        ? q.section === 'mock'
        : q.chapterId === chapter.id && q.section === 'practice',
    )
    .filter(
      (q) => filter !== 'review' || (latest(q.id) && latest(q.id)!.grade.score < q.maxPoints),
    );
  return `<div class="topline"><div><span class="eyebrow">STUDY ROOM</span><h1>${esc(c.title)}</h1><p>${esc(c.description)}</p></div></div><div class="split"><div class="chapter-list">${c.chapters.map((ch) => `<button class="${chapterId === ch.id ? 'selected' : ''}" data-chapter="${esc(ch.id)}">${esc(ch.title)}</button>`).join('')}</div><div><div class="tabbar"><button class="${tab === 'read' ? 'active' : ''}" data-tab="read">教材を読む</button><button class="${tab === 'practice' ? 'active' : ''}" data-tab="practice">確認テスト</button>${c.questions.some((q) => q.section === 'mock') ? `<button class="${tab === 'mock' ? 'active' : ''}" data-tab="mock">模擬テスト</button>` : ''}</div><div class="paper">${tab === 'read' ? `<h2>${esc(chapter.title)}</h2>${md(chapter.content)}<div class="actions"><button class="primary" data-tab="practice">理解を確かめる →</button></div>` : `<div class="section-heading"><h2>${tab === 'mock' ? '模擬テストの問題練習' : '確認テスト'}</h2><button class="flat" data-action="toggle-filter">${filter === 'review' ? 'すべて表示' : '要復習だけ'}</button></div>${tab === 'mock' ? '<p class="hint">初期版は大問ごとの練習です。60分の一括受験・自動提出には対応していません。</p>' : ''}${qs.map((q) => `<button class="question-link" data-question="${esc(q.id)}"><span>${esc(q.title)}<small>${latest(q.id) ? `${modeName(latest(q.id)!.grade.mode)} · 前回 ${latest(q.id)!.grade.score} / ${q.maxPoints}点` : 'まだ取り組んでいません'}</small></span><span class="points">${q.maxPoints}点 →</span></button>`).join('') || '<div class="empty">この表示に該当する問題はありません。</div>'}<div class="actions"><button data-view="editor">＋ 問題・解答を追加</button></div>`}</div></div></div>`;
}
function questionView() {
  const q = question();
  if (!q) {
    view = 'study';
    return study();
  }
  return `<button class="flat back" data-action="back-study">← 問題一覧に戻る</button><div class="breadcrumb">${esc(current().title)} / ${q.section === 'mock' ? '模擬テスト' : '確認テスト'}</div><div class="paper"><div class="question-header"><h2>${esc(q.title)}</h2><span class="tag">${q.maxPoints}点</span></div>${md(q.prompt)}<label for="answer">あなたの回答</label><textarea id="answer" rows="8" maxlength="12000" placeholder="結論だけでなく、考え方や途中式も書いてみましょう。" ${busy ? 'disabled' : ''}>${esc(answer)}</textarea><div class="word-count"><span id="count">${answer.length}</span> / 12,000文字</div><div class="answer-tools"><span id="save-status" class="save-status">回答はこのパソコンに保存します</span><div><label for="grade-model" class="inline-label">今回の採点モデル</label><select id="grade-model"><option value="${esc(status.model)}">${esc(status.model)}（標準）</option>${status.model !== 'gpt-6-luna' ? '<option value="gpt-6-luna">GPT-6 Luna</option>' : ''}${status.model !== 'gpt-6-astra' ? '<option value="gpt-6-astra">GPT-6 Astra（利用枠に注意）</option>' : ''}</select></div></div>${!status.aiConfigured ? '<p class="hint warn">AI-MOPは未設定です。解答を確認して自己採点できます。「AIの設定」から接続するとAI採点も使えます。</p>' : '<p class="hint">採点を押すと、この回答・問題・解答・関連する教材をINIAD AI-MOPへ送ります。AIの採点は学習の目安です。根拠も確認しましょう。</p>'}<div class="actions"><button class="primary" data-action="grade" ${busy || (!status.aiConfigured && q.kind !== 'exact') ? 'disabled' : ''}>${busy ? '採点しています…' : q.kind === 'exact' ? '通常の採点をする' : 'AIで採点する'}</button><button data-action="solution" ${busy ? 'disabled' : ''}>解答を見て自己採点</button></div>${solution ? `<div class="result"><h2>解答・解説</h2>${md(solution.modelAnswer)}<details><summary>採点基準</summary>${md(solution.rubric)}</details><div class="actions"><label for="self-score">自分の点数</label><input id="self-score" type="number" min="0" max="${q.maxPoints}" step="1" value="0" class="score-input"><span>/ ${q.maxPoints}点</span><button data-action="self-grade">自己採点を記録</button></div></div>` : ''}${result ? resultView(result) + `<div class="actions"><button data-action="retry">もう一度解く</button><button class="primary" data-action="next-question">次の問題へ →</button></div>` : ''}</div>`;
}
function resultView(a: Attempt) {
  return `<div class="result"><div class="result-head"><div><span class="eyebrow">${esc(modeName(a.grade.mode))}</span><div class="score">${a.grade.score}<small> / ${a.grade.maxPoints}点</small></div></div><div><span class="tag">${a.grade.score === a.grade.maxPoints ? '理解できています' : '振り返ってみましょう'}</span>${a.grade.model ? `<p><small>${esc(a.grade.model)}</small></p>` : ''}</div></div>${a.grade.needsReview ? '<p class="hint warn">AIが判断の確認を勧めています。採点基準と回答を見比べてください。</p>' : ''}${md(a.grade.feedback)}${a.grade.criteria.map((c) => `<div class="criterion"><strong>${esc(c.id)} · ${c.points}点</strong>${esc(c.reason)}${c.evidence ? `<blockquote>回答の根拠：${esc(c.evidence)}</blockquote>` : ''}</div>`).join('')}<details ${a.grade.mode === 'self' ? '' : 'open'}><summary>模範解答と解説</summary>${md(a.modelAnswer)}</details><details><summary>採点基準</summary>${md(a.rubric)}</details><h3>復習するなら</h3><div class="actions">${a.reviewChapterIds
    .map((id) => {
      const chapter = courses.find((c) => c.id === a.courseId)?.chapters.find((c) => c.id === id);
      return chapter
        ? `<button data-review="${esc(id)}" data-review-course="${esc(a.courseId)}">${esc(chapter.title)} →</button>`
        : '';
    })
    .join('')}</div><small>教材バージョン：${esc(a.courseVersion)}</small></div>`;
}
function retryButton(a: Attempt) {
  return courses.find((c) => c.id === a.courseId)?.questions.some((q) => q.id === a.questionId)
    ? `<div class="actions"><button data-retry-course="${esc(a.courseId)}" data-retry-question="${esc(a.questionId)}" class="primary">この問題を解き直す →</button></div>`
    : '';
}
function usageView() {
  const data = usageData;
  if (!data) return '<p>利用状況を読み込めませんでした。</p>';
  const quota = data.quota,
    fmt = (n: number) => n.toLocaleString('ja-JP');
  const limits = data.lastLimits;
  return `<div class="topline"><div><span class="eyebrow">DAILY AI USAGE</span><h1>AI-MOPの利用状況</h1><p>日ごとの確認値と、このアプリで使った量。</p></div><button data-action="refresh-usage">表示を更新</button></div><div class="grid"><div class="card"><span class="tag ${quota?.isToday ? '' : 'warn'}">${quota?.isToday ? '今日のquota確認値' : quota ? '前回の確認値（本日ではありません）' : 'quota未確認'}</span><p class="quota-number">${quota ? fmt(quota.remaining) : '—'}<small> 残り</small></p><p class="muted">${quota ? `確認日時：${new Date(quota.observedAt).toLocaleString('ja-JP')}<br>${esc(quota.note)}` : '対話画面でquotaを実行し、表示された残量を下に記録できます。'}</p><p class="hint">${quota?.isToday ? '最後にquotaで確認した時点の値です。現在の残量を自動取得した表示ではありません。' : '今日の残量は未確認です。日付が変わっても、この値を自動補充しません。'}</p></div><div class="card"><span class="eyebrow">このアプリの本日の使用量</span><p class="quota-number">${fmt(data.totalTokens)}<small> tokens</small></p><p class="muted">AIへの採点リクエスト ${data.requests}回<br>${data.unreported ? `使用トークン数が返らなかった処理 ${data.unreported}回` : 'トークン数が返った処理の合計です。'}</p><p class="hint">Slackや他のアプリでの使用は含みません。AI-MOP側の換算方法が未確認のため、quota確認値から単純に差し引きません。</p></div></div><div class="paper form usage-form"><h2>quotaの残量を記録する</h2><p class="muted">対話画面でquotaと送り、表示された日次残量を入力します。毎日の固定上限としては保存しません。</p><form id="quota-form"><label for="quota-remaining">今回quotaで確認した残量</label><input id="quota-remaining" type="number" min="0" step="1" max="9007199254740991" placeholder="quotaに表示された数値" required><button class="primary" type="submit">今の確認値として記録</button></form></div><div class="paper usage-form"><h2>今日のモデル別使用量</h2>${data.models.length ? `<div class="markdown"><table><thead><tr><th>モデル</th><th>採点要求</th><th>入力</th><th>出力</th><th>合計</th></tr></thead><tbody>${data.models.map((m) => `<tr><td>${esc(m.model)}</td><td>${m.requests}回</td><td>${fmt(m.inputTokens)}</td><td>${fmt(m.outputTokens)}</td><td>${fmt(m.totalTokens)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">今日はまだ、このアプリからAI採点を呼び出していません。</p>'}<small>日付は日本時間の ${esc(data.today)}。AI-MOP側の実際のリセット時刻やモデル別換算は未確認です。失敗した処理も採点要求の回数に含めます。</small>${
    limits
      ? `<details><summary>APIの応答に含まれた短時間の制限情報</summary><p class="muted">${new Date(limits.createdAt).toLocaleString('ja-JP')} · ${esc(limits.model)} の応答時点です。日次quotaとは別の値である可能性があります。対象期間・共有範囲は未確認です。</p>${Object.entries(
          limits.limits,
        )
          .map(([key, value]) => `<p><small>${esc(key)}</small><br>${esc(value)}</p>`)
          .join('')}</details>`
      : ''
  }</div>`;
}
function historyView() {
  const rows = history.filter((a) => filter !== 'review' || a.grade.score < a.grade.maxPoints);
  return `<div class="topline"><div><span class="eyebrow">LEARNING JOURNAL</span><h1>学習の記録</h1><p>間違えたところが、次に分かるところ。</p></div><button data-action="toggle-filter">${filter === 'review' ? 'すべて表示' : '要復習だけ'}</button></div><div class="paper">${rows.map((a) => `<div class="history-row"><div><strong>${esc(a.questionTitle)}</strong><small>${esc(a.courseTitle)} · ${new Date(a.createdAt).toLocaleString('ja-JP')}<br>${esc(modeName(a.grade.mode))}${a.grade.model ? ' · ' + esc(a.grade.model) : ''}</small></div><div class="history-score">${a.grade.score} / ${a.grade.maxPoints}</div><button data-attempt="${a.id}">振り返る →</button></div>`).join('') || '<div class="empty">まだ記録がありません。問題に取り組むと、ここに残ります。</div>'}</div>`;
}
function materialPromptPanel() {
  return `<section class="paper form material-authoring" aria-labelledby="authoring-title">
    <span class="eyebrow">STEP 1 · 教材を作る</span>
    <h2 id="authoring-title">他のAIに渡すプロンプト</h2>
    <p class="muted">このプロンプトと元資料を、教材作成を任せるAIに渡してください。教材・問題・解答・採点基準がそろったJSONを作成するための指示です。</p>
    <div class="actions">
      <button type="button" class="primary" data-action="copy-material-prompt">プロンプトをコピー</button>
      <a class="button-link" href="/api/material-prompt/download" download>テキストをダウンロード</a>
      <button type="button" data-action="show-material-prompt">全文を表示</button>
    </div>
    <div id="material-prompt-preview" hidden>
      <label for="material-prompt-text">教材作成用プロンプト（編集不要で使えます）</label>
      <textarea id="material-prompt-text" rows="12" readonly spellcheck="false"></textarea>
    </div>
    <p class="hint">受け取ったJSONと作成確認レポートを確認してから、下の欄でJSONを追加します。元資料を別に登録しても、採点時に自動で関連付けられる機能はありません。</p>
  </section>`;
}
function importForm() {
  return `<div class="topline"><div><span class="eyebrow">BUILD YOUR LIBRARY</span><h1>学びたい教材を追加する</h1><p>科目を問わず、使いたい教材を何度でも。</p></div></div>${materialPromptPanel()}<div class="paper form"><span class="eyebrow">STEP 2 · 教材を取り込む</span><h2>完成した教材を追加する</h2><form id="import-form"><label for="material-title">教材の名前</label><input id="material-title" name="title" placeholder="例：統計学 第1回"><label for="material-file">教材ファイル</label><input id="material-file" name="file" type="file" accept=".pdf,.md,.txt,.json" required><p class="muted">PDF・Markdown・テキスト、または問題付き教材パッケージ（JSON）。1ファイル15MBまで。</p><p class="hint">問題付きのJSONなら、そのまま学習・採点を始められます。本文だけのファイルは、まず読むための教材として追加します。問題・解答・採点基準は後から追加できます。</p><p class="hint">PDFは文字を取り出せるものに対応します。画像だけのPDF、図表や数式の配置は正確に読み取れない場合があるため、追加後に本文を確認してください。元ファイルは変更しません。</p><button class="primary" type="submit">この教材を追加する</button></form></div>`;
}
function settings() {
  return `<div class="topline"><div><span class="eyebrow">AI CONNECTION</span><h1>INIAD AI-MOPの設定</h1><p>普段はLuna、必要なときにAstra。</p></div></div><div class="paper form"><span class="tag ${status.aiConfigured ? '' : 'warn'}">${status.aiConfigured ? '鍵を設定済み（接続は未確認）' : '未設定'}</span><form id="settings-form"><label for="api-key">AI-MOPのAPIキー</label><input id="api-key" type="password" autocomplete="off" placeholder="${status.aiConfigured ? '変更するときだけ入力' : 'ご自身のパソコンで入力してください'}" ${status.aiConfigured ? '' : 'required'}><small>入力した鍵は、このパソコンのアプリ専用フォルダーに保存します。画面への再表示やGitHubへの登録はしません。</small><label for="model-name">標準のモデル名</label><input id="model-name" list="model-options" value="${esc(status.model)}" required pattern="[a-zA-Z0-9._:/\-]+"><datalist id="model-options"><option value="gpt-6-luna"><option value="gpt-6-astra"></datalist><p><small>AI-MOPで利用できる正式な名前を指定します。Lunaを普段の採点に使い、必要な問題だけAstraを選べます。</small></p><div class="actions"><button type="submit" class="primary">設定を保存</button><button type="button" data-action="models" ${status.aiConfigured ? '' : 'disabled'}>利用できるモデルを確認</button></div><p id="model-result" class="hint" hidden></p></form><div class="settings-separator"><h3>利用枠を大切に使うために</h3><p class="muted">1問ずつ採点し、過去の会話全体は送りません。失敗した処理は自動で再送しません。残りの利用枠はAI-MOP側で確認してください。</p><small>このアプリは自分のパソコン専用です。共有・公開して使う機能は初期版には含まれません。</small></div></div>`;
}
function editor() {
  const c = current();
  return `<button class="flat back" data-view="study">← 教材に戻る</button><h1>問題・解答を追加する</h1><div class="paper form"><p class="hint">こちらのチャットで作った問題や、自分の問題を登録できます。解答と配点を含む採点基準を一緒に用意してください。</p><form id="question-form"><label for="edit-chapter">復習先の章</label><select id="edit-chapter">${c.chapters.map((ch) => `<option value="${esc(ch.id)}" ${ch.id === chapterId ? 'selected' : ''}>${esc(ch.title)}</option>`).join('')}</select><label for="edit-title">問題の名前</label><input id="edit-title" required maxlength="160"><label for="edit-prompt">問題文</label><textarea id="edit-prompt" required></textarea><label for="edit-answer">模範解答・解説</label><textarea id="edit-answer" required></textarea><label for="edit-rubric">採点基準（部分点の内訳も記入）</label><textarea id="edit-rubric" required></textarea><label for="edit-points">満点</label><input id="edit-points" type="number" min="1" max="1000" step="1" value="5" required><button class="primary" type="submit">問題を保存</button></form></div>`;
}
async function saveAnswer() {
  if (view !== 'question' || !question()) return;
  const el = document.querySelector<HTMLTextAreaElement>('#answer');
  if (el) answer = el.value;
  await api('/draft', { method: 'PUT', body: JSON.stringify({ courseId, questionId, answer }) });
}
async function move(next: View) {
  if (busy) return;
  await saveAnswer();
  if (next === 'usage') usageData = await api('/usage');
  view = next;
  filter = 'all';
  render();
  window.scrollTo(0, 0);
}
async function openQuestion(id: string, fresh = false) {
  await saveAnswer();
  questionId = id;
  solution = null;
  result = null;
  answer = fresh ? '' : (await api<{ answer: string }>(`/draft/${courseId}/${id}`)).answer;
  view = 'question';
  render();
  window.scrollTo(0, 0);
}
function bind() {
  const quotaForm = document.querySelector<HTMLFormElement>('#quota-form');
  if (quotaForm)
    quotaForm.onsubmit = (e) => {
      e.preventDefault();
      run(async () => {
        const remaining = Number(
          document.querySelector<HTMLInputElement>('#quota-remaining')!.value,
        );
        await api('/quota', {
          method: 'PUT',
          body: JSON.stringify({ remaining, note: 'quotaで確認した値' }),
        });
        usageData = await api('/usage');
        render();
        notice('quotaの確認値を記録しました。毎日の上限には設定しません。');
      });
    };
  document
    .querySelectorAll<HTMLElement>('[data-view]')
    .forEach((el) => (el.onclick = () => run(() => move(el.dataset.view as View))));
  document.querySelectorAll<HTMLElement>('[data-course]').forEach(
    (el) =>
      (el.onclick = () =>
        run(async () => {
          if (busy) return;
          await saveAnswer();
          courseId = el.dataset.course!;
          chapterId = current().chapters[0]!.id;
          tab = 'read';
          await move('study');
        })),
  );
  document.querySelectorAll<HTMLElement>('[data-chapter]').forEach(
    (el) =>
      (el.onclick = () => {
        chapterId = el.dataset.chapter!;
        render();
      }),
  );
  document.querySelectorAll<HTMLElement>('[data-tab]').forEach(
    (el) =>
      (el.onclick = () => {
        tab = el.dataset.tab!;
        filter = 'all';
        render();
      }),
  );
  document
    .querySelectorAll<HTMLElement>('[data-question]')
    .forEach((el) => (el.onclick = () => run(() => openQuestion(el.dataset.question!))));
  document.querySelectorAll<HTMLElement>('[data-attempt]').forEach(
    (el) =>
      (el.onclick = () => {
        result = history.find((a) => a.id === el.dataset.attempt)!;
        view = 'attempt';
        render();
        window.scrollTo(0, 0);
      }),
  );
  document.querySelectorAll<HTMLElement>('[data-review]').forEach(
    (el) =>
      (el.onclick = () =>
        run(async () => {
          await saveAnswer();
          courseId = el.dataset.reviewCourse!;
          chapterId = el.dataset.review!;
          tab = 'read';
          view = 'study';
          render();
          window.scrollTo(0, 0);
        })),
  );
  document.querySelectorAll<HTMLElement>('[data-retry-course]').forEach(
    (el) =>
      (el.onclick = () =>
        run(async () => {
          courseId = el.dataset.retryCourse!;
          await openQuestion(el.dataset.retryQuestion!, true);
        })),
  );
  document
    .querySelectorAll<HTMLElement>('[data-action]')
    .forEach((el) => (el.onclick = () => run(() => action(el.dataset.action!))));
  const input = document.querySelector<HTMLTextAreaElement>('#answer');
  if (input)
    input.oninput = () => {
      answer = input.value;
      document.querySelector('#count')!.textContent = String(answer.length);
      document.querySelector('#save-status')!.textContent =
        '入力中…（問題を移るときにも保存します）';
      scheduleSave();
    };
  const imp = document.querySelector<HTMLFormElement>('#import-form');
  if (imp)
    imp.onsubmit = (e) => {
      e.preventDefault();
      run(async () => {
        const button = imp.querySelector<HTMLButtonElement>('button[type=submit]')!;
        button.disabled = true;
        button.textContent = '本文を確認しています…';
        try {
          const data = await api<{ id: string }>('/materials', {
            method: 'POST',
            body: new FormData(imp),
          });
          await reload();
          courseId = data.id;
          chapterId = current().chapters[0]!.id;
          tab = 'read';
          view = 'study';
          render();
          notice('教材を追加しました。本文を確認してください。');
        } finally {
          button.disabled = false;
          button.textContent = 'この教材を追加する';
        }
      });
    };
  const setting = document.querySelector<HTMLFormElement>('#settings-form');
  if (setting)
    setting.onsubmit = (e) => {
      e.preventDefault();
      run(async () => {
        const key = document.querySelector<HTMLInputElement>('#api-key')!.value.trim(),
          model = document.querySelector<HTMLInputElement>('#model-name')!.value.trim();
        await api('/settings', {
          method: 'PUT',
          body: JSON.stringify({ ...(key ? { apiKey: key } : {}), model }),
        });
        await reload();
        render();
        notice('設定を保存しました。採点するときにAI-MOPへ接続します。');
      });
    };
  const edit = document.querySelector<HTMLFormElement>('#question-form');
  if (edit)
    edit.onsubmit = (e) => {
      e.preventDefault();
      run(async () => {
        const val = (id: string) => (document.getElementById(id) as HTMLInputElement).value;
        const ch = val('edit-chapter'),
          points = Number(val('edit-points'));
        await api('/questions', {
          method: 'POST',
          body: JSON.stringify({
            courseId,
            question: {
              id: 'q-' + crypto.randomUUID(),
              chapterId: ch,
              title: val('edit-title'),
              kind: 'written',
              prompt: val('edit-prompt'),
              modelAnswer: val('edit-answer'),
              rubric: val('edit-rubric'),
              maxPoints: points,
              criteria: [{ id: 'overall', description: val('edit-rubric'), maxPoints: points }],
              acceptedAnswers: [],
              reviewChapterIds: [ch],
              section: 'practice',
            },
          }),
        });
        await reload();
        chapterId = ch;
        tab = 'practice';
        view = 'study';
        render();
        notice('問題を保存しました。');
      });
    };
}
let saveTimer: number | undefined;
function scheduleSave() {
  clearTimeout(saveTimer);
  const c = courseId,
    q = questionId,
    text = answer;
  saveTimer = window.setTimeout(() => {
    api('/draft', {
      method: 'PUT',
      body: JSON.stringify({ courseId: c, questionId: q, answer: text }),
    })
      .then(() => {
        const el = document.querySelector('#save-status');
        if (el && courseId === c && questionId === q) el.textContent = '✓ 保存しました';
      })
      .catch(() => notice('回答の保存に失敗しました。ページを閉じず、再試行してください。'));
  }, 700);
}
async function action(name: string) {
  if (name === 'copy-material-prompt' || name === 'show-material-prompt') {
    if (!materialPromptText)
      materialPromptText = (await api<{ prompt: string }>('/material-prompt')).prompt;
    if (name === 'copy-material-prompt') {
      try {
        await navigator.clipboard.writeText(materialPromptText);
        notice(
          'プロンプトをコピーしました。元資料と一緒に、教材作成を任せるAIへ貼り付けてください。',
        );
        return;
      } catch {
        notice(
          '自動コピーできませんでした。表示した全文をCtrl+Cでコピーするか、ダウンロードしてください。',
        );
      }
    }
    const preview = document.querySelector<HTMLElement>('#material-prompt-preview');
    const text = document.querySelector<HTMLTextAreaElement>('#material-prompt-text');
    if (preview && text) {
      preview.hidden = false;
      text.value = materialPromptText;
      if (name === 'copy-material-prompt') {
        text.focus();
        text.select();
      }
    }
    return;
  }
  if (name === 'toggle-filter') {
    filter = filter === 'review' ? 'all' : 'review';
    render();
    return;
  }
  if (name === 'back-study') {
    await saveAnswer();
    view = 'study';
    tab = question().section;
    render();
    return;
  }
  if (name === 'retry') {
    await openQuestion(questionId, true);
    return;
  }
  if (name === 'next-question') {
    const c = current(),
      i = c.questions.findIndex((q) => q.id === questionId);
    if (c.questions[i + 1]) await openQuestion(c.questions[i + 1]!.id);
    else {
      await saveAnswer();
      view = 'study';
      render();
      notice('最後の問題です。お疲れさまでした。');
    }
    return;
  }
  if (name === 'solution') {
    await saveAnswer();
    solution = await api(`/solution/${courseId}/${questionId}`);
    render();
    return;
  }
  if (name === 'grade' || name === 'self-grade') {
    if (busy) return;
    await saveAnswer();
    if (!answer.trim()) {
      notice('回答を書いてから採点してください。');
      return;
    }
    const mode = name === 'self-grade' ? 'self' : question().kind === 'exact' ? 'exact' : 'ai';
    const scoreEl = document.querySelector<HTMLInputElement>('#self-score');
    const selfScore = mode === 'self' ? Number(scoreEl?.value) : undefined;
    if (
      mode === 'self' &&
      (!Number.isInteger(selfScore) || selfScore! < 0 || selfScore! > question().maxPoints)
    ) {
      notice('0点から満点までの整数を入力してください。');
      return;
    }
    const model = document.querySelector<HTMLSelectElement>('#grade-model')!.value;
    busy = true;
    render();
    try {
      result = await api<Attempt>('/grade', {
        method: 'POST',
        body: JSON.stringify({ courseId, questionId, answer, mode, selfScore, model }),
      });
      history = await api('/history');
      solution = null;
    } finally {
      busy = false;
      render();
    }
    document.querySelector('.result')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  if (name === 'models') {
    const ids = await api<string[]>('/models', { method: 'POST' });
    const list = document.querySelector('#model-options')!;
    list.innerHTML = ids.map((id) => `<option value="${esc(id)}">`).join('');
    const el = document.querySelector<HTMLParagraphElement>('#model-result')!;
    el.hidden = false;
    el.textContent = ids.length ? '取得できました：' + ids.join(' / ') : 'モデル一覧が空でした。';
    notice('モデル一覧を確認しました。');
  }
  if (name === 'refresh-usage') {
    usageData = await api('/usage');
    render();
  }
}
async function run(fn: () => Promise<unknown>) {
  if (busy) return;
  try {
    await fn();
  } catch (error) {
    notice(error instanceof Error ? error.message : '処理できませんでした。');
  }
}
window.addEventListener('beforeunload', (e) => {
  if (busy) {
    e.preventDefault();
  }
});
void run(async () => {
  await reload();
  courseId = courses[0]?.id ?? '';
  chapterId = current()?.chapters[0]?.id ?? '';
  render();
});
