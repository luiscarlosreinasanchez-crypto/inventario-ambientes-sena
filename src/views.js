'use strict';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const MESES_L = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
function fechaCorta(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return `${d} ${MESES[m - 1]} ${y}`;
}
function fechaLarga(iso) {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  const dia = DIAS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${dia} ${d} de ${MESES_L[m - 1]} de ${y}`;
}
const hora = (iso) => (iso ? iso.slice(11, 16) : '');

function logoSena(size = 40) {
  // Marca genérica (no es el logo oficial). El logo oficial se sube en Ajustes.
  return `<svg width="${size}" height="${size}" viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="23" fill="#39A900"/><text x="24" y="29" text-anchor="middle" font-family="Work Sans,Arial,sans-serif" font-weight="700" font-size="13" fill="#fff">SENA</text></svg>`;
}

function marca(sede) {
  if (sede && sede.logo_mime) return `<img src="/s/${esc(sede.slug)}/logo" alt="Logo" class="logo-img">`;
  return logoSena(38);
}

function layout({ title, body, user, sede, nav = '', flash = '', csrf = '', publico = false }) {
  const color = (sede && sede.color) || '#39A900';
  const menu = !publico && user && sede ? `
    <nav class="side">
      <a href="/s/${esc(sede.slug)}" data-k="inicio">Inicio</a>
      <a href="/s/${esc(sede.slug)}/registros" data-k="registros">Registros</a>
      <a href="/s/${esc(sede.slug)}/actas" data-k="actas">Actas diarias</a>
      <a href="/s/${esc(sede.slug)}/sabana" data-k="sabana">Sábana Excel</a>
      <span class="sep">Configuración</span>
      <a href="/s/${esc(sede.slug)}/ambientes" data-k="ambientes">Ambientes e inventario</a>
      <a href="/s/${esc(sede.slug)}/elementos" data-k="elementos">Elementos</a>
      <a href="/s/${esc(sede.slug)}/instructores" data-k="instructores">Instructores</a>
      <a href="/s/${esc(sede.slug)}/usuarios" data-k="usuarios">Usuarios del panel</a>
      <a href="/s/${esc(sede.slug)}/ajustes" data-k="ajustes">Ajustes</a>
      ${user.rol === 'superadmin' ? '<span class="sep">Coordinación</span><a href="/admin">Panel de superadmin</a>' : ''}
    </nav>` : (!publico && user && user.rol === 'superadmin' ? `
    <nav class="side"><a href="/admin" data-k="admin">Sedes</a><a href="/admin/sabana" data-k="asabana">Sábana consolidada</a><a href="/admin/cuenta" data-k="cuenta">Mi cuenta</a></nav>` : '');
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Inventario SENA</title>
<link rel="stylesheet" href="/static/app.css">
<style>:root{--sede:${esc(color)}}</style>
</head><body class="${publico ? 'publico' : ''}" data-nav="${esc(nav)}">
<header class="top">
  <a class="brand" href="${publico ? '#' : (sede ? `/s/${esc(sede.slug)}` : '/admin')}">${marca(sede)}<span><b>Inventario de ambientes</b><small>${esc(sede ? sede.nombre : 'SENA')}${sede && sede.centro ? ' · ' + esc(sede.centro) : ''}</small></span></a>
  ${!publico && user ? `<div class="who"><span>${esc(user.nombre)}</span><form method="post" action="/logout"><input type="hidden" name="_csrf" value="${esc(csrf)}"><button class="btn ghost sm">Salir</button></form></div>` : ''}
</header>
<div class="wrap ${menu ? 'con-menu' : ''}">${menu}<main>${flash}${body}</main></div>
<footer class="pie">SENA · Servicio Nacional de Aprendizaje · Control de inventario de ambientes de formación</footer>
<script>document.querySelectorAll('nav.side a').forEach(a=>{if(a.dataset.k===document.body.dataset.nav)a.classList.add('on')});</script>
</body></html>`;
}

function flashHtml(f) {
  if (!f) return '';
  return `<div class="flash ${f.tipo === 'error' ? 'err' : 'ok'}">${esc(f.msg)}</div>`;
}

function badgeEstado(r) {
  if (r.anulado) return '<span class="badge gris">Anulado</span>';
  if (r.estado === 'faltante') return `<span class="badge rojo">Faltante (${r.total_faltantes})</span>`;
  if (r.estado === 'sobrante') return `<span class="badge ambar">Sobrante</span>`;
  if (r.estado === 'novedad') return `<span class="badge ambar">Novedad</span>`;
  return '<span class="badge verde">Completo</span>';
}

module.exports = { esc, layout, flashHtml, fechaCorta, fechaLarga, hora, badgeEstado, logoSena, MESES_L };
