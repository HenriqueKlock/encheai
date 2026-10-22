// Importação de histórico: o formato que a IA devolve (encheai-importacao-1), planilhas e o conector do Claude
// passam por aqui. Puro e sem dependências: o mesmo arquivo roda no app e na função `mcp` do servidor
// (supabase/functions/mcp/importacao.ts é uma cópia, conferida nos testes).

export const FORMATO = 'encheai-importacao-1';

export type Fuel = 'gasolina' | 'etanol' | 'diesel' | 'gnv';
export type VehicleFuel = 'flex' | 'gasolina' | 'etanol' | 'diesel';
export type ServiceType = 'revisao' | 'corretiva' | 'pneus' | 'outros';

/** Itens do plano de manutenção que o app acompanha (próxima troca). */
export const CATEGORIAS: Record<string, string> = {
  oleo_motor: 'Óleo do motor',
  filtro_oleo: 'Filtro de óleo',
  filtro_ar: 'Filtro de ar do motor',
  filtro_cabine: 'Filtro de cabine (ar-condicionado)',
  filtro_combustivel: 'Filtro de combustível',
  velas: 'Velas de ignição',
  correia_acessorios: 'Correia de acessórios',
  arrefecimento: 'Líquido de arrefecimento',
  fluido_freio: 'Fluido de freio',
  fluido_cambio: 'Fluido do câmbio',
  folga_valvulas: 'Folga de válvulas',
};

export interface ImportFill {
  date: string;
  odometer_km: number;
  liters: number;
  total_brl: number;
  price_per_l: number;
  fuel: Fuel;
  full_tank: boolean;
  station: string | null;
  note: string | null;
}
export interface ImportItem { description: string; plan_item_key: string | null; parts_brl: number; labor_brl: number }
export interface ImportService {
  date: string;
  odometer_km: number | null;
  shop: string | null;
  os_number: string | null;
  type: ServiceType;
  note: string | null;
  items: ImportItem[];
}
export interface Parsed { fills: ImportFill[]; services: ImportService[]; warnings: string[] }

/* ---------- leitura de valores ---------- */

const clean = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/** Número em qualquer formato comum: 250.3, "250,30", "R$ 1.234,56", "45.210 km". */
export function num(v: unknown, kind: 'money' | 'int' | 'dec' = 'dec'): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  let s = v.replace(/[^\d,.\-]/g, '');
  if (!s || !/\d/.test(s)) return null;
  const lastComma = s.lastIndexOf(','), lastDot = s.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    // o último separador é o decimal
    s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (lastComma >= 0) {
    s = /^\-?\d{1,3}(,\d{3})+$/.test(s) && kind === 'int' ? s.replace(/,/g, '') : s.replace(/\./g, '').replace(',', '.');
  } else if (lastDot >= 0) {
    // "45.210" é milhar em km; em dinheiro e litros, "1.234" com 3 casas também é milhar só quando for inteiro
    if (/^\-?\d{1,3}(\.\d{3})+$/.test(s) && (kind === 'int' || s.split('.').length > 2)) s = s.replace(/\./g, '');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Data em AAAA-MM-DD, DD/MM/AAAA, DD/MM/AA, DD-MM-AAAA ou número de série do Excel. */
export function isoDate(v: unknown): string | null {
  if (v instanceof Date && !isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  if (typeof v === 'number' && v > 20000 && v < 80000) {
    return new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 864e5).toISOString().slice(0, 10);
  }
  if (typeof v !== 'string') return null;
  const s = v.trim();
  let y: number, m: number, d: number;
  let r = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (r) [y, m, d] = [Number(r[1]), Number(r[2]), Number(r[3])];
  else if ((r = /^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/.exec(s))) {
    [d, m, y] = [Number(r[1]), Number(r[2]), Number(r[3])];
    if (y < 100) y += y > 70 ? 1900 : 2000;
  } else if (/^\d{5}(\.\d+)?$/.test(s)) return isoDate(Number(s));
  else return null;
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1980 || y > 2100) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null;
  return dt.toISOString().slice(0, 10);
}

export function fuelOf(v: unknown): Fuel | null {
  if (typeof v !== 'string') return null;
  const s = clean(v);
  if (!s) return null;
  if (/etanol|alcool|\be\b|hidratado/.test(s)) return 'etanol';
  if (/diesel|s10|s500/.test(s)) return 'diesel';
  if (/gnv|gas natural/.test(s)) return 'gnv';
  if (/gasolina|\bg\b|aditivada|comum|podium|premium|v-power/.test(s)) return 'gasolina';
  return null;
}

export function boolOf(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v !== 'string') return null;
  const s = clean(v);
  if (['sim', 's', 'true', 'x', 'cheio', 'completo', 'yes', 'y', '1', 'tanque cheio'].includes(s)) return true;
  if (['nao', 'n', 'false', 'parcial', 'no', '0'].includes(s)) return false;
  return null;
}

const text = (v: unknown, max: number): string | null => {
  if (v == null) return null;
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
};

/** Categoria do plano de manutenção a partir da descrição do item. */
export function guessCategory(desc: string): string | null {
  const s = clean(desc);
  if (/filtro/.test(s)) {
    if (/oleo|lubrific/.test(s)) return 'filtro_oleo';
    if (/cabine|ar.?condicionado|polen|antipolen|habitaculo/.test(s)) return 'filtro_cabine';
    if (/combustivel|gasolina|diesel/.test(s)) return 'filtro_combustivel';
    if (/\bar\b|motor/.test(s)) return 'filtro_ar';
    return null;
  }
  if (/fluido.*freio|oleo.*freio|dot ?[345]/.test(s)) return 'fluido_freio';
  if (/cambio|transmiss|\batf\b|cvt/.test(s)) return 'fluido_cambio';
  if (/oleo|lubrificante|\d+w\d+/.test(s)) return 'oleo_motor';
  if (/\bvelas?\b/.test(s)) return 'velas';
  if (/correia.*(acessorio|alternador|poly|dentada)?/.test(s) && !/dentada/.test(s)) return 'correia_acessorios';
  if (/arrefecimento|radiador|aditivo|coolant/.test(s)) return 'arrefecimento';
  if (/valvula/.test(s)) return 'folga_valvulas';
  return null;
}

function typeFor(items: ImportItem[]): ServiceType {
  if (items.some((i) => i.plan_item_key)) return 'revisao';
  if (items.length && items.every((i) => /pneu|alinhamento|balanceamento|cambagem/.test(clean(i.description)))) return 'pneus';
  return items.length ? 'corretiva' : 'outros';
}

/* ---------- o formato da IA ---------- */

/** Acha o JSON no texto colado: bloco ```json```, ou o primeiro objeto { … }. */
export function extractJson(textIn: string): unknown {
  const t = textIn.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  const body = fence ? fence[1] : t.slice(Math.max(0, t.indexOf('{')), t.lastIndexOf('}') + 1);
  if (!body.trim()) throw new Error('Não achei os dados no texto. Cole a resposta inteira da IA.');
  try {
    return JSON.parse(body);
  } catch {
    // vírgula sobrando antes de ] ou } é o erro mais comum
    try {
      return JSON.parse(body.replace(/,\s*([\]}])/g, '$1'));
    } catch {
      throw new Error('O texto colado não está no formato esperado. Peça para a IA devolver só o bloco JSON.');
    }
  }
}

const pick = (o: Record<string, unknown>, ...keys: string[]) => {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k];
  return undefined;
};

/** Um abastecimento vindo da IA ou da planilha. Devolve o registro, ou o motivo de descartar. */
export function fillFrom(o: Record<string, unknown>, where: string): ImportFill | string {
  const date = isoDate(pick(o, 'data', 'date'));
  if (!date) return where + ': sem data válida';
  const km = num(pick(o, 'km', 'odometro', 'odometer_km'), 'int');
  if (km == null || km < 0 || km > 3_000_000) return where + ': sem km (odômetro)';
  let liters = num(pick(o, 'litros', 'liters'));
  let total = num(pick(o, 'valor_total', 'total', 'valor', 'total_brl'), 'money');
  let price = num(pick(o, 'preco_litro', 'preco', 'price_per_l'), 'money');
  if (liters == null && total != null && price) liters = total / price;
  if (total == null && liters != null && price != null) total = liters * price;
  if (price == null && liters && total != null) price = total / liters;
  if (!liters || liters <= 0 || liters >= 500) return where + ': sem litros (ou valor e preço por litro)';
  if (total == null || total < 0) return where + ': sem valor pago';
  if (price == null || price <= 0) price = total / liters;
  const fuel = fuelOf(pick(o, 'combustivel', 'fuel')) ?? 'gasolina';
  const full = boolOf(pick(o, 'tanque_cheio', 'cheio', 'full_tank'));
  return {
    date, odometer_km: Math.round(km), liters: Math.round(liters * 1000) / 1000, total_brl: Math.round(total * 100) / 100,
    price_per_l: Math.round(price * 1000) / 1000, fuel, full_tank: full ?? true,
    station: text(pick(o, 'posto', 'station'), 120), note: text(pick(o, 'obs', 'observacao', 'note'), 300),
  };
}

export function itemFrom(o: Record<string, unknown>): ImportItem | null {
  const description = text(pick(o, 'descricao', 'item', 'servico', 'description'), 160);
  const parts = num(pick(o, 'peca', 'pecas', 'valor_peca', 'parts_brl'), 'money');
  const labor = num(pick(o, 'mao_de_obra', 'mao_obra', 'labor_brl'), 'money');
  const total = num(pick(o, 'valor', 'total'), 'money');
  const qty = num(pick(o, 'quantidade', 'qtd')) ?? 1;
  if (!description) return null;
  const cat = text(pick(o, 'categoria', 'plan_item_key'), 60);
  const key = cat && CATEGORIAS[clean(cat).replace(/\s+/g, '_')] ? clean(cat).replace(/\s+/g, '_') : guessCategory(description);
  // "peca" já vem como total da linha na maioria das OS; quantidade só multiplica quando o valor é unitário explícito
  const unit = num(pick(o, 'valor_unitario', 'unitario'), 'money');
  const partsBrl = parts ?? (unit != null ? unit * qty : labor == null ? total ?? 0 : 0);
  return {
    description, plan_item_key: key,
    parts_brl: Math.max(0, Math.round(partsBrl * 100) / 100), labor_brl: Math.max(0, Math.round((labor ?? 0) * 100) / 100),
  };
}

export function serviceFrom(o: Record<string, unknown>, where: string): ImportService | string {
  const date = isoDate(pick(o, 'data', 'date'));
  if (!date) return where + ': sem data válida';
  const km = num(pick(o, 'km', 'odometro', 'odometer_km'), 'int');
  const rawItems = pick(o, 'itens', 'items');
  const items = (Array.isArray(rawItems) ? rawItems : []).map((x) => (x && typeof x === 'object' ? itemFrom(x as Record<string, unknown>) : null)).filter((x): x is ImportItem => !!x);
  if (!items.length) {
    const total = num(pick(o, 'total', 'valor'), 'money');
    const desc = text(pick(o, 'descricao', 'servico', 'obs'), 160);
    if (!desc && total == null) return where + ': sem itens';
    items.push({ description: desc ?? 'Serviço', plan_item_key: desc ? guessCategory(desc) : null, parts_brl: total ?? 0, labor_brl: 0 });
  }
  return {
    date, odometer_km: km != null && km >= 0 && km < 3_000_000 ? Math.round(km) : null,
    shop: text(pick(o, 'oficina', 'shop'), 80), os_number: text(pick(o, 'os', 'os_number', 'numero_os'), 40),
    type: typeFor(items), note: text(pick(o, 'obs', 'observacao', 'note'), 300), items: items.slice(0, 60),
  };
}

/** Lê o formato da IA (já como objeto). Aceita também só a lista de abastecimentos ou de manutenções. */
export function parseImport(raw: unknown): Parsed {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if ((o as any).app && (o as any).version) throw new Error('Isto é um backup do app, não um arquivo de importação.');
  const fillsIn = pick(o, 'abastecimentos', 'fills', 'fuel_logs');
  const svcsIn = pick(o, 'manutencoes', 'servicos', 'services');
  if (!Array.isArray(fillsIn) && !Array.isArray(svcsIn)) throw new Error('Não achei "abastecimentos" nem "manutencoes" nos dados.');
  const out: Parsed = { fills: [], services: [], warnings: [] };
  (Array.isArray(fillsIn) ? fillsIn : []).slice(0, 5000).forEach((x, i) => {
    const r = x && typeof x === 'object' ? fillFrom(x as Record<string, unknown>, 'Abastecimento ' + (i + 1)) : 'Abastecimento ' + (i + 1) + ': inválido';
    if (typeof r === 'string') out.warnings.push(r + ' (ignorado)');
    else out.fills.push(r);
  });
  (Array.isArray(svcsIn) ? svcsIn : []).slice(0, 1000).forEach((x, i) => {
    const r = x && typeof x === 'object' ? serviceFrom(x as Record<string, unknown>, 'Manutenção ' + (i + 1)) : 'Manutenção ' + (i + 1) + ': inválida';
    if (typeof r === 'string') out.warnings.push(r + ' (ignorada)');
    else out.services.push(r);
  });
  const avisos = pick(o, 'avisos', 'warnings');
  if (Array.isArray(avisos)) for (const a of avisos.slice(0, 50)) if (typeof a === 'string' && a.trim()) out.warnings.push('Da IA: ' + a.trim().slice(0, 200));
  return out;
}

/* ---------- conferência contra o que já existe ---------- */

export interface Existing {
  fills: { date: string; odometer_km: number; total_brl: number }[];
  services: { date: string; odometer_km: number | null; shop: string | null }[];
}
export interface Plan {
  fills: ImportFill[];
  services: ImportService[];
  dupFills: number;
  dupServices: number;
  warnings: string[];
}

const dm = (iso: string) => iso.slice(8, 10) + '/' + iso.slice(5, 7) + '/' + iso.slice(0, 4);

/** O que entra de fato: tira duplicados (já no carro ou repetidos no arquivo) e aponta o que parece errado. */
export function planImport(p: Parsed, existing: Existing, vehicleFuel: VehicleFuel): Plan {
  const warnings = [...p.warnings];
  const fillKey = (f: { date: string; odometer_km: number }) => f.date + '|' + f.odometer_km;
  const seenFill = new Set(existing.fills.map(fillKey));
  const near = (f: ImportFill) => existing.fills.some((e) => e.date === f.date && (Math.abs(e.odometer_km - f.odometer_km) <= 2 || Math.abs(e.total_brl - f.total_brl) < 0.05));
  const fills: ImportFill[] = [];
  let dupFills = 0;
  for (const f of p.fills) {
    if (seenFill.has(fillKey(f)) || near(f)) { dupFills++; continue; }
    seenFill.add(fillKey(f));
    fills.push(f);
  }
  const svcKey = (s: { date: string; odometer_km: number | null; shop: string | null }) => s.date + '|' + (s.odometer_km ?? '') + '|' + clean(s.shop ?? '');
  const seenSvc = new Set(existing.services.map(svcKey));
  const sameDay = (s: ImportService) => existing.services.some((e) => e.date === s.date && (s.odometer_km == null || e.odometer_km == null || Math.abs((e.odometer_km ?? 0) - s.odometer_km) <= 5));
  const services: ImportService[] = [];
  let dupServices = 0;
  for (const s of p.services) {
    if (seenSvc.has(svcKey(s)) || sameDay(s)) { dupServices++; continue; }
    seenSvc.add(svcKey(s));
    services.push(s);
  }
  // km tem que crescer com a data (juntando com o que já existe)
  const all = [...existing.fills.map((f) => ({ ...f, novo: false })), ...fills.map((f) => ({ ...f, novo: true }))].sort((a, b) => a.date.localeCompare(b.date) || a.odometer_km - b.odometer_km);
  let bad = 0, same = 0;
  for (let i = 1; i < all.length; i++) {
    // mesmo km em dias diferentes: o carro não rodou nada entre um e outro, quase sempre km copiado errado
    if (all[i].odometer_km === all[i - 1].odometer_km && all[i].date !== all[i - 1].date && (all[i].novo || all[i - 1].novo)) {
      if (same++ < 5) warnings.push('Km repetido: ' + dm(all[i].date) + ' e ' + dm(all[i - 1].date) + ' com ' + all[i].odometer_km.toLocaleString('pt-BR') + ' km');
    }
    if (all[i].odometer_km < all[i - 1].odometer_km && (all[i].novo || all[i - 1].novo)) {
      if (bad < 5) warnings.push('Km fora de ordem: ' + dm(all[i].date) + ' com ' + all[i].odometer_km.toLocaleString('pt-BR') + ' km, menor que ' + all[i - 1].odometer_km.toLocaleString('pt-BR') + ' km em ' + dm(all[i - 1].date));
      bad++;
    }
  }
  if (bad > 5) warnings.push('… e mais ' + (bad - 5) + ' abastecimentos com km fora de ordem');
  let odd = 0;
  for (const f of fills) {
    const calc = f.liters * f.price_per_l;
    if (f.price_per_l < 2 || f.price_per_l > 12) { if (odd++ < 5) warnings.push('Preço por litro estranho em ' + dm(f.date) + ': R$ ' + f.price_per_l.toFixed(2).replace('.', ',')); }
    else if (Math.abs(calc - f.total_brl) > Math.max(1, f.total_brl * 0.05)) { if (odd++ < 5) warnings.push('Em ' + dm(f.date) + ', litros × preço não bate com o valor pago'); }
    if (vehicleFuel !== 'flex' && f.fuel !== vehicleFuel && !(vehicleFuel === 'gasolina' && f.fuel === 'gnv')) {
      if (odd++ < 5) warnings.push('Em ' + dm(f.date) + ' o combustível é ' + f.fuel + ', diferente do carro (' + vehicleFuel + ')');
    }
  }
  return { fills, services, dupFills, dupServices, warnings };
}

/* ---------- prompt de referência para a IA da pessoa ---------- */

export function aiPrompt(car?: { name: string; fuel_type: VehicleFuel } | null): string {
  return [
    'Você vai organizar o histórico do meu carro' + (car ? ' (' + car.name + ', ' + (car.fuel_type === 'flex' ? 'flex' : car.fuel_type) + ')' : '') + ' para importar no app Enche Aí.',
    'Anexei planilhas, fotos de ordens de serviço (OS) e/ou anotações.',
    '',
    'Devolva APENAS um bloco ```json``` neste formato:',
    '',
    '{',
    '  "formato": "' + FORMATO + '",',
    '  "abastecimentos": [',
    '    { "data": "AAAA-MM-DD", "km": 45210, "litros": 40.5, "valor_total": 250.30,',
    '      "preco_litro": 6.18, "combustivel": "gasolina|etanol|diesel|gnv",',
    '      "tanque_cheio": true, "posto": "nome e bairro, se houver", "obs": null }',
    '  ],',
    '  "manutencoes": [',
    '    { "data": "AAAA-MM-DD", "km": 60150, "oficina": "nome", "os": "número da OS ou null",',
    '      "itens": [',
    '        { "descricao": "como está na OS", "categoria": "uma da lista abaixo ou null",',
    '          "peca": 180.00, "mao_de_obra": 60.00 }',
    '      ],',
    '      "obs": null }',
    '  ],',
    '  "avisos": ["o que ficou incompleto ou duvidoso, com a origem (arquivo, linha ou página)"]',
    '}',
    '',
    'Regras:',
    '- Nunca invente. Campo que não aparece no material fica null.',
    '- Datas no formato AAAA-MM-DD; números com ponto decimal, sem "R$" nem separador de milhar.',
    '- Abastecimento: se faltar um entre litros, valor_total e preco_litro, calcule a partir dos outros dois.',
    '  "tanque_cheio" só é false se estiver indicado que foi parcial; na dúvida, true e registre em "avisos".',
    '- Manutenção: um item por linha da OS; "peca" e "mao_de_obra" são o valor total da linha.',
    '  Se a OS não separar peça e mão de obra, ponha tudo em "peca".',
    '- categoria: ' + Object.keys(CATEGORIAS).join(', ') + '.',
    '  Qualquer outro item (pneu, pastilha, alinhamento…) fica com categoria null.',
    '- Ignore dados pessoais: nome, CPF, telefone, endereço e placa não entram no resultado.',
    '- Se houver registros repetidos, mantenha um só e avise.',
  ].join('\n');
}
