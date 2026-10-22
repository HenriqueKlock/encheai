// Rodar: npx -y deno@2 run --allow-env --allow-net tests/mcp-servidor.deno.ts
// Testa o servidor MCP com o Supabase simulado (auth + PostgREST em memória).
Deno.env.set('SUPABASE_URL', 'https://proj.supabase.co');
Deno.env.set('SUPABASE_ANON_KEY', 'anon');
const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.sig';
const db: Record<string, any[]> = {
  vehicles: [{ id: 'c1', name: 'Creta', make: 'Hyundai', model: 'Creta', year: 2020, fuel_type: 'flex', archived: false, deleted_at: null, user_id: 'u1' },
             { id: 'c9', name: 'Outro', make: null, model: null, year: null, fuel_type: 'flex', archived: false, deleted_at: null, user_id: 'u2' }],
  fuel_logs: [{ id: 'f0', vehicle_id: 'c1', date: '2025-01-02', odometer_km: 1000, total_brl: 240, liters: 40, price_per_l: 6, fuel: 'gasolina', full_tank: true, station: null, note: null, deleted_at: null, user_id: 'u1' }],
  services: [], service_items: [],
};
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
  const u = new URL(String(input instanceof Request ? input.url : input));
  const auth = new Headers(init.headers).get('authorization');
  if (u.pathname === '/auth/v1/user') return auth === 'Bearer ' + TOKEN ? Response.json({ id: 'u1' }) : new Response('{}', { status: 401 });
  const t = u.pathname.replace('/rest/v1/', '');
  if (auth !== 'Bearer ' + TOKEN) return new Response('{}', { status: 401 });
  if ((init.method ?? 'GET') === 'POST') {
    for (const r of JSON.parse(String(init.body))) db[t].push({ ...r, user_id: 'u1', deleted_at: null });
    return new Response(null, { status: 201 });
  }
  // RLS: só do u1
  let rows = db[t].filter((r) => r.user_id === 'u1' && !r.deleted_at);
  const veh = u.searchParams.get('vehicle_id'); if (veh) rows = rows.filter((r) => r.vehicle_id === veh.replace('eq.', ''));
  if (t === 'services') rows = rows.map((s) => ({ ...s, service_items: db.service_items.filter((i) => i.service_id === s.id) }));
  return Response.json(rows);
}) as typeof fetch;
let handler: (r: Request) => Promise<Response>;
(Deno as any).serve = (h: any) => { handler = h; return {} as any; };
await import('../supabase/functions/mcp/index.ts');
let n = 0;
const call = async (method: string, params?: unknown, token: string | null = TOKEN) => {
  const r = await handler(new Request('https://proj.supabase.co/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method, params }) }));
  return { status: r.status, www: r.headers.get('www-authenticate'), body: r.status === 202 ? null : await r.json() };
};
const ok = (c: boolean, m: string) => { console.log((c ? 'ok  ' : 'FALHOU ') + m); if (!c) Deno.exitCode = 1; };

const noauth = await call('initialize', {}, null);
ok(noauth.status === 401 && /resource_metadata="https:\/\/proj\.supabase\.co\/functions\/v1\/mcp\/\.well-known\/oauth-protected-resource"/.test(noauth.www ?? ''), 'sem token: 401 com resource_metadata');
const meta = await (await handler(new Request('https://proj.supabase.co/mcp/.well-known/oauth-protected-resource'))).json();
ok(meta.resource === 'https://proj.supabase.co/functions/v1/mcp' && meta.authorization_servers[0] === 'https://proj.supabase.co/auth/v1', 'metadados apontam para o Supabase Auth');
const init = await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude', version: '1' } });
ok(init.body.result.protocolVersion === '2025-06-18' && init.body.result.capabilities.tools, 'initialize');
const notif = await handler(new Request('https://x/mcp', { method: 'POST', headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) }));
ok(notif.status === 202, 'notificação: 202');
const tools = await call('tools/list');
ok(tools.body.result.tools.map((t: any) => t.name).join() === 'listar_carros,instrucoes_importacao,ver_historico,conferir_importacao,importar_historico', 'tools/list');
const cars = await call('tools/call', { name: 'listar_carros', arguments: {} });
ok(cars.body.result.structuredContent.carros.length === 1 && cars.body.result.structuredContent.carros[0].abastecimentos === 1, 'listar_carros só mostra os carros da pessoa');
console.log(cars.body.result.content[0].text);
const inst = await call('tools/call', { name: 'instrucoes_importacao', arguments: {} });
ok(/Creta, flex/.test(inst.body.result.content[0].text) && /argumentos de conferir_importacao/.test(inst.body.result.content[0].text), 'instruções adaptadas às ferramentas');
const args = {
  abastecimentos: [{ data: '2025-01-02', km: 1000, litros: 40, valor_total: 240, combustivel: 'gasolina' }, { data: '2025-01-20', km: 1450, litros: 38, valor_total: 171, combustivel: 'etanol', tanque_cheio: true }],
  manutencoes: [{ data: '2025-02-01', km: 1500, oficina: 'Auto Center', os: '77', itens: [{ descricao: 'Óleo 5W30', categoria: 'oleo_motor', peca: 180, mao_de_obra: 60 }, { descricao: 'Filtro de óleo', categoria: null, peca: 40 }] }],
};
const conf = await call('tools/call', { name: 'conferir_importacao', arguments: args });
console.log(conf.body.result.content[0].text);
ok(conf.body.result.structuredContent.entram.abastecimentos === 1 && conf.body.result.structuredContent.duplicados.abastecimentos === 1 && db.fuel_logs.length === 1, 'conferir não grava e aponta duplicado');
const imp = await call('tools/call', { name: 'importar_historico', arguments: args });
ok(db.fuel_logs.length === 2 && db.services.length === 1 && db.service_items.length === 2 && db.service_items[1].plan_item_key === 'filtro_oleo', 'importar grava abastecimento, manutenção e itens (categoria deduzida)');
ok(db.fuel_logs[1].vehicle_id === 'c1' && /^[0-9a-f-]{36}$/.test(db.fuel_logs[1].id) && db.fuel_logs[1].updated_at, 'linhas com id, carro e updated_at');
ok(db.fuel_logs[1].import_source === 'claude' && /^[0-9a-f-]{36}$/.test(db.fuel_logs[1].import_batch) && db.services[0].import_batch === db.fuel_logs[1].import_batch && !db.fuel_logs[1].station_id, 'importação pelo Claude marcada com lote e origem, sem posto da rede');
const again = await call('tools/call', { name: 'importar_historico', arguments: args });
ok(/Nada novo/.test(again.body.result.content[0].text) && db.fuel_logs.length === 2, 'repetir não duplica');
const hist = await call('tools/call', { name: 'ver_historico', arguments: { carro_id: 'Creta' } });
ok(hist.body.result.structuredContent.abastecimentos.length === 2 && hist.body.result.structuredContent.manutencoes[0].itens.length === 2, 'ver_historico (carro pelo nome)');
const other = await call('tools/call', { name: 'ver_historico', arguments: { carro_id: 'c9' } });
ok(other.body.result.isError && /não encontrado/.test(other.body.result.content[0].text), 'carro de outra pessoa: não encontrado');
const empty = await call('tools/call', { name: 'conferir_importacao', arguments: {} });
ok(empty.body.result.isError, 'conferir sem dados: erro amigável');
const bad = await call('nada/isso');
ok(bad.body.error.code === -32601, 'método desconhecido');
const pr = await call('prompts/get', { name: 'importar_historico' });
ok(/Registre no Enche Aí/.test(pr.body.result.messages[0].content.text), 'prompt importar_historico');
globalThis.fetch = realFetch;
