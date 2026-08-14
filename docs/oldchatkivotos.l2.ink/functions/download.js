// /download —— 极简下载页（Cloudflare Pages Function）
// 设计目标：绝对加载速度。纯服务端渲染、无外部字体/图片/JS，
// 纯黑白风格（无蓝色），按钮无圆角，hover 向左上偏移留纯黑残影、按下复原。
// 所有下载链接均为静态 GitHub Release 资源直链，写死在 HTML 里。

const KEY = 'releases:latest';
const REPO = 'LGCR837/oldchat-kivotos-next';
// GitHub 镜像中转（与主站一致），对下载透明；前缀到完整 GitHub 直链前
const MIRROR = 'https://gh.jasonzeng.dev/';

// KV 未刷新时的兜底标签（按 GitHub 实时数据：v6 / v5 / v4）
const FALLBACK_TAGS = ['v6', 'v5', 'v4'];

// 每个 tag 对应的 5 个产物（命名已与 GitHub Release 资产逐一对齐）
function buildAssets(tag) {
    return [
        ['Windows amd64', 'oldchat-kivotos-next-app-' + tag + '-windows-amd64.exe'],
        ['Windows arm64', 'oldchat-kivotos-next-app-' + tag + '-windows-arm64.exe'],
        ['Windows i386',  'oldchat-kivotos-next-app-' + tag + '-windows-i386.exe'],
        ['Linux amd64',   'oldchat-kivotos-next-app-' + tag + '-linux-amd64'],
        ['Linux arm64',   'oldchat-kivotos-next-app-' + tag + '-linux-arm64']
    ];
}

function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
}

function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

// 发布说明：转义 + 换行保留
function renderNotes(body) {
    if (!body) return '';
    return '<p class="notes">' + esc(body).replace(/\n/g, '<br>') + '</p>\n';
}

// 按文件名分类为 {os, arch, fmt, label}，未知格式返回 null（自动跳过）
function classify(name) {
    const n = String(name).toLowerCase();
    let os = '', arch = '', fmt = '';
    if (/\.dmg$/.test(n)) { os = 'macOS'; fmt = 'dmg'; }
    else if (/setup\.exe$/.test(n)) { os = 'Windows'; fmt = '安装包'; }
    else if (/\.msi$/.test(n)) { os = 'Windows'; fmt = 'MSI'; }
    else if (/windows-amd64\.exe$/.test(n)) { os = 'Windows'; arch = 'amd64'; }
    else if (/windows-arm64\.exe$/.test(n)) { os = 'Windows'; arch = 'arm64'; }
    else if (/windows-i386\.exe$/.test(n)) { os = 'Windows'; arch = 'i386'; }
    else if (/\.appimage$/.test(n)) { os = 'Linux'; fmt = 'AppImage'; }
    else if (/\.deb$/.test(n)) { os = 'Linux'; fmt = 'deb'; }
    else if (/\.rpm$/.test(n)) { os = 'Linux'; fmt = 'rpm'; }
    else if (/linux-amd64$/.test(n)) { os = 'Linux'; arch = 'amd64'; }
    else if (/linux-arm64$/.test(n)) { os = 'Linux'; arch = 'arm64'; }
    else return null;
    if (!arch) {
        if (/aarch64/.test(n) || /arm64/.test(n)) arch = 'arm64';
        else if (/x86_64/.test(n) || /x64/.test(n) || /amd64/.test(n)) arch = 'amd64';
    }
    let archLabel = arch;
    if (os === 'macOS') archLabel = (arch === 'arm64') ? 'Apple Silicon' : 'Intel';
    const label = os + (archLabel ? (' ' + archLabel) : '') + (fmt ? (' ' + fmt) : '');
    return { os: os, arch: archLabel, fmt: fmt, label: label };
}

// 渲染顺序（与下载页「不限制一行个数」一致，仅决定先后）
const RANK = {
    'Windows|amd64|': 1,
    'Windows|amd64|安装包': 2,
    'Windows|arm64|': 3,
    'Windows|arm64|安装包': 4,
    'Windows|i386|': 5,
    'Linux|amd64|': 6,
    'Linux|amd64|AppImage': 7,
    'Linux|amd64|deb': 8,
    'Linux|amd64|rpm': 9,
    'Linux|arm64|': 10,
    'macOS|Apple Silicon|dmg': 11,
    'macOS|Intel|dmg': 12
};

// 从真实资产渲染按钮；无资产时返回空串（交由调用方回退 buildAssets）
function buildLinksFromAssets(assets) {
    if (!assets || !assets.length) return '';
    const items = [];
    assets.forEach(function (a) {
        const c = classify(a.name);
        if (!c) return;
        const href = MIRROR + a.browser_download_url;
        items.push({
            rank: RANK[c.os + '|' + c.arch + '|' + c.fmt] || 99,
            html: '<a class="btn" href="' + esc(href) + '" target="_blank" rel="noopener">' + esc(c.label) + '</a>\n'
        });
    });
    if (!items.length) return '';
    items.sort(function (x, y) { return x.rank - y.rank; });
    return items.map(function (i) { return i.html; }).join('');
}

const CSS = '' +
    'body{max-width:720px;margin:0 auto;padding:24px;font-family:-apple-system,"Noto Sans SC",sans-serif;line-height:1.7;color:#000;background:#fff}\n' +
    'h1{font-size:32px;margin:8px 0;font-weight:800;letter-spacing:-0.5px}\n' +
    'h2{margin:44px 0 8px;font-size:20px;border-bottom:2px solid #000;padding-bottom:6px}\n' +
    'a{color:#000;text-decoration:underline}\n' +
    'a:hover{text-decoration:none}\n' +
    '.subtitle{margin:0 0 24px;color:#000;font-size:16px;font-weight:500}\n' +
    '.intro{margin:0 0 28px;color:#000;font-size:14px}\n' +
    '.v{margin:0 0 4px;color:#000;font-size:13px}\n' +
    '.notes{margin:12px 0 4px;color:#000;font-size:13px;white-space:pre-wrap}\n' +
    '.btn{display:inline-block;padding:10px 18px;border:2px solid #000;background:#fff;color:#000;font-weight:700;text-decoration:none;margin:6px 6px 6px 0;border-radius:0;white-space:nowrap;box-shadow:0 0 0 #000;transition:transform .12s ease,box-shadow .12s ease,background-color .12s ease,color .12s ease}\n' +
    '.btn:hover{background:#000;color:#fff;transform:translate(-3px,-3px);box-shadow:3px 3px 0 #000}\n' +
    '.btn:active{background:#fff;color:#000;transform:translate(0,0);box-shadow:0 0 0 #000}\n' +
    '.btn:focus-visible{background:#000;color:#fff;outline:none}\n' +
    '.tag{display:inline-block;font-size:12px;font-weight:700;color:#fff;background:#000;padding:2px 8px;margin-left:8px;vertical-align:middle;border-radius:0}\n' +
    '.dls{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px;margin:10px 0 0}\n' +
    '@media(max-width:400px){.dls{grid-template-columns:repeat(auto-fill,minmax(130px,1fr))}}\n' +
    '.dls .btn{margin:0;text-align:center}\n' +
    'ul{padding-left:20px}\n' +
    'li{margin:6px 0}\n' +
    '.notice{border:2px solid #000;padding:14px 16px;margin:0 0 24px;background:#fff}\n' +
    '.notice h2{margin:0 0 10px;border-bottom:0;padding:0;font-size:16px}\n' +
    '.notice ul{padding-left:18px;margin:6px 0}\n' +
    '.notice li{margin:5px 0;font-size:13px}\n' +
    '.notice-foot{margin:10px 0 0;font-size:13px}\n' +
    '.notice b{font-weight:700}\n' +
    '.btn-inline{display:inline-block;border-bottom:2px solid #000;font-weight:700;color:#000;text-decoration:none}\n' +
    '.btn-inline:hover{background:#000;color:#fff;border-bottom-color:#000}\n';

function render(releases) {
    const base = 'https://github.com/' + REPO + '/releases/download/';
    let blocks = '';

    releases.forEach(function (r, i) {
        const tag = esc(r.tag || r.name || '');
        if (!tag) return;
        const date = fmtDate(r.published_at);
        const badge = i === 0 ? ' <span class="tag">最新</span>' : '';

        let links = buildLinksFromAssets(r.assets);
        if (!links) {
            // 兜底：KV 中尚无资产列表时（如旧缓存），用写死的 5 产物
            buildAssets(tag).forEach(function (pair) {
                const label = pair[0];
                const file = pair[1];
                links += '<a class="btn" href="' + MIRROR + base + tag + '/' + file +
                    '" target="_blank" rel="noopener">' + esc(label) + '</a>\n';
            });
        }

        blocks += '<h2>' + tag + badge + '</h2>\n';
        if (date) blocks += '<p class="v">发布于 ' + date + '</p>\n';
        blocks += renderNotes(r.body);
        blocks += '<div class="dls">\n' + links + '</div>\n';
    });

    return '<!doctype html>\n' +
        '<html lang="zh-CN">\n' +
        '<head>\n' +
        '  <meta charset="utf-8">\n' +
        '  <meta name="viewport" content="width=device-width, initial-scale=1">\n' +
        '  <meta name="description" content="OldChat For Kivotos Next（桃信旧聊）历史版本下载，免安装单文件客户端。">\n' +
        '  <title>OldChat For Kivotos Next — 下载页</title>\n' +
        '  <style>\n' + CSS + '  </style>\n' +
        '</head>\n' +
        '<body>\n' +
        '  <h1>OldChat For Kivotos Next<br>下载页</h1>\n' +
        '  <p class="subtitle">一个 MomoTalk 风格的第三方 OldChat 桌面客户端</p>\n' +
        '  <p class="intro">OldChat For Kivotos Next 第三方 OldChat 桌面客户端。界面大幅参考了蔚蓝档案的 MomoTalk 风格，底层基于 Rust + Tauri + Web 构建，支持 Windows / Linux / macOS 多架构。提供免安装单文件与系统安装包（AppImage / deb / rpm / NSIS），并由 Aoharu Reverie (LGCR837) 开源维护。</p>\n' +
        '  <div class="notice">\n' +
        '    <h2>Windows 运行环境（打不开请装）</h2>\n' +
        '    <ul>\n' +
        '      <li><b>Windows 10</b>（大部分自带，不行再装）：<a class="btn-inline" href="https://developer.microsoft.com/zh-cn/microsoft-edge/webview2/" target="_blank" rel="noopener">' + esc('Microsoft Edge WebView2 运行时') + '</a></li>\n' +
        '      <li><b>Windows 7 / 8 / 8.1</b> 装 <b>WebView2 v109</b>（默认不自带）：<a class="btn-inline" href="https://www.catalog.update.microsoft.com/Search.aspx?q=webview2%20runtime%20109.0.1518.140" target="_blank" rel="noopener">' + esc('WebView2 Runtime 109.0.1518.140') + '</a></li>\n' +
        '      <li><b>VC++ 运行库</b>（报错再装，一般不用）：<a class="btn-inline" href="https://aka.ms/vc14/vc_redist.x64.exe" target="_blank" rel="noopener">x64</a> / <a class="btn-inline" href="https://aka.ms/vc14/vc_redist.x86.exe" target="_blank" rel="noopener">x86</a></li>\n' +
        '    </ul>\n' +
        '    <p class="notice-foot">Windows 7 请确保安装了 <b>SP1</b>，以及补丁：<a class="btn-inline" href="https://www.catalog.update.microsoft.com/Search.aspx?q=KB4490628" target="_blank" rel="noopener">KB4490628</a>（服务堆栈更新）、<a class="btn-inline" href="https://www.catalog.update.microsoft.com/Search.aspx?q=KB4474419" target="_blank" rel="noopener">KB4474419</a>（SHA-2 代码签名支持）。</p>\n' +
        '  </div>\n' +
        '  <p>\n' +
        '    <a class="btn" href="/">查看官网</a>\n' +
        '    <a class="btn" href="https://github.com/' + REPO + '/releases" target="_blank" rel="noopener">GitHub Releases</a>\n' +
        '  </p>\n' +
        blocks +
        '  <h2>说明</h2>\n' +
        '  <ul>\n' +
        '    <li>Windows 可直接双击 <b>免安装单文件</b> 运行，或用 <b>NSIS 安装包</b> 安装到系统；Linux 推荐用 <b>AppImage</b>（双击运行）/ <b>deb</b>（Ubuntu/Debian）/ <b>rpm</b>（Fedora）安装。</li>\n' +
        '    <li>macOS 为未签名 dmg：首次打开请<strong>右键 → 打开</strong>（或终端执行 <code>xattr -cr /Applications/OldChat\\ For\\ Kivotos.app</code>）以越过 Gatekeeper 拦截。</li>\n' +
        '    <li>Linux 免安装单文件与 macOS 原生包在部分环境需系统已带 WebView 框架。</li>\n' +
        '    <li>本项目基于 MIT License 开源，由 Aoharu Reverie（LGCR837）开发维护。</li>\n' +
        '  </ul>\n' +
        '</body>\n' +
        '</html>\n';
}

export async function onRequestGet(context) {
    const { env } = context;

    let releases = [];
    try {
        const raw = await env.RELEASES.get(KEY, 'text');
        if (raw) {
            const data = JSON.parse(raw);
            if (Array.isArray(data.releases) && data.releases.length) {
                releases = data.releases; // refresh 已按发布时间倒序排好
            }
        }
    } catch (e) {
        releases = [];
    }

    if (!releases.length) {
        releases = FALLBACK_TAGS.map(function (tag) {
            return { tag: tag, name: tag, published_at: null, body: '' };
        });
    }

    return new Response(render(releases), {
        status: 200,
        headers: {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'public, max-age=600'
        }
    });
}
