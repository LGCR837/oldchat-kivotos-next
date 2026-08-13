// /api/refresh
//   GET / POST 均触发：从 GitHub API 拉取「全部」Release（自动翻页），覆盖写入 KV
const KEY = 'releases:latest';
const REPO = 'LGCR837/oldchat-kivotos-next';

async function fetchAllReleases(headers) {
    let all = [];
    let page = 1;
    const per = 100;
    while (true) {
        const url = 'https://api.github.com/repos/' + REPO
            + '/releases?per_page=' + per + '&page=' + page;
        const up = await fetch(url, { headers });
        if (!up.ok) {
            const text = await up.text().catch(function () { return ''; });
            return { error: { ok: false, error: 'github_error', status: up.status, body: text.slice(0, 300) } };
        }
        let arr;
        try {
            arr = await up.json();
        } catch (e) {
            return { error: { ok: false, error: 'bad_json', message: String(e) } };
        }
        if (!Array.isArray(arr)) return { error: { ok: false, error: 'unexpected_shape' } };
        all = all.concat(arr);
        if (arr.length < per) break;
        if (++page > 50) break; // 安全上限：最多 5000 个
    }
    return { releases: all };
}

async function doRefresh(context) {
    const { env, request } = context;

    // 可选防滥用：若配置了 REFRESH_TOKEN，则必须带上同名 header（GET/POST 都校验）
    if (env.REFRESH_TOKEN) {
        const got = request.headers.get('x-refresh-token');
        if (got !== env.REFRESH_TOKEN) {
            return json({ ok: false, error: 'unauthorized' }, 401);
        }
    }

    const headers = {
        'accept': 'application/vnd.github+json',
        'user-agent': 'oldchat-kivotos-next-site',
        'x-github-api-version': '2022-11-28'
    };
    // 可选：配置 GITHUB_TOKEN 可把速率限制从 60/h 提到 5000/h
    if (env.GITHUB_TOKEN) headers['authorization'] = 'Bearer ' + env.GITHUB_TOKEN;

    const result = await fetchAllReleases(headers);
    if (result.error) return json(result.error, 502);

    const releases = result.releases
        .filter(function (r) { return r && !r.draft; })
        .map(function (r) {
            const assets = (r.assets || []).map(function (a) {
                return {
                    name: a.name,
                    browser_download_url: a.browser_download_url,
                    size: a.size
                };
            });
            return {
                tag: r.tag_name,
                name: r.name || r.tag_name,
                body: (r.body || '').replace(/\r/g, '').trim(),
                published_at: r.published_at,
                prerelease: !!r.prerelease,
                html_url: r.html_url,
                assets: assets
            };
        })
        .sort(function (a, b) {
            return new Date(b.published_at || 0) - new Date(a.published_at || 0);
        });

    const payload = {
        updated_at: new Date().toISOString(),
        repo: REPO,
        count: releases.length,
        releases: releases
    };

    // 覆盖写入
    try {
        await env.RELEASES.put(KEY, JSON.stringify(payload));
    } catch (e) {
        return json({ ok: false, error: 'kv_write_failed', message: String(e) }, 500);
    }

    return json({
        ok: true,
        updated_at: payload.updated_at,
        count: payload.count,
        tags: releases.map(function (r) { return r.tag; })
    }, 200);
}

export function onRequestGet(context) {
    return doRefresh(context);
}

export function onRequestPost(context) {
    return doRefresh(context);
}

function json(obj, status) {
    return new Response(JSON.stringify(obj), {
        status: status || 200,
        headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
            'access-control-allow-origin': '*'
        }
    });
}
