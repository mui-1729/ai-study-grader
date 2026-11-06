// Isolated local OCR process. This process receives only rendered page images.
const { createWorker, OEM } = require('tesseract.js');
let worker;
const send = (message) => {
  if (process.connected) process.send(message);
};
process.on('disconnect', () => process.exit(0));
process.on('message', async (message) => {
  if (message.type !== 'recognize' || !worker) return;
  try {
    const { data } = await worker.recognize(message.image);
    send({ type: 'result', text: data.text, confidence: data.confidence });
  } catch {
    send({ type: 'error' });
  }
});
createWorker('jpn+eng', OEM.LSTM_ONLY, {
  langPath: process.argv[2],
  gzip: true,
  cacheMethod: 'none',
  errorHandler: () => send({ type: 'error' }),
  logger: (event) => {
    if (event.status === 'recognizing text') send({ type: 'progress', value: event.progress });
  },
}).then(
  (value) => {
    worker = value;
    send({ type: 'ready' });
  },
  () => send({ type: 'error' }),
);
