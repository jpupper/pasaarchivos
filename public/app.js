'use strict';

/* PASAARCHIVOS — cliente */

const $ = (sel) => document.querySelector(sel);

const elZona = $('#zona');
const elInput = $('#input');
const elCola = $('#cola');
const elLista = $('#archivos');
const elVacio = $('#vacio');
const elStatus = $('#status');
const elBuscar = $('#buscar');
const elConteo = $('#conteo');
const elIp = $('#ip-servidor');
const elDisco = $('#disco-libre');
const elPieUrl = $('#pie-url');
const elPieCarpeta = $('#pie-carpeta');
const elZonaCarpeta = $('#zona-carpeta');

const estado = {
  archivos: [],
  firma: '',
  filtro: '',
  subiendo: false,
};

let cola = [];
let activa = null;

/* ------------------------------------------------------------- formato */

function fmtBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return n + ' B';
  const u = ['kB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = -1;
  do { v /= 1024; i++; } while (v >= 1024 && i < u.length - 1);
  return v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2).replace('.', ',') + ' ' + u[i];
}

function fmtFecha(ms) {
  const d = new Date(ms);
  const s = (Date.now() - ms) / 1000;
  if (s < 90) return 'recién';
  if (s < 3600) return 'hace ' + Math.max(1, Math.floor(s / 60)) + ' min';
  if (s < 86400) return 'hace ' + Math.floor(s / 3600) + ' h';
  if (s < 86400 * 7) return 'hace ' + Math.floor(s / 86400) + ' d';
  return d.toLocaleDateString('es-AR', { day: '2-digit', month: 'short', year: 'numeric' });
}

function fmtFechaAbs(ms) {
  return new Date(ms).toLocaleString('es-AR', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function extDe(name) {
  const i = name.lastIndexOf('.');
  if (i <= 0 || i === name.length - 1) return 'FILE';
  const ext = name.slice(i + 1).toUpperCase();
  return ext.length > 5 ? ext.slice(0, 5) : ext;
}

/* ------------------------------------------------------------- status */

let statusTimer = 0;

function setStatus(texto, tipo) {
  clearTimeout(statusTimer);
  elStatus.textContent = texto || '';
  elStatus.dataset.tipo = tipo || '';
  elStatus.classList.toggle('visible', Boolean(texto));
  if (texto) {
    statusTimer = setTimeout(() => elStatus.classList.remove('visible'), 7000);
  }
}

/* ------------------------------------------------------------- portapapeles */

async function copiarTexto(texto) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(texto);
      return true;
    }
  } catch { /* probamos el fallback */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = texto;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

async function copiarLink(url) {
  const abs = location.origin + url;
  const ok = await copiarTexto(abs);
  if (ok) setStatus('Link copiado: ' + abs, 'ok');
  else setStatus('Copiá el link a mano: ' + abs, 'warn');
}

/* ------------------------------------------------------------- lista */

function filaArchivo(f) {
  const li = document.createElement('li');
  li.className = 'archivo';
  li.dataset.name = f.name;

  const a = document.createElement('a');
  a.className = 'nombre';
  a.href = f.url;
  a.setAttribute('download', f.name);
  a.title = 'Descargar ' + f.name;

  const ext = document.createElement('span');
  ext.className = 'ext';
  ext.textContent = extDe(f.name);

  const txt = document.createElement('span');
  txt.className = 'nombre-txt';
  txt.textContent = f.name;

  a.append(ext, txt);

  const meta = document.createElement('div');
  meta.className = 'meta';

  const peso = document.createElement('span');
  peso.className = 'peso';
  peso.textContent = fmtBytes(f.size);

  const fecha = document.createElement('span');
  fecha.className = 'fecha';
  fecha.textContent = fmtFecha(f.mtime);
  fecha.title = fmtFechaAbs(f.mtime);

  meta.append(peso, fecha);

  const ops = document.createElement('div');
  ops.className = 'ops';

  const bajar = document.createElement('a');
  bajar.className = 'btn';
  bajar.href = f.url;
  bajar.setAttribute('download', f.name);
  bajar.textContent = 'Bajar';

  const copiar = document.createElement('button');
  copiar.type = 'button';
  copiar.textContent = 'Link';
  copiar.title = 'Copiar el link de descarga';
  copiar.addEventListener('click', () => copiarLink(f.url));

  const borrar = document.createElement('button');
  borrar.type = 'button';
  borrar.className = 'peligro';
  borrar.textContent = 'Borrar';
  borrar.title = 'Doble click para borrar';

  let timer = 0;
  borrar.addEventListener('click', () => {
    if (borrar.dataset.confirmar !== '1') {
      borrar.dataset.confirmar = '1';
      borrar.classList.add('confirmar');
      borrar.textContent = '¿Seguro?';
      setStatus('Click de nuevo en "¿Seguro?" para borrar ' + f.name, 'warn');
      clearTimeout(timer);
      timer = setTimeout(() => {
        delete borrar.dataset.confirmar;
        borrar.classList.remove('confirmar');
        borrar.textContent = 'Borrar';
      }, 4000);
      return;
    }
    clearTimeout(timer);
    borrar.disabled = true;
    borrar.textContent = '…';
    fetch('/api/files/' + encodeURIComponent(f.name), { method: 'DELETE', headers: { 'X-Pasaarchivos': '1' } })
      .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
      .then(({ ok, j }) => {
        if (!ok) throw new Error(j && j.error ? j.error : 'no se pudo borrar');
        setStatus('Borrado: ' + f.name, 'ok');
        estado.firma = '';
        refrescar();
      })
      .catch((err) => {
        borrar.disabled = false;
        borrar.textContent = 'Borrar';
        setStatus('Error al borrar: ' + err.message, 'error');
      });
  });

  ops.append(bajar, copiar, borrar);
  li.append(a, meta, ops);
  return li;
}

function pintarLista() {
  const q = estado.filtro.trim().toLowerCase();
  const visibles = q
    ? estado.archivos.filter((f) => f.name.toLowerCase().includes(q))
    : estado.archivos;

  elLista.textContent = '';
  const frag = document.createDocumentFragment();
  for (const f of visibles) frag.appendChild(filaArchivo(f));
  elLista.appendChild(frag);

  elVacio.hidden = visibles.length > 0;
  elVacio.textContent = estado.archivos.length
    ? 'Ningún archivo coincide con el filtro.'
    : 'Todavía no hay archivos. Arrastrá el primero arriba.';

  const total = estado.archivos.reduce((a, f) => a + f.size, 0);
  elConteo.textContent = estado.archivos.length
    ? `· ${estado.archivos.length} archivo${estado.archivos.length === 1 ? '' : 's'} · ${fmtBytes(total)}`
    : '';
}

function pintarDisco(disk) {
  if (!disk) return;
  elDisco.textContent = fmtBytes(disk.free);
  elDisco.title = `Libres ${fmtBytes(disk.free)} de ${fmtBytes(disk.total)} en el disco del servidor`;
}

async function refrescar(forzar) {
  try {
    const r = await fetch('/api/files', { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();

    const firma = data.files.map((f) => f.name + ':' + f.size + ':' + Math.round(f.mtime)).join('|');
    const cambio = firma !== estado.firma;
    estado.archivos = data.files;
    estado.firma = firma;

    pintarDisco(data.disk);
    if (cambio || forzar) pintarLista();

    if (!elPieCarpeta.textContent || elPieCarpeta.textContent === '—') {
      elPieCarpeta.textContent = data.folder;
      elPieCarpeta.title = data.folder;
    }
  } catch (err) {
    setStatus('No pude leer la lista del servidor (' + err.message + ')', 'error');
  }
}

async function cargarInfo() {
  try {
    const r = await fetch('/api/info', { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const info = await r.json();
    elIp.textContent = info.ip + ':' + info.port;
    elPieUrl.textContent = info.url;
    elPieCarpeta.textContent = info.folder;
    elPieCarpeta.title = info.folder;
    elZonaCarpeta.textContent = 'files/';
    pintarDisco(info.disk);
  } catch (err) {
    $('#chip-servidor').textContent = 'sin conexión';
    $('#chip-servidor').classList.add('caido');
    setStatus('El servidor no responde: ' + err.message, 'error');
  }
}

/** Recalcula los "hace X" sin volver a pedir la lista. */
function refrescarFechas() {
  for (const li of elLista.children) {
    const f = estado.archivos.find((x) => x.name === li.dataset.name);
    if (!f) continue;
    const fecha = li.querySelector('.fecha');
    if (fecha) fecha.textContent = fmtFecha(f.mtime);
  }
}

/* ------------------------------------------------------------- subidas */

function crearItem(file) {
  const el = document.createElement('div');
  el.className = 'subida-item';

  const top = document.createElement('div');
  top.className = 'subida-top';

  const nombre = document.createElement('span');
  nombre.className = 'subida-nombre';
  nombre.textContent = file.name;
  nombre.title = file.name;

  const peso = document.createElement('span');
  peso.className = 'subida-peso';
  peso.textContent = fmtBytes(file.size);

  top.append(nombre, peso);

  const barra = document.createElement('div');
  barra.className = 'progreso';
  const fill = document.createElement('div');
  fill.className = 'progreso-fill';
  barra.appendChild(fill);

  const meta = document.createElement('div');
  meta.className = 'subida-meta';

  const estadoTxt = document.createElement('span');
  estadoTxt.className = 'subida-estado';
  estadoTxt.textContent = 'en cola';

  const vel = document.createElement('span');
  vel.className = 'subida-vel';
  vel.textContent = '';

  const acciones = document.createElement('div');
  acciones.className = 'subida-acciones';

  const cancelar = document.createElement('button');
  cancelar.type = 'button';
  cancelar.className = 'peligro';
  cancelar.textContent = 'cancelar';

  acciones.appendChild(cancelar);
  meta.append(estadoTxt, vel, acciones);

  el.append(top, barra, meta);
  elCola.appendChild(el);
  elCola.scrollTop = elCola.scrollHeight;

  const api = {
    el,
    xhr: null,
    cancelar: () => {
      if (api.xhr) api.xhr.abort();
    },
  };

  cancelar.addEventListener('click', api.cancelar);

  api.progreso = (pct, velocidad) => {
    if (pct !== null) fill.style.width = (pct * 100).toFixed(1) + '%';
    estadoTxt.textContent = pct === null
      ? 'subiendo…'
      : 'subiendo ' + Math.floor(pct * 100) + '%';
    vel.textContent = velocidad && velocidad > 0 ? fmtBytes(velocidad) + '/s' : '';
  };

  api.ok = (res) => {
    el.classList.add('done');
    fill.style.transition = 'none';
    fill.style.width = '100%';
    estadoTxt.textContent = 'guardado · ' + res.name;
    vel.textContent = 'listo';
    cancelar.remove();
    const bajar = document.createElement('a');
    bajar.className = 'btn';
    bajar.href = res.url;
    bajar.setAttribute('download', res.name);
    bajar.textContent = 'bajar';
    acciones.appendChild(bajar);
    api.xhr = null;
    setTimeout(() => { el.remove(); }, 12000);
  };

  api.error = (msg) => {
    el.classList.add('error');
    estadoTxt.textContent = 'error: ' + msg;
    vel.textContent = '';
    cancelar.remove();
    api.xhr = null;
  };

  return api;
}

function subir(file, item) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    item.xhr = xhr;

    xhr.open('PUT', '/api/upload?name=' + encodeURIComponent(file.name), true);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-Pasaarchivos', '1');

    let ultimoT = performance.now();
    let ultimoB = 0;
    let vel = 0;

    xhr.upload.onprogress = (e) => {
      const ahora = performance.now();
      const dt = (ahora - ultimoT) / 1000;
      if (dt > 0.3) {
        const inst = (e.loaded - ultimoB) / dt;
        vel = vel ? vel * 0.65 + inst * 0.35 : inst;
        ultimoT = ahora;
        ultimoB = e.loaded;
      }
      item.progreso(e.lengthComputable ? e.loaded / e.total : null, vel);
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText));
        } catch {
          resolve({ name: file.name, url: '/d/' + encodeURIComponent(file.name) });
        }
        return;
      }
      let msg = 'HTTP ' + xhr.status;
      try {
        const j = JSON.parse(xhr.responseText);
        if (j && j.error) msg = j.error;
      } catch { /* respuesta no JSON */ }
      reject(new Error(msg));
    };

    xhr.onerror = () => reject(new Error('se cortó la conexión'));
    xhr.onabort = () => reject(new Error('cancelado'));
    xhr.ontimeout = () => reject(new Error('timeout'));

    xhr.send(file);
  });
}

async function procesarCola() {
  if (activa) return;
  const file = cola.shift();
  if (!file) {
    estado.subiendo = false;
    refrescar(true);
    return;
  }

  activa = file;
  estado.subiendo = true;
  const item = crearItem(file);

  try {
    const res = await subir(file, item);
    item.ok(res);
    setStatus('Guardado: ' + res.name + ' (' + fmtBytes(res.size) + ')', 'ok');
    estado.firma = '';
    refrescar(true);
  } catch (err) {
    item.error(err.message);
    setStatus('Falló ' + file.name + ': ' + err.message, 'error');
  } finally {
    activa = null;
    procesarCola();
  }
}

function agregar(files) {
  const lista = Array.from(files || []);
  if (!lista.length) return;
  cola = cola.concat(lista);
  const total = lista.reduce((a, f) => a + f.size, 0);
  setStatus(
    lista.length === 1
      ? 'En cola: ' + lista[0].name + ' (' + fmtBytes(lista[0].size) + ')'
      : lista.length + ' archivos en cola (' + fmtBytes(total) + ')',
    'ok'
  );
  procesarCola();
}

/* ------------------------------------------------------------- eventos */

elZona.addEventListener('click', (e) => {
  if (e.target === elInput) return;
  elInput.click();
});

elZona.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    elInput.click();
  }
});

$('#btn-elegir').addEventListener('click', (e) => {
  e.stopPropagation();
  elInput.click();
});

elInput.addEventListener('change', () => {
  agregar(elInput.files);
  elInput.value = '';
});

for (const ev of ['dragenter', 'dragover']) {
  elZona.addEventListener(ev, (e) => {
    e.preventDefault();
    elZona.classList.add('drag');
  });
}

for (const ev of ['dragleave', 'dragend']) {
  elZona.addEventListener(ev, (e) => {
    if (e.target === elZona) elZona.classList.remove('drag');
  });
}

document.addEventListener('dragover', (e) => e.preventDefault());

elZona.addEventListener('drop', (e) => {
  e.preventDefault();
  elZona.classList.remove('drag');

  const dt = e.dataTransfer;
  if (!dt) return;

  const items = Array.from(dt.items || []);
  const archivos = [];
  let carpetas = 0;

  if (items.length) {
    for (const it of items) {
      if (it.kind !== 'file') continue;
      let entry = null;
      try { entry = it.webkitGetAsEntry ? it.webkitGetAsEntry() : null; } catch { /* sin entry */ }
      if (entry && entry.isDirectory) { carpetas++; continue; }
      const f = it.getAsFile();
      if (f) archivos.push(f);
    }
  } else {
    archivos.push(...Array.from(dt.files || []));
  }

  if (carpetas) {
    setStatus('Las carpetas no se pueden subir: arrastrá los archivos que hay adentro.', 'warn');
  }
  if (archivos.length) agregar(archivos);
});

document.addEventListener('paste', (e) => {
  const files = Array.from((e.clipboardData && e.clipboardData.files) || []);
  if (files.length) {
    e.preventDefault();
    agregar(files);
  }
});

elBuscar.addEventListener('input', () => {
  estado.filtro = elBuscar.value;
  pintarLista();
});

$('#btn-actualizar').addEventListener('click', () => refrescar(true));

$('#copiar-url').addEventListener('click', async () => {
  const url = elPieUrl.textContent;
  if (!url || url === '—') return;
  const ok = await copiarTexto(url);
  setStatus(ok ? 'URL copiada: ' + url : 'Copiá a mano: ' + url, ok ? 'ok' : 'warn');
});

window.addEventListener('beforeunload', (e) => {
  if (estado.subiendo) {
    e.preventDefault();
    e.returnValue = '';
  }
});

/* ------------------------------------------------------------- arranque */

cargarInfo();
refrescar(true);

setInterval(() => {
  if (document.hidden || activa) return;
  refrescar(false);
}, 8000);

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refrescar(false);
});

window.addEventListener('focus', () => refrescar(false));

setInterval(refrescarFechas, 30000);
