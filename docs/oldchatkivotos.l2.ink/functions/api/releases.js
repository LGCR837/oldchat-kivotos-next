// GET /api/releases —— 读取 KV 里缓存的发行版数据，纯 GET，返回 JSON
const KEY = 'releases:latest';

const EMPTY = {
    updated_at: null,
    repo: 'LGCR837/oldchat-kivotos-next',
    count: 0,
    releases: []
};

export async function onRequestGet(context) {
    const { env } = context;

    let payload;
    try {
        payload = await env.RELEASES.get(KEY, 'text');
    } catch (e) {
        return json({ error: 'kv_unavailable', message: String(e) }, 500);
    }

    if (!payload) payload = JSON.stringify(EMPTY);

    return new Response(payload, {
        status: 200,
        headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'public, max-age=300',
            'access-control-allow-origin': '*'
        }
    });
}

export function onRequestOptions() {
    return new Response(null, {
        status: 204,
        headers: {
            'access-control-allow-origin': '*',
            'access-control-allow-methods': 'GET, OPTIONS',
            'access-control-allow-headers': 'content-type'
        }
    });
}

function json(obj, status) {
    return new Response(JSON.stringify(obj), {
        status: status || 200,
        headers: {
            'content-type': 'application/json; charset=utf-8',
            'access-control-allow-origin': '*'
        }
    });
}
