// 构建前把 src-tauri/tauri.conf.json 的 version 字段改为当前 Release 的 tag 对应的 semver。
// tag 形如 v6 / v6.1 / v6.1.2（可能带 v 前缀，也可能不带）——tauri 要求 version 必须是合法 semver，
// 因此这里统一归一化为 x.y.z（如 v6 → 6.0.0、v6.1 → 6.1.0、6.1.2 → 6.1.2）。
// 只改工作副本，不执行任何 git 提交，仓库里的 tauri.conf.json 保持不变。
// 用法：node scripts/set-version.mjs <tag>
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const tag = (process.argv[2] || '').trim();
if (!tag) {
    console.error('用法: node scripts/set-version.mjs <tag>');
    process.exit(1);
}

// 归一化 Release tag → semver x.y.z
function tagToSemver(t) {
    let s = t.replace(/^v/i, '');           // 去 v 前缀
    // 剥离预发布/构建元数据前的部分（如 6.0.0-beta.1 → 6.0.0；6.0.0+build5 → 6.0.0）
    s = s.replace(/[-+].*$/, '');
    const parts = s.split('.');
    const nums = [];
    for (const p of parts) {
        const n = p.replace(/\D+/g, '');
        if (n === '') break;
        nums.push(parseInt(n, 10));
    }
    while (nums.length < 3) nums.push(0);
    // 防御：若无法解析出任何数字（如纯字母 tag），退化为 0.0.0
    if (!nums.length) return '0.0.0';
    return nums.slice(0, 3).join('.');
}

const semver = tagToSemver(tag);
if (!/^\d+\.\d+\.\d+$/.test(semver)) {
    console.error('[set-version] 无法把 tag 归一化为 semver:', tag);
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

conf.version = semver;
writeFileSync(confPath, JSON.stringify(conf, null, 2) + '\n');
console.log('[set-version] tauri.conf.json version ->', semver, '(tag:', tag + ')');
