import { readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { persistCourse } from '../src/materials.js';
const source = process.argv[2];
if (!source) throw new Error('教材JSONのパスを指定してください。');
mkdirSync('data/courses', { recursive: true });
const c = persistCourse(resolve('data/courses'), JSON.parse(readFileSync(source, 'utf8')));
console.log(`追加しました: ${c.title} / ${c.questions.length}問`);
