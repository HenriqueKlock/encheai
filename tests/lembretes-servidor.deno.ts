// Rodar: npx -y deno@2 run --allow-env --allow-net --allow-read tests/lembretes-servidor.deno.ts
// Função `lembretes` com o banco e os serviços de push simulados.
Deno.env.set('SUPABASE_URL', 'https://proj.supabase.co');
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'service');
let keyRow: any = null;
const reminders: any[] = [], pushes: { host: string; auth: string }[] = [];
let subs = [
  { user_id: 'u1', endpoint: 'https://fcm.googleapis.com/fcm/send/abc' },
  { user_id: 'u1', endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/velho' },
  { user_id: 'u2', endpoint: 'https://web.push.apple.com/xyz' },
];
const due = [{ user_id: 'u1', fuel_log_id: 'f1' }, { user_id: 'u2', fuel_log_id: 'f2' }];
globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
  const u = new URL(String(input instanceof Request ? input.url : input));
  const h = new Headers(init.headers);
  if (u.hostname !== 'proj.supabase.co') {
    pushes.push({ host: u.host, auth: h.get('authorization') ?? '' });
    if (u.pathname.endsWith('/velho')) return new Response('', { status: 410 });
    if (u.host === 'web.push.apple.com') return new Response('', { status: 500 });
    return new Response('', { status: 201 });
  }
  const p = u.pathname.replace('/rest/v1/', '');
  if (p === 'push_keys') {
    if (init.method === 'POST') { keyRow ??= JSON.parse(String(init.body)); return new Response(null, { status: 201 }); }
    if (u.searchParams.get('select') === 'cron_secret') return Response.json(keyRow ? [{ cron_secret: 'segredo-do-banco-0123456789' }] : []);
    return Response.json(keyRow ? [keyRow] : []);
  }
  if (p === 'rpc/lembretes_devidos') return Response.json(due);
  if (p === 'push_subscriptions') {
    if (init.method === 'DELETE') { const e = decodeURIComponent(u.searchParams.get('endpoint')!.slice(3)); subs = subs.filter((s) => s.endpoint !== e); return new Response(null, { status: 204 }); }
    const uid = u.searchParams.get('user_id')!.slice(3);
    return Response.json(subs.filter((s) => s.user_id === uid).map((s) => ({ endpoint: s.endpoint })));
  }
  if (p === 'push_reminders') { reminders.push(JSON.parse(String(init.body))); return new Response(null, { status: 201 }); }
  return new Response('{}', { status: 404 });
}) as typeof fetch;
let handler: (r: Request) => Promise<Response>;
(Deno as any).serve = (h: any) => { handler = h; return {} as any; };
await import('../supabase/functions/lembretes/index.ts');
const ok = (c: boolean, m: string) => { console.log((c ? 'ok  ' : 'FALHOU ') + m); if (!c) Deno.exitCode = 1; };
const b64d = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

const k = await (await handler(new Request('https://x/lembretes/chave'))).json();
ok(typeof k.publicKey === 'string' && b64d(k.publicKey).length === 65 && b64d(k.publicKey)[0] === 4, 'chave pública P-256 (65 bytes, não comprimida)');
ok(!!keyRow?.private_jwk?.d, 'chave privada gerada e guardada só no banco');
const k2 = await (await handler(new Request('https://x/lembretes/chave'))).json();
ok(k2.publicKey === k.publicKey, 'a mesma chave nas próximas vezes');

const sem = await handler(new Request('https://x/lembretes', { method: 'POST' }));
const errado = await handler(new Request('https://x/lembretes', { method: 'POST', headers: { 'x-lembretes': 'segredo-do-banco-0123456780' } }));
ok(sem.status === 401 && errado.status === 401 && pushes.length === 0, 'POST sem o segredo do banco não envia nada (401)');
const r = await (await handler(new Request('https://x/lembretes', { method: 'POST', headers: { 'x-lembretes': 'segredo-do-banco-0123456789' } }))).json();
ok(r.due === 2 && r.sent === 1 && r.gone === 1, 'envia para quem está devido; resultado ' + JSON.stringify(r));
ok(reminders.length === 1 && reminders[0].fuel_log_id === 'f1', 'marca o lembrete só de quem recebeu (u2 falhou: tenta amanhã)');
ok(!subs.some((s) => s.endpoint.endsWith('/velho')), 'inscrição que não existe mais (410) é apagada');
// assinatura VAPID confere com a chave pública
const a = pushes.find((x) => x.host === 'fcm.googleapis.com')!.auth;
const m = /^vapid t=([^,]+), k=(.+)$/.exec(a)!;
ok(!!m && m[2] === k.publicKey, 'cabeçalho vapid t=…, k=chave pública');
const [h64, p64, s64] = m[1].split('.');
const payload = JSON.parse(new TextDecoder().decode(b64d(p64)));
ok(payload.aud === 'https://fcm.googleapis.com' && payload.exp > Date.now() / 1000 && payload.sub.startsWith('https://'), 'JWT com aud da origem do serviço, validade e contato');
const pub = await crypto.subtle.importKey('raw', b64d(k.publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
ok(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, b64d(s64), new TextEncoder().encode(h64 + '.' + p64)), 'assinatura ES256 válida');
