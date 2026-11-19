const encoder = new TextEncoder();
const COOKIE = 'ts_crm_session';
const SESSION_SECONDS = 60 * 60 * 12;
const PASSWORD_ITERATIONS = 100_000;

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
}
export function fail(message, status = 400) { return json({ error: message }, status); }
export function sameOrigin(request) {
  const origin = request.headers.get('Origin');
  if (!origin) return true;
  try { return new URL(origin).origin === new URL(request.url).origin; } catch { return false; }
}
export async function readJson(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) throw new Error('Formato de solicitação inválido.');
  if (Number(request.headers.get('content-length') || 0) > 12000) throw new Error('O formulário excede o tamanho permitido.');
  return request.json();
}
function b64(bytes) { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function unb64(s) { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return Uint8Array.from(atob(s), c => c.charCodeAt(0)); }
async function hmac(value, secret) { const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign','verify']); return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value))); }
export async function makeSession(secret, user) {
  const payload = b64(encoder.encode(JSON.stringify({ exp: Math.floor(Date.now()/1000) + SESSION_SECONDS, sub: user.id, username: user.username, name: user.name, role: user.role })));
  return `${payload}.${b64(await hmac(payload, secret))}`;
}
export async function getSession(request, secret) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.split(';').map(x => x.trim()).find(x => x.startsWith(COOKIE + '='));
  if (!match) return null;
  let token;
  try { token = decodeURIComponent(match.slice(COOKIE.length + 1)); } catch { return null; }
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra) return null;
  try {
    const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    if (!await crypto.subtle.verify('HMAC', key, unb64(signature), encoder.encode(payload))) return null;
    const data = JSON.parse(new TextDecoder().decode(unb64(payload)));
    if (!data.sub || !['admin','seller'].includes(data.role) || data.exp <= Math.floor(Date.now()/1000)) return null;
    return { id: data.sub, username: data.username, name: data.name, role: data.role };
  } catch { return null; }
}
export async function hasSession(request, secret) { return !!(await getSession(request, secret)); }
export function sessionCookie(token, maxAge = SESSION_SECONDS) { return `${COOKIE}=${encodeURIComponent(token)}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Strict`; }
export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: PASSWORD_ITERATIONS, hash: 'SHA-256' }, key, 256);
  return `pbkdf2-sha256$${PASSWORD_ITERATIONS}$${b64(salt)}$${b64(new Uint8Array(bits))}`;
}
export async function verifyPassword(password, stored) {
  try {
    const [algorithm, rounds, saltText, hashText] = String(stored || '').split('$');
    if (algorithm !== 'pbkdf2-sha256' || Number(rounds) !== PASSWORD_ITERATIONS || !saltText || !hashText) return false;
    const salt = unb64(saltText), expected = unb64(hashText);
    const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: PASSWORD_ITERATIONS, hash: 'SHA-256' }, key, expected.length * 8));
    if (bits.length !== expected.length) return false;
    let diff = 0; for (let i = 0; i < bits.length; i++) diff |= bits[i] ^ expected[i];
    return diff === 0;
  } catch { return false; }
}
export async function rateLimit(request, env, bucket, limit, windowSeconds) {
  const address = request.headers.get('CF-Connecting-IP') || 'unknown';
  const hash = b64(await hmac(`${bucket}:${address}`, env.SESSION_SECRET));
  const now = Math.floor(Date.now()/1000);
  await env.DB.prepare('DELETE FROM request_limits WHERE created_at < ?').bind(now - 86400).run();
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM request_limits WHERE bucket=? AND key_hash=? AND created_at>?').bind(bucket, hash, now-windowSeconds).first();
  if (Number(count?.n || 0) >= limit) return false;
  await env.DB.prepare('INSERT INTO request_limits(bucket,key_hash,created_at) VALUES(?,?,?)').bind(bucket, hash, now).run();
  return true;
}
export function dbRequired(env) { return env.DB && env.CRM_PASSWORD && env.SESSION_SECRET; }
export function validLead(body, isPublic = false) {
  const clean = {
    name: String(body.name || body.nome || '').trim().slice(0,80), phone: String(body.phone || body.telefone || '').trim().slice(0,20),
    email: String(body.email || '').trim().slice(0,120), city: String(body.city || body.cidade || '').trim().slice(0,80),
    plan: String(body.plan || body.plano || 'Não informado').trim().slice(0,50), lives: String(body.lives || body.vidas || '').trim().slice(0,30),
    stage: String(body.stage || 'novo'), next_return_at: String(body.next_return_at || body.returnDate || '').trim(), notes: String(body.notes || '').trim().slice(0,1200)
  };
  if (clean.name.length < 2 || clean.phone.replace(/\D/g,'').length < 10) throw new Error('Informe nome e WhatsApp válido.');
  if (clean.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean.email)) throw new Error('Informe um e-mail válido.');
  if (!['novo','atendimento','cotacao','retorno','fechado'].includes(clean.stage)) throw new Error('Etapa inválida.');
  if (clean.next_return_at && !/^\d{4}-\d{2}-\d{2}$/.test(clean.next_return_at)) throw new Error('Data de retorno inválida.');
  if (isPublic) { clean.stage = 'novo'; clean.notes = ''; }
  return clean;
}
