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
let rideId = null, pollT = null, role = 'pass';

Object.keys(GOVS).forEach(g => $('gov').add(new Option(g, g)));
['dName', 'dPhone', 'dCar', 'dPlate'].forEach(i => $(i).value = load(i));

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
  [mFrom, mTo].forEach(m => m && map.removeLayer(m)); from = to = mFrom = mTo = null; mode = 'from';
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
  $('cancelBtn').classList.toggle('hide', end || r.status === 'ongoing'); $('newBtn').classList.toggle('hide', !end);
  return end;
}
async function poll() {
  clearTimeout(pollT); if (!rideId) return;
  try { const r = await api(`/api/rides/${rideId}`); if (r.error) return resetPass(); if (showRide(r)) return; } catch {}
  pollT = setTimeout(poll, 3000);
}

// ---------- السائق ----------
let online = false, dRideId = null, dT;
$('goOnline').onclick = () => {
  const v = ['dName', 'dPhone', 'dCar', 'dPlate'].map(i => $(i).value.trim());
  if (v.some(x => !x)) return alert('أكمل بيانات السائق');
  ['dName', 'dPhone', 'dCar', 'dPlate'].forEach((i, k) => save(i, v[k]));
  online = true; $('dForm').classList.add('hide'); $('dList').classList.remove('hide'); loadReqs();
};
$('goOffline').onclick = () => { online = false; clearTimeout(dT); $('dList').classList.add('hide'); $('dForm').classList.remove('hide'); };
async function loadReqs() {
  clearTimeout(dT); if (!online) return;
  try {
    const list = await api('/api/requests'); $('cnt').textContent = list.length;
    $('reqs').innerHTML = '';
    list.reverse().forEach(r => {
      const c = document.createElement('div'); c.className = 'card';
      c.innerHTML = `<div><b>${NAMES[r.type]}</b></div><div>من: ${esc(r.fromName)}</div><div>إلى: ${esc(r.toName)}</div><div>${r.km} كم — <b>${r.price.toFixed(1)} د.ت</b></div>`;
      const b = document.createElement('button'); b.className = 'btn y'; b.style.marginTop = '8px'; b.textContent = 'قبول الرحلة';
      b.onclick = () => accept(r); c.appendChild(b); $('reqs').appendChild(c);
      L.marker(r.from, { icon: icon('🧍') }).addTo(map);
    });
    if (!list.length) $('reqs').innerHTML = '<div class="hint">لا توجد طلبات حالياً… سيتم التحديث تلقائياً</div>';
  } catch {}
  dT = setTimeout(loadReqs, 3000);
}
async function accept(r) {
  const res = await post(`/api/rides/${r.id}/accept`, { name: $('dName').value, phone: $('dPhone').value, car: $('dCar').value, plate: $('dPlate').value });
  if (res.error) { alert(res.error); return loadReqs(); }
  clearTimeout(dT); dRideId = r.id; $('dList').classList.add('hide'); $('dRide').classList.remove('hide');
  map.setView(r.from, 14); showDrv(res);
}
function showDrv(r) {
  $('dStatus').textContent = STATUS[r.status];
  $('dInfo').innerHTML = `<div>من: ${esc(r.fromName)}</div><div>إلى: ${esc(r.toName)}</div><div>السعر التقديري: <b>${r.price.toFixed(1)} د.ت</b></div>`;
  const nx = { accepted: ['بدأت الرحلة', 'start'], ongoing: ['أنهيت الرحلة', 'complete'] }[r.status];
  $('dNext').classList.remove('hide');
  if (nx) { $('dNext').textContent = nx[0]; $('dNext').onclick = async () => { const x = await post(`/api/rides/${dRideId}/${nx[1]}`); if (!x.error) showDrv(x); }; }
  else { $('dNext').textContent = 'العودة للطلبات'; $('dNext').onclick = () => { $('dRide').classList.add('hide'); $('dList').classList.remove('hide'); loadReqs(); }; }
}

// ---------- التبديل بين الراكب والسائق ----------
function setRole(r) {
  role = r; $('tP').classList.toggle('on', r === 'pass'); $('tD').classList.toggle('on', r === 'drv');
  $('pass').classList.toggle('hide', r !== 'pass'); $('drv').classList.toggle('hide', r !== 'drv');
  setTimeout(() => map.invalidateSize(), 50);
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
