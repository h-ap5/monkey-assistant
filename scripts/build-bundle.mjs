import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const inputs = [
  resolve(root, 'vendor/jszip.min.js'),
  resolve(root, 'analysis-core.js'),
  resolve(root, 'app.js')
];

const sections = await Promise.all(inputs.map(async file => {
  const source = await readFile(file, 'utf8');
  return source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trimEnd();
}));

const banner = '/* 몽키 어시스턴트 배포 번들 · npm run build로 생성 · 직접 수정 금지 */';
const outputFile = resolve(root, 'app.bundle.js');
const expected = `${banner}\n${sections.join('\n')}\n`;

if (process.argv.includes('--check')) {
  let current = '';
  try { current = await readFile(outputFile, 'utf8'); } catch { /* reported below */ }
  if (current !== expected) {
    console.error('app.bundle.js가 원본 소스보다 오래되었습니다. npm run build를 실행하세요.');
    process.exitCode = 1;
  } else {
    console.log('app.bundle.js 최신 상태 확인 완료');
  }
} else {
  await writeFile(outputFile, expected, 'utf8');
  console.log('app.bundle.js 생성 완료');
}
