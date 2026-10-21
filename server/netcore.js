// THHO-Netz: Capes, Tänze (Emotes), Freunde, Chats, Bestenliste, Live-Liste und öffentliche Profile für alle THHO-Spieler.
// Läuft kostenlos auf Deno Deploy (mit Deno KV) – oder lokal mit Node 22: `node main.js`.
// Anmeldung über den echten Minecraft-Account (Mojang "hasJoined"-Prüfung) – niemand kann sich als jemand anderes ausgeben.

const isDeno = typeof Deno !== 'undefined';
const VERSION = 13;
const MAX_IDS = 120;
const env = k => (isDeno ? Deno.env.get(k) : typeof process !== 'undefined' ? process.env[k] : '') || '';
const MOJANG = env('THHO_MOJANG') || 'https://sessionserver.mojang.com'; // Override nur für Tests

// ---------------- Speicher ----------------
function memoryStore() {
  const m = new Map();
  return {
    kind: 'memory',
    async get(k) { const e = m.get(k.join('/')); if (!e) return null; if (e.exp && e.exp < Date.now()) { m.delete(k.join('/')); return null; } return e.v; },
    async set(k, v, ttl) { m.set(k.join('/'), { v, exp: ttl ? Date.now() + ttl : 0 }); },
    async many(keys) { return Promise.all(keys.map(k => this.get(k))); },
    async list(prefix, limit = 5000) { const pre = prefix.join('/') + '/', out = []; for (const [k, e] of [...m].sort((a, b) => a[0] < b[0] ? -1 : 1)) if (k.startsWith(pre) && (!e.exp || e.exp > Date.now())) out.push(e.v); return out.slice(-limit); },
  };
}
async function kvStore() {
  const kv = await Deno.openKv();
  return {
    kind: 'kv',
    async get(k) { return (await kv.get(k)).value ?? null; },
    async set(k, v, ttl) { await kv.set(k, v, ttl ? { expireIn: ttl } : undefined); },
    async many(keys) {
      const out = [];
      for (let i = 0; i < keys.length; i += 10) out.push(...(await kv.getMany(keys.slice(i, i + 10))).map(e => e.value ?? null));
      return out;
    },
    async list(prefix, limit = 5000) { const out = []; for await (const e of kv.list({ prefix }, { limit, reverse: limit < 5000 })) out.push(e.value); return limit < 5000 ? out.reverse() : out; },
  };
}
// Cloudflare D1 (SQLite): eine Tabelle als Schlüssel-Wert-Speicher
async function d1Store(d1) {
  await d1.prepare('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, exp INTEGER NOT NULL DEFAULT 0)').run();
  const key = k => k.map(String).join('\u0001');
  const b64 = u => { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
  const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const enc = v => v instanceof Uint8Array ? 'b:' + b64(v) : 'j:' + JSON.stringify(v);
  const dec = s => s.startsWith('b:') ? unb64(s.slice(2)) : JSON.parse(s.slice(2));
  const live = r => r && (!r.exp || r.exp > Date.now());
  return {
    kind: 'd1',
    async get(k) { const r = await d1.prepare('SELECT v, exp FROM kv WHERE k = ?').bind(key(k)).first(); return live(r) ? dec(r.v) : null; },
    async set(k, v, ttl) { await d1.prepare('INSERT OR REPLACE INTO kv (k, v, exp) VALUES (?, ?, ?)').bind(key(k), enc(v), ttl ? Date.now() + ttl : 0).run(); },
    async many(keys) {
      if (!keys.length) return [];
      const ks = keys.map(key), out = new Map();
      for (let i = 0; i < ks.length; i += 50) {
        const part = ks.slice(i, i + 50);
        const { results } = await d1.prepare(`SELECT k, v, exp FROM kv WHERE k IN (${part.map(() => '?').join(',')})`).bind(...part).all();
        for (const r of results) if (live(r)) out.set(r.k, dec(r.v));
      }
      return ks.map(k => out.has(k) ? out.get(k) : null);
    },
    async list(prefix, limit = 5000) {
      const pre = key(prefix) + '\u0001';
      const { results } = await d1.prepare(`SELECT v, exp FROM kv WHERE k >= ? AND k < ? ORDER BY k ${limit < 5000 ? 'DESC' : 'ASC'} LIMIT ?`).bind(pre, key(prefix) + '\u0002', limit).all();
      const vals = results.filter(live).map(r => dec(r.v));
      return limit < 5000 ? vals.reverse() : vals;
    },
  };
}
let dbp = null;
const db = () => (dbp ||= (async () => {
  if (globalThis.__THHO_D1) return d1Store(globalThis.__THHO_D1);
  try { if (isDeno && Deno.openKv) return await kvStore(); } catch {}
  return memoryStore();
})());

// ---------------- Hilfen ----------------
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', ...CORS } });
const fail = (msg, s = 400) => json({ error: msg }, s);
const uuidOk = u => /^[0-9a-f]{32}$/.test(u);
const idOk = s => s === null || (typeof s === 'string' && /^[a-z0-9_-]{1,40}$/.test(s));
const randomToken = () => [...crypto.getRandomValues(new Uint8Array(24))].map(b => b.toString(16).padStart(2, '0')).join('');
async function body(req) { try { const t = await req.text(); return t.length > 8000 ? {} : JSON.parse(t || '{}'); } catch { return {}; } }

async function who(req) {
  const a = req.headers.get('authorization') || '';
  const tok = a.startsWith('Bearer ') ? a.slice(7) : '';
  if (!/^[0-9a-f]{48}$/.test(tok)) return null;
  return (await db()).get(['tok', tok]);
}

const priv = v => ({ showServer: true, showPlaytime: true, allowJoin: true, public: true, live: true, ...(v.privacy || {}) });
const HEX = /^#[0-9a-fA-F]{6}$/;
const BANNERS = ['aurora', 'galaxy', 'sunset', 'neon', 'ocean', 'lava', 'sakura', 'matrix'];
function cleanProfile(p) {
  const out = { bio: String(p.bio || '').replace(/[<>]/g, '').slice(0, 160) };
  const bn = p.banner || {};
  if (BANNERS.includes(bn.preset)) out.banner = { preset: bn.preset };
  else if (HEX.test(bn.c1 || '') && HEX.test(bn.c2 || '')) out.banner = { c1: bn.c1, c2: bn.c2 };
  if (HEX.test(p.accent || '')) out.accent = p.accent;
  return out;
}
const isOnline = v => v.seen && Date.now() - v.seen < 150_000 && v.status !== 'invisible';
/** Öffentliche Sicht auf einen Spieler (respektiert seine Privatsphäre-Einstellungen). */
function publicView(v) {
  const pv = priv(v), on = isOnline(v);
  return {
    uuid: v.uuid, name: v.name, pro: !!v.pro, online: !!on, status: on ? v.status || 'online' : 'offline',
    server: on && pv.showServer ? v.server || null : null, joinable: !!(on && pv.showServer && pv.allowJoin && v.server),
    mc: on ? v.mc || null : null, seen: v.seen || 0, cape: v.cape || null,
    stats: pv.showPlaytime ? v.stats || null : null,
    profile: { bio: v.profile?.bio || '', banner: v.pro ? v.profile?.banner || null : null, accent: v.profile?.accent || null },
  };
}
let cacheAll = { t: 0, v: [] };
async function allPlayers(store) {
  if (Date.now() - cacheAll.t < 30_000) return cacheAll.v;
  const v = (await store.list(['p'])).filter(x => x && x.uuid && x.name);
  cacheAll = { t: Date.now(), v };
  return v;
}
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtH = ms => { const h = Math.floor(ms / 3600000), m = Math.round(ms % 3600000 / 60000); return h ? `${h} Std. ${m} Min.` : `${m} Min.`; };
const BANNER_CSS = { aurora: 'linear-gradient(120deg,#34d399,#22d3ee,#a78bfa)', galaxy: 'radial-gradient(circle at 30% 40%,#f0abfc,#7c3aed 40%,#020617)', sunset: 'linear-gradient(120deg,#f97316,#e11d48,#7c3aed)', neon: 'linear-gradient(120deg,#22d3ee,#f472b6,#a3e635)', ocean: 'linear-gradient(120deg,#0ea5e9,#1d4ed8,#0f172a)', lava: 'linear-gradient(120deg,#fde047,#f97316,#7f1d1d)', sakura: 'linear-gradient(120deg,#fdf2f8,#f9a8d4,#ec4899)', matrix: 'linear-gradient(120deg,#022c22,#16a34a,#020a04)' };
function profilePage(v) {
  const a = v.profile.accent || '#3b82f6';
  const bn = v.profile.banner ? (v.profile.banner.preset ? BANNER_CSS[v.profile.banner.preset] : `linear-gradient(120deg,${v.profile.banner.c1},${v.profile.banner.c2})`) : `linear-gradient(120deg,${a},#0b1020)`;
  const st = v.online ? (v.status === 'ingame' ? 'Spielt gerade' + (v.server ? ' auf ' + esc(v.server) : '') : v.status === 'away' ? 'Abwesend' : v.status === 'dnd' ? 'Bitte nicht stören' : 'Im THHO Client') : 'Offline';
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(v.name)} – THHO Client</title>
<style>body{margin:0;background:#070b16;color:#e8eefc;font-family:Inter,"Segoe UI",system-ui,sans-serif}.wrap{max-width:760px;margin:40px auto;padding:0 16px}.card{border-radius:20px;overflow:hidden;background:#0c111d;border:1px solid rgba(148,170,220,.14)}.banner{height:170px;background:${bn};background-size:cover}.head{display:flex;gap:18px;align-items:flex-end;padding:0 24px;margin-top:-48px}.head img{width:96px;height:96px;border-radius:16px;border:4px solid #0c111d;image-rendering:pixelated;background:#111}.head h1{margin:0 0 6px;font-size:30px}.pro{display:inline-block;margin-left:8px;padding:3px 8px;border-radius:7px;font-size:12px;font-weight:800;background:linear-gradient(90deg,#f59e0b,#ec4899);vertical-align:middle}.body{padding:18px 24px 26px}.st{color:#8d9bbb}.dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px;background:${v.online ? (v.status === 'ingame' ? a : v.status === 'away' ? '#f59e0b' : v.status === 'dnd' ? '#ef4444' : '#22c55e') : '#64748b'}}.bio{margin:14px 0 0;white-space:pre-wrap}.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:18px}.stats div{padding:14px;border-radius:12px;background:rgba(255,255,255,.04)}.stats b{display:block;font-size:20px}.stats small{color:#8d9bbb}img.skin{float:right;height:150px;margin:-30px 0 8px 18px;image-rendering:pixelated;filter:drop-shadow(0 8px 14px rgba(0,0,0,.5))}footer{text-align:center;color:#8d9bbb;font-size:13px;margin:22px 0}</style></head>
<body><div class="wrap"><div class="card"><div class="banner"></div><div class="head"><img src="https://mc-heads.net/avatar/${esc(v.uuid)}/96" alt=""><div><h1>${esc(v.name)}${v.pro ? '<span class="pro">★ PRO</span>' : ''}</h1><div class="st"><span class="dot"></span>${st}</div></div></div>
<div class="body"><img class="skin" src="https://mc-heads.net/body/${esc(v.uuid)}/150" alt="Skin">${v.profile.bio ? `<p class="bio">${esc(v.profile.bio)}</p>` : ''}${v.stats ? `<div class="stats"><div><b>${fmtH(v.stats.today)}</b><small>Heute</small></div><div><b>${fmtH(v.stats.week)}</b><small>Diese Woche</small></div><div><b>${fmtH(v.stats.total)}</b><small>Gesamt</small></div></div>` : ''}</div></div>
<footer>THHO Client · Profil</footer></div></body></html>`;
}

// Öffentliche Schlüssel von Mojang (https://api.minecraftservices.com/publickeys) – damit prüft der Server ohne Mojang-Anfrage
const MOJANG_CERT_KEYS = [
  'MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAylB4B6m5lz7jwrcFz6Fd/fnfUhcvlxsTSn5kIK/2aGG1C3kMy4VjhwlxF6BFUSnfxhNswPjh3ZitkBxEAFY25uzkJFRwHwVA9mdwjashXILtR6OqdLXXFVyUPIURLOSWqGNBtb08EN5fMnG8iFLgEJIBMxs9BvF3s3/FhuHyPKiVTZmXY0WY4ZyYqvoKR+XjaTRPPvBsDa4WI2u1zxXMeHlodT3lnCzVvyOYBLXL6CJgByuOxccJ8hnXfF9yY4F0aeL080Jz/3+EBNG8RO4ByhtBf4Ny8NQ6stWsjfeUIvH7bU/4zCYcYOq4WrInXHqS8qruDmIl7P5XXGcabuzQstPf/h2CRAUpP/PlHXcMlvewjmGU6MfDK+lifScNYwjPxRo4nKTGFZf/0aqHCh/EAsQyLKrOIYRE0lDG3bzBh8ogIMLAugsAfBb6M3mqCqKaTMAf/VAjh5FFJnjS+7bE+bZEV0qwax1CEoPPJL1fIQjOS8zj086gjpGRCtSy9+bTPTfTR/SJ+VUB5G2IeCItkNHpJX2ygojFZ9n5Fnj7R9ZnOM+L8nyIjPu3aePvtcrXlyLhH/hvOfIOjPxOlqW+O5QwSFP4OEcyLAUgDdUgyW36Z5mB285uKW/ighzZsOTevVUG2QwDItObIV6i8RCxFbN2oDHyPaO5j1tTaBNyVt8CAwEAAQ==',
  'MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAt4t9NPuu7cktclnaH7eZj0omkLcJHeLz5MKsyJEntHZ0INtuBjSSul3Pp3pBeJN8k3ADdcdBLUN90bcAi7WsQqTx3Ft363q3W7TbM8j2iTEdp/0uVspoRt/DP1tkaWFs/w2WwUv9jbVoBUzfUc4pSTIxRwdjmqjZQfvjwKNDbOx3IhP2H0WXodbISejPi1wBZqNW4m1rnZAXp/EpUguxA8mobCa4vUCBkyFDyXdl69/wUSJHyCPmgcMJ364OlAhIqtwVPShBZObvrK/f0BYk6ShJD3N7TFDatSYsIIdcTKRknaIm91s+EsMrdB9U4Yw+ZJ/pyCB4S3vk8zfDCnb0DWIxYH3/EMzaxl77djmTmMzi/JDITup5z3jfWtRZmrAhU2/+W5IO5hEpo3/bCS9PXIY5xb41Lmp2ZO8dXKtyD66Chchy0W129n8vPl2GIruOdrxsjZAHnneyAb9jm0uaGaphwnEnuecX/qgHY6ZMtayvLLsPst8PO6R1vufMy8WqjK+j7LnC1krL7CPDg0NEhyQTmw5l+NCNjSlvB1juM9V4PARg0bYCOkGXm7ydRCjSSH8CJXZpwnd5cBB5WKAX3KPzutRgMi/LFwNSMZzFuUyXaYOZPpD259yqph1LmGqegEdDriACVU+dVEONFMm8eIuBofe7ljmsAFKW9BINwK0CAwEAAQ==',
];
const MOJANG_PROFILE_KEYS = [
  'MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAylB4B6m5lz7jwrcFz6Fd/fnfUhcvlxsTSn5kIK/2aGG1C3kMy4VjhwlxF6BFUSnfxhNswPjh3ZitkBxEAFY25uzkJFRwHwVA9mdwjashXILtR6OqdLXXFVyUPIURLOSWqGNBtb08EN5fMnG8iFLgEJIBMxs9BvF3s3/FhuHyPKiVTZmXY0WY4ZyYqvoKR+XjaTRPPvBsDa4WI2u1zxXMeHlodT3lnCzVvyOYBLXL6CJgByuOxccJ8hnXfF9yY4F0aeL080Jz/3+EBNG8RO4ByhtBf4Ny8NQ6stWsjfeUIvH7bU/4zCYcYOq4WrInXHqS8qruDmIl7P5XXGcabuzQstPf/h2CRAUpP/PlHXcMlvewjmGU6MfDK+lifScNYwjPxRo4nKTGFZf/0aqHCh/EAsQyLKrOIYRE0lDG3bzBh8ogIMLAugsAfBb6M3mqCqKaTMAf/VAjh5FFJnjS+7bE+bZEV0qwax1CEoPPJL1fIQjOS8zj086gjpGRCtSy9+bTPTfTR/SJ+VUB5G2IeCItkNHpJX2ygojFZ9n5Fnj7R9ZnOM+L8nyIjPu3aePvtcrXlyLhH/hvOfIOjPxOlqW+O5QwSFP4OEcyLAUgDdUgyW36Z5mB285uKW/ighzZsOTevVUG2QwDItObIV6i8RCxFbN2oDHyPaO5j1tTaBNyVt8CAwEAAQ==',
  'MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAra4Y2wu3rWEW7cDTDRRd4IvUD140Y12SaG3k4V3UwT/pDnnX5itOcYiZA0qf4VCpJDp2PifOL+Pr/ph/G9/6ZoIxkBeGENo+S7i9BqizJy9cmZocpyx+RkZaw9+frCGNLuYLrxziNWiXFACJSg2mHACR7+6NkGN8d/16/3PxMnvGSyLT7JKGUgqj1Q3oW7k+NLXR9sw6oRELOcnUvZVa2bcglv8vlcyPqqnBhydLfHI85Z5WnIYZviZ3Bb4dv5Fme726BGOtEY7kz40RfiwjT3xYKYKPJUS3/crPX6eugmWyrWdddKaePrW88bp17Z5NIStlJ5KJJk4coha8O+P7onDqmbHwLqPTeR51njkgZ+DJWT6fz8ku9OWQn6I/FxqN14iYIghDJijmKvEwsI7FJ5X2ttPXEvBYLmpj2j0lQQcUIqH7hkiZ+mCW0GYawJgbAeNAraM9sP+76MyAGITtAsXv1IQmah+7OeDJOToG2Kb1Dl0Va+HiP9MPpcnO7kbn6dqAyhNvRNmHnsUOiEcLhW9Rk7xz87IBV/cGKbUDgxu8cYY0P512DWt5+Jmr8W10FDFdLmkJt1taWxNxApM2CiFPCimk02koyLZDW9nqpWNw6qS/TOYPdz438qEuamtYUJ+u6WhBjK8xAJEAt5k3gDKX+nlTiG3N6se09D62fS8CAwEAAQ==',
];
const TEST_KEYS = env('THHO_TEST_KEYS') ? JSON.parse(env('THHO_TEST_KEYS')) : null; // nur für lokale Tests
const b64bytes = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function rsaVerify(keyB64, hash, sigB64, data) {
  try {
    const key = await crypto.subtle.importKey('spki', b64bytes(keyB64), { name: 'RSASSA-PKCS1-v1_5', hash }, false, ['verify']);
    return await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64bytes(sigB64), data);
  } catch { return false; }
}
const anyKey = async (keys, hash, sig, data) => { for (const k of keys) if (await rsaVerify(k, hash, sig, data)) return true; return false; };
/**
 * Anmeldung ohne Anfrage bei Mojang (Mojang/Microsoft blockieren manche Server-Anbieter):
 * 1) Spieler-Zertifikat von Mojang (Schlüsselpaar des Spielers, von Mojang signiert) beweist die UUID,
 * 2) der Launcher signiert mit dem privaten Spieler-Schlüssel eine Nachricht mit Zeitstempel,
 * 3) die von Mojang signierten Profil-Daten (textures) beweisen den Namen.
 */
async function verifyCertAuth(b) {
  const uuid = String(b.uuid || '').replace(/-/g, '').toLowerCase();
  if (!uuidOk(uuid)) return { why: 'uuid' };
  const c = b.cert || {}, exp = Number(c.expiresAt);
  if (!(exp > Date.now()) || typeof c.publicKey !== 'string' || typeof c.signatureV2 !== 'string') return { why: 'cert' };
  const pub = b64bytes(c.publicKey);
  const data = new Uint8Array(24 + pub.length), dv = new DataView(data.buffer);
  for (let i = 0; i < 16; i++) data[i] = parseInt(uuid.slice(i * 2, i * 2 + 2), 16);
  dv.setBigInt64(16, BigInt(exp));
  data.set(pub, 24);
  if (!await anyKey(TEST_KEYS?.cert || MOJANG_CERT_KEYS, 'SHA-1', c.signatureV2, data)) return { why: 'cert-sig' };
  const ts = Number(b.ts);
  if (!(Math.abs(Date.now() - ts) < 5 * 60_000)) return { why: 'zeit' };
  if (!await rsaVerify(c.publicKey, 'SHA-256', String(b.sig || ''), new TextEncoder().encode(`thho:${uuid}:${ts}`))) return { why: 'sig' };
  const t = b.textures || {};
  if (typeof t.value !== 'string' || typeof t.signature !== 'string') return { why: 'textures' };
  if (!await anyKey(TEST_KEYS?.profile || MOJANG_PROFILE_KEYS, 'SHA-1', t.signature, new TextEncoder().encode(t.value))) return { why: 'textures-sig' };
  let tx; try { tx = JSON.parse(new TextDecoder().decode(b64bytes(t.value))); } catch { return { why: 'textures-json' }; }
  if (String(tx.profileId || '').toLowerCase() !== uuid || !/^[A-Za-z0-9_]{1,16}$/.test(tx.profileName || '')) return { why: 'textures-profil' };
  return { prof: { id: uuid, name: tx.profileName } };
}

// ---------------- Routen ----------------
async function handle(req) {
  const url = new URL(req.url);
  const p = url.pathname.replace(/\/+$/, '') || '/';
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  const store = await db();

  if (p === '/') return json({ ok: true, name: 'THHO-Netz', version: VERSION, storage: store.kind });
  // Diagnose: erreicht der Server die Mojang-/Microsoft-Dienste?
  if (p === '/diag') {
    const st = async u => { try { const r = await fetch(u, { headers: { 'User-Agent': 'THHO-Netz' } }); return r.status; } catch (e) { return String(e).slice(0, 80); } };
    return json({ version: VERSION, storage: store.kind, ai: !!globalThis.__THHO_AI, hasJoined: await st(`${MOJANG}/session/minecraft/hasJoined?username=Notch&serverId=deadbeef`), services: await st('https://api.minecraftservices.com/minecraft/profile') });
  }

  // Anmeldung: Der Launcher meldet sich vorher bei Mojang mit serverId an ("join"), wir prüfen das hier.
  if (p === '/auth' && req.method === 'POST') {
    const b0 = await body(req);
    const { name, serverId, mcToken } = b0;
    let prof = null, why = '';
    if (b0.cert) { const v = await verifyCertAuth(b0); prof = v.prof || null; if (!prof) why = 'zertifikat ' + v.why; }
    if (!prof && (!/^[A-Za-z0-9_]{1,16}$/.test(name || '') || !/^[0-9a-f]{8,40}$/.test(serverId || ''))) return json({ error: 'Minecraft-Konto konnte nicht bestätigt werden', why }, 401);
    // 1) Konto über den Minecraft-Dienst von Microsoft bestätigen (Token wird nur geprüft, nicht gespeichert)
    if (!prof && typeof mcToken === 'string' && mcToken.length > 20 && mcToken.length < 4000) {
      try {
        const r = await fetch('https://api.minecraftservices.com/minecraft/profile', { headers: { Authorization: 'Bearer ' + mcToken, 'User-Agent': 'THHO-Netz' } });
        if (r.status === 200) prof = await r.json(); else why = 'services ' + r.status;
      } catch (e) { why = 'services ' + String(e).slice(0, 60); }
    }
    // 2) sonst klassisch über Mojang (Launcher hat sich vorher mit serverId angemeldet)
    if (!prof) {
      try {
        const r = await fetch(`${MOJANG}/session/minecraft/hasJoined?username=${encodeURIComponent(name)}&serverId=${serverId}`, { headers: { 'User-Agent': 'THHO-Netz' } });
        if (r.status === 200) prof = await r.json(); else why += ' / mojang ' + r.status;
      } catch (e) { why += ' / mojang ' + String(e).slice(0, 60); }
    }
    if (prof && !b0.cert && prof.name && prof.name.toLowerCase() !== String(name).toLowerCase()) { prof = null; why += ' / name'; }
    if (!prof) return json({ error: 'Minecraft-Konto konnte nicht bestätigt werden', why }, 401);
    if (!uuidOk(prof.id)) return fail('Minecraft-Konto konnte nicht bestätigt werden', 401);
    const token = randomToken();
    await store.set(['tok', token], { uuid: prof.id, name: prof.name }, 1000 * 60 * 60 * 24 * 30);
    await store.set(['name', prof.name.toLowerCase()], { uuid: prof.id, name: prof.name });
    return json({ token, uuid: prof.id, name: prof.name });
  }

  // Eigenen Stand setzen: { cape?: id|null, emote?: id|null }
  if (p === '/me' && req.method === 'POST') {
    const me = await who(req);
    if (!me) return fail('Bitte neu anmelden', 401);
    const b = await body(req);
    const cur = (await store.get(['p', me.uuid])) || { cape: null, emote: null, emoteAt: 0 };
    if ('cape' in b) { if (!idOk(b.cape)) return fail('Ungültiges Cape'); cur.cape = b.cape; }
    if ('emote' in b) { if (!idOk(b.emote)) return fail('Ungültiges Emote'); cur.emote = b.emote; cur.emoteAt = b.emote ? Date.now() : 0; }
    if ('status' in b) cur.status = ['online', 'ingame', 'away', 'dnd', 'invisible'].includes(b.status) ? b.status : 'online';
    if ('server' in b) cur.server = typeof b.server === 'string' && /^[\w.:-]{1,80}$/.test(b.server) ? b.server : null;
    if (b.stats && typeof b.stats === 'object') cur.stats = { total: Math.max(0, Math.min(1e12, Number(b.stats.total) || 0)), week: Math.max(0, Math.min(1e10, Number(b.stats.week) || 0)), today: Math.max(0, Math.min(1e9, Number(b.stats.today) || 0)) };
    if (b.privacy && typeof b.privacy === 'object') cur.privacy = { showServer: b.privacy.showServer !== false, showPlaytime: b.privacy.showPlaytime !== false, allowJoin: b.privacy.allowJoin !== false, public: b.privacy.public !== false, live: b.privacy.live !== false };
    if (b.profile && typeof b.profile === 'object') cur.profile = cleanProfile(b.profile);
    if ('pro' in b) cur.pro = !!b.pro;
    if ('version' in b) cur.mc = typeof b.version === 'string' ? b.version.slice(0, 24) : null;
    if (b.look && typeof b.look === 'object') {
      const cols = (Array.isArray(b.look.colors) ? b.look.colors : []).filter(c => HEX.test(c)).slice(0, 8);
      const cid = x => /^k_[a-z0-9_]{1,24}$/.test(x || '') ? x : null;
      cur.look = { colors: cols, anim: ['static', 'flow', 'wave', 'pulse', 'sparkle', 'breathe'].includes(b.look.anim) ? b.look.anim : 'static', logo: b.look.logo !== false, logoColor: HEX.test(b.look.logoColor || '') ? b.look.logoColor : null, hat: cid(b.look.hat), face: cid(b.look.face), wings: cid(b.look.wings), aura: cid(b.look.aura) };
    }
    cur.uuid = me.uuid; cur.name = me.name; cur.seen = Date.now();
    await store.set(['p', me.uuid], cur, 1000 * 60 * 60 * 24 * 60);
    await store.set(['name', me.name.toLowerCase()], { uuid: me.uuid, name: me.name });
    return json({ ok: true });
  }

  // Abfrage für Spieler in der Nähe: { ids: [uuid ohne Striche, …] }
  if (p === '/q' && req.method === 'POST') {
    const { ids, names } = await body(req);
    const list = (Array.isArray(ids) ? ids : []).map(s => String(s).replace(/-/g, '').toLowerCase()).filter(uuidOk).slice(0, MAX_IDS);
    const vals = await store.many(list.map(u => ['p', u]));
    const now = Date.now(), out = {}, byName = {};
    const view = v => {
      const emoteOn = v.emote && now - v.emoteAt < 5 * 60_000;
      return { cape: v.cape || null, emote: emoteOn ? v.emote : null, ago: emoteOn ? now - v.emoteAt : 0, look: v.look || { colors: [], anim: 'static', logo: true, logoColor: null } };
    };
    list.forEach((u, i) => { const v = vals[i]; if (v) out[u] = view(v); });
    // Offline-/Proxy-Server (andere UUIDs): THHO-Spieler über den Namen finden
    const nl = (Array.isArray(names) ? names : []).map(n => String(n)).filter(n => /^[A-Za-z0-9_]{1,16}$/.test(n)).slice(0, 60);
    if (nl.length) {
      const idx = await store.many(nl.map(n => ['name', n.toLowerCase()]));
      const us = idx.map(x => x && x.uuid).filter(Boolean);
      const pv = await store.many(us.map(u => ['p', u]));
      let k = 0;
      nl.forEach((n, i) => { if (!idx[i]?.uuid) return; const v = pv[k++]; if (v && v.seen && now - v.seen < 10 * 60_000) byName[n.toLowerCase()] = { ...view(v), uuid: idx[i].uuid }; });
    }
    return json({ now, players: out, names: byName });
  }

  // ---------------- Eigene Capes (jedes Cape-Bild, auch eigene Designs) ----------------
  const cg = /^\/cape\/([0-9a-f]{32})$/.exec(p);
  if (cg && req.method === 'GET') {
    const meta = await store.get(['capeMeta', cg[1]]);
    if (!meta) return fail('Kein Cape', 404);
    const parts = [];
    for (let i = 0; i < meta.chunks; i++) { const c = await store.get(['capeData', cg[1], i]); if (!c) return fail('Kein Cape', 404); parts.push(c); }
    const out = new Uint8Array(parts.reduce((n, c) => n + c.length, 0)); let o = 0; for (const c of parts) { out.set(c, o); o += c.length; }
    return new Response(out, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=300', ...CORS } });
  }
  if (p.startsWith('/cape/') && req.method === 'POST') {
    const me = await who(req);
    if (!me) return fail('Bitte neu anmelden', 401);
    if (p === '/cape/new') {
      const { size } = await body(req);
      if (!(size > 0 && size <= 3_000_000)) return fail('Cape-Bild zu groß');
      await store.set(['capeUp', me.uuid], { chunks: Math.ceil(size / 60000), size }, 3600_000);
      return json({ chunk: 60000 });
    }
    if (p === '/cape/up') {
      const up = await store.get(['capeUp', me.uuid]); const i = Number(url.searchParams.get('i'));
      if (!up || !(i >= 0 && i < up.chunks)) return fail('Ungültiger Upload');
      const buf = new Uint8Array(await req.arrayBuffer());
      if (buf.length > 60000) return fail('Teil zu groß');
      await store.set(['capeNew', me.uuid, i], buf, 3600_000);
      return json({ ok: true });
    }
    if (p === '/cape/done') {
      const { hash } = await body(req);
      const up = await store.get(['capeUp', me.uuid]);
      if (!up || !/^[0-9a-f]{8,40}$/.test(hash || '')) return fail('Ungültiger Upload');
      for (let i = 0; i < up.chunks; i++) { const c = await store.get(['capeNew', me.uuid, i]); if (!c) return fail('Upload unvollständig'); await store.set(['capeData', me.uuid, i], c); }
      await store.set(['capeMeta', me.uuid], { chunks: up.chunks, hash });
      const cur = (await store.get(['p', me.uuid])) || { uuid: me.uuid, name: me.name };
      cur.cape = 'c' + hash.slice(0, 12);
      await store.set(['p', me.uuid], cur, 1000 * 60 * 60 * 24 * 60);
      return json({ ok: true, cape: cur.cape });
    }
  }

  // ---------------- KI-Hilfe (Cloudflare Workers AI, Binding „AI“) ----------------
  if (p === '/ai' && req.method === 'POST') {
    const me = await who(req);
    if (!me) return fail('Bitte neu anmelden', 401);
    const AI = globalThis.__THHO_AI;
    if (!AI) return fail('Die KI-Hilfe ist auf dem Server noch nicht eingeschaltet (Workers-AI-Binding „AI“ fehlt).', 503);
    const day = new Date().toISOString().slice(0, 10);
    const used = (await store.get(['aiUse', me.uuid, day])) || 0;
    if (used >= 40) return fail('Tageslimit der KI-Hilfe erreicht (40 Fragen) – morgen geht es weiter.', 429);
    await store.set(["aiUse", me.uuid, day], used + 1, 2 * 86400_000);
    const b = await body(req);
    const msgs = (Array.isArray(b.messages) ? b.messages : []).slice(-12)
      .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '').slice(0, 4000) }))
      .filter(m => m.content.trim());
    if (!msgs.length || msgs[msgs.length - 1].role !== 'user') return fail('Leere Frage');
    const c = b.ctx && typeof b.ctx === 'object' ? b.ctx : {};
    let sys = `Du bist „THHO KI“, der Assistent im THHO Client – einem Minecraft-Java-Launcher (Electron) mit eigener Fabric-Mod, Hauptversion Minecraft ${String(c.mc || '1.21.11').slice(0, 12)}.
Du beantwortest ALLE Fragen rund um Minecraft und den THHO Client ausführlich und kompetent, zum Beispiel:
- Spielmechaniken, Crafting-Rezepte, Verzauberungen, Tränke, Mobs, Biome, Strukturen, Farmen, Redstone-Schaltungen, Befehle (/commands), Datapacks, Seeds, Speedrun- und PvP-Tipps, Bauideen, Survival-Strategien.
- Java Edition-Technik: Versionen, Mods (Fabric/Forge/NeoForge/Quilt), Shader, Ressourcenpakete, Performance/FPS, Server (beitreten, eigenen Server aufsetzen, Plugins, Aternos), Fehler und Abstürze.
- Den THHO Client: Anmeldung mit Microsoft-Konto; Tab „Versionen“ (Instanzen, eigener RAM pro Instanz); Tab „Mods“ (Mods/Shader/Texturen von Modrinth installieren, an/aus schalten, aktualisieren); Tab „Skins“ (Skins & Capes); Tab „Server“ (Favoriten, direkt beitreten); Tab „Community“ (Freunde, Chat mit Bildern/Clips/Skin-Emotes, Bestenliste, Live-Status, öffentliches Profil); Tab „Clips“ (F8 ingame oder Alt+F9 speichert die letzten Sekunden); Tab „Bilder“ (Screenshots); Tab „Spielzeit“; Tab „Konsole“ (Spiel-Log); Tab „Hilfe“ (Absturz-Analyse und du); Einstellungen (RAM-Regler, Java automatisch oder eigener Pfad, Theme, Akzentfarbe, Discord-Status, Kindersicherung). Shop mit Kristallen (Namensfarben, Emotes, Capes) und THHO Pro (animierte Namen, Pro-Capes, Profil-Banner). Andere THHO-Spieler sehen Cape, Namensfarbe, Logo und Emotes. Updates installieren sich automatisch.
Regeln:
- Antworte immer auf Deutsch (außer der Nutzer schreibt in einer anderen Sprache), freundlich und gut strukturiert. Nutze Schritt-für-Schritt-Listen, wenn es hilft. Bei einfachen Fragen kurz, bei komplexen Themen (Redstone, Farmen, Server-Setup, Mods) ruhig ausführlich.
- Sei genau: Rezepte, Befehle und Werte müssen für Java Edition stimmen. Wenn sich etwas zwischen Versionen unterscheidet, sag das. Wenn du dir nicht sicher bist, sag es ehrlich statt zu raten. Erfinde keine Menüs oder Funktionen des THHO Clients.
- Keine Hilfe bei Cheats/Hacks/X-Ray auf Servern, Account-Diebstahl oder Umgehen von Bans. Nie nach Passwörtern, Tokens oder Zahlungsdaten fragen.
- Themen ohne Bezug zu Minecraft/Gaming/dem Client lehnst du freundlich ab und lenkst zurück.
System des Nutzers: Launcher ${String(c.launcher || '?').slice(0, 12)}, ${String(c.os || '?').slice(0, 20)}, RAM für Minecraft ${Number(c.ram) || '?'} MB.`;
    if (c.crash && typeof c.crash === 'object') {
      const k = c.crash;
      sys += `\n\nLetzter Absturz:\nFehler: ${String(k.error || '').slice(0, 300)}\nBeschreibung: ${String(k.description || '').slice(0, 200)}\nErkannte Ursachen: ${(Array.isArray(k.causes) ? k.causes : []).slice(0, 5).map(String).join(', ').slice(0, 300)}\nVerdächtige Mods: ${(Array.isArray(k.mods) ? k.mods : []).slice(0, 6).map(String).join(', ').slice(0, 200)}\nAuszug:\n${String(k.excerpt || '').slice(0, 2200)}`;
    }
    const run = model => AI.run(model, { messages: [{ role: 'system', content: sys }, ...msgs], max_tokens: 1800, temperature: 0.5 });
    let out;
    try { out = await run('@cf/meta/llama-3.3-70b-instruct-fp8-fast'); }
    catch { try { out = await run('@cf/meta/llama-3.1-8b-instruct'); } catch (e) { return fail('KI gerade nicht erreichbar: ' + String(e?.message || e).slice(0, 120), 502); } }
    const answer = String(out?.response || '').trim();
    if (!answer) return fail('Die KI hat keine Antwort gegeben – bitte nochmal versuchen.', 502);
    return json({ answer: answer.slice(0, 9000), left: 39 - used });
  }

  // ---------------- Bestenliste, Live, Profile ----------------
  if (p === '/leaderboard') {
    const range = url.searchParams.get('range') === 'total' ? 'total' : 'week';
    const all = (await allPlayers(store)).filter(v => priv(v).showPlaytime && priv(v).public && v.stats);
    const top = all.sort((a, b) => (b.stats[range] || 0) - (a.stats[range] || 0)).slice(0, 50)
      .map((v, i) => ({ rank: i + 1, uuid: v.uuid, name: v.name, pro: !!v.pro, ms: v.stats[range] || 0, online: !!isOnline(v) }));
    return json({ range, players: top });
  }
  if (p === '/live') {
    // Nur Freunde: wer gerade online ist
    const me = await who(req);
    if (!me) return fail('Bitte neu anmelden', 401);
    const ids = (await store.get(['fr', me.uuid])) || [];
    const vals = (await store.many(ids.map(u => ['p', u]))).filter(v => v && isOnline(v) && priv(v).live);
    return json({ players: vals.map(publicView).sort((a, b) => (b.status === 'ingame') - (a.status === 'ingame') || a.name.localeCompare(b.name)) });
  }
  const pm = /^\/(api\/)?p\/([A-Za-z0-9_]{1,16})$/.exec(p);
  if (pm) {
    const n = await store.get(['name', pm[2].toLowerCase()]);
    const v = n && await store.get(['p', n.uuid]);
    if (!v || !priv(v).public) return pm[1] ? fail('Profil nicht gefunden', 404) : new Response('Profil nicht gefunden', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    const view = publicView(v);
    return pm[1] ? json(view) : new Response(profilePage(view), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  // ---------------- Chats (nur zwischen Freunden) ----------------
  if (p.startsWith('/chat') || p.startsWith('/media')) {
    const me = await who(req);
    if (!me) return fail('Bitte neu anmelden', 401);
    const friendsOf = async u => (await store.get(['fr', u])) || [];
    const conv = (a, b) => [a, b].sort().join('_');
    const DAY = 86400_000;
    if (p === '/chat/unread') {
      const u = (await store.get(['unread', me.uuid])) || {};
      return json(u);
    }
    // Medien hochladen: /media/new → id, /media/up?id=&i= (roh, ≤ 60 KB), /media/done
    if (p === '/media/new' && req.method === 'POST') {
      const b = await body(req);
      const kind = b.kind === 'clip' ? 'clip' : 'image';
      const size = Number(b.size) || 0, max = kind === 'clip' ? 6_500_000 : 2_000_000;
      if (size <= 0 || size > max) return fail(kind === 'clip' ? 'Clip zu groß (max. 6 MB)' : 'Bild zu groß');
      const to = String(b.to || '');
      if (!(await friendsOf(me.uuid)).includes(to)) return fail('Nur an Freunde');
      const id = randomToken().slice(0, 24);
      await store.set(['mediaMeta', id], { owner: me.uuid, to, kind, mime: String(b.mime || '').slice(0, 60), size, chunks: Math.ceil(size / 60000), done: false }, 14 * DAY);
      return json({ id, chunk: 60000 });
    }
    if (p === '/media/up' && req.method === 'POST') {
      const id = url.searchParams.get('id') || '', i = Number(url.searchParams.get('i'));
      const meta = await store.get(['mediaMeta', id]);
      if (!meta || meta.owner !== me.uuid || meta.done || !(i >= 0 && i < meta.chunks)) return fail('Ungültiger Upload');
      const buf = new Uint8Array(await req.arrayBuffer());
      if (buf.length > 60000) return fail('Teil zu groß');
      await store.set(['media', id, i], buf, 14 * DAY);
      return json({ ok: true });
    }
    if (p === '/media/done' && req.method === 'POST') {
      const { id } = await body(req);
      const meta = await store.get(['mediaMeta', id]);
      if (!meta || meta.owner !== me.uuid) return fail('Ungültiger Upload');
      meta.done = true;
      await store.set(['mediaMeta', id], meta, 14 * DAY);
      return json({ ok: true });
    }
    const mm = /^\/media\/([a-f0-9]{24})$/.exec(p);
    if (mm) {
      const meta = await store.get(['mediaMeta', mm[1]]);
      if (!meta || !meta.done || (meta.owner !== me.uuid && meta.to !== me.uuid)) return fail('Nicht gefunden', 404);
      const parts = [];
      for (let i = 0; i < meta.chunks; i++) { const c = await store.get(['media', mm[1], i]); if (!c) return fail('Datei abgelaufen', 410); parts.push(c); }
      const out = new Uint8Array(parts.reduce((n, c) => n + c.length, 0)); let o = 0; for (const c of parts) { out.set(c, o); o += c.length; }
      return new Response(out, { headers: { 'Content-Type': meta.mime || 'application/octet-stream', ...CORS } });
    }
    // Nachricht senden: { to, type: text|image|clip|skin, text?, media?, emote? }
    if (p === '/chat/send' && req.method === 'POST') {
      const b = await body(req);
      const to = String(b.to || '');
      if (!(await friendsOf(me.uuid)).includes(to)) return fail('Du kannst nur Freunden schreiben');
      const type = ['text', 'image', 'clip', 'skin'].includes(b.type) ? b.type : 'text';
      const msg = { id: randomToken().slice(0, 16), from: me.uuid, name: me.name, type, t: Date.now() };
      if (type === 'text') { msg.text = String(b.text || '').slice(0, 1000).trim(); if (!msg.text) return fail('Leere Nachricht'); }
      if (type === 'image' || type === 'clip') {
        const meta = await store.get(['mediaMeta', String(b.media || '')]);
        if (!meta || meta.owner !== me.uuid || !meta.done || meta.to !== to) return fail('Datei fehlt');
        msg.media = b.media; msg.text = String(b.text || '').slice(0, 200);
      }
      if (type === 'skin') { if (!idOk(b.emote)) return fail('Ungültiges Emote'); msg.emote = b.emote; msg.emoteName = String(b.emoteName || '').slice(0, 40); }
      await store.set(['msg', conv(me.uuid, to), String(msg.t).padStart(14, '0') + msg.id], msg, 30 * DAY);
      const un = (await store.get(['unread', to])) || {};
      un[me.uuid] = (un[me.uuid] || 0) + 1;
      await store.set(['unread', to], un);
      return json({ ok: true, msg });
    }
    const cm = /^\/chat\/([0-9a-f]{32})$/.exec(p);
    if (cm) {
      if (!(await friendsOf(me.uuid)).includes(cm[1])) return fail('Nur mit Freunden', 403);
      const msgs = await store.list(['msg', conv(me.uuid, cm[1])], 100);
      const un = (await store.get(['unread', me.uuid])) || {};
      if (un[cm[1]]) { delete un[cm[1]]; await store.set(['unread', me.uuid], un); }
      return json({ messages: msgs });
    }
  }

  // ---------------- Freunde ----------------
  if (p.startsWith('/friends')) {
    const me = await who(req);
    if (!me) return fail('Bitte neu anmelden', 401);
    const list = async k => (await store.get(k)) || [];
    const save = (k, v) => store.set(k, v);
    if (p === '/friends' && req.method === 'GET') {
      const ids = await list(['fr', me.uuid]);
      const vals = await store.many(ids.map(u => ['p', u]));
      const now = Date.now();
      const friends = ids.map((u, i) => {
        const v = vals[i] || {};
        const online = isOnline(v);
        const pv = priv(v);
        return { uuid: u, name: v.name || '?', pro: !!v.pro, online: !!online, status: online ? v.status || 'online' : 'offline', server: online && pv.showServer ? v.server || null : null, joinable: !!(online && pv.showServer && pv.allowJoin && v.server), seen: v.seen || 0, stats: pv.showPlaytime ? v.stats || null : null };
      });
      return json({ me: me.name, friends, incoming: await list(['in', me.uuid]), outgoing: await list(['out', me.uuid]) });
    }
    const b = await body(req);
    const addTo = async (k, item) => { const l = (await list(k)).filter(x => (x.uuid || x) !== (item.uuid || item)); l.push(item); await save(k, l.slice(-200)); };
    const dropFrom = async (k, uuid) => save(k, (await list(k)).filter(x => (x.uuid || x) !== uuid));
    const makeFriends = async (a, b) => {
      await addTo(['fr', a], b); await addTo(['fr', b], a);
      for (const [x, y] of [[a, b], [b, a]]) { await dropFrom(['in', x], y); await dropFrom(['out', x], y); }
    };
    if (p === '/friends/add' && req.method === 'POST') {
      const name = String(b.name || '').trim().toLowerCase();
      if (!/^[a-z0-9_]{1,16}$/.test(name)) return fail('Ungültiger Spielername');
      let t = await store.get(['name', name]);
      // Fallback: der Client hat die UUID schon bei Mojang nachgeschlagen (z. B. nach Namensänderung)
      const bu = String(b.uuid || '').replace(/-/g, '').toLowerCase();
      if (!t && uuidOk(bu)) { const pv = await store.get(['p', bu]); if (pv) { t = { uuid: bu, name: pv.name || b.name }; await store.set(['name', name], t); } }
      if (!t) return fail('Diesen Spieler gibt es im THHO-Netz noch nicht – er muss den THHO Client einmal gestartet haben.', 404);
      if (t.uuid === me.uuid) return fail('Das bist du selbst 🙂');
      if ((await list(['fr', me.uuid])).includes(t.uuid)) return fail(t.name + ' ist schon dein Freund.');
      // Hat er mich schon angefragt? → sofort Freunde
      if ((await list(['in', me.uuid])).some(x => x.uuid === t.uuid)) { await makeFriends(me.uuid, t.uuid); return json({ ok: true, friends: true, name: t.name }); }
      await addTo(['in', t.uuid], { uuid: me.uuid, name: me.name, at: Date.now() });
      await addTo(['out', me.uuid], { uuid: t.uuid, name: t.name, at: Date.now() });
      return json({ ok: true, sent: true, name: t.name });
    }
    const other = String(b.uuid || '').replace(/-/g, '').toLowerCase();
    if (!uuidOk(other)) return fail('Ungültiger Spieler');
    if (p === '/friends/accept' && req.method === 'POST') {
      if (!(await list(['in', me.uuid])).some(x => x.uuid === other)) return fail('Keine Anfrage von diesem Spieler');
      await makeFriends(me.uuid, other);
      return json({ ok: true });
    }
    if (p === '/friends/decline' && req.method === 'POST') {
      await dropFrom(['in', me.uuid], other); await dropFrom(['out', other], me.uuid);
      await dropFrom(['out', me.uuid], other); await dropFrom(['in', other], me.uuid);
      return json({ ok: true });
    }
    if (p === '/friends/remove' && req.method === 'POST') {
      await dropFrom(['fr', me.uuid], other); await dropFrom(['fr', other], me.uuid);
      return json({ ok: true });
    }
  }

  return fail('Nicht gefunden', 404);
}

return handle;
