// سليماني تاكسي - سيرفر بدون أي مكتبات خارجية
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const DB_FILE = path.join(process.env.DATA_DIR || __dirname, 'data.json');
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const UP_URL = process.env.UPSTASH_REDIS_REST_URL, UP_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const UP_KEY = 'slimani:state';

// ---------- التخزين: Upstash Redis (مجاني ودائم) إن وُجد، وإلا ملف محلي ----------
let db = { rides: [], drivers: {} };
async function up(cmd) {
  const r = await fetch(UP_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + UP_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}
async function load() {
  if (UP_URL && UP_TOKEN) {
    // إذا فشل التحميل نتوقف بدل أن نكتب حالة فارغة فوق البيانات المحفوظة
    const s = await up(['GET', UP_KEY]);
    if (s) db = JSON.parse(s);
  } else {
    try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch {}
  }
  db.rides = db.rides || []; db.drivers = db.drivers || {};
}
let dirty = false, timer = null;
function save() { dirty = true; if (!timer) timer = setTimeout(flush, 1500); }
async function flush() {
  timer = null; if (!dirty) return;
  dirty = false;
  db.rides = db.rides.filter(r => Date.now() - r.created < 3 * 864e5);
  const s = JSON.stringify(db);
  try { if (UP_URL && UP_TOKEN) await up(['SET', UP_KEY, s]); else fs.writeFileSync(DB_FILE, s); }
  catch (e) { console.log('save failed:', e.message); dirty = true; timer = setTimeout(flush, 5000); }
}
async function shutdown() { clearTimeout(timer); await flush(); process.exit(0); }
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);

// ---------- أدوات ----------
const TYPES = { standard: { base: 0.8, km: 0.65 }, comfort: { base: 1.5, km: 0.9 }, van: { base: 2, km: 1.1 } };
function distKm(a, b) {
  const R = 6371, rad = x => x * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h)) * 1.3; // معامل تقريبي للطرق
}
const price = (km, type) => { const t = TYPES[type] || TYPES.standard; return Math.round((t.base + km * t.km) * 10) / 10; };
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.apk': 'application/vnd.android.package-archive' };
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const validPt = p => p && Number.isFinite(p.lat) && Number.isFinite(p.lng) && p.lat > 29 && p.lat < 38 && p.lng > 7 && p.lng < 12.5;
const clean = s => String(s || '').trim().slice(0, 60);
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const normPhone = p => { let d = String(p || '').replace(/\D/g, ''); if (d.length === 11 && d.startsWith('216')) d = d.slice(3); return d; };
const pub = r => { const { driverId, ...x } = r; return x; };
const ip = req => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
function body(req) {
  return new Promise(res => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 1e5) req.destroy(); });
    req.on('end', () => { try { res(JSON.parse(d || '{}')); } catch { res({}); } });
  });
}
const hashPin = (pin, salt = crypto.randomBytes(16).toString('hex')) => ({ salt, hash: crypto.scryptSync(pin, salt, 32).toString('hex') });
const checkPin = (pin, d) => crypto.timingSafeEqual(crypto.scryptSync(pin, d.salt, 32), Buffer.from(d.hash, 'hex'));

// تحديد معدل بسيط في الذاكرة
const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now(), arr = (hits.get(key) || []).filter(t => now - t < windowMs);
  if (arr.length >= max) { hits.set(key, arr); return true; }
  arr.push(now); hits.set(key, arr); return false;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some(t => now - t < 3600e3)) hits.delete(k); }, 600e3).unref();

function driverFrom(req) {
  const m = String(req.headers.authorization || '').match(/^Bearer (\w{32,})$/);
  if (!m) return null;
  const h = sha(m[1]);
  return Object.values(db.drivers).find(d => d.tokens.includes(h)) || null;
}
const driverPub = d => ({ id: d.id, name: d.name, phone: d.phone, car: d.car, plate: d.plate, status: d.status, created: d.created });
function isAdmin(req) {
  if (!ADMIN_KEY) return false;
  const a = crypto.createHash('sha256').update(String(req.headers['x-admin-key'] || '')).digest();
  return crypto.timingSafeEqual(a, crypto.createHash('sha256').update(ADMIN_KEY).digest());
}
const activeRide = d => db.rides.find(r => r.driverId === d.id && ['accepted', 'ongoing'].includes(r.status));
function expire() {
  const now = Date.now();
  db.rides.forEach(x => { if (x.status === 'searching' && now - x.created > 10 * 60e3) { x.status = 'expired'; save(); } });
}
setInterval(expire, 30e3).unref();

// ---------- الواجهة البرمجية ----------
async function api(req, res, url) {
  const m = req.method, p = url.pathname;

  // ===== الراكب =====
  if (m === 'POST' && p === '/api/rides') {
    if (limited('ride:' + ip(req), 6, 10 * 60e3)) return send(res, 429, { error: 'طلبات كثيرة، حاول بعد قليل' });
    const b = await body(req);
    if (!validPt(b.from) || !validPt(b.to)) return send(res, 400, { error: 'الموقع يجب أن يكون داخل تونس' });
    const type = TYPES[b.type] ? b.type : 'standard';
    const km = distKm(b.from, b.to);
    const ride = {
      id: crypto.randomUUID(), status: 'searching', created: Date.now(),
      from: b.from, to: b.to, fromName: clean(b.fromName), toName: clean(b.toName),
      type, km: Math.round(km * 10) / 10, price: price(km, type), driver: null, driverId: null, driverLoc: null,
    };
    db.rides.push(ride); save();
    return send(res, 200, pub(ride));
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
    return ride ? send(res, 200, pub(ride)) : send(res, 404, { error: 'غير موجود' });
  }

  // ===== السائق: حساب =====
  if (m === 'POST' && p === '/api/driver/register') {
    if (limited('reg:' + ip(req), 5, 3600e3)) return send(res, 429, { error: 'محاولات كثيرة، حاول لاحقاً' });
    const b = await body(req);
    const phone = normPhone(b.phone), pin = String(b.pin || '');
    if (phone.length !== 8) return send(res, 400, { error: 'أدخل رقم هاتف تونسي من 8 أرقام' });
    if (pin.length < 6) return send(res, 400, { error: 'كلمة السر 6 أحرف على الأقل' });
    if (!clean(b.name) || !clean(b.car) || !clean(b.plate)) return send(res, 400, { error: 'أكمل الاسم والسيارة واللوحة' });
    if (Object.values(db.drivers).some(d => d.phone === phone)) return send(res, 409, { error: 'هذا الرقم مسجّل من قبل، سجّل الدخول' });
    const id = crypto.randomUUID(), token = crypto.randomBytes(24).toString('hex');
    db.drivers[id] = { id, name: clean(b.name), phone, car: clean(b.car), plate: clean(b.plate), ...hashPin(pin), status: 'pending', created: Date.now(), tokens: [sha(token)], loc: null };
    save();
    return send(res, 200, { token, driver: driverPub(db.drivers[id]) });
  }

  if (m === 'POST' && p === '/api/driver/login') {
    const b = await body(req), phone = normPhone(b.phone);
    if (limited('login:' + ip(req) + phone, 8, 15 * 60e3)) return send(res, 429, { error: 'محاولات كثيرة، حاول بعد 15 دقيقة' });
    const d = Object.values(db.drivers).find(x => x.phone === phone);
    if (!d || !checkPin(String(b.pin || ''), d)) return send(res, 401, { error: 'الهاتف أو كلمة السر غير صحيحة' });
    const token = crypto.randomBytes(24).toString('hex');
    d.tokens = [...d.tokens.slice(-2), sha(token)]; save();
    return send(res, 200, { token, driver: driverPub(d) });
  }

  if (p.startsWith('/api/driver/') || p === '/api/requests' || /^\/api\/rides\/[\w-]+\/(accept|start|complete|loc)$/.test(p)) {
    const d = driverFrom(req);
    if (!d) return send(res, 401, { error: 'سجّل الدخول من جديد' });

    if (m === 'GET' && p === '/api/driver/me') return send(res, 200, { driver: driverPub(d), activeRide: (activeRide(d) && pub(activeRide(d))) || null });
    if (d.status !== 'approved') return send(res, 403, { error: d.status === 'blocked' ? 'تم إيقاف حسابك' : 'حسابك قيد المراجعة' });

    if (m === 'POST' && p === '/api/driver/ping') {
      const b = await body(req);
      if (validPt(b)) { d.loc = { lat: b.lat, lng: b.lng, t: Date.now() }; const ar = activeRide(d); if (ar) ar.driverLoc = d.loc; save(); }
      return send(res, 200, { ok: true });
    }

    if (m === 'GET' && p === '/api/requests') { // الطلبات للسائقين المعتمدين، الأقرب أولاً
      expire();
      const q = url.searchParams, here = { lat: +q.get('lat'), lng: +q.get('lng') };
      const hasLoc = validPt(here);
      let list = db.rides.filter(x => x.status === 'searching').map(x => ({ ...pub(x), dist: hasLoc ? Math.round(distKm(here, x.from) * 10) / 10 : null }));
      if (hasLoc) list = list.filter(x => x.dist <= 40).sort((a, b) => a.dist - b.dist);
      return send(res, 200, list.slice(0, 30));
    }

    r = p.match(/^\/api\/rides\/([\w-]+)\/(accept|start|complete|loc)$/);
    const ride = db.rides.find(x => x.id === r[1]);
    if (!ride) return send(res, 404, { error: 'غير موجود' });
    const b = await body(req), act = r[2];
    if (act === 'accept') {
      if (ride.status !== 'searching') return send(res, 409, { error: 'أخذها سائق آخر أو أُلغيت' });
      if (activeRide(d)) return send(res, 409, { error: 'عندك رحلة جارية، أنهِها أولاً' });
      ride.status = 'accepted'; ride.driverId = d.id; ride.driver = { name: d.name, phone: d.phone, car: d.car, plate: d.plate };
      if (d.loc) ride.driverLoc = d.loc;
    } else if (ride.driverId !== d.id) return send(res, 403, { error: 'هذه ليست رحلتك' });
    else if (act === 'start' && ride.status === 'accepted') ride.status = 'ongoing';
    else if (act === 'complete' && ride.status === 'ongoing') ride.status = 'done';
    else if (act === 'loc' && validPt(b) && ['accepted', 'ongoing'].includes(ride.status)) { ride.driverLoc = { lat: b.lat, lng: b.lng, t: Date.now() }; d.loc = ride.driverLoc; }
    else return send(res, 409, { error: 'لا يمكن تنفيذ هذا الإجراء الآن' });
    save();
    return send(res, 200, pub(ride));
  }

  r = p.match(/^\/api\/rides\/([\w-]+)\/cancel$/); // الراكب يلغي (المعرّف سرّي وطويل)
  if (r && m === 'POST') {
    const ride = db.rides.find(x => x.id === r[1]);
    if (!ride) return send(res, 404, { error: 'غير موجود' });
    if (!['searching', 'accepted'].includes(ride.status)) return send(res, 409, { error: 'لا يمكن الإلغاء الآن' });
    ride.status = 'cancelled'; save();
    return send(res, 200, pub(ride));
  }

  // ===== المدير =====
  if (p.startsWith('/api/admin/')) {
    if (!ADMIN_KEY) return send(res, 503, { error: 'لم يُعرَّف ADMIN_KEY على الخادم' });
    if (!isAdmin(req)) { if (limited('adm:' + ip(req), 10, 15 * 60e3)) return send(res, 429, { error: 'محاولات كثيرة' }); return send(res, 401, { error: 'مفتاح المدير غير صحيح' }); }
    if (m === 'GET' && p === '/api/admin/drivers') return send(res, 200, Object.values(db.drivers).sort((a, b) => b.created - a.created).map(driverPub));
    r = p.match(/^\/api\/admin\/drivers\/([\w-]+)\/(approve|block)$/);
    if (r && m === 'POST') {
      const d = db.drivers[r[1]];
      if (!d) return send(res, 404, { error: 'غير موجود' });
      d.status = r[2] === 'approve' ? 'approved' : 'blocked';
      if (d.status === 'blocked') d.tokens = [];
      save();
      return send(res, 200, driverPub(d));
    }
  }

  send(res, 404, { error: 'not found' });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) return api(req, res, url).catch(e => { console.log(e); send(res, 500, { error: 'خطأ في الخادم' }); });
  const f = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!f.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (e, data) => {
    if (e) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': mime[path.extname(f)] || 'application/octet-stream' });
    res.end(data);
  });
});

load().then(() => server.listen(PORT, () => console.log(`سليماني تاكسي يعمل على http://localhost:${PORT} | تخزين: ${UP_URL ? 'Upstash' : 'ملف'} | مدير: ${ADMIN_KEY ? 'مفعّل' : 'غير مفعّل'}`)))
  .catch(e => { console.error('تعذر تحميل البيانات المحفوظة، لن أبدأ كي لا أمسحها:', e.message); process.exit(1); });
