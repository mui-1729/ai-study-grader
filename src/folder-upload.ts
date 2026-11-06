import multer from 'multer';
import { mkdirSync, createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { MATERIAL_LIMITS } from './material-limits.js';

export async function removeUpload(file: Pick<Express.Multer.File, 'path'>) {
  try {
    await unlink(file.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
// Stream to private temporary files instead of retaining a whole large folder in RAM.
export function folderUpload(
  directory: string,
  totalByteLimit: number = MATERIAL_LIMITS.folderBytes,
) {
  const totals = new WeakMap<object, number>();
  const active = new WeakMap<object, Set<AbortController>>();
  const storage: multer.StorageEngine = {
    _handleFile(req, file, callback) {
      try {
        mkdirSync(directory, { recursive: true });
      } catch (error) {
        callback(error as Error);
        return;
      }
      const path = join(directory, `${randomUUID()}.tmp`);
      let size = 0;
      const controller = new AbortController();
      let controllers = active.get(req);
      if (!controllers) {
        controllers = new Set();
        active.set(req, controllers);
        const pending = controllers;
        req.once('aborted', () => {
          for (const controller of pending) controller.abort();
        });
      }
      controllers.add(controller);
      if (req.aborted) controller.abort();
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          const total = (totals.get(req) ?? 0) + chunk.length;
          totals.set(req, total);
          if (total > totalByteLimit) return done(new Error('folder_total_size'));
          size += chunk.length;
          done(null, chunk);
        },
      });
      void pipeline(file.stream, counter, createWriteStream(path, { flags: 'wx', mode: 0o600 }), {
        signal: controller.signal,
      }).then(
        () => {
          controllers.delete(controller);
          callback(null, { path, size });
        },
        async (error) => {
          controllers.delete(controller);
          try {
            await removeUpload({ path });
          } catch {
            /* Keep cleanup errors from hiding the upload error. */
          }
          callback(error);
        },
      );
    },
    _removeFile(_req, file, callback) {
      void removeUpload(file).then(() => callback(null), callback);
    },
  };
  return multer({
    storage,
    limits: {
      fileSize: MATERIAL_LIMITS.fileBytes,
      files: MATERIAL_LIMITS.folderFiles,
      fields: 3,
      fieldSize: 512 * 1024,
      parts: MATERIAL_LIMITS.folderFiles + 4,
    },
  }).array('files', MATERIAL_LIMITS.folderFiles);
}
