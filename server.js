const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

const PORT = process.env.PORT || 3050;
const NOTION_API_KEY = process.env.NOTION_API_KEY || '';
const NOTION_DB_ID = process.env.NOTION_DB_ID || '12bb62ac-a681-4f41-b6e5-87ecaa1151da';

// ── Cache da newsletter (2 min) ──
let newsletterCache = { data: null, ts: 0 };
const CACHE_TTL = 2 * 60 * 1000;

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

const server = http.createServer((req, res) => {
  // Health check
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
  }

  // Newsletter API
  if (req.url === '/api/newsletter') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (!NOTION_API_KEY) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'NOTION_API_KEY não configurada' }));
    }
    fetchNewsletter()
      .then((data) => {
        if (!data) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Nenhuma edição encontrada' }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      })
      .catch((err) => {
        console.error('[Newsletter] Erro:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Erro ao buscar newsletter' }));
      });
    return;
  }

  // Serve static files
  let filePath = req.url === '/' ? '/index.html' : req.url;
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
      // Fallback to index.html for SPA-like behavior
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
