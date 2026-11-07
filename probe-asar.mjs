import { flatten, readAsarHeader } from './tools/asar.mjs';
const ASAR = 'D:\\Tools\\DeepSeekHarness-Desktop\\resources\\app.asar';
const { header } = readAsarHeader(ASAR);
const entries = flatten(header);
const names = Object.keys(entries);
const hits = names.filter(n => n.includes('@deepseek-ai/') && n.split('/').length <= 5 && !n.includes('/lib/') && !n.includes('/dist/'));
const pkgs = new Set();
for (const n of hits) { const m = n.match(/@deepseek-ai\/[^/]+/); if (m) pkgs.add(m[0]); }
console.log('packages:', pkgs.size);
console.log([...pkgs].sort().join('\n'));
