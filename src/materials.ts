import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { courseSchema, type Course } from './schema.js';
import { MATERIAL_LIMITS } from './material-limits.js';
export function persistCourse(directory: string, raw: unknown): Course {
  const course = courseSchema.parse(raw);
  writeFileSync(join(directory, `${course.id}.json`), JSON.stringify(course, null, 2), {
    encoding: 'utf8',
    flag: 'wx',
  });
  return course;
}
export async function extractMaterial(file: {
  originalname: string;
  buffer: Buffer;
}): Promise<string> {
  if (/\.(md|txt)$/i.test(file.originalname))
    return new TextDecoder('utf-8', { fatal: true }).decode(file.buffer);
  if (!/\.pdf$/i.test(file.originalname))
    throw new Error('PDF・Markdown・テキストを選んでください。');
  const task = getDocument({
    data: new Uint8Array(file.buffer),
    useSystemFonts: true,
    stopAtErrors: true,
  });
  try {
    const doc = await task.promise;
    if (doc.numPages > MATERIAL_LIMITS.pdfPages)
      throw new Error('PDFは1,000ページ以内に分けてください。');
    let text = '';
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i),
        content = await page.getTextContent();
      text +=
        `\n\n## ${i}ページ\n\n` +
        content.items
          .map((item) =>
            'str' in item ? item.str + ('hasEOL' in item && item.hasEOL ? '\n' : ' ') : '',
          )
          .join('');
      if (text.length > MATERIAL_LIMITS.textCharacters)
        throw new Error('本文が長すぎます。ファイルを分けてください。');
    }
    const body = text.replace(/^## \d+ページ/gm, '').trim();
    if (body.length < 50)
      throw new Error(
        'このPDFから本文を取り出せませんでした。画像だけのPDFは、文字起こししたテキストを追加してください。',
      );
    return text;
  } finally {
    await task.destroy();
  }
}
export function materialCourse(title: string, content: string): Course {
  if (content.trim().length < 10 || content.length > MATERIAL_LIMITS.textCharacters)
    throw new Error('本文は10〜5,000,000文字で追加してください。');
  const chunks: string[] = [];
  for (let start = 0; start < content.length; start += 24000)
    chunks.push(content.slice(start, start + 24000));
  return courseSchema.parse({
    schemaVersion: 1,
    id: `course-${randomUUID()}`,
    version: '1',
    title,
    description: '自分で追加した教材',
    gradingPolicy: '指定された解答と採点基準に従い、同じ意味の表現や正しい別解を認める。',
    chapters: chunks.map((body, i) => ({
      id: `ch-${i + 1}`,
      title: chunks.length === 1 ? '教材本文' : `教材本文 ${i + 1}`,
      content: body,
    })),
    questions: [],
  });
}
export class FolderMaterialError extends Error {}
export function materialPath(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const parts = normalized.split('/');
  if (
    normalized.length > 512 ||
    parts.some((p) => !p || p.startsWith('.') || p === 'node_modules') ||
    /[\x00-\x1f:]/.test(normalized) ||
    !/\.(pdf|md|txt)$/i.test(normalized)
  )
    throw new FolderMaterialError(
      'フォルダーにはPDF・Markdown・テキストだけを選んでください。隠しフォルダー・開発用フォルダーは対象外です。',
    );
  return normalized;
}
export type FolderMaterial = { path: string } & (
  { buffer: Buffer } | { size: number; read: () => Promise<Buffer> }
);
export async function folderMaterialCourse(
  title: string,
  files: FolderMaterial[],
): Promise<Course> {
  if (!files.length || files.length > MATERIAL_LIMITS.folderFiles)
    throw new FolderMaterialError('一度に追加できる資料は1〜200ファイルです。');
  const entries = files.map((file) => ({ ...file, path: materialPath(file.path) }));
  if (new Set(entries.map((f) => f.path.toLowerCase())).size !== entries.length)
    throw new FolderMaterialError('同じ相対パスの資料が重複しています。');
  if (
    entries.some((f) => ('buffer' in f ? f.buffer.length : f.size) > MATERIAL_LIMITS.fileBytes) ||
    entries.reduce((s, f) => s + ('buffer' in f ? f.buffer.length : f.size), 0) >
      MATERIAL_LIMITS.folderBytes
  )
    throw new FolderMaterialError('資料は1ファイル50MB以下、合計500MB以下で選んでください。');
  // Numeric file ordering makes lecture-2 precede lecture-10 and keeps subfolder names.
  entries.sort(
    (a, b) =>
      a.path.localeCompare(b.path, 'ja', { numeric: true }) ||
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  );
  const chapters: Course['chapters'] = [];
  let total = 0;
  for (const file of entries) {
    let content: string;
    try {
      const buffer = 'buffer' in file ? file.buffer : await file.read();
      if (buffer.length > MATERIAL_LIMITS.fileBytes) throw new Error();
      content = await extractMaterial({ originalname: file.path, buffer });
      if (content.trim().length < 10) throw new Error();
    } catch {
      throw new FolderMaterialError(
        `「${file.path}」を読み取れませんでした。UTF-8の本文、または文字を抽出できる1,000ページ以内のPDFを使ってください。まだ教材は追加していません。この資料を外して再試行できます。`,
      );
    }
    total += content.length;
    if (total > MATERIAL_LIMITS.textCharacters)
      throw new FolderMaterialError(
        '本文の合計は5,000,000文字以内にしてください。選択する資料を減らしてください。まだ教材は追加していません。',
      );
    for (let start = 0, part = 1; start < content.length; start += 24000, part++) {
      chapters.push({
        id: `ch-${chapters.length + 1}`,
        title: file.path + (content.length > 24000 ? `（${part}）` : ''),
        content: content.slice(start, start + 24000),
      });
    }
  }
  return courseSchema.parse({
    schemaVersion: 1,
    id: `course-${randomUUID()}`,
    version: '1',
    title,
    description: `フォルダーから${entries.length}資料をまとめて追加した元資料`,
    gradingPolicy: '同じ意味の表現や正しい別解を認める。',
    chapters,
    questions: [],
  });
}
