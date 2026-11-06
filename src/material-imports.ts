import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Course } from './schema.js';
import { folderMaterialCourse, persistCourse, FolderMaterialError } from './materials.js';
import { removeUpload } from './folder-upload.js';
import type { OCRFactory, OCRMode, ReadProgress } from './ocr.js';
export type MaterialImport = {
  id: string;
  title: string;
  state: 'running' | 'cancelling' | 'completed' | 'cancelled' | 'failed';
  file: string;
  fileIndex: number;
  fileCount: number;
  page: number;
  pages: number;
  phase: ReadProgress['phase'];
  progress: number;
  ocrPages: number;
  warnings: string[];
  courseId?: string;
  error?: string;
};
export class ImportBusyError extends Error {}
export function materialImports(directory: string, courses: Course[], ocrFactory?: OCRFactory) {
  const jobs = new Map<string, MaterialImport>();
  const controllers = new Map<string, AbortController>();
  let active = false;
  return {
    get: (id: string) => jobs.get(id),
    cancel(id: string) {
      const job = jobs.get(id);
      if (job?.state === 'running') {
        job.state = 'cancelling';
        controllers.get(id)?.abort();
      }
    },
    start(title: string, files: { path: string; upload: Express.Multer.File }[], mode: OCRMode) {
      if (active) throw new ImportBusyError();
      active = true;
      const controller = new AbortController();
      const job: MaterialImport = {
        id: randomUUID(),
        title,
        state: 'running',
        file: '',
        fileIndex: 0,
        fileCount: files.length,
        page: 0,
        pages: 0,
        phase: 'text',
        progress: 0,
        ocrPages: 0,
        warnings: [],
      };
      for (const [id, old] of jobs) {
        if (jobs.size < 40) break;
        if (old.state !== 'running' && old.state !== 'cancelling') jobs.delete(id);
      }
      jobs.set(job.id, job);
      controllers.set(job.id, controller);
      void (async () => {
        try {
          const course = await folderMaterialCourse(
            title,
            files.map(({ path, upload }) => ({
              path,
              size: upload.size,
              read: () => readFile(upload.path),
            })),
            {
              ocrMode: mode,
              signal: controller.signal,
              ocrFactory,
              onFile(path, index, count) {
                Object.assign(job, {
                  file: path,
                  fileIndex: index,
                  fileCount: count,
                  page: 0,
                  pages: 0,
                  phase: 'text',
                  progress: 0,
                });
              },
              onProgress(value) {
                Object.assign(job, value);
              },
              onOCR(page, score, empty) {
                job.ocrPages++;
                if ((empty || score < 60) && job.warnings.length < 100)
                  job.warnings.push(
                    `${job.file}・${page}ページ：${empty ? '文字を確認できませんでした。空白・図のみ・認識失敗の可能性があります。' : `認識スコア${score}/100。元資料との照合が必要です。`}`,
                  );
              },
            },
          );
          controller.signal.throwIfAborted();
          if (files.length === 1) course.description = '自分で追加した元資料';
          if (job.ocrPages)
            course.description += `。${job.ocrPages}ページをOCRで抽出。数式・図表・読み取り結果を元資料と照合してください。`;
          persistCourse(directory, course);
          courses.push(course);
          job.courseId = course.id;
          job.state = 'completed';
          job.progress = 1;
        } catch (error) {
          job.state = controller.signal.aborted ? 'cancelled' : 'failed';
          job.error = controller.signal.aborted
            ? '取り込みを停止しました。教材は追加していません。'
            : error instanceof FolderMaterialError
              ? error.message
              : '資料を取り込めませんでした。PDFの破損・パスワード・OCRの状態を確認してください。教材は追加していません。';
        } finally {
          await Promise.allSettled(files.map((file) => removeUpload(file.upload)));
          controllers.delete(job.id);
          active = false;
        }
      })();
      return job;
    },
  };
}
