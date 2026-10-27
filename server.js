// ফ্যামিলি-ওনলি লোকেশন শেয়ার সাইট — PostgreSQL সংস্করণ
// Render-এর জন্য প্রস্তুত। চালাতে: KEY="family123" DATABASE_URL="..." node server.js
const http = require('http'), fs = require('fs'), crypto = require('crypto'), path = require('path');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const KEY  = process.env.KEY;

if (!KEY || KEY.length < 6) {
  console.error('KEY সেট করুন (কমপক্ষে ৬ অক্ষর)।');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL সেট করুন (Render PostgreSQL থেকে কপি করুন)।');
  process.exit(1);
}

const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const KEYHASH = sha(KEY);
const num = v => typeof v === 'number' && isFinite(v);

// ---------- ডেটাবেস (PostgreSQL) ----------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// টেবিল তৈরি (প্রথমবার চালালে হবে, পরে কিছুই করবে না)
pool.query(`
  CREATE TABLE IF NOT EXISTS visits (
    id SERIAL PRIMARY KEY,
    ts BIGINT NOT NULL,
    client_ts BIGINT,
    lat REAL,
    lng REAL,
    acc REAL,
    ip TEXT,
    ua TEXT,
    referer TEXT,
    page TEXT,
    session TEXT
  );
`).catch(e => console.error('টেবিল তৈরি ব্যর্থ:', e));

const MAX_RECORDS = 100;

// ---------- পেজ ----------
const PAGE  = fs.readFileSync(path.join(__dirname, 'index.html'));
const ADMIN = fs.readFileSync(path.join(__dirname, 'admin.html'));

// ---------- রেট লিমিট ----------
const hits = new Map();
function limited(ip) {
  const now = Date.now(), win = hits.get(ip) || [];
  const recent = win.filter(t => now - t < 60000);
  recent.push(now); hits.set(ip, recent);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some(t => now - t < 60000)) hits.delete(k);
  return recent.length > 20;
}

const authed = req => {
  try { return crypto.timingSafeEqual(sha(req.headers['x-key'] || ''), KEYHASH); }
  catch (e) { return false; }
};

// ---------- HTTP সার্ভার ----------
http.createServer((req, res) => {
  const send = (code, body, type) => {
    res.writeHead(code, { 'Content-Type': type || 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
  };

  if (req.method === 'GET' && req.url === '/')      return send(200, PAGE,  'text/html; charset=utf-8');
  if (req.method === 'GET' && req.url === '/admin') return send(200, ADMIN, 'text/html; charset=utf-8');

  // ভিজিটর লোকেশন পাঠালে সংরক্ষণ
  if (req.url === '/api/save' && req.method === 'POST') {
    const ip = req.socket.remoteAddress || 'unknown';
    if (limited(ip)) return send(429, '{"error":"rate_limited"}');

    let b = '';
    req.on('data', c => { b += c; if (b.length > 5000) req.destroy(); });
    req.on('end', async () => {
      try {
        const d = JSON.parse(b);
        if (!num(d.lat) || !num(d.lng) || Math.abs(d.lat) > 90 || Math.abs(d.lng) > 180)
          return send(400, '{"error":"bad"}');

        await pool.query(
          `INSERT INTO visits (ts, client_ts, lat, lng, acc, ip, ua, referer, page, session)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            Date.now(),
            num(d.t) ? d.t : null,
            d.lat, d.lng,
            num(d.acc) ? d.acc : null,
            ip,
            String(req.headers['user-agent'] || '').slice(0, 300),
            String(req.headers['referer'] || '').slice(0, 300),
            String(d.page || '').slice(0, 300),
            String(d.session || '').slice(0, 64)
          ]
        );

        // সর্বশেষ ১০০টি ছাড়া বাকি মুছে ফেলো
        await pool.query(`
          DELETE FROM visits
          WHERE id NOT IN (
            SELECT id FROM visits ORDER BY ts DESC LIMIT ${MAX_RECORDS}
          )
        `);

        return send(200, '{"ok":true}');
      } catch (e) {
        console.error(e);
        return send(400, '{"error":"bad"}');
      }
    });
    return;
  }

  // মালিক সব ভিজিট দেখবে
  if (req.url === '/api/visitors' && req.method === 'GET') {
    if (!authed(req)) return setTimeout(() => send(401, '{"error":"key"}'), 800);

    pool.query(`SELECT * FROM visits ORDER BY ts DESC LIMIT ${MAX_RECORDS}`)
      .then(r => {
        const rows = r.rows.map(x => ({
          id: x.id, t: Number(x.ts), ct: x.client_ts ? Number(x.client_ts) : null,
          lat: x.lat, lng: x.lng, acc: x.acc,
          ip: x.ip, ua: x.ua, ref: x.referer, page: x.page, sid: x.session
        }));
        send(200, JSON.stringify(rows));
      })
      .catch(e => { console.error(e); send(500, '{"error":"db"}'); });
    return;
  }

  send(404, '{"error":"not found"}');
}).listen(PORT, () => {
  console.log('চালু: http://localhost:' + PORT + '  (মালিকের পেজ: /admin)');
});