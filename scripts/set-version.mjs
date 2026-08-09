// 构建前把 src-tauri/tauri.conf.json 的 version 字段改为当前 Release 的 tag 名称（如 v6）。
// 只改工作副本，不执行任何 git 提交，仓库里的 tauri.conf.json 保持不变。
// 用法：node scripts/set-version.mjs <tag>
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const tag = process.argv[2];
if (!tag) {
    console.error('用法: node scripts/set-version.mjs <tag>');
    process.exit(1);
}

const dir = fileURLToPath(new URL('.', import.meta.url));
const confPath = join(dir, '..', 'src-tauri', 'tauri.conf.json');

let conf;
try {
    conf = JSON.parse(readFileSync(confPath, 'utf8'));
} catch (e) {
    console.error('[set-version] 读取 tauri.conf.json 失败:', e.message);
    process.exit(1);
}

conf.version = tag;
writeFileSync(confPath, JSON.stringify(conf, null, 2) + '\n');
console.log('[set-version] tauri.conf.json version ->', tag);
