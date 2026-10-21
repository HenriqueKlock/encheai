// Conector do Enche Aí para o Claude (e outros clientes MCP): servidor MCP sem estado, por HTTP (JSON-RPC).
// Login: OAuth 2.1 do próprio Supabase Auth. O token que o Claude recebe é um token da conta da pessoa,
// então toda leitura e gravação passa pelo RLS: cada um só vê e grava o que é seu.
// Ferramentas: listar carros, ver histórico, instruções do formato, conferir e importar histórico.
// Nada aqui apaga registros.
import { aiPrompt, CATEGORIAS, FORMATO, parseImport, planImport, type Plan, type VehicleFuel } from './importacao.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const ANON = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const RESOURCE = SUPABASE_URL + '/functions/v1/mcp';
const RESOURCE_META = RESOURCE + '/.well-known/oauth-protected-resource';
const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_FILLS = 3000, MAX_SERVICES = 600;

const json = (status: number, data: unknown, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', ...extra } });

function unauthorized(msg: string) {
  return json(401, { error: 'invalid_token', error_description: msg }, {
    'WWW-Authenticate': 'Bearer resource_metadata="' + RESOURCE_META + '", error="invalid_token"',
    'Access-Control-Expose-Headers': 'WWW-Authenticate',
  });
}

/* ---------- acesso ao banco como a pessoa ---------- */

interface Ctx { token: string; userId: string }

async function userFrom(req: Request): Promise<Ctx | null> {
  const auth = req.headers.get('authorization') ?? '';
  const m = /^Bearer\s+(eyJ[\w-]+\.[\w-]+\.[\w-]+)$/.exec(auth);
  if (!m) return null;
  try {
    const r = await fetch(SUPABASE_URL + '/auth/v1/user', { headers: { apikey: ANON, Authorization: 'Bearer ' + m[1] } });
    if (!r.ok) return null;
    const u = await r.json();
    return typeof u?.id === 'string' ? { token: m[1], userId: u.id } : null;
  } catch {
    return null;
  }
}

async function rest(ctx: Ctx, path: string, init: RequestInit = {}) {
  const r = await fetch(SUPABASE_URL + '/rest/v1/' + path, {
    ...init,
    headers: { apikey: ANON, Authorization: 'Bearer ' + ctx.token, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  const body = r.status === 204 ? null : await r.text();
  if (!r.ok) throw new Error('Banco respondeu ' + r.status + (body ? ': ' + body.slice(0, 300) : ''));
  return body ? JSON.parse(body) : null;
}

interface Car { id: string; name: string; make: string | null; model: string | null; year: number | null; fuel_type: VehicleFuel; archived: boolean }

async function cars(ctx: Ctx): Promise<Car[]> {
  return rest(ctx, 'vehicles?select=id,name,make,model,year,fuel_type,archived&deleted_at=is.null&order=name');
}

async function carOr(ctx: Ctx, id: unknown): Promise<Car> {
  const all = (await cars(ctx)).filter((c) => !c.archived);
  if (typeof id === 'string' && id) {
    const c = all.find((x) => x.id === id || x.name.toLowerCase() === id.toLowerCase());
    if (!c) throw new UserError('Carro não encontrado. Use listar_carros para ver os carros da conta.');
    return c;
  }
  if (all.length === 1) return all[0];
  if (!all.length) throw new UserError('A conta ainda não tem carro cadastrado. Cadastre o carro no app Enche Aí primeiro (Perfil › Carros).');
  throw new UserError('A conta tem mais de um carro: ' + all.map((c) => c.name).join(', ') + '. Pergunte qual e informe carro_id.');
}

class UserError extends Error {}

async function existingFor(ctx: Ctx, carId: string) {
  const [fills, services] = await Promise.all([
    rest(ctx, 'fuel_logs?select=date,odometer_km,total_brl&deleted_at=is.null&vehicle_id=eq.' + carId + '&limit=20000'),
    rest(ctx, 'services?select=date,odometer_km,shop&deleted_at=is.null&vehicle_id=eq.' + carId + '&limit=5000'),
  ]);
  return {
    fills: (fills as any[]).map((f) => ({ date: f.date, odometer_km: Number(f.odometer_km), total_brl: Number(f.total_brl) })),
    services: (services as any[]).map((s) => ({ date: s.date, odometer_km: s.odometer_km == null ? null : Number(s.odometer_km), shop: s.shop })),
  };
}

async function planFor(ctx: Ctx, args: Record<string, unknown>) {
  const car = await carOr(ctx, args.carro_id);
  const fills = Array.isArray(args.abastecimentos) ? args.abastecimentos : [];
  const svcs = Array.isArray(args.manutencoes) ? args.manutencoes : [];
  if (!fills.length && !svcs.length) throw new UserError('Nada para conferir: envie "abastecimentos" e/ou "manutencoes".');
  if (fills.length > MAX_FILLS || svcs.length > MAX_SERVICES) throw new UserError('Lote grande demais: mande no máximo ' + MAX_FILLS + ' abastecimentos e ' + MAX_SERVICES + ' manutenções por vez.');
  const parsed = parseImport({ formato: FORMATO, abastecimentos: fills, manutencoes: svcs, avisos: args.avisos });
  const plan = planImport(parsed, await existingFor(ctx, car.id), car.fuel_type);
  return { car, plan };
}

const brl = (n: number) => 'R$ ' + n.toFixed(2).replace('.', ',');
const dmy = (iso: string) => iso.slice(8, 10) + '/' + iso.slice(5, 7) + '/' + iso.slice(0, 4);

function summary(car: Car, p: Plan, done: boolean) {
  const items = p.services.reduce((a, s) => a + s.items.length, 0);
  const planned = p.services.reduce((a, s) => a + s.items.filter((i) => i.plan_item_key).length, 0);
  const dates = p.fills.map((f) => f.date).sort();
  const lines = [
    (done ? 'Gravado no ' : 'Vai entrar no ') + car.name + ':',
    '- ' + p.fills.length + ' abastecimento(s)' + (dates.length ? ' de ' + dmy(dates[0]) + ' a ' + dmy(dates[dates.length - 1]) : ''),
    '- ' + p.services.length + ' manutenção(ões), ' + items + ' item(ns)' + (planned ? ' (' + planned + ' no plano de manutenção)' : ''),
  ];
  if (p.dupFills || p.dupServices) lines.push('- Já existiam e ficaram de fora: ' + p.dupFills + ' abastecimento(s), ' + p.dupServices + ' manutenção(ões)');
  if (p.warnings.length) lines.push('', 'Avisos:', ...p.warnings.slice(0, 30).map((w) => '- ' + w), ...(p.warnings.length > 30 ? ['- … e mais ' + (p.warnings.length - 30)] : []));
  if (!done && (p.fills.length || p.services.length)) lines.push('', 'Mostre este resumo à pessoa e só chame importar_historico depois que ela confirmar.');
  if (done) lines.push('', 'Os registros aparecem no app na próxima sincronização (ao abrir o app).');
  return lines.join('\n');
}

async function write(ctx: Ctx, car: Car, p: Plan) {
  const now = new Date().toISOString();
  const fills = p.fills.map((f) => ({
    id: crypto.randomUUID(), vehicle_id: car.id, date: f.date, odometer_km: f.odometer_km, liters: f.liters, total_brl: f.total_brl,
    price_per_l: f.price_per_l, fuel: f.fuel, full_tank: f.full_tank, station: f.station, note: f.note, updated_at: now,
  }));
  for (let i = 0; i < fills.length; i += 500) await rest(ctx, 'fuel_logs', { method: 'POST', body: JSON.stringify(fills.slice(i, i + 500)), headers: { Prefer: 'return=minimal' } });
  const svcs: Record<string, unknown>[] = [], items: Record<string, unknown>[] = [];
  for (const s of p.services) {
    const id = crypto.randomUUID();
    svcs.push({ id, vehicle_id: car.id, date: s.date, odometer_km: s.odometer_km, shop: s.shop, os_number: s.os_number, type: s.type, note: s.note, updated_at: now });
    s.items.forEach((it, position) => items.push({ id: crypto.randomUUID(), service_id: id, description: it.description, plan_item_key: it.plan_item_key, parts_brl: it.parts_brl, labor_brl: it.labor_brl, position, updated_at: now }));
  }
  for (let i = 0; i < svcs.length; i += 300) await rest(ctx, 'services', { method: 'POST', body: JSON.stringify(svcs.slice(i, i + 300)), headers: { Prefer: 'return=minimal' } });
  for (let i = 0; i < items.length; i += 500) await rest(ctx, 'service_items', { method: 'POST', body: JSON.stringify(items.slice(i, i + 500)), headers: { Prefer: 'return=minimal' } });
}

/* ---------- ferramentas ---------- */

const FILL_SCHEMA = {
  type: 'object',
  properties: {
    data: { type: 'string', description: 'AAAA-MM-DD' },
    km: { type: 'number', description: 'Odômetro no abastecimento' },
    litros: { type: ['number', 'null'] },
    valor_total: { type: ['number', 'null'], description: 'Valor pago, em reais' },
    preco_litro: { type: ['number', 'null'] },
    combustivel: { type: 'string', enum: ['gasolina', 'etanol', 'diesel', 'gnv'] },
    tanque_cheio: { type: 'boolean', description: 'false só quando indicado que foi parcial' },
    posto: { type: ['string', 'null'] },
    obs: { type: ['string', 'null'] },
  },
  required: ['data', 'km'],
};
const SERVICE_SCHEMA = {
  type: 'object',
  properties: {
    data: { type: 'string', description: 'AAAA-MM-DD' },
    km: { type: ['number', 'null'] },
    oficina: { type: ['string', 'null'] },
    os: { type: ['string', 'null'], description: 'Número da ordem de serviço' },
    itens: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          descricao: { type: 'string', description: 'Como está na OS' },
          categoria: { type: ['string', 'null'], enum: [...Object.keys(CATEGORIAS), null], description: 'Item do plano de manutenção, ou null' },
          peca: { type: ['number', 'null'], description: 'Valor total da linha em peças' },
          mao_de_obra: { type: ['number', 'null'], description: 'Valor total da linha em mão de obra' },
        },
        required: ['descricao'],
      },
    },
    obs: { type: ['string', 'null'] },
  },
  required: ['data', 'itens'],
};
const IMPORT_INPUT = {
  type: 'object',
  properties: {
    carro_id: { type: 'string', description: 'id do carro (de listar_carros). Pode omitir se a conta tiver um carro só.' },
    abastecimentos: { type: 'array', items: FILL_SCHEMA },
    manutencoes: { type: 'array', items: SERVICE_SCHEMA },
    avisos: { type: 'array', items: { type: 'string' }, description: 'O que ficou incompleto ou duvidoso no material' },
  },
};

const TOOLS = [
  {
    name: 'listar_carros',
    title: 'Listar carros',
    description: 'Lista os carros da conta do Enche Aí, com quantos abastecimentos e manutenções cada um já tem. Use antes de importar para saber o carro_id.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'instrucoes_importacao',
    title: 'Como ler o material',
    description: 'Regras para extrair abastecimentos e manutenções de planilhas, fotos de OS e anotações no formato que o Enche Aí grava. Leia antes de montar os dados.',
    inputSchema: { type: 'object', properties: { carro_id: { type: 'string' } } },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'ver_historico',
    title: 'Ver histórico',
    description: 'Abastecimentos e manutenções já registrados num carro (para conferir, comparar ou analisar consumo e gastos).',
    inputSchema: { type: 'object', properties: { carro_id: { type: 'string' }, desde: { type: 'string', description: 'AAAA-MM-DD (opcional)' } } },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'conferir_importacao',
    title: 'Conferir antes de gravar',
    description: 'Confere os dados extraídos sem gravar nada: quantos entram, quais já existem (duplicados ficam de fora) e avisos como km fora de ordem ou preço estranho. Sempre chame antes de importar_historico e mostre o resumo à pessoa.',
    inputSchema: IMPORT_INPUT,
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'importar_historico',
    title: 'Gravar histórico',
    description: 'Grava no carro os abastecimentos e manutenções conferidos. Pula o que já existe (pode repetir sem duplicar). Só chame depois de a pessoa confirmar o resumo de conferir_importacao.',
    inputSchema: IMPORT_INPUT,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

const INSTRUCTIONS = [
  'Enche Aí é um app de controle do carro (abastecimentos, consumo e manutenção). Com este conector você lê e registra o histórico do carro da pessoa.',
  'Para importar: 1) listar_carros (se houver mais de um carro, pergunte qual); 2) leia os arquivos seguindo instrucoes_importacao;',
  '3) conferir_importacao e mostre o resumo; 4) só depois da confirmação, importar_historico.',
  'Nunca invente valores; ignore nome, CPF, telefone, endereço e placa. Lotes grandes podem ser enviados em partes.',
].join(' ');

const toolInstructions = (car?: { name: string; fuel_type: VehicleFuel } | null) =>
  aiPrompt(car)
    .replace('Devolva APENAS um bloco ```json``` neste formato:', 'Monte os dados neste formato (os campos de "abastecimentos" e "manutencoes" são os argumentos de conferir_importacao e importar_historico):')
    .replace('Anexei planilhas, fotos de ordens de serviço (OS) e/ou anotações.', 'O material são planilhas, fotos de ordens de serviço (OS) e/ou anotações que a pessoa anexou.');

async function callTool(ctx: Ctx, name: string, args: Record<string, unknown>) {
  const text = (t: string, structured?: unknown) => ({ content: [{ type: 'text', text: t }], ...(structured ? { structuredContent: structured } : {}) });
  switch (name) {
    case 'listar_carros': {
      const all = (await cars(ctx)).filter((c) => !c.archived);
      if (!all.length) return text('A conta ainda não tem carro cadastrado. Cadastre no app Enche Aí (Perfil › Carros) e tente de novo.', { carros: [] });
      const out = [];
      for (const c of all) {
        const ex = await existingFor(ctx, c.id);
        const kms = ex.fills.map((f) => f.odometer_km);
        out.push({ carro_id: c.id, nome: c.name, marca: c.make, modelo: c.model, ano: c.year, combustivel: c.fuel_type, abastecimentos: ex.fills.length, manutencoes: ex.services.length, km_atual: kms.length ? Math.max(...kms) : null });
      }
      return text(out.map((c) => '- ' + c.nome + ' (' + [c.marca, c.modelo, c.ano].filter(Boolean).join(' ') + ', ' + c.combustivel + ') · carro_id ' + c.carro_id + ' · ' + c.abastecimentos + ' abastecimentos, ' + c.manutencoes + ' manutenções' + (c.km_atual ? ' · ' + c.km_atual + ' km' : '')).join('\n'), { carros: out });
    }
    case 'instrucoes_importacao': {
      let car: Car | null = null;
      try { car = await carOr(ctx, args.carro_id); } catch { /* sem carro definido: instruções gerais */ }
      return text(toolInstructions(car));
    }
    case 'ver_historico': {
      const car = await carOr(ctx, args.carro_id);
      const since = typeof args.desde === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(args.desde) ? '&date=gte.' + args.desde : '';
      const [fills, svcs] = await Promise.all([
        rest(ctx, 'fuel_logs?select=date,odometer_km,liters,total_brl,price_per_l,fuel,full_tank,station,note&deleted_at=is.null&vehicle_id=eq.' + car.id + since + '&order=date.asc,odometer_km.asc&limit=3000'),
        rest(ctx, 'services?select=id,date,odometer_km,shop,os_number,type,note,service_items(description,plan_item_key,parts_brl,labor_brl,deleted_at)&deleted_at=is.null&vehicle_id=eq.' + car.id + since + '&order=date.asc&limit=600'),
      ]);
      const manut = (svcs as any[]).map((s) => ({ data: s.date, km: s.odometer_km, oficina: s.shop, os: s.os_number, tipo: s.type, obs: s.note, itens: (s.service_items ?? []).filter((i: any) => !i.deleted_at).map((i: any) => ({ descricao: i.description, categoria: i.plan_item_key, peca: Number(i.parts_brl), mao_de_obra: Number(i.labor_brl) })) }));
      const abast = (fills as any[]).map((f) => ({ data: f.date, km: f.odometer_km, litros: Number(f.liters), valor_total: Number(f.total_brl), preco_litro: Number(f.price_per_l), combustivel: f.fuel, tanque_cheio: f.full_tank, posto: f.station, obs: f.note }));
      const total = abast.reduce((a, f) => a + f.valor_total, 0);
      return text(car.name + ': ' + abast.length + ' abastecimentos (' + brl(total) + ') e ' + manut.length + ' manutenções' + (since ? ' desde ' + dmy(String(args.desde)) : '') + '. Dados completos em structuredContent.', { carro: car.name, abastecimentos: abast, manutencoes: manut });
    }
    case 'conferir_importacao': {
      const { car, plan } = await planFor(ctx, args);
      return text(summary(car, plan, false), { carro_id: car.id, entram: { abastecimentos: plan.fills.length, manutencoes: plan.services.length }, duplicados: { abastecimentos: plan.dupFills, manutencoes: plan.dupServices }, avisos: plan.warnings });
    }
    case 'importar_historico': {
      const { car, plan } = await planFor(ctx, args);
      if (plan.fills.length || plan.services.length) await write(ctx, car, plan);
      return text(plan.fills.length || plan.services.length ? summary(car, plan, true) : 'Nada novo: tudo já estava registrado no ' + car.name + '.', { gravados: { abastecimentos: plan.fills.length, manutencoes: plan.services.length } });
    }
    default:
      throw new RpcError(-32602, 'Ferramenta desconhecida: ' + name);
  }
}

class RpcError extends Error {
  constructor(public code: number, message: string) { super(message); }
}

/* ---------- JSON-RPC ---------- */

async function handle(ctx: Ctx, msg: any): Promise<unknown | undefined> {
  const { id, method, params } = msg ?? {};
  if (typeof method !== 'string') throw new RpcError(-32600, 'Pedido inválido');
  if (id === undefined || id === null) return undefined; // notificação: sem resposta
  switch (method) {
    case 'initialize': {
      const asked = String(params?.protocolVersion ?? '');
      return {
        protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
        capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
        serverInfo: { name: 'enche-ai', title: 'Enche Aí', version: '1.0.0' },
        instructions: INSTRUCTIONS,
      };
    }
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOOLS };
    case 'tools/call': {
      const name = String(params?.name ?? '');
      const args = (params?.arguments && typeof params.arguments === 'object' ? params.arguments : {}) as Record<string, unknown>;
      if (!TOOLS.some((t) => t.name === name)) throw new RpcError(-32602, 'Ferramenta desconhecida: ' + name);
      try {
        return await callTool(ctx, name, args);
      } catch (e) {
        if (e instanceof RpcError) throw e;
        console.error(JSON.stringify({ event: 'mcp-tool-error', tool: name, message: (e as Error).message.slice(0, 300) }));
        return { content: [{ type: 'text', text: e instanceof UserError ? e.message : 'Não deu certo agora: ' + (e as Error).message }], isError: true };
      }
    }
    case 'prompts/list':
      return { prompts: [{ name: 'importar_historico', title: 'Importar histórico do carro', description: 'Lê planilhas, fotos de OS e anotações anexadas e registra no Enche Aí, com conferência antes de gravar.' }] };
    case 'prompts/get':
      if (params?.name !== 'importar_historico') throw new RpcError(-32602, 'Prompt desconhecido');
      return {
        description: 'Importar histórico do carro',
        messages: [{ role: 'user', content: { type: 'text', text: 'Registre no Enche Aí o histórico dos arquivos que anexei.\n\n' + INSTRUCTIONS + '\n\n' + toolInstructions(null) } }],
      };
    case 'resources/list':
      return { resources: [] };
    default:
      throw new RpcError(-32601, 'Método não suportado: ' + method);
  }
}

Deno.serve(async (req) => {
  const path = new URL(req.url).pathname;
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type, mcp-protocol-version, mcp-session-id', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' } });
  }
  // metadados do recurso protegido (RFC 9728): onde fica o servidor de login
  if (path.endsWith('/.well-known/oauth-protected-resource')) {
    return json(200, {
      resource: RESOURCE,
      authorization_servers: [SUPABASE_URL + '/auth/v1'],
      bearer_methods_supported: ['header'],
      scopes_supported: ['openid', 'email', 'profile'],
      resource_name: 'Enche Aí',
      resource_documentation: 'https://henriqueklock.github.io/encheai/',
    });
  }
  if (req.method === 'GET') return new Response('Use POST (MCP Streamable HTTP).', { status: 405, headers: { Allow: 'POST' } });
  if (req.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });

  const ctx = await userFrom(req);
  if (!ctx) return unauthorized('Conecte a sua conta do Enche Aí.');

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON inválido' } });
  }
  const batch = Array.isArray(body);
  const msgs = (batch ? body : [body]) as any[];
  const out: unknown[] = [];
  for (const m of msgs) {
    try {
      const result = await handle(ctx, m);
      if (result !== undefined) out.push({ jsonrpc: '2.0', id: m.id, result });
    } catch (e) {
      const err = e instanceof RpcError ? e : new RpcError(-32603, (e as Error).message);
      if (m?.id !== undefined && m?.id !== null) out.push({ jsonrpc: '2.0', id: m.id, error: { code: err.code, message: err.message } });
    }
  }
  if (!out.length) return new Response(null, { status: 202, headers: { 'Access-Control-Allow-Origin': '*' } });
  return json(200, batch ? out : out[0]);
});
