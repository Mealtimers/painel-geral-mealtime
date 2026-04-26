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

// ── Email config ──
const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT = Number(process.env.SMTP_PORT) || 587;
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const RECOVER_EMAIL = process.env.RECOVER_EMAIL || 'comercial@mealtime.com.br';

// ── BI Bling config ──
const BI_API_URL = process.env.BI_API_URL || 'https://bi-bling-production.up.railway.app';
const BI_ADMIN_USER = process.env.BI_ADMIN_USER || '';
const BI_ADMIN_PASS = process.env.BI_ADMIN_PASS || '';

// ── Data dir ──
const DATA_DIR = process.env.DATA_DIR || './data';

// ═══════════════════════════════════════
//  USERS STORE (JSON persistence)
// ═══════════════════════════════════════

const USERS_FILE = path.join(DATA_DIR, 'users.json');

function hashPassword(pass) {
  return crypto.createHash('sha256').update(pass + JWT_SECRET).digest('hex');
}

function loadUsers() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('[Users] Erro ao ler:', e.message);
  }
  return null;
}

function saveUsers(users) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
  } catch (e) {
    console.error('[Users] Erro ao salvar:', e.message);
  }
}

function getUsers() {
  let users = loadUsers();
  if (!users) {
    // Inicializar com admin padrão
    users = [{
      id: crypto.randomUUID(),
      usuario: ADMIN_USER,
      senha: hashPassword(ADMIN_PASS),
      nome: 'Administrador',
      email: RECOVER_EMAIL,
      telefone: '',
      cargo: 'Administrador',
      perfil: 'admin',
      ativo: true,
      criadoEm: new Date().toISOString(),
    }];
    saveUsers(users);
  }
  return users;
}

function findUser(usuario) {
  return getUsers().find(u => u.usuario === usuario && u.ativo);
}

function findUserById(id) {
  return getUsers().find(u => u.id === id);
}

function findUserByEmail(email) {
  return getUsers().find(u => u.email && u.email.toLowerCase() === email.toLowerCase() && u.ativo);
}

function updateUser(id, updates) {
  const users = getUsers();
  const idx = users.findIndex(u => u.id === id);
  if (idx === -1) return null;
  Object.assign(users[idx], updates, { atualizadoEm: new Date().toISOString() });
  saveUsers(users);
  return users[idx];
}

function addUser(data) {
  const users = getUsers();
  if (users.find(u => u.usuario === data.usuario)) return null;
  const user = {
    id: crypto.randomUUID(),
    usuario: data.usuario,
    senha: hashPassword(data.senha),
    nome: data.nome || '',
    email: data.email || '',
    telefone: data.telefone || '',
    cargo: data.cargo || '',
    perfil: data.perfil || 'usuario',
    ativo: true,
    criadoEm: new Date().toISOString(),
  };
  users.push(user);
  saveUsers(users);
  return user;
}

function deleteUser(id) {
  const users = getUsers();
  const idx = users.findIndex(u => u.id === id);
  if (idx === -1) return false;
  users[idx].ativo = false;
  users[idx].atualizadoEm = new Date().toISOString();
  saveUsers(users);
  return true;
}

function sanitizeUser(u) {
  return { id: u.id, usuario: u.usuario, nome: u.nome, email: u.email, telefone: u.telefone, cargo: u.cargo, perfil: u.perfil, ativo: u.ativo, criadoEm: u.criadoEm };
}

// ═══════════════════════════════════════
//  AUTH — JWT + Recovery
// ═══════════════════════════════════════

function generateToken(user) {
  return jwt.sign({ id: user.id, user: user.usuario, perfil: user.perfil, iat: Math.floor(Date.now() / 1000) }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

function verifyToken(token) {
  try { return jwt.verify(token, JWT_SECRET); }
  catch { return null; }
}

function extractToken(req) {
  const auth = req.headers['authorization'];
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7);
  const cookies = req.headers['cookie'] || '';
  const match = cookies.match(/painel_token=([^;]+)/);
  return match ? match[1] : null;
}

function isAuthenticated(req) {
  const token = extractToken(req);
  if (!token) return false;
  return verifyToken(token) !== null;
}

function getAuthUser(req) {
  const token = extractToken(req);
  if (!token) return null;
  const decoded = verifyToken(token);
  if (!decoded) return null;
  return findUserById(decoded.id);
}

// Reset tokens (in memory, 15 min)
const resetTokens = new Map();

async function sendRecoveryEmail(email, resetCode) {
  if (!SMTP_USER || !SMTP_PASS) {
    console.error('[Auth] SMTP não configurado');
    return false;
  }
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST, port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  await transporter.sendMail({
    from: `"Meal Time Painel" <${SMTP_USER}>`,
    to: email,
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
        <p style="color:#888;font-size:12px;text-align:center;">Expira em <strong style="color:#f0f0f0;">15 minutos</strong>.</p>
        <p style="color:#555;font-size:11px;text-align:center;margin-top:20px;">Se você não solicitou, ignore este email.</p>
      </div>`,
  });
  return true;
}

// ═══════════════════════════════════════
//  NOTION — Newsletter
// ═══════════════════════════════════════

const CACHE_TTL = 2 * 60 * 1000;
let newsletterCache = { data: null, ts: 0 };
let contasCache = { data: null, ts: 0 };
let pedidosCache = { data: null, ts: 0 };
let biToken = { token: null, expiresAt: 0 };

function notionRequest(endpoint, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.notion.com', path: endpoint, method: 'POST',
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
        catch { reject(new Error('Notion parse error')); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function fetchNewsletter() {
  if (newsletterCache.data && Date.now() - newsletterCache.ts < CACHE_TTL) return newsletterCache.data;
  const result = await notionRequest(`/v1/databases/${NOTION_DB_ID}/query`, {
    sorts: [{ property: 'Data', direction: 'descending' }], page_size: 1,
  });
  if (!result.results || !result.results.length) return null;
  const page = result.results[0];
  const props = page.properties;
  const getText = (p) => {
    if (!p) return '';
    if (p.type === 'title') return (p.title || []).map(t => t.plain_text).join('');
    if (p.type === 'rich_text') return (p.rich_text || []).map(t => t.plain_text).join('');
    return '';
  };
  const getDate = (p) => (!p || p.type !== 'date' || !p.date) ? null : p.date.start;
  const getTopics = (p) => (!p || p.type !== 'multi_select') ? [] : (p.multi_select || []).map(t => t.name);
  const data = {
    edicao: getText(props['Edição']), data: getDate(props['Data']),
    manchete1: getText(props['Manchete 1']), manchete2: getText(props['Manchete 2']),
    manchete3: getText(props['Manchete 3']), resumo1: getText(props['Resumo 1']),
    resumo2: getText(props['Resumo 2']), resumo3: getText(props['Resumo 3']),
    topicos: getTopics(props['Tópicos']), notionUrl: page.url || '',
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
      path: urlPath, method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (biToken.token) opts.headers['Authorization'] = `Bearer ${biToken.token}`;
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
      path: urlPath, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
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
  if (biToken.token && Date.now() < biToken.expiresAt - 60000) return biToken.token;
  if (!BI_ADMIN_USER || !BI_ADMIN_PASS) throw new Error('BI credentials not configured');
  const res = await biPost('/api/auth/login', { usuario: BI_ADMIN_USER, senha: BI_ADMIN_PASS });
  if (res.status !== 200 || !res.data.token) throw new Error('BI login failed');
  biToken = { token: res.data.token, expiresAt: Date.now() + (res.data.expiresIn || 3600) * 1000 };
  return biToken.token;
}

function todayBRT() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' })).toISOString().slice(0, 10);
}

async function fetchContasResumo() {
  if (contasCache.data && Date.now() - contasCache.ts < CACHE_TTL) return contasCache.data;
  await ensureBiToken();
  const today = todayBRT();
  const res = await biRequest('GET', `/api/bi/contas-pagar?dateFrom=${today}&dateTo=${today}&dateField=vencimento`);
  if (res.status !== 200 || !res.data.ok) throw new Error('BI contas-pagar error');
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
  if (pedidosCache.data && Date.now() - pedidosCache.ts < CACHE_TTL) return pedidosCache.data;
  await ensureBiToken();
  const today = todayBRT();
  const res = await biRequest('GET', `/api/bi/sales/analytics?dateFrom=${today}&dateTo=${today}`);
  if (res.status !== 200) throw new Error('BI sales error');
  const summary = res.data.summary || {};
  const data = { total: summary.ordersCount || 0, valor: summary.ordersValue || 0, data: today };
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
      try { resolve(JSON.parse(body)); } catch { resolve({}); }
    });
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

const PUBLIC = path.join(__dirname, 'public');

function jsonRes(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(obj));
}

function requireAuth(req, res) {
  const user = getAuthUser(req);
  if (!user) { jsonRes(res, 401, { error: 'Token inválido ou ausente' }); return null; }
  return user;
}

function requireAdmin(req, res) {
  const user = requireAuth(req, res);
  if (!user) return null;
  if (user.perfil !== 'admin') { jsonRes(res, 403, { error: 'Acesso restrito a administradores' }); return null; }
  return user;
}

// ═══════════════════════════════════════
//  HTTP SERVER
// ═══════════════════════════════════════

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    return res.end();
  }

  // ── Public routes ──

  if (url === '/health') return jsonRes(res, 200, { status: 'ok', uptime: process.uptime() });

  if (url === '/login') {
    fs.readFile(path.join(PUBLIC, 'login.html'), (err, data) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  // ── Auth API (public) ──

  if (url === '/api/auth/login' && req.method === 'POST') {
    const body = await readBody(req);
    const { usuario, senha } = body;
    if (!usuario || !senha) return jsonRes(res, 400, { error: 'Usuário e senha obrigatórios' });

    const user = findUser(usuario);
    if (user && user.senha === hashPassword(senha)) {
      console.log(`[Auth] Login OK: ${usuario}`);
      const token = generateToken(user);
      return jsonRes(res, 200, { ok: true, token, user: sanitizeUser(user) });
    }
    console.log(`[Auth] Login falhou: ${usuario}`);
    return jsonRes(res, 401, { ok: false, error: 'Usuário ou senha incorretos' });
  }

  if (url === '/api/auth/verify') {
    const user = getAuthUser(req);
    return jsonRes(res, 200, { authenticated: !!user, user: user ? sanitizeUser(user) : null });
  }

  if (url === '/api/auth/recover' && req.method === 'POST') {
    const body = await readBody(req);
    const { email } = body;
    if (email) {
      const user = findUserByEmail(email);
      if (user) {
        const code = crypto.randomInt(100000, 999999).toString();
        resetTokens.set(code, { userId: user.id, expiresAt: Date.now() + 15 * 60 * 1000 });
        for (const [k, v] of resetTokens) { if (Date.now() > v.expiresAt) resetTokens.delete(k); }
        try {
          await sendRecoveryEmail(email, code);
          console.log(`[Auth] Código enviado para ${email}`);
        } catch (err) { console.error('[Auth] Erro email:', err.message); }
      }
    }
    return jsonRes(res, 200, { ok: true, message: 'Se o email estiver cadastrado, você receberá um código.' });
  }

  if (url === '/api/auth/reset' && req.method === 'POST') {
    const body = await readBody(req);
    const { code, novaSenha } = body;
    if (!code || !novaSenha) return jsonRes(res, 400, { error: 'Código e nova senha obrigatórios' });
    const entry = resetTokens.get(code);
    if (!entry || Date.now() > entry.expiresAt) return jsonRes(res, 400, { error: 'Código inválido ou expirado' });

    const user = findUserById(entry.userId);
    if (!user) return jsonRes(res, 400, { error: 'Usuário não encontrado' });

    updateUser(user.id, { senha: hashPassword(novaSenha) });
    resetTokens.delete(code);
    console.log(`[Auth] Senha resetada: ${user.usuario}`);
    const token = generateToken(user);
    return jsonRes(res, 200, { ok: true, token, user: sanitizeUser(user) });
  }

  // ── Protected: index.html ──

  if (url === '/' || url === '/index.html') {
    if (!isAuthenticated(req)) { res.writeHead(302, { 'Location': '/login' }); return res.end(); }
    fs.readFile(path.join(PUBLIC, 'index.html'), (err, data) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  // ── Protected API ──

  if (url.startsWith('/api/')) {
    // Skip public auth endpoints
    if (['/api/auth/login','/api/auth/verify','/api/auth/recover','/api/auth/reset'].includes(url)) return;

    // ── User profile ──

    if (url === '/api/auth/me' && req.method === 'GET') {
      const user = requireAuth(req, res); if (!user) return;
      return jsonRes(res, 200, { ok: true, user: sanitizeUser(user) });
    }

    if (url === '/api/auth/me' && req.method === 'PUT') {
      const user = requireAuth(req, res); if (!user) return;
      const body = await readBody(req);
      const allowed = {};
      if (body.nome !== undefined) allowed.nome = body.nome;
      if (body.email !== undefined) allowed.email = body.email;
      if (body.telefone !== undefined) allowed.telefone = body.telefone;
      if (body.cargo !== undefined) allowed.cargo = body.cargo;
      const updated = updateUser(user.id, allowed);
      return jsonRes(res, 200, { ok: true, user: sanitizeUser(updated) });
    }

    if (url === '/api/auth/change-password' && req.method === 'POST') {
      const user = requireAuth(req, res); if (!user) return;
      const body = await readBody(req);
      const { senhaAtual, novaSenha } = body;
      if (!senhaAtual || !novaSenha) return jsonRes(res, 400, { error: 'Senha atual e nova senha obrigatórias' });
      if (user.senha !== hashPassword(senhaAtual)) return jsonRes(res, 400, { error: 'Senha atual incorreta' });
      if (novaSenha.length < 4) return jsonRes(res, 400, { error: 'A nova senha deve ter pelo menos 4 caracteres' });
      updateUser(user.id, { senha: hashPassword(novaSenha) });
      console.log(`[Auth] Senha alterada: ${user.usuario}`);
      return jsonRes(res, 200, { ok: true, message: 'Senha alterada com sucesso' });
    }

    // ── Users CRUD (admin only) ──

    if (url === '/api/users' && req.method === 'GET') {
      const admin = requireAdmin(req, res); if (!admin) return;
      const users = getUsers().filter(u => u.ativo).map(sanitizeUser);
      return jsonRes(res, 200, { ok: true, users });
    }

    if (url === '/api/users' && req.method === 'POST') {
      const admin = requireAdmin(req, res); if (!admin) return;
      const body = await readBody(req);
      if (!body.usuario || !body.senha) return jsonRes(res, 400, { error: 'Usuário e senha obrigatórios' });
      if (body.senha.length < 4) return jsonRes(res, 400, { error: 'A senha deve ter pelo menos 4 caracteres' });
      const user = addUser(body);
      if (!user) return jsonRes(res, 409, { error: 'Usuário já existe' });
      console.log(`[Users] Criado: ${body.usuario} por ${admin.usuario}`);
      return jsonRes(res, 201, { ok: true, user: sanitizeUser(user) });
    }

    // /api/users/:id
    const userMatch = url.match(/^\/api\/users\/([a-f0-9-]+)$/);
    if (userMatch) {
      const targetId = userMatch[1];

      if (req.method === 'PUT') {
        const admin = requireAdmin(req, res); if (!admin) return;
        const body = await readBody(req);
        const allowed = {};
        if (body.nome !== undefined) allowed.nome = body.nome;
        if (body.email !== undefined) allowed.email = body.email;
        if (body.telefone !== undefined) allowed.telefone = body.telefone;
        if (body.cargo !== undefined) allowed.cargo = body.cargo;
        if (body.perfil !== undefined) allowed.perfil = body.perfil;
        if (body.senha) allowed.senha = hashPassword(body.senha);
        const updated = updateUser(targetId, allowed);
        if (!updated) return jsonRes(res, 404, { error: 'Usuário não encontrado' });
        console.log(`[Users] Atualizado: ${updated.usuario} por ${admin.usuario}`);
        return jsonRes(res, 200, { ok: true, user: sanitizeUser(updated) });
      }

      if (req.method === 'DELETE') {
        const admin = requireAdmin(req, res); if (!admin) return;
        if (targetId === admin.id) return jsonRes(res, 400, { error: 'Não é possível excluir a si mesmo' });
        const ok = deleteUser(targetId);
        if (!ok) return jsonRes(res, 404, { error: 'Usuário não encontrado' });
        console.log(`[Users] Desativado: ${targetId} por ${admin.usuario}`);
        return jsonRes(res, 200, { ok: true });
      }
    }

    // ── Dashboard data ──

    if (url === '/api/newsletter') {
      const user = requireAuth(req, res); if (!user) return;
      if (!NOTION_API_KEY) return jsonRes(res, 503, { error: 'NOTION_API_KEY não configurada' });
      try {
        const data = await fetchNewsletter();
        if (!data) return jsonRes(res, 404, { error: 'Nenhuma edição' });
        return jsonRes(res, 200, data);
      } catch (err) { console.error('[Newsletter]', err.message); return jsonRes(res, 500, { error: 'Erro newsletter' }); }
    }

    if (url === '/api/contas-resumo') {
      const user = requireAuth(req, res); if (!user) return;
      if (!BI_ADMIN_USER) return jsonRes(res, 503, { error: 'BI não configurado' });
      try { return jsonRes(res, 200, await fetchContasResumo()); }
      catch (err) { console.error('[Contas]', err.message); return jsonRes(res, 500, { error: 'Erro contas' }); }
    }

    if (url === '/api/pedidos-resumo') {
      const user = requireAuth(req, res); if (!user) return;
      if (!BI_ADMIN_USER) return jsonRes(res, 503, { error: 'BI não configurado' });
      try { return jsonRes(res, 200, await fetchPedidosResumo()); }
      catch (err) { console.error('[Pedidos]', err.message); return jsonRes(res, 500, { error: 'Erro pedidos' }); }
    }

    return jsonRes(res, 404, { error: 'Endpoint não encontrado' });
  }

  // ── Static files ──
  let filePath = path.join(PUBLIC, url);
  if (!filePath.startsWith(PUBLIC)) { res.writeHead(403); return res.end('Forbidden'); }
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME[ext] || 'application/octet-stream';
  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (!isAuthenticated(req)) { res.writeHead(302, { 'Location': '/login' }); return res.end(); }
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
  console.log(`[Painel Geral] Porta ${PORT}`);
  console.log(`[Painel Geral] Login: /login`);
  // Garantir que admin existe
  getUsers();
});
