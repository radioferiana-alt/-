// سليماني تاكسي - سيرفر بدون أي مكتبات خارجية
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const DB_FILE = path.join(process.env.DATA_DIR || __dirname, 'data.json');

let db = { rides: [], drivers: {} };
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch {}
const save = () => fs.writeFile(DB_FILE, JSON.stringify(db), () => {});

const TYPES = { standard: { base: 0.8, km: 0.65 }, comfort: { base: 1.5, km: 0.9 }, van: { base: 2, km: 1.1 } };

function distKm(a, b) {
  const R = 6371, rad = x => x * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h)) * 1.3; // معامل تقريبي للطرق
}
const price = (km, type) => {
  const t = TYPES[type] || TYPES.standard;
  return Math.round((t.base + km * t.km) * 10) / 10;
};

const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.apk': 'application/vnd.android.package-archive' };

function body(req) {
  return new Promise(res => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 1e5) req.destroy(); });
    req.on('end', () => { try { res(JSON.parse(d || '{}')); } catch { res({}); } });
  });
}
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const validPt = p => p && Number.isFinite(p.lat) && Number.isFinite(p.lng) && p.lat > 29 && p.lat < 38 && p.lng > 7 && p.lng < 12.5;
const clean = s => String(s || '').slice(0, 60);

async function api(req, res, url) {
  const m = req.method, p = url.pathname;

  if (m === 'POST' && p === '/api/rides') {
    const b = await body(req);
    if (!validPt(b.from) || !validPt(b.to)) return send(res, 400, { error: 'الموقع يجب أن يكون داخل تونس' });
    const type = TYPES[b.type] ? b.type : 'standard';
    const km = distKm(b.from, b.to);
    const ride = {
      id: crypto.randomUUID(), status: 'searching', created: Date.now(),
      name: clean(b.name) || 'راكب', phone: clean(b.phone),
      from: b.from, to: b.to, fromName: clean(b.fromName), toName: clean(b.toName),
      type, km: Math.round(km * 10) / 10, price: price(km, type), driver: null,
    };
    db.rides.push(ride); save();
    return send(res, 200, ride);
  }

  if (m === 'GET' && p === '/api/estimate') {
    const q = url.searchParams;
    const from = { lat: +q.get('flat'), lng: +q.get('flng') }, to = { lat: +q.get('tlat'), lng: +q.get('tlng') };
    if (!validPt(from) || !validPt(to)) return send(res, 400, { error: 'bad' });
    const km = distKm(from, to);
    return send(res, 200, { km: Math.round(km * 10) / 10, prices: Object.fromEntries(Object.keys(TYPES).map(t => [t, price(km, t)])) });
  }

  let r = p.match(/^\/api\/rides\/([\w-]+)$/);
  if (r && m === 'GET') {
    const ride = db.rides.find(x => x.id === r[1]);
    return ride ? send(res, 200, ride) : send(res, 404, { error: 'غير موجود' });
  }

  r = p.match(/^\/api\/rides\/([\w-]+)\/(cancel|accept|start|complete)$/);
  if (r && m === 'POST') {
    const ride = db.rides.find(x => x.id === r[1]);
    if (!ride) return send(res, 404, { error: 'غير موجود' });
    const b = await body(req), act = r[2];
    if (act === 'cancel' && ['searching', 'accepted'].includes(ride.status)) ride.status = 'cancelled';
    else if (act === 'accept' && ride.status === 'searching') {
      ride.status = 'accepted';
      ride.driver = { name: clean(b.name) || 'سائق', phone: clean(b.phone), car: clean(b.car), plate: clean(b.plate) };
    } else if (act === 'start' && ride.status === 'accepted') ride.status = 'ongoing';
    else if (act === 'complete' && ride.status === 'ongoing') ride.status = 'done';
    else return send(res, 409, { error: 'لا يمكن تنفيذ هذا الإجراء الآن (ربما أخذها سائق آخر)' });
    save();
    return send(res, 200, ride);
  }

  if (m === 'GET' && p === '/api/requests') { // الطلبات المتاحة للسائقين
    const now = Date.now();
    db.rides.forEach(x => { if (x.status === 'searching' && now - x.created > 10 * 60e3) x.status = 'expired'; });
    return send(res, 200, db.rides.filter(x => x.status === 'searching').slice(-30));
  }

  send(res, 404, { error: 'not found' });
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) return api(req, res, url).catch(() => send(res, 500, { error: 'خطأ في الخادم' }));
  let f = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!f.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (e, data) => {
    if (e) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': mime[path.extname(f)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, () => console.log(`سليماني تاكسي يعمل على http://localhost:${PORT}`));
