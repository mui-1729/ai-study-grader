// Browser modules are served locally; no CDN or external requests.
// @ts-ignore Browser import path
import { marked } from '/vendor/marked.js';
// @ts-ignore Browser import path
import DOMPurify from '/vendor/purify.js';
import type { Course, Question } from '../schema.js';
import type { Attempt } from '../store.js';
import type { usageSummary } from '../usage.js';
import type { QuestionContext } from '../question-context.js';
import type { TutorSession } from '../tutor.js';
import type { GenerationJob } from '../authoring.js';
type PublicQuestion = Omit<Question, 'modelAnswer' | 'rubric' | 'acceptedAnswers'> & {
  resolvedContext?: QuestionContext;
};
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
  | 'usage'
  | 'tutor'
  | 'generation';
type GenerationSummary = Omit<GenerationJob, 'selected'> & {
  plannedCalls: number;
  draft?: Course | null;
};
type GenerationPlan = {
  totalUnits: number;
  totalCharacters: number;
  units: { chapterId: string; title: string; start: number; end: number; characters: number }[];
  jobs: GenerationSummary[];
};
let tutorSession: TutorSession | null = null,
  tutorSessions: TutorSession[] = [],
  tutorInput = '';
let generationPlan: GenerationPlan | null = null,
  generationJob: GenerationSummary | null = null;
let generationPoll: number | undefined;
let folderFiles: { file: File; path: string; selected: boolean }[] = [];
let folderSkipped = 0;
let usageData: ReturnType<typeof usageSummary> | null = null;
let materialPromptText = '';
let gradingError = '';
let courses: PublicCourse[] = [],
  history: Attempt[] = [],
  status: {
    aiConfigured: boolean;
    model: string;
    token: string;
    appVersion?: string;
    credentialStorage?: string;
  } = {
    aiConfigured: false,
    model: 'gpt-6-luna',
    token: '',
  };
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
  if (view === 'question' && gradingError) {
    const error = document.createElement('p');
    error.className = 'hint warn';
    error.setAttribute('role', 'alert');
    error.textContent = gradingError;
    document.querySelector('.paper')?.append(error);
  }
  if (view === 'question') {
    const context = question()?.resolvedContext;
    if (context && (context.text || context.questions.length || context.warnings.length)) {
      const section = document.createElement('section');
      section.className = 'question-context';
      section.setAttribute('aria-label', 'この問題の前提');
      section.innerHTML = `<h3>この問題の前提</h3>${context.text ? md(context.text) : ''}${context.questions.map((q) => `<details open><summary>${esc(q.title)}の条件</summary>${md(q.prompt)}</details>`).join('')}${context.warnings.map((w) => `<p class="hint warn">${esc(w)}</p>`).join('')}`;
      document.querySelector('label[for="answer"]')?.insertAdjacentElement('beforebegin', section);
    }
  }
  if (view === 'study') {
    const button = document.createElement('button');
    button.textContent = 'この資料からAI教材を作る';
    button.dataset.action = 'open-generation';
    document.querySelector('.topline')?.append(button);
  }
  if (view === 'question') {
    const button = document.createElement('button');
    button.textContent = result ? '採点について相談・質問する' : 'わからない・質問する';
    button.dataset.action = 'open-tutor';
    button.disabled = busy;
    document.querySelector('.paper .actions')?.append(button);
  }
  if (
    view === 'attempt' &&
    result &&
    courses
      .find((c) => c.id === result!.courseId)
      ?.questions.some((q) => q.id === result!.questionId)
  ) {
    const button = document.createElement('button');
    button.textContent = 'この採点から会話を始める';
    button.dataset.action = 'open-tutor';
    document.querySelector('.paper')?.append(button);
  }
  if (view === 'settings') {
    const storage = document.createElement('p');
    storage.className = 'hint';
    storage.textContent =
      status.credentialStorage === 'windows-protected'
        ? 'キーはWindowsで暗号化し、プロジェクト外の保護領域に保存しています。毎回消す必要はありません。'
        : status.credentialStorage === 'session'
          ? 'この環境ではキーは起動中だけ保持します。'
          : status.credentialStorage === 'environment'
            ? 'キーは起動元の環境変数から設定されています。'
            : 'キーは未設定です。';
    document.querySelector('#settings-form')?.prepend(storage);
    const keyHelp = document.querySelector('#api-key')?.nextElementSibling;
    if (keyHelp)
      keyHelp.textContent =
        'Windowsではユーザー単位で暗号化し、プロジェクト外に保存します。画面やGitHubへキーを出しません。同じWindowsユーザーの権限を持つ処理から完全に隠せる方式ではありません。';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '保存したキーを削除';
    remove.className = 'danger';
    remove.dataset.action = 'remove-key';
    remove.disabled = !status.aiConfigured;
    document.querySelector('#settings-form .actions')?.append(remove);
    const version = document.createElement('p');
    version.className = 'muted';
    version.textContent = status.appVersion
      ? `アプリの版：${status.appVersion}`
      : 'アプリの版：旧版です。起動し直してください。';
    document.querySelector('.settings-separator')?.append(version);
  }
  bind();
}
function body(): string {
  if (view === 'tutor') return tutorView();
  if (view === 'generation') return generationView();
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
  return `<div class="result"><div class="result-head"><div><span class="eyebrow">${esc(modeName(a.grade.mode))}</span><div class="score">${a.grade.score}<small> / ${a.grade.maxPoints}点</small></div></div><div><span class="tag">${a.grade.score === a.grade.maxPoints ? '理解できています' : '振り返ってみましょう'}</span>${a.grade.model ? `<p><small>${esc(a.grade.model)}</small></p>` : ''}</div></div>${a.grade.needsReview ? '<p class="hint warn">要確認の参考点です。教材や基準に不足がある可能性もあります。「採点について相談・質問する」から確認できます。</p>' : ''}${md(a.grade.feedback)}${a.grade.criteria.map((c) => `<div class="criterion"><strong>${esc(c.id)} · ${c.points}点</strong>${esc(c.reason)}${c.evidence ? `<blockquote>回答の根拠：${esc(c.evidence)}</blockquote>` : ''}</div>`).join('')}<details ${a.grade.mode === 'self' ? '' : 'open'}><summary>模範解答と解説</summary>${md(a.modelAnswer)}</details><details><summary>採点基準</summary>${md(a.rubric)}</details><h3>復習するなら</h3><div class="actions">${a.reviewChapterIds
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
function tutorView() {
  if (!tutorSession) return '<p>問題から相談を開いてください。</p>';
  const session = tutorSession;
  return `<button class="flat back" data-action="tutor-back">← 問題に戻る</button><div class="topline"><div><h1>${esc(session.questionTitle)}について相談</h1><p>「どこから考えればいい？」から聞けます。この会話は採点を変えません。</p></div><button data-action="tutor-new">新しい会話に分岐</button></div><div class="paper"><details><summary>引き継いだ問題・回答・採点</summary>${md(question()?.prompt ?? '')}${
    question()
      ?.resolvedContext?.questions.map((q) => `<h3>${esc(q.title)}の条件</h3>${md(q.prompt)}`)
      .join('') ?? ''
  }${question()?.resolvedContext?.text ? md(question().resolvedContext!.text) : ''}<h3>相談を始めた時の回答</h3>${md(session.answerSnapshot || 'まだ回答していません。')}${session.gradeSnapshot ? `<h3>採点結果（参考）</h3>${md(session.gradeSnapshot.feedback)}` : ''}</details><div aria-live="polite">${session.messages.map((m) => `<section class="tutor-message ${m.failed ? 'hint warn' : ''}"><h3>${m.role === 'user' ? 'あなた' : 'AI'}</h3>${md(m.text)}</section>`).join('') || '<p class="hint">例：何を求められているのか分かりません。小さい例から説明して。</p>'}</div><form id="tutor-form"><label for="tutor-input">聞きたいこと</label><textarea id="tutor-input" rows="4" maxlength="4000" required ${busy ? 'disabled' : ''}>${esc(tutorInput)}</textarea><p class="hint">送信すると、問題・関連教材・参考解答・相談開始時の回答・採点結果と、直近10件の会話をINIAD AI-MOPへ送ります。会話はこのパソコンに保存します。</p>${modelPicker('tutor-model')}<div class="actions"><button type="submit" class="primary" ${busy || !status.aiConfigured ? 'disabled' : ''}>${busy ? '返答を待っています…' : '質問を送る'}</button>${!status.aiConfigured ? '<button type="button" data-view="settings">AIの設定を開く</button>' : ''}</div></form></div><details class="paper"><summary>この問題の相談履歴（${tutorSessions.length}件）</summary>${tutorSessions.map((s) => `<p><button data-tutor-session="${esc(s.id)}">${new Date(s.createdAt).toLocaleString('ja-JP')} · ${s.messages.length}件のメッセージ</button></p>`).join('')}</details>`;
}
function modelPicker(id: string) {
  return `<label for="${id}">今回のモデル</label><select id="${id}">${[...new Set([status.model, 'gpt-6-luna', 'gpt-6-astra'])].map((model) => `<option value="${esc(model)}">${esc(model)}${model.includes('astra') ? '（利用枠に注意）' : ''}</option>`).join('')}</select>`;
}
function generationView() {
  if (!generationPlan || !current()) return '<p>資料から教材作成を開いてください。</p>';
  const plan = generationPlan,
    job = generationJob;
  const stateName = {
    running: '生成中',
    completed: '選択範囲の生成完了',
    failed: '途中で停止',
    cancelled: '停止済み',
    interrupted: 'アプリ終了により中断',
  };
  return `<button class="flat back" data-view="study">← 元資料に戻る</button><h1>元資料から教材を作る</h1><div class="paper form"><h2>${esc(current().title)}</h2><p>本文 ${plan.totalCharacters.toLocaleString()}文字・全${plan.totalUnits}区間。1区間につきAIを1回呼び出し、解説・確認問題・参考解答・採点基準を作ります。</p><p class="hint">利用枠の正確な残量は自動取得できません。まず少ない回数で確認してください。上限に達すると停止し、成功した区間を残します。画像・図表を読み直す機能はなく、取り込んだ本文だけを使います。</p><form id="generation-form"><label for="generation-start">開始する区間</label><input id="generation-start" type="number" min="1" max="${plan.totalUnits}" value="1" required><label for="generation-calls">今回生成する区間数（開始区間から順番）</label><input id="generation-calls" type="number" min="1" max="${Math.min(20, plan.totalUnits)}" value="${Math.min(3, plan.totalUnits)}" required><p id="generation-scope" class="hint"></p>${modelPicker('generation-model')}<p class="hint">「教材を生成」を押すと、選択した範囲の本文をINIAD AI-MOPへ送信します。1回の出力上限は6,144トークン。これは消費量の予測やquotaの保証ではありません。元資料はそのまま残ります。</p><button class="primary" type="submit" ${job?.state === 'running' || !status.aiConfigured ? 'disabled' : ''}>教材を生成</button>${!status.aiConfigured ? '<button type="button" data-view="settings">AIの設定を開く</button>' : ''}</form></div>${
    job
      ? `<section class="paper" aria-live="polite"><h2>${stateName[job.state]} · ${job.completed.length}/${job.plannedCalls}回</h2><p>この結果では元資料の${(job.startUnit ?? 0) + 1}区間目から ${job.completed.length}/${job.totalUnits}区間を教材化しています。${job.completed.length < job.totalUnits ? '未生成の範囲があります。' : ''}</p>${job.error ? `<p role="alert" class="hint warn">${esc(job.error)}</p>` : ''}${job.state === 'running' ? `<p>画面を閉じてもアプリが動いていれば処理は続きます。</p><button data-action="generation-cancel" ${job.cancelRequested ? 'disabled' : ''}>${job.cancelRequested ? '停止を待っています' : '次の呼び出しから停止'}</button>` : ''}${
          job.draft
            ? `<h3>生成内容を確認</h3><p class="hint">AIの誤りが含まれることがあります。説明・解答・配点を元資料と照合してください。登録後の問題からAIにも質問できます。</p>${job.draft.chapters
                .map(
                  (ch) =>
                    `<details><summary>${esc(ch.title)}</summary>${md(ch.content)}${job
                      .draft!.questions.filter((q) => q.chapterId === ch.id)
                      .map(
                        (q) =>
                          `<h4>${esc(q.title)} · ${q.maxPoints}点</h4>${md(q.prompt)}<details><summary>解答・採点基準</summary>${md(q.modelAnswer)}${md(q.rubric)}</details>`,
                      )
                      .join('')}</details>`,
                )
                .join(
                  '',
                )}${job.state !== 'running' ? `<button class="primary" data-action="generation-register">${job.registeredCourseId ? '登録した教材を開く' : '確認した内容を新しい教材として登録'}</button>` : ''}`
            : ''
        }</section>`
      : ''
  }<details class="paper"><summary>作成履歴</summary>${plan.jobs.map((j) => `<p><button data-generation-job="${esc(j.id)}">${new Date(j.createdAt).toLocaleString('ja-JP')} · ${stateName[j.state]} · ${j.completed.length}区間</button></p>`).join('') || '<p>まだありません。</p>'}</details>`;
}
async function refreshGeneration() {
  if (!generationJob) return;
  generationJob = await api<GenerationSummary>(`/generation/${generationJob.id}`);
  if (view === 'generation') render();
  clearTimeout(generationPoll);
  if (generationJob.state === 'running')
    generationPoll = window.setTimeout(() => {
      void run(refreshGeneration);
    }, 1500);
}
async function startTutor(forceNew = false) {
  await saveAnswer();
  if (view === 'attempt' && result) {
    courseId = result.courseId;
    questionId = result.questionId;
  }
  tutorSessions = await api<TutorSession[]>(`/tutor/${courseId}/${questionId}`);
  const matching = tutorSessions.find((s) =>
    result ? s.attemptId === result.id : !s.attemptId && s.answerSnapshot === answer,
  );
  tutorSession =
    !forceNew && matching
      ? matching
      : await api<TutorSession>('/tutor', {
          method: 'POST',
          body: JSON.stringify({
            courseId,
            questionId,
            answer,
            ...(forceNew && view === 'tutor' && tutorSession
              ? { parentSessionId: tutorSession.id }
              : {}),
            ...(result ? { attemptId: result.id } : {}),
          }),
        });
  tutorSessions = await api(`/tutor/${courseId}/${questionId}`);
  tutorInput = '';
  view = 'tutor';
  render();
  window.scrollTo(0, 0);
}
function usageView() {
  const data = usageData;
  if (!data) return '<p>利用状況を読み込めませんでした。</p>';
  const quota = data.quota,
    fmt = (n: number) => n.toLocaleString('ja-JP');
  const limits = data.lastLimits;
  return `<div class="topline"><div><span class="eyebrow">DAILY AI USAGE</span><h1>AI-MOPの利用状況</h1><p>日ごとの確認値と、このアプリで使った量。</p></div><button data-action="refresh-usage">表示を更新</button></div><div class="grid"><div class="card"><span class="tag ${quota?.isToday ? '' : 'warn'}">${quota?.isToday ? '今日のquota確認値' : quota ? '前回の確認値（本日ではありません）' : 'quota未確認'}</span><p class="quota-number">${quota ? fmt(quota.remaining) : '—'}<small> 残り</small></p><p class="muted">${quota ? `確認日時：${new Date(quota.observedAt).toLocaleString('ja-JP')}<br>${esc(quota.note)}` : '対話画面でquotaを実行し、表示された残量を下に記録できます。'}</p><p class="hint">${quota?.isToday ? '最後にquotaで確認した時点の値です。現在の残量を自動取得した表示ではありません。' : '今日の残量は未確認です。日付が変わっても、この値を自動補充しません。'}</p></div><div class="card"><span class="eyebrow">このアプリの本日の使用量</span><p class="quota-number">${fmt(data.totalTokens)}<small> tokens</small></p><p class="muted">AI呼び出し ${data.requests}回<br>${data.unreported ? `使用トークン数が返らなかった処理 ${data.unreported}回` : 'トークン数が返った処理の合計です。'}</p><p class="hint">Slackや他のアプリでの使用は含みません。AI-MOP側の換算方法が未確認のため、quota確認値から単純に差し引きません。</p></div></div><div class="paper form usage-form"><h2>quotaの残量を記録する</h2><p class="muted">対話画面でquotaと送り、表示された日次残量を入力します。毎日の固定上限としては保存しません。</p><form id="quota-form"><label for="quota-remaining">今回quotaで確認した残量</label><input id="quota-remaining" type="number" min="0" step="1" max="9007199254740991" placeholder="quotaに表示された数値" required><button class="primary" type="submit">今の確認値として記録</button></form></div><div class="paper usage-form"><h2>今日のモデル別使用量</h2>${data.models.length ? `<div class="markdown"><table><thead><tr><th>モデル</th><th>AI呼び出し</th><th>入力</th><th>出力</th><th>合計</th></tr></thead><tbody>${data.models.map((m) => `<tr><td>${esc(m.model)}</td><td>${m.requests}回</td><td>${fmt(m.inputTokens)}</td><td>${fmt(m.outputTokens)}</td><td>${fmt(m.totalTokens)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">今日はまだ、このアプリからAIを呼び出していません。</p>'}<small>日付は日本時間の ${esc(data.today)}。AI-MOP側の実際のリセット時刻やモデル別換算は未確認です。失敗した処理もAI呼び出しの回数に含めます。</small>${
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
function folderImportPanel() {
  return `<section class="paper form"><h2>フォルダーからまとめて追加</h2><p>サブフォルダーも含め、PDF・Markdown・テキストを1つの教材にまとめます。</p><form id="folder-import-form"><label for="material-folder">資料のフォルダー</label><input id="material-folder" type="file" webkitdirectory multiple><label for="folder-title">まとめる教材の名前</label><input id="folder-title" maxlength="160" required placeholder="例：情報数学 第1〜6回"><div id="folder-preview"></div><p class="hint">一度に最大50ファイル・合計100MB・本文合計500,000文字。1ファイル15MBまで。JSON教材は下のファイル欄で別に追加してください。選択した資料だけをこのPCのアプリへ取り込み、この段階ではAIへ送りません。</p><p id="folder-error" class="hint warn" role="alert" hidden></p><button type="submit" class="primary" id="folder-submit" disabled>選択した資料をまとめて追加</button></form><p class="hint">追加後に「この資料からAI教材を作る」でまとめて教材化できます。PDFの図表や画像は本文へ正しく反映されない場合があるため、取り込んだ内容を確認してください。</p></section>`;
}
function folderSelectionSummary() {
  const selected = folderFiles.filter((f) => f.selected),
    total = selected.reduce((sum, f) => sum + f.file.size, 0);
  const valid = selected.length > 0 && selected.length <= 50 && total <= 100 * 1024 * 1024;
  const summary = document.querySelector('#folder-summary');
  if (summary)
    summary.textContent = `${selected.length}/${folderFiles.length}ファイルを選択 · 合計${(total / 1024 / 1024).toFixed(1)}MB。${valid ? '一覧を確認して追加してください。' : '最大50ファイル・合計100MB以内になるよう選んでください。'}`;
  const button = document.querySelector<HTMLButtonElement>('#folder-submit');
  if (button) button.disabled = !valid;
}
function folderPreview() {
  const target = document.querySelector('#folder-preview');
  if (!target) return;
  target.innerHTML = `<p id="folder-summary"></p>${folderSkipped ? `<p class="muted">対象外の${folderSkipped}ファイルは送信しません（JSON・画像・隠しフォルダーなど）。</p>` : ''}${folderFiles.length ? `<div class="actions"><button type="button" id="folder-select-all">すべて選択</button><button type="button" id="folder-select-none">すべて解除</button></div><div class="folder-file-list">${folderFiles.map((f, i) => `<label class="folder-file"><input type="checkbox" data-folder-file="${i}" ${f.selected ? 'checked' : ''} ${f.file.size > 15 * 1024 * 1024 ? 'disabled' : ''}><span>${esc(f.path)}<small>${(f.file.size / 1024 / 1024).toFixed(2)}MB${f.file.size > 15 * 1024 * 1024 ? ' · 15MB超のため選択できません' : ''}</small></span></label>`).join('')}</div>` : '<p>PDF・Markdown・テキストのあるフォルダーを選んでください。</p>'}`;
  target.querySelectorAll<HTMLInputElement>('[data-folder-file]').forEach(
    (el) =>
      (el.onchange = () => {
        folderFiles[Number(el.dataset.folderFile)]!.selected = el.checked;
        folderSelectionSummary();
      }),
  );
  const setAll = (selected: boolean) => {
    folderFiles.forEach((f) => (f.selected = selected && f.file.size <= 15 * 1024 * 1024));
    folderPreview();
  };
  const all = target.querySelector<HTMLButtonElement>('#folder-select-all'),
    none = target.querySelector<HTMLButtonElement>('#folder-select-none');
  if (all) all.onclick = () => setAll(true);
  if (none) none.onclick = () => setAll(false);
  folderSelectionSummary();
}
function bindFolderImport() {
  const picker = document.querySelector<HTMLInputElement>('#material-folder');
  const form = document.querySelector<HTMLFormElement>('#folder-import-form');
  if (!picker || !form) return;
  if (!('webkitdirectory' in picker)) {
    document.querySelector('#folder-preview')!.textContent =
      'このブラウザーではフォルダーを選べません。通常のファイル追加を使ってください。';
    return;
  }
  if (folderFiles.length) folderPreview();
  picker.onchange = () => {
    const files = Array.from(picker.files ?? []);
    folderFiles = files
      .filter(
        (file) =>
          /\.(pdf|md|txt)$/i.test(file.name) &&
          !(file.webkitRelativePath || file.name)
            .split('/')
            .some((part) => part.startsWith('.') || part === 'node_modules'),
      )
      .map((file) => ({
        file,
        path: file.webkitRelativePath || file.name,
        selected: file.size <= 15 * 1024 * 1024,
      }))
      .sort(
        (a, b) =>
          a.path.localeCompare(b.path, 'ja', { numeric: true }) ||
          (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
      );
    folderSkipped = files.length - folderFiles.length;
    const name = document.querySelector<HTMLInputElement>('#folder-title')!;
    if (!name.value.trim())
      name.value = (files[0]?.webkitRelativePath.split('/')[0] || 'まとめた資料').slice(0, 160);
    document.querySelector<HTMLElement>('#folder-error')!.hidden = true;
    folderPreview();
  };
  form.onsubmit = (e) => {
    e.preventDefault();
    void run(async () => {
      const selected = folderFiles.filter((f) => f.selected);
      if (
        !selected.length ||
        selected.length > 50 ||
        selected.reduce((sum, f) => sum + f.file.size, 0) > 100 * 1024 * 1024
      ) {
        folderSelectionSummary();
        return;
      }
      const data = new FormData();
      data.append('title', document.querySelector<HTMLInputElement>('#folder-title')!.value.trim());
      data.append('paths', JSON.stringify(selected.map((f) => f.path)));
      selected.forEach((f) => data.append('files', f.file, f.file.name));
      const button = document.querySelector<HTMLButtonElement>('#folder-submit')!,
        error = document.querySelector<HTMLElement>('#folder-error')!;
      button.disabled = true;
      picker.disabled = true;
      busy = true;
      form
        .querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button')
        .forEach((el) => (el.disabled = true));
      button.textContent = '資料の本文を確認しています…';
      error.hidden = true;
      try {
        const imported = await api<{ id: string; files: number }>('/materials/folder', {
          method: 'POST',
          body: data,
        });
        await reload();
        courseId = imported.id;
        chapterId = current().chapters[0]!.id;
        tab = 'read';
        view = 'study';
        folderFiles = [];
        folderSkipped = 0;
        render();
        window.scrollTo(0, 0);
        notice(
          `${imported.files}資料を1つの教材にまとめました。本文を確認してからAI教材を作れます。`,
        );
      } catch (err) {
        error.hidden = false;
        error.textContent =
          err instanceof Error
            ? err.message
            : '取り込めませんでした。選択した資料を確認してください。';
      } finally {
        busy = false;
        form
          .querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button')
          .forEach((el) => (el.disabled = false));
        picker.disabled = false;
        button.textContent = '選択した資料をまとめて追加';
        if (form.isConnected) folderPreview();
      }
    });
  };
}
function importForm() {
  return `<div class="topline"><div><span class="eyebrow">BUILD YOUR LIBRARY</span><h1>学びたい教材を追加する</h1><p>科目を問わず、使いたい教材を何度でも。</p></div></div>${folderImportPanel()}${materialPromptPanel()}<div class="paper form"><span class="eyebrow">STEP 2 · 教材を取り込む</span><h2>元資料・完成した教材を追加する</h2><form id="import-form"><label for="material-title">教材の名前</label><input id="material-title" name="title" placeholder="例：統計学 第1回"><label for="material-file">教材ファイル</label><input id="material-file" name="file" type="file" accept=".pdf,.md,.txt,.json" required><p class="muted">PDF・Markdown・テキスト、または問題付き教材パッケージ（JSON）。1ファイル15MBまで。</p><p class="hint">問題付きのJSONなら、そのまま学習・採点を始められます。本文だけのファイルは、まず読むための教材として追加します。追加後に「この資料からAI教材を作る」で、解説・問題・解答・採点基準をまとめて生成できます。</p><p class="hint">PDFは文字を取り出せるものに対応します。画像だけのPDF、図表や数式の配置は正確に読み取れない場合があるため、追加後に本文を確認してください。元ファイルは変更しません。</p><button class="primary" type="submit">この教材を追加する</button></form></div>`;
}
function settings() {
  return `<div class="topline"><div><span class="eyebrow">AI CONNECTION</span><h1>INIAD AI-MOPの設定</h1><p>普段はLuna、必要なときにAstra。</p></div></div><div class="paper form"><span class="tag ${status.aiConfigured ? '' : 'warn'}">${status.aiConfigured ? '鍵を設定済み（接続は未確認）' : '未設定'}</span><form id="settings-form"><label for="api-key">AI-MOPのAPIキー</label><input id="api-key" type="password" autocomplete="off" placeholder="${status.aiConfigured ? '変更するときだけ入力' : 'ご自身のパソコンで入力してください'}" ${status.aiConfigured ? '' : 'required'}><small>Windowsではユーザー単位で暗号化し、プロジェクト外に保存します。画面やGitHubへキーを出しません。</small><label for="model-name">標準のモデル名</label><input id="model-name" list="model-options" value="${esc(status.model)}" required pattern="[a-zA-Z0-9._:/\-]+"><datalist id="model-options"><option value="gpt-6-luna"><option value="gpt-6-astra"></datalist><p><small>AI-MOPで利用できる正式な名前を指定します。Lunaを普段の採点に使い、必要な問題だけAstraを選べます。</small></p><div class="actions"><button type="submit" class="primary">設定を保存</button><button type="button" data-action="models" ${status.aiConfigured ? '' : 'disabled'}>利用できるモデルを確認</button></div><p id="model-result" class="hint" hidden></p></form><div class="settings-separator"><h3>利用枠を大切に使うために</h3><p class="muted">1問ずつ採点し、過去の会話全体は送りません。失敗した処理は自動で再送しません。残りの利用枠はAI-MOP側で確認してください。</p><small>このアプリは自分のパソコン専用です。共有・公開して使う機能は初期版には含まれません。</small></div></div>`;
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
  gradingError = '';
  answer = fresh ? '' : (await api<{ answer: string }>(`/draft/${courseId}/${id}`)).answer;
  view = 'question';
  render();
  window.scrollTo(0, 0);
}
function bind() {
  bindFolderImport();
  document.querySelectorAll<HTMLElement>('[data-tutor-session]').forEach(
    (el) =>
      (el.onclick = () => {
        if (busy) return;
        tutorSession = tutorSessions.find((s) => s.id === el.dataset.tutorSession)!;
        tutorInput = '';
        render();
      }),
  );
  document.querySelectorAll<HTMLElement>('[data-generation-job]').forEach(
    (el) =>
      (el.onclick = () =>
        run(async () => {
          generationJob = await api(`/generation/${el.dataset.generationJob}`);
          await refreshGeneration();
        })),
  );
  const tutorInputEl = document.querySelector<HTMLTextAreaElement>('#tutor-input');
  if (tutorInputEl)
    tutorInputEl.oninput = () => {
      tutorInput = tutorInputEl.value;
    };
  const tutorForm = document.querySelector<HTMLFormElement>('#tutor-form');
  if (tutorForm)
    tutorForm.onsubmit = (e) => {
      e.preventDefault();
      void run(async () => {
        const text = tutorInput.trim();
        if (!text || !tutorSession) return;
        const model = document.querySelector<HTMLSelectElement>('#tutor-model')!.value;
        busy = true;
        render();
        try {
          tutorSession = await api(`/tutor/${tutorSession.id}/message`, {
            method: 'POST',
            body: JSON.stringify({ text, model }),
          });
          tutorInput = '';
          tutorSessions = await api(`/tutor/${courseId}/${questionId}`);
        } finally {
          busy = false;
          render();
        }
        document.querySelector('#tutor-form')?.scrollIntoView({ block: 'end' });
      });
    };
  const generationForm = document.querySelector<HTMLFormElement>('#generation-form');
  if (generationForm) {
    const calls = document.querySelector<HTMLInputElement>('#generation-calls')!;
    const start = document.querySelector<HTMLInputElement>('#generation-start')!;
    const updateScope = () => {
      const startUnit = Math.max(0, Number(start.value) - 1);
      const units = generationPlan!.units.slice(startUnit, startUnit + Number(calls.value));
      const last = units.at(-1);
      document.querySelector('#generation-scope')!.textContent =
        `最大${units.length}回の呼び出し・本文${units.reduce((s, u) => s + u.characters, 0).toLocaleString()}文字を送信。範囲：第${start.value}区間〜${last?.title ?? ''}の${last?.end ?? 0}文字目。`;
    };
    start.oninput = updateScope;
    calls.oninput = updateScope;
    updateScope();
    generationForm.onsubmit = (e) => {
      e.preventDefault();
      void run(async () => {
        const maxCalls = Number(calls.value),
          model = document.querySelector<HTMLSelectElement>('#generation-model')!.value;
        const button = generationForm.querySelector<HTMLButtonElement>('button[type=submit]')!;
        button.disabled = true;
        try {
          const started = await api<{ id: string }>('/generation', {
            method: 'POST',
            body: JSON.stringify({ courseId, maxCalls, model, startUnit: Number(start.value) - 1 }),
          });
          generationJob = await api(`/generation/${started.id}`);
          generationPlan = await api(`/generation/plan/${courseId}`);
          await refreshGeneration();
        } finally {
          button.disabled = false;
        }
      });
    };
  }

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
  if (name === 'open-tutor' || name === 'tutor-new') {
    await startTutor(name === 'tutor-new');
    return;
  }
  if (name === 'tutor-back') {
    await openQuestion(questionId);
    return;
  }
  if (name === 'open-generation') {
    generationPlan = await api(`/generation/plan/${courseId}`);
    generationJob = null;
    view = 'generation';
    render();
    if (generationPlan!.jobs[0]) {
      generationJob = await api(`/generation/${generationPlan!.jobs[0].id}`);
      await refreshGeneration();
    }
    return;
  }
  if (name === 'generation-cancel' && generationJob) {
    await api(`/generation/${generationJob.id}/cancel`, { method: 'POST' });
    await refreshGeneration();
    return;
  }
  if (name === 'generation-register' && generationJob) {
    const registered = await api<{ id: string }>(`/generation/${generationJob.id}/register`, {
      method: 'POST',
    });
    await reload();
    courseId = registered.id;
    chapterId = current().chapters[0]!.id;
    tab = 'read';
    view = 'study';
    render();
    return;
  }

  if (name === 'remove-key') {
    await api('/settings/key', { method: 'DELETE' });
    await reload();
    render();
    notice('保存したキーと、このアプリのメモリ上のキーを削除しました。');
    return;
  }
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
    gradingError = '';
    result = null;
    busy = true;
    render();
    try {
      result = await api<Attempt>('/grade', {
        method: 'POST',
        body: JSON.stringify({ courseId, questionId, answer, mode, selfScore, model }),
      });
      history = await api('/history');
      solution = null;
    } catch (error) {
      gradingError =
        error instanceof Error
          ? error.message
          : '採点を完了できませんでした。回答は保存されています。';
      throw error;
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
