'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const cookieSession = require('cookie-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const QRCode = require('qrcode');
const ExcelJS = require('exceljs');

const { db, seed, crearSede, crearUsuario, slugify, token, hoy, ahora } = require('./db');
const { esc, layout, flashHtml, fechaCorta, fechaLarga, hora, badgeEstado } = require('./views');
const S = require('./servicios');
const { actaPdf } = require('./pdf');
const { sabanaXlsx } = require('./excel');

const PORT = Number(process.env.PORT || 3100);
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const SECRET = process.env.SESSION_SECRET || (() => { console.warn('[aviso] SESSION_SECRET no definido; se usa uno temporal.'); return crypto.randomBytes(32).toString('hex'); })();

const archivoCred = seed();
if (archivoCred) console.log(`[inicio] Base de datos creada. Credenciales iniciales en: ${archivoCred}`);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.set('Referrer-Policy', 'same-origin');
  next();
});
app.use('/static', express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));
app.use(express.urlencoded({ extended: false, limit: '3mb', parameterLimit: 2000 }));
app.use(cookieSession({ name: 'inv_sena', keys: [SECRET], maxAge: 12 * 3600 * 1000, sameSite: 'lax', httpOnly: true, secure: process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === '1' : BASE_URL.startsWith('https') }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 3 * 1024 * 1024, files: 1 } });

// ---------------------------------------------------------------- utilidades
const sedePorSlug = (slug) => db.prepare('SELECT * FROM sedes WHERE slug = ?').get(slug);
const usuarioActual = (req) => (req.session && req.session.uid ? db.prepare('SELECT * FROM usuarios WHERE id = ? AND activo = 1').get(req.session.uid) : null);
function csrf(req) { if (!req.session.csrf) req.session.csrf = crypto.randomBytes(18).toString('hex'); return req.session.csrf; }
const H = (req) => `<input type="hidden" name="_csrf" value="${esc(csrf(req))}">`;
function flash(req, msg, tipo = 'ok') { req.session.flash = { msg, tipo }; }
function render(req, res, { title, body, nav, sede, publico = false, status = 200 }) {
  const f = req.session ? req.session.flash : null; if (f) req.session.flash = null;
  res.status(status).type('html').send(layout({ title, body, nav, sede, publico, user: req.user, csrf: req.session ? csrf(req) : '', flash: flashHtml(f) }));
}
const entero = (v, min = 0, max = 99999) => { const n = Number.parseInt(String(v ?? '').trim(), 10); return Number.isFinite(n) && n >= min && n <= max ? n : null; };
const texto = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const fechaValida = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : null);
function sumarDias(iso, n) { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
// Horarios oficiales de formación por jornada (Centro Agroturístico)
const HORARIOS = { 'Mañana': '6:30 a 12:30', 'Tarde': '12:30 a 18:30', 'Noche': '18:30 a 23:30' };
function jornadaActual() {
  const [h, m] = ahora().slice(11, 16).split(':').map(Number); const t = h * 60 + m;
  if (t >= 390 && t < 750) return 'Mañana';
  if (t >= 750 && t < 1110) return 'Tarde';
  if (t >= 1110 && t < 1410) return 'Noche';
  return '';
}
function enmascarar(nombre) { const p = String(nombre).trim().split(/\s+/); return p[0] + (p.length > 1 ? ' ' + p.slice(1).map((x) => x[0] + '.').join(' ') : ''); }

// Límite de intentos simple en memoria
const intentos = new Map();
function limitar(clave, max, ventanaMs) {
  const ahoraMs = Date.now(); const r = intentos.get(clave) || { n: 0, t: ahoraMs };
  if (ahoraMs - r.t > ventanaMs) { r.n = 0; r.t = ahoraMs; }
  r.n++; intentos.set(clave, r); return r.n > max;
}
setInterval(() => { const t = Date.now(); for (const [k, v] of intentos) if (t - v.t > 3600e3) intentos.delete(k); }, 600e3).unref();

// Usuario y CSRF
app.use((req, res, next) => { req.user = usuarioActual(req); next(); });
function verificarCsrf(req, res, next) {
  if (req.method !== 'POST') return next();
  if (!req.body || req.body._csrf !== req.session.csrf) return res.status(403).send('Sesión vencida o formulario inválido. Vuelva atrás y recargue la página.');
  next();
}
function mismoOrigen(req, res, next) {
  const o = req.get('origin') || req.get('referer');
  if (o) { try { if (new URL(o).host !== req.get('host')) return res.status(403).send('Origen no permitido'); } catch { return res.status(403).send('Origen no permitido'); } }
  next();
}
function requiereSuper(req, res, next) {
  if (!req.user) return res.redirect('/login');
  if (req.user.rol !== 'superadmin') return res.status(403).send('Solo coordinación general.');
  next();
}
function requiereSede(req, res, next) {
  if (!req.user) return res.redirect('/login?volver=' + encodeURIComponent(req.originalUrl));
  const sede = sedePorSlug(req.params.slug);
  if (!sede) return res.status(404).send('Sede no encontrada');
  if (req.user.rol !== 'superadmin' && req.user.sede_id !== sede.id) return res.status(403).send('No tiene acceso a esta sede.');
  req.sede = sede; next();
}

// ---------------------------------------------------------------- sesión
app.get('/', (req, res) => {
  if (!req.user) return res.redirect('/login');
  if (req.user.rol === 'superadmin') return res.redirect('/admin');
  const s = db.prepare('SELECT slug FROM sedes WHERE id = ?').get(req.user.sede_id);
  res.redirect(s ? `/s/${s.slug}` : '/login');
});
app.get('/salud', (req, res) => res.json({ ok: true }));

app.get('/login', (req, res) => {
  render(req, res, { title: 'Ingresar', publico: true, body: `
  <div class="login card">
    <p class="eyebrow">Panel de coordinación</p><h1>Ingresar</h1>
    <p class="sub">Inventario diario de ambientes de formación.</p>
    <form method="post" action="/login">${H(req)}<input type="hidden" name="volver" value="${esc(req.query.volver || '')}">
      <div class="campo"><label for="u">Usuario</label><input id="u" name="usuario" type="text" autocomplete="username" required autofocus></div>
      <div class="campo"><label for="p">Contraseña</label><input id="p" name="password" type="password" autocomplete="current-password" required></div>
      <button class="btn" type="submit">Entrar</button>
    </form>
    <p class="ayuda" style="margin-top:14px">¿Es instructor? No necesita cuenta: use el enlace o el código QR de su sede o ambiente.</p>
  </div>` });
});
app.post('/login', verificarCsrf, (req, res) => {
  if (limitar('login:' + req.ip, 10, 15 * 60e3)) { flash(req, 'Demasiados intentos. Espere 15 minutos.', 'error'); return res.redirect('/login'); }
  const u = db.prepare('SELECT * FROM usuarios WHERE usuario = ? AND activo = 1').get(texto(req.body.usuario, 60));
  if (!u || !bcrypt.compareSync(String(req.body.password || ''), u.pass_hash)) { flash(req, 'Usuario o contraseña incorrectos.', 'error'); return res.redirect('/login'); }
  if (u.sede_id) { const s = db.prepare('SELECT activo FROM sedes WHERE id = ?').get(u.sede_id); if (!s || !s.activo) { flash(req, 'La sede está desactivada.', 'error'); return res.redirect('/login'); } }
  req.session.uid = u.id; req.session.csrf = crypto.randomBytes(18).toString('hex');
  const volver = String(req.body.volver || '');
  res.redirect(volver.startsWith('/') && !volver.startsWith('//') ? volver : '/');
});
app.post('/logout', verificarCsrf, (req, res) => { req.session = null; res.redirect('/login'); });

// ---------------------------------------------------------------- superadmin
app.use('/admin', requiereSuper, verificarCsrf);

app.get('/admin', (req, res) => {
  const f = hoy();
  const sedes = db.prepare('SELECT * FROM sedes ORDER BY activo DESC, nombre').all();
  const filas = sedes.map((s) => {
    const r = db.prepare('SELECT COUNT(*) n, COALESCE(SUM(total_faltantes),0) f FROM registros WHERE sede_id = ? AND fecha = ? AND anulado = 0').get(s.id, f);
    const amb = db.prepare('SELECT COUNT(*) n FROM ambientes WHERE sede_id = ? AND activo = 1').get(s.id).n;
    const sin = S.ambientesSinReporte(s.id, f).length;
    const us = db.prepare("SELECT usuario FROM usuarios WHERE sede_id = ? AND activo = 1 ORDER BY id").all(s.id).map((x) => x.usuario).join(', ');
    return `<tr>
      <td><a href="/s/${esc(s.slug)}"><b>${esc(s.nombre)}</b></a><div class="ayuda">/${esc(s.slug)} · usuarios: ${esc(us || '—')}</div></td>
      <td class="num">${amb}</td><td class="num">${r.n}</td>
      <td class="num">${r.f ? `<span class="badge rojo">${r.f}</span>` : '0'}</td>
      <td class="num">${sin ? `<span class="badge ambar">${sin}</span>` : '0'}</td>
      <td>${s.activo ? '<span class="badge verde">Activa</span>' : '<span class="badge gris">Inactiva</span>'}</td>
      <td><form method="post" action="/admin/sedes/${s.id}/estado" style="margin:0">${H(req)}<button class="btn ghost sm">${s.activo ? 'Desactivar' : 'Activar'}</button></form></td></tr>`;
  }).join('');
  render(req, res, { title: 'Sedes', nav: 'admin', body: `
    <p class="eyebrow">Superadmin</p><h1>Sedes</h1>
    <p class="sub">Cada sede tiene sus ambientes, elementos, instructores, usuarios y actas. Hoy: ${esc(fechaLarga(f))}.</p>
    <div class="tabla"><table><thead><tr><th>Sede</th><th class="num">Ambientes</th><th class="num">Registros hoy</th><th class="num">Faltantes hoy</th><th class="num">Sin reporte hoy</th><th>Estado</th><th></th></tr></thead><tbody>${filas || '<tr><td colspan="7">Sin sedes.</td></tr>'}</tbody></table></div>
    <h2>Nueva sede</h2>
    <form class="card" method="post" action="/admin/sedes">${H(req)}
      <div class="grid g2">
        <div class="campo"><label>Nombre de la sede</label><input name="nombre" type="text" required placeholder="Ej.: Sede Barichara"></div>
        <div class="campo"><label>Dirección web del panel</label><input name="slug" type="text" placeholder="se llena sola si la deja vacía"><div class="ayuda">Quedará así: ${esc(BASE_URL)}/s/nombre-sede</div></div>
        <div class="campo"><label>Usuario de la sede</label><input name="usuario" type="text" required placeholder="Ej.: barichara"></div>
        <div class="campo"><label>Contraseña inicial</label><input name="password" type="text" required minlength="8"><div class="ayuda">Mínimo 8 caracteres. Entréguela por un medio seguro.</div></div>
      </div>
      <button class="btn">Crear sede</button>
      <p class="ayuda">La sede se crea con los 11 elementos del formato base (computadores, cargadores, mouse…). Se pueden editar después.</p>
    </form>` });
});

app.post('/admin/sedes', (req, res) => {
  const nombre = texto(req.body.nombre, 80), usuario = texto(req.body.usuario, 40), pass = String(req.body.password || '');
  if (!nombre || !/^[a-zA-Z0-9._-]{3,40}$/.test(usuario) || pass.length < 8) { flash(req, 'Revise los datos: usuario de 3 a 40 letras/números y contraseña de mínimo 8 caracteres.', 'error'); return res.redirect('/admin'); }
  try {
    db.exec('BEGIN');
    const id = crearSede({ nombre, slug: texto(req.body.slug, 60) || nombre });
    crearUsuario({ sedeId: id, usuario, nombre: `Coordinación ${nombre}`, password: pass, rol: 'sede' });
    db.exec('COMMIT');
    flash(req, `Sede «${nombre}» creada con el usuario «${usuario}».`);
  } catch (e) {
    db.exec('ROLLBACK');
    flash(req, /UNIQUE/.test(e.message) ? 'Ya existe una sede con esa dirección o un usuario con ese nombre.' : e.message, 'error');
  }
  res.redirect('/admin');
});
app.post('/admin/sedes/:id/estado', (req, res) => {
  db.prepare('UPDATE sedes SET activo = 1 - activo WHERE id = ?').run(entero(req.params.id));
  flash(req, 'Estado de la sede actualizado.'); res.redirect('/admin');
});

function formSabana(req, accion, sedes) {
  const h = hoy(), d = sumarDias(h, -6);
  return `<form class="card" method="get" action="${accion}">
    <div class="filtros">
      <div class="campo"><label>Desde</label><input type="date" name="desde" value="${d}" required></div>
      <div class="campo"><label>Hasta</label><input type="date" name="hasta" value="${h}" required></div>
      ${sedes ? `<div class="campo"><label>Sede</label><select name="sede"><option value="">Todas las sedes</option>${sedes.map((s) => `<option value="${s.id}">${esc(s.nombre)}</option>`).join('')}</select></div>` : ''}
      <button class="btn">Descargar sábana Excel</button>
    </div>
    <p class="ayuda">El libro trae 5 hojas: Resumen, Sábana (una fila por elemento, con alerta), Por registro, Alertas y Sin reporte. Máximo 366 días por descarga.</p>
  </form>`;
}
async function enviarSabana(res, { sedeId, desde, hasta, sedes }) {
  desde = fechaValida(desde); hasta = fechaValida(hasta);
  if (!desde || !hasta || desde > hasta || S.diasEntre(desde, hasta).length > 366) return res.status(400).send('Rango de fechas inválido (máximo 366 días).');
  const registros = S.registrosRango({ sedeId, desde, hasta });
  const buf = await sabanaXlsx({ registros, desde, hasta, sedes });
  const nombre = `sabana-inventario-${sedes.length === 1 ? sedes[0].slug : 'consolidada'}-${desde}_a_${hasta}.xlsx`;
  res.set('Content-Disposition', `attachment; filename="${nombre}"`).type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(buf);
}
app.get('/admin/sabana', (req, res) => {
  const sedes = db.prepare('SELECT * FROM sedes WHERE activo = 1 ORDER BY nombre').all();
  render(req, res, { title: 'Sábana consolidada', nav: 'asabana', body: `<p class="eyebrow">Superadmin</p><h1>Sábana consolidada</h1><p class="sub">Inventarios firmados de todas las sedes, con alertas de faltantes.</p>${formSabana(req, '/admin/sabana/xlsx', sedes)}` });
});
app.get('/admin/sabana/xlsx', async (req, res) => {
  const sedeId = entero(req.query.sede, 1) || null;
  const sedes = sedeId ? db.prepare('SELECT * FROM sedes WHERE id = ?').all(sedeId) : db.prepare('SELECT * FROM sedes WHERE activo = 1 ORDER BY nombre').all();
  await enviarSabana(res, { sedeId, desde: req.query.desde, hasta: req.query.hasta, sedes });
});
app.get('/admin/cuenta', (req, res) => {
  render(req, res, { title: 'Mi cuenta', nav: 'cuenta', body: `<p class="eyebrow">Superadmin</p><h1>Mi cuenta</h1>
    <form class="card" method="post" action="/admin/cuenta" style="max-width:460px">${H(req)}
      <div class="campo"><label>Nombre</label><input name="nombre" type="text" value="${esc(req.user.nombre)}" required></div>
      <div class="campo"><label>Cargo</label><input name="cargo" type="text" value="${esc(req.user.cargo)}"></div>
      <div class="campo"><label>Contraseña actual</label><input name="actual" type="password" required></div>
      <div class="campo"><label>Nueva contraseña (opcional)</label><input name="nueva" type="password" minlength="8"></div>
      <button class="btn">Guardar</button></form>` });
});
app.post('/admin/cuenta', (req, res) => {
  if (!bcrypt.compareSync(String(req.body.actual || ''), req.user.pass_hash)) { flash(req, 'La contraseña actual no es correcta.', 'error'); return res.redirect('/admin/cuenta'); }
  const nueva = String(req.body.nueva || '');
  if (nueva && nueva.length < 8) { flash(req, 'La nueva contraseña debe tener mínimo 8 caracteres.', 'error'); return res.redirect('/admin/cuenta'); }
  db.prepare('UPDATE usuarios SET nombre = ?, cargo = ? WHERE id = ?').run(texto(req.body.nombre, 80) || req.user.nombre, texto(req.body.cargo, 80), req.user.id);
  if (nueva) db.prepare('UPDATE usuarios SET pass_hash = ? WHERE id = ?').run(bcrypt.hashSync(nueva, 10), req.user.id);
  flash(req, 'Datos actualizados.'); res.redirect('/admin/cuenta');
});

// ---------------------------------------------------------------- panel de sede
const sedeR = express.Router({ mergeParams: true });
// logo público (lo usa también el formulario del instructor)
app.get('/s/:slug/logo', (req, res) => {
  const s = sedePorSlug(req.params.slug);
  if (!s || !s.logo) return res.status(404).end();
  res.type(s.logo_mime).set('Cache-Control', 'public, max-age=300').send(Buffer.from(s.logo));
});
app.use('/s/:slug', requiereSede, sedeR);
const base = (req) => `/s/${req.sede.slug}`;
const urlFormulario = (sede, amb) => `${BASE_URL}/f/${sede.slug}${amb ? '/a/' + amb.token : ''}`;

sedeR.get('/', (req, res) => {
  const s = req.sede, f = hoy();
  const regs = S.registrosDelDia(s.id, f);
  const sin = S.ambientesSinReporte(s.id, f);
  const amb = db.prepare('SELECT COUNT(*) n FROM ambientes WHERE sede_id = ? AND activo = 1').get(s.id).n;
  const falt = regs.reduce((a, r) => a + r.total_faltantes, 0);
  const alertas = [];
  for (const r of regs) for (const it of r.items) { const al = S.alertaItem(it); if (al !== 'OK') alertas.push({ r, it, al }); }
  // Faltantes de los últimos 7 días
  const semana = db.prepare(`SELECT fecha, COUNT(*) n, SUM(total_faltantes) f FROM registros WHERE sede_id = ? AND anulado = 0 AND fecha >= ? GROUP BY fecha ORDER BY fecha DESC`).all(s.id, sumarDias(f, -6));
  render(req, res, { title: 'Inicio', nav: 'inicio', sede: s, body: `
    <p class="eyebrow">${esc(s.nombre)}</p><h1>Inventario de hoy</h1><p class="sub">${esc(fechaLarga(f))}</p>
    ${amb === 0 ? `<div class="flash err">Aún no hay ambientes. <a href="${base(req)}/ambientes">Cree los ambientes y su inventario asignado</a> para que los instructores puedan reportar.</div>` : ''}
    <div class="grid g4">
      <a class="kpi" href="${base(req)}/ambientes"><span>Ambientes activos</span><b>${amb}</b></a>
      <a class="kpi ok" href="${base(req)}/registros?desde=${f}&hasta=${f}"><span>Registros firmados hoy</span><b>${regs.length}</b></a>
      <a class="kpi ${falt ? 'alerta' : ''}" href="${base(req)}/registros?desde=${f}&hasta=${f}&estado=faltante"><span>Unidades faltantes hoy</span><b>${falt}</b></a>
      <a class="kpi ${sin.length ? 'alerta' : ''}" href="#sin"><span>Ambientes sin reporte</span><b>${sin.length}</b></a>
    </div>
    <div class="acciones" style="margin:16px 0">
      <a class="btn" href="${base(req)}/actas/${f}">Ver acta de hoy</a>
      <a class="btn sec" href="${base(req)}/actas/${f}/pdf" target="_blank">Descargar acta PDF</a>
      <a class="btn ghost" href="${base(req)}/sabana">Sábana Excel</a>
    </div>
    <h2>Alertas de hoy</h2>
    ${alertas.length ? `<div class="tabla"><table><thead><tr><th>Ambiente</th><th>Jornada</th><th>Instructor</th><th>Elemento</th><th class="num">Asig.</th><th class="num">Verif.</th><th>Alerta</th><th>Novedad</th></tr></thead><tbody>
      ${alertas.map(({ r, it, al }) => `<tr class="${al === 'FALTANTE' ? 'falta' : 'sobra'}"><td><a href="${base(req)}/registros/${r.id}">${esc(r.ambiente_nombre)}</a></td><td>${esc(r.jornada)}</td><td>${esc(r.instructor_nombre)}</td><td>${esc(it.elemento_nombre)}</td><td class="num">${it.asignada}</td><td class="num">${it.cantidad}</td><td><b>${al}</b></td><td>${esc(it.novedad)}</td></tr>`).join('')}
      </tbody></table></div>` : '<p class="card">Sin faltantes ni novedades reportadas hoy.</p>'}
    <h2 id="sin">Ambientes sin inventario firmado hoy</h2>
    ${sin.length ? `<ul class="card lista-alertas">${sin.map((a) => `<li><b>${esc(a.nombre)}</b>${a.ubicacion ? ' · ' + esc(a.ubicacion) : ''}</li>`).join('')}</ul>` : '<p class="card">Todos los ambientes activos tienen al menos un registro hoy.</p>'}
    <h2>Últimos 7 días</h2>
    <div class="tabla"><table><thead><tr><th>Fecha</th><th class="num">Registros</th><th class="num">Unidades faltantes</th><th></th></tr></thead><tbody>
      ${semana.map((d) => `<tr><td>${esc(fechaLarga(d.fecha))}</td><td class="num">${d.n}</td><td class="num">${d.f ? `<span class="badge rojo">${d.f}</span>` : 0}</td><td><a href="${base(req)}/actas/${d.fecha}">Acta</a></td></tr>`).join('') || '<tr><td colspan="4">Sin registros esta semana.</td></tr>'}
    </tbody></table></div>
    <h2>Enlace para instructores</h2>
    <div class="card grid g2"><div><p>Comparta este enlace (o el QR) con los instructores. Allí eligen el ambiente, verifican el inventario y firman.</p><code class="link">${esc(urlFormulario(s))}</code>
      <p class="ayuda">Cada ambiente también tiene su propio QR en <a href="${base(req)}/ambientes">Ambientes</a>, para pegarlo en la puerta.</p></div>
      <div class="qr">${await_qr(urlFormulario(s))}</div></div>` });
});

// QR en SVG (sincrónico vía caché)
const qrCache = new Map();
function await_qr(url) {
  if (qrCache.has(url)) return qrCache.get(url);
  QRCode.toString(url, { type: 'svg', margin: 1, color: { dark: '#00304D' } }).then((svg) => qrCache.set(url, svg)).catch(() => {});
  return `<img alt="Código QR" src="/qr.svg?u=${encodeURIComponent(url)}" width="150" height="150">`;
}
app.get('/qr.svg', async (req, res) => {
  const u = String(req.query.u || '');
  if (!u.startsWith(BASE_URL + '/f/')) return res.status(400).end();
  res.type('image/svg+xml').set('Cache-Control', 'public, max-age=86400').send(await QRCode.toString(u, { type: 'svg', margin: 1, color: { dark: '#00304D' } }));
});

// ---- Registros
sedeR.get('/registros', (req, res) => {
  const s = req.sede, h = hoy();
  const desde = fechaValida(req.query.desde) || sumarDias(h, -6), hasta = fechaValida(req.query.hasta) || h;
  const ambId = entero(req.query.ambiente, 1); const estado = ['faltante', 'sobrante', 'novedad', 'completo', 'anulado'].includes(req.query.estado) ? req.query.estado : '';
  let sql = 'SELECT * FROM registros WHERE sede_id = ? AND fecha BETWEEN ? AND ?'; const p = [s.id, desde, hasta];
  if (ambId) { sql += ' AND ambiente_id = ?'; p.push(ambId); }
  if (estado === 'anulado') sql += ' AND anulado = 1'; else if (estado) { sql += ' AND estado = ? AND anulado = 0'; p.push(estado); }
  sql += ' ORDER BY fecha DESC, creado DESC LIMIT 1000';
  const regs = db.prepare(sql).all(...p);
  const ambs = db.prepare('SELECT id, nombre FROM ambientes WHERE sede_id = ? ORDER BY nombre').all(s.id);
  render(req, res, { title: 'Registros', nav: 'registros', sede: s, body: `
    <p class="eyebrow">${esc(s.nombre)}</p><h1>Registros de inventario</h1><p class="sub">Cada registro es una formación: el instructor verificó cantidades y firmó.</p>
    <form class="filtros" method="get">
      <div class="campo"><label>Desde</label><input type="date" name="desde" value="${desde}"></div>
      <div class="campo"><label>Hasta</label><input type="date" name="hasta" value="${hasta}"></div>
      <div class="campo"><label>Ambiente</label><select name="ambiente"><option value="">Todos</option>${ambs.map((a) => `<option value="${a.id}" ${a.id === ambId ? 'selected' : ''}>${esc(a.nombre)}</option>`).join('')}</select></div>
      <div class="campo"><label>Estado</label><select name="estado"><option value="">Todos</option>${['faltante', 'sobrante', 'novedad', 'completo', 'anulado'].map((e) => `<option ${e === estado ? 'selected' : ''} value="${e}">${e[0].toUpperCase() + e.slice(1)}</option>`).join('')}</select></div>
      <button class="btn sec">Filtrar</button>
    </form>
    <div class="tabla"><table><thead><tr><th>Fecha</th><th>Ambiente</th><th>Jornada</th><th>Instructor</th><th>Ficha</th><th>Estado</th><th>Firmado</th></tr></thead><tbody>
    ${regs.map((r) => `<tr class="${r.total_faltantes && !r.anulado ? 'falta' : ''}"><td>${fechaCorta(r.fecha)}</td><td><a href="${base(req)}/registros/${r.id}">${esc(r.ambiente_nombre)}</a></td><td>${esc(r.jornada)}</td><td>${esc(r.instructor_nombre)}</td><td>${esc(r.ficha)}</td><td>${badgeEstado(r)}</td><td>${hora(r.creado)}</td></tr>`).join('') || '<tr><td colspan="7">No hay registros con esos filtros.</td></tr>'}
    </tbody></table></div>` });
});

sedeR.get('/registros/:id', (req, res) => {
  const r = db.prepare('SELECT * FROM registros WHERE id = ? AND sede_id = ?').get(req.params.id, req.sede.id);
  if (!r) return res.status(404).send('Registro no encontrado');
  S.conItems([r]);
  render(req, res, { title: 'Registro', nav: 'registros', sede: req.sede, body: `
    <p><a href="${base(req)}/registros">← Volver a registros</a></p>
    <p class="eyebrow">Registro ${esc(r.id.slice(0, 8))}</p><h1>${esc(r.ambiente_nombre)} ${badgeEstado(r)}</h1>
    <div class="card grid g3">
      <div><label>Fecha</label>${esc(fechaLarga(r.fecha))}</div><div><label>Jornada / horario</label>${esc(r.jornada)} ${esc(r.horario || '')}</div><div><label>Firmado</label>${fechaCorta(r.creado)} ${hora(r.creado)}</div>
      <div><label>Instructor</label>${esc(r.instructor_nombre)} · C.C. ${esc(r.instructor_documento)}</div><div><label>Ficha</label>${esc(r.ficha || '—')}</div><div><label>Programa</label>${esc(r.programa || '—')}</div>
    </div>
    ${r.anulado ? `<div class="flash err">Registro anulado: ${esc(r.anulado_motivo)}</div>` : ''}
    <div class="tabla"><table><thead><tr><th>Elemento</th><th class="num">Asignada</th><th class="num">Verificada</th><th class="num">Diferencia</th><th>Novedad</th></tr></thead><tbody>
    ${r.items.map((it) => { const d = it.cantidad - it.asignada; return `<tr class="${d < 0 ? 'falta' : d > 0 ? 'sobra' : ''}"><td>${esc(it.elemento_nombre)}</td><td class="num">${it.asignada}</td><td class="num">${it.cantidad}</td><td class="num"><b>${d > 0 ? '+' + d : d}</b></td><td>${esc(it.novedad)}</td></tr>`; }).join('')}
    </tbody></table></div>
    ${r.observaciones ? `<div class="card"><label>Observaciones</label>${esc(r.observaciones)}</div>` : ''}
    <div class="card"><label>Firma del instructor</label><img class="firma-img" src="${esc(r.firma_png)}" alt="Firma"><div class="ayuda">IP ${esc(r.ip || '')} · ${esc((r.user_agent || '').slice(0, 90))}</div></div>
    ${r.anulado ? '' : `<form class="card no-print" method="post" action="${base(req)}/registros/${r.id}/anular">${H(req)}<label>Anular registro (por error de diligenciamiento o duplicado)</label>
      <div class="acciones"><input name="motivo" type="text" required placeholder="Motivo de la anulación" style="max-width:420px"><button class="btn rojo sm">Anular</button></div>
      <p class="ayuda">El registro no se borra: queda marcado como anulado y sale del acta y de la sábana.</p></form>`}` });
});
sedeR.post('/registros/:id/anular', verificarCsrf, (req, res) => {
  const motivo = texto(req.body.motivo, 300);
  if (!motivo) { flash(req, 'Escriba el motivo.', 'error'); return res.redirect(`${base(req)}/registros/${req.params.id}`); }
  db.prepare('UPDATE registros SET anulado = 1, anulado_motivo = ? WHERE id = ? AND sede_id = ?').run(`${motivo} (por ${req.user.nombre}, ${ahora().replace('T', ' ')})`, req.params.id, req.sede.id);
  flash(req, 'Registro anulado.'); res.redirect(`${base(req)}/registros/${req.params.id}`);
});

// ---- Actas diarias
sedeR.get('/actas', (req, res) => {
  const s = req.sede, f = fechaValida(req.query.fecha);
  if (f) return res.redirect(`${base(req)}/actas/${f}`);
  const dias = db.prepare(`SELECT r.fecha, COUNT(*) n, SUM(r.total_faltantes) f, a.firmado_en FROM registros r LEFT JOIN actas a ON a.sede_id = r.sede_id AND a.fecha = r.fecha
    WHERE r.sede_id = ? AND r.anulado = 0 GROUP BY r.fecha ORDER BY r.fecha DESC LIMIT 60`).all(s.id);
  render(req, res, { title: 'Actas diarias', nav: 'actas', sede: s, body: `
    <p class="eyebrow">${esc(s.nombre)}</p><h1>Actas diarias</h1><p class="sub">Una por día: consolida los inventarios firmados por los instructores. Usted la revisa, la firma y la descarga en PDF.</p>
    <form class="filtros" method="get"><div class="campo"><label>Ir a la fecha</label><input type="date" name="fecha" value="${hoy()}"></div><button class="btn sec">Abrir acta</button></form>
    <div class="tabla"><table><thead><tr><th>Fecha</th><th class="num">Registros</th><th class="num">Unidades faltantes</th><th>Firma coordinación</th><th></th></tr></thead><tbody>
    ${dias.map((d) => `<tr><td><a href="${base(req)}/actas/${d.fecha}">${esc(fechaLarga(d.fecha))}</a></td><td class="num">${d.n}</td><td class="num">${d.f ? `<span class="badge rojo">${d.f}</span>` : 0}</td><td>${d.firmado_en ? '<span class="badge verde">Firmada</span>' : '<span class="badge ambar">Pendiente</span>'}</td><td><a href="${base(req)}/actas/${d.fecha}/pdf" target="_blank">PDF</a></td></tr>`).join('') || '<tr><td colspan="5">Aún no hay registros.</td></tr>'}
    </tbody></table></div>` });
});

function datosActa(sede, fecha) {
  return {
    sede, fecha,
    registros: S.registrosDelDia(sede.id, fecha),
    sinReporte: S.ambientesSinReporte(sede.id, fecha),
    totalAmbientes: db.prepare('SELECT COUNT(*) n FROM ambientes WHERE sede_id = ? AND activo = 1').get(sede.id).n,
    acta: db.prepare('SELECT * FROM actas WHERE sede_id = ? AND fecha = ?').get(sede.id, fecha),
  };
}
sedeR.get('/actas/:fecha', (req, res) => {
  const fecha = fechaValida(req.params.fecha); if (!fecha) return res.status(400).send('Fecha inválida');
  const d = datosActa(req.sede, fecha);
  const falt = d.registros.reduce((a, r) => a + r.total_faltantes, 0);
  const bloques = d.registros.map((r, i) => `
    <div class="card"><h2 style="margin-top:0">${i + 1}. ${esc(r.ambiente_nombre)} · ${esc(r.jornada)} ${esc(r.horario || '')} ${badgeEstado(r)}</h2>
    <p class="ayuda">Instructor: <b>${esc(r.instructor_nombre)}</b> (C.C. ${esc(r.instructor_documento)}) · Ficha ${esc(r.ficha || '—')} · ${esc(r.programa || '')}</p>
    <div class="tabla"><table><thead><tr><th>Elemento</th><th class="num">Asig.</th><th class="num">Verif.</th><th class="num">Dif.</th><th>Novedad</th></tr></thead><tbody>
    ${r.items.map((it) => { const df = it.cantidad - it.asignada; return `<tr class="${df < 0 ? 'falta' : df > 0 ? 'sobra' : ''}"><td>${esc(it.elemento_nombre)}</td><td class="num">${it.asignada}</td><td class="num">${it.cantidad}</td><td class="num"><b>${df > 0 ? '+' + df : df}</b></td><td>${esc(it.novedad)}</td></tr>`; }).join('')}
    </tbody></table></div>${r.observaciones ? `<p><b>Observaciones:</b> ${esc(r.observaciones)}</p>` : ''}
    <p><img class="firma-img" src="${esc(r.firma_png)}" alt="Firma"><br><span class="ayuda">Firmado ${hora(r.creado)} · <a href="${base(req)}/registros/${r.id}">ver registro</a></span></p></div>`).join('');
  const a = d.acta;
  render(req, res, { title: 'Acta ' + fecha, nav: 'actas', sede: req.sede, body: `
    <p class="no-print"><a href="${base(req)}/actas">← Actas</a></p>
    <p class="eyebrow">${esc(req.sede.formato_codigo)} · v${esc(req.sede.formato_version)}</p><h1>Acta diaria de inventario</h1><p class="sub">${esc(req.sede.nombre)} · ${esc(fechaLarga(fecha))}</p>
    <div class="acciones no-print" style="margin-bottom:14px">
      <a class="btn sec" href="${base(req)}/actas/${sumarDias(fecha, -1)}">← Día anterior</a><a class="btn sec" href="${base(req)}/actas/${sumarDias(fecha, 1)}">Día siguiente →</a>
      <a class="btn" href="${base(req)}/actas/${fecha}/pdf" target="_blank">Descargar PDF</a>
    </div>
    <div class="grid g4">
      <div class="kpi"><span>Ambientes con reporte</span><b>${d.totalAmbientes - d.sinReporte.length} / ${d.totalAmbientes}</b></div>
      <div class="kpi"><span>Registros firmados</span><b>${d.registros.length}</b></div>
      <div class="kpi ${falt ? 'alerta' : ''}"><span>Unidades faltantes</span><b>${falt}</b></div>
      <div class="kpi ${d.sinReporte.length ? 'alerta' : ''}"><span>Sin reporte</span><b>${d.sinReporte.length}</b></div>
    </div>
    ${d.sinReporte.length ? `<div class="flash err" style="margin-top:14px"><b>Ambientes sin inventario firmado:</b> ${d.sinReporte.map((x) => esc(x.nombre)).join(', ')}</div>` : ''}
    ${bloques || '<p class="card">No hay registros firmados en esta fecha.</p>'}
    <h2>Firma de coordinación</h2>
    ${a && a.firmado_en ? `<div class="card"><img class="firma-img" src="${esc(a.firma_png)}" alt="Firma"><p><b>${esc(a.firmado_por)}</b> · ${esc(a.cargo || '')}<br><span class="ayuda">Firmada ${fechaCorta(a.firmado_en)} ${hora(a.firmado_en)}</span></p>${a.observaciones ? `<p>${esc(a.observaciones)}</p>` : ''}
      <form method="post" action="${base(req)}/actas/${fecha}/reabrir" class="no-print">${H(req)}<button class="btn ghost sm">Quitar firma para corregir</button></form></div>`
    : `<form class="card no-print" method="post" action="${base(req)}/actas/${fecha}/firmar" data-firma>${H(req)}
      <div class="grid g2"><div class="campo"><label>Nombre</label><input name="firmado_por" type="text" value="${esc(req.user.nombre)}" required></div><div class="campo"><label>Cargo</label><input name="cargo" type="text" value="${esc(req.user.cargo || '')}"></div></div>
      <div class="campo"><label>Observaciones de coordinación (opcional)</label><textarea name="observaciones" rows="2"></textarea></div>
      <label>Firma</label><div class="firma-box"><canvas id="firma"></canvas></div><input type="hidden" name="firma_png" id="firma_png">
      <div class="acciones" style="margin-top:10px"><button type="button" class="btn ghost sm" id="limpiar">Borrar firma</button><button class="btn" type="submit">Firmar acta</button></div>
    </form><script src="/static/formulario.js"></script>`}` });
});
sedeR.get('/actas/:fecha/pdf', async (req, res) => {
  const fecha = fechaValida(req.params.fecha); if (!fecha) return res.status(400).send('Fecha inválida');
  const buf = await actaPdf(datosActa(req.sede, fecha));
  res.type('application/pdf').set('Content-Disposition', `${req.query.descargar ? 'attachment' : 'inline'}; filename="acta-inventario-${req.sede.slug}-${fecha}.pdf"`).send(buf);
});
sedeR.post('/actas/:fecha/firmar', verificarCsrf, (req, res) => {
  const fecha = fechaValida(req.params.fecha); const firma = String(req.body.firma_png || '');
  if (!fecha || !/^data:image\/png;base64,/.test(firma) || firma.length > 2_000_000) { flash(req, 'Falta la firma.', 'error'); return res.redirect(`${base(req)}/actas/${req.params.fecha}`); }
  db.prepare(`INSERT INTO actas (sede_id, fecha, firmado_por, cargo, firma_png, observaciones, firmado_en) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(sede_id, fecha) DO UPDATE SET firmado_por = excluded.firmado_por, cargo = excluded.cargo, firma_png = excluded.firma_png, observaciones = excluded.observaciones, firmado_en = excluded.firmado_en`)
    .run(req.sede.id, fecha, texto(req.body.firmado_por, 100), texto(req.body.cargo, 100), firma, texto(req.body.observaciones, 1000), ahora());
  flash(req, 'Acta firmada. Ya puede descargar el PDF.'); res.redirect(`${base(req)}/actas/${fecha}`);
});
sedeR.post('/actas/:fecha/reabrir', verificarCsrf, (req, res) => {
  db.prepare('UPDATE actas SET firmado_en = NULL, firma_png = NULL WHERE sede_id = ? AND fecha = ?').run(req.sede.id, req.params.fecha);
  flash(req, 'Firma retirada. Puede volver a firmar.'); res.redirect(`${base(req)}/actas/${req.params.fecha}`);
});

// ---- Sábana
sedeR.get('/sabana', (req, res) => {
  render(req, res, { title: 'Sábana Excel', nav: 'sabana', sede: req.sede, body: `<p class="eyebrow">${esc(req.sede.nombre)}</p><h1>Sábana Excel</h1><p class="sub">Todos los inventarios firmados del periodo, con alertas de faltantes, sobrantes, novedades y ambientes sin reporte.</p>${formSabana(req, `${base(req)}/sabana/xlsx`)}` });
});
sedeR.get('/sabana/xlsx', async (req, res) => { await enviarSabana(res, { sedeId: req.sede.id, desde: req.query.desde, hasta: req.query.hasta, sedes: [req.sede] }); });

// ---- Ambientes
sedeR.get('/ambientes', (req, res) => {
  const s = req.sede;
  const ambs = db.prepare(`SELECT a.*, (SELECT COALESCE(SUM(cantidad),0) FROM asignaciones x WHERE x.ambiente_id = a.id) total FROM ambientes a WHERE sede_id = ? ORDER BY activo DESC, nombre`).all(s.id);
  render(req, res, { title: 'Ambientes', nav: 'ambientes', sede: s, body: `
    <p class="eyebrow">${esc(s.nombre)}</p><h1>Ambientes e inventario asignado</h1><p class="sub">El inventario asignado es la referencia con la que se compara lo que verifica el instructor.</p>
    <div class="tabla"><table><thead><tr><th>Ambiente</th><th>Ubicación</th><th class="num">Unidades asignadas</th><th>Estado</th><th></th></tr></thead><tbody>
    ${ambs.map((a) => `<tr><td><a href="${base(req)}/ambientes/${a.id}"><b>${esc(a.nombre)}</b></a></td><td>${esc(a.ubicacion || '')}</td><td class="num">${a.total}</td><td>${a.activo ? '<span class="badge verde">Activo</span>' : '<span class="badge gris">Inactivo</span>'}</td><td><a href="${base(req)}/ambientes/${a.id}">Editar · QR</a></td></tr>`).join('') || '<tr><td colspan="5">Aún no hay ambientes.</td></tr>'}
    </tbody></table></div>
    <h2>Nuevo ambiente</h2>
    <form class="card" method="post" action="${base(req)}/ambientes">${H(req)}
      <div class="grid g2"><div class="campo"><label>Denominación del ambiente</label><input name="nombre" type="text" required placeholder="Ej.: Ambiente 101 – Sistemas"></div>
      <div class="campo"><label>Ubicación (salón / bloque)</label><input name="ubicacion" type="text"></div></div>
      <button class="btn">Crear y asignar inventario</button></form>` });
});
sedeR.post('/ambientes', verificarCsrf, (req, res) => {
  const nombre = texto(req.body.nombre, 100); if (!nombre) return res.redirect(`${base(req)}/ambientes`);
  const r = db.prepare('INSERT INTO ambientes (sede_id, nombre, ubicacion, token, fecha_base) VALUES (?, ?, ?, ?, ?)').run(req.sede.id, nombre, texto(req.body.ubicacion, 100), token(), hoy());
  flash(req, 'Ambiente creado. Ahora registre las cantidades asignadas.'); res.redirect(`${base(req)}/ambientes/${r.lastInsertRowid}`);
});
sedeR.get('/ambientes/:id', (req, res) => {
  const a = db.prepare('SELECT * FROM ambientes WHERE id = ? AND sede_id = ?').get(entero(req.params.id), req.sede.id);
  if (!a) return res.status(404).send('Ambiente no encontrado');
  const inv = S.inventarioAmbiente(a.id, req.sede.id); const url = urlFormulario(req.sede, a);
  render(req, res, { title: a.nombre, nav: 'ambientes', sede: req.sede, body: `
    <p><a href="${base(req)}/ambientes">← Ambientes</a></p><h1>${esc(a.nombre)}</h1>
    <form class="card" method="post" action="${base(req)}/ambientes/${a.id}">${H(req)}
      <div class="grid g3"><div class="campo"><label>Denominación</label><input name="nombre" type="text" value="${esc(a.nombre)}" required></div>
      <div class="campo"><label>Ubicación</label><input name="ubicacion" type="text" value="${esc(a.ubicacion || '')}"></div>
      <div class="campo"><label>Fecha inventario base</label><input name="fecha_base" type="date" value="${esc(a.fecha_base || '')}"></div></div>
      <h2>Cantidad asignada por elemento</h2>
      <div class="tabla"><table><thead><tr><th>Elemento</th><th class="num" style="width:140px">Cantidad asignada</th></tr></thead><tbody>
      ${inv.map((e) => `<tr><td>${esc(e.nombre)}</td><td><input type="number" min="0" max="9999" name="el_${e.id}" value="${e.asignada}" required></td></tr>`).join('')}
      </tbody></table></div>
      <p class="ayuda">Use 0 cuando el ambiente no tenga ese elemento. Para agregar o renombrar elementos vaya a <a href="${base(req)}/elementos">Elementos</a>.</p>
      <div class="acciones"><label class="check"><input type="checkbox" name="activo" value="1" ${a.activo ? 'checked' : ''}> Ambiente activo (se exige reporte diario)</label></div>
      <p><button class="btn">Guardar</button></p>
    </form>
    <h2>Código QR del ambiente</h2>
    <div class="card grid g2"><div><p>Imprímalo y péguelo en el ambiente. Al escanearlo, el instructor abre directamente el formulario de este ambiente.</p><code class="link">${esc(url)}</code>
    <p><a class="btn sec sm" href="/qr.svg?u=${encodeURIComponent(url)}" download="qr-${esc(slugify(a.nombre))}.svg">Descargar QR</a></p></div><div class="qr">${await_qr(url)}</div></div>` });
});
sedeR.post('/ambientes/:id', verificarCsrf, (req, res) => {
  const a = db.prepare('SELECT * FROM ambientes WHERE id = ? AND sede_id = ?').get(entero(req.params.id), req.sede.id);
  if (!a) return res.status(404).send('Ambiente no encontrado');
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE ambientes SET nombre = ?, ubicacion = ?, fecha_base = ?, activo = ? WHERE id = ?').run(texto(req.body.nombre, 100) || a.nombre, texto(req.body.ubicacion, 100), fechaValida(req.body.fecha_base), req.body.activo ? 1 : 0, a.id);
    const up = db.prepare('INSERT INTO asignaciones (ambiente_id, elemento_id, cantidad) VALUES (?, ?, ?) ON CONFLICT(ambiente_id, elemento_id) DO UPDATE SET cantidad = excluded.cantidad');
    for (const e of S.elementosSede(req.sede.id)) { const n = entero(req.body['el_' + e.id], 0, 9999); if (n !== null) up.run(a.id, e.id, n); }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  flash(req, 'Ambiente guardado.'); res.redirect(`${base(req)}/ambientes/${a.id}`);
});

// ---- Elementos
sedeR.get('/elementos', (req, res) => {
  const els = S.elementosSede(req.sede.id, false);
  render(req, res, { title: 'Elementos', nav: 'elementos', sede: req.sede, body: `
    <p class="eyebrow">${esc(req.sede.nombre)}</p><h1>Elementos a verificar</h1><p class="sub">Lista de elementos que el instructor cuenta en cada ambiente. El orden define cómo aparecen en el formulario, el acta y la sábana.</p>
    <div class="tabla"><table><thead><tr><th style="width:90px">Orden</th><th>Elemento</th><th>Activo</th><th></th></tr></thead><tbody>
    ${els.map((e) => `<tr><td colspan="4" style="padding:0"><form method="post" action="${base(req)}/elementos/${e.id}" style="display:grid;grid-template-columns:90px 1fr 90px 110px;gap:8px;align-items:center;padding:6px 10px;margin:0">${H(req)}
      <input type="number" name="orden" value="${e.orden}" min="0" max="999"><input type="text" name="nombre" value="${esc(e.nombre)}" required>
      <label class="check"><input type="checkbox" name="activo" value="1" ${e.activo ? 'checked' : ''}> Sí</label><button class="btn ghost sm">Guardar</button></form></td></tr>`).join('')}
    </tbody></table></div>
    <p class="ayuda">Desactivar un elemento lo quita del formulario sin borrar el histórico.</p>
    <h2>Agregar elemento</h2>
    <form class="card acciones" method="post" action="${base(req)}/elementos">${H(req)}<input type="text" name="nombre" required placeholder="Ej.: Video beam" style="max-width:360px"><button class="btn">Agregar</button></form>` });
});
sedeR.post('/elementos', verificarCsrf, (req, res) => {
  const nombre = texto(req.body.nombre, 80);
  if (nombre) { const max = db.prepare('SELECT COALESCE(MAX(orden),0) m FROM elementos WHERE sede_id = ?').get(req.sede.id).m; db.prepare('INSERT INTO elementos (sede_id, nombre, orden) VALUES (?, ?, ?)').run(req.sede.id, nombre, max + 1); flash(req, 'Elemento agregado. Asigne su cantidad en cada ambiente.'); }
  res.redirect(`${base(req)}/elementos`);
});
sedeR.post('/elementos/:id', verificarCsrf, (req, res) => {
  db.prepare('UPDATE elementos SET nombre = ?, orden = ?, activo = ? WHERE id = ? AND sede_id = ?').run(texto(req.body.nombre, 80), entero(req.body.orden, 0, 999) ?? 0, req.body.activo ? 1 : 0, entero(req.params.id), req.sede.id);
  flash(req, 'Elemento actualizado.'); res.redirect(`${base(req)}/elementos`);
});

// ---- Instructores
sedeR.get('/instructores', (req, res) => {
  const q = texto(req.query.q, 60);
  const ins = db.prepare(`SELECT * FROM instructores WHERE sede_id = ? ${q ? 'AND (nombre LIKE ? OR documento LIKE ?)' : ''} ORDER BY activo DESC, nombre`).all(...(q ? [req.sede.id, `%${q}%`, `%${q}%`] : [req.sede.id]));
  render(req, res, { title: 'Instructores', nav: 'instructores', sede: req.sede, body: `
    <p class="eyebrow">${esc(req.sede.nombre)}</p><h1>Instructores</h1><p class="sub">Personas que pueden firmar el inventario en esta sede. No necesitan cuenta: escriben su nombre y documento en el formulario. Si un documento no está en la lista, se agrega solo al primer registro.</p>
    <form class="filtros" method="get"><div class="campo"><label>Buscar</label><input type="text" name="q" value="${esc(q)}"></div><button class="btn sec">Buscar</button></form>
    <div class="tabla"><table><thead><tr><th>Documento</th><th>Nombre</th><th>Celular</th><th>Correo</th><th>Estado</th><th></th></tr></thead><tbody>
    ${ins.map((i) => `<tr><td>${esc(i.documento)}</td><td>${esc(i.nombre)}</td><td>${esc(i.celular || '')}</td><td>${esc(i.correo || '')}</td><td>${i.activo ? '<span class="badge verde">Activo</span>' : '<span class="badge gris">Inactivo</span>'}</td>
      <td><form method="post" action="${base(req)}/instructores/${i.id}/estado" style="margin:0">${H(req)}<button class="btn ghost sm">${i.activo ? 'Desactivar' : 'Activar'}</button></form></td></tr>`).join('') || '<tr><td colspan="6">Sin instructores.</td></tr>'}
    </tbody></table></div>
    <h2>Agregar o actualizar instructor</h2>
    <form class="card" method="post" action="${base(req)}/instructores">${H(req)}
      <div class="grid g4"><div class="campo"><label>Documento</label><input name="documento" type="text" inputmode="numeric" required></div><div class="campo"><label>Nombre completo</label><input name="nombre" type="text" required></div>
      <div class="campo"><label>Celular</label><input name="celular" type="tel"></div><div class="campo"><label>Correo</label><input name="correo" type="email"></div></div>
      <button class="btn">Guardar</button><span class="ayuda"> Si el documento ya existe, se actualizan sus datos.</span></form>
    <h2>Importar desde Excel</h2>
    <form class="card" method="post" action="${base(req)}/instructores/importar?_csrf=${esc(csrf(req))}" enctype="multipart/form-data">
      <p>Primera fila con los títulos: <b>Documento · Nombre · Celular · Correo</b> (celular y correo opcionales).</p>
      <div class="acciones"><input type="file" name="archivo" accept=".xlsx" required><button class="btn">Importar</button><a href="${base(req)}/instructores/modelo.xlsx">Descargar modelo de Excel</a></div></form>` });
});
const guardarInstructor = (sedeId, { documento, nombre, celular, correo }) => db.prepare(`INSERT INTO instructores (sede_id, documento, nombre, celular, correo) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(sede_id, documento) DO UPDATE SET nombre = excluded.nombre, celular = excluded.celular, correo = excluded.correo, activo = 1`).run(sedeId, documento, nombre, celular, correo);
sedeR.post('/instructores', verificarCsrf, (req, res) => {
  const documento = texto(req.body.documento, 20).replace(/\D/g, ''), nombre = texto(req.body.nombre, 100).toUpperCase();
  if (!documento || !nombre) { flash(req, 'Documento y nombre son obligatorios.', 'error'); return res.redirect(`${base(req)}/instructores`); }
  guardarInstructor(req.sede.id, { documento, nombre, celular: texto(req.body.celular, 20), correo: texto(req.body.correo, 100) });
  flash(req, `Instructor ${nombre} guardado.`); res.redirect(`${base(req)}/instructores`);
});
sedeR.post('/instructores/:id/estado', verificarCsrf, (req, res) => {
  db.prepare('UPDATE instructores SET activo = 1 - activo WHERE id = ? AND sede_id = ?').run(entero(req.params.id), req.sede.id);
  res.redirect(`${base(req)}/instructores`);
});
sedeR.get('/instructores/modelo.xlsx', async (req, res) => {
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Instructores');
  ws.columns = [{ header: 'Documento', width: 16 }, { header: 'Nombre', width: 36 }, { header: 'Celular', width: 16 }, { header: 'Correo', width: 30 }];
  ws.getRow(1).font = { bold: true };
  ws.addRow(['1098000000', 'NOMBRE APELLIDO EJEMPLO', '3000000000', 'instructor@sena.edu.co']);
  res.set('Content-Disposition', 'attachment; filename="modelo-instructores.xlsx"').type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(Buffer.from(await wb.xlsx.writeBuffer()));
});
sedeR.post('/instructores/importar', upload.single('archivo'), (req, res, next) => { req.body = { ...(req.body || {}), _csrf: req.query._csrf }; next(); }, verificarCsrf, async (req, res) => {
  if (!req.file) { flash(req, 'Elija un archivo.', 'error'); return res.redirect(`${base(req)}/instructores`); }
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(req.file.buffer); } catch { flash(req, 'No se pudo leer el archivo. Debe ser .xlsx.', 'error'); return res.redirect(`${base(req)}/instructores`); }
  const ws = wb.worksheets[0]; let n = 0, malos = 0;
  const val = (c) => { const v = c.value; if (v && typeof v === 'object') return String(v.text ?? v.result ?? ''); return String(v ?? ''); };
  db.exec('BEGIN');
  ws.eachRow((row, i) => {
    if (i === 1) return;
    const documento = val(row.getCell(1)).replace(/\D/g, '').slice(0, 20), nombre = val(row.getCell(2)).trim().toUpperCase().slice(0, 100);
    if (!documento || !nombre) { malos++; return; }
    guardarInstructor(req.sede.id, { documento, nombre, celular: val(row.getCell(3)).trim().slice(0, 20), correo: val(row.getCell(4)).trim().slice(0, 100) }); n++;
  });
  db.exec('COMMIT');
  flash(req, `Importados o actualizados: ${n}.${malos ? ` Filas omitidas por datos incompletos: ${malos}.` : ''}`); res.redirect(`${base(req)}/instructores`);
});

// ---- Usuarios del panel
sedeR.get('/usuarios', (req, res) => {
  const us = db.prepare('SELECT * FROM usuarios WHERE sede_id = ? ORDER BY activo DESC, nombre').all(req.sede.id);
  render(req, res, { title: 'Usuarios', nav: 'usuarios', sede: req.sede, body: `
    <p class="eyebrow">${esc(req.sede.nombre)}</p><h1>Usuarios del panel</h1><p class="sub">Personas que entran a este panel con usuario y contraseña. Los instructores no necesitan cuenta.</p>
    <div class="tabla"><table><thead><tr><th>Usuario</th><th>Nombre</th><th>Cargo</th><th>Estado</th><th>Nueva contraseña</th><th></th></tr></thead><tbody>
    ${us.map((u) => `<tr><td>${esc(u.usuario)}</td><td>${esc(u.nombre)}</td><td>${esc(u.cargo || '')}</td><td>${u.activo ? '<span class="badge verde">Activo</span>' : '<span class="badge gris">Inactivo</span>'}</td>
      <td><form method="post" action="${base(req)}/usuarios/${u.id}/clave" class="acciones" style="margin:0">${H(req)}<input type="password" name="password" minlength="8" required placeholder="mín. 8" style="max-width:150px"><button class="btn ghost sm">Cambiar</button></form></td>
      <td>${u.id !== req.user.id ? `<form method="post" action="${base(req)}/usuarios/${u.id}/estado" style="margin:0">${H(req)}<button class="btn ghost sm">${u.activo ? 'Desactivar' : 'Activar'}</button></form>` : '(usted)'}</td></tr>`).join('') || '<tr><td colspan="6">Sin usuarios.</td></tr>'}
    </tbody></table></div>
    <h2>Nuevo usuario</h2>
    <form class="card" method="post" action="${base(req)}/usuarios">${H(req)}
      <div class="grid g4"><div class="campo"><label>Usuario</label><input name="usuario" type="text" required pattern="[A-Za-z0-9._-]{3,40}"></div><div class="campo"><label>Nombre</label><input name="nombre" type="text" required></div>
      <div class="campo"><label>Cargo</label><input name="cargo" type="text" value="Coordinador(a)"></div><div class="campo"><label>Contraseña</label><input name="password" type="password" minlength="8" required></div></div>
      <button class="btn">Crear usuario</button></form>` });
});
sedeR.post('/usuarios', verificarCsrf, (req, res) => {
  const usuario = texto(req.body.usuario, 40), pass = String(req.body.password || '');
  if (!/^[A-Za-z0-9._-]{3,40}$/.test(usuario) || pass.length < 8 || !texto(req.body.nombre)) { flash(req, 'Revise los datos (contraseña mínimo 8 caracteres).', 'error'); return res.redirect(`${base(req)}/usuarios`); }
  try { crearUsuario({ sedeId: req.sede.id, usuario, nombre: texto(req.body.nombre, 80), cargo: texto(req.body.cargo, 80), password: pass, rol: 'sede' }); flash(req, 'Usuario creado.'); } catch { flash(req, 'Ese nombre de usuario ya existe.', 'error'); }
  res.redirect(`${base(req)}/usuarios`);
});
sedeR.post('/usuarios/:id/clave', verificarCsrf, (req, res) => {
  const pass = String(req.body.password || '');
  if (pass.length < 8) { flash(req, 'Mínimo 8 caracteres.', 'error'); return res.redirect(`${base(req)}/usuarios`); }
  db.prepare('UPDATE usuarios SET pass_hash = ? WHERE id = ? AND sede_id = ?').run(bcrypt.hashSync(pass, 10), entero(req.params.id), req.sede.id);
  flash(req, 'Contraseña actualizada.'); res.redirect(`${base(req)}/usuarios`);
});
sedeR.post('/usuarios/:id/estado', verificarCsrf, (req, res) => {
  if (entero(req.params.id) !== req.user.id) db.prepare('UPDATE usuarios SET activo = 1 - activo WHERE id = ? AND sede_id = ?').run(entero(req.params.id), req.sede.id);
  res.redirect(`${base(req)}/usuarios`);
});

// ---- Ajustes
sedeR.get('/ajustes', (req, res) => {
  const s = req.sede;
  render(req, res, { title: 'Ajustes', nav: 'ajustes', sede: s, body: `
    <p class="eyebrow">${esc(s.nombre)}</p><h1>Ajustes</h1>
    <form class="card" method="post" action="${base(req)}/ajustes">${H(req)}
      <h2 style="margin-top:0">Datos de la sede</h2>
      <div class="grid g3"><div class="campo"><label>Nombre</label><input name="nombre" type="text" value="${esc(s.nombre)}" required></div>
      <div class="campo"><label>Centro de formación</label><input name="centro" type="text" value="${esc(s.centro || '')}"></div>
      <div class="campo"><label>Regional</label><input name="regional" type="text" value="${esc(s.regional || '')}"></div></div>
      <div class="campo" style="max-width:200px"><label>Color de las tablas del PDF</label><input name="color" type="color" value="${esc(s.color || '#39A900')}"></div>
      <h2>Encabezado oficial del acta</h2>
      <div class="grid g4"><div class="campo"><label>Título</label><input name="formato_titulo" type="text" value="${esc(s.formato_titulo || '')}"></div>
      <div class="campo"><label>Código</label><input name="formato_codigo" type="text" value="${esc(s.formato_codigo || '')}"></div>
      <div class="campo"><label>Versión</label><input name="formato_version" type="text" value="${esc(s.formato_version || '')}"></div>
      <div class="campo"><label>Fecha del formato</label><input name="formato_fecha" type="date" value="${esc(s.formato_fecha || '')}"></div></div>
      <button class="btn">Guardar cambios</button></form>
    <form class="card" method="post" action="${base(req)}/ajustes/logo?_csrf=${esc(csrf(req))}" enctype="multipart/form-data">
      <h2 style="margin-top:0">Logo</h2>
      <p>Aparece en el encabezado del acta PDF y en el formulario del instructor. Use el logo oficial del SENA en PNG o JPG (fondo blanco o transparente).</p>
      ${s.logo_mime ? `<p><img src="${base(req)}/logo?v=${Date.now()}" alt="Logo actual" style="max-height:70px"></p>` : '<p class="ayuda">Sin logo cargado: se usa una marca genérica verde «SENA».</p>'}
      <div class="acciones"><input type="file" name="logo" accept="image/png,image/jpeg" required><button class="btn">Guardar logo</button></div></form>` });
});
sedeR.post('/ajustes', verificarCsrf, (req, res) => {
  const b = req.body, color = /^#[0-9a-fA-F]{6}$/.test(b.color || '') ? b.color : '#39A900';
  db.prepare('UPDATE sedes SET nombre = ?, centro = ?, regional = ?, color = ?, formato_titulo = ?, formato_codigo = ?, formato_version = ?, formato_fecha = ? WHERE id = ?')
    .run(texto(b.nombre, 80) || req.sede.nombre, texto(b.centro, 100), texto(b.regional, 100), color, texto(b.formato_titulo, 120), texto(b.formato_codigo, 40), texto(b.formato_version, 20), fechaValida(b.formato_fecha), req.sede.id);
  flash(req, 'Ajustes guardados.'); res.redirect(`${base(req)}/ajustes`);
});
sedeR.post('/ajustes/logo', upload.single('logo'), (req, res, next) => { req.body = { ...(req.body || {}), _csrf: req.query._csrf }; next(); }, verificarCsrf, (req, res) => {
  const f = req.file; const okPng = f && f.buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])); const okJpg = f && f.buffer[0] === 0xff && f.buffer[1] === 0xd8;
  if (!okPng && !okJpg) { flash(req, 'El logo debe ser PNG o JPG.', 'error'); return res.redirect(`${base(req)}/ajustes`); }
  db.prepare('UPDATE sedes SET logo = ?, logo_mime = ? WHERE id = ?').run(f.buffer, okPng ? 'image/png' : 'image/jpeg', req.sede.id);
  flash(req, 'Logo actualizado.'); res.redirect(`${base(req)}/ajustes`);
});

// ---------------------------------------------------------------- formulario público del instructor
function sedePublica(req, res) {
  const s = sedePorSlug(req.params.slug);
  if (!s || !s.activo) { res.status(404); render(req, res, { title: 'No encontrado', publico: true, status: 404, body: '<div class="card"><h1>Sede no encontrada</h1><p>Revise el enlace o el código QR.</p></div>' }); return null; }
  return s;
}
app.get('/f/:slug', (req, res) => {
  const s = sedePublica(req, res); if (!s) return;
  const ambs = db.prepare('SELECT * FROM ambientes WHERE sede_id = ? AND activo = 1 ORDER BY nombre').all(s.id);
  render(req, res, { title: 'Inventario', publico: true, sede: s, body: `
    <p class="eyebrow">${esc(s.nombre)}</p><h1>Inventario del ambiente</h1><p class="sub">${esc(fechaLarga(hoy()))}. Elija el ambiente donde va a orientar la formación.</p>
    <div class="card"><div class="grid g2">${ambs.map((a) => `<a class="btn sec" style="justify-content:center" href="/f/${esc(s.slug)}/a/${esc(a.token)}">${esc(a.nombre)}</a>`).join('') || '<p>No hay ambientes configurados.</p>'}</div></div>` });
});
app.get('/f/:slug/instructor', (req, res) => {
  if (limitar('lookup:' + req.ip, 60, 10 * 60e3)) return res.status(429).json({});
  const s = sedePorSlug(req.params.slug); if (!s) return res.json({});
  const i = db.prepare('SELECT nombre FROM instructores WHERE sede_id = ? AND documento = ? AND activo = 1').get(s.id, String(req.query.documento || '').replace(/\D/g, ''));
  res.json(i ? { nombre: enmascarar(i.nombre) } : {});
});
function ambientePublico(req, res) {
  const s = sedePublica(req, res); if (!s) return {};
  const a = db.prepare('SELECT * FROM ambientes WHERE sede_id = ? AND token = ? AND activo = 1').get(s.id, req.params.token);
  if (!a) { render(req, res, { title: 'No encontrado', publico: true, sede: s, status: 404, body: '<div class="card"><h1>Ambiente no encontrado</h1><p>Puede estar inactivo. Consulte con coordinación.</p></div>' }); return {}; }
  return { s, a };
}
app.get('/f/:slug/a/:token', (req, res) => {
  const { s, a } = ambientePublico(req, res); if (!a) return;
  const inv = S.inventarioAmbiente(a.id, s.id);
  const prev = req.session.prevInstructor || {};
  const hoyRegs = db.prepare('SELECT jornada, instructor_nombre, horario FROM registros WHERE ambiente_id = ? AND fecha = ? AND anulado = 0 ORDER BY creado').all(a.id, hoy());
  render(req, res, { title: a.nombre, publico: true, sede: s, body: `
    <p class="eyebrow">${esc(s.nombre)} · Constancia del instructor</p><h1>${esc(a.nombre)}</h1>
    <p class="sub">${esc(fechaLarga(hoy()))}${a.ubicacion ? ' · ' + esc(a.ubicacion) : ''}</p>
    ${hoyRegs.length ? `<div class="flash ok">Hoy ya se registró este ambiente: ${hoyRegs.map((r) => `${esc(r.jornada)} (${esc(enmascarar(r.instructor_nombre))})`).join(', ')}. Si usted orienta otra formación, regístrela igual.</div>` : ''}
    <form id="form-inv" method="post" action="/f/${esc(s.slug)}/a/${esc(a.token)}" data-firma>
      <div class="card">
        <h2 style="margin-top:0">1. Datos de la formación</h2>
        <div class="grid g2">
          <div class="campo" style="grid-column:1/-1"><label for="nombre">Nombre completo del instructor</label><input id="nombre" name="nombre" type="text" autocomplete="name" required minlength="5" maxlength="100" value="${esc(prev.nombre || '')}"></div>
          <div class="campo"><label for="documento">Número de documento de identidad</label><input id="documento" name="documento" type="text" inputmode="numeric" autocomplete="off" required data-url="/f/${esc(s.slug)}/instructor" value="${esc(prev.documento || '')}"><div class="ayuda" id="nombre-instructor"></div></div>
          <div class="campo"><label for="jornada">Jornada</label><select id="jornada" name="jornada" required><option value="">Elija…</option>${Object.entries(HORARIOS).map(([j, h]) => `<option value="${j}" ${jornadaActual() === j ? 'selected' : ''}>${j} (${h})</option>`).join('')}</select><div class="ayuda">El horario se asigna según la jornada.</div></div>
          <div class="campo"><label>Ficha</label><input name="ficha" type="text" inputmode="numeric" maxlength="20" value="${esc(prev.ficha || '')}"></div>
          <div class="campo" style="grid-column:1/-1"><label>Programa de formación</label><input name="programa" type="text" maxlength="150" value="${esc(prev.programa || '')}"></div>
        </div>
      </div>
      <div class="card">
        <h2 style="margin-top:0">2. Verifique el inventario</h2>
        <p class="ayuda">Cuente cada elemento y escriba la cantidad que encontró. Si falta algo, descríbalo en «Novedad». Use 0 si no hay elementos.</p>
        <p><button type="button" class="btn ghost sm" id="todo-ok">Todo está completo (copiar cantidades asignadas)</button></p>
        ${inv.map((e) => `<div class="item" data-asig="${e.asignada}"><div><div class="nom">${esc(e.nombre)}</div><div class="asig">Asignado: ${e.asignada}</div></div>
          <input type="number" name="cant_${e.id}" min="0" max="9999" inputmode="numeric" required aria-label="Cantidad ${esc(e.nombre)}"><div class="dif"></div>
          <div class="nov"><input type="text" name="nov_${e.id}" maxlength="200" placeholder="Novedad (opcional si está completo)" aria-label="Novedad ${esc(e.nombre)}"></div></div>`).join('')}
        <p id="resumen-falt" style="color:#c62828;font-weight:600"></p>
        <div class="campo"><label>Observaciones generales (opcional)</label><textarea name="observaciones" rows="2" maxlength="1000"></textarea></div>
      </div>
      <div class="card">
        <h2 style="margin-top:0">3. Firme</h2>
        <label class="check"><input type="checkbox" name="declaro" value="1" required> Declaro que verifiqué el inventario de este ambiente y que la información registrada es verdadera.</label>
        <p></p><div class="firma-box"><canvas id="firma"></canvas></div><input type="hidden" name="firma_png" id="firma_png">
        <div class="acciones" style="margin-top:10px"><button type="button" class="btn ghost sm" id="limpiar">Borrar firma</button></div>
        <p style="margin-top:16px"><button class="btn" type="submit" style="width:100%;justify-content:center;font-size:17px">Enviar inventario firmado</button></p>
      </div>
    </form><script src="/static/formulario.js"></script>` });
});
app.post('/f/:slug/a/:token', mismoOrigen, (req, res) => {
  const { s, a } = ambientePublico(req, res); if (!a) return;
  const volver = (msg) => { flash(req, msg, 'error'); res.redirect(`/f/${s.slug}/a/${a.token}`); };
  if (limitar('envio:' + req.ip, 40, 60 * 60e3)) return volver('Demasiados envíos desde este equipo. Intente más tarde.');
  const b = req.body || {};
  const documento = texto(b.documento, 20).replace(/\D/g, '');
  const nombre = texto(b.nombre, 100).replace(/\s+/g, ' ').toUpperCase();
  if (nombre.length < 5) return volver('Escriba su nombre completo.');
  if (documento.length < 5) return volver('Escriba su número de documento de identidad.');
  let ins = db.prepare('SELECT * FROM instructores WHERE sede_id = ? AND documento = ?').get(s.id, documento);
  if (ins && !ins.activo) return volver('Su documento está desactivado en esta sede. Consulte con coordinación.');
  if (!ins) {
    // Instructor nuevo: queda registrado automáticamente en el listado de la sede.
    const r = db.prepare('INSERT INTO instructores (sede_id, documento, nombre) VALUES (?, ?, ?)').run(s.id, documento, nombre);
    ins = db.prepare('SELECT * FROM instructores WHERE id = ?').get(r.lastInsertRowid);
  }
  const jornada = ['Mañana', 'Tarde', 'Noche'].includes(b.jornada) ? b.jornada : null;
  if (!jornada) return volver('Elija la jornada.');
  if (!b.declaro) return volver('Debe aceptar la declaración.');
  const firma = String(b.firma_png || '');
  if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(firma) || firma.length < 500 || firma.length > 2_000_000) return volver('Falta la firma.');
  const inv = S.inventarioAmbiente(a.id, s.id);
  const items = [];
  for (const e of inv) {
    const n = entero(b['cant_' + e.id], 0, 9999);
    if (n === null) return volver(`Falta la cantidad de «${e.nombre}».`);
    const nov = texto(b['nov_' + e.id], 200);
    if (n < e.asignada && !S.esNovedad(nov)) return volver(`Describa la novedad de «${e.nombre}»: hay faltante.`);
    items.push({ elemento_id: e.id, elemento_nombre: e.nombre, orden: e.orden, asignada: e.asignada, cantidad: n, novedad: S.esNovedad(nov) ? nov : 'Sin novedad' });
  }
  const ev = S.evaluar(items);
  const id = crypto.randomUUID();
  db.exec('BEGIN');
  try {
    db.prepare(`INSERT INTO registros (id, sede_id, ambiente_id, ambiente_nombre, fecha, jornada, horario, instructor_id, instructor_nombre, instructor_documento, ficha, programa, observaciones, firma_png, total_faltantes, total_sobrantes, total_novedades, estado, ip, user_agent, creado)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, s.id, a.id, a.nombre, hoy(), jornada, HORARIOS[jornada], ins.id, ins.nombre, ins.documento, texto(b.ficha, 20), texto(b.programa, 150), texto(b.observaciones, 1000), firma, ev.faltantes, ev.sobrantes, ev.novedades, ev.estado, req.ip, texto(req.get('user-agent'), 250), ahora());
    const insIt = db.prepare('INSERT INTO registro_items (registro_id, elemento_id, elemento_nombre, orden, asignada, cantidad, novedad) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const it of items) insIt.run(id, it.elemento_id, it.elemento_nombre, it.orden, it.asignada, it.cantidad, it.novedad);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  req.session.prevInstructor = { nombre, documento, ficha: texto(b.ficha, 20), programa: texto(b.programa, 150) };
  req.session.ultimo = id;
  res.redirect(`/f/${s.slug}/listo`);
});
app.get('/f/:slug/listo', (req, res) => {
  const s = sedePublica(req, res); if (!s) return;
  const r = req.session.ultimo && db.prepare('SELECT * FROM registros WHERE id = ? AND sede_id = ?').get(req.session.ultimo, s.id);
  if (!r) return res.redirect(`/f/${s.slug}`);
  S.conItems([r]);
  const falt = r.items.filter((i) => i.cantidad < i.asignada);
  render(req, res, { title: 'Inventario enviado', publico: true, sede: s, body: `
    <div class="card ok-grande"><div class="ic">✔</div><h1>Inventario firmado</h1>
    <p>${esc(r.ambiente_nombre)} · ${esc(r.jornada)} · ${esc(fechaLarga(r.fecha))} · ${hora(r.creado)}</p>
    <p>Código de constancia: <b>${esc(r.id.slice(0, 8).toUpperCase())}</b></p>
    ${falt.length ? `<div class="flash err" style="text-align:left">Se reportaron faltantes: ${falt.map((i) => `${esc(i.elemento_nombre)} (${i.asignada - i.cantidad})`).join(', ')}. Coordinación recibirá la alerta.</div>` : '<p class="badge verde">Inventario completo</p>'}
    <p><a class="btn sec" href="/f/${esc(s.slug)}">Registrar otro ambiente</a></p></div>` });
});

// ---------------------------------------------------------------- errores
app.use((req, res) => res.status(404).type('html').send(layout({ title: 'No encontrado', publico: true, body: '<div class="card"><h1>Página no encontrada</h1><p><a href="/">Ir al inicio</a></p></div>' })));
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(err);
  if (err instanceof multer.MulterError) return res.status(400).send('Archivo demasiado grande o inválido (máximo 3 MB).');
  res.status(500).send('Ocurrió un error. Intente de nuevo.');
});

const HOST = process.env.HOST || '127.0.0.1';
app.listen(PORT, HOST, () => console.log(`[inicio] Inventario SENA escuchando en ${HOST}:${PORT} · ${BASE_URL}`));
