// Lembretes por notificação (Web Push, padrão VAPID, sem conteúdo cifrado: o aviso é sempre o mesmo e
// o app mostra o resto). GET …/lembretes/chave devolve a chave pública para o aparelho se inscrever.
// POST …/lembretes (chamado uma vez por dia pelo pg_cron) envia os lembretes devidos: abastecimento com
// posto de 1 a 5 dias atrás, sem resposta do "como o carro andou". Cada abastecimento recebe um lembrete
// no máximo, então chamar de novo não repete nada. As chaves VAPID são geradas aqui e ficam no banco
// (tabela push_keys, só a chave de serviço lê); nunca passam pelo repositório. O POST só vale com o cabeçalho
// x-lembretes igual ao segredo da mesma tabela, que só o próprio banco (o pg_cron) conhece.
const URL_ = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUBJECT = 'https://henriqueklock.github.io/encheai/';
const admin = { apikey: SERVICE, Authorization: 'Bearer ' + SERVICE, 'Content-Type': 'application/json' };

const b64url = (b: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(b instanceof Uint8Array ? b : new Uint8Array(b)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));

async function rest(path: string, init: RequestInit = {}) {
  const r = await fetch(URL_ + '/rest/v1/' + path, { ...init, headers: { ...admin, ...(init.headers ?? {}) } });
  const t = r.status === 204 ? '' : await r.text();
  if (!r.ok) throw new Error('banco ' + r.status + ': ' + t.slice(0, 200));
  return t ? JSON.parse(t) : null;
}

let keys: { publicKey: string; jwk: JsonWebKey } | null = null;
export async function ensureKeys() {
  if (keys) return keys;
  let row = (await rest('push_keys?id=eq.1&select=public_key,private_jwk'))?.[0];
  if (!row) {
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
    const pub = b64url(await crypto.subtle.exportKey('raw', kp.publicKey));
    const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
    await rest('push_keys', { method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' }, body: JSON.stringify({ id: 1, public_key: pub, private_jwk: jwk }) });
    row = (await rest('push_keys?id=eq.1&select=public_key,private_jwk'))[0];
  }
  keys = { publicKey: row.public_key, jwk: row.private_jwk };
  return keys;
}

/** JWT do VAPID (RFC 8292), assinado com ES256 para a origem do serviço de push. */
export async function vapidAuth(endpoint: string) {
  const k = await ensureKeys();
  const key = await crypto.subtle.importKey('jwk', k.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const body = enc({ typ: 'JWT', alg: 'ES256' }) + '.' + enc({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: SUBJECT });
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(body));
  return 'vapid t=' + body + '.' + b64url(sig) + ', k=' + k.publicKey;
}

/** Envia um aviso sem conteúdo. true = entregue; 'gone' = inscrição não existe mais. */
async function push(endpoint: string): Promise<true | false | 'gone'> {
  try {
    const r = await fetch(endpoint, { method: 'POST', headers: { TTL: '172800', Urgency: 'normal', Authorization: await vapidAuth(endpoint), 'Content-Length': '0' } });
    if (r.status === 404 || r.status === 410) return 'gone';
    if (!r.ok) console.error(JSON.stringify({ event: 'lembrete-push-erro', status: r.status, host: new URL(endpoint).host }));
    return r.ok;
  } catch (e) {
    console.error(JSON.stringify({ event: 'lembrete-push-erro', error: String(e).slice(0, 200) }));
    return false;
  }
}

async function sendDue() {
  const due: { user_id: string; fuel_log_id: string }[] = await rest('rpc/lembretes_devidos', { method: 'POST', body: '{}' });
  let sent = 0, gone = 0;
  for (const d of due.slice(0, 500)) {
    const subs: { endpoint: string }[] = await rest('push_subscriptions?select=endpoint&user_id=eq.' + d.user_id);
    let ok = false;
    for (const s of subs) {
      const r = await push(s.endpoint);
      if (r === true) ok = true;
      if (r === 'gone') {
        gone++;
        await rest('push_subscriptions?endpoint=eq.' + encodeURIComponent(s.endpoint), { method: 'DELETE' });
      }
    }
    if (ok) {
      sent++;
      await rest('push_reminders', { method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' }, body: JSON.stringify({ fuel_log_id: d.fuel_log_id, user_id: d.user_id }) });
    }
  }
  return { due: due.length, sent, gone };
}

function timingSafe(a: string, b: string) {
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

Deno.serve(async (req) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
  const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (!URL_ || !SERVICE) return json(500, { error: 'Servidor sem configuração.' });
  try {
    if (req.method === 'GET' && new URL(req.url).pathname.endsWith('/chave')) {
      return json(200, { publicKey: (await ensureKeys()).publicKey });
    }
    if (req.method === 'POST') {
      const given = req.headers.get('x-lembretes') ?? '';
      const secret: string = (await rest('push_keys?id=eq.1&select=cron_secret'))?.[0]?.cron_secret ?? '';
      if (!secret || given.length !== secret.length || !timingSafe(given, secret)) return json(401, { error: 'Não autorizado.' });
      const r = await sendDue();
      console.log(JSON.stringify({ event: 'lembretes', ...r }));
      return json(200, r);
    }
    return json(405, { error: 'Use GET …/chave ou POST.' });
  } catch (e) {
    console.error(JSON.stringify({ event: 'lembretes-erro', error: String(e).slice(0, 300) }));
    return json(500, { error: 'Não deu certo agora.' });
  }
});
