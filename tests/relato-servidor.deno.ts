// Rodar: npx -y deno@2 run --allow-env --allow-net --allow-read tests/relato-servidor.deno.ts
// Função `relato` com o Supabase e o Resend simulados.
Deno.env.set('SUPABASE_URL', 'https://proj.supabase.co');
Deno.env.set('SUPABASE_ANON_KEY', 'anon');
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'service');
Deno.env.set('RESEND_API_KEY', 're_teste');
Deno.env.set('RELATO_PARA', 'dono@exemplo.com');
const rows: any[] = [], uploads: string[] = [], emails: any[] = [];
globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
  const u = new URL(String(input instanceof Request ? input.url : input));
  const h = new Headers(init.headers);
  if (u.hostname === 'api.resend.com') { emails.push(JSON.parse(String(init.body))); return Response.json({ id: 'e1' }); }
  if (u.pathname === '/auth/v1/user') return h.get('authorization') === 'Bearer eyJ.a.b' ? Response.json({ id: 'u1', email: 'pessoa@exemplo.com' }) : new Response('{}', { status: 401 });
  if (u.pathname.startsWith('/storage/v1/object/relatos/')) { uploads.push(u.pathname.split('/relatos/')[1] + ' ' + h.get('content-type')); return Response.json({}); }
  if (u.pathname === '/rest/v1/feedback') {
    if (init.method === 'POST') { const r = { ...JSON.parse(String(init.body)), id: 'f' + (rows.length + 1) }; rows.push(r); return Response.json([r], { status: 201 }); }
    if (init.method === 'PATCH') { Object.assign(rows.find((r) => u.searchParams.get('id') === 'eq.' + r.id), JSON.parse(String(init.body))); return new Response(null, { status: 204 }); }
    return new Response('[]', { headers: { 'content-range': '0-0/0' } });
  }
  return new Response('{}', { status: 404 });
}) as typeof fetch;
let handler: (r: Request) => Promise<Response>;
(Deno as any).serve = (h: any) => { handler = h; return {} as any; };
await import('../supabase/functions/relato/index.ts');
const post = (body: unknown, auth?: string) => handler(new Request('https://x/relato', { method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) }, body: JSON.stringify(body) }));
const ok = (c: boolean, m: string) => { console.log((c ? 'ok  ' : 'FALHOU ') + m); if (!c) Deno.exitCode = 1; };
const png = btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0));
const jpg = 'data:image/jpeg;base64,' + btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8));

let r = await post({ tipo: 'problema', mensagem: 'Sincronizar dá erro', prints: [{ dados: png }, { dados: jpg }] }, 'Bearer eyJ.a.b');
ok(r.status === 200, 'relato com 2 prints aceito');
ok(rows[0].user_id === 'u1' && rows[0].kind === 'problema', 'gravado com a conta');
ok(uploads.join() === 'f1/1.png image/png,f1/2.jpg image/jpeg', 'prints no bucket relatos: ' + uploads.join());
ok(JSON.stringify(rows[0].attachments) === '["f1/1.png","f1/2.jpg"]', 'caminhos guardados no relato');
ok(emails[0]?.attachments?.length === 2 && emails[0].attachments[0].filename === 'print-1.png' && emails[0].reply_to === 'pessoa@exemplo.com' && emails[0].to[0] === 'dono@exemplo.com', 'e-mail com os prints anexados e resposta para a pessoa');
ok(rows[0].emailed === true, 'marcado como enviado por e-mail');
r = await post({ tipo: 'problema', mensagem: 'teste', prints: [{ dados: btoa('<script>alert(1)</script>') }] });
ok(r.status === 400 && /imagens/.test((await r.json()).error), 'arquivo que não é imagem é recusado');
r = await post({ tipo: 'sugestao', mensagem: 'ok', prints: [{ dados: png }, { dados: png }, { dados: png }, { dados: png }] });
ok(r.status === 400, 'mais de 3 prints é recusado');
r = await post({ tipo: 'sugestao', mensagem: 'Sem print, sem login', contato: 'eu@exemplo.com' });
ok(r.status === 200 && rows[1].user_id === null && emails[1].reply_to === 'eu@exemplo.com' && !emails[1].attachments, 'sem login e sem print também vai');
r = await post({ tipo: 'sugestao', mensagem: 'robô', site: 'http://spam' });
ok(r.status === 200 && rows.length === 2, 'campo-isca: finge que aceitou e não grava');
