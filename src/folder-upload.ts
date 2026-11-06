import multer from 'multer';
// Bound retained memory across all files, including requests without Content-Length.
export function folderUpload(totalByteLimit = 100 * 1024 * 1024) {
  const totals = new WeakMap<object, number>();
  const storage: multer.StorageEngine = {
    _handleFile(req, file, callback) {
      let chunks: Buffer[] = [],
        size = 0,
        finished = false;
      const fail = (error: Error) => {
        if (finished) return;
        finished = true;
        chunks = [];
        callback(error);
      };
      file.stream.on('data', (chunk: Buffer) => {
        if (finished) return;
        const total = (totals.get(req) ?? 0) + chunk.length;
        totals.set(req, total);
        if (total > totalByteLimit) return fail(new Error('folder_total_size'));
        size += chunk.length;
        chunks.push(chunk);
      });
      file.stream.on('error', fail);
      file.stream.on('end', () => {
        if (finished) return;
        finished = true;
        callback(null, { buffer: Buffer.concat(chunks, size), size });
        chunks = [];
      });
    },
    _removeFile(_req, file, callback) {
      delete (file as Partial<Express.Multer.File>).buffer;
      callback(null);
    },
  };
  return multer({
    storage,
    limits: { fileSize: 15 * 1024 * 1024, files: 50, fields: 2, fieldSize: 65536, parts: 53 },
  }).array('files', 50);
}
