// admin.js

// server.js
const http = require('http');
const fs = require('fs').promises;
const path = require('path');
const { URL } = require('url');

const SERVICES_DIR = 'services';
const CONFIG_FILE = 'config.json';
const STATIC_ROOT = path.resolve(__dirname);

const routes = [];
function on(method, pattern, handler) {
  const names = [];
  const regex = new RegExp('^' + pattern.replace(/:([^/]+)/g, (_, n) => {
    names.push(n);
    return '([^/]+)';
  }) + '$');
  routes.push({ method, regex, names, handler });
}

function jsonResponse(res, status, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        const parsed = JSON.parse(body);
        resolve(parsed);
      } catch (e) {
        reject(new Error('Invalid JSON'));
      }
    });
  });
}

async function serveFile(res, filePath, contentType) {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(STATIC_ROOT + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('Forbidden');
  }
  try {
    const content = await fs.readFile(resolved);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}

on('GET', '/', async (req, res) => {
  await serveFile(res, path.join(__dirname, 'admin.html'), 'text/html');
});

on('GET', '/api/services', async (req, res) => {
  try {
    const files = await fs.readdir(SERVICES_DIR);
    const out = [];
    for (const f of files) {
      if (f.endsWith('.json')) {
        const text = await fs.readFile(path.join(SERVICES_DIR, f), 'utf8');
        const cfg = JSON.parse(text);
        out.push({ name: path.basename(f, '.json'), config: cfg });
      }
    }
    jsonResponse(res, 200, out);
  } catch {
    jsonResponse(res, 500, { error: 'Could not list services' });
  }
});

on('POST', '/api/services', async (req, res) => {
  let body;
  try {
    body = await parseBody(req);
  } catch {
    return jsonResponse(res, 400, { error: 'Invalid JSON' });
  }
  const { name, config } = body;
  if (!name || typeof config !== 'object') {
    return jsonResponse(res, 400, { error: 'Missing name or invalid config' });
  }
  const file = path.join(SERVICES_DIR, name + '.json');
  try {
    await fs.access(file);
    return jsonResponse(res, 400, { error: 'Already exists' });
  } catch {}
  await fs.writeFile(file, JSON.stringify(config, null, 2));
  jsonResponse(res, 201, { name, config });
});

on('GET', '/api/services/:name', async (req, res, p) => {
  const file = path.join(SERVICES_DIR, p.name + '.json');
  try {
    const text = await fs.readFile(file, 'utf8');
    const cfg = JSON.parse(text);
    jsonResponse(res, 200, { name: p.name, config: cfg });
  } catch {
    jsonResponse(res, 404, { error: 'Not found or invalid JSON' });
  }
});

on('PUT', '/api/services/:name', async (req, res, p) => {
  const file = path.join(SERVICES_DIR, p.name + '.json');
  try {
    await fs.access(file);
  } catch {
    return jsonResponse(res, 404, { error: 'Not found' });
  }
  let cfg;
  try {
    cfg = await parseBody(req);
  } catch {
    return jsonResponse(res, 400, { error: 'Invalid JSON' });
  }
  await fs.writeFile(file, JSON.stringify(cfg, null, 2));
  jsonResponse(res, 200, { name: p.name, config: cfg });
});

on('DELETE', '/api/services/:name', async (req, res, p) => {
  const file = path.join(SERVICES_DIR, p.name + '.json');
  try {
    await fs.unlink(file);
    res.writeHead(204);
    res.end();
  } catch {
    jsonResponse(res, 404, { error: 'Not found' });
  }
});

on('GET', '/api/config', async (req, res) => {
  try {
    const text = await fs.readFile(CONFIG_FILE, 'utf8');
    const cfg = JSON.parse(text);
    jsonResponse(res, 200, cfg);
  } catch {
    jsonResponse(res, 500, { error: 'Could not read or invalid JSON' });
  }
});

on('PUT', '/api/config', async (req, res) => {
  let cfg;
  try {
    cfg = await parseBody(req);
  } catch {
    return jsonResponse(res, 400, { error: 'Invalid JSON' });
  }
  try {
    await fs.writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2));
    jsonResponse(res, 200, cfg);
  } catch {
    jsonResponse(res, 500, { error: 'Could not write config' });
  }
});

// whitelist endpoints
on('GET', '/api/whitelist', async (req, res) => {
  try {
    const cfgText = await fs.readFile(CONFIG_FILE, 'utf8');
    const cfg = JSON.parse(cfgText);
    if (!cfg.whitelist) throw new Error('No whitelist path configured');
    const content = await fs.readFile(cfg.whitelist, 'utf8');
    jsonResponse(res, 200, { path: cfg.whitelist, content });
  } catch (e) {
    jsonResponse(res, 500, { error: e.message });
  }
});

on('PUT', '/api/whitelist', async (req, res) => {
  let body;
  try {
    body = await parseBody(req);
  } catch {
    return jsonResponse(res, 400, { error: 'Invalid JSON' });
  }
  try {
    const cfgText = await fs.readFile(CONFIG_FILE, 'utf8');
    const cfg = JSON.parse(cfgText);
    if (!cfg.whitelist) throw new Error('No whitelist path configured');
    await fs.writeFile(cfg.whitelist, body.content, 'utf8');
    jsonResponse(res, 200, { path: cfg.whitelist, content: body.content });
  } catch (e) {
    jsonResponse(res, 500, { error: e.message });
  }
});

// blacklist endpoints
on('GET', '/api/blacklist', async (req, res) => {
  try {
    const cfgText = await fs.readFile(CONFIG_FILE, 'utf8');
    const cfg = JSON.parse(cfgText);
    if (!cfg.blacklist) throw new Error('No blacklist path configured');
    const content = await fs.readFile(cfg.blacklist, 'utf8');
    jsonResponse(res, 200, { path: cfg.blacklist, content });
  } catch (e) {
    jsonResponse(res, 500, { error: e.message });
  }
});

on('PUT', '/api/blacklist', async (req, res) => {
  let body;
  try {
    body = await parseBody(req);
  } catch {
    return jsonResponse(res, 400, { error: 'Invalid JSON' });
  }
  try {
    const cfgText = await fs.readFile(CONFIG_FILE, 'utf8');
    const cfg = JSON.parse(cfgText);
    if (!cfg.blacklist) throw new Error('No blacklist path configured');
    await fs.writeFile(cfg.blacklist, body.content, 'utf8');
    jsonResponse(res, 200, { path: cfg.blacklist, content: body.content });
  } catch (e) {
    jsonResponse(res, 500, { error: e.message });
  }
});

async function init() {
  await fs.mkdir(SERVICES_DIR, { recursive: true });
  try { await fs.access(CONFIG_FILE); }
  catch { await fs.writeFile(CONFIG_FILE, JSON.stringify({}, null, 2)); }
}

async function startServer(port = 3001) {
  await init();
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, `http://${req.headers.host}`);
    (async () => {
      for (const r of routes) {
        if (req.method === r.method) {
          const m = u.pathname.match(r.regex);
          if (m) {
            const params = {};
            r.names.forEach((n, i) => params[n] = m[i + 1]);
            await r.handler(req, res, params);
            return;
          }
        }
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    })();
  });
  return new Promise(resolve => server.listen(port, () => resolve(server)));
}

module.exports = { startServer };
