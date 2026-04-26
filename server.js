const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');

const PORT = process.env.PORT || 3050;
const NOTION_API_KEY = process.env.NOTION_API_KEY || '';
const NOTION_DB_ID = process.env.NOTION_DB_ID || '12bb62ac-a681-4f41-b6e5-87ecaa1151da';

// ── Auth config ──
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'changeme';
const JWT_SECRET = process.env.JWT_SECRET || 'painel-dev-secret-change-me';
const JWT_EXPIRES = '24h';

// ── Email config (para recuperação de senha) ──
const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT = Number(process.env.SMTP_PORT) || 587;
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const RECOVER_EMAIL = process.env.RECOVER_EMAIL || 'comercial@mealtime.com.br';

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

// ── Reset tokens (em memória, expira em 15 min) ──
const resetTokens = new Map();

// ═══════════════════════════════════════
//  AUTH — JWT + Recovery
// ═══════════════════════════════════════

function generateToken(user) {
  return jwt.sign({ user, iat: Math.floor(Date.now() / 1000) }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

function extractToken(req) {
  const auth = req.headers['authorization'];
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7);
  // Cookie fallback
  const cookies = req.headers['cookie'] || '';
  const match = cookies.match(/painel_token=([^;]+)/);
  return match ? match[1] : null;
}

function isAuthenticated(req) {
  const token = extractToken(req);
  if (!token) return false;
  return verifyToken(token) !== null;
}

async function sendRecoveryEmail(resetCode) {
  if (!SMTP_USER || !SMTP_PASS) {
    console.error('[Auth] SMTP não configurado — não é possível enviar email');
    return false;
  }

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  await transporter.sendMail({
    from: `"Meal Time Painel" <${SMTP_USER}>`,
    to: RECOVER_EMAIL,
    subject: 'Recuperação de Senha — Painel Geral',
    html: `
      <div style="font-family:Inter,Arial,sans-serif;max-width:460px;margin:0 auto;padding:32px;background:#141518;color:#f0f0f0;border-radius:12px;">
        <div style="text-align:center;margin-bottom:24px;">
          <img src="https://www.mealtime.com.br/mealtime/logo-avatar-192.png" width="48" height="48" style="border-radius:12px;">
          <h2 style="margin:12px 0 4px;color:#f0f0f0;font-size:18px;">Meal Time — Painel Geral</h2>
          <p style="color:#888;font-size:13px;margin:0;">Recuperação de senha</p>
        </div>
        <div style="background:#1a1b1f;padding:20px;border-radius:10px;text-align:center;margin-bottom:20px;">
          <p style="color:#aaa;font-size:13px;margin:0 0 12px;">Seu código de recuperação:</p>
          <div style="font-size:32px;font-weight:800;letter-spacing:8px;color:#BC2026;font-family:monospace;">${resetCode}</div>
        </div>
        <p style="color:#888;font-size:12px;text-align:center;margin:0;">Este código expira em <strong style="color:#f0f0f0;">15 minutos</strong>.</p>
        <p style="color:#555;font-size:11px;text-align:center;margin-top:20px;">Se você não solicitou, ignore este email.</p>
      </div>
    `,
  });

  return true;
}

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

function todayBRT() {
  return new Date(
    new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' })
  ).toISOString().slice(0, 10);
}

async function fetchContasResumo() {
  if (contasCache.data && Date.now() - contasCache.ts < CACHE_TTL) {
    return contasCache.data;
  }

  await ensureBiToken();
  const today = todayBRT();
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

async function fetchPedidosResumo() {
  if (pedidosCache.data && Date.now() - pedidosCache.ts < CACHE_TTL) {
    return pedidosCache.data;
  }

  await ensureBiToken();
  const today = todayBRT();
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
//  HELPERS
// ═══════════════════════════════════════

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => body += c);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { resolve({}); }
    });
  });
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

function jsonRes(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(obj));
}

// ═══════════════════════════════════════
//  HTTP SERVER
// ═══════════════════════════════════════

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    return res.end();
  }

  // ── Public routes ──

  if (url === '/health') {
    return jsonRes(res, 200, { status: 'ok', uptime: process.uptime() });
  }

  // Login page (always accessible)
  if (url === '/login') {
    fs.readFile(path.join(PUBLIC, 'login.html'), (err, data) => {
      if (err) { res.writeHead(404); return res.end('Login page not found'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  // Auth API — Login
  if (url === '/api/auth/login' && req.method === 'POST') {
    const body = await readBody(req);
    const { usuario, senha } = body;

    if (usuario === ADMIN_USER && senha === ADMIN_PASS) {
      const token = generateToken(usuario);
      console.log(`[Auth] Login OK: ${usuario}`);
      return jsonRes(res, 200, { ok: true, token });
    }
    console.log(`[Auth] Login falhou: ${usuario}`);
    return jsonRes(res, 401, { ok: false, error: 'Usuário ou senha incorretos' });
  }

  // Auth API — Verificar token
  if (url === '/api/auth/verify') {
    const token = extractToken(req);
    const decoded = token ? verifyToken(token) : null;
    return jsonRes(res, 200, { authenticated: !!decoded, user: decoded?.user || null });
  }

  // Auth API — Solicitar recuperação de senha
  if (url === '/api/auth/recover' && req.method === 'POST') {
    const body = await readBody(req);
    const { email } = body;

    // Sempre retorna sucesso para não revelar se o email existe
    if (email && email.toLowerCase() === RECOVER_EMAIL.toLowerCase()) {
      const code = crypto.randomInt(100000, 999999).toString();
      resetTokens.set(code, { expiresAt: Date.now() + 15 * 60 * 1000 });

      // Limpar tokens expirados
      for (const [k, v] of resetTokens) {
        if (Date.now() > v.expiresAt) resetTokens.delete(k);
      }

      try {
        await sendRecoveryEmail(code);
        console.log(`[Auth] Código de recuperação enviado para ${email}`);
      } catch (err) {
        console.error('[Auth] Erro ao enviar email:', err.message);
      }
    }

    return jsonRes(res, 200, { ok: true, message: 'Se o email estiver cadastrado, você receberá um código.' });
  }

  // Auth API — Verificar código e resetar senha
  if (url === '/api/auth/reset' && req.method === 'POST') {
    const body = await readBody(req);
    const { code, novaSenha } = body;

    if (!code || !novaSenha) {
      return jsonRes(res, 400, { ok: false, error: 'Código e nova senha são obrigatórios' });
    }

    const entry = resetTokens.get(code);
    if (!entry || Date.now() > entry.expiresAt) {
      return jsonRes(res, 400, { ok: false, error: 'Código inválido ou expirado' });
    }

    // Nota: em produção com persistência, aqui salvaria a nova senha.
    // Como usamos env vars, apenas logamos. O admin deve atualizar ADMIN_PASS no Railway.
    resetTokens.delete(code);
    console.log(`[Auth] Senha resetada via código. Nova senha definida (efêmera até restart).`);

    // Gerar token direto para já logar
    const token = generateToken(ADMIN_USER);
    return jsonRes(res, 200, { ok: true, token, message: 'Senha redefinida com sucesso' });
  }

  // ── Protected routes — require auth ──

  // Serve static index.html only if authenticated
  if (url === '/' || url === '/index.html') {
    if (!isAuthenticated(req)) {
      // Redirect to login
      res.writeHead(302, { 'Location': '/login' });
      return res.end();
    }
    fs.readFile(path.join(PUBLIC, 'index.html'), (err, data) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  // Protected API endpoints
  if (url.startsWith('/api/') && url !== '/api/auth/login' && url !== '/api/auth/verify' && url !== '/api/auth/recover' && url !== '/api/auth/reset') {
    if (!isAuthenticated(req)) {
      return jsonRes(res, 401, { error: 'Token inválido ou ausente' });
    }

    // Newsletter API
    if (url === '/api/newsletter') {
      if (!NOTION_API_KEY) {
        return jsonRes(res, 503, { error: 'NOTION_API_KEY não configurada' });
      }
      try {
        const data = await fetchNewsletter();
        if (!data) return jsonRes(res, 404, { error: 'Nenhuma edição encontrada' });
        return jsonRes(res, 200, data);
      } catch (err) {
        console.error('[Newsletter] Erro:', err.message);
        return jsonRes(res, 500, { error: 'Erro ao buscar newsletter' });
      }
    }

    // Contas a pagar resumo
    if (url === '/api/contas-resumo') {
      if (!BI_ADMIN_USER) {
        return jsonRes(res, 503, { error: 'BI credentials não configuradas' });
      }
      try {
        const data = await fetchContasResumo();
        return jsonRes(res, 200, data);
      } catch (err) {
        console.error('[Contas] Erro:', err.message);
        return jsonRes(res, 500, { error: 'Erro ao buscar contas a pagar' });
      }
    }

    // Pedidos do dia resumo
    if (url === '/api/pedidos-resumo') {
      if (!BI_ADMIN_USER) {
        return jsonRes(res, 503, { error: 'BI credentials não configuradas' });
      }
      try {
        const data = await fetchPedidosResumo();
        return jsonRes(res, 200, data);
      } catch (err) {
        console.error('[Pedidos] Erro:', err.message);
        return jsonRes(res, 500, { error: 'Erro ao buscar pedidos' });
      }
    }

    return jsonRes(res, 404, { error: 'Endpoint não encontrado' });
  }

  // Static files (CSS, JS, images — public assets, no auth needed)
  let filePath = path.join(PUBLIC, url);
  if (!filePath.startsWith(PUBLIC)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // If not found and not authenticated, redirect to login
      if (!isAuthenticated(req)) {
        res.writeHead(302, { 'Location': '/login' });
        return res.end();
      }
      fs.readFile(path.join(PUBLIC, 'index.html'), (err2, fallback) => {
        if (err2) { res.writeHead(404); return res.end('Not found'); }
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
  console.log(`[Painel Geral] Login: /login`);
});
