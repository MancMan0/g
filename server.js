const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = process.env.PORT || 8080;
const ROOT_DIR = path.resolve(__dirname, 'M3U PLAYER HTML');
const UPSTREAM_USER = 'eeff932ab93c';
const UPSTREAM_PASS = 'a8737a2d4a';
const UPSTREAM_HOST = 'tvips.site';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.ts': 'video/mp2t',
  '.m3u8': 'application/vnd.apple.mpegurl'
};

function serveStatic(req, res, pathname) {
  let safePath = pathname === '/' ? '/index.html' : pathname;
  let fullPath = path.join(ROOT_DIR, safePath);

  if (!fullPath.startsWith(ROOT_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  fs.stat(fullPath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }

    const ext = path.extname(fullPath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*'
    });
    fs.createReadStream(fullPath).pipe(res);
  });
}

function proxyStream(targetUrl, clientReq, clientRes, redirectCount = 0) {
  if (redirectCount > 5) {
    clientRes.writeHead(502, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
    clientRes.end('Too many redirects');
    return;
  }

  const parsed = url.parse(targetUrl);
  const client = parsed.protocol === 'https:' ? https : http;

  const reqHeaders = {
    'User-Agent': 'RainDotTV-Secure-Player/2.0',
    'Accept': '*/*',
    'Connection': 'keep-alive',
    'Host': parsed.host
  };
  if (clientReq.headers.range) {
    reqHeaders['Range'] = clientReq.headers.range;
  }

  const upstreamReq = client.request(targetUrl, {
    method: 'GET',
    headers: reqHeaders
  }, (upstreamRes) => {
    if (upstreamRes.statusCode >= 300 && upstreamRes.statusCode < 400 && upstreamRes.headers.location) {
      let nextUrl = upstreamRes.headers.location;
      if (!nextUrl.startsWith('http')) {
        nextUrl = url.resolve(targetUrl, nextUrl);
      }
      upstreamRes.resume();
      proxyStream(nextUrl, clientReq, clientRes, redirectCount + 1);
      return;
    }

    const resHeaders = {
      'Content-Type': upstreamRes.headers['content-type'] || 'video/mp2t',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Private-Network': 'true',
      'Cache-Control': 'no-cache, no-store, must-revalidate'
    };

    if (upstreamRes.headers['content-length']) {
      resHeaders['Content-Length'] = upstreamRes.headers['content-length'];
    }
    if (upstreamRes.headers['accept-ranges']) {
      resHeaders['Accept-Ranges'] = upstreamRes.headers['accept-ranges'];
    }

    clientRes.writeHead(upstreamRes.statusCode, resHeaders);
    upstreamRes.pipe(clientRes);

    clientRes.on('close', () => {
      upstreamReq.destroy();
    });
  });

  upstreamReq.on('error', (e) => {
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, {
        'Content-Type': 'text/plain',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Private-Network': 'true'
      });
      clientRes.end('Stream Gateway Error: ' + e.message);
    }
  });

  upstreamReq.end();
}

let activeTunnelUrl = null;

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Private-Network': 'true'
    });
    res.end();
    return;
  }

  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  if (pathname === '/health' || pathname === '/status') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Private-Network': 'true'
    });
    res.end(JSON.stringify({
      status: 'ok',
      relay: 'active',
      tunnel: activeTunnelUrl,
      timestamp: Date.now()
    }));
    return;
  }

  if (pathname.startsWith('/live/')) {
    const filename = pathname.replace('/live/', '').replace('prem_', '');
    const channelId = filename.replace(/\.(ts|m3u8)$/, '');
    const upstreamUrl = 'http://' + UPSTREAM_HOST + '/live/' + UPSTREAM_USER + '/' + UPSTREAM_PASS + '/' + channelId + '.ts';
    proxyStream(upstreamUrl, req, res);
    return;
  }

  serveStatic(req, res, pathname);
});

function startCloudflaredTunnel() {
  const binaryPath = path.join(__dirname, 'cloudflared.exe');
  if (!fs.existsSync(binaryPath)) {
    console.log('[Tunnel] cloudflared.exe not found in directory. Running in local relay mode.');
    return;
  }

  console.log('[Tunnel] Launching Cloudflare HTTPS Tunnel for deployed website streaming...');
  const tunnel = spawn(binaryPath, ['tunnel', '--url', `http://127.0.0.1:${PORT}`]);

  tunnel.stderr.on('data', (data) => {
    const text = data.toString();
    const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
    if (match && match[0] !== activeTunnelUrl) {
      activeTunnelUrl = match[0];
      console.log('\n================================================================');
      console.log(' 🔥 CLOUDFLARE HTTPS TUNNEL ONLINE & CONNECTED!');
      console.log(' Live HTTPS Relay URL:', activeTunnelUrl);
      console.log(' Live TV will stream over HTTPS on the deployed website!');
      console.log('================================================================\n');

      // Update tunnel_config.js in M3U PLAYER HTML
      const configPath = path.join(ROOT_DIR, 'tunnel_config.js');
      const content = `window.RAINDOT_TUNNEL_URL = ${JSON.stringify(activeTunnelUrl)};\n`;
      try {
        fs.writeFileSync(configPath, content, 'utf8');
      } catch (e) {
        console.warn('[Tunnel] Could not write tunnel_config.js:', e.message);
      }
    }
  });

  tunnel.on('error', (err) => {
    console.warn('[Tunnel] Cloudflared error:', err.message);
  });

  process.on('exit', () => {
    try { tunnel.kill(); } catch (e) {}
  });
}

server.listen(PORT, () => {
  console.log('RainDotTV Web Player running at http://localhost:' + PORT + '/index.html');
  startCloudflaredTunnel();
});
