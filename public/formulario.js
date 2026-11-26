(function () {
  'use strict';
  // ---------- Pad de firma ----------
  var canvas = document.getElementById('firma');
  var hidden = document.getElementById('firma_png');
  var trazado = false, dibujando = false, last = null, distancia = 0;
  function ajustar() {
    var r = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    var prev = trazado ? canvas.toDataURL() : null;
    canvas.width = r.width * dpr; canvas.height = r.height * dpr;
    var ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr); ctx.lineWidth = 2.2; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#0d1b2a';
    if (prev) { var img = new Image(); img.onload = function () { ctx.drawImage(img, 0, 0, r.width, r.height); }; img.src = prev; }
  }
  function pos(e) { var r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  if (canvas) {
    ajustar(); window.addEventListener('resize', ajustar);
    canvas.addEventListener('pointerdown', function (e) { dibujando = true; last = pos(e); canvas.setPointerCapture(e.pointerId); e.preventDefault(); });
    canvas.addEventListener('pointermove', function (e) {
      if (!dibujando) return; var p = pos(e), ctx = canvas.getContext('2d');
      ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke(); distancia += Math.hypot(p.x - last.x, p.y - last.y); last = p; trazado = distancia > 60; e.preventDefault();
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (t) { canvas.addEventListener(t, function () { dibujando = false; }); });
    document.getElementById('limpiar').addEventListener('click', function () {
      var ctx = canvas.getContext('2d'); ctx.clearRect(0, 0, canvas.width, canvas.height); trazado = false; distancia = 0; hidden.value = '';
    });
  }

  // ---------- Diferencias en vivo ----------
  function recalcular() {
    var falt = 0;
    document.querySelectorAll('.item').forEach(function (it) {
      var asig = Number(it.dataset.asig), inp = it.querySelector('input[type=number]'), dif = it.querySelector('.dif');
      if (inp.value === '') { dif.textContent = ''; it.classList.remove('falta'); return; }
      var d = Number(inp.value) - asig;
      if (d < 0) { dif.textContent = 'Faltan ' + (-d); dif.style.color = '#c62828'; it.classList.add('falta'); falt += -d; }
      else if (d > 0) { dif.textContent = 'Sobran ' + d; dif.style.color = '#a86b00'; it.classList.remove('falta'); }
      else { dif.textContent = 'OK'; dif.style.color = '#2d8500'; it.classList.remove('falta'); }
    });
    var res = document.getElementById('resumen-falt');
    if (res) res.textContent = falt ? ('Atención: hay ' + falt + ' elemento(s) faltante(s). Describa la novedad en cada uno.') : '';
  }
  document.querySelectorAll('.item input[type=number]').forEach(function (i) { i.addEventListener('input', recalcular); });
  var todoOk = document.getElementById('todo-ok');
  if (todoOk) todoOk.addEventListener('click', function () {
    document.querySelectorAll('.item').forEach(function (it) { it.querySelector('input[type=number]').value = it.dataset.asig; });
    recalcular();
  });
  recalcular();

  // ---------- Búsqueda de instructor ----------
  var doc = document.getElementById('documento'), nom = document.getElementById('nombre-instructor');
  if (doc && nom) {
    var t;
    doc.addEventListener('input', function () {
      clearTimeout(t); nom.textContent = '';
      var v = doc.value.replace(/\D/g, ''); if (v.length < 5) return;
      t = setTimeout(function () {
        fetch(doc.dataset.url + '?documento=' + encodeURIComponent(v)).then(function (r) { return r.json(); }).then(function (j) {
          nom.textContent = j.nombre ? ('✔ Registrado en la sede como ' + j.nombre) : 'Documento nuevo en esta sede: quedará registrado con el nombre que escribió.';
          nom.style.color = j.nombre ? '#2d8500' : '#5f6b73';
        }).catch(function () {});
      }, 350);
    });
  }

  // ---------- Envío ----------
  var form = document.querySelector('form[data-firma]');
  if (form) form.addEventListener('submit', function (e) {
    if (canvas) {
      if (!trazado) { e.preventDefault(); alert('Falta su firma (o es demasiado corta). Firme dentro del recuadro.'); return; }
      hidden.value = canvas.toDataURL('image/png');
    }
    var faltSinNov = false;
    document.querySelectorAll('.item').forEach(function (it) {
      var inp = it.querySelector('input[type=number]'), nov = it.querySelector('input[type=text]');
      if (inp.value !== '' && Number(inp.value) < Number(it.dataset.asig) && (!nov.value.trim() || /^sin novedad$/i.test(nov.value.trim()))) faltSinNov = true;
    });
    if (faltSinNov) { e.preventDefault(); alert('Hay elementos faltantes sin descripción de la novedad. Explique qué pasó en cada uno.'); return; }
    form.querySelector('button[type=submit]').disabled = true;
  });
})();
