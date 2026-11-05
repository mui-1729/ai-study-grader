import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { courseSchema, type Course } from './schema.js';
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
    if (doc.numPages > 150) throw new Error('PDFは150ページ以内に分けてください。');
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
      if (text.length > 500000) throw new Error('本文が長すぎます。ファイルを分けてください。');
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
  if (content.trim().length < 10 || content.length > 500000)
    throw new Error('本文は10〜500,000文字で追加してください。');
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
