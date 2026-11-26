'use strict';
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'inventario.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS sedes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  centro TEXT DEFAULT 'Centro Agroturístico',
  regional TEXT DEFAULT 'Regional Santander',
  color TEXT DEFAULT '#39A900',
  logo_mime TEXT,
  logo BLOB,
  formato_codigo TEXT DEFAULT 'FR-INV-01',
  formato_version TEXT DEFAULT '1',
  formato_fecha TEXT,
  formato_titulo TEXT DEFAULT 'ACTA DIARIA DE INVENTARIO DE AMBIENTES',
  activo INTEGER DEFAULT 1,
  creado TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS usuarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sede_id INTEGER REFERENCES sedes(id) ON DELETE CASCADE,
  usuario TEXT NOT NULL UNIQUE COLLATE NOCASE,
  nombre TEXT NOT NULL,
  cargo TEXT DEFAULT 'Coordinador(a)',
  pass_hash TEXT NOT NULL,
  rol TEXT NOT NULL CHECK (rol IN ('superadmin','sede')),
  activo INTEGER DEFAULT 1,
  creado TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS elementos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sede_id INTEGER NOT NULL REFERENCES sedes(id) ON DELETE CASCADE,
  nombre TEXT NOT NULL,
  orden INTEGER DEFAULT 0,
  activo INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS ambientes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sede_id INTEGER NOT NULL REFERENCES sedes(id) ON DELETE CASCADE,
  nombre TEXT NOT NULL,
  ubicacion TEXT,
  token TEXT NOT NULL UNIQUE,
  fecha_base TEXT,
  activo INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS asignaciones (
  ambiente_id INTEGER NOT NULL REFERENCES ambientes(id) ON DELETE CASCADE,
  elemento_id INTEGER NOT NULL REFERENCES elementos(id) ON DELETE CASCADE,
  cantidad INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ambiente_id, elemento_id)
);
CREATE TABLE IF NOT EXISTS instructores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sede_id INTEGER NOT NULL REFERENCES sedes(id) ON DELETE CASCADE,
  documento TEXT NOT NULL,
  nombre TEXT NOT NULL,
  celular TEXT,
  correo TEXT,
  activo INTEGER DEFAULT 1,
  UNIQUE (sede_id, documento)
);
CREATE TABLE IF NOT EXISTS registros (
  id TEXT PRIMARY KEY,
  sede_id INTEGER NOT NULL REFERENCES sedes(id) ON DELETE CASCADE,
  ambiente_id INTEGER NOT NULL REFERENCES ambientes(id),
  ambiente_nombre TEXT NOT NULL,
  fecha TEXT NOT NULL,
  jornada TEXT NOT NULL,
  horario TEXT,
  instructor_id INTEGER REFERENCES instructores(id),
  instructor_nombre TEXT NOT NULL,
  instructor_documento TEXT NOT NULL,
  ficha TEXT,
  programa TEXT,
  observaciones TEXT,
  firma_png TEXT NOT NULL,
  total_faltantes INTEGER DEFAULT 0,
  total_sobrantes INTEGER DEFAULT 0,
  total_novedades INTEGER DEFAULT 0,
  estado TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  anulado INTEGER DEFAULT 0,
  anulado_motivo TEXT,
  creado TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reg_sede_fecha ON registros(sede_id, fecha);
CREATE TABLE IF NOT EXISTS registro_items (
  registro_id TEXT NOT NULL REFERENCES registros(id) ON DELETE CASCADE,
  elemento_id INTEGER,
  elemento_nombre TEXT NOT NULL,
  orden INTEGER DEFAULT 0,
  asignada INTEGER NOT NULL,
  cantidad INTEGER NOT NULL,
  novedad TEXT NOT NULL DEFAULT 'Sin novedad'
);
CREATE INDEX IF NOT EXISTS idx_items_reg ON registro_items(registro_id);
CREATE TABLE IF NOT EXISTS actas (
  sede_id INTEGER NOT NULL REFERENCES sedes(id) ON DELETE CASCADE,
  fecha TEXT NOT NULL,
  firmado_por TEXT,
  cargo TEXT,
  firma_png TEXT,
  observaciones TEXT,
  firmado_en TEXT,
  PRIMARY KEY (sede_id, fecha)
);
`);

const ELEMENTOS_BASE = [
  'Computadores / equipos de cómputo', 'Cargadores', 'Mouse', 'Maletas', 'Ventiladores',
  'Sillas', 'Mesas', 'Lockers', 'Televisor', 'Control remoto de TV', 'Aire acondicionado',
];

function slugify(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}
const token = (n = 9) => crypto.randomBytes(n).toString('base64url');
const randomPassword = () => crypto.randomBytes(9).toString('base64url');

function crearSede({ nombre, slug }) {
  slug = slugify(slug || nombre);
  if (!nombre || !slug) throw new Error('Nombre de sede inválido');
  if (['admin', 'login', 'logout', 'f', 's', 'static', 'api', 'salud'].includes(slug)) throw new Error('Esa dirección está reservada');
  const r = db.prepare('INSERT INTO sedes (nombre, slug, formato_fecha) VALUES (?, ?, ?)').run(nombre.trim(), slug, hoy());
  const sedeId = Number(r.lastInsertRowid);
  const ins = db.prepare('INSERT INTO elementos (sede_id, nombre, orden) VALUES (?, ?, ?)');
  ELEMENTOS_BASE.forEach((e, i) => ins.run(sedeId, e, i + 1));
  return sedeId;
}

function crearUsuario({ sedeId = null, usuario, nombre, cargo, password, rol }) {
  const hash = bcrypt.hashSync(password, 10);
  return db.prepare('INSERT INTO usuarios (sede_id, usuario, nombre, cargo, pass_hash, rol) VALUES (?, ?, ?, ?, ?, ?)')
    .run(sedeId, usuario.trim(), nombre.trim(), cargo || 'Coordinador(a)', hash, rol);
}

function hoy() {
  // Fecha de hoy en Colombia (YYYY-MM-DD)
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function ahora() {
  const f = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date());
  return f.replace(' ', 'T');
}

/**
 * Primer arranque: superadmin + 3 sedes iniciales con su usuario.
 * Las contraseñas se toman de variables de entorno o se generan y se
 * escriben UNA vez en DATA_DIR/credenciales-iniciales.txt (solo en el servidor).
 */
function seed() {
  const hay = db.prepare('SELECT COUNT(*) n FROM usuarios').get().n;
  if (hay > 0) return null;
  const lineas = [];
  const adminUser = process.env.ADMIN_USER || 'admin';
  const adminPass = process.env.ADMIN_PASSWORD || randomPassword();
  crearUsuario({ usuario: adminUser, nombre: process.env.ADMIN_NAME || 'Coordinación', cargo: 'Coordinador académico', password: adminPass, rol: 'superadmin' });
  lineas.push(`SUPERADMIN  usuario: ${adminUser}  contraseña: ${adminPass}`);
  const iniciales = [
    { nombre: 'Sede Principal', slug: 'principal', usuario: 'principal' },
    { nombre: 'Sede Unisangil', slug: 'unisangil', usuario: 'unisangil' },
    { nombre: 'Sede Confines', slug: 'confines', usuario: 'confines' },
  ];
  for (const s of iniciales) {
    const id = crearSede(s);
    const pass = process.env[`PASS_${s.usuario.toUpperCase()}`] || randomPassword();
    crearUsuario({ sedeId: id, usuario: s.usuario, nombre: `Coordinación ${s.nombre}`, password: pass, rol: 'sede' });
    lineas.push(`${s.nombre.padEnd(15)} usuario: ${s.usuario}  contraseña: ${pass}`);
  }
  const archivo = path.join(DATA_DIR, 'credenciales-iniciales.txt');
  fs.writeFileSync(archivo, `Credenciales iniciales (${ahora()}). Cámbielas al entrar y borre este archivo.\n${lineas.join('\n')}\n`, { mode: 0o600 });
  return archivo;
}

module.exports = { db, seed, crearSede, crearUsuario, slugify, token, randomPassword, hoy, ahora, ELEMENTOS_BASE, DATA_DIR };
