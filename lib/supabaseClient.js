// Cliente HTTP minimalista para Supabase (PostgREST)
// Usa node:https direto pra ficar no estilo do projeto (sem framework, sem deps).
//
// Uso típico (server-side, com SERVICE_ROLE_KEY):
//   const sb = require('./lib/supabaseClient');
//   const rows = await sb.select('dashboard.overview_today');
//   await sb.upsert('core.customers', [{cpf_cnpj:'...', name:'...'}], 'cpf_cnpj');
//   await sb.rpc('refresh_overview');

const https = require('node:https');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY || // alias comum
  '';

function isConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_KEY);
}

function parseUrl(p) {
  return new URL(SUPABASE_URL.replace(/\/$/, '') + p);
}

function request(method, p, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    if (!isConfigured()) {
      return reject(new Error('Supabase não configurado (SUPABASE_URL e SUPABASE_SERVICE_KEY)'));
    }
    const u = parseUrl(p);
    const data = body !== undefined && body !== null ? JSON.stringify(body) : null;
    const headers = Object.assign({
      apikey: SUPABASE_KEY,
      Authorization: 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    }, extraHeaders || {});
    if (data) headers['Content-Length'] = Buffer.byteLength(data);

    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method,
      headers,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        let parsed;
        try { parsed = buf ? JSON.parse(buf) : null; } catch { parsed = buf; }
        if (!ok) {
          const msg = typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
          return reject(new Error('Supabase ' + res.statusCode + ': ' + msg));
        }
        resolve(parsed);
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function splitSchema(table) {
  if (table.includes('.')) {
    const [schema, name] = table.split('.');
    return { schema, name };
  }
  return { schema: 'public', name: table };
}

// SELECT — query é uma querystring no formato PostgREST (sem '?')
//   ex.: select('bling.orders', 'select=id,valor&data=eq.2026-04-28&order=data.desc&limit=50')
async function select(table, query) {
  const { schema, name } = splitSchema(table);
  const qs = query || 'select=*';
  const headers = schema !== 'public' ? { 'Accept-Profile': schema } : {};
  return request('GET', '/rest/v1/' + name + '?' + qs, null, headers);
}

// UPSERT — rows pode ser objeto ou array. onConflict = nome de coluna ou "col1,col2".
async function upsert(table, rows, onConflict) {
  const { schema, name } = splitSchema(table);
  const arr = Array.isArray(rows) ? rows : [rows];
  if (arr.length === 0) return [];
  const qs = onConflict ? '?on_conflict=' + encodeURIComponent(onConflict) : '';
  const headers = {
    Prefer: 'resolution=merge-duplicates,return=representation',
  };
  if (schema !== 'public') headers['Content-Profile'] = schema;
  return request('POST', '/rest/v1/' + name + qs, arr, headers);
}

// INSERT puro (falha em conflito, útil pra append-only)
async function insert(table, rows) {
  const { schema, name } = splitSchema(table);
  const arr = Array.isArray(rows) ? rows : [rows];
  if (arr.length === 0) return [];
  const headers = { Prefer: 'return=representation' };
  if (schema !== 'public') headers['Content-Profile'] = schema;
  return request('POST', '/rest/v1/' + name, arr, headers);
}

// DELETE com filtro PostgREST
async function remove(table, filter) {
  const { schema, name } = splitSchema(table);
  const headers = {};
  if (schema !== 'public') headers['Content-Profile'] = schema;
  return request('DELETE', '/rest/v1/' + name + '?' + filter, null, headers);
}

// RPC — chamada de função SQL exposta via PostgREST
async function rpc(fn, args, schema) {
  const headers = {};
  if (schema && schema !== 'public') headers['Content-Profile'] = schema;
  return request('POST', '/rest/v1/rpc/' + fn, args || {}, headers);
}

module.exports = {
  isConfigured,
  request,
  select,
  upsert,
  insert,
  remove,
  rpc,
};
