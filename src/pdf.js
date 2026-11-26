'use strict';
const PDFDocument = require('pdfkit');
const { fechaLarga, fechaCorta } = require('./views');
const { alertaItem } = require('./servicios');

const VERDE = '#39A900', AZUL = '#00304D', ROJO = '#C62828', AMBAR = '#A86B00', GRIS = '#5F6B73';

function imgBuffer(dataUrl) {
  const m = /^data:image\/(png|jpe?g);base64,(.+)$/.exec(dataUrl || '');
  return m ? Buffer.from(m[2], 'base64') : null;
}

/**
 * Acta diaria de inventario por sede.
 * @returns {Promise<Buffer>}
 */
function actaPdf({ sede, fecha, registros, sinReporte, acta, totalAmbientes }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margins: { top: 40, bottom: 50, left: 40, right: 40 }, bufferPages: true, info: { Title: `Acta inventario ${sede.nombre} ${fecha}`, Author: 'SENA' } });
    const chunks = []; doc.on('data', (c) => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    const W = doc.page.width - 80, X = 40;
    const color = sede.color || VERDE;

    // ---------- Encabezado (formato oficial) ----------
    function encabezado() {
      const y = 40, h = 60;
      doc.lineWidth(0.8).strokeColor('#999');
      doc.rect(X, y, 110, h).stroke(); doc.rect(X + 110, y, W - 230, h).stroke(); doc.rect(X + W - 120, y, 120, h).stroke();
      if (sede.logo && /png|jpe?g/.test(sede.logo_mime || '')) {
        try { doc.image(Buffer.from(sede.logo), X + 8, y + 6, { fit: [94, 48], align: 'center', valign: 'center' }); } catch { /* logo inválido */ }
      } else {
        doc.circle(X + 55, y + 30, 22).fill(VERDE);
        doc.fillColor('#fff').font('Helvetica-Bold').fontSize(11).text('SENA', X + 33, y + 25, { width: 44, align: 'center' });
      }
      doc.fillColor(AZUL).font('Helvetica-Bold').fontSize(12).text(sede.formato_titulo || 'ACTA DIARIA DE INVENTARIO DE AMBIENTES', X + 118, y + 12, { width: W - 246, align: 'center' });
      doc.fillColor(GRIS).font('Helvetica').fontSize(8.5).text(`${sede.regional || ''} · ${sede.centro || ''} · ${sede.nombre}`, X + 118, y + 38, { width: W - 246, align: 'center' });
      doc.fillColor('#000').fontSize(8.5)
        .text(`Código: ${sede.formato_codigo || ''}`, X + W - 114, y + 8)
        .text(`Versión: ${sede.formato_version || ''}`, X + W - 114, y + 24)
        .text(`Fecha: ${sede.formato_fecha ? fechaCorta(sede.formato_fecha) : ''}`, X + W - 114, y + 40);
      doc.y = y + h + 12; doc.x = X;
    }
    encabezado();
    doc.on('pageAdded', () => { encabezado(); });

    // ---------- Datos generales ----------
    const falt = registros.reduce((a, r) => a + r.total_faltantes, 0);
    const conFalt = registros.filter((r) => r.total_faltantes > 0).length;
    const reportados = totalAmbientes - sinReporte.length;
    doc.font('Helvetica-Bold').fontSize(10).fillColor(AZUL).text(`Fecha del acta: `, { continued: true }).font('Helvetica').fillColor('#000').text(fechaLarga(fecha));
    doc.moveDown(0.3);
    const resumen = [
      ['Ambientes activos', totalAmbientes], ['Ambientes con reporte', reportados], ['Ambientes sin reporte', sinReporte.length],
      ['Registros firmados', registros.length], ['Registros con faltantes', conFalt], ['Unidades faltantes', falt],
    ];
    const cw = W / 6, ry = doc.y;
    resumen.forEach(([k, v], i) => {
      const alerta = (i === 2 || i >= 4) && v > 0;
      doc.rect(X + i * cw, ry, cw, 38).fillAndStroke(alerta ? '#FDECEA' : '#F2F7EE', '#cfd8cc');
      doc.fillColor(alerta ? ROJO : AZUL).font('Helvetica-Bold').fontSize(15).text(String(v), X + i * cw, ry + 5, { width: cw, align: 'center' });
      doc.fillColor(GRIS).font('Helvetica').fontSize(7).text(k.toUpperCase(), X + i * cw + 2, ry + 25, { width: cw - 4, align: 'center' });
    });
    doc.y = ry + 50; doc.x = X;

    if (sinReporte.length) {
      doc.fillColor(ROJO).font('Helvetica-Bold').fontSize(9.5).text('ALERTA – Ambientes sin inventario firmado este día: ', { continued: true })
        .font('Helvetica').text(sinReporte.map((a) => a.nombre).join(', '));
      doc.moveDown(0.6);
    }
    if (!registros.length) {
      doc.fillColor(GRIS).font('Helvetica-Oblique').fontSize(10).text('No se registraron inventarios firmados en esta fecha.');
    }

    // ---------- Un bloque por registro ----------
    const cols = [{ t: 'Elemento', w: 0.36 }, { t: 'Asignada', w: 0.1 }, { t: 'Verificada', w: 0.1 }, { t: 'Dif.', w: 0.08 }, { t: 'Novedad', w: 0.36 }];
    registros.forEach((r, idx) => {
      const alto = 36 + 14 * (r.items.length + 1) + 92 + (r.observaciones ? 20 : 0);
      if (doc.y + alto > doc.page.height - 60) doc.addPage();
      const y0 = doc.y;
      doc.rect(X, y0, W, 18).fill(color);
      doc.fillColor('#fff').font('Helvetica-Bold').fontSize(9.5)
        .text(`${idx + 1}. ${r.ambiente_nombre}  ·  Jornada ${r.jornada}${r.horario ? ' (' + r.horario + ')' : ''}`, X + 6, y0 + 5, { width: W - 140 });
      doc.font('Helvetica').fontSize(8).text(r.total_faltantes ? `FALTANTES: ${r.total_faltantes}` : r.estado === 'completo' ? 'COMPLETO' : r.estado.toUpperCase(), X + W - 130, y0 + 5, { width: 124, align: 'right' });
      doc.fillColor('#000').font('Helvetica').fontSize(8.5);
      const info = `Instructor: ${r.instructor_nombre} (C.C. ${r.instructor_documento})   Ficha: ${r.ficha || '—'}   Programa: ${r.programa || '—'}`;
      doc.text(info, X + 4, y0 + 22, { width: W - 8 });
      let y = doc.y + 4;
      // cabecera tabla
      let cx = X;
      doc.rect(X, y, W, 14).fill('#EEF3EA');
      doc.fillColor(AZUL).font('Helvetica-Bold').fontSize(7.5);
      cols.forEach((c) => { doc.text(c.t.toUpperCase(), cx + 3, y + 4, { width: c.w * W - 6, align: c.t === 'Elemento' || c.t === 'Novedad' ? 'left' : 'right' }); cx += c.w * W; });
      y += 14;
      doc.font('Helvetica').fontSize(8);
      for (const it of r.items) {
        const al = alertaItem(it); const d = it.cantidad - it.asignada;
        if (al === 'FALTANTE') doc.rect(X, y, W, 14).fill('#FDECEA');
        else if (al === 'SOBRANTE' || al === 'NOVEDAD') doc.rect(X, y, W, 14).fill('#FFF4DC');
        cx = X;
        const vals = [it.elemento_nombre, it.asignada, it.cantidad, d > 0 ? '+' + d : d, it.novedad];
        vals.forEach((v, i) => {
          doc.fillColor(i === 3 && d < 0 ? ROJO : i === 3 && d > 0 ? AMBAR : '#000').font(i === 3 && d !== 0 ? 'Helvetica-Bold' : 'Helvetica')
            .text(String(v), cx + 3, y + 3.5, { width: cols[i].w * W - 6, height: 10, ellipsis: true, lineBreak: false, align: i === 0 || i === 4 ? 'left' : 'right' });
          cx += cols[i].w * W;
        });
        doc.moveTo(X, y + 14).lineTo(X + W, y + 14).lineWidth(0.3).strokeColor('#ddd').stroke();
        y += 14;
      }
      y += 6;
      if (r.observaciones) {
        doc.fillColor('#000').font('Helvetica-Bold').fontSize(8).text('Observaciones: ', X + 4, y, { continued: true }).font('Helvetica').text(r.observaciones, { width: W - 8 });
        y = doc.y + 4;
      }
      // firma
      const firma = imgBuffer(r.firma_png);
      if (firma) { try { doc.image(firma, X + 4, y, { fit: [170, 50] }); } catch { /* firma ilegible */ } }
      doc.moveTo(X + 4, y + 52).lineTo(X + 200, y + 52).lineWidth(0.6).strokeColor('#555').stroke();
      doc.fillColor(GRIS).font('Helvetica').fontSize(7.5)
        .text(`Firma del instructor: ${r.instructor_nombre}`, X + 4, y + 55, { width: 260 })
        .text(`Firmado electrónicamente el ${fechaCorta(r.creado)} a las ${r.creado.slice(11, 16)} · Registro ${r.id.slice(0, 8)}`, X + 4, y + 65, { width: 360 });
      doc.y = y + 86; doc.x = X;
    });

    // ---------- Cierre del acta ----------
    if (doc.y + 130 > doc.page.height - 60) doc.addPage();
    doc.moveDown(0.5);
    doc.fillColor(AZUL).font('Helvetica-Bold').fontSize(10).text('CONSTANCIA DE COORDINACIÓN', X);
    doc.fillColor('#000').font('Helvetica').fontSize(8.5).text(
      'Con base en los registros firmados electrónicamente por los instructores, se consolida el inventario de los ambientes de formación de la sede para la fecha indicada. ' +
      'Los faltantes y novedades aquí reportados deben ser gestionados conforme al procedimiento de bienes del SENA.', X, doc.y + 2, { width: W });
    if (acta && acta.observaciones) { doc.moveDown(0.4).font('Helvetica-Bold').text('Observaciones de coordinación: ', { continued: true }).font('Helvetica').text(acta.observaciones); }
    const yF = doc.y + 10;
    const f = acta && imgBuffer(acta.firma_png);
    if (f) { try { doc.image(f, X + 4, yF, { fit: [180, 55] }); } catch { /* */ } }
    doc.moveTo(X + 4, yF + 58).lineTo(X + 230, yF + 58).lineWidth(0.6).strokeColor('#555').stroke();
    doc.fillColor('#000').fontSize(8.5).text(acta && acta.firmado_por ? acta.firmado_por : 'Nombre y firma de coordinación', X + 4, yF + 62)
      .fillColor(GRIS).fontSize(7.5).text(acta && acta.firmado_en ? `${acta.cargo || ''} · Firmado el ${fechaCorta(acta.firmado_en)} ${acta.firmado_en.slice(11, 16)}` : 'Pendiente de firma', X + 4, yF + 74);

    // ---------- Paginación ----------
    const rango = doc.bufferedPageRange();
    for (let i = 0; i < rango.count; i++) {
      doc.switchToPage(i);
      const old = doc.page.margins.bottom; doc.page.margins.bottom = 0;
      doc.fillColor(GRIS).font('Helvetica').fontSize(7.5).text(`${sede.nombre} · Acta ${fecha} · Página ${i + 1} de ${rango.count}`, X, doc.page.height - 32, { width: W, align: 'center' });
      doc.page.margins.bottom = old;
    }
    doc.end();
  });
}

module.exports = { actaPdf };
