'use strict';
/* Pilotage PMO : serveur API + interface web, données stockées dans MySQL / MariaDB. */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

const env = process.env;
const cfg = {
  port: +env.PORT || 3000,
  db: { host: env.DB_HOST || '127.0.0.1', port: +env.DB_PORT || 3306, user: env.DB_USER || 'pmo', password: env.DB_PASSWORD || '', database: env.DB_NAME || 'pmo' },
  secret: env.SESSION_SECRET || '',
  secure: env.COOKIE_SECURE === 'true',
  ttl: (+env.SESSION_HOURS || 12) * 3600,
  trustProxy: env.TRUST_PROXY === 'true',
  adminEmail: (env.ADMIN_EMAIL || '').trim().toLowerCase(),
  adminPassword: env.ADMIN_PASSWORD || '',
  adminName: env.ADMIN_NAME || 'Administrateur'
};
if (cfg.secret.length < 32) { console.error('SESSION_SECRET est absent ou trop court (32 caractères minimum).'); process.exit(1); }

const pool = mysql.createPool({ ...cfg.db, waitForConnections: true, connectionLimit: 10, charset: 'utf8mb4', dateStrings: true, decimalNumbers: true, timezone: 'Z' });
const log = (...a) => console.log(new Date().toISOString(), ...a);

/* ---------- Utilitaires de validation ---------- */
const str = (v, n) => (v === null || v === undefined ? '' : String(v)).slice(0, n);
const num = (v, min, max, def = 0) => { const x = Number(v); return Number.isFinite(x) ? Math.min(max, Math.max(min, x)) : def; };
const dt = v => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const [y, m, d] = v.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d && y >= 1990 && y <= 2200 ? v : null;
};
const jp = v => { if (v === null || v === undefined || v === '') return null; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch (e) { return null; } };
const js = v => JSON.stringify(v === undefined ? null : v);
const rid = () => crypto.randomBytes(8).toString('hex');
const ROLES = ['admin', 'editor', 'viewer'];
class HttpError extends Error { constructor(status, msg, body) { super(msg); this.status = status; this.body = body; } }

/* ---------- Initialisation de la base ---------- */
async function waitForDb() {
  for (let i = 1; i <= 40; i++) {
    try { const c = await pool.getConnection(); await c.ping(); c.release(); return; }
    catch (e) { log(`Base de données indisponible (${e.code || e.message}), nouvelle tentative ${i}/40`); await new Promise(r => setTimeout(r, 2000)); }
  }
  throw new Error('Impossible de joindre la base de données.');
}
async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8').replace(/^\s*--.*$/gm, '');
  for (const stmt of sql.split(/;\s*(?:\r?\n|$)/).map(s => s.trim()).filter(Boolean)) await pool.query(stmt);
  const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM users');
  if (n === 0) {
    if (cfg.adminEmail && cfg.adminPassword.length >= 10) {
      await pool.query('INSERT INTO users (id,email,name,role,pass_hash) VALUES (?,?,?,?,?)', [rid(), cfg.adminEmail, cfg.adminName, 'admin', await bcrypt.hash(cfg.adminPassword, 11)]);
      log('Compte administrateur créé :', cfg.adminEmail);
    } else log('ATTENTION : aucun utilisateur. Définissez ADMIN_EMAIL et ADMIN_PASSWORD (10 caractères minimum) ou lancez « npm run user -- add ».');
  }
}

/* ---------- Sessions ---------- */
const sign = p => crypto.createHmac('sha256', cfg.secret).update(p).digest('base64url');
const sv = hash => crypto.createHash('sha256').update(hash).digest('hex').slice(0, 10);
const makeToken = u => { const p = `${u.id}.${Math.floor(Date.now() / 1000) + cfg.ttl}.${sv(u.pass_hash)}`; return `${p}.${sign(p)}`; };
function readCookie(req, name) {
  const h = req.headers.cookie; if (!h) return null;
  for (const part of h.split(';')) { const i = part.indexOf('='); if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim()); }
  return null;
}
const setCookie = (res, token, maxAge) => res.setHeader('Set-Cookie', `pmo_session=${token ? encodeURIComponent(token) : ''}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${cfg.secure ? '; Secure' : ''}`);
async function auth(req, res, next) {
  try {
    const t = readCookie(req, 'pmo_session'); if (!t) throw new HttpError(401, 'Non connecté');
    const parts = t.split('.'); if (parts.length !== 4) throw new HttpError(401, 'Session invalide');
    const p = parts.slice(0, 3).join('.'); const a = Buffer.from(sign(p)), b = Buffer.from(parts[3]);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new HttpError(401, 'Session invalide');
    if (+parts[1] < Date.now() / 1000) throw new HttpError(401, 'Session expirée');
    const [[u]] = await pool.query('SELECT id,email,name,role,pass_hash,active FROM users WHERE id=?', [parts[0]]);
    if (!u || !u.active || sv(u.pass_hash) !== parts[2]) throw new HttpError(401, 'Session invalide');
    req.user = { id: u.id, email: u.email, name: u.name, role: u.role };
    next();
  } catch (e) { next(e); }
}
const need = (...roles) => (req, res, next) => roles.includes(req.user.role) ? next() : next(new HttpError(403, 'Votre compte est en lecture seule.'));
const DUMMY_HASH = bcrypt.hashSync('pmo-dummy', 11);
const attempts = new Map();
function throttle(key) {
  const now = Date.now(), r = attempts.get(key) || { n: 0, t: now };
  if (now - r.t > 15 * 60e3) { r.n = 0; r.t = now; }
  attempts.set(key, r); return r;
}

/* ---------- Audit ---------- */
const audit = (conn, user, action, entity, entityId, detail) =>
  conn.query('INSERT INTO audit_log (user_id,user_name,action,entity,entity_id,detail) VALUES (?,?,?,?,?,?)',
    [user ? user.id : null, user ? user.name : null, action, entity || null, entityId || null, detail ? js(detail).slice(0, 5000) : null]);

/* ---------- Projets : lecture ---------- */
const group = (rows, mapFn) => { const m = new Map(); rows.forEach(r => { if (!m.has(r.project_id)) m.set(r.project_id, []); m.get(r.project_id).push(mapFn(r)); }); return m; };
async function loadProjects(conn, onlyId) {
  const w = onlyId ? 'p.id=? AND p.deleted_at IS NULL' : 'p.deleted_at IS NULL', a = onlyId ? [onlyId] : [];
  const [P] = await conn.query(`SELECT p.* FROM projects p WHERE ${w} ORDER BY p.code, p.name`, a);
  if (!P.length) return [];
  const j = `JOIN projects p ON p.id=x.project_id WHERE ${w}`;
  const [T] = await conn.query(`SELECT x.* FROM tasks x ${j} ORDER BY x.project_id,x.pos`, a);
  const [L] = await conn.query(`SELECT x.* FROM budget_lines x ${j} ORDER BY x.project_id,x.pos`, a);
  const [R] = await conn.query(`SELECT x.* FROM risks x ${j} ORDER BY x.project_id,x.pos`, a);
  const [U] = await conn.query(`SELECT x.* FROM status_updates x ${j} ORDER BY x.project_id,x.upd_date`, a);
  const tasks = group(T, r => { const o = { id: r.id, phase: r.phase, name: r.name, owner: r.owner, start: r.start_date || '', end: r.end_date || '', progress: r.progress, ms: !!r.is_milestone, deps: jp(r.deps) || [] }; if (r.is_deploy) o.deploy = true; return o; });
  const lines = group(L, r => ({ id: r.id, cat: r.category, label: r.label, planned: r.planned, committed: r.committed, actual: r.actual, etc: r.etc === null ? null : r.etc }));
  const risks = group(R, r => ({ id: r.id, title: r.title, cat: r.category, prob: r.probability, imp: r.impact, owner: r.owner, resp: r.response, mitigation: r.mitigation || '', due: r.due_date || '', status: r.status, created: r.created_on || '' }));
  const upds = group(U, r => ({ id: r.id, date: r.upd_date, rag: r.rag, done: r.done || '', next: r.next_steps || '', issues: r.issues || '', decisions: r.decisions || '', snap: jp(r.snapshot) || undefined }));
  return P.map(r => ({
    ...(jp(r.extra) || {}),
    id: r.id, code: r.code, name: r.name, type: r.type, manager: r.manager, sponsor: r.sponsor, status: r.status, priority: r.priority,
    start: r.start_date || '', end: r.end_date || '', budget: r.budget, progress: r.progress, ragManual: r.rag_manual,
    description: r.description || '', objectives: r.objectives || '', quality: jp(r.quality) || {},
    tasks: tasks.get(r.id) || [], lines: lines.get(r.id) || [], risks: risks.get(r.id) || [], updates: upds.get(r.id) || [], _v: r.version
  }));
}
async function revision(conn) {
  const [[a]] = await conn.query("SELECT COUNT(*) n, COALESCE(MAX(updated_at),'0') m, COALESCE(SUM(version),0) v FROM projects");
  const [[b]] = await conn.query("SELECT COALESCE(MAX(updated_at),'0') m FROM settings");
  return `${a.n}|${a.m}|${a.v}|${b.m}`;
}

/* ---------- Projets : écriture ---------- */
const KNOWN = new Set(['id', 'code', 'name', 'type', 'manager', 'sponsor', 'status', 'priority', 'start', 'end', 'budget', 'progress', 'ragManual', 'description', 'objectives', 'quality', 'tasks', 'lines', 'risks', 'updates', '_v', '_mem']);
const uniq = (seen, id, i) => { let k = str(id, 40) || 'x' + rid().slice(0, 8); if (seen.has(k)) k = (k.slice(0, 33) + '_' + i).slice(0, 40); seen.add(k); return k; };
async function saveProject(user, id, p, version) {
  if (!/^[A-Za-z0-9_.:-]{1,40}$/.test(id)) throw new HttpError(400, 'Identifiant de projet invalide.');
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw new HttpError(400, 'Projet invalide.');
  const arr = (k, max) => { const a = p[k] === undefined ? [] : p[k]; if (!Array.isArray(a) || a.length > max) throw new HttpError(400, `Champ « ${k} » invalide ou trop volumineux (max ${max}).`); return a; };
  const tasks = arr('tasks', 3000), lines = arr('lines', 1000), risks = arr('risks', 2000), upds = arr('updates', 2000);
  const extra = {}; Object.keys(p).forEach(k => { if (!KNOWN.has(k)) extra[k] = p[k]; });
  const extraJson = js(extra); if (extraJson.length > 20000) throw new HttpError(400, 'Champs additionnels trop volumineux.');
  const quality = js(p.quality && typeof p.quality === 'object' ? p.quality : {});
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [found] = await conn.query('SELECT version, deleted_at FROM projects WHERE id=? FOR UPDATE', [id]);
    const cur = found[0];
    let ver;
    if (cur && !cur.deleted_at) {
      if (version === null || version === undefined || +version !== cur.version) {
        await conn.rollback();
        const now = await loadProjects(conn, id);
        throw new HttpError(409, 'Ce projet a été modifié par un autre utilisateur.', { current: now[0] || null });
      }
      ver = cur.version + 1;
    } else ver = cur ? cur.version + 1 : 1;
    const row = [str(p.code, 40), str(p.name, 255) || 'Sans titre', str(p.type, 80), str(p.manager, 120), str(p.sponsor, 120), str(p.status, 20) || 'Planifié', str(p.priority, 20) || 'Moyenne',
      dt(p.start), dt(p.end), num(p.budget, 0, 9e15), num(p.progress, 0, 100), str(p.ragManual, 8) || 'auto', str(p.description, 20000), str(p.objectives, 20000), quality, extraJson];
    if (cur) await conn.query('UPDATE projects SET code=?,name=?,type=?,manager=?,sponsor=?,status=?,priority=?,start_date=?,end_date=?,budget=?,progress=?,rag_manual=?,description=?,objectives=?,quality=?,extra=?,version=?,updated_by=?,deleted_at=NULL WHERE id=?', [...row, ver, user.name, id]);
    else await conn.query('INSERT INTO projects (code,name,type,manager,sponsor,status,priority,start_date,end_date,budget,progress,rag_manual,description,objectives,quality,extra,version,updated_by,id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [...row, ver, user.name, id]);
    for (const t of ['tasks', 'budget_lines', 'risks', 'status_updates']) await conn.query(`DELETE FROM ${t} WHERE project_id=?`, [id]);
    let s = new Set();
    if (tasks.length) await conn.query('INSERT INTO tasks (project_id,id,pos,phase,name,owner,start_date,end_date,progress,is_milestone,is_deploy,deps) VALUES ?', [tasks.map((t, i) => [id, uniq(s, t.id, i), i, str(t.phase, 120), str(t.name, 255) || 'Sans titre', str(t.owner, 120), dt(t.start), dt(t.end), num(t.progress, 0, 100), t.ms ? 1 : 0, t.deploy ? 1 : 0, js(Array.isArray(t.deps) ? t.deps.map(d => str(d, 40)).slice(0, 50) : [])])]);
    s = new Set();
    if (lines.length) await conn.query('INSERT INTO budget_lines (project_id,id,pos,category,label,planned,committed,actual,etc) VALUES ?', [lines.map((l, i) => [id, uniq(s, l.id, i), i, str(l.cat, 120), str(l.label, 255), num(l.planned, 0, 9e15), num(l.committed, 0, 9e15), num(l.actual, 0, 9e15), l.etc === null || l.etc === undefined || l.etc === '' ? null : num(l.etc, 0, 9e15)])]);
    s = new Set();
    if (risks.length) await conn.query('INSERT INTO risks (project_id,id,pos,title,category,probability,impact,owner,response,mitigation,due_date,status,created_on) VALUES ?', [risks.map((r, i) => [id, uniq(s, r.id, i), i, str(r.title, 500) || 'Sans titre', str(r.cat, 60), Math.round(num(r.prob, 1, 5, 3)), Math.round(num(r.imp, 1, 5, 3)), str(r.owner, 120), str(r.resp, 40), str(r.mitigation, 20000), dt(r.due), str(r.status, 20) || 'Ouvert', dt(r.created)])]);
    s = new Set();
    const ups = upds.filter(u => dt(u.date));
    if (ups.length) await conn.query('INSERT INTO status_updates (project_id,id,upd_date,rag,done,next_steps,issues,decisions,snapshot) VALUES ?', [ups.map((u, i) => [id, uniq(s, u.id, i), u.date, str(u.rag, 8) || 'ok', str(u.done, 20000), str(u.next, 20000), str(u.issues, 20000), str(u.decisions, 20000), u.snap ? js(u.snap).slice(0, 5000) : null])]);
    await audit(conn, user, cur && !cur.deleted_at ? 'project.update' : 'project.create', 'project', id, { code: p.code, name: p.name, version: ver, tasks: tasks.length, lines: lines.length, risks: risks.length, updates: ups.length });
    await conn.commit();
    return ver;
  } catch (e) { try { await conn.rollback(); } catch (x) { /* déjà annulé */ } throw e; }
  finally { conn.release(); }
}

/* ---------- Application ---------- */
const app = express();
if (cfg.trustProxy) app.set('trust proxy', true);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  if (cfg.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  next();
});
app.use('/api', express.json({ limit: '3mb' }));
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers['x-requested-with'] !== 'pmo') return next(new HttpError(403, 'Requête refusée.'));
  next();
});
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

app.get('/api/health', wrap(async (req, res) => {
  let db = false; try { await pool.query('SELECT 1'); db = true; } catch (e) { /* base injoignable */ }
  res.json({ app: 'pmo', ok: db, db });
}));

app.post('/api/login', wrap(async (req, res) => {
  const email = str(req.body && req.body.email, 190).trim().toLowerCase(), password = str(req.body && req.body.password, 200);
  const k1 = 'ip:' + req.ip, k2 = 'em:' + email, r1 = throttle(k1), r2 = throttle(k2);
  if (r1.n >= 20 || r2.n >= 6) throw new HttpError(429, 'Trop de tentatives. Réessayez dans 15 minutes.');
  const [[u]] = await pool.query('SELECT * FROM users WHERE email=?', [email]);
  const ok = await bcrypt.compare(password, u ? u.pass_hash : DUMMY_HASH);
  if (!u || !u.active || !ok) { r1.n++; r2.n++; await audit(pool, null, 'login.fail', 'user', null, { email }); throw new HttpError(401, 'Adresse e-mail ou mot de passe incorrect.'); }
  attempts.delete(k2);
  await pool.query('UPDATE users SET last_login=CURRENT_TIMESTAMP(3) WHERE id=?', [u.id]);
  setCookie(res, makeToken(u), cfg.ttl);
  await audit(pool, u, 'login', 'user', u.id);
  res.json({ user: { id: u.id, email: u.email, name: u.name, role: u.role } });
}));
app.post('/api/logout', (req, res) => { setCookie(res, '', 0); res.json({ ok: true }); });
app.get('/api/me', auth, (req, res) => res.json({ user: req.user }));
app.post('/api/me/password', auth, wrap(async (req, res) => {
  const cur = str(req.body && req.body.current, 200), nw = str(req.body && req.body.next, 200);
  if (nw.length < 10) throw new HttpError(400, 'Le nouveau mot de passe doit contenir au moins 10 caractères.');
  const [[u]] = await pool.query('SELECT * FROM users WHERE id=?', [req.user.id]);
  if (!(await bcrypt.compare(cur, u.pass_hash))) throw new HttpError(400, 'Mot de passe actuel incorrect.');
  const h = await bcrypt.hash(nw, 11); await pool.query('UPDATE users SET pass_hash=? WHERE id=?', [h, u.id]);
  await audit(pool, req.user, 'password.change', 'user', u.id);
  setCookie(res, makeToken({ ...u, pass_hash: h }), cfg.ttl); res.json({ ok: true });
}));

app.get('/api/rev', auth, wrap(async (req, res) => res.json({ rev: await revision(pool) })));
app.get('/api/state', auth, wrap(async (req, res) => {
  const rev = await revision(pool);
  const [S] = await pool.query("SELECT v FROM settings WHERE k='app'");
  res.json({ user: req.user, rev, settings: S.length ? jp(S[0].v) || {} : {}, projects: await loadProjects(pool) });
}));
app.put('/api/projects/:id', auth, need('admin', 'editor'), wrap(async (req, res) => {
  const ver = await saveProject(req.user, req.params.id, req.body && req.body.project, req.body ? req.body.version : null);
  res.json({ version: ver });
}));
app.delete('/api/projects/:id', auth, need('admin', 'editor'), wrap(async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [r] = await conn.query('UPDATE projects SET deleted_at=CURRENT_TIMESTAMP(3), version=version+1, updated_by=? WHERE id=? AND deleted_at IS NULL', [req.user.name, req.params.id]);
    if (r.affectedRows) await audit(conn, req.user, 'project.delete', 'project', req.params.id);
    await conn.commit(); res.json({ ok: true });
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
}));
app.put('/api/settings', auth, need('admin', 'editor'), wrap(async (req, res) => {
  const body = req.body; if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Paramètres invalides.');
  const v = js(body); if (v.length > 250000) throw new HttpError(400, 'Paramètres trop volumineux.');
  await pool.query('INSERT INTO settings (k,v,updated_by) VALUES (?,?,?) ON DUPLICATE KEY UPDATE v=VALUES(v), updated_by=VALUES(updated_by)', ['app', v, req.user.name]);
  await audit(pool, req.user, 'settings.update', 'settings', 'app');
  res.json({ ok: true });
}));
app.get('/api/audit', auth, need('admin'), wrap(async (req, res) => {
  const lim = Math.min(500, Math.max(1, +req.query.limit || 100));
  const [rows] = await pool.query('SELECT id, at, user_name, action, entity, entity_id, detail FROM audit_log ORDER BY id DESC LIMIT ?', [lim]);
  res.json({ rows: rows.map(r => ({ ...r, detail: jp(r.detail) })) });
}));
app.use('/api', (req, res, next) => next(new HttpError(404, 'Route inconnue.')));

const PUB = path.join(__dirname, 'public');
app.use(express.static(PUB, { index: 'index.html', maxAge: 0, etag: true, setHeaders: (res, p) => { if (p.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache'); else if (p.includes(`${path.sep}vendor${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=604800'); } }));
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...(err.body || {}) });
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'Données trop volumineuses.' });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON invalide.' });
  log('Erreur', req.method, req.originalUrl, err && (err.code || err.message));
  res.status(500).json({ error: 'Erreur serveur.' });
});

(async () => {
  await waitForDb(); await migrate();
  const srv = app.listen(cfg.port, () => log(`Pilotage PMO prêt sur le port ${cfg.port}`));
  const stop = () => { srv.close(() => pool.end().then(() => process.exit(0))); setTimeout(() => process.exit(0), 5000).unref(); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
})().catch(e => { console.error(e); process.exit(1); });
