'use strict';
const { db } = require('./db');

const SIN_NOV = /^\s*(sin novedad|ninguna|ok|n\/?a)?\s*$/i;
const esNovedad = (t) => !SIN_NOV.test(String(t || ''));

function evaluar(items) {
  let faltantes = 0, sobrantes = 0, novedades = 0;
  for (const it of items) {
    if (it.cantidad < it.asignada) faltantes += it.asignada - it.cantidad;
    if (it.cantidad > it.asignada) sobrantes += it.cantidad - it.asignada;
    if (esNovedad(it.novedad)) novedades++;
  }
  const estado = faltantes ? 'faltante' : sobrantes ? 'sobrante' : novedades ? 'novedad' : 'completo';
  return { faltantes, sobrantes, novedades, estado };
}

function alertaItem(it) {
  const d = it.cantidad - it.asignada;
  if (d < 0) return 'FALTANTE';
  if (d > 0) return 'SOBRANTE';
  if (esNovedad(it.novedad)) return 'NOVEDAD';
  return 'OK';
}

function elementosSede(sedeId, soloActivos = true) {
  return db.prepare(`SELECT * FROM elementos WHERE sede_id = ? ${soloActivos ? 'AND activo = 1' : ''} ORDER BY orden, id`).all(sedeId);
}

function inventarioAmbiente(ambienteId, sedeId) {
  return db.prepare(`SELECT e.id, e.nombre, e.orden, COALESCE(a.cantidad, 0) AS asignada
    FROM elementos e LEFT JOIN asignaciones a ON a.elemento_id = e.id AND a.ambiente_id = ?
    WHERE e.sede_id = ? AND e.activo = 1 ORDER BY e.orden, e.id`).all(ambienteId, sedeId);
}

function conItems(registros) {
  const q = db.prepare('SELECT * FROM registro_items WHERE registro_id = ? ORDER BY orden');
  for (const r of registros) r.items = q.all(r.id);
  return registros;
}

function registrosDelDia(sedeId, fecha, incluirAnulados = false) {
  return conItems(db.prepare(`SELECT * FROM registros WHERE sede_id = ? AND fecha = ? ${incluirAnulados ? '' : 'AND anulado = 0'}
    ORDER BY ambiente_nombre, CASE jornada WHEN 'Mañana' THEN 1 WHEN 'Tarde' THEN 2 ELSE 3 END, creado`).all(sedeId, fecha));
}

function registrosRango({ sedeId = null, desde, hasta }) {
  const params = [desde, hasta];
  let w = 'r.fecha BETWEEN ? AND ? AND r.anulado = 0';
  if (sedeId) { w += ' AND r.sede_id = ?'; params.push(sedeId); }
  return conItems(db.prepare(`SELECT r.*, s.nombre AS sede_nombre FROM registros r JOIN sedes s ON s.id = r.sede_id
    WHERE ${w} ORDER BY r.fecha, s.nombre, r.ambiente_nombre, CASE r.jornada WHEN 'Mañana' THEN 1 WHEN 'Tarde' THEN 2 ELSE 3 END, r.creado`).all(...params));
}

function ambientesSinReporte(sedeId, fecha) {
  return db.prepare(`SELECT a.* FROM ambientes a WHERE a.sede_id = ? AND a.activo = 1
    AND NOT EXISTS (SELECT 1 FROM registros r WHERE r.ambiente_id = a.id AND r.fecha = ? AND r.anulado = 0)
    ORDER BY a.nombre`).all(sedeId, fecha);
}

function diasEntre(desde, hasta) {
  const out = []; const d = new Date(desde + 'T00:00:00Z'); const h = new Date(hasta + 'T00:00:00Z');
  while (d <= h && out.length < 400) { out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}

module.exports = { evaluar, alertaItem, esNovedad, elementosSede, inventarioAmbiente, registrosDelDia, registrosRango, ambientesSinReporte, diasEntre, conItems };
