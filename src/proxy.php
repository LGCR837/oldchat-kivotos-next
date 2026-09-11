<?php
/**
 * OldChat For Kivotos Next —— 网页版 HTTP/HTTPS 反向代理
 *
 * 部署：与 index.html 同级（例如 /ockn/proxy.php），前端同源调用即可绕过 CORS。
 *
 * 设计约束：
 *  1. 只中转 http / https，**不做 WebSocket（ws/wss）中转** —— 长连接由浏览器直连后端。
 *  2. 原样转发：方法、请求头、请求体、查询串、响应状态码与响应头全部保持原样，
 *     唯一改写的是 Host（改为目标站的 Host）。
 *  3. 目标站白名单：不是开放代理，只允许后端与媒体域名。
 *
 * 用法：proxy.php?u=<目标绝对 URL>
 *      例：proxy.php?u=http%3A%2F%2Foc.mcl0.dpdns.org%2Fv1%2Fme
 *   健康检查：proxy.php?_ping=1
 *
 * 环境要求：PHP >= 5.4，需要 curl 扩展。
 */

// ===== 配置 =====

/** 允许代理的目标站（host 需与 URL 中的 host 完全一致，含端口则一并匹配） */
$ALLOWED_HOSTS = array(
    'oc.mcl0.dpdns.org',
    '60.205.94.101:8080',
    '60.205.94.101',
    'files.mcl0.dpdns.org',
    'ocf.oss-cn-shanghai.aliyuncs.com',
);

$CONNECT_TIMEOUT = 10;   // 连接超时（秒）
$TOTAL_TIMEOUT   = 120;  // 总超时（秒，媒体/上传可能较慢）
$MAX_REDIRECTS   = 5;    // 最大重定向次数

// 逐跳首部（HTTP/1.1 13.5.1）：不能原样转发
$HOP_BY_HOP = array(
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailer', 'transfer-encoding', 'upgrade',
);

// ===== 工具 =====

function deny($status, $msg) {
    if (!headers_sent()) {
        header('Content-Type: application/json; charset=utf-8', true, $status);
    }
    echo json_encode(array('error' => $msg));
    exit;
}

function header_name_lc($line) {
    $p = strpos($line, ':');
    if ($p === false) return strtolower(trim($line));
    return strtolower(trim(substr($line, 0, $p)));
}

function is_allowed_host($host, $allowed) {
    $host = strtolower($host);
    foreach ($allowed as $h) {
        if ($host === strtolower($h)) return true;
    }
    return false;
}

// 关闭可能干扰“原样转发”的输出压缩；ob 循环加护栏，避免某些主机上无法弹出缓冲层导致死循环
@ini_set('zlib.output_compression', '0');
@ini_set('output_buffering', '0');
if (function_exists('apache_setenv')) { @apache_setenv('no-gzip', '1'); }
$obGuard = 0;
while (ob_get_level() > 0 && $obGuard++ < 16) {
    if (!@ob_end_clean()) break;
}

// ===== 健康检查 =====
if (isset($_GET['_ping'])) {
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(array(
        'ok' => true,
        'proxy' => 'ockn-http-proxy',
        'curl' => function_exists('curl_init'),
        'allowedHosts' => $ALLOWED_HOSTS,
        'php' => PHP_VERSION,
    ));
    exit;
}

// ===== 取目标 URL =====
if (!isset($_GET['u']) || !is_string($_GET['u']) || $_GET['u'] === '') {
    deny(400, 'missing target: use ?u=<absolute url>');
}
$target = $_GET['u'];

$parts = parse_url($target);
if ($parts === false || empty($parts['scheme']) || empty($parts['host'])) {
    deny(400, 'invalid target url');
}
$scheme = strtolower($parts['scheme']);

// 明确拒绝 WebSocket：本代理只中转普通 HTTP
if ($scheme === 'ws' || $scheme === 'wss') {
    deny(400, 'websocket is not proxied: connect ws/wss directly from the browser');
}
if ($scheme !== 'http' && $scheme !== 'https') {
    deny(400, 'unsupported scheme: ' . $scheme);
}

$host = $parts['host'];
if (isset($parts['port'])) $host .= ':' . $parts['port'];
if (!is_allowed_host($host, $ALLOWED_HOSTS)) {
    deny(403, 'host not allowed: ' . $host);
}

// ===== 组装请求头（原样转发，仅剔除 Host 与逐跳首部）=====
$method = isset($_SERVER['REQUEST_METHOD']) ? $_SERVER['REQUEST_METHOD'] : 'GET';

$reqHeaders = array();
$hasAcceptEncoding = false;
if (function_exists('getallheaders')) {
    foreach (getallheaders() as $k => $v) {
        $lk = strtolower($k);
        if ($lk === 'host') continue;                 // Host 由 curl 按目标站改写
        if ($lk === 'accept-encoding') { $hasAcceptEncoding = true; continue; }
        if (in_array($lk, $HOP_BY_HOP, true)) continue;
        if ($lk === 'content-length') continue;       // 由 curl 依实际 body 计算
        $reqHeaders[] = $k . ': ' . $v;
    }
}
if (!$hasAcceptEncoding) {
    // 未带也可显式声明身份编码，避免上游返回 gzip 后需要二次解码
    $reqHeaders[] = 'Accept-Encoding: identity';
}

// 目标 URL：保留路径与查询串
$finalUrl = $target;

// ===== 读取原始请求体 =====
$body = null;
if ($method !== 'GET' && $method !== 'HEAD') {
    $body = file_get_contents('php://input');
    if ($body === false) $body = null;
}

// ===== 发起请求 =====
if (!function_exists('curl_init')) {
    deny(500, 'curl extension is required');
}

$ch = curl_init($finalUrl);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, false);   // 走 WRITEFUNCTION 流式输出
curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, $CONNECT_TIMEOUT);
curl_setopt($ch, CURLOPT_TIMEOUT, $TOTAL_TIMEOUT);
curl_setopt($ch, CURLOPT_FOLLOWLOCATION, true);
curl_setopt($ch, CURLOPT_MAXREDIRS, $MAX_REDIRECTS);
curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, true);
curl_setopt($ch, CURLOPT_SSL_VERIFYHOST, 2);
curl_setopt($ch, CURLOPT_HTTPHEADER, $reqHeaders);
curl_setopt($ch, CURLOPT_CUSTOMREQUEST, $method);
curl_setopt($ch, CURLOPT_HEADER, false);           // 头部交给 HEADERFUNCTION

if ($method !== 'GET' && $method !== 'HEAD' && $body !== null && $body !== '') {
    curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
} elseif ($method === 'PUT' || $method === 'PATCH' || $method === 'DELETE') {
    curl_setopt($ch, CURLOPT_POSTFIELDS, '');
}

// 响应头：先到，直接下发（此时尚未输出 body，header() 仍有效）
$statusSet = false;
curl_setopt($ch, CURLOPT_HEADERFUNCTION, function ($curl, $headerLine) use (&$statusSet, $HOP_BY_HOP) {
    $len = strlen($headerLine);
    $line = trim($headerLine);
    if ($line === '') return $len;

    // 跟随重定向时每个跃点都会来一次状态行；只要还没输出 body，就以最新跃点为准
    if (preg_match('#^HTTP/\S+\s+(\d{3})#i', $line, $m)) {
        if (!headers_sent()) {
            http_response_code((int)$m[1]);
            $statusSet = true;
        }
        return $len;
    }

    $lk = header_name_lc($line);
    if (in_array($lk, $HOP_BY_HOP, true)) return $len;
    if ($lk === 'content-encoding') return $len;      // 已强制身份编码
    if ($lk === 'transfer-encoding') return $len;

    if (strpos($line, ':') !== false && !headers_sent()) {
        header($line, true);
    }
    return $len;
});

// 响应体：边收边发，避免大文件占用内存
curl_setopt($ch, CURLOPT_WRITEFUNCTION, function ($curl, $data) {
    echo $data;
    if (ob_get_level() > 0) { @ob_flush(); }
    @flush();
    return strlen($data);
});

$ok = curl_exec($ch);
$errNo = curl_errno($ch);
$errMsg = curl_error($ch);
curl_close($ch);

if ($ok === false) {
    // 头部可能已发出，无法再改状态码，只能追加错误说明
    if (!headers_sent()) {
        header('Content-Type: application/json; charset=utf-8', true, 502);
    }
    echo json_encode(array(
        'error' => 'upstream request failed',
        'curl_errno' => $errNo,
        'curl_error' => $errMsg,
    ));
}
exit;
