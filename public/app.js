const $ = id => document.getElementById(id);
if (typeof L === 'undefined') {
  document.body.innerHTML = '<div style="padding:30px;text-align:center;font:18px Tahoma,Arial">تعذّر تحميل الخريطة.<br>تأكد من اتصال الإنترنت ثم <a href="">أعد المحاولة</a></div>';
  throw new Error('Leaflet not loaded');
}
const GOVS = {
  'تونس': [36.8065, 10.1815], 'أريانة': [36.8625, 10.1956], 'بن عروس': [36.7531, 10.2189], 'منوبة': [36.8081, 10.0863],
  'نابل': [36.4561, 10.7376], 'زغوان': [36.4029, 10.1429], 'بنزرت': [37.2744, 9.8739], 'باجة': [36.7256, 9.1817],
  'جندوبة': [36.5011, 8.7802], 'الكاف': [36.1675, 8.7049], 'سليانة': [36.0850, 9.3708], 'القيروان': [35.6781, 10.0963],
  'القصرين': [35.1676, 8.8365], 'سيدي بوزيد': [35.0382, 9.4858], 'سوسة': [35.8256, 10.6084], 'المنستير': [35.7643, 10.8113],
  'المهدية': [35.5047, 11.0622], 'صفاقس': [34.7406, 10.7603], 'قفصة': [34.425, 8.7842], 'توزر': [33.9197, 8.1335],
  'قبلي': [33.7050, 8.9650], 'قابس': [33.8815, 10.0982], 'مدنين': [33.3549, 10.5055], 'تطاوين': [32.9297, 10.4518],
  'جربة (حومة السوق)': [33.8756, 10.8575], 'مطار تونس قرطاج': [36.851, 10.2272], 'مطار النفيضة': [36.0758, 10.4387],
};
const NAMES = { standard: 'عادي', comfort: 'مريح', van: 'عائلي' };
const STATUS = { searching: '🔎 نبحث عن سائق…', accepted: '✅ السائق في الطريق إليك', ongoing: '🚕 الرحلة جارية', done: '🏁 وصلت بسلامة', cancelled: '❌ تم الإلغاء', expired: '⌛ انتهت مهلة الطلب' };
const save = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
const load = k => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const api = (u, o) => fetch(u, o).then(r => r.json());
const post = (u, b) => api(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) });

const map = L.map('map', { zoomControl: false }).setView([34.0, 9.5], 6);
L.control.zoom({ position: 'topleft' }).addTo(map);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap', maxZoom: 19 }).addTo(map);
const icon = e => L.divIcon({ html: `<div class="pin">${e}</div>`, className: '', iconSize: [26, 26], iconAnchor: [13, 24] });
let from = null, to = null, mFrom, mTo, mode = 'from', type = 'standard', prices = null;
let rideId = null, pollT = null, role = 'pass', mDrv = null, fitted = false;

Object.keys(GOVS).forEach(g => $('gov').add(new Option(g, g)));
$('dPhone').value = load('dPhone');
const hav = (a, b) => { const R = 6371, r = x => x * Math.PI / 180, dl = r(b.lat - a.lat), dg = r(b.lng - a.lng); const h = Math.sin(dl / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dg / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)) * 1.3; };
const navUrl = p => `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}`;

// ---------- تحديد النقاط ----------
function setPoint(which, ll, name) {
  const p = { lat: ll.lat, lng: ll.lng };
  if (which === 'from') {
    from = p; if (mFrom) map.removeLayer(mFrom); mFrom = L.marker(ll, { icon: icon('📍') }).addTo(map);
    $('fromIn').value = name || 'نقطة على الخريطة'; mode = 'to';
    $('pickHint').innerHTML = 'اضغط على الخريطة لتحديد: <b>الوجهة</b>';
  } else {
    to = p; if (mTo) map.removeLayer(mTo); mTo = L.marker(ll, { icon: icon('🏁') }).addTo(map);
    $('toIn').value = name || 'نقطة على الخريطة'; $('pickHint').textContent = '';
  }
  if (from && to) { map.fitBounds(L.latLngBounds([from, to]).pad(0.3)); estimate(); }
}
map.on('click', e => { if (role === 'pass' && !rideId) setPoint(mode, e.latlng); });
$('fromIn').onfocus = () => { mode = 'from'; };
$('toIn').onfocus = () => { mode = 'to'; };

$('gov').onchange = e => { const g = GOVS[e.target.value]; if (g) map.setView(g, 12); };
$('locBtn').onclick = () => {
  if (!navigator.geolocation) return alert('المتصفح لا يدعم تحديد الموقع');
  navigator.geolocation.getCurrentPosition(
    pos => { const ll = L.latLng(pos.coords.latitude, pos.coords.longitude); map.setView(ll, 15); setPoint('from', ll, 'موقعي الحالي'); },
    () => alert('تعذر تحديد موقعك. فعّل خدمة الموقع أو اضغط على الخريطة.'), { enableHighAccuracy: true, timeout: 10000 });
};

// البحث عن الأماكن في تونس (OpenStreetMap Nominatim)
function bindSearch(inp, box, which) {
  let t;
  inp.oninput = () => {
    clearTimeout(t); const q = inp.value.trim();
    if (q.length < 3) return box.classList.add('hide');
    t = setTimeout(async () => {
      try {
        const r = await api(`https://nominatim.openstreetmap.org/search?format=json&countrycodes=tn&accept-language=ar&limit=5&q=${encodeURIComponent(q)}`);
        box.innerHTML = '';
        r.forEach(x => {
          const d = document.createElement('div'); d.textContent = x.display_name;
          d.onclick = () => { box.classList.add('hide'); const ll = L.latLng(+x.lat, +x.lon); map.setView(ll, 14); setPoint(which, ll, x.display_name.split(',').slice(0, 2).join('،')); };
          box.appendChild(d);
        });
        box.classList.toggle('hide', !r.length);
      } catch {}
    }, 500);
  };
}
bindSearch($('fromIn'), $('fromSug'), 'from'); bindSearch($('toIn'), $('toSug'), 'to');

// ---------- السعر ----------
async function estimate() {
  const r = await api(`/api/estimate?flat=${from.lat}&flng=${from.lng}&tlat=${to.lat}&tlng=${to.lng}`);
  if (r.error) { $('kmInfo').textContent = 'الموقع يجب أن يكون داخل تونس'; $('reqBtn').disabled = true; return; }
  prices = r.prices;
  document.querySelectorAll('.type').forEach(el => el.querySelector('b').textContent = prices[el.dataset.t].toFixed(1) + ' د.ت');
  $('kmInfo').textContent = `المسافة التقريبية: ${r.km} كم — السعر تقديري والعدّاد هو المرجع`;
  $('reqBtn').disabled = false;
}
document.querySelectorAll('.type').forEach(el => el.onclick = () => {
  document.querySelectorAll('.type').forEach(x => x.classList.remove('on')); el.classList.add('on'); type = el.dataset.t;
});

// ---------- طلب الرحلة ----------
$('reqBtn').onclick = async () => {
  const r = await post('/api/rides', { from, to, fromName: $('fromIn').value, toName: $('toIn').value, type });
  if (r.error) return alert(r.error);
  rideId = r.id; save('rideId', rideId); showRide(r); poll();
};
$('cancelBtn').onclick = async () => { if (confirm('إلغاء الطلب؟')) { const r = await post(`/api/rides/${rideId}/cancel`); if (!r.error) showRide(r); } };
$('newBtn').onclick = resetPass;

function resetPass() {
  rideId = null; save('rideId', ''); clearTimeout(pollT);
  $('pRide').classList.add('hide'); $('pForm').classList.remove('hide');
  [mFrom, mTo, mDrv].forEach(m => m && map.removeLayer(m)); from = to = mFrom = mTo = mDrv = null; mode = 'from'; fitted = false;
  $('fromIn').value = $('toIn').value = ''; $('reqBtn').disabled = true; $('kmInfo').textContent = '';
  $('pickHint').innerHTML = 'اضغط على الخريطة لتحديد: <b>نقطة الانطلاق</b>';
}
function showRide(r) {
  $('pForm').classList.add('hide'); $('pRide').classList.remove('hide');
  $('rStatus').textContent = STATUS[r.status] || r.status;
  const d = r.driver;
  $('rInfo').innerHTML = `<div>من: ${esc(r.fromName)}</div><div>إلى: ${esc(r.toName)}</div><div>النوع: ${NAMES[r.type]} — ${r.km} كم</div><div>السعر التقديري: <b>${r.price.toFixed(1)} د.ت</b></div>` +
    (d ? `<hr style="margin:8px 0;border:0;border-top:1px solid #ddd"><div>السائق: <b>${esc(d.name)}</b></div><div>السيارة: ${esc(d.car)} — ${esc(d.plate)}</div><a class="call" href="tel:${esc(d.phone)}">📞 اتصل بالسائق</a>` : '');
  const end = ['done', 'cancelled', 'expired'].includes(r.status);
  if (r.driverLoc && !end) { // موقع السيارة مباشرة على الخريطة
    const ll = [r.driverLoc.lat, r.driverLoc.lng];
    if (mDrv) mDrv.setLatLng(ll); else mDrv = L.marker(ll, { icon: icon('🚕'), zIndexOffset: 1000 }).addTo(map);
    const target = r.status === 'accepted' ? r.from : r.to, km = hav(r.driverLoc, target);
    $('rInfo').insertAdjacentHTML('afterbegin', `<div style="font-weight:700;margin-bottom:6px">🚕 ${r.status === 'accepted' ? 'السائق يبعد عنك' : 'متبقٍ للوجهة'} نحو ${km.toFixed(1)} كم (≈ ${Math.max(1, Math.round(km / 30 * 60))} دقيقة)</div>`);
    if (!fitted) { fitted = true; map.fitBounds(L.latLngBounds([ll, [target.lat, target.lng]]).pad(0.4)); }
  } else if (end && mDrv) { map.removeLayer(mDrv); mDrv = null; }
  $('cancelBtn').classList.toggle('hide', end || r.status === 'ongoing'); $('newBtn').classList.toggle('hide', !end);
  return end;
}
async function poll() {
  clearTimeout(pollT); if (!rideId) return;
  try { const r = await api(`/api/rides/${rideId}`); if (r.error) return resetPass(); if (showRide(r)) return; } catch {}
  pollT = setTimeout(poll, 3000);
}

// ---------- السائق ----------
let dToken = load('dtoken'), online = false, dRideId = null, dT, rpT, pendT, authMode = 'login', watchId = null, myLoc = null, lastPing = 0, dInit = false;
const reqLayer = L.layerGroup().addTo(map);
const VIEWS = ['dAuth', 'dPending', 'dList', 'dRide'];
const showDView = v => VIEWS.forEach(x => $(x).classList.toggle('hide', x !== v));
const dapi = (u, b) => fetch(u, { method: b === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + dToken }, body: b === undefined ? undefined : JSON.stringify(b) })
  .then(async r => { const j = await r.json(); if (r.status === 401) driverOut(); return j; });

function setAuthMode(m) {
  authMode = m; $('regFields').classList.toggle('hide', m !== 'reg'); $('dAuthBtn').textContent = m === 'reg' ? 'إرسال طلب التسجيل' : 'دخول'; $('dAuthMsg').textContent = '';
  $('aLogin').style.cssText = m === 'login' ? 'padding:10px;font-size:15px' : 'padding:10px;font-size:15px;background:var(--g);color:var(--k)';
  $('aReg').style.cssText = m === 'reg' ? 'padding:10px;font-size:15px;background:var(--y);color:var(--k)' : 'padding:10px;font-size:15px;background:var(--g);color:var(--k)';
  $('aLogin').className = m === 'login' ? 'btn y' : 'btn'; $('aReg').className = m === 'reg' ? 'btn y' : 'btn';
}
$('aLogin').onclick = () => setAuthMode('login'); $('aReg').onclick = () => setAuthMode('reg');
$('dAuthBtn').onclick = async () => {
  const b = { phone: $('dPhone').value, pin: $('dPin').value };
  if (authMode === 'reg') Object.assign(b, { name: $('dName').value, car: $('dCar').value, plate: $('dPlate').value });
  $('dAuthMsg').textContent = '';
  const r = await post(authMode === 'reg' ? '/api/driver/register' : '/api/driver/login', b);
  if (r.error) return $('dAuthMsg').textContent = r.error;
  dToken = r.token; save('dtoken', dToken); save('dPhone', $('dPhone').value); $('dPin').value = '';
  initDriver();
};
function driverOut() {
  dToken = ''; save('dtoken', ''); online = false; dRideId = null; clearTimeout(dT); clearTimeout(rpT); clearTimeout(pendT);
  if (watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  reqLayer.clearLayers(); showDView('dAuth');
}
$('dOut').onclick = $('pendOut').onclick = driverOut;

async function initDriver() {
  clearTimeout(pendT);
  if (!dToken) return showDView('dAuth');
  const r = await dapi('/api/driver/me'); if (r.error) return;
  const d = r.driver;
  if (d.status === 'approved') {
    if (r.activeRide) { dRideId = r.activeRide.id; showDView('dRide'); showDrv(r.activeRide); startGeo(); pollDRide(); } else goOnline();
  } else {
    $('pendTitle').textContent = d.status === 'blocked' ? '⛔ تم إيقاف حسابك' : '⏳ حسابك قيد المراجعة';
    $('pendTxt').textContent = d.status === 'blocked' ? 'تواصل مع الإدارة لمعرفة السبب.' : 'سنقبل حسابك بعد التحقق من بياناتك. ستُفتح لك الطلبات تلقائياً عند الموافقة، ابقَ في هذه الصفحة أو عُد لاحقاً.';
    showDView('dPending'); if (d.status === 'pending') pendT = setTimeout(initDriver, 8000);
  }
}
function showBalance(b, pct) {
  const f = n => Number(n || 0).toFixed(3) + ' د.ت';
  $('balHint').innerHTML = `💰 المستحق عليك لإدارة سليماني: <b style="color:#b85c00">${f(b.due)}</b><br><span style="color:#666;font-size:12px">عمولة ${pct}٪ من كل رحلة تنتهي + الاشتراك الشهري. المدفوع حتى الآن: ${f(b.paid)}</span>`;
}
async function refreshBalance() { const r = await dapi('/api/driver/me'); if (r && r.balance) showBalance(r.balance, r.commissionPct); }
function goOnline() { online = true; $('goOffline').textContent = 'إيقاف'; showDView('dList'); startGeo(); refreshBalance(); loadReqs(); }
$('goOffline').onclick = () => {
  if (online) { online = false; clearTimeout(dT); reqLayer.clearLayers(); $('cnt').textContent = '0'; $('reqs').innerHTML = '<div class="hint">أنت متوقف عن استقبال الطلبات.</div>'; $('goOffline').textContent = 'ابدأ الاستقبال'; }
  else goOnline();
};

// موقع السائق: يُرسل للخادم ليرتّب الطلبات حسب القرب ويتتبعه الراكب
function startGeo() {
  if (watchId != null || !navigator.geolocation) return;
  watchId = navigator.geolocation.watchPosition(pos => {
    myLoc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    const now = Date.now();
    if (now - lastPing > 8000 && dToken) { lastPing = now; dapi(dRideId ? `/api/rides/${dRideId}/loc` : '/api/driver/ping', myLoc); }
  }, () => { myLoc = null; }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
}
async function loadReqs() {
  clearTimeout(dT); if (!online) return;
  try {
    const list = await dapi('/api/requests' + (myLoc ? `?lat=${myLoc.lat}&lng=${myLoc.lng}` : ''));
    if (list.error) { if (!dToken) return; return initDriver(); }
    $('cnt').textContent = list.length;
    $('locHint').textContent = myLoc ? 'مرتّبة حسب القرب منك (حتى 40 كم)' : 'لم نحدد موقعك. فعّل الموقع لترى الأقرب إليك أولاً.';
    $('reqs').innerHTML = ''; reqLayer.clearLayers();
    list.forEach(r => {
      const c = document.createElement('div'); c.className = 'card';
      c.innerHTML = (r.dist != null ? `<div style="font-weight:800">📍 يبعد عنك ${r.dist} كم</div>` : '') + `<div><b>${NAMES[r.type]}</b></div><div>من: ${esc(r.fromName)}</div><div>إلى: ${esc(r.toName)}</div><div>${r.km} كم — <b>${r.price.toFixed(1)} د.ت</b></div>`;
      const b = document.createElement('button'); b.className = 'btn y'; b.style.marginTop = '8px'; b.textContent = 'قبول الرحلة';
      b.onclick = () => accept(r); c.appendChild(b); $('reqs').appendChild(c);
      L.marker(r.from, { icon: icon('🧍') }).addTo(reqLayer);
    });
    if (!list.length) $('reqs').innerHTML = '<div class="hint">لا توجد طلبات قريبة حالياً… سيتم التحديث تلقائياً</div>';
  } catch {}
  dT = setTimeout(loadReqs, 3000);
}
async function accept(r) {
  const res = await dapi(`/api/rides/${r.id}/accept`, {});
  if (res.error) { alert(res.error); return loadReqs(); }
  clearTimeout(dT); online = false; reqLayer.clearLayers(); dRideId = r.id; showDView('dRide');
  map.setView(r.from, 14); showDrv(res); pollDRide();
  if (myLoc) dapi(`/api/rides/${r.id}/loc`, myLoc);
}
function showDrv(r) {
  $('dStatus').textContent = STATUS[r.status];
  $('dInfo').innerHTML = `<div>من: ${esc(r.fromName)}</div><div>إلى: ${esc(r.toName)}</div><div>السعر التقديري: <b>${r.price.toFixed(1)} د.ت</b></div>`;
  const nx = { accepted: ['بدأت الرحلة', 'start'], ongoing: ['أنهيت الرحلة', 'complete'] }[r.status];
  const nav = r.status === 'accepted' ? ['🧭 الاتجاهات إلى الراكب', r.from] : r.status === 'ongoing' ? ['🧭 الاتجاهات إلى الوجهة', r.to] : null;
  $('navBtn').classList.toggle('hide', !nav); if (nav) { $('navBtn').textContent = nav[0]; $('navBtn').href = navUrl(nav[1]); }
  if (nx) { $('dNext').textContent = nx[0]; $('dNext').onclick = async () => { const x = await dapi(`/api/rides/${dRideId}/${nx[1]}`, {}); if (x.error) alert(x.error); else { showDrv(x); if (x.status === 'done') dRideId = null; } }; }
  else { dRideId = null; clearTimeout(rpT); $('dNext').textContent = 'العودة للطلبات'; $('dNext').onclick = () => { goOnline(); }; }
}
async function pollDRide() { // يكتشف إلغاء الراكب للرحلة
  clearTimeout(rpT); if (!dRideId) return;
  try { const r = await api(`/api/rides/${dRideId}`); if (!r.error && r.status === 'cancelled') return showDrv(r); } catch {}
  rpT = setTimeout(pollDRide, 4000);
}

// ---------- التبديل بين الراكب والسائق ----------
function setRole(r) {
  role = r; $('tP').classList.toggle('on', r === 'pass'); $('tD').classList.toggle('on', r === 'drv');
  $('pass').classList.toggle('hide', r !== 'pass'); $('drv').classList.toggle('hide', r !== 'drv');
  setTimeout(() => map.invalidateSize(), 50);
  if (r === 'drv' && !dInit) { dInit = true; initDriver(); }
}
$('tP').onclick = () => setRole('pass'); $('tD').onclick = () => setRole('drv');

// استرجاع رحلة جارية بعد إعادة فتح التطبيق
rideId = load('rideId') || null; if (rideId) poll();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

// زر تحميل التطبيق (أيقونة التحميل في الترويسة)
(() => {
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (standalone) return $('dl').classList.add('hide');
  const ua = navigator.userAgent, ios = /iphone|ipad|ipod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  let ev;
  addEventListener('beforeinstallprompt', e => { e.preventDefault(); ev = e; });
  addEventListener('appinstalled', () => $('dl').classList.add('hide'));
  const isAndroid = /android/i.test(ua);
  const help = t => {
    $('helpTxt').innerHTML = t; $('help').classList.add('show');
    $('apkLink').classList.toggle('hide', !isAndroid); $('apkNote').classList.toggle('hide', !isAndroid);
  };
  $('helpOk').onclick = () => $('help').classList.remove('show');
  $('dl').onclick = async () => {
    if (ev) { ev.prompt(); try { await ev.userChoice; } catch {} ev = null; return; }
    if (ios) return help('اضغط زر <b>المشاركة</b> ⬆️ في Safari<br>ثم اختر <b>«إضافة إلى الشاشة الرئيسية»</b>');
    if (/android/i.test(ua)) return help('اضغط قائمة المتصفح <b>⋮</b><br>ثم اختر <b>«تثبيت التطبيق»</b> أو <b>«إضافة إلى الشاشة الرئيسية»</b>');
    help('اضغط أيقونة <b>التثبيت</b> في شريط العنوان أعلى المتصفح،<br>أو القائمة ⋮ ثم <b>«تثبيت سليماني تاكسي»</b>');
  };
})();
