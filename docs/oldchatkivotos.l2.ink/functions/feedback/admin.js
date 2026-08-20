// /feedback/admin —— 反馈管理页（Cloudflare Pages Function，需密码）
// 路由（同文件，靠 action 隐藏字段区分）：
//   GET  /feedback/admin                      未登录 → 登录页；已登录 → 管理面板
//   POST /feedback/admin  action=login        password 校验，成功下发 cookie
//   POST /feedback/admin  action=setstatus    id + status 更新状态（需登录）
//   POST /feedback/admin  action=delete        id 删除一条反馈（需登录）
//   POST /feedback/admin  action=logout       清除 cookie
// 鉴权：无外部 KV 会话，采用「密码哈希写入 HttpOnly Cookie」的轻量无状态方案。
//   cookie 值 = sha256(ADMIN_PW + ':' + SALT)，服务端按当前密码重算并比对，无法伪造（不知密码即不可得）。
// 存储：复用 RELEASES KV namespace，键 fb:list（与 /feedback 共享）。

const KV_KEY = 'fb:list';
const TYPES = ['问题反馈', '意见修复', '留言'];
const STATUSES = ['待查看', '已查看', '已解决', '不解决', '延后', '正在解决'];

// 管理员密码：取自 Cloudflare Pages 密钥 FEEDBACK_ADMIN_PW（通过 `wrangler pages secret put` 设置，不进源码）。
// 未配置时 adminPw 返回 undefined，登录恒失败、面板锁定 —— 源码里不残留任何密码明文。
const SALT = 'oc-kn-feedback-salt-v1';
function adminPw(env) {
    return env && env.FEEDBACK_ADMIN_PW;
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
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
        + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

async function sha256Hex(str) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return Array.prototype.map.call(new Uint8Array(buf), function (b) {
        return b.toString(16).padStart(2, '0');
    }).join('');
}

async function getList(kv) {
    try {
        const raw = await kv.get(KV_KEY, 'json');
        if (Array.isArray(raw)) return raw;
    } catch (e) { /* ignore */ }
    return [];
}

async function saveList(kv, list) {
    await kv.put(KV_KEY, JSON.stringify(list));
}

// 读取并校验会话 cookie
async function validSession(request, env) {
    const c = request.headers.get('cookie') || '';
    const m = c.match(/(?:^|;\s*)fba=([^;]+)/);
    if (!m) return false;
    const expected = await sha256Hex(adminPw(env) + ':' + SALT);
    return m[1] === expected;
}

function cookieHeader(token, maxAge) {
    return 'fba=' + token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + maxAge;
}

// 将相对路径解析为绝对 URL（Cloudflare / Node 的 Response.redirect 都收绝对地址）
function loc(req, p) {
    return new URL(p, req.url).href;
}

// 相对路径重定向（自动解析为绝对 URL）
function redirect(req, p, status) {
    return new Response('', {
        status: status || 303,
        headers: { 'location': loc(req, p), 'cache-control': 'no-store' }
    });
}

const CSS = '' +
    'body{max-width:860px;margin:0 auto;padding:24px;font-family:-apple-system,"Noto Sans SC",sans-serif;line-height:1.7;color:#000;background:#fff}\n' +
    'h1{font-size:30px;margin:8px 0;font-weight:800;letter-spacing:-0.5px}\n' +
    'h2{margin:32px 0 12px;font-size:18px;border-bottom:2px solid #000;padding-bottom:6px}\n' +
    'a{color:#000;text-decoration:underline}\n' +
    'a:hover{text-decoration:none}\n' +
    '.subtitle{margin:0 0 20px;color:#000;font-size:15px;font-weight:500}\n' +
    '.topbar{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:8px}\n' +
    '.btn{display:inline-block;padding:9px 16px;border:2px solid #000;background:#fff;color:#000;font-weight:700;text-decoration:none;border-radius:0;white-space:nowrap;box-shadow:0 0 0 #000;cursor:pointer;font-size:14px;font-family:inherit;transition:transform .12s ease,box-shadow .12s ease,background-color .12s ease,color .12s ease}\n' +
    '.btn:hover{background:#000;color:#fff;transform:translate(-3px,-3px);box-shadow:3px 3px 0 #000}\n' +
    '.btn:active{background:#fff;color:#000;transform:translate(0,0);box-shadow:0 0 0 #000}\n' +
    '.btn.danger{color:#b00020;border-color:#b00020}\n' +
    '.btn.danger:hover{background:#b00020;color:#fff;box-shadow:3px 3px 0 #b00020}\n' +
    '.btn.danger:active{background:#fff;color:#b00020}\n' +
    '.btn-inline{display:inline-block;border-bottom:2px solid #000;font-weight:700;color:#000;text-decoration:none;cursor:pointer}\n' +
    '.btn-inline:hover{background:#000;color:#fff;border-bottom-color:#000}\n' +
    '.notice{margin:0 0 16px;border:2px solid #000;padding:10px 14px;background:#fff;font-size:14px;font-weight:600}\n' +
    '.notice.err{border-color:#b00020;color:#b00020}\n' +
    // 登录
    'form{margin:14px 0 0}\n' +
    'label{display:block;font-weight:700;font-size:14px;margin:14px 0 6px}\n' +
    'input[type=password],select{width:100%;box-sizing:border-box;padding:10px 12px;border:2px solid #000;background:#fff;color:#000;border-radius:0;font-size:14px;font-family:inherit;outline:none}\n' +
    'input[type=password]:focus,select:focus{background:#fff;color:#000;box-shadow:3px 3px 0 #000}\n' +
    // 列表
    '.fb-list{display:flex;flex-direction:column;gap:14px}\n' +
    '.fb-item{border:2px solid #000;padding:14px 16px;background:#fff}\n' +
    '.fb-head{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:8px}\n' +
    '.badge{display:inline-block;font-size:12px;font-weight:700;color:#fff;background:#000;padding:2px 8px;border-radius:0}\n' +
    '.fb-time{font-size:12px;color:#000;margin-left:auto}\n' +
    '.fb-content{margin:0 0 12px;font-size:14px;color:#000;white-space:pre-wrap;word-break:break-word}\n' +
    '.fb-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}\n' +
    '.fb-actions select{max-width:200px;margin:0}\n' +
    '.fb-empty{border:2px dashed #000;padding:24px;text-align:center;font-size:14px;color:#000}\n';

function renderLogin(opts) {
    opts = opts || {};
    const err = opts.err === 'bad' ? '<div class="notice err">密码错误。</div>\n' : '';
    return '<!doctype html>\n' +
        '<html lang="zh-CN">\n' +
        '<head>\n' +
        '  <meta charset="utf-8">\n' +
        '  <meta name="viewport" content="width=device-width, initial-scale=1">\n' +
        '  <meta name="robots" content="noindex">\n' +
        '  <title>反馈管理 — 登录</title>\n' +
        '  <style>\n' + CSS + '  </style>\n' +
        '</head>\n' +
        '<body>\n' +
        '  <h1>反馈管理</h1>\n' +
        '  <p class="subtitle">需要密码才能进入管理面板</p>\n' +
        err +
        '  <form method="POST" action="/feedback/admin">\n' +
        '    <input type="hidden" name="action" value="login">\n' +
        '    <label for="pw">管理员密码</label>\n' +
        '    <input type="password" id="pw" name="password" autocomplete="current-password" required>\n' +
        '    <div style="margin-top:16px"><button class="btn" type="submit">登录</button></div>\n' +
        '  </form>\n' +
        '  <p style="margin-top:24px"><a class="btn" href="/feedback">返回反馈页</a></p>\n' +
        '</body>\n' +
        '</html>\n';
}

function renderPanel(items) {
    let body;
    if (!items.length) {
        body = '<div class="fb-empty">还没有任何反馈。</div>\n';
    } else {
        body = '<div class="fb-list">\n' + items.map(function (it) {
            const type = TYPES.indexOf(it.type) >= 0 ? it.type : '留言';
            const cur = STATUSES.indexOf(it.status) >= 0 ? it.status : '待查看';
            const opts = STATUSES.map(function (s) {
                return '<option value="' + esc(s) + '"' + (s === cur ? ' selected' : '') + '>' + esc(s) + '</option>';
            }).join('');
            return '<div class="fb-item">\n' +
                '  <div class="fb-head">\n' +
                '    <span class="badge">' + esc(type) + '</span>\n' +
                '    <span class="fb-time">' + esc(fmtDate(it.createdAt)) + '</span>\n' +
                '  </div>\n' +
                '  <p class="fb-content">' + esc(it.content) + '</p>\n' +
                '  <div class="fb-actions">\n' +
                '    <form method="POST" action="/feedback/admin" style="margin:0;display:flex;gap:8px;align-items:center;flex-wrap:wrap">\n' +
                '      <input type="hidden" name="action" value="setstatus">\n' +
                '      <input type="hidden" name="id" value="' + esc(it.id) + '">\n' +
                '      <select name="status">' + opts + '</select>\n' +
                '      <button class="btn" type="submit">更新状态</button>\n' +
                '    </form>\n' +
                '    <form method="POST" action="/feedback/admin" style="margin:0" onsubmit="return confirm(\'确定删除这条反馈？\');">\n' +
                '      <input type="hidden" name="action" value="delete">\n' +
                '      <input type="hidden" name="id" value="' + esc(it.id) + '">\n' +
                '      <button class="btn danger" type="submit">删除</button>\n' +
                '    </form>\n' +
                '  </div>\n' +
                '</div>\n';
        }).join('') + '</div>\n';
    }

    return '<!doctype html>\n' +
        '<html lang="zh-CN">\n' +
        '<head>\n' +
        '  <meta charset="utf-8">\n' +
        '  <meta name="viewport" content="width=device-width, initial-scale=1">\n' +
        '  <meta name="robots" content="noindex">\n' +
        '  <title>反馈管理面板</title>\n' +
        '  <style>\n' + CSS + '  </style>\n' +
        '</head>\n' +
        '<body>\n' +
        '  <div class="topbar">\n' +
        '    <h1 style="margin:0">反馈管理</h1>\n' +
        '    <form method="POST" action="/feedback/admin" style="margin:0">\n' +
        '      <input type="hidden" name="action" value="logout">\n' +
        '      <button class="btn" type="submit">退出登录</button>\n' +
        '    </form>\n' +
        '  </div>\n' +
        '  <p class="subtitle">共 ' + items.length + ' 条反馈 · 设置处理后状态，或删除垃圾反馈。</p>\n' +
        '  <h2>全部反馈</h2>\n' +
        body +
        '  <p style="margin-top:24px"><a class="btn" href="/feedback">查看公开反馈页</a></p>\n' +
        '</body>\n' +
        '</html>\n';
}

export async function onRequestGet(context) {
    const { env, request } = context;
    if (!(await validSession(request, env))) {
        return new Response(renderLogin(), {
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
        });
    }
    const items = await getList(env.RELEASES);
    return new Response(renderPanel(items), {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
    });
}

export async function onRequestPost(context) {
    const { env, request } = context;
    let fd;
    try {
        fd = await request.formData();
    } catch (e) {
        return redirect(request, '/feedback/admin', 303);
    }
    const action = (fd.get('action') || '').trim();

    // —— 登录：无需已登录 ——
    if (action === 'login') {
        const pw = fd.get('password') || '';
        if (pw === adminPw(env)) {
            const token = await sha256Hex(adminPw(env) + ':' + SALT);
            return new Response('', {
                status: 303,
                headers: {
                    'location': loc(request, '/feedback/admin'),
                    'set-cookie': cookieHeader(token, 86400)
                }
            });
        }
        return new Response(renderLogin({ err: 'bad' }), {
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
        });
    }

    // —— 其余操作均需登录 ——
    if (!(await validSession(request, env))) {
        return new Response(renderLogin(), {
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
        });
    }

    if (action === 'logout') {
        return new Response('', {
            status: 303,
            headers: {
                'location': loc(request, '/feedback/admin'),
                'set-cookie': cookieHeader('', 0)
            }
        });
    }

    const id = (fd.get('id') || '').trim();

    if (action === 'setstatus') {
        const status = (fd.get('status') || '').trim();
        if (STATUSES.indexOf(status) >= 0 && id) {
            const items = await getList(env.RELEASES);
            const it = items.find(function (x) { return x.id === id; });
            if (it) {
                it.status = status;
                await saveList(env.RELEASES, items);
            }
        }
        return redirect(request, '/feedback/admin', 303);
    }

    if (action === 'delete') {
        if (id) {
            const items = await getList(env.RELEASES);
            const next = items.filter(function (x) { return x.id !== id; });
            await saveList(env.RELEASES, next);
        }
        return redirect(request, '/feedback/admin', 303);
    }

    return redirect(request, '/feedback/admin', 303);
}
