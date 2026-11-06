const WEB_API_KEY = 'AIzaSyCmtleP8R7OjvmeNbgSs2_gRwzLxRPA5wI';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const out = (text, status) => new Response(text, { status, headers: CORS });

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
  const j = await r.json();
  const u = (j.users || [])[0];
  return u ? { uid: u.localId, email: (u.email || '').toLowerCase() } : null;
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return out('Method not allowed', 405);

  const user = await whoIs(req);
  if (!user) return out('Sign in required', 401);

  const key = process.env.GEMINI_API_KEY;
  if (!key) return out('Server is not set up yet', 500);

  let b;
  try { b = await req.json(); } catch { return out('Bad request', 400); }

  const model = String(b.model || '');
  if (!/^gemini-[a-z0-9.\-]+$/.test(model)) return out('Bad model', 400);
  const p = b.payload;
  if (!p || !Array.isArray(p.contents)) return out('Bad request', 400);
  if (JSON.stringify(p).length > 3000000) return out('Too large', 413);

  delete p.tools;
  p.generationConfig = { ...(p.generationConfig || {}), maxOutputTokens: 4096 };

  const up = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':streamGenerateContent?alt=sse',
    { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(p) }
  );
  return new Response(up.body, {
    status: up.status,
    headers: { ...CORS, 'Content-Type': up.headers.get('content-type') || 'text/event-stream', 'Cache-Control': 'no-store' },
  });
};
