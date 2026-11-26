'use strict';
const ExcelJS = require('exceljs');
const { alertaItem, ambientesSinReporte, diasEntre } = require('./servicios');
const { ahora } = require('./db');

const VERDE = 'FF39A900', AZUL = 'FF00304D', ROJO_F = 'FFFDECEA', ROJO = 'FFC62828', AMBAR_F = 'FFFFF4DC', VERDE_F = 'FFEAF6E2';

function cabecera(ws, cols) {
  ws.columns = cols.map((c) => ({ header: c.h, key: c.k, width: c.w || 14, style: c.style || {} }));
  const row = ws.getRow(1);
  row.height = 30;
  row.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: AZUL } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = { bottom: { style: 'medium', color: { argb: VERDE } } };
  });
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
}

const fechaExcel = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };

/**
 * Sábana de inventario con alertas.
 * @returns {Promise<Buffer>}
 */
async function sabanaXlsx({ registros, desde, hasta, sedes }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Inventario de ambientes SENA'; wb.created = new Date();

  // ---------- Hoja 1: Resumen ----------
  const res = wb.addWorksheet('Resumen', { properties: { tabColor: { argb: VERDE } } });
  res.getColumn(1).width = 38; res.getColumn(2).width = 18;
  res.mergeCells('A1:D1');
  res.getCell('A1').value = 'SÁBANA DE INVENTARIO DE AMBIENTES – SENA';
  res.getCell('A1').font = { bold: true, size: 15, color: { argb: AZUL } };
  res.getCell('A2').value = `Periodo: ${desde} a ${hasta}`;
  res.getCell('A3').value = `Sedes: ${sedes.map((s) => s.nombre).join(', ')}`;
  res.getCell('A4').value = 'Generado (hora Colombia):'; res.getCell('B4').value = ahora().replace('T', ' ');

  // ---------- Hoja 2: Sábana (una fila por elemento verificado) ----------
  const ws = wb.addWorksheet('Sábana', { properties: { tabColor: { argb: AZUL } } });
  cabecera(ws, [
    { h: 'Fecha', k: 'fecha', w: 12, style: { numFmt: 'dd/mm/yyyy' } }, { h: 'Sede', k: 'sede', w: 18 }, { h: 'Ambiente', k: 'ambiente', w: 22 },
    { h: 'Jornada', k: 'jornada', w: 10 }, { h: 'Horario', k: 'horario', w: 13 }, { h: 'Instructor', k: 'instructor', w: 26 },
    { h: 'Documento', k: 'documento', w: 13 }, { h: 'Ficha', k: 'ficha', w: 11 }, { h: 'Programa', k: 'programa', w: 26 },
    { h: 'Elemento', k: 'elemento', w: 28 }, { h: 'Cant. asignada', k: 'asignada', w: 11 }, { h: 'Cant. verificada', k: 'cantidad', w: 11 },
    { h: 'Diferencia', k: 'dif', w: 11 }, { h: 'Novedad', k: 'novedad', w: 34 }, { h: 'Alerta', k: 'alerta', w: 12 },
    { h: 'Firmado', k: 'firmado', w: 17, style: { numFmt: 'dd/mm/yyyy hh:mm' } }, { h: 'Id registro', k: 'id', w: 12 },
  ]);
  let n = 1;
  for (const r of registros) {
    for (const it of r.items) {
      n++;
      ws.addRow({
        fecha: fechaExcel(r.fecha), sede: r.sede_nombre, ambiente: r.ambiente_nombre, jornada: r.jornada, horario: r.horario,
        instructor: r.instructor_nombre, documento: r.instructor_documento, ficha: r.ficha, programa: r.programa,
        elemento: it.elemento_nombre, asignada: it.asignada, cantidad: it.cantidad,
        dif: { formula: `L${n}-K${n}`, result: it.cantidad - it.asignada },
        novedad: it.novedad,
        alerta: { formula: `IF(M${n}<0,"FALTANTE",IF(M${n}>0,"SOBRANTE",IF(OR(N${n}="",LOWER(N${n})="sin novedad"),"OK","NOVEDAD")))`, result: alertaItem(it) },
        firmado: new Date(r.creado + 'Z'), id: r.id.slice(0, 8),
      });
    }
  }
  const ult = Math.max(n, 2);
  ws.addConditionalFormatting({ ref: `A2:Q${ult}`, rules: [
    { type: 'expression', priority: 1, formulae: ['$M2<0'], style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: ROJO_F } }, font: { color: { argb: ROJO } } } },
    { type: 'expression', priority: 2, formulae: ['$M2>0'], style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: AMBAR_F } } } },
    { type: 'expression', priority: 3, formulae: ['$O2="NOVEDAD"'], style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: AMBAR_F } } } },
  ] });
  ws.addConditionalFormatting({ ref: `O2:O${ult}`, rules: [
    { type: 'cellIs', operator: 'equal', priority: 4, formulae: ['"OK"'], style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: VERDE_F } }, font: { color: { argb: 'FF2D8500' }, bold: true } } },
    { type: 'cellIs', operator: 'equal', priority: 5, formulae: ['"FALTANTE"'], style: { font: { color: { argb: ROJO }, bold: true } } },
  ] });

  // ---------- Hoja 3: Por registro (formato ancho, como la planilla) ----------
  const nombresEl = [];
  for (const r of registros) for (const it of r.items) if (!nombresEl.includes(it.elemento_nombre)) nombresEl.push(it.elemento_nombre);
  const wr = wb.addWorksheet('Por registro');
  const colsR = [
    { h: 'Fecha', k: 'fecha', w: 12, style: { numFmt: 'dd/mm/yyyy' } }, { h: 'Sede', k: 'sede', w: 16 }, { h: 'Ambiente', k: 'ambiente', w: 20 },
    { h: 'Jornada', k: 'jornada', w: 10 }, { h: 'Instructor', k: 'instructor', w: 24 }, { h: 'Ficha', k: 'ficha', w: 10 },
    ...nombresEl.map((e, i) => ({ h: e, k: 'e' + i, w: 11 })),
    { h: 'Unidades faltantes', k: 'falt', w: 12 }, { h: 'Estado', k: 'estado', w: 12 },
  ];
  cabecera(wr, colsR);
  const primeraEl = 7, ultimaEl = 6 + nombresEl.length;
  for (const r of registros) {
    const row = { fecha: fechaExcel(r.fecha), sede: r.sede_nombre, ambiente: r.ambiente_nombre, jornada: r.jornada, instructor: r.instructor_nombre, ficha: r.ficha, falt: r.total_faltantes, estado: r.estado.toUpperCase() };
    const added = wr.addRow(row);
    r.items.forEach((it) => {
      const i = nombresEl.indexOf(it.elemento_nombre);
      const cell = added.getCell(primeraEl + i);
      cell.value = it.cantidad;
      const d = it.cantidad - it.asignada;
      if (d !== 0 || it.novedad) cell.note = `Asignada: ${it.asignada} · Verificada: ${it.cantidad}${it.novedad ? ' · ' + it.novedad : ''}`;
      if (d < 0) { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ROJO_F } }; cell.font = { color: { argb: ROJO }, bold: true }; }
      else if (d > 0) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: AMBAR_F } };
    });
  }
  if (nombresEl.length) {
    const lastRow = Math.max(wr.rowCount, 2);
    const colLetra = (c) => wr.getColumn(c).letter;
    wr.addConditionalFormatting({ ref: `${colLetra(ultimaEl + 1)}2:${colLetra(ultimaEl + 1)}${lastRow}`, rules: [
      { type: 'cellIs', operator: 'greaterThan', priority: 1, formulae: ['0'], style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: ROJO_F } }, font: { color: { argb: ROJO }, bold: true } } },
    ] });
  }

  // ---------- Hoja 4: Alertas ----------
  const wa = wb.addWorksheet('Alertas', { properties: { tabColor: { argb: ROJO } } });
  cabecera(wa, [
    { h: 'Fecha', k: 'fecha', w: 12, style: { numFmt: 'dd/mm/yyyy' } }, { h: 'Sede', k: 'sede', w: 18 }, { h: 'Ambiente', k: 'ambiente', w: 22 },
    { h: 'Jornada', k: 'jornada', w: 10 }, { h: 'Instructor', k: 'instructor', w: 26 }, { h: 'Elemento', k: 'elemento', w: 28 },
    { h: 'Asignada', k: 'asignada', w: 10 }, { h: 'Verificada', k: 'cantidad', w: 10 }, { h: 'Diferencia', k: 'dif', w: 10 },
    { h: 'Tipo de alerta', k: 'alerta', w: 14 }, { h: 'Novedad reportada', k: 'novedad', w: 40 },
  ]);
  let nAl = 0;
  for (const r of registros) for (const it of r.items) {
    const al = alertaItem(it); if (al === 'OK') continue;
    nAl++;
    const row = wa.addRow({ fecha: fechaExcel(r.fecha), sede: r.sede_nombre, ambiente: r.ambiente_nombre, jornada: r.jornada, instructor: r.instructor_nombre, elemento: it.elemento_nombre, asignada: it.asignada, cantidad: it.cantidad, dif: it.cantidad - it.asignada, alerta: al, novedad: it.novedad });
    row.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: al === 'FALTANTE' ? ROJO_F : AMBAR_F } }; });
    row.getCell('alerta').font = { bold: true, color: { argb: al === 'FALTANTE' ? ROJO : 'FFA86B00' } };
  }

  // ---------- Hoja 5: Ambientes sin reporte ----------
  const wsr = wb.addWorksheet('Sin reporte', { properties: { tabColor: { argb: 'FFA86B00' } } });
  cabecera(wsr, [{ h: 'Fecha', k: 'fecha', w: 12, style: { numFmt: 'dd/mm/yyyy' } }, { h: 'Sede', k: 'sede', w: 20 }, { h: 'Ambiente sin inventario firmado', k: 'ambiente', w: 34 }, { h: 'Ubicación', k: 'ubicacion', w: 24 }]);
  let nSin = 0;
  const dias = diasEntre(desde, hasta);
  for (const s of sedes) for (const d of dias) {
    // Solo días hábiles (lunes a sábado) para no inflar alertas de domingos.
    if (new Date(d + 'T00:00:00Z').getUTCDay() === 0) continue;
    for (const a of ambientesSinReporte(s.id, d)) { wsr.addRow({ fecha: fechaExcel(d), sede: s.nombre, ambiente: a.nombre, ubicacion: a.ubicacion }); nSin++; }
  }

  // ---------- Indicadores en Resumen ----------
  const totFalt = registros.reduce((a, r) => a + r.total_faltantes, 0);
  const kpis = [
    ['Registros firmados', registros.length],
    ['Registros con faltantes', registros.filter((r) => r.total_faltantes > 0).length],
    ['Unidades faltantes', totFalt],
    ['Ítems con alerta (faltante, sobrante o novedad)', nAl],
    ['Ambiente-día sin reporte (lunes a sábado)', nSin],
  ];
  kpis.forEach(([k, v], i) => {
    const r = 6 + i;
    res.getCell(`A${r}`).value = k; res.getCell(`B${r}`).value = v;
    res.getCell(`A${r}`).border = res.getCell(`B${r}`).border = { bottom: { style: 'thin', color: { argb: 'FFDDDDDD' } } };
    res.getCell(`B${r}`).font = { bold: true, size: 13, color: { argb: v > 0 && i > 0 ? ROJO : AZUL } };
  });
  res.getCell('A12').value = 'Faltantes por elemento'; res.getCell('A12').font = { bold: true, color: { argb: AZUL } };
  const porEl = {};
  for (const r of registros) for (const it of r.items) if (it.cantidad < it.asignada) porEl[it.elemento_nombre] = (porEl[it.elemento_nombre] || 0) + (it.asignada - it.cantidad);
  const filasEl = Object.entries(porEl).sort((a, b) => b[1] - a[1]);
  if (!filasEl.length) res.getCell('A13').value = 'Sin faltantes en el periodo.';
  filasEl.forEach(([e, v], i) => { res.getCell(`A${13 + i}`).value = e; res.getCell(`B${13 + i}`).value = v; res.getCell(`B${13 + i}`).font = { bold: true, color: { argb: ROJO } }; });
  const base = 14 + Math.max(filasEl.length, 1);
  res.getCell(`A${base}`).value = 'Cómo leer este libro'; res.getCell(`A${base}`).font = { bold: true, color: { argb: AZUL } };
  [
    'Sábana: una fila por elemento verificado. Rojo = faltante, ámbar = sobrante o novedad. Use los filtros de la fila 1.',
    'Por registro: una fila por formación firmada, con la cantidad verificada de cada elemento (comentario con el detalle).',
    'Alertas: solo los elementos con faltante, sobrante o novedad descrita por el instructor.',
    'Sin reporte: ambientes activos que no tienen inventario firmado en un día hábil (lunes a sábado).',
  ].forEach((t, i) => { res.getCell(`A${base + 1 + i}`).value = '• ' + t; });

  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = { sabanaXlsx };
