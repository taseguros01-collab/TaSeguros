import { json, fail, readJson, sameOrigin, makeSession, getSession, sessionCookie, rateLimit, dbRequired, validLead, hashPassword, verifyPassword } from './_lib.js';

const admin = user => user?.role === 'admin';
const cleanUsername = value => String(value || '').trim().toLowerCase();
const safeUser = user => ({ id: user.id, username: user.username, name: user.name, role: user.role, active: Boolean(user.active), created_at: user.created_at });
const passwordOk = value => typeof value === 'string' && value.length >= 12 && value.length <= 200;

async function authenticated(request, env) {
  const session = await getSession(request, env.SESSION_SECRET);
  if (!session) return null;
  const user = await env.DB.prepare('SELECT id,username,name,role,active FROM users WHERE id=?').bind(session.id).first();
  return user?.active ? user : null;
}
async function activeSeller(env, id) {
  if (!id) return true;
  const user = await env.DB.prepare("SELECT id FROM users WHERE id=? AND role='seller' AND active=1").bind(id).first();
  return !!user;
}
async function api({ request, env, params }) {
  const url = new URL(request.url), path = url.pathname, method = request.method;
  if (!dbRequired(env)) return json({ error: 'CRM ainda não configurado.' }, 503);

  if (path === '/api/auth/session' && method === 'GET') {
    const user = await authenticated(request, env);
    if (!user) return fail('Sessão expirada ou acesso desativado.', 401);
    return json({ authenticated: true, user: safeUser(user) });
  }

  if (path === '/api/auth/login' && method === 'POST') {
    if (!sameOrigin(request)) return fail('Origem inválida.', 403);
    if (!await rateLimit(request, env, 'login', 8, 900)) return fail('Muitas tentativas. Aguarde 15 minutos.', 429);
    try {
      const body = await readJson(request), username = cleanUsername(body.username), password = String(body.password || '');
      if (!username || !password) return fail('Informe usuário e senha.');
      let user = await env.DB.prepare('SELECT id,username,name,role,password_hash,active,created_at FROM users WHERE username=? COLLATE NOCASE').bind(username).first();
      if (!user && username === 'admin') {
        const a = new TextEncoder().encode(password), b = new TextEncoder().encode(env.CRM_PASSWORD);
        let diff = a.length ^ b.length; for (let i=0;i<Math.max(a.length,b.length);i++) diff |= (a[i]||0) ^ (b[i]||0);
        if (!diff) {
          const id = crypto.randomUUID(), passwordHash = await hashPassword(password);
          await env.DB.prepare("INSERT OR IGNORE INTO users(id,username,name,role,password_hash) VALUES(?,'admin','Administrador','admin',?)").bind(id,passwordHash).run();
          user = await env.DB.prepare('SELECT id,username,name,role,password_hash,active,created_at FROM users WHERE username=? COLLATE NOCASE').bind('admin').first();
        }
      }
      if (!user || !user.active || !await verifyPassword(password, user.password_hash)) return fail('Usuário ou senha incorretos.', 401);
      const publicUser = safeUser(user), token = await makeSession(env.SESSION_SECRET, publicUser);
      return json({ authenticated: true, user: publicUser }, 200, { 'set-cookie': sessionCookie(token) });
    } catch (error) { return fail(error.message || 'Não foi possível entrar.'); }
  }

  if (path === '/api/auth/logout' && method === 'POST') {
    if (!sameOrigin(request)) return fail('Origem inválida.', 403);
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie('', 0) });
  }

  if (path === '/api/public-leads' && method === 'POST') {
    if (!sameOrigin(request)) return fail('Origem inválida.', 403);
    if (!await rateLimit(request, env, 'public-lead', 8, 3600)) return fail('Muitas solicitações deste acesso. Tente novamente mais tarde.', 429);
    try {
      const body = await readJson(request);
      if (body.empresa_site) return json({ ok: true });
      if (body.consent !== true && body.aceite !== true) return fail('É necessário aceitar o contato para solicitar a cotação.');
      const lead = validLead(body, true), id = crypto.randomUUID();
      await env.DB.prepare('INSERT INTO leads(id,name,phone,email,city,plan,lives,stage,next_return_at,notes,source,consent_at,updated_at) VALUES(?,?,?,?,?,?,?,"novo","","","site",datetime("now"),datetime("now"))').bind(id,lead.name,lead.phone,lead.email,lead.city,lead.plan,lead.lives).run();
      return json({ ok: true, id }, 201);
    } catch (error) { return fail(error.message || 'Não foi possível registrar o pedido.'); }
  }

  if (path === '/api/leads' && method === 'GET') {
    const user = await authenticated(request, env); if (!user) return fail('Acesso não autorizado.', 401);
    const base = `SELECT l.id,l.name,l.phone,l.email,l.city,l.plan,l.lives,l.stage,l.next_return_at,l.notes,l.source,l.created_at,l.updated_at,l.assigned_to,u.name AS assigned_name FROM leads l LEFT JOIN users u ON u.id=l.assigned_to`;
    const result = admin(user)
      ? await env.DB.prepare(`${base} ORDER BY CASE WHEN l.next_return_at='' THEN 1 ELSE 0 END,l.next_return_at,l.created_at DESC`).all()
      : await env.DB.prepare(`${base} WHERE l.assigned_to=? ORDER BY CASE WHEN l.next_return_at='' THEN 1 ELSE 0 END,l.next_return_at,l.created_at DESC`).bind(user.id).all();
    return json(result.results || []);
  }

  if (path === '/api/leads' && method === 'POST') {
    if (!sameOrigin(request)) return fail('Origem inválida.', 403);
    const user = await authenticated(request, env); if (!user) return fail('Acesso não autorizado.', 401);
    try {
      const body = await readJson(request), lead = validLead(body), id = crypto.randomUUID();
      const assignedTo = admin(user) ? (String(body.assigned_to || '').trim() || null) : user.id;
      if (assignedTo && !await activeSeller(env, assignedTo) && !(admin(user) && assignedTo === user.id)) return fail('Vendedor selecionado não está ativo.', 400);
      await env.DB.prepare('INSERT INTO leads(id,name,phone,email,city,plan,lives,stage,next_return_at,notes,source,assigned_to,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,datetime("now"))').bind(id,lead.name,lead.phone,lead.email,lead.city,lead.plan,lead.lives,lead.stage,lead.next_return_at,lead.notes,'manual',assignedTo).run();
      return json({ id }, 201);
    } catch (error) { return fail(error.message || 'Não foi possível salvar.'); }
  }

  if (path === '/api/users' && method === 'GET') {
    const user = await authenticated(request, env); if (!admin(user)) return fail('Acesso não autorizado.', 403);
    const result = await env.DB.prepare('SELECT id,username,name,role,active,created_at FROM users ORDER BY CASE role WHEN "admin" THEN 0 ELSE 1 END,name COLLATE NOCASE').all();
    return json((result.results || []).map(safeUser));
  }

  if (path === '/api/users' && method === 'POST') {
    if (!sameOrigin(request)) return fail('Origem inválida.', 403);
    const user = await authenticated(request, env); if (!admin(user)) return fail('Acesso não autorizado.', 403);
    try {
      const body = await readJson(request), name = String(body.name || '').trim().slice(0,80), username = cleanUsername(body.username), password = String(body.password || '');
      if (name.length < 2) return fail('Informe o nome do vendedor.');
      if (!/^[a-z0-9._-]{3,40}$/.test(username)) return fail('O usuário deve ter 3 a 40 caracteres: letras, números, ponto, hífen ou sublinhado.');
      if (!passwordOk(password)) return fail('A senha precisa ter entre 12 e 200 caracteres.');
      const id = crypto.randomUUID(), passwordHash = await hashPassword(password);
      await env.DB.prepare("INSERT INTO users(id,username,name,role,password_hash) VALUES(?,?,?,'seller',?)").bind(id,username,name,passwordHash).run();
      const created = await env.DB.prepare('SELECT id,username,name,role,active,created_at FROM users WHERE id=?').bind(id).first();
      return json({ user: safeUser(created) }, 201);
    } catch (error) {
      if (/UNIQUE|constraint/i.test(error.message || '')) return fail('Esse nome de usuário já está em uso.');
      return fail(error.message || 'Não foi possível criar o usuário.');
    }
  }

  const userMatch = path.match(/^\/api\/users\/([^/]+)$/);
  if (userMatch && method === 'PUT') {
    if (!sameOrigin(request)) return fail('Origem inválida.', 403);
    const user = await authenticated(request, env); if (!admin(user)) return fail('Acesso não autorizado.', 403);
    try {
      const id = decodeURIComponent(userMatch[1]), body = await readJson(request);
      const target = await env.DB.prepare('SELECT id,role FROM users WHERE id=?').bind(id).first();
      if (!target) return fail('Usuário não encontrado.', 404);
      if (target.role !== 'seller') return fail('Somente contas de vendedor podem ser alteradas aqui.', 400);
      const fields = [], values = [];
      if (typeof body.active === 'boolean') { fields.push('active=?'); values.push(body.active ? 1 : 0); }
      if (body.name !== undefined) { const name=String(body.name).trim().slice(0,80); if(name.length<2)return fail('Informe o nome do vendedor.'); fields.push('name=?'); values.push(name); }
      if (body.password !== undefined) { const password=String(body.password); if(!passwordOk(password))return fail('A senha precisa ter entre 12 e 200 caracteres.'); fields.push('password_hash=?'); values.push(await hashPassword(password)); }
      if (!fields.length) return fail('Nenhuma alteração informada.');
      values.push(id); await env.DB.prepare(`UPDATE users SET ${fields.join(',')} WHERE id=?`).bind(...values).run();
      const updated=await env.DB.prepare('SELECT id,username,name,role,active,created_at FROM users WHERE id=?').bind(id).first();
      return json({ user: safeUser(updated) });
    } catch (error) { return fail(error.message || 'Não foi possível atualizar o usuário.'); }
  }

  const leadMatch = path.match(/^\/api\/leads\/([^/]+)$/);
  if (leadMatch && ['PUT','DELETE'].includes(method)) {
    if (!sameOrigin(request)) return fail('Origem inválida.', 403);
    const user = await authenticated(request, env); if (!user) return fail('Acesso não autorizado.', 401);
    const id = decodeURIComponent(leadMatch[1]);
    const old = admin(user)
      ? await env.DB.prepare('SELECT * FROM leads WHERE id=?').bind(id).first()
      : await env.DB.prepare('SELECT * FROM leads WHERE id=? AND assigned_to=?').bind(id,user.id).first();
    if (!old) return fail('Cotação não encontrada.', 404);
    if (method === 'DELETE') {
      if (!admin(user)) return fail('Somente a gestão pode excluir cotações.', 403);
      const result = await env.DB.prepare('DELETE FROM leads WHERE id=?').bind(id).run();
      return result.meta?.changes ? json({ ok:true }) : fail('Cotação não encontrada.',404);
    }
    try {
      const body=await readJson(request), lead=validLead({ ...old, ...body });
      const assignedTo=admin(user) ? (body.assigned_to !== undefined ? (String(body.assigned_to || '').trim() || null) : old.assigned_to) : old.assigned_to;
      if (admin(user) && assignedTo && !await activeSeller(env,assignedTo)) return fail('Vendedor selecionado não está ativo.',400);
      await env.DB.prepare('UPDATE leads SET name=?,phone=?,email=?,city=?,plan=?,lives=?,stage=?,next_return_at=?,notes=?,assigned_to=?,updated_at=datetime("now") WHERE id=?').bind(lead.name,lead.phone,lead.email,lead.city,lead.plan,lead.lives,lead.stage,lead.next_return_at,lead.notes,assignedTo,id).run();
      return json({ ok:true });
    } catch (error) { return fail(error.message || 'Não foi possível atualizar.'); }
  }

  return fail('Rota não encontrada.', 404);
}

export async function onRequest(context) {
  if (new URL(context.request.url).pathname.startsWith('/api/')) return api(context);
  return context.next();
}
