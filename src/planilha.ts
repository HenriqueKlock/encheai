// Planilha simples, sem IA: lê .csv e .xlsx, reconhece as colunas pelo cabeçalho e transforma as linhas
// no mesmo formato da importação (src/importacao.ts). A parte de colunas e linhas é pura (testada);
// a leitura do arquivo usa fflate só para abrir o .xlsx (um zip de XMLs).
import { fillFrom, itemFrom, serviceFrom, type Parsed } from './importacao.ts';

export type Cell = string | number | boolean | null;
export interface Table { name: string; rows: Cell[][] }
export type Kind = 'abastecimentos' | 'manutencoes';

const clean = (s: unknown) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9$/º°]+/g, ' ').trim();

/* ---------- campos e cabeçalhos ---------- */

export interface FieldDef { key: string; label: string; required?: boolean; exact: string[]; contains: string[] }

export const FIELDS: Record<Kind, FieldDef[]> = {
  abastecimentos: [
    { key: 'data', label: 'Data', required: true, exact: ['data', 'dia', 'date', 'data abastecimento'], contains: ['data'] },
    { key: 'km', label: 'Km (odômetro)', required: true, exact: ['km', 'odometro', 'hodometro', 'quilometragem', 'kilometragem', 'km atual', 'km total'], contains: ['odometro', 'hodometro', 'quilometragem', 'km'] },
    { key: 'preco_litro', label: 'Preço por litro', exact: ['preco', 'preco litro', 'preco/l', 'r$/l', 'valor litro', 'preco por litro', 'valor do litro', 'r$ l'], contains: ['preco', 'litro r$', 'r$/l', 'valor litro', 'valor do litro'] },
    { key: 'litros', label: 'Litros', exact: ['litros', 'lts', 'l', 'volume', 'qtd litros', 'quantidade'], contains: ['litro', 'lts', 'volume'] },
    { key: 'valor_total', label: 'Valor pago', exact: ['valor', 'total', 'valor total', 'valor pago', 'gasto', 'custo', 'r$', 'total r$'], contains: ['valor', 'total', 'pago', 'gasto', 'custo'] },
    { key: 'combustivel', label: 'Combustível', exact: ['combustivel', 'tipo', 'produto', 'tipo combustivel'], contains: ['combust', 'produto'] },
    { key: 'tanque_cheio', label: 'Tanque cheio', exact: ['cheio', 'tanque cheio', 'completo', 'completou', 'encheu'], contains: ['cheio', 'complet'] },
    { key: 'posto', label: 'Posto', exact: ['posto', 'local', 'estabelecimento'], contains: ['posto'] },
    { key: 'obs', label: 'Observação', exact: ['obs', 'observacao', 'observacoes', 'notas', 'nota', 'comentario'], contains: ['obs'] },
  ],
  manutencoes: [
    { key: 'data', label: 'Data', required: true, exact: ['data', 'dia', 'date'], contains: ['data'] },
    { key: 'km', label: 'Km', exact: ['km', 'odometro', 'hodometro', 'quilometragem'], contains: ['odometro', 'quilometragem', 'km'] },
    { key: 'descricao', label: 'Item ou serviço', required: true, exact: ['item', 'descricao', 'servico', 'peca/servico', 'produto', 'servico realizado', 'o que foi feito'], contains: ['descri', 'item', 'servico realizado'] },
    { key: 'mao_de_obra', label: 'Mão de obra (R$)', exact: ['mao de obra', 'mo', 'm o', 'valor mao de obra', 'servico r$'], contains: ['mao de obra', 'mao obra'] },
    { key: 'peca', label: 'Peça (R$)', exact: ['peca', 'pecas', 'valor peca', 'valor pecas', 'material'], contains: ['peca', 'material'] },
    { key: 'valor', label: 'Valor (R$)', exact: ['valor', 'total', 'preco', 'custo', 'r$', 'valor total'], contains: ['valor', 'total', 'preco', 'custo'] },
    { key: 'oficina', label: 'Oficina', exact: ['oficina', 'mecanica', 'loja', 'local', 'fornecedor', 'concessionaria'], contains: ['oficina', 'mecanic', 'concession'] },
    { key: 'os', label: 'Nº da OS', exact: ['os', 'o s', 'n os', 'no os', 'nº os', 'numero os', 'ordem de servico', 'numero da os'], contains: ['ordem de servico', ' os'] },
    { key: 'categoria', label: 'Categoria', exact: ['categoria'], contains: ['categoria'] },
    { key: 'obs', label: 'Observação', exact: ['obs', 'observacao', 'notas'], contains: ['obs'] },
  ],
};

export type ColumnMap = Record<string, number | null>;

/** Para cada campo, a coluna com o cabeçalho que mais combina (cada coluna vai para um campo só). */
export function autoMap(header: Cell[], kind: Kind): ColumnMap {
  const h = header.map(clean);
  const used = new Set<number>();
  const map: ColumnMap = {};
  const fields = FIELDS[kind];
  // 1º nome exato, depois "contém", na ordem dos campos (preço por litro antes de litros e de valor)
  for (const f of fields) {
    const i = h.findIndex((x, j) => !used.has(j) && f.exact.includes(x));
    map[f.key] = i >= 0 ? i : null;
    if (i >= 0) used.add(i);
  }
  for (const f of fields) {
    if (map[f.key] != null) continue;
    const i = h.findIndex((x, j) => !used.has(j) && x && f.contains.some((c) => (' ' + x + ' ').includes(c)));
    map[f.key] = i >= 0 ? i : null;
    if (i >= 0) used.add(i);
  }
  return map;
}

const score = (row: Cell[], kind: Kind) => Object.values(autoMap(row, kind)).filter((v) => v != null).length;

/** Acha a linha do cabeçalho (nas 10 primeiras) e se a planilha é de abastecimentos ou de manutenções. */
export function detect(t: Table): { headerRow: number; kind: Kind } | null {
  let best: { headerRow: number; kind: Kind; s: number } | null = null;
  for (let r = 0; r < Math.min(10, t.rows.length); r++) {
    for (const kind of ['abastecimentos', 'manutencoes'] as Kind[]) {
      const m = autoMap(t.rows[r], kind);
      const req = FIELDS[kind].filter((f) => f.required).every((f) => m[f.key] != null);
      let s = score(t.rows[r], kind) + (req ? 3 : 0);
      // litros decide: planilha de abastecimento quase sempre tem; de manutenção, nunca
      if (kind === 'abastecimentos' && m.litros != null) s += 2;
      if (kind === 'manutencoes' && m.descricao != null) s += 2;
      if (s >= 4 && (!best || s > best.s)) best = { headerRow: r, kind, s };
    }
  }
  return best ? { headerRow: best.headerRow, kind: best.kind } : null;
}

/** O que falta para importar com este mapeamento (vazio = pode seguir). */
export function missing(map: ColumnMap, kind: Kind): string[] {
  const out = FIELDS[kind].filter((f) => f.required && map[f.key] == null).map((f) => f.label);
  if (kind === 'abastecimentos') {
    const n = ['litros', 'valor_total', 'preco_litro'].filter((k) => map[k] != null).length;
    if (n < 2) out.push('dois entre Litros, Valor pago e Preço por litro');
  }
  if (kind === 'manutencoes' && map.peca == null && map.mao_de_obra == null && map.valor == null) out.push('um valor (Peça, Mão de obra ou Valor)');
  return out;
}

const emptyRow = (r: Cell[]) => r.every((c) => c == null || String(c).trim() === '');

/** Linhas da planilha → o mesmo resultado da importação pela IA. */
export function tableToParsed(t: Table, headerRow: number, kind: Kind, map: ColumnMap): Parsed {
  const out: Parsed = { fills: [], services: [], warnings: [] };
  const rows = t.rows.slice(headerRow + 1);
  const obj = (r: Cell[]) => {
    const o: Record<string, unknown> = {};
    for (const [k, i] of Object.entries(map)) if (i != null && r[i] != null && String(r[i]).trim() !== '') o[k] = r[i];
    return o;
  };
  if (kind === 'abastecimentos') {
    rows.forEach((r, i) => {
      if (emptyRow(r)) return;
      const res = fillFrom(obj(r), 'Linha ' + (headerRow + i + 2));
      if (typeof res === 'string') out.warnings.push(res + ' (ignorada)');
      else out.fills.push(res);
    });
    return out;
  }
  // manutenção: uma linha por item; linhas com a mesma data, km, oficina e OS formam uma ida à oficina.
  // Linha sem data logo abaixo de outra é item da mesma OS (planilha com células mescladas).
  const groups = new Map<string, { o: Record<string, unknown>; itens: Record<string, unknown>[]; line: number }>();
  let last: Record<string, unknown> | null = null;
  rows.forEach((r, i) => {
    if (emptyRow(r)) return;
    const o = obj(r);
    if (o.data == null && last) for (const k of ['data', 'km', 'oficina', 'os']) if (o[k] == null && last[k] != null) o[k] = last[k];
    last = o;
    const key = [o.data, o.km, o.oficina, o.os].map((x) => String(x ?? '')).join('|');
    if (!groups.has(key)) groups.set(key, { o, itens: [], line: headerRow + i + 2 });
    groups.get(key)!.itens.push(o);
  });
  for (const g of groups.values()) {
    const itens = g.itens.filter((x) => itemFrom(x));
    const res = serviceFrom({ ...g.o, itens }, 'Linha ' + g.line);
    if (typeof res === 'string') out.warnings.push(res + ' (ignorada)');
    else out.services.push(res);
  }
  return out;
}

/* ---------- modelos para baixar ---------- */

export const TEMPLATES: Record<Kind, { file: string; csv: string }> = {
  abastecimentos: {
    file: 'enche-ai-modelo-abastecimentos.csv',
    csv: ['Data;Km;Litros;Valor pago;Preço por litro;Combustível;Tanque cheio;Posto;Observação',
      '14/03/2025;45210;40,5;250,30;6,18;Gasolina;Sim;Posto Exemplo - Centro;',
      '28/03/2025;45690;38,2;175,72;4,60;Etanol;Sim;;viagem'].join('\r\n'),
  },
  manutencoes: {
    file: 'enche-ai-modelo-manutencoes.csv',
    csv: ['Data;Km;Oficina;Nº OS;Item;Peça;Mão de obra;Observação',
      '02/04/2025;46000;Oficina Exemplo;1234;Óleo do motor 5W30;180,00;60,00;revisão 40 mil',
      '02/04/2025;46000;Oficina Exemplo;1234;Filtro de óleo;40,00;0;',
      '15/06/2025;49800;Pneus Exemplo;;Alinhamento e balanceamento;0;120,00;'].join('\r\n'),
  },
};

/* ---------- leitura do arquivo ---------- */

/** CSV com ; , ou tab, aspas e quebras de linha dentro das aspas. */
export function parseCsv(text: string): Cell[][] {
  const t = text.replace(/^﻿/, '');
  const first = t.split(/\r?\n/, 1)[0] ?? '';
  const delim = [';', '\t', ','].map((d) => [d, first.split(d).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const rows: Cell[][] = [];
  let row: Cell[] = [], cell = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) {
      if (ch === '"' && t[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && t[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((c) => (typeof c === 'string' ? c.trim() : c)));
}

function colIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** .xlsx: abre o zip e lê as planilhas (texto, números, verdadeiro/falso; datas vêm como número de série). */
export async function parseXlsx(buf: ArrayBuffer): Promise<Table[]> {
  const { unzipSync, strFromU8 } = await import('fflate');
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(buf), { filter: (f) => f.name.startsWith('xl/') && f.name.endsWith('.xml') || f.name.endsWith('.rels') });
  } catch {
    throw new Error('Não consegui abrir a planilha. Salve como .xlsx ou .csv e tente de novo.');
  }
  const xml = (name: string) => (files[name] ? new DOMParser().parseFromString(strFromU8(files[name]), 'application/xml') : null);
  const shared: string[] = [];
  const ss = xml('xl/sharedStrings.xml');
  if (ss) for (const si of Array.from(ss.getElementsByTagName('si'))) shared.push(Array.from(si.getElementsByTagName('t')).map((x) => x.textContent ?? '').join(''));
  const wb = xml('xl/workbook.xml');
  const rels = xml('xl/_rels/workbook.xml.rels');
  if (!wb) throw new Error('Esta planilha não parece um .xlsx. Salve como .xlsx ou .csv.');
  const target = new Map<string, string>();
  if (rels) for (const r of Array.from(rels.getElementsByTagName('Relationship'))) target.set(r.getAttribute('Id') ?? '', r.getAttribute('Target') ?? '');
  const out: Table[] = [];
  Array.from(wb.getElementsByTagName('sheet')).forEach((s, idx) => {
    const rid = s.getAttribute('r:id') ?? s.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') ?? '';
    let path = target.get(rid) ?? 'worksheets/sheet' + (idx + 1) + '.xml';
    path = path.replace(/^\/?xl\//, '').replace(/^\//, '');
    const doc = xml('xl/' + path);
    if (!doc) return;
    const rows: Cell[][] = [];
    for (const r of Array.from(doc.getElementsByTagName('row'))) {
      const rowIdx = Number(r.getAttribute('r') ?? rows.length + 1) - 1;
      const row: Cell[] = [];
      for (const c of Array.from(r.getElementsByTagName('c'))) {
        const t = c.getAttribute('t');
        const v = c.getElementsByTagName('v')[0]?.textContent ?? null;
        let val: Cell = null;
        if (t === 's') val = v != null ? shared[Number(v)] ?? '' : '';
        else if (t === 'inlineStr') val = Array.from(c.getElementsByTagName('t')).map((x) => x.textContent ?? '').join('');
        else if (t === 'b') val = v === '1';
        else if (t === 'str' || t === 'e') val = v;
        else val = v != null && v !== '' ? Number(v) : null;
        row[colIndex(c.getAttribute('r') ?? '')] = val;
      }
      rows[rowIdx] = Array.from(row, (x) => x ?? null);
    }
    out.push({ name: s.getAttribute('name') ?? 'Planilha ' + (idx + 1), rows: Array.from(rows, (x) => x ?? []) });
  });
  return out;
}

export async function readSpreadsheet(file: File): Promise<Table[]> {
  const name = file.name.toLowerCase();
  if (name.endsWith('.xls')) throw new Error('Planilha no formato antigo (.xls). No Excel, use "Salvar como" .xlsx ou .csv.');
  if (name.endsWith('.xlsx') || name.endsWith('.xlsm')) return parseXlsx(await file.arrayBuffer());
  const buf = await file.arrayBuffer();
  let text = new TextDecoder('utf-8').decode(buf);
  if (text.includes('�')) text = new TextDecoder('windows-1252').decode(buf); // CSV salvo pelo Excel em português
  return [{ name: file.name, rows: parseCsv(text) }];
}
