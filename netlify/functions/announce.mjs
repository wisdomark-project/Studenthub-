import crypto from 'node:crypto';

const PROJECT = 'studenthub-8af70';
const WEB_API_KEY = 'AIzaSyCmtleP8R7OjvmeNbgSs2_gRwzLxRPA5wI';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

async function whoIs(req) {
  const h = req.headers.get('authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) return null;
  const r = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + WEB_API_KEY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken: token }),
  });
  if (!r.ok) return null;
  const u = ((await r.json()).users || [])[0];
  return u ? { email: (u.email || '').toLowerCase(), verified: !!u.emailVerified } : null;
}

const b64u = (x) => Buffer.from(x).toString('base64url');

async function accessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64u(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3000,
  }));
  const sig = crypto.createSign('RSA-SHA256').update(head + '.' + claim).sign(sa.private_key, 'base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + head + '.' + claim + '.' + sig,
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('Could not sign in to Google with the service account');
  return j.access_token;
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const me = await whoIs(req);
  const admin = (process.env.ADMIN_EMAIL || '').toLowerCase();
  if (!me || !me.verified || !admin || me.email !== admin) return json({ error: 'Not allowed' }, 403);

  let text = '';
  try { text = String((await req.json()).text || '').trim().slice(0, 300); } catch {}
  if (!text) return json({ error: 'No message' }, 400);

  let sa;
  try { sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || ''); } catch { return json({ error: 'Service account not set up' }, 500); }

  let at;
  try { at = await accessToken(sa); } catch (e) { return json({ error: String(e.message) }, 500); }
  const auth = { Authorization: 'Bearer ' + at };

  const tokens = [];
  let page = '';
  do {
    const r = await fetch(
      'https://firestore.googleapis.com/v1/projects/' + PROJECT + '/databases/(default)/documents/tokens?pageSize=300&mask.fieldPaths=ts' +
        (page ? '&pageToken=' + encodeURIComponent(page) : ''),
      { headers: auth }
    );
    const j = await r.json();
    (j.documents || []).forEach((d) => tokens.push(d.name.split('/').pop()));
    page = j.nextPageToken || '';
  } while (page && tokens.length < 3000);

  let sent = 0, failed = 0;
  const sendOne = async (t) => {
    const r = await fetch('https://fcm.googleapis.com/v1/projects/' + PROJECT + '/messages:send', {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          token: t,
          data: { title: 'StudentHub', body: text },
          webpush: { headers: { Urgency: 'high', TTL: '86400' } },
        },
      }),
    });
    if (r.ok) { sent++; return; }
    failed++;
    if (r.status === 404 || r.status === 400) {
      await fetch('https://firestore.googleapis.com/v1/projects/' + PROJECT + '/databases/(default)/documents/tokens/' + encodeURIComponent(t), {
        method: 'DELETE',
        headers: auth,
      }).catch(() => {});
    }
  };
  for (let i = 0; i < tokens.length; i += 25) {
    await Promise.all(tokens.slice(i, i + 25).map(sendOne));
  }
  return json({ sent, failed, total: tokens.length });
};
