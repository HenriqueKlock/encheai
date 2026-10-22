// Trazer histórico: planilha simples (sem IA), resposta da IA da pessoa (prompt de referência) ou o conector
// do Claude. Tudo passa pela mesma conferência (duplicados, km fora de ordem, preço estranho) e nada é gravado
// antes de a pessoa ver a prévia.
import { db, setMeta, softDelete, stamp, uuid, type FuelLog, type ImportSource, type Service, type ServiceItem } from '../db';
import { importBatches, SOURCE_LABEL } from '../lotes';
import { importBackup } from '../backup';
import { SUPABASE_URL } from '../config';
import { aiPrompt, extractJson, parseImport, planImport, CATEGORIAS, type Parsed, type Plan } from '../importacao';
import { autoMap, detect, FIELDS, missing, readSpreadsheet, tableToParsed, TEMPLATES, type ColumnMap, type Kind, type Table } from '../planilha';
import { S, activeVehicles, current, subscribe } from '../store';
import { currentSession } from '../sync';
import { $, brl, esc, fmt, km, pl, toast } from '../ui';
import { currentRoute, go, onShow } from '../router';
import { ICON } from '../icons';

export const MCP_URL = SUPABASE_URL + '/functions/v1/mcp';
/** Liga a opção "Conectar o Claude" quando o conector estiver no ar. */
const MCP_READY = true;

type Step =
  | { s: 'menu' }
  | { s: 'ia' }
  | { s: 'claude' }
  | { s: 'colunas'; tables: Table[]; sheet: number; headerRow: number; kind: Kind; map: ColumnMap; file: string }
  | { s: 'previa'; plan: Plan; parsed: Parsed; origem: string; back: Step }
  | { s: 'feito'; fills: number; services: number };

const dmy = (iso: string) => iso.slice(8, 10) + '/' + iso.slice(5, 7) + '/' + iso.slice(0, 4);

export function initImportar() {
  let step: Step = { s: 'menu' };
  let carId: string | null = null;
  let logged = false;

  const car = () => activeVehicles().find((v) => v.id === carId) ?? current();

  async function render() {
    if (currentRoute().view !== 'importar') return;
    logged = !!(await currentSession());
    const body = $('imp-body');
    const cars = activeVehicles();
    if (!cars.length) {
      body.innerHTML = '<div class="card center"><p class="hint">Cadastre o carro primeiro: o histórico entra nele.</p><button type="button" class="btn primary" data-act="cars">Cadastrar carro</button></div>';
      return;
    }
    const c = car()!;
    carId = c.id;
    const carPick = cars.length > 1 && step.s !== 'feito'
      ? '<div class="field"><span>Para qual carro</span><div class="chips">' + cars.map((v) => '<button type="button" data-car="' + v.id + '" aria-selected="' + (v.id === c.id) + '">' + esc(v.name) + '</button>').join('') + '</div></div>'
      : '';
    body.innerHTML = carPick + view();
  }

  function view(): string {
    const c = car()!;
    switch (step.s) {
      case 'menu':
        return (
          '<div class="list-card">' +
          opt('planilha', ICON.chart, 'Planilha', 'Excel ou CSV organizado, uma linha por abastecimento ou por item de manutenção. Sem IA. Ex.: a planilha onde você já anota os abastecimentos.') +
          opt('ia', SPARK, 'Com a sua IA', 'PDFs e fotos de notas de manutenção, anotações e planilhas bagunçadas. Funciona com Claude, ChatGPT ou Gemini: você copia as instruções, a IA organiza e você cola a resposta aqui.') +
          (MCP_READY ? opt('claude', PLUG, 'Conectar o Claude', 'Para quem usa o Claude: ele lê os seus arquivos e registra direto na sua conta, sempre mostrando antes o que vai entrar.') : '') +
          '</div>' +
          batchesCard() +
          '<div class="card"><span class="b15">Modelos de planilha</span><span class="hint">Preencha no Excel ou no Google Planilhas e importe aqui.</span>' +
          '<div class="btn-row"><button type="button" class="btn sm" data-tpl="abastecimentos">Abastecimentos</button><button type="button" class="btn sm" data-tpl="manutencoes">Manutenções</button></div></div>' +
          '<p class="foot-note">Também aceita o backup do Enche AI (.json). Nada é gravado antes de você conferir; registros que já existem no ' + esc(c.name) + ' ficam de fora.</p>'
        );
      case 'ia':
        return (
          '<div class="card steps">' +
          '<div class="stp"><b>1</b><div><span class="b15">Copie as instruções</span><span class="hint">Já explicam para a IA o formato que o app entende.</span><button type="button" class="btn sm primary" data-imp="copy">Copiar instruções</button></div></div>' +
          '<div class="stp"><b>2</b><div><span class="b15">Abra a sua IA e cole</span><span class="hint">Junto, anexe as planilhas, fotos das OS e anotações. Pode mandar vários de uma vez.</span></div></div>' +
          '<div class="stp"><b>3</b><div><span class="b15">Traga a resposta</span><span class="hint">Copie o bloco que a IA devolveu e cole aqui, ou anexe o arquivo que ela gerou.</span>' +
          '<textarea class="inp" id="imp-paste" rows="5" placeholder="Cole aqui a resposta da IA" spellcheck="false"></textarea>' +
          '<div class="btn-row"><button type="button" class="btn sm" data-imp="file">Anexar arquivo</button><button type="button" class="btn sm primary" data-imp="paste">Conferir</button></div></div></div>' +
          '</div>' + backBtn()
        );
      case 'claude':
        return (
          '<div class="card steps">' +
          (logged ? '' : '<p class="rec-warn">' + ICON.warn + '<span>Entre na sua conta no Perfil antes: o Claude grava na sua conta.</span></p>') +
          '<div class="stp"><b>1</b><div><span class="b15">Adicione o conector</span><span class="hint">No Claude: Configurações › Conectores › Adicionar conector personalizado. Nome: Enche AI. Endereço:</span>' +
          '<div class="copy-row"><code>' + esc(MCP_URL) + '</code><button type="button" class="btn sm" data-imp="copyurl">Copiar</button></div>' +
          '<span class="hint">Funciona no plano gratuito do Claude (1 conector personalizado). Adicione pelo site ou app do computador; depois ele aparece no celular também.</span></div></div>' +
          '<div class="stp"><b>2</b><div><span class="b15">Conecte com a sua conta</span><span class="hint">O Claude abre o Enche AI para você autorizar. Ele só acessa os seus carros e registros, e você pode desconectar quando quiser.</span></div></div>' +
          '<div class="stp"><b>3</b><div><span class="b15">Peça no chat</span><span class="hint">Anexe as fotos das OS ou a planilha e escreva, por exemplo:</span><blockquote>Registre no Enche AI o histórico destes arquivos no meu carro.</blockquote><span class="hint">O Claude mostra o que vai gravar e pede a sua confirmação. Os registros aparecem aqui na próxima sincronização.</span></div></div>' +
          '</div>' + backBtn()
        );
      case 'colunas': {
        const st = step;
        const t = st.tables[st.sheet];
        const header = t.rows[st.headerRow] ?? [];
        const colName = (i: number) => String(header[i] ?? '').trim() || 'Coluna ' + letter(i);
        const cols = Array.from({ length: Math.max(header.length, ...t.rows.slice(st.headerRow, st.headerRow + 20).map((r) => r.length)) }, (_, i) => i);
        const miss = missing(st.map, st.kind);
        const sel = (k: string) =>
          '<select class="inp sm" data-col="' + k + '"><option value="">—</option>' + cols.map((i) => '<option value="' + i + '"' + (st.map[k] === i ? ' selected' : '') + '>' + esc(colName(i)) + '</option>').join('') + '</select>';
        return (
          '<div class="card"><span class="b15">' + esc(st.file) + '</span>' +
          (st.tables.length > 1 ? '<div class="chips">' + st.tables.map((x, i) => '<button type="button" data-sheet="' + i + '" aria-selected="' + (i === st.sheet) + '">' + esc(x.name) + '</button>').join('') + '</div>' : '') +
          '<div class="seg" role="tablist"><button type="button" role="tab" data-kind="abastecimentos" aria-selected="' + (st.kind === 'abastecimentos') + '">Abastecimentos</button><button type="button" role="tab" data-kind="manutencoes" aria-selected="' + (st.kind === 'manutencoes') + '">Manutenções</button></div>' +
          '<span class="hint">Confira qual coluna é cada informação. Cabeçalho na linha ' + (st.headerRow + 1) + ' · ' + pl(Math.max(0, t.rows.length - st.headerRow - 1), 'linha', 'linhas') + ' abaixo.</span>' +
          '<div class="map-grid">' + FIELDS[st.kind].map((f) => '<label class="field"><span>' + f.label + (f.required ? ' *' : '') + '</span>' + sel(f.key) + '</label>').join('') + '</div>' +
          (miss.length ? '<p class="rec-warn">' + ICON.warn + '<span>Falta: ' + esc(miss.join('; ')) + '.</span></p>' : '') +
          '<div class="btn-row"><button type="button" class="btn" data-imp="menu">Voltar</button><button type="button" class="btn primary" data-imp="cols"' + (miss.length ? ' disabled' : '') + '>Conferir</button></div></div>'
        );
      }
      case 'previa': {
        const p = step.plan;
        const items = p.services.reduce((a, s) => a + s.items.length, 0);
        const planned = p.services.reduce((a, s) => a + s.items.filter((i) => i.plan_item_key).length, 0);
        const range = (ds: string[]) => (ds.length ? (ds.length === 1 ? dmy(ds[0]) : dmy(ds.reduce((a, b) => (a < b ? a : b))) + ' a ' + dmy(ds.reduce((a, b) => (a > b ? a : b)))) : '');
        const total = p.fills.reduce((a, f) => a + f.total_brl, 0) + p.services.reduce((a, s) => a + s.items.reduce((b, i) => b + i.parts_brl + i.labor_brl, 0), 0);
        const nothing = !p.fills.length && !p.services.length;
        const warn = p.warnings.length
          ? '<details class="card warn-list"' + (nothing ? ' open' : '') + '><summary>' + ICON.warn + '<span>' + pl(p.warnings.length, 'aviso', 'avisos') + '</span></summary><ul>' + p.warnings.slice(0, 40).map((w) => '<li>' + esc(w) + '</li>').join('') + (p.warnings.length > 40 ? '<li>… e mais ' + (p.warnings.length - 40) + '</li>' : '') + '</ul></details>'
          : '';
        const fillRows = p.fills.slice().sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5).map((f) =>
          '<div class="pv-row"><span>' + dmy(f.date) + '</span><span>' + km(f.odometer_km) + ' km</span><span>' + fmt(f.liters, 1) + ' l</span><span>' + brl(f.total_brl) + '</span></div>').join('');
        const svcRows = p.services.slice().sort((a, b) => b.date.localeCompare(a.date)).slice(0, 4).map((s) =>
          '<div class="pv-svc"><span class="a">' + dmy(s.date) + (s.odometer_km != null ? ' · ' + km(s.odometer_km) + ' km' : '') + (s.shop ? ' · ' + esc(s.shop) : '') + '</span><span class="b">' + s.items.map((i) => esc(i.description) + (i.plan_item_key ? ' <i class="tag">' + esc(CATEGORIAS[i.plan_item_key]) + '</i>' : '')).join(' · ') + '</span></div>').join('');
        return (
          '<div class="card"><span class="l">' + esc(step.origem) + ' → ' + esc(car()!.name) + '</span>' +
          '<div class="pv-tiles' + (p.fills.length && p.services.length ? '' : nothing ? '' : ' one') + '">' + (p.fills.length || nothing ? '<div><b>' + p.fills.length + '</b><span>' + (p.fills.length === 1 ? 'abastecimento' : 'abastecimentos') + '</span><span class="hint">' + range(p.fills.map((f) => f.date)) + '</span></div>' : '') +
          (p.services.length || nothing ? '<div><b>' + p.services.length + '</b><span>' + (p.services.length === 1 ? 'manutenção' : 'manutenções') + '</span><span class="hint">' + (items ? pl(items, 'item', 'itens') + (planned ? ', ' + planned + ' no plano' : '') : '') + '</span></div>' : '') + '</div>' +
          (p.dupFills || p.dupServices ? '<span class="hint">Já existiam e ficam de fora: ' + [p.dupFills ? pl(p.dupFills, 'abastecimento', 'abastecimentos') : '', p.dupServices ? pl(p.dupServices, 'manutenção', 'manutenções') : ''].filter(Boolean).join(' e ') + '.</span>' : '') +
          (total ? '<span class="hint">Soma do que entra: ' + brl(total) + '</span>' : '') +
          '</div>' + warn +
          (fillRows ? '<div class="card"><span class="b15">Abastecimentos (mais recentes)</span><div class="pv-table">' + fillRows + '</div></div>' : '') +
          (svcRows ? '<div class="card"><span class="b15">Manutenções (mais recentes)</span>' + svcRows + '</div>' : '') +
          '<div class="btn-row"><button type="button" class="btn" data-imp="back">Voltar</button><button type="button" class="btn primary" data-imp="go"' + (nothing ? ' disabled' : '') + '>' + (nothing ? 'Nada novo para importar' : 'Importar no ' + esc(car()!.name)) + '</button></div>'
        );
      }
      case 'feito':
        return (
          '<div class="card center"><span class="ok-ic big">' + ICON.check + '</span><span class="b15">Histórico importado</span><span class="hint">' +
          [step.fills ? pl(step.fills, 'abastecimento', 'abastecimentos') : '', step.services ? pl(step.services, 'manutenção', 'manutenções') : ''].filter(Boolean).join(' e ') + ' no ' + esc(car()!.name) + '. ' +
          (logged ? 'Sobem para a sua conta na próxima sincronização.' : 'Ficam neste aparelho; entre na conta para guardar na nuvem.') + '</span>' +
          '<div class="btn-row"><button type="button" class="btn" data-imp="menu">Importar mais</button><a class="btn primary" href="#/carro/historico">Ver histórico</a></div></div>'
        );
    }
  }

  /** Importações deste carro que ainda têm registros: dá para desfazer cada uma inteira. */
  let undoArmed: string | null = null;
  function batchesCard() {
    const c = car()!;
    const bs = importBatches(S.logs, S.services, c.id).slice(0, 6);
    if (!bs.length) return '';
    return (
      '<div class="card"><span class="b15">Importações no ' + esc(c.name) + '</span><span class="hint">Se alguma veio errada, desfaça inteira: os registros dela saem do histórico.</span>' +
      '<div class="list-card flat">' + bs.map((b) =>
        '<div class="row batch"><span class="mid"><span class="a">' + SOURCE_LABEL[b.source] + ' · ' + dmy(b.at.slice(0, 10)) + '</span><span class="b">' +
        [b.fills ? pl(b.fills, 'abastecimento', 'abastecimentos') : '', b.services ? pl(b.services, 'manutenção', 'manutenções') : ''].filter(Boolean).join(', ') +
        (b.first ? ' · de ' + dmy(b.first) + ' a ' + dmy(b.last) : '') + '</span></span>' +
        '<button type="button" class="btn sm' + (undoArmed === b.id ? ' danger-solid' : ' danger') + '" data-undo="' + b.id + '">' + (undoArmed === b.id ? 'Confirmar' : 'Desfazer') + '</button></div>').join('') +
      '</div></div>'
    );
  }

  const opt = (k: string, icon: string, a: string, b: string) =>
    '<button type="button" class="row nav wrap" data-imp="' + k + '"><span class="ic gray">' + icon + '</span><span class="mid"><span class="a">' + a + '</span><span class="b">' + b + '</span></span><span class="chev">' + ICON.chev + '</span></button>';
  const backBtn = () => '<button type="button" class="link-btn muted" data-imp="menu">' + '← Outras formas de importar</button>';
  const letter = (i: number) => (i >= 26 ? String.fromCharCode(64 + Math.floor(i / 26)) : '') + String.fromCharCode(65 + (i % 26));

  /* ---------- conferência e gravação ---------- */

  function preview(parsed: Parsed, origem: string, back: Step) {
    const c = car()!;
    const existing = {
      fills: S.logs.filter((f) => f.vehicle_id === c.id).map((f) => ({ date: f.date, odometer_km: f.odometer_km, total_brl: f.total_brl })),
      services: S.services.filter((s) => s.vehicle_id === c.id).map((s) => ({ date: s.date, odometer_km: s.odometer_km, shop: s.shop })),
    };
    step = { s: 'previa', plan: planImport(parsed, existing, c.fuel_type), parsed, origem, back };
    render();
    window.scrollTo({ top: 0 });
  }

  async function apply(plan: Plan, origem: string) {
    const c = car()!;
    const import_batch = uuid();
    const import_source: ImportSource = /planilha/i.test(origem) ? 'planilha' : 'ia';
    await db.transaction('rw', db.fuel_logs, db.services, db.service_items, async () => {
      for (const f of plan.fills) {
        await db.fuel_logs.put(stamp<FuelLog>({
          id: uuid(), vehicle_id: c.id, date: f.date, odometer_km: f.odometer_km, liters: f.liters, total_brl: f.total_brl,
          price_per_l: f.price_per_l, fuel: f.fuel, full_tank: f.full_tank, range_left_km: null, station: f.station, station_id: null, note: f.note,
          import_batch, import_source,
        }));
      }
      for (const s of plan.services) {
        const sid = uuid();
        await db.services.put(stamp<Service>({ id: sid, vehicle_id: c.id, date: s.date, odometer_km: s.odometer_km, shop: s.shop, os_number: s.os_number, type: s.type, note: s.note, attachment_path: null, import_batch, import_source }));
        for (const [position, it] of s.items.entries()) {
          await db.service_items.put(stamp<ServiceItem>({ id: uuid(), service_id: sid, description: it.description, plan_item_key: it.plan_item_key, parts_brl: it.parts_brl, labor_brl: it.labor_brl, next_due_km: null, next_due_date: null, position }));
        }
      }
    });
    if (S.currentId !== c.id) await setMeta('current_vehicle', c.id);
    step = { s: 'feito', fills: plan.fills.length, services: plan.services.length };
    render();
  }

  /** Arquivo de qualquer tipo: backup, resposta da IA (.json/.txt) ou planilha (.csv/.xlsx). */
  async function openFile(file: File) {
    const name = file.name.toLowerCase();
    try {
      if (/\.(csv|xlsx|xlsm|xls|tsv)$/.test(name)) {
        const tables = (await readSpreadsheet(file)).filter((t) => t.rows.some((r) => r.some((c) => c != null && String(c).trim() !== '')));
        if (!tables.length) throw new Error('A planilha está vazia.');
        let sheet = 0, d = detect(tables[0]);
        for (let i = 0; i < tables.length && !d; i++) if ((d = detect(tables[i]))) sheet = i;
        const headerRow = d?.headerRow ?? 0;
        const kind = d?.kind ?? 'abastecimentos';
        step = { s: 'colunas', tables, sheet, headerRow, kind, map: autoMap(tables[sheet].rows[headerRow] ?? [], kind), file: file.name };
        return render();
      }
      const raw = extractJson(await file.text());
      const o = raw as { app?: string; version?: number };
      if (o && o.app && o.version) {
        const res = await importBackup(raw);
        toast('Backup importado: ' + pl(res.vehicles, 'carro', 'carros') + ', ' + pl(res.fuel_logs, 'abastecimento', 'abastecimentos') + ', ' + pl(res.services, 'manutenção', 'manutenções'));
        step = { s: 'menu' };
        return render();
      }
      preview(parseImport(raw), 'Arquivo da IA', { s: 'ia' });
    } catch (e) {
      toast((e as Error).message);
    }
  }

  /* ---------- eventos ---------- */

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.csv,.xlsx,.xlsm,.xls,.tsv,.json,.txt,.md,text/csv,application/json,text/plain,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  fileInput.hidden = true;
  document.body.appendChild(fileInput);
  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    fileInput.value = '';
    if (f) openFile(f);
  });

  async function copy(textIn: string, ok: string) {
    try {
      await navigator.clipboard.writeText(textIn);
      toast(ok);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = textIn;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      toast(ok);
    }
  }

  function download(name: string, content: string) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + content], { type: 'text/csv;charset=utf-8' }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  $('v-importar').addEventListener('click', async (e) => {
    const el = e.target as HTMLElement;
    const carB = el.closest<HTMLElement>('[data-car]');
    if (carB) {
      carId = carB.dataset.car!;
      if (step.s === 'previa') return preview(step.parsed, step.origem, step.back);
      return render();
    }
    const tpl = el.closest<HTMLElement>('[data-tpl]')?.dataset.tpl as Kind | undefined;
    if (tpl) return download(TEMPLATES[tpl].file, TEMPLATES[tpl].csv);
    const sh = el.closest<HTMLElement>('[data-sheet]');
    if (sh && step.s === 'colunas') {
      const sheet = Number(sh.dataset.sheet);
      const d = detect(step.tables[sheet]);
      step = { ...step, sheet, headerRow: d?.headerRow ?? 0, kind: d?.kind ?? step.kind, map: autoMap(step.tables[sheet].rows[d?.headerRow ?? 0] ?? [], d?.kind ?? step.kind) };
      return render();
    }
    const k = el.closest<HTMLElement>('[data-kind]')?.dataset.kind as Kind | undefined;
    if (k && step.s === 'colunas') {
      step = { ...step, kind: k, map: autoMap(step.tables[step.sheet].rows[step.headerRow] ?? [], k) };
      return render();
    }
    const u = el.closest<HTMLElement>('[data-undo]')?.dataset.undo;
    if (u) {
      if (undoArmed !== u) { undoArmed = u; return render(); }
      undoArmed = null;
      const fills = S.logs.filter((f) => f.import_batch === u && !f.deleted_at);
      const svcs = S.services.filter((s) => s.import_batch === u && !s.deleted_at);
      await db.transaction('rw', db.fuel_logs, db.services, db.service_items, async () => {
        for (const f of fills) await softDelete(db.fuel_logs, f.id);
        for (const s of svcs) {
          await softDelete(db.services, s.id);
          for (const it of S.items.filter((i) => i.service_id === s.id && !i.deleted_at)) await softDelete(db.service_items, it.id);
        }
      });
      toast('Importação desfeita: ' + [fills.length ? pl(fills.length, 'abastecimento', 'abastecimentos') : '', svcs.length ? pl(svcs.length, 'manutenção', 'manutenções') : ''].filter(Boolean).join(' e ') + ' saíram do histórico.');
      return render();
    }
    const a = el.closest<HTMLElement>('[data-imp]')?.dataset.imp;
    if (!a) return;
    if (a === 'planilha' || a === 'file') return fileInput.click();
    if (a === 'menu' || a === 'ia' || a === 'claude') { step = { s: a } as Step; return render(); }
    if (a === 'copy') return copy(aiPrompt(car()), 'Instruções copiadas. Cole na sua IA junto com os arquivos.');
    if (a === 'copyurl') return copy(MCP_URL, 'Endereço copiado');
    if (a === 'paste') {
      const t = ($('imp-paste') as HTMLTextAreaElement).value;
      if (!t.trim()) return toast('Cole a resposta da IA primeiro.');
      try {
        preview(parseImport(extractJson(t)), 'Resposta da IA', { s: 'ia' });
      } catch (err) {
        toast((err as Error).message);
      }
      return;
    }
    if (a === 'cols' && step.s === 'colunas') {
      const st = step;
      return preview(tableToParsed(st.tables[st.sheet], st.headerRow, st.kind, st.map), 'Planilha', st);
    }
    if (a === 'back' && step.s === 'previa') { step = step.back; return render(); }
    if (a === 'go' && step.s === 'previa') {
      (el.closest('button') as HTMLButtonElement).disabled = true;
      try {
        await apply(step.plan, step.origem);
      } catch (err) {
        console.error(err);
        toast('Não consegui gravar: ' + (err as Error).message);
        render();
      }
    }
  });
  $('v-importar').addEventListener('change', (e) => {
    const el = e.target as HTMLSelectElement;
    if (!el.dataset.col || step.s !== 'colunas') return;
    step.map = { ...step.map, [el.dataset.col]: el.value === '' ? null : Number(el.value) };
    render();
  });

  // a lista de importações acompanha o histórico (desfazer, sincronização)
  subscribe(() => { if (currentRoute().view === 'importar' && step.s === 'menu') render(); });

  onShow('importar', () => {
    if (step.s === 'feito') step = { s: 'menu' };
    render();
  });

  return {
    /** Arquivo escolhido em outro lugar (botão "Importar" do Início): abre aqui. */
    openFile: (f: File) => {
      go('importar');
      openFile(f);
    },
    render,
  };
}

const SPARK = '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/></svg>';
const PLUG = '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0z"/><path d="M12 18v4"/></svg>';
