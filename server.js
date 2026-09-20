const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const supabase = require('./lib/supabaseClient');

const PORT = process.env.PORT || 3050;

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

// ── WhatsApp (Evolution API) — para envio de código 2FA por WPP ──
const EVOLUTION_API_URL = (process.env.EVOLUTION_API_URL || '').replace(/\/$/, '');
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || '';
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE || '';

// ── Brevo (HTTP) — Railway bloqueia SMTP; e-mail sai por HTTPS (api.brevo.com).
// resolveBrevoKey tolera nome de variável com espaço acidental (" BREVO_API_KEY").
function resolveBrevoKey() {
  if (process.env.BREVO_API_KEY && process.env.BREVO_API_KEY.trim()) return process.env.BREVO_API_KEY.trim();
  for (const k in process.env) { if (k.trim() === 'BREVO_API_KEY' && process.env[k] && process.env[k].trim()) return process.env[k].trim(); }
  return '';
}
const BREVO_API_KEY = resolveBrevoKey();
const BREVO_SENDER_EMAIL = process.env.BREVO_SENDER_EMAIL || 'comercial@mealtime.com.br';
const BREVO_SENDER_NAME = process.env.BREVO_SENDER_NAME || 'Meal Time';
async function sendViaBrevo(to, subject, html) {
  try {
    const resp = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json', 'accept': 'application/json' },
      body: JSON.stringify({ sender: { email: BREVO_SENDER_EMAIL, name: BREVO_SENDER_NAME }, to: [{ email: to }], subject, htmlContent: html }),
    });
    if (resp.ok) return true;
    console.error('[mail] Brevo falhou:', resp.status, (await resp.text().catch(() => '')).slice(0, 200));
    return false;
  } catch (e) { console.error('[mail] Brevo erro:', e.message); return false; }
}
const RECOVER_EMAIL = process.env.RECOVER_EMAIL || 'comercial@mealtime.com.br';

// ── BI Bling config ──
const BI_API_URL = process.env.BI_API_URL || 'https://bi-bling-production.up.railway.app';
const BI_ADMIN_USER = process.env.BI_ADMIN_USER || '';
const BI_ADMIN_PASS = process.env.BI_ADMIN_PASS || '';

// ── Estoque Fabrica config (integração cross-app) ──
const ESTOQUE_FABRICA_URL = process.env.ESTOQUE_FABRICA_URL || 'https://estoque.mealtime.com.br';
const ESTOQUE_FABRICA_API_KEY = process.env.ESTOQUE_FABRICA_API_KEY || '';

// ── Data dir ──
const DATA_DIR = process.env.DATA_DIR || './data';

// ═══════════════════════════════════════
//  USERS STORE (JSON persistence)
// ═══════════════════════════════════════

const USERS_FILE = path.join(DATA_DIR, 'users.json');

function hashPassword(pass) {
  return crypto.createHash('sha256').update(pass + JWT_SECRET).digest('hex');
}

// ─── Persistência de Users ───
// Fonte da verdade: Supabase core.users (sobrevive a deploys/restart sem volume).
// Cache em memória + arquivo local como fallback rápido (boot sync).
//
// Fluxo:
//   1. Boot sync: lê file pra encher cache (rápido, sem await).
//   2. Boot async (fire-and-forget): puxa do Supabase e SOBRESCREVE cache.
//   3. saveUsers: atualiza cache + grava file + UPSERT Supabase (await).
//
// Isso resolve o problema de Railway sem volume montado em /data —
// o file desaparece a cada deploy mas o Supabase persiste.

let _usersCache = null;

// ─── Mappers DB ↔ in-memory ───
// In-memory shape (legado): { id, usuario, senha, nome, email, telefone, cargo, perfil, ativo, criadoEm, atualizadoEm }
// Supabase core.users:      { id (uuid), usuario, password_hash, nome, email, telefone, cargo, perfil, ativo, criado_em, atualizado_em }

function mapUserToDb(u) {
  return {
    id: u.id, // UUID gerado pelo painel — mantém compat com sessions JWT
    usuario: u.usuario,
    password_hash: u.senha || null,
    nome: u.nome || null,
    email: u.email || null,
    telefone: u.telefone || null,
    cargo: u.cargo || null,
    perfil: u.perfil || 'usuario',
    ativo: u.ativo !== false,
    criado_em: u.criadoEm || new Date().toISOString(),
    atualizado_em: u.atualizadoEm || new Date().toISOString(),
  };
}

function mapUserFromDb(r) {
  return {
    id: r.id,
    usuario: r.usuario,
    senha: r.password_hash || '',
    nome: r.nome || '',
    email: r.email || '',
    telefone: r.telefone || '',
    cargo: r.cargo || '',
    perfil: r.perfil || 'usuario',
    ativo: r.ativo !== false,
    criadoEm: r.criado_em || null,
    atualizadoEm: r.atualizado_em || null,
  };
}

function loadUsersFromFile() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('[Users] Erro ao ler file:', e.message);
  }
  return null;
}

function saveUsersToFile(users) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
  } catch (e) {
    console.error('[Users] Erro ao gravar file:', e.message);
  }
}

async function loadUsersFromSupabase() {
  if (!supabase.isConfigured()) return null;
  try {
    const rows = await supabase.select('core.users', 'select=*&order=criado_em.asc');
    if (Array.isArray(rows)) return rows.map(mapUserFromDb);
  } catch (e) {
    console.error('[Users] Falha ler Supabase:', e.message);
  }
  return null;
}

async function saveUsersToSupabase(users) {
  if (!supabase.isConfigured()) return false;
  try {
    await supabase.upsert('core.users', users.map(mapUserToDb), 'id');
    return true;
  } catch (e) {
    console.error('[Users] Falha gravar Supabase:', e.message);
    return false;
  }
}

function ensureAdmin(users) {
  const admin = users.find(u => u.usuario === ADMIN_USER && u.perfil === 'admin');
  if (admin) return users;
  users.push({
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
  });
  console.log('[Users] Admin padrão criado/recriado.');
  return users;
}

// Boot sync: enche cache do file (ou cria admin default).
function loadUsers() {
  const file = loadUsersFromFile();
  if (file && Array.isArray(file)) {
    _usersCache = ensureAdmin(file);
  } else {
    _usersCache = ensureAdmin([]);
    saveUsersToFile(_usersCache);
  }
  return _usersCache;
}

// Boot async (fire-and-forget): puxa do Supabase e SOBRESCREVE cache se houver.
// Se Supabase está vazio, faz seed inicial com o cache atual.
async function syncUsersFromSupabase() {
  if (!supabase.isConfigured()) {
    console.log('[Users] Supabase não configurado — usando apenas file local.');
    return;
  }
  const remote = await loadUsersFromSupabase();
  if (Array.isArray(remote) && remote.length > 0) {
    _usersCache = ensureAdmin(remote);
    saveUsersToFile(_usersCache); // mantém file como fallback consistente
    console.log(`[Users] Carregado ${remote.length} user(s) do Supabase.`);
  } else {
    // Supabase vazio — sobe o cache atual (file ou admin default).
    if (_usersCache && _usersCache.length > 0) {
      const ok = await saveUsersToSupabase(_usersCache);
      if (ok) console.log(`[Users] Seed inicial Supabase com ${_usersCache.length} user(s).`);
    }
  }
}

function saveUsers(users) {
  _usersCache = users;
  saveUsersToFile(users);
  // Fire-and-forget Supabase upsert (await falharia se rede lenta — não bloqueia UX)
  saveUsersToSupabase(users).catch((e) => console.error('[Users] sync Supabase falhou:', e.message));
}

function getUsers() {
  if (!_usersCache) loadUsers();
  return _usersCache;
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
  // Inclui aliases `role` e `usuario` além de `perfil`/`user` para compatibilidade
  // com apps-filho que checam `role` (ex.: BI) — corrige SSO 403 "exclusiva de admin".
  return jwt.sign({ id: user.id, user: user.usuario, usuario: user.usuario, perfil: user.perfil, role: user.perfil, iat: Math.floor(Date.now() / 1000) }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
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

/* ═══════════════════ 2FA por email + dispositivo confiável (30d) ═══════════════════ */
const TWOFA_ENABLED = process.env.TWOFA_ENABLED !== 'false'; // ligado por padrão
const twofaPending = new Map(); // pendingToken -> { userId, codeHash, expiresAt, attempts }
const TWOFA_TTL_MS = 10 * 60 * 1000;
const TD_MAX_AGE_SEC = 30 * 24 * 3600; // dispositivo confiável: 30 dias

function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }

function maskEmailPB(email) {
  const [u, d] = String(email || '').split('@');
  if (!d) return '***';
  return (u.length <= 3 ? u[0] : u.slice(0, 3)) + '***@' + d;
}

function normalizePhoneBR(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return '';
  // Sem DDI: assume Brasil (+55). Com 10-11 dígitos → 55DDXXXXXXXX(X).
  if (digits.length >= 12) return digits; // já tem DDI
  if (digits.length === 10 || digits.length === 11) return '55' + digits;
  return digits;
}
function maskPhonePB(phone) {
  const p = String(phone || '').replace(/\D/g, '');
  if (p.length < 4) return '***';
  return '(' + p.slice(0, -6).slice(-2) + ') ****-' + p.slice(-4);
}
function hasWhatsappConfigured() { return !!(EVOLUTION_API_URL && EVOLUTION_API_KEY && EVOLUTION_INSTANCE); }
function userHasWhatsapp(user) { return !!(user && user.telefone && normalizePhoneBR(user.telefone).length >= 12); }
function canSendWhatsapp2fa(user) { return hasWhatsappConfigured() && userHasWhatsapp(user); }

// Cookie de dispositivo confiável = JWT curto {uid, td} válido 30 dias
function isTrustedDevice(req, userId) {
  const m = (req.headers['cookie'] || '').match(/painel_td=([^;]+)/);
  if (!m) return false;
  try { const d = jwt.verify(m[1], JWT_SECRET); return d && d.td === true && d.uid === userId; }
  catch { return false; }
}
function trustedDeviceCookie(userId) {
  const token = jwt.sign({ uid: userId, td: true }, JWT_SECRET, { expiresIn: '30d' });
  const parts = [`painel_td=${token}`, 'HttpOnly', 'SameSite=Lax', 'Path=/', `Max-Age=${TD_MAX_AGE_SEC}`];
  if ((process.env.APP_BASE_URL || '').startsWith('https://')) parts.push('Secure');
  return parts.join('; ');
}

async function send2faWhatsapp(phoneRaw, code) {
  if (!hasWhatsappConfigured()) throw new Error('Whatsapp gateway não configurado');
  const number = normalizePhoneBR(phoneRaw);
  if (number.length < 12) throw new Error('Telefone inválido');
  const text = `*Meal Time — Painel Geral*\n\nSeu código de acesso: *${code}*\n\nExpira em 10 minutos. Se não foi você, avise o administrador.`;
  const url = `${EVOLUTION_API_URL}/message/sendText/${encodeURIComponent(EVOLUTION_INSTANCE)}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': EVOLUTION_API_KEY },
    body: JSON.stringify({ number, text }),
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Evolution ${resp.status}: ${body.slice(0, 200)}`);
  }
  return true;
}

async function send2faEmail(email, code) {
  const subject = 'Código de acesso — Painel Geral';
  const html = `
      <div style="font-family:Inter,Arial,sans-serif;max-width:460px;margin:0 auto;padding:32px;background:#141518;color:#f0f0f0;border-radius:12px;">
        <div style="text-align:center;margin-bottom:24px;">
          <img src="https://www.mealtime.com.br/mealtime/logo-avatar-192.png" width="48" height="48" style="border-radius:12px;">
          <h2 style="margin:12px 0 4px;color:#f0f0f0;font-size:18px;">Meal Time — Painel Geral</h2>
          <p style="color:#888;font-size:13px;margin:0;">Verificação em duas etapas</p>
        </div>
        <div style="background:#1a1b1f;padding:20px;border-radius:10px;text-align:center;margin-bottom:20px;">
          <p style="color:#aaa;font-size:13px;margin:0 0 12px;">Seu código de acesso:</p>
          <div style="font-size:32px;font-weight:800;letter-spacing:8px;color:#BC2026;font-family:monospace;">${code}</div>
        </div>
        <p style="color:#888;font-size:12px;text-align:center;">Expira em <strong style="color:#f0f0f0;">10 minutos</strong>.</p>
        <p style="color:#555;font-size:11px;text-align:center;margin-top:20px;">Se não foi você tentando entrar, troque sua senha imediatamente.</p>
      </div>`;
  if (BREVO_API_KEY) { const ok = await sendViaBrevo(email, subject, html); if (ok) return true; }
  if (SMTP_USER && SMTP_PASS) {
    try {
      const t = nodemailer.createTransport({ host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_PORT === 465, auth: { user: SMTP_USER, pass: SMTP_PASS }, connectionTimeout: 8000, greetingTimeout: 8000, socketTimeout: 8000 });
      await t.sendMail({ from: `"Meal Time Painel" <${SMTP_USER}>`, to: email, subject, html }); return true;
    } catch (e) { console.error('[2fa] SMTP erro:', e.message); }
  }
  return false;
}

async function sendRecoveryEmail(email, resetCode) {
  const subject = 'Recuperação de Senha — Painel Geral';
  const html = `
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
      </div>`;
  // 1) Brevo (HTTP) — fura o bloqueio SMTP do Railway.
  if (BREVO_API_KEY) { const ok = await sendViaBrevo(email, subject, html); if (ok) return true; }
  // 2) Fallback SMTP (timeout curto p/ não pendurar caso a porta esteja bloqueada).
  if (!SMTP_USER || !SMTP_PASS) { console.error('[Auth] sem provedor de e-mail (BREVO/SMTP)'); return false; }
  try {
    const transporter = nodemailer.createTransport({
      host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_PORT === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
      connectionTimeout: 8000, greetingTimeout: 8000, socketTimeout: 8000,
    });
    await transporter.sendMail({ from: `"Meal Time Painel" <${SMTP_USER}>`, to: email, subject, html });
    return true;
  } catch (e) { console.error('[mail] SMTP erro:', e.message); return false; }
}

// ═══════════════════════════════════════
//  CACHES + BI CLIENT
// ═══════════════════════════════════════

const CACHE_TTL = 2 * 60 * 1000;
let contasCache = { data: null, ts: 0 };
let pedidosCache = { data: null, ts: 0 };
let overviewCache = { data: null, ts: 0 };
let biToken = { token: null, expiresAt: 0 };

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
  const valoresPorConta = {};
  let total = 0;
  let valorTotal = 0;
  for (const row of (res.data.rows || [])) {
    if (row.situacao === 'PAGO') continue;
    const nome = row.accountName || 'Sem conta';
    const valor = Number(row.valor || 0);
    if (!porConta[nome]) porConta[nome] = 0;
    if (!valoresPorConta[nome]) valoresPorConta[nome] = 0;
    porConta[nome]++;
    valoresPorConta[nome] += valor;
    total++;
    valorTotal += valor;
  }
  const data = { total, valorTotal, porConta, valoresPorConta, data: today };
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

// ── Compras Insumos Fabrica: proxy pro Estoque Fabrica ──────────────
let comprasInsumosCache = { data: null, ts: 0 };
const COMPRAS_INSUMOS_TTL = 60_000; // 60s

async function fetchComprasInsumosFabrica({ force = false } = {}) {
  if (!force && comprasInsumosCache.data && (Date.now() - comprasInsumosCache.ts) < COMPRAS_INSUMOS_TTL) {
    return { ...comprasInsumosCache.data, cached: true };
  }
  if (!ESTOQUE_FABRICA_API_KEY) {
    return { ok: false, error: 'ESTOQUE_FABRICA_API_KEY nao configurada no painel-geral.', total: 0, items: [] };
  }
  const url = `${ESTOQUE_FABRICA_URL.replace(/\/$/, '')}/api/integration/insumos-abaixo-minimo`;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'X-Internal-Api-Key': ESTOQUE_FABRICA_API_KEY, Accept: 'application/json' },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      return { ok: false, error: `Estoque Fabrica retornou ${res.status}: ${txt.slice(0, 200)}`, total: 0, items: [] };
    }
    const data = await res.json();
    comprasInsumosCache = { data, ts: Date.now() };
    return { ...data, cached: false };
  } catch (err) {
    return { ok: false, error: `Falha ao conectar no Estoque Fabrica: ${err.message}`, total: 0, items: [] };
  }
}

// Overview unificado (lê dashboard.overview_today no Supabase).
// View materializada — refresh agendado via pg_cron a cada 5min.
async function fetchOverviewUnificado() {
  if (overviewCache.data && Date.now() - overviewCache.ts < CACHE_TTL) return overviewCache.data;
  if (!supabase.isConfigured()) {
    return { ok: false, error: 'Supabase não configurado', configured: false };
  }
  const rows = await supabase.select('dashboard.overview_today', 'select=*&limit=1');
  const row = Array.isArray(rows) && rows.length ? rows[0] : null;
  const data = {
    ok: true,
    configured: true,
    data: row ? row.data_ref : todayBRT(),
    bling: {
      orders: { qtd: row?.bling_orders_qtd || 0, valor: Number(row?.bling_orders_valor || 0) },
      contasPagar: {
        qtd: row?.contas_pagar_qtd || 0,
        valor: Number(row?.contas_pagar_valor || 0),
        porConta: row?.contas_pagar_por_conta || [],
      },
    },
    dieta: {
      pendentes: row?.dieta_pendentes_qtd || 0,
      hoje: row?.dieta_hoje_qtd || 0,
    },
    fabrica: {
      movimentacoesHoje: row?.fabrica_mov_qtd || 0,
      estoqueCritico: row?.estoque_critico_qtd || 0,
    },
    refreshedAt: row?.refreshed_at || null,
  };
  overviewCache = { data, ts: Date.now() };
  return data;
}

// ═══════════════════════════════════════
//  DASHBOARD AGREGADO — 1 request, tudo em paralelo, cache 60s
// ═══════════════════════════════════════
let dashCache = { data: null, ts: 0 };
const DASH_TTL = 60 * 1000;

function addDaysISO(iso, n) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const settled = (p) => (p && p.status === 'fulfilled') ? p.value : null;

function appsToPing() {
  return [
    { id: 'bi',          nome: 'BI',            url: `${BI_API_URL.replace(/\/$/, '')}/api/health` },
    { id: 'fabrica',     nome: 'Fábrica',       url: `${ESTOQUE_FABRICA_URL.replace(/\/$/, '')}/api/integration/status`, key: true },
    { id: 'dietas',      nome: 'Pedidos',       url: 'https://dietas.mealtime.com.br/' },
    { id: 'crm',         nome: 'CRM',           url: 'https://crm.mealtime.com.br/' },
    { id: 'ads',         nome: 'Meta Ads',      url: 'https://ads.mealtime.com.br/' },
    { id: 'mkt',         nome: 'Marketing',     url: 'https://marketing.mealtime.com.br/' },
    { id: 'mealcontrol', nome: 'Ficha Técnica', url: 'https://mealcontrol.mealtime.com.br/' },
  ];
}

async function pingApp(app) {
  const t0 = Date.now();
  try {
    const headers = app.key && ESTOQUE_FABRICA_API_KEY ? { 'X-Internal-Api-Key': ESTOQUE_FABRICA_API_KEY } : {};
    const r = await fetch(app.url, { method: 'GET', headers, redirect: 'manual', signal: AbortSignal.timeout(6000) });
    // 2xx/3xx/4xx = processo vivo (login redireciona, 401/404 ainda é servidor de pé). 5xx = problema.
    return { id: app.id, nome: app.nome, ok: r.status < 500, ms: Date.now() - t0, status: r.status };
  } catch (e) {
    return { id: app.id, nome: app.nome, ok: false, ms: Date.now() - t0, error: e.name === 'TimeoutError' ? 'timeout' : e.message };
  }
}
async function pingApps() { return Promise.all(appsToPing().map(pingApp)); }

async function fetchDashboard(force = false) {
  if (!force && dashCache.data && Date.now() - dashCache.ts < DASH_TTL) return { ...dashCache.data, cached: true };

  const today = todayBRT();
  const from14 = addDaysISO(today, -13);
  const monthStart = today.slice(0, 8) + '01';
  const to7 = addDaysISO(today, 6);

  const biConfigured = !!(BI_ADMIN_USER && BI_ADMIN_PASS);
  let biErr = biConfigured ? null : 'BI não configurado';
  if (biConfigured) { try { await ensureBiToken(); } catch (e) { biErr = e.message; } }
  const bi = (p) => biErr ? Promise.reject(new Error(biErr)) : biRequest('GET', p);

  const [rHoje, rSerie, rMes, rMetas, rAccounts, rContas7, rInsumos, rOverview, rApps] = await Promise.allSettled([
    bi(`/api/bi/sales/analytics?dateFrom=${today}&dateTo=${today}`),
    bi(`/api/bi/sales/analytics?dateFrom=${from14}&dateTo=${today}&groupBy=day`),
    bi(`/api/bi/sales/analytics?dateFrom=${monthStart}&dateTo=${today}`),
    bi('/api/bi/metas/results'),
    bi('/api/bi/accounts'),
    bi(`/api/bi/contas-pagar?dateFrom=${today}&dateTo=${to7}&dateField=vencimento`),
    fetchComprasInsumosFabrica(),
    fetchOverviewUnificado(),
    pingApps(),
  ]);

  // Contas do BI (id → nome)
  const accRaw = settled(rAccounts)?.data;
  const accList = Array.isArray(accRaw) ? accRaw : (accRaw?.accounts || []);
  const accName = {};
  for (const a of accList) if (a && a.id) accName[a.id] = a.name || a.companyName || a.id;

  // Hoje
  const sHoje = settled(rHoje)?.data?.summary || {};
  const hoje = {
    valor: Number(sHoje.ordersValue || 0), pedidos: Number(sHoje.ordersCount || 0),
    ticket: Number(sHoje.averageTicket || 0), itens: Number(sHoje.itemsSold || 0),
  };

  // Série 14 dias (sparkline + ontem + mesmo dia da semana passada)
  const tl = settled(rSerie)?.data?.timeline || [];
  const byDay = {};
  for (const p of tl) byDay[p.label] = { valor: Number(p.revenue || 0), pedidos: Number(p.orders || 0) };
  const serie = [];
  for (let i = 13; i >= 0; i--) { const d = addDaysISO(today, -i); serie.push({ data: d, ...(byDay[d] || { valor: 0, pedidos: 0 }) }); }
  const ontem = byDay[addDaysISO(today, -1)] || { valor: 0, pedidos: 0 };
  const semanaPassada = byDay[addDaysISO(today, -7)] || { valor: 0, pedidos: 0 };
  const pct = (a, b) => b > 0 ? Math.round(((a - b) / b) * 100) : (a > 0 ? 100 : 0);

  // Mês + projeção linear
  const sMes = settled(rMes)?.data?.summary || {};
  const diaDoMes = Number(today.slice(8, 10));
  const diasNoMes = new Date(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0).getDate();
  const mes = {
    valor: Number(sMes.ordersValue || 0), pedidos: Number(sMes.ordersCount || 0), ticket: Number(sMes.averageTicket || 0),
    diaDoMes, diasNoMes,
    projecao: diaDoMes > 0 ? Math.round((Number(sMes.ordersValue || 0) / diaDoMes) * diasNoMes) : 0,
  };

  // Metas do período atual (do BI → Metas)
  const goalsRaw = settled(rMetas)?.data?.goals || [];
  const metas = goalsRaw.filter((g) => !g.isHistoric).map((g) => ({
    id: g.id, nome: g.name || g.label || g.title || 'Meta',
    target: Number(g.target || 0), atual: Number(g.current || 0), percent: Number(g.percent || 0),
    accountId: g.accountId || null, accountIds: Array.isArray(g.accountIds) && g.accountIds.length ? g.accountIds : null,
    type: g.type || 'monthly', atingiu: !!g.atingiu,
  }));
  const mensais = metas.filter((m) => m.type !== 'yearly');
  const metaGeral = mensais.find((m) => m.accountId === 'all' && !m.accountIds)
    || mensais.find((m) => !m.accountId && !m.accountIds)
    || (mensais.length ? mensais.reduce((a, b) => (b.target > a.target ? b : a)) : null);

  // Por loja (hoje, mês, meta)
  const revHoje = sHoje.revenueByAccount || {};
  const cntHoje = sHoje.ordersCountByAccount || {};
  const revMes = sMes.revenueByAccount || {};
  const ids = new Set([...Object.keys(revMes), ...Object.keys(revHoje), ...Object.keys(accName)]);
  const lojas = [...ids].map((id) => {
    const meta = mensais.find((m) => m.accountId === id && !m.accountIds);
    return {
      id, nome: accName[id] || id,
      hoje: Number(revHoje[id] || 0), pedidosHoje: Number(cntHoje[id] || 0), mes: Number(revMes[id] || 0),
      meta: meta ? meta.target : 0, metaPct: meta ? meta.percent : null,
    };
  }).filter((l) => l.mes > 0 || l.hoje > 0 || l.meta > 0).sort((a, b) => b.mes - a.mes);

  // Contas a pagar em aberto: hoje + próximos 7 dias por vencimento
  const rows = settled(rContas7)?.data?.rows || [];
  const porDia = {}; const hojePorConta = {};
  let hojeQtd = 0, hojeVal = 0, semQtd = 0, semVal = 0;
  for (const r of rows) {
    if (r.situacao === 'PAGO') continue;
    const d = String(r.vencimento || '').slice(0, 10); if (!d) continue;
    const v = Number(r.valor || 0);
    if (!porDia[d]) porDia[d] = { data: d, qtd: 0, valor: 0 };
    porDia[d].qtd++; porDia[d].valor += v; semQtd++; semVal += v;
    if (d === today) {
      hojeQtd++; hojeVal += v;
      const n = r.accountName || 'Sem conta';
      if (!hojePorConta[n]) hojePorConta[n] = { qtd: 0, valor: 0 };
      hojePorConta[n].qtd++; hojePorConta[n].valor += v;
    }
  }
  const dias = [];
  for (let i = 0; i < 7; i++) { const d = addDaysISO(today, i); dias.push(porDia[d] || { data: d, qtd: 0, valor: 0 }); }

  const insumos = settled(rInsumos) || { ok: false, total: 0, items: [] };
  const ov = settled(rOverview) || {};
  const apps = settled(rApps) || [];
  const hojeOk = !biErr && settled(rHoje)?.status === 200;

  const data = {
    ok: true, data: today, geradoEm: new Date().toISOString(),
    bi: { ok: hojeOk, erro: biErr || (rHoje.status === 'rejected' ? (rHoje.reason?.message || 'falha') : (hojeOk ? null : `HTTP ${settled(rHoje)?.status}`)) },
    hoje: { ...hoje, vsOntem: pct(hoje.valor, ontem.valor), vsSemana: pct(hoje.valor, semanaPassada.valor), ontem, semanaPassada },
    serie, mes, metaGeral, metas, lojas,
    contas: {
      hoje: { qtd: hojeQtd, valor: Math.round(hojeVal * 100) / 100, porConta: hojePorConta },
      proximos7: { qtd: semQtd, valor: Math.round(semVal * 100) / 100, dias },
    },
    insumos: {
      ok: insumos.ok !== false, total: Number(insumos.total || 0),
      ultimaConferencia: insumos.ultimaConferenciaInsumos || null, erro: insumos.error || null,
    },
    dieta:   { ok: !!ov?.ok, pendentes: Number(ov?.dieta?.pendentes || 0), hoje: Number(ov?.dieta?.hoje || 0) },
    fabrica: { ok: !!ov?.ok, movimentacoesHoje: Number(ov?.fabrica?.movimentacoesHoje || 0), estoqueCritico: Number(ov?.fabrica?.estoqueCritico || 0) },
    apps,
  };
  dashCache = { data, ts: Date.now() };
  return { ...data, cached: false };
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
  // Headers de segurança em toda resposta (mesclados no writeHead pelo Node)
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', "object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'; upgrade-insecure-requests");

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
    const channelRequested = (body.channel === 'whatsapp' || body.channel === 'email') ? body.channel : null;
    if (!usuario || !senha) return jsonRes(res, 400, { error: 'Usuário e senha obrigatórios' });

    const user = findUser(usuario);
    if (!(user && user.senha === hashPassword(senha))) {
      console.log(`[Auth] Login falhou: ${usuario}`);
      return jsonRes(res, 401, { ok: false, error: 'Usuário ou senha incorretos' });
    }

    // 2FA obrigatório em TODO login (sem bypass por dispositivo confiável).
    const code = crypto.randomInt(100000, 1000000).toString();
    const pending = crypto.randomBytes(24).toString('hex');
    for (const [k, v] of twofaPending) { if (Date.now() > v.expiresAt) twofaPending.delete(k); }
    twofaPending.set(pending, { userId: user.id, codeHash: sha256(code), expiresAt: Date.now() + TWOFA_TTL_MS, attempts: 0 });

    const canWpp = canSendWhatsapp2fa(user);
    const canEmail = !!(user.email || RECOVER_EMAIL);
    // Canal padrão: o pedido do usuário (se possível), senão wpp se disponível, senão email.
    let channel = channelRequested;
    if (channel === 'whatsapp' && !canWpp) channel = null;
    if (channel === 'email' && !canEmail) channel = null;
    if (!channel) channel = canWpp ? 'whatsapp' : 'email';

    let dest;
    try {
      if (channel === 'whatsapp') {
        dest = maskPhonePB(user.telefone);
        await send2faWhatsapp(user.telefone, code);
        console.log(`[2fa] wpp enviado para ${dest} (user ${user.usuario})`);
      } else {
        const email = user.email || RECOVER_EMAIL;
        dest = maskEmailPB(email);
        await send2faEmail(email, code);
        console.log(`[2fa] email enviado para ${dest} (user ${user.usuario})`);
      }
    } catch (e) {
      console.error(`[2fa] erro envio ${channel}:`, e.message);
      // Não vaza erro pro usuário — só sinaliza falha genérica.
      return jsonRes(res, 500, { error: `Falha ao enviar código por ${channel === 'whatsapp' ? 'WhatsApp' : 'email'}.` });
    }
    return jsonRes(res, 200, {
      ok: true, twofa: true, pending, channel, dest,
      hasEmail: canEmail, hasWhatsapp: canWpp,
    });
  }

  // Troca de canal (reenvia código pelo canal escolhido usando a MESMA pending session)
  if (url === '/api/auth/2fa-resend' && req.method === 'POST') {
    const body = await readBody(req);
    const { pending, channel } = body;
    const entry = pending ? twofaPending.get(pending) : null;
    if (!entry || Date.now() > entry.expiresAt) return jsonRes(res, 400, { error: 'Sessão expirada. Faça login novamente.' });
    if (channel !== 'email' && channel !== 'whatsapp') return jsonRes(res, 400, { error: 'Canal inválido' });
    const user = findUserById(entry.userId);
    if (!user) return jsonRes(res, 400, { error: 'Usuário não encontrado' });
    // Gera código novo (invalida anterior) e reseta tentativas.
    const code = crypto.randomInt(100000, 1000000).toString();
    entry.codeHash = sha256(code); entry.attempts = 0; entry.expiresAt = Date.now() + TWOFA_TTL_MS;
    let dest;
    try {
      if (channel === 'whatsapp') {
        if (!canSendWhatsapp2fa(user)) return jsonRes(res, 400, { error: 'WhatsApp não disponível para este usuário.' });
        dest = maskPhonePB(user.telefone);
        await send2faWhatsapp(user.telefone, code);
      } else {
        const email = user.email || RECOVER_EMAIL;
        if (!email) return jsonRes(res, 400, { error: 'Email não cadastrado.' });
        dest = maskEmailPB(email);
        await send2faEmail(email, code);
      }
      console.log(`[2fa] reenvio via ${channel} para ${dest} (user ${user.usuario})`);
    } catch (e) {
      console.error(`[2fa] erro reenvio ${channel}:`, e.message);
      return jsonRes(res, 500, { error: `Falha ao enviar código por ${channel === 'whatsapp' ? 'WhatsApp' : 'email'}.` });
    }
    return jsonRes(res, 200, { ok: true, channel, dest });
  }

  if (url === '/api/auth/2fa-verify' && req.method === 'POST') {
    const body = await readBody(req);
    const { pending, code } = body;
    const entry = pending ? twofaPending.get(pending) : null;
    if (!entry || Date.now() > entry.expiresAt) { if (entry) twofaPending.delete(pending); return jsonRes(res, 400, { error: 'Código expirado. Faça login novamente.' }); }
    if (entry.attempts >= 5) { twofaPending.delete(pending); return jsonRes(res, 429, { error: 'Muitas tentativas. Faça login novamente.' }); }
    entry.attempts++;
    if (sha256(String(code || '').trim()) !== entry.codeHash) return jsonRes(res, 401, { error: 'Código incorreto.' });
    const user = findUserById(entry.userId);
    twofaPending.delete(pending);
    if (!user) return jsonRes(res, 400, { error: 'Usuário não encontrado' });
    const token = generateToken(user);
    console.log(`[2fa] verificado — login OK: ${user.usuario}`);
    return jsonRes(res, 200, { ok: true, token, user: sanitizeUser(user) });
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
    if (['/api/auth/login','/api/auth/2fa-verify','/api/auth/2fa-resend','/api/auth/verify','/api/auth/recover','/api/auth/reset'].includes(url)) return;

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

    if (url === '/api/dashboard') {
      const user = requireAuth(req, res); if (!user) return;
      try {
        const force = /(\?|&)fresh=1(&|$)/.test(req.url);
        return jsonRes(res, 200, await fetchDashboard(force));
      } catch (err) { console.error('[Dashboard]', err.message); return jsonRes(res, 500, { error: err.message || 'Erro dashboard' }); }
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

    if (url === '/api/overview-unificado') {
      const user = requireAuth(req, res); if (!user) return;
      try { return jsonRes(res, 200, await fetchOverviewUnificado()); }
      catch (err) { console.error('[Overview]', err.message); return jsonRes(res, 500, { error: 'Erro overview' }); }
    }

    if (url === '/api/compras-insumos-fabrica') {
      const user = requireAuth(req, res); if (!user) return;
      const force = (req.url.split('?')[1] || '').includes('force=1');
      try {
        const data = await fetchComprasInsumosFabrica({ force });
        return jsonRes(res, data.ok === false ? 502 : 200, data);
      } catch (err) {
        console.error('[ComprasInsumos]', err.message);
        return jsonRes(res, 500, { ok: false, error: 'Erro compras insumos', items: [], total: 0 });
      }
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
  // 1. Boot sync: enche cache do file (ou cria admin default).
  getUsers();
  // 2. Boot async: tenta sincronizar com Supabase (source of truth).
  //    Se Supabase tem dados, sobrescreve cache. Se vazio, faz seed inicial.
  syncUsersFromSupabase().catch((e) =>
    console.error('[Users] sync inicial Supabase falhou:', e.message)
  );
});
