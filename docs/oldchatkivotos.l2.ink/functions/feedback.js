// /feedback —— 反馈页（Cloudflare Pages Function）
// 设计目标：与下载页一致的「绝对加载速度」纯服务端渲染、纯黑白风格、
// 按钮无圆角、hover 向左上偏移留纯黑残影、按下复原。仅内联最少 CSS，无外部字体/图片/JS。
// 结构：标题 → 反馈输入区域（类型 select + 内容 textarea）→ 公开反馈列表。
// 存储：复用现有 RELEASES KV namespace，键 fb:list 存全部反馈 JSON 数组。

const KV_KEY = 'fb:list';
const TYPES = ['问题反馈', '意见修复', '留言'];
const STATUSES = ['待查看', '已查看', '已解决', '不解决', '延后', '正在解决'];
const MAX_CONTENT = 1000;
const MAX_ITEMS = 200; // 公开列表最多展示条数

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

function genId() {
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

// 相对路径重定向（自动解析为绝对 URL；Cloudflare / Node 都收绝对地址）
function redirect(req, p, status) {
    return new Response('', {
        status: status || 303,
        headers: { 'location': new URL(p, req.url).href, 'cache-control': 'no-store' }
    });
}

const CSS = '' +
    'body{max-width:760px;margin:0 auto;padding:24px;font-family:-apple-system,"Noto Sans SC",sans-serif;line-height:1.7;color:#000;background:#fff}\n' +
    'h1{font-size:32px;margin:8px 0;font-weight:800;letter-spacing:-0.5px}\n' +
    'h2{margin:40px 0 12px;font-size:20px;border-bottom:2px solid #000;padding-bottom:6px}\n' +
    'a{color:#000;text-decoration:underline}\n' +
    'a:hover{text-decoration:none}\n' +
    '.subtitle{margin:0 0 24px;color:#000;font-size:16px;font-weight:500}\n' +
    '.intro{margin:0 0 28px;color:#000;font-size:14px}\n' +
    '.btn{display:inline-block;padding:10px 18px;border:2px solid #000;background:#fff;color:#000;font-weight:700;text-decoration:none;margin:6px 6px 6px 0;border-radius:0;white-space:nowrap;box-shadow:0 0 0 #000;cursor:pointer;font-size:14px;font-family:inherit;transition:transform .12s ease,box-shadow .12s ease,background-color .12s ease,color .12s ease}\n' +
    '.btn:hover{background:#000;color:#fff;transform:translate(-3px,-3px);box-shadow:3px 3px 0 #000}\n' +
    '.btn:active{background:#fff;color:#000;transform:translate(0,0);box-shadow:0 0 0 #000}\n' +
    '.btn:focus-visible{background:#000;color:#fff;outline:none}\n' +
    '.btn.danger{color:#b00020;border-color:#b00020}\n' +
    '.btn.danger:hover{background:#b00020;color:#fff;box-shadow:3px 3px 0 #b00020}\n' +
    '.btn.danger:active{background:#fff;color:#b00020}\n' +
    '.btn-inline{display:inline-block;border-bottom:2px solid #000;font-weight:700;color:#000;text-decoration:none;cursor:pointer}\n' +
    '.btn-inline:hover{background:#000;color:#fff;border-bottom-color:#000}\n' +
    // 表单
    'form{margin:14px 0 0}\n' +
    'label{display:block;font-weight:700;font-size:14px;margin:16px 0 6px}\n' +
    'select,textarea,input[type=text]{width:100%;box-sizing:border-box;padding:10px 12px;border:2px solid #000;background:#fff;color:#000;border-radius:0;font-size:14px;font-family:inherit;outline:none}\n' +
    'select:focus,textarea:focus,input[type=text]:focus{background:#fff;color:#000;box-shadow:3px 3px 0 #000}\n' +
    'textarea{resize:vertical;min-height:120px;line-height:1.6}\n' +
    '.form-actions{margin-top:16px}\n' +
    '.hint{font-size:12px;color:#000;margin:6px 0 0}\n' +
    '.hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}\n' +
    // 提示条
    '.notice{border:2px solid #000;padding:12px 16px;margin:0 0 20px;background:#fff;font-size:14px;font-weight:600}\n' +
    '.notice.err{border-color:#b00020;color:#b00020}\n' +
    // 公开列表
    '.fb-count{font-size:13px;color:#000;margin:0 0 12px}\n' +
    '.fb-list{display:flex;flex-direction:column;gap:14px}\n' +
    '.fb-item{border:2px solid #000;padding:14px 16px;background:#fff}\n' +
    '.fb-meta{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:8px}\n' +
    '.badge{display:inline-block;font-size:12px;font-weight:700;color:#fff;background:#000;padding:2px 8px;border-radius:0}\n' +
    '.badge.outline{color:#000;background:#fff;border:2px solid #000;padding:1px 7px}\n' +
    '.fb-time{font-size:12px;color:#000;margin-left:auto}\n' +
    '.fb-content{margin:0;font-size:14px;color:#000;white-space:pre-wrap;word-break:break-word}\n' +
    '.fb-empty{border:2px dashed #000;padding:24px;text-align:center;font-size:14px;color:#000}\n' +
    '.admin-link{margin-top:36px;font-size:14px}\n';

function renderItem(item) {
    const type = TYPES.indexOf(item.type) >= 0 ? item.type : '留言';
    const status = STATUSES.indexOf(item.status) >= 0 ? item.status : '待查看';
    return '<div class="fb-item">\n' +
        '  <div class="fb-meta">\n' +
        '    <span class="badge">' + esc(type) + '</span>\n' +
        '    <span class="badge outline">' + esc(status) + '</span>\n' +
        '    <span class="fb-time">' + esc(fmtDate(item.createdAt)) + '</span>\n' +
        '  </div>\n' +
        '  <p class="fb-content">' + esc(item.content) + '</p>\n' +
        '</div>\n';
}

function render(items, opts) {
    opts = opts || {};
    let notice = '';
    if (opts.ok) {
        notice = '<div class="notice">反馈已提交，谢谢你的反馈！</div>\n';
    } else if (opts.err === 'empty') {
        notice = '<div class="notice err">反馈内容不能为空。</div>\n';
    } else if (opts.err === 'type') {
        notice = '<div class="notice err">反馈类型无效。</div>\n';
    } else if (opts.err === 'long') {
        notice = '<div class="notice err">反馈内容过长（最多 ' + MAX_CONTENT + ' 字）。</div>\n';
    } else if (opts.err === 'bot') {
        notice = '<div class="notice err">提交失败，请稍后再试。</div>\n';
    }

    const shown = items.slice(0, MAX_ITEMS);
    let listHtml;
    if (!shown.length) {
        listHtml = '<div class="fb-empty">还没有反馈，来做第一个吧。</div>\n';
    } else {
        listHtml = '<div class="fb-list">\n' + shown.map(renderItem).join('') + '</div>\n';
    }

    return '<!doctype html>\n' +
        '<html lang="zh-CN">\n' +
        '<head>\n' +
        '  <meta charset="utf-8">\n' +
        '  <meta name="viewport" content="width=device-width, initial-scale=1">\n' +
        '  <meta name="description" content="OldChat For Kivotos Next（桃信旧聊）用户反馈页。提交问题反馈、意见修复或留言，并查看公开反馈列表。">\n' +
        '  <title>OldChat For Kivotos Next — 反馈</title>\n' +
        '  <style>\n' + CSS + '  </style>\n' +
        '</head>\n' +
        '<body>\n' +
        '  <h1>OldChat For Kivotos Next<br>反馈</h1>\n' +
        '  <p class="subtitle">一个 MomoTalk 风格的第三方 OldChat 桌面客户端</p>\n' +
        notice +
        '  <h2>提交反馈</h2>\n' +
        '  <form method="POST" action="/feedback">\n' +
        '    <label for="ftype">反馈类型</label>\n' +
        '    <select id="ftype" name="type">\n' +
        '      <option value="问题反馈">问题反馈</option>\n' +
        '      <option value="意见修复">意见修复</option>\n' +
        '      <option value="留言">留言</option>\n' +
        '    </select>\n' +
        '    <label for="fcontent">反馈内容</label>\n' +
        '    <textarea id="fcontent" name="content" maxlength="' + MAX_CONTENT + '" required placeholder="请描述你遇到的问题、建议或想说的话……"></textarea>\n' +
        '    <p class="hint">最多 ' + MAX_CONTENT + ' 字。提交即公开显示在下方列表中。</p>\n' +
        '    <input class="hp" type="text" name="hp" tabindex="-1" autocomplete="off" aria-hidden="true">\n' +
        '    <div class="form-actions">\n' +
        '      <button class="btn" type="submit">提交反馈</button>\n' +
        '    </div>\n' +
        '  </form>\n' +
        '  <h2>公开反馈</h2>\n' +
        '  <p class="fb-count">共 ' + items.length + ' 条反馈' + (items.length > MAX_ITEMS ? '（展示最新 ' + MAX_ITEMS + ' 条）' : '') + '</p>\n' +
        listHtml +
        '  <p class="admin-link"><a class="btn-inline" href="/feedback/admin">反馈管理 →</a></p>\n' +
        '  <p style="margin-top:24px"><a class="btn" href="/">返回官网</a></p>\n' +
        '</body>\n' +
        '</html>\n';
}

export async function onRequestGet(context) {
    const { env } = context;
    const url = new URL(context.request.url);
    const ok = url.searchParams.get('ok') === '1';
    const err = url.searchParams.get('err') || '';
    const items = await getList(env.RELEASES);
    return new Response(render(items, { ok: ok, err: err }), {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=30' }
    });
}

export async function onRequestPost(context) {
    const { env, request } = context;
    let fd;
    try {
        fd = await request.formData();
    } catch (e) {
        return redirect(request, '/feedback?err=bot', 303);
    }

    // 蜜罐：机器人通常会填这个隐藏字段，直接假装成功但不存储
    if ((fd.get('hp') || '').trim() !== '') {
        return redirect(request, '/feedback?ok=1', 303);
    }

    const type = (fd.get('type') || '').trim();
    const content = (fd.get('content') || '').trim();

    if (!content) return redirect(request, '/feedback?err=empty', 303);
    if (content.length > MAX_CONTENT) return redirect(request, '/feedback?err=long', 303);
    if (TYPES.indexOf(type) < 0) return redirect(request, '/feedback?err=type', 303);

    const items = await getList(env.RELEASES);
    items.unshift({
        id: genId(),
        type: type,
        content: content,
        status: '待查看',
        createdAt: new Date().toISOString()
    });
    await saveList(env.RELEASES, items);

    return redirect(request, '/feedback?ok=1', 303);
}
