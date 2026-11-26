'use strict';

/*
 * PASAARCHIVOS — servidor de archivos para la red local.
 * - Sin límite de peso: cada subida se escribe en disco en streaming (nunca en memoria).
 * - Los archivos viven en ./files y se listan/bajan desde cualquier equipo de la LAN.
 */

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { URL } = require('url');

const ROOT = __dirname;
const FILES_DIR = path.join(ROOT, 'files');
const TMP_DIR = path.join(FILES_DIR, '.tmp');
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 5636);
const HOST = '0.0.0.0';

fs.mkdirSync(TMP_DIR, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/* ------------------------------------------------------------------ utils */

function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const u = ['B', 'kB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return v.toFixed(v >= 100 || i === 0 ? 0 : v >= 10 ? 1 : 2).replace('.', ',') + ' ' + u[i];
}

function now() {
  return new Date().toLocaleTimeString('es-AR', { hour12: false });
}

function lanIP() {
  const candidates = [];
  for (const [alias, list] of Object.entries(os.networkInterfaces())) {
    for (const it of list || []) {
      if (it.family !== 'IPv4' || it.internal) continue;
      const ip = it.address;
      if (ip.startsWith('169.254.')) continue;
      let score = 0;
      if (ip.startsWith('192.168.')) score = 3;
      else if (ip.startsWith('10.')) score = 2;
      else if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) score = 2;
      if (/wi-?fi|wlan|wireless/i.test(alias)) score += 0.5;
      candidates.push({ ip, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates.length ? candidates[0].ip : '127.0.0.1';
}

const RESERVADOS = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

function sanitizeName(raw) {
  let name = String(raw || '').normalize('NFC');
  name = name.replace(/[\u0000-\u001f\u007f]/g, '');
  name = name.replace(/[\\/]/g, '_');
  name = name.replace(/[<>:"|?*]/g, '_');
  name = name.replace(/^[.\s]+/, '');
  name = name.replace(/[.\s]+$/, '');
  if (!name) name = 'archivo';
  if (RESERVADOS.test(name)) name = '_' + name;
  if (name.length > 120) {
    const ext = path.extname(name).slice(0, 20);
    name = name.slice(0, Math.max(1, 120 - ext.length)) + ext;
  }
  return name;
}

function contentDisposition(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const utf8 = encodeURIComponent(name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

function sendJson(res, status, obj) {
  if (res.writableEnded || res.destroyed) return;
  try {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch { /* cliente ya desconectado */ }
}

function notFound(res) {
  if (res.writableEnded || res.destroyed) return;
  const body = '<!doctype html><meta charset="utf-8"><title>404</title><body style="background:#06070b;color:#eef2f8;font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h1 style="letter-spacing:.2em">404</h1><p><a href="/" style="color:#00d9ff">volver</a></p></div>';
  res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  res.end(body);
}

/* ------------------------------------------------------------------ datos */

async function listFiles() {
  const entries = await fsp.readdir(FILES_DIR, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (!e.isFile() || e.name.startsWith('.')) continue;
    try {
      const st = await fsp.stat(path.join(FILES_DIR, e.name));
      out.push({ name: e.name, size: st.size, mtime: st.mtimeMs, url: '/d/' + encodeURIComponent(e.name) });
    } catch { /* se borró mientras listaba */ }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

async function diskInfo() {
  try {
    const s = await fsp.statfs(FILES_DIR);
    return { total: s.bsize * s.blocks, free: s.bsize * s.bavail };
  } catch {
    return null;
  }
}

async function commitFile(tmpPath, baseName) {
  const ext = path.extname(baseName);
  const stem = baseName.slice(0, baseName.length - ext.length);
  for (let i = 0; i < 10000; i++) {
    const candidate = i === 0 ? baseName : `${stem} (${i})${ext}`;
    const dest = path.join(FILES_DIR, candidate);
    try {
      await fsp.link(tmpPath, dest);
      await fsp.unlink(tmpPath);
      return candidate;
    } catch (err) {
      if (err.code === 'EEXIST') continue;
      if (['EPERM', 'ENOSYS', 'EXDEV', 'ENOTSUP', 'EACCES'].includes(err.code)) {
        try {
          await fsp.copyFile(tmpPath, dest, fs.constants.COPYFILE_EXCL);
          await fsp.unlink(tmpPath);
          return candidate;
        } catch (e2) {
          if (e2.code === 'EEXIST') continue;
          throw e2;
        }
      }
      throw err;
    }
  }
  throw new Error('no pude asignar un nombre libre en la carpeta');
}

/* ------------------------------------------------------------------ rutas */

async function handleUpload(req, res, url) {
  const rawName = url.searchParams.get('name');
  if (!rawName) return sendJson(res, 400, { error: 'falta el nombre del archivo (?name=)' });

  const baseName = sanitizeName(rawName);
  const tmpPath = path.join(TMP_DIR, crypto.randomUUID() + '.part');
  const out = fs.createWriteStream(tmpPath, { flags: 'wx', highWaterMark: 1 << 20 });

  let recibido = 0;
  const declarado = Number(req.headers['content-length'] || 0);
  const t0 = Date.now();

  req.on('data', (chunk) => { recibido += chunk.length; });

  try {
    await pipeline(req, out);
  } catch (err) {
    await fsp.unlink(tmpPath).catch(() => {});
    if (!res.writableEnded && !res.destroyed) {
      console.log(`[${now()}] ! subida cortada: ${baseName} (${fmtBytes(recibido)})`);
      const status = err.code === 'ERR_STREAM_PREMATURE_CLOSE' ? 499 : 500;
      const msg = err.code === 'ENOSPC' ? 'no hay espacio en disco' : 'subida interrumpida';
      sendJson(res, status, { error: msg });
    }
    return;
  }

  if (declarado && recibido !== declarado) {
    await fsp.unlink(tmpPath).catch(() => {});
    return sendJson(res, 400, { error: `llegaron ${recibido} de ${declarado} bytes` });
  }

  let finalName;
  try {
    finalName = await commitFile(tmpPath, baseName);
  } catch (err) {
    await fsp.unlink(tmpPath).catch(() => {});
    console.error(`[${now()}] ! no pude guardar ${baseName}:`, err && err.code ? err.code : err);
    return sendJson(res, 500, { error: 'no pude guardar el archivo en disco' });
  }

  const seg = Math.max(1, (Date.now() - t0) / 1000);
  console.log(`[${now()}] ↑ ${fmtBytes(recibido)}  ${finalName}  (${fmtBytes(recibido / seg)}/s)`);
  sendJson(res, 200, { name: finalName, size: recibido, url: '/d/' + encodeURIComponent(finalName) });
}

function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m) return 'invalid';
  let start = m[1] === '' ? null : Number(m[1]);
  let end = m[2] === '' ? null : Number(m[2]);
  if (start === null && end === null) return 'invalid';
  if (start === null) {
    if (end === 0) return 'invalid';
    start = Math.max(0, size - end);
    end = size - 1;
  } else if (end === null || end >= size) {
    end = size - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return 'invalid';
  return { start, end };
}

async function handleDownload(req, res, rawName) {
  let name;
  try {
    name = decodeURIComponent(rawName);
  } catch {
    return notFound(res);
  }
  if (!name || name !== path.basename(name) || name.includes('/') || name.includes('\\') || name.startsWith('.')) {
    return notFound(res);
  }
  const filePath = path.join(FILES_DIR, name);
  let st;
  try {
    st = await fsp.stat(filePath);
  } catch {
    return notFound(res);
  }
  if (!st.isFile()) return notFound(res);

  const headers = {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': contentDisposition(name),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };

  const range = parseRange(req.headers.range, st.size);

  if (range === 'invalid') {
    res.writeHead(416, { ...headers, 'Content-Range': `bytes */${st.size}`, 'Content-Length': 0 });
    return res.end();
  }

  if (range) {
    const len = range.end - range.start + 1;
    res.writeHead(206, {
      ...headers,
      'Content-Range': `bytes ${range.start}-${range.end}/${st.size}`,
      'Content-Length': len,
    });
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(filePath, { start: range.start, end: range.end });
    stream.on('error', () => res.destroy());
    req.on('close', () => stream.destroy());
    stream.pipe(res);
    return;
  }

  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  if (req.method === 'HEAD') return res.end();
  console.log(`[${now()}] ↓ ${fmtBytes(st.size)}  ${name}`);
  const stream = fs.createReadStream(filePath);
  stream.on('error', () => res.destroy());
  req.on('close', () => stream.destroy());
  stream.pipe(res);
}

async function handleDelete(req, res, rawName) {
  let name;
  try {
    name = decodeURIComponent(rawName);
  } catch {
    return sendJson(res, 400, { error: 'nombre inválido' });
  }
  if (!name || name !== path.basename(name) || name.includes('/') || name.includes('\\') || name.startsWith('.')) {
    return sendJson(res, 400, { error: 'nombre inválido' });
  }
  try {
    await fsp.unlink(path.join(FILES_DIR, name));
    console.log(`[${now()}] ✕ ${name}`);
    sendJson(res, 200, { ok: true, name });
  } catch (err) {
    if (err.code === 'ENOENT') return sendJson(res, 404, { error: 'ese archivo ya no está' });
    sendJson(res, 500, { error: 'no pude borrar el archivo' });
  }
}

async function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  let decoded;
  try {
    decoded = decodeURIComponent(rel);
  } catch {
    return notFound(res);
  }
  if (decoded.includes('\0') || decoded.includes('..') || /^[.\\/]/.test(decoded)) return notFound(res);
  const file = path.join(PUBLIC_DIR, decoded);
  const relCheck = path.relative(PUBLIC_DIR, file);
  if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) return notFound(res);

  let st;
  try {
    st = await fsp.stat(file);
  } catch {
    return notFound(res);
  }
  if (!st.isFile()) return notFound(res);

  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': st.size,
    'Cache-Control': 'no-cache',
  });
  if (req.method === 'HEAD') return res.end();
  const stream = fs.createReadStream(file);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

/* ------------------------------------------------------------------ router */

async function route(req, res) {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const p = url.pathname;
  const m = req.method;

  if (p === '/api/info' && (m === 'GET' || m === 'HEAD')) {
    const files = await listFiles();
    const disk = await diskInfo();
    return sendJson(res, 200, {
      app: 'PASAARCHIVOS',
      ip: lanIP(),
      port: PORT,
      url: `http://${lanIP()}:${PORT}/`,
      folder: FILES_DIR,
      disk,
      count: files.length,
      bytes: files.reduce((a, f) => a + f.size, 0),
    });
  }

  if (p === '/api/files' && m === 'GET') {
    const files = await listFiles();
    return sendJson(res, 200, {
      files,
      disk: await diskInfo(),
      folder: FILES_DIR,
      count: files.length,
      bytes: files.reduce((a, f) => a + f.size, 0),
    });
  }

  if (p === '/api/upload' && (m === 'PUT' || m === 'POST')) {
    if (req.headers['x-pasaarchivos'] !== '1') return sendJson(res, 400, { error: 'falta el header X-Pasaarchivos' });
    return handleUpload(req, res, url);
  }

  if (p.startsWith('/api/files/') && m === 'DELETE') {
    if (req.headers['x-pasaarchivos'] !== '1') return sendJson(res, 400, { error: 'falta el header X-Pasaarchivos' });
    return handleDelete(req, res, p.slice('/api/files/'.length));
  }

  if ((m === 'GET' || m === 'HEAD') && p.startsWith('/d/')) {
    return handleDownload(req, res, p.slice(3));
  }

  if (m === 'GET' || m === 'HEAD') return serveStatic(req, res, p);

  return sendJson(res, 405, { error: 'método no permitido' });
}

/* ------------------------------------------------------------------ server */

const server = http.createServer((req, res) => {
  route(req, res).catch((err) => {
    console.error(`[${now()}] error:`, err);
    sendJson(res, 500, { error: 'error interno' });
  });
});

// Sin timeouts de cuerpo: una subida de 200 GB puede tardar horas y no se corta sola.
server.requestTimeout = 0;
server.timeout = 0;
server.keepAliveTimeout = 72000;

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('');
    console.error(`  El puerto ${PORT} ya está en uso: probablemente PASAARCHIVOS ya está corriendo.`);
    console.error(`  Abrí http://localhost:${PORT}/`);
    console.error('');
    process.exit(2);
  }
  console.error('Error del servidor:', err);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const ip = lanIP();
  console.log('');
  console.log('  PASAARCHIVOS ------------------------------------------');
  console.log(`  Carpeta de archivos : ${FILES_DIR}`);
  console.log(`  En esta máquina     : http://localhost:${PORT}/`);
  console.log(`  En la red local     : http://${ip}:${PORT}/`);
  console.log('  Sin límite de peso. Ctrl+C para detener.');
  console.log('  ------------------------------------------------------');
  console.log('');
});

process.on('SIGINT', () => {
  console.log('\n  Cerrando PASAARCHIVOS...');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
});
