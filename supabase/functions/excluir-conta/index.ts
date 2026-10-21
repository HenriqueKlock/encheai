// Edge Function: exclui a conta de quem está logado e TUDO o que ela registrou.
// Todas as tabelas apontam para auth.users com ON DELETE CASCADE, então apagar o usuário apaga
// carros, abastecimentos, manutenções, locais, avaliações e cotas. Os números da rede são
// recalculados em até 15 minutos e deixam de contar essa pessoa.
// Exige confirmação explícita no corpo ({ "confirmar": "EXCLUIR" }) para não ser disparada por engano.
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

const ALLOWED_ORIGINS = ['https://henriqueklock.github.io', 'http://localhost:5173', 'http://localhost:4173'];

function cors(origin: string | null) {
  return {
    'Access-Control-Allow-Origin': origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
}

async function currentUser(req: Request): Promise<string | null> {
  const url = Deno.env.get('SUPABASE_URL');
  const auth = req.headers.get('authorization') ?? '';
  const apikey = req.headers.get('apikey') ?? Deno.env.get('SUPABASE_ANON_KEY') ?? '';
  if (!url || !/^Bearer eyJ/.test(auth)) return null;
  try {
    const r = await fetch(url + '/auth/v1/user', { headers: { apikey, Authorization: auth } });
    if (!r.ok) return null;
    const u = await r.json();
    return typeof u?.id === 'string' ? u.id : null;
  } catch {
    return null;
  }
}

/** Token emitido para um app conectado (OAuth do Supabase) traz o claim client_id. */
function fromConnectedApp(req: Request): boolean {
  try {
    const part = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/, '').split('.')[1] ?? '';
    const claims = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=')));
    return !!claims?.client_id;
  } catch {
    return true; // sem conseguir ler, não arrisca
  }
}

Deno.serve(async (req) => {
  const headers = cors(req.headers.get('origin'));
  if (req.method === 'OPTIONS') return new Response('ok', { headers });
  const json = (status: number, data: unknown) =>
    new Response(JSON.stringify(data), { status, headers: { ...headers, 'Content-Type': 'application/json' } });
  if (req.method !== 'POST') return json(405, { error: 'Use POST.' });

  const uid = await currentUser(req);
  if (!uid) return json(401, { error: 'Entre na sua conta para excluir.' });
  // Só o próprio app exclui a conta: token de app conectado (OAuth, com client_id) não pode
  if (fromConnectedApp(req)) return json(403, { error: 'Apps conectados não podem excluir a conta.' });

  let b: any = {};
  try {
    b = await req.json();
  } catch {
    /* sem corpo */
  }
  if (b?.confirmar !== 'EXCLUIR') return json(400, { error: 'Confirmação ausente.' });

  const url = Deno.env.get('SUPABASE_URL');
  const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !service) return json(500, { error: 'Servidor sem configuração.' });

  // Arquivos de OS (Storage não apaga em cascata): lista a pasta do usuário e remove tudo
  const admin = { apikey: service, Authorization: 'Bearer ' + service, 'Content-Type': 'application/json' };
  try {
    for (let round = 0; round < 20; round++) {
      const l = await fetch(url + '/storage/v1/object/list/os', { method: 'POST', headers: admin, body: JSON.stringify({ prefix: uid + '/', limit: 1000 }) });
      const files: { name: string }[] = l.ok ? await l.json() : [];
      if (!files.length) break;
      const del = await fetch(url + '/storage/v1/object/os', { method: 'DELETE', headers: admin, body: JSON.stringify({ prefixes: files.map((f) => uid + '/' + f.name) }) });
      if (!del.ok) throw new Error('storage ' + del.status);
    }
  } catch (e) {
    console.error(JSON.stringify({ event: 'excluir-conta-arquivos', error: String(e) }));
    return json(502, { error: 'Não deu para apagar os arquivos agora. Tente de novo em instantes.' });
  }

  const r = await fetch(url + '/auth/v1/admin/users/' + uid, {
    method: 'DELETE',
    headers: { apikey: service, Authorization: 'Bearer ' + service },
  });
  if (!r.ok) {
    console.error(JSON.stringify({ event: 'excluir-conta-erro', status: r.status }));
    return json(502, { error: 'Não deu para excluir agora. Tente de novo em instantes.' });
  }
  console.log(JSON.stringify({ event: 'excluir-conta' }));
  return json(200, { ok: true });
});
