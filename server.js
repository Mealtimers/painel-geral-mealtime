const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

const PORT = process.env.PORT || 3050;
const NOTION_API_KEY = process.env.NOTION_API_KEY || '';
const NOTION_DB_ID = process.env.NOTION_DB_ID || '12bb62ac-a681-4f41-b6e5-87ecaa1151da';

// ── BI Bling config ──
const BI_API_URL = process.env.BI_API_URL || 'https://bi-bling-production.up.railway.app';
const BI_ADMIN_USER = process.env.BI_ADMIN_USER || '';
const BI_ADMIN_PASS = process.env.BI_ADMIN_PASS || '';

// ── Caches (2 min) ──
const CACHE_TTL = 2 * 60 * 1000;
let newsletterCache = { data: null, ts: 0 };
let contasCache = { data: null, ts: 0 };
let pedidosCache = { data: null, ts: 0 };
let biToken = { token: null, expiresAt: 0 };

// ═══════════════════════════════════════
//  NOTION — Newsletter
// ═══════════════════════════════════════

function notionRequest(endpoint, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.notion.com',
      path: endpoint,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${NOTION_API_KEY}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Notion parse error')); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function fetchNewsletter() {
  if (newsletterCache.data && Date.now() - newsletterCache.ts < CACHE_TTL) {
    return newsletterCache.data;
  }

  const result = await notionRequest(`/v1/databases/${NOTION_DB_ID}/query`, {
    sorts: [{ property: 'Data', direction: 'descending' }],
    page_size: 1,
  });

  if (!result.results || result.results.length === 0) return null;

  const page = result.results[0];
  const props = page.properties;

  const getText = (p) => {
    if (!p) return '';
    if (p.type === 'title') return (p.title || []).map(t => t.plain_text).join('');
    if (p.type === 'rich_text') return (p.rich_text || []).map(t => t.plain_text).join('');
    return '';
  };

  const getDate = (p) => {
    if (!p || p.type !== 'date' || !p.date) return null;
    return p.date.start;
  };

  const getTopics = (p) => {
    if (!p || p.type !== 'multi_select') return [];
    return (p.multi_select || []).map(t => t.name);
  };

  const data = {
    edicao: getText(props['Edição']),
    data: getDate(props['Data']),
    manchete1: getText(props['Manchete 1']),
    manchete2: getText(props['Manchete 2']),
    manchete3: getText(props['Manchete 3']),
    resumo1: getText(props['Resumo 1']),
    resumo2: getText(props['Resumo 2']),
    resumo3: getText(props['Resumo 3']),
    topicos: getTopics(props['Tópicos']),
    notionUrl: page.url || '',
  };

  newsletterCache = { data, ts: Date.now() };
  return data;
}

// ═══════════════════════════════════════
//  BI BLING — Auth + Proxy
// ═══════════════════════════════════════

function biRequest(method, urlPath) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(BI_API_URL);
    const opts = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: urlPath,
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (biToken.token) {
      opts.headers['Authorization'] = `Bearer ${biToken.token}`;
    }
    const transport = parsed.protocol === 'https:' ? https : http;
    const req = transport.request(opts, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, data: body }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function biPost(urlPath, payload) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(BI_API_URL);
    const body = JSON.stringify(payload);
    const opts = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: urlPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const transport = parsed.protocol === 'https:' ? https : http;
    const req = transport.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function ensureBiToken() {
  if (biToken.token && Date.now() < biToken.expiresAt - 60000) {
    return biToken.token;
  }
  if (!BI_ADMIN_USER || !BI_ADMIN_PASS) {
    throw new Error('BI credentials not configured');
  }
  const res = await biPost('/api/auth/login', {
    usuario: BI_ADMIN_USER,
    senha: BI_ADMIN_PASS,
  });
  if (res.status !== 200 || !res.data.token) {
    throw new Error('BI login failed: ' + JSON.stringify(res.data));
  }
  biToken = {
    token: res.data.token,
    expiresAt: Date.now() + (res.data.expiresIn || 3600) * 1000,
  };
  return biToken.token;
}

// Contas a pagar do dia — resumo por conta
async function fetchContasResumo() {
  if (contasCache.data && Date.now() - contasCache.ts < CACHE_TTL) {
    return contasCache.data;
  }

  await ensureBiToken();
  const today = new Date().toISOString().slice(0, 10);
  const res = await biRequest('GET',
    `/api/bi/contas-pagar?dateFrom=${today}&dateTo=${today}&dateField=vencimento`
  );

  if (res.status !== 200 || !res.data.ok) {
    throw new Error('BI contas-pagar error');
  }

  const porConta = {};
  let total = 0;
  for (const row of (res.data.rows || [])) {
    if (row.situacao === 'PAGO') continue;
    const nome = row.accountName || 'Sem conta';
    if (!porConta[nome]) porConta[nome] = 0;
    porConta[nome]++;
    total++;
  }

  const data = { total, porConta, data: today };
  contasCache = { data, ts: Date.now() };
  return data;
}

// Pedidos do dia — resumo
async function fetchPedidosResumo() {
  if (pedidosCache.data && Date.now() - pedidosCache.ts < CACHE_TTL) {
    return pedidosCache.data;
  }

  await ensureBiToken();
  const today = new Date().toISOString().slice(0, 10);
  const res = await biRequest('GET',
    `/api/bi/sales/analytics?dateFrom=${today}&dateTo=${today}`
  );

  if (res.status !== 200) {
    throw new Error('BI sales error');
  }

  const summary = res.data.summary || {};
  const data = {
    total: summary.ordersCount || 0,
    valor: summary.ordersValue || 0,
    data: today,
  };
  pedidosCache = { data, ts: Date.now() };
  return data;
}

// ═══════════════════════════════════════
//  HTTP SERVER
// ═══════════════════════════════════════

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

const PUBLIC = path.join(__dirname, 'public');

function jsonRes(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];

  // Health check
  if (url === '/health') {
    return jsonRes(res, 200, { status: 'ok', uptime: process.uptime() });
  }

  // Newsletter API
  if (url === '/api/newsletter') {
    if (!NOTION_API_KEY) {
      return jsonRes(res, 503, { error: 'NOTION_API_KEY não configurada' });
    }
    fetchNewsletter()
      .then((data) => {
        if (!data) return jsonRes(res, 404, { error: 'Nenhuma edição encontrada' });
        jsonRes(res, 200, data);
      })
      .catch((err) => {
        console.error('[Newsletter] Erro:', err.message);
        jsonRes(res, 500, { error: 'Erro ao buscar newsletter' });
      });
    return;
  }

  // Contas a pagar resumo
  if (url === '/api/contas-resumo') {
    if (!BI_ADMIN_USER) {
      return jsonRes(res, 503, { error: 'BI credentials não configuradas' });
    }
    fetchContasResumo()
      .then((data) => jsonRes(res, 200, data))
      .catch((err) => {
        console.error('[Contas] Erro:', err.message);
        jsonRes(res, 500, { error: 'Erro ao buscar contas a pagar' });
      });
    return;
  }

  // Pedidos do dia resumo
  if (url === '/api/pedidos-resumo') {
    if (!BI_ADMIN_USER) {
      return jsonRes(res, 503, { error: 'BI credentials não configuradas' });
    }
    fetchPedidosResumo()
      .then((data) => jsonRes(res, 200, data))
      .catch((err) => {
        console.error('[Pedidos] Erro:', err.message);
        jsonRes(res, 500, { error: 'Erro ao buscar pedidos' });
      });
    return;
  }

  // Serve static files
  let filePath = url === '/' ? '/index.html' : url;
  filePath = path.join(PUBLIC, filePath);

  // Prevent directory traversal
  if (!filePath.startsWith(PUBLIC)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      fs.readFile(path.join(PUBLIC, 'index.html'), (err2, fallback) => {
        if (err2) {
          res.writeHead(404);
          return res.end('Not found');
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(fallback);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`[Painel Geral] Rodando na porta ${PORT}`);
});
