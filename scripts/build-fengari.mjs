#!/usr/bin/env node
/**
 * 重新生成 src/assets/vendor/fengari/fengari-web.js
 *
 * 为什么需要这个脚本：
 *   fengari npm 包不提供浏览器 bundle，而且它用 `typeof process` 区分 Node / 浏览器分支。
 *   browserify 会自动注入 process polyfill，于是 bundle 会**错误地走进 Node 分支**，
 *   加载时 require('fs') 直接炸（典型报错 `Cannot read properties of undefined (reading 'O_CREAT')`）。
 *
 *   所以打包时必须给 fengari 源码打两类补丁：
 *     1. 把所有 `typeof process` 守卫钉死到浏览器分支；
 *     2. 摘掉 io 与 package 两个标准库
 *        （io 依赖 fs；package 依赖 child_process 且能任意加载模块，CIP 沙箱本来就该禁）。
 *
 *   补丁通过 browserify 的 **global transform** 在打包管线里做，不改 node_modules 里的文件
 *   —— 既天然幂等，也避开了 Windows 上文件被杀软/索引器占用导致的 EPERM。
 *
 * 用法：node scripts/build-fengari.mjs
 * 构建目录 .fengari-build/ 已 gitignore；里面若已装好依赖会跳过 npm install。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD_DIR = path.join(ROOT, '.fengari-build');
const OUT_FILE = path.join(ROOT, 'src', 'assets', 'vendor', 'fengari', 'fengari-web.js');

const FENGARI_VERSION = '0.1.5';
const BROWSERIFY_VERSION = '17.0.1';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
const log = (msg) => console.log('[build-fengari] ' + msg);

// ---------- 1. 构建目录 ----------
fs.mkdirSync(BUILD_DIR, { recursive: true });
const PKG_FILE = path.join(BUILD_DIR, 'package.json');
const PKG_JSON =
  JSON.stringify(
    {
      name: 'fengari-build',
      private: true,
      version: '1.0.0',
      dependencies: { browserify: BROWSERIFY_VERSION, fengari: FENGARI_VERSION }
    },
    null,
    2
  ) + '\n';
if (!fs.existsSync(PKG_FILE) || fs.readFileSync(PKG_FILE, 'utf8') !== PKG_JSON) {
  fs.writeFileSync(PKG_FILE, PKG_JSON);
}

const NM = path.join(BUILD_DIR, 'node_modules');
const FENGARI_SRC = path.join(NM, 'fengari', 'src');
const BROWSERIFY_BIN = path.join(
  NM,
  '.bin',
  process.platform === 'win32' ? 'browserify.cmd' : 'browserify'
);

if (fs.existsSync(FENGARI_SRC) && fs.existsSync(BROWSERIFY_BIN)) {
  log('检测到已安装的依赖，跳过 npm install');
} else {
  log('安装 fengari@' + FENGARI_VERSION + ' + browserify@' + BROWSERIFY_VERSION + ' …');
  run(npm, ['install', '--no-audit', '--no-fund'], BUILD_DIR);
}
if (!fs.existsSync(FENGARI_SRC)) throw new Error('找不到 fengari 源码目录: ' + FENGARI_SRC);

// ---------- 2. 写 transform 与入口 ----------
const TRANSFORM_SRC = String.raw`
// browserify global transform：给 fengari 源码打 CIP 补丁（不落盘改 node_modules）
'use strict';
var path = require('path');
var through = require('through2');

var MARK = ' /* CIP: force browser branch */ ';
var counters = { flipped: 0, io: 0, pkg: 0 };

function patch(file, src) {
  var base = path.basename(file);

  // 1) 钉死 process 守卫 → 一律走浏览器分支
  src = src
    .replace(/typeof process === "undefined"/g, function () { counters.flipped++; return 'true' + MARK; })
    .replace(/typeof process !== "undefined"/g, function () { counters.flipped++; return 'false' + MARK; });

  // 2) lualib.js：摘掉 io / package 的导出
  if (base === 'lualib.js') {
    // 注意：守卫已被上一步替换成 if (false /* CIP ... */ ) { —— 正则要能吃掉括号里的注释
    src = src.replace(
      /if \(false[^)]*\)\s*\{\n\s*const LUA_IOLIBNAME[\s\S]*?\n\}\n/,
      function () { counters.io++; return "// CIP build: io library requires Node 'fs' — dropped.\n"; }
    );
    src = src.replace(
      /const LUA_LOADLIBNAME = "package";\n[^\n]*\n[^\n]*\n/,
      function () { counters.pkg++; return "// CIP build: package library requires Node 'child_process' — dropped.\n"; }
    );
  }

  // 3) linit.js：不把 io / package 注册进 loadedlibs
  if (base === 'linit.js') {
    src = src.replace(/const \{ luaopen_package \}\s*=\s*require\('\.\/loadlib\.js'\);\n/, '');
    src = src.replace(/loadedlibs\[lualib\.LUA_LOADLIBNAME\] = luaopen_package;\n/, function () { counters.pkg++; return ''; });
    src = src.replace(/if \(false[^)]*\)\s*\n\s*loadedlibs\[lualib\.LUA_IOLIBNAME\][^\n]*\n/, function () { counters.io++; return ''; });
  }

  return src;
}

module.exports = function (file) {
  var normalized = file.split(path.sep).join('/');
  if (normalized.indexOf('/node_modules/fengari/src/') === -1) return through();
  var buf = '';
  return through(
    function (chunk, enc, cb) { buf += chunk.toString('utf8'); cb(); },
    function (cb) {
      var out = patch(file, buf);
      if (/LUA_IOLIBNAME|luaopen_package/.test(out) && /lualib\.js|linit\.js$/.test(file)) {
        return cb(new Error('CIP 补丁未生效: ' + file + ' 仍残留 io/package 引用'));
      }
      this.push(out);
      cb();
    }
  );
};

process.on('exit', function () {
  console.error('[cip-patch] 守卫 ' + counters.flipped + ' 处 / io ' + counters.io + ' 处 / package ' + counters.pkg + ' 处');
});
`;
fs.writeFileSync(path.join(BUILD_DIR, 'cip-patch.js'), TRANSFORM_SRC.trimStart());

fs.writeFileSync(
  path.join(BUILD_DIR, 'cip-entry.js'),
  [
    '// CIP build entry: bundle fengari for the browser (window.fengari)',
    "var fengari = require('fengari');",
    "if (typeof window !== 'undefined') window.fengari = fengari;",
    "if (typeof global !== 'undefined') global.fengari = fengari;",
    'module.exports = fengari;',
    ''
  ].join('\n')
);

// ---------- 3. 打包 ----------
fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
log('browserify 打包中 …');
run(
  BROWSERIFY_BIN,
  ['cip-entry.js', '-g', './cip-patch.js', '--standalone', 'fengari', '-o', OUT_FILE],
  BUILD_DIR
);

// ---------- 4. 冒烟检查 ----------
const bundle = fs.readFileSync(OUT_FILE, 'utf8');
for (const bad of ["require('fs')", 'require("fs")', "require('child_process')"]) {
  if (bundle.includes(bad)) throw new Error('打包结果里仍残留 ' + bad + '，补丁没生效');
}
if (!bundle.includes('CIP: force browser branch')) {
  throw new Error('打包结果里找不到补丁标记，global transform 可能没跑到 fengari 源码上');
}
const mb = (fs.statSync(OUT_FILE).size / 1024 / 1024).toFixed(2);
log('产物: ' + path.relative(ROOT, OUT_FILE) + ' (' + mb + ' MB)');
log('完成。请在应用内打开「设置 → 开发者 → Lua 小程序调试器」验证。');
