// /api/cfg —— 配置云同步（Cloudflare Pages Function + KV）
// 路由（全部在 /api 下）：
//   GET  /api/cfg?ncuid=<n>          读取完整配置（含 meta）
//   GET  /api/cfg?ncuid=<n>&meta=1   仅读取 meta（轮询用，轻量）
//   PUT  /api/cfg?ncuid=<n>          上传配置（body = 配置 JSON 字符串）
// 鉴权：无（面向全部用户的功能，无需密钥；以 ncuid 隔离）。
//   注意：CF Workers 禁止 fetch 明文 http:// 地址，无法用 OldChat access_token
//   在服务端做身份校验，故采用公开读写；配置本身不含登录凭据（客户端已排除）。
// 冲突控制：PUT 支持乐观锁——请求头 X-Base-Ts = 客户端上次同步时拿到的 meta.updatedAt。
//   若云端已存在且 X-Base-Ts ≠ 当前 updatedAt（云端在客户端之后被其它设备更新过）→ 409 拒绝覆盖。
// 存储：复用现有 RELEASES KV namespace，键 cfg:<ncuid> 与 meta:<ncuid> 隔离。
// 一致性：KV 最终一致（秒级），对配置同步足够。

const PREFIX_CFG = 'cfg:';
const PREFIX_META = 'meta:';
const MAX_BODY = 512 * 1024; // 512KB

function json(obj, status) {
    return new Response(JSON.stringify(obj), {
        status: status || 200,
        headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
            'access-control-allow-origin': '*',
            'access-control-allow-methods': 'GET, PUT, OPTIONS',
            'access-control-allow-headers': 'content-type, x-base-ts'
        }
    });
}

function validNcuid(n) {
    return typeof n === 'string' && /^[A-Za-z0-9_-]{3,64}$/.test(n);
}

async function sha256Hex(str) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return Array.prototype.map.call(new Uint8Array(buf), function (b) {
        return b.toString(16).padStart(2, '0');
    }).join('');
}

export async function onRequestGet(context) {
    const kv = context.env.RELEASES;
    const url = new URL(context.request.url);
    const ncuid = url.searchParams.get('ncuid') || '';
    const metaOnly = url.searchParams.get('meta') === '1';
    if (!validNcuid(ncuid)) return json({ ok: false, error: 'invalid_ncuid' }, 400);
    const meta = await kv.get(PREFIX_META + ncuid, 'json');
    if (!meta) return json({ ok: false, error: 'not_found' }, 404);
    if (metaOnly) return json({ ok: true, meta: meta });
    const data = await kv.get(PREFIX_CFG + ncuid);
    if (data === null) return json({ ok: false, error: 'not_found' }, 404);
    return json({ ok: true, data: data, meta: meta });
}

export async function onRequestPut(context) {
    const kv = context.env.RELEASES;
    const url = new URL(context.request.url);
    const ncuid = url.searchParams.get('ncuid') || '';
    if (!validNcuid(ncuid)) return json({ ok: false, error: 'invalid_ncuid' }, 400);
    const text = await context.request.text();
    if (text.length === 0) return json({ ok: false, error: 'empty_body' }, 400);
    if (text.length > MAX_BODY) return json({ ok: false, error: 'too_large' }, 413);
    // 乐观锁：客户端带 X-Base-Ts（上次同步的 updatedAt）。
    // 云端已存在且基准与当前 updatedAt 不一致 → 云端被其它设备更新过 → 409，拒绝覆盖。
    const baseTs = context.request.headers.get('x-base-ts') || '';
    const metaKey = PREFIX_META + ncuid;
    const existing = await kv.get(metaKey, 'json');
    if (existing && existing.updatedAt && baseTs && baseTs !== existing.updatedAt) {
        return json({ ok: false, error: 'conflict', meta: existing }, 409);
    }
    const hash = await sha256Hex(text);
    const meta = { updatedAt: new Date().toISOString(), size: text.length, hash: hash };
    await kv.put(PREFIX_CFG + ncuid, text);
    await kv.put(metaKey, JSON.stringify(meta));
    return json({ ok: true, meta: meta });
}

export async function onRequestOptions() {
    return new Response(null, {
        status: 204,
        headers: {
            'access-control-allow-origin': '*',
            'access-control-allow-methods': 'GET, PUT, OPTIONS',
            'access-control-allow-headers': 'content-type, x-base-ts',
            'access-control-max-age': '86400'
        }
    });
}
