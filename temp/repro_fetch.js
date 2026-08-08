// Repro: Tauri plugin-http style fetch wrapper + apiFetch clone path
function makeInvoke(bodyStr, splitInto) {
  const bytes = [...new TextEncoder().encode(bodyStr)];
  const chunks = [];
  const size = Math.max(1, Math.ceil(bytes.length / splitInto));
  for (let i = 0; i < bytes.length; i += size) {
    chunks.push([...bytes.slice(i, i + size), 0]); // append sentinel 0
  }
  chunks.push([1]); // EOF sentinel
  let idx = 0;
  return (cmd) => {
    if (cmd === 'plugin:http|fetch') return Promise.resolve({ rid: 1 });
    if (cmd === 'plugin:http|fetch_send') return Promise.resolve({ status: 200, statusText: 'OK', url: 'http://x', headers: [], rid: 1 });
    if (cmd === 'plugin:http|fetch_read_body') {
      const c = chunks[idx++] || [];
      return Promise.resolve(new Uint8Array(c));
    }
    return Promise.resolve();
  };
}

function tauriFetch(invoke) {
  return async (input, init) => {
    const rid = await invoke('plugin:http|fetch');
    const sendResp = await invoke('plugin:http|fetch_send');
    const body = new ReadableStream({
      pull: async (controller) => {
        const chunkData = await invoke('plugin:http|fetch_read_body');
        const u8 = new Uint8Array(chunkData);
        if (u8.byteLength === 0) { controller.close(); return; }
        const lastByte = u8[u8.byteLength - 1];
        const actualData = u8.slice(0, u8.byteLength - 1);
        if (lastByte === 1) { if (actualData.byteLength > 0) controller.enqueue(actualData); controller.close(); return; }
        controller.enqueue(actualData);
      }
    });
    return new Response(body, { status: sendResp.status, statusText: sendResp.statusText });
  };
}

async function run(label, bodyStr, splitInto, useClone) {
  const invoke = makeInvoke(bodyStr, splitInto);
  const fetchFn = (input, init) => tauriFetch(invoke)(input, init);
  const res = await fetchFn('/v1/test', {});
  const finalRes = useClone ? res.clone() : res;
  const text = await finalRes.text();
  let ok = true, err = '';
  try { JSON.parse(text); } catch (e) { ok = false; err = e.message; }
  console.log(`[${label}] split=${splitInto} clone=${useClone} -> GOT=${JSON.stringify(text)} JSON=${ok ? 'OK' : 'FAIL(' + err + ')'}`);
}

(async () => {
  for (const split of [1, 2, 3]) {
    await run('null', 'null', split, false);
    await run('null', 'null', split, true);
    await run('obj', '{"code":0,"data":[1,2,3]}', split, false);
    await run('obj', '{"code":0,"data":[1,2,3]}', split, true);
  }
})();
