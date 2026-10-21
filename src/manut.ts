import { db, softDelete, stamp, uuid, type FuelLog, type PendingFile, type Service, type ServiceItem, type Vehicle } from './db';
import { kmPerDay } from './calc';
import { BASIC_PLAN, customKey, planByKey, planOf, templatesFor, type CustomPlan, type PlanItem } from './plans';
import { dueByKm, itemStates, lastDoneByKey, maintenanceTotals, progressOf, sortStates, type ItemState } from './maintenance';
import { ICON } from './icons';
import { attachmentUrl } from './sync';

export interface MaintCtx {
  $: <T extends HTMLElement = HTMLElement>(id: string) => T;
  fmt: (n: number, d?: number) => string;
  brl: (n: number) => string;
  km: (n: number) => string;
  esc: (s: unknown) => string;
  pl: (n: number, one: string, many: string) => string;
  todayISO: () => string;
  toast: (m: string) => void;
  openSheet: (id: string) => void;
  closeSheets: () => void;
  parseNum: (v: unknown) => number;
  parseIntLoose: (v: unknown) => number;
}

export interface MaintData {
  vehicle: Vehicle | undefined;
  logs: FuelLog[]; // do carro atual, ordenados
  services: Service[];
  items: ServiceItem[];
  pending: PendingFile[];
}

const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const monthYear = (iso: string) => MESES[+iso.slice(5, 7) - 1] + '/' + iso.slice(2, 4);
const dmy = (iso: string) => iso.slice(8, 10) + '/' + iso.slice(5, 7) + '/' + iso.slice(2, 4);
const TYPE_LABEL: Record<Service['type'], string> = { revisao: 'Revisão', corretiva: 'Conserto', pneus: 'Pneus', outros: 'Outros' };
const STATUS_LABEL = { vencida: 'Vencida', proxima: 'Próxima', em_dia: 'Em dia', sem_historico: 'Sem histórico', sem_intervalo: 'Sem intervalo' } as const;

/** Km atual do carro: maior valor entre abastecimentos, manutenções e o km do cadastro. */
export function currentKmOf(v: Vehicle | undefined, logs: FuelLog[], services: Service[]): number {
  if (!v) return 0;
  const svcKm = services.filter((s) => s.vehicle_id === v.id && !s.deleted_at).map((s) => s.odometer_km ?? 0);
  return Math.max(v.initial_km ?? 0, ...logs.map((f) => f.odometer_km), ...svcKm, 0);
}

export function initMaintenance(c: MaintCtx) {
  const { $, brl, km, esc, pl, toast } = c;
  let data: MaintData = { vehicle: undefined, logs: [], services: [], items: [], pending: [] };
  let targetKm: number | null = null;

  /* ---------- markup ---------- */
  $('v-manut').innerHTML = `
    <p class="hint" id="m-car"></p>
    <div id="m-alert"></div>
    <button type="button" class="btn primary" id="m-new">${ICON.wrench}Registrar ida à oficina</button>
    <div class="list-card" id="m-plan-card">
      <div id="m-next"></div>
      <button type="button" class="list-more" id="m-more" hidden></button>
    </div>
    <p class="foot-note" id="m-plan-note"></p>
    <div class="card" id="m-target-card">
      <div class="card-head"><span>Quando chegar em</span><span class="hint" id="m-target-when"></span></div>
      <div class="suffix" style="max-width:200px"><input class="inp sm" id="m-target" inputmode="numeric" aria-label="Quilometragem alvo"><em>km</em></div>
      <div id="m-due" class="hint" style="color:var(--ink-2);font-size:14px"></div>
    </div>
    <div class="stat-grid" id="m-kpis"></div>
    <div class="sec-head"><span>Idas à oficina</span><span class="muted" style="font-size:13px" id="m-hist-count"></span></div>
    <div class="list-card" id="m-hist"></div>`;

  document.body.insertAdjacentHTML(
    'beforeend',
    `<form class="sheet full" id="svc-sheet" novalidate aria-labelledby="svc-title">
      <div class="sheet-bar">
        <button type="button" class="text-btn" data-close style="justify-self:start">Cancelar</button>
        <h2 id="svc-title">Lançar manutenção</h2>
        <button type="button" class="text-btn danger" id="svc-del" hidden>Excluir</button>
      </div>
      <div class="sheet-body"><div class="stack">
        <div class="good" id="svc-check" hidden></div>
        <div class="warn-box" id="svc-warn" hidden></div>
        <div class="grid2">
          <label class="field">Data<input class="inp sm" id="svc-date" type="date"></label>
          <label class="field">Km na oficina<input class="inp sm" id="svc-km" inputmode="numeric" autocomplete="off"></label>
          <label class="field full">Oficina<input class="inp sm" id="svc-shop" autocomplete="off"></label>
          <label class="field">Nº da OS<input class="inp sm" id="svc-os" autocomplete="off" placeholder="Opcional"></label>
          <label class="field">Tipo<select class="inp sm" id="svc-type"><option value="revisao">Revisão</option><option value="corretiva">Conserto</option><option value="pneus">Pneus</option><option value="outros">Outros</option></select></label>
        </div>
        <div class="card-head"><span>Itens</span><span class="svc-total" id="svc-total"></span></div>
        <div id="svc-items" class="view" style="gap:10px"></div>
        <button type="button" class="btn" id="svc-add-item">+ Adicionar item</button>
        <label class="field">Observação<input class="inp sm" id="svc-note" autocomplete="off" placeholder="Opcional"></label>
        <div class="list-card"><div class="set-row"><div><div class="t">Anexo da OS</div><div class="d" id="svc-att-d"></div></div><div><button type="button" class="link-btn" id="svc-att-view" hidden>Ver</button><button type="button" class="link-btn" id="svc-att-add">Anexar</button></div></div></div>
        <input type="file" id="svc-att-file" accept="application/pdf,image/*" hidden>
        <div class="err" id="svc-err" hidden></div>
      </div></div>
      <div class="sheet-foot"><button type="submit" class="btn primary block">Salvar manutenção</button></div>
    </form>
    <datalist id="plan-list"></datalist>`,
  );

  /* ---------- render ---------- */
  let expanded = false;
  const SHOW_FIRST = 5;

  function render(d: MaintData) {
    data = d;
    const v = d.vehicle;
    $('m-car').textContent = v ? v.name + ' · ' + km(currentKmOf(v, d.logs, d.services)) + ' km' : '';
    if (!v) {
      $('m-next').innerHTML = '<div class="empty">Cadastre um carro para ver o plano de manutenção.</div>';
      ['m-alert', 'm-plan-note', 'm-kpis', 'm-hist'].forEach((id) => ($(id).innerHTML = ''));
      $('m-target-card').hidden = true;
      return;
    }
    const plan = planOf(v);
    const curKm = currentKmOf(v, d.logs, d.services);
    const today = c.todayISO();
    const kpd = kmPerDay(d.logs);
    const svcs = d.services.filter((s) => s.vehicle_id === v.id && !s.deleted_at).sort((a, b) => b.date.localeCompare(a.date));
    const itemsOf = (sid: string) => d.items.filter((i) => i.service_id === sid && !i.deleted_at);

    if (!plan) {
      $('m-alert').innerHTML = '';
      const tpls = templatesFor(v);
      const opt = (id: string, icon: string, a: string, b: string) =>
        '<button type="button" class="row nav" data-plan="' + esc(id) + '"><span class="ic gray">' + icon + '</span><span class="mid"><span class="a">' + esc(a) + '</span><span class="b">' + esc(b) + '</span></span><span class="chev">' + ICON.chev + '</span></button>';
      $('m-next').innerHTML =
        '<div class="set-row col"><div><div class="t">Monte o plano de manutenção do ' + esc(v.name) + '</div><div class="d">Com ele o app avisa quando trocar óleo, filtros e o resto. Você ajusta tudo depois.</div></div></div>' +
        opt('tpl:' + BASIC_PLAN.key, ICON.wrench, 'Começar pelo plano básico', 'Intervalos comuns da maioria dos carros; ajuste pelo manual') +
        tpls.filter((t) => t.key !== BASIC_PLAN.key).map((t) => opt('tpl:' + t.key, ICON.wrench, 'Plano do fabricante: ' + t.name, t.summary)).join('') +
        opt('new', ICON.plus, 'Montar do zero', 'Escolha os itens e os intervalos') +
        '<a class="row nav" href="#/importar"><span class="ic gray">' + ICON.chart + '</span><span class="mid"><span class="a">Importar OS ou planilha</span><span class="b">O histórico entra nas idas à oficina; com um plano, vira a base das próximas trocas</span></span><span class="chev">' + ICON.chev + '</span></a>';
      $('m-more').hidden = true;
      $('m-plan-note').textContent = 'Sem plano, você ainda pode registrar cada ida à oficina pelo botão acima.';
      $('m-target-card').hidden = true;
    } else {
      const states = sortStates(itemStates(plan, lastDoneByKey(v.id, d.services, d.items), curKm, today, kpd));
      // Aviso no topo: o mais urgente que pede ação
      const venc = states.find((s) => s.status === 'vencida');
      const semHist = states.find((s) => s.status === 'sem_historico' && (s.item.interval_km || s.item.interval_months));
      const every = (it: ItemState['item']) => [it.interval_km ? km(it.interval_km) + ' km' : '', it.interval_months ? it.interval_months + ' meses' : ''].filter(Boolean).join(' ou ');
      $('m-alert').innerHTML = venc
        ? '<div class="alert bad">' + ICON.warn + '<div><b>' + esc(venc.item.description) + ' vencida</b><span>' + esc(dueText(venc)) + '. Agende a troca.</span></div></div>'
        : semHist
          ? '<div class="alert">' + ICON.warn + '<div><b>' + esc(semHist.item.description) + ' sem registro</b><span>O plano pede ' + (semHist.item.action === 'inspecionar' ? 'inspeção' : 'troca') + ' a cada ' + esc(every(semHist.item)) + '. Pergunte na próxima revisão.</span></div></div>'
          : '';
      const shown = expanded ? states : states.slice(0, SHOW_FIRST);
      $('m-next').innerHTML = shown.map((s) => planRow(s, curKm, today)).join('');
      $('m-more').hidden = states.length <= SHOW_FIRST;
      $('m-more').textContent = expanded ? 'Mostrar menos' : 'Ver o plano completo (' + states.length + ' itens)';
      $('m-plan-note').innerHTML =
        esc(plan.name) + '. ' + esc(plan.summary) + (plan.sources.length ? ' Fontes: ' + plan.sources.map((x) => '<a href="' + esc(x.url) + '" target="_blank" rel="noopener">' + esc(x.label) + '</a>').join(' · ') + '.' : '') +
        ' <button type="button" class="link-btn" id="m-plan-edit">Editar plano</button>';
      // Quando chegar em X km
      $('m-target-card').hidden = false;
      const tEl = $<HTMLInputElement>('m-target');
      const def = Math.ceil((curKm + 1) / 10000) * 10000;
      const tgt = targetKm && targetKm > curKm ? targetKm : def;
      if (document.activeElement !== tEl) tEl.value = String(tgt);
      const r = dueByKm(states, tgt, curKm, today, kpd);
      $('m-target-when').textContent = r.targetDate ? '≈ ' + monthYear(r.targetDate) + ' no seu ritmo' : '';
      const names = (list: ItemState[]) => list.map((x) => x.item.description.toLowerCase()).join(', ');
      const trocar = r.due.filter((x) => x.item.action === 'trocar');
      const insp = r.due.filter((x) => x.item.action === 'inspecionar');
      const lines = [trocar.length ? 'Trocar ' + names(trocar) : '', insp.length ? 'Inspecionar ' + names(insp) : '', r.check.length ? 'Verificar (sem registro): ' + names(r.check) : ''].filter(Boolean);
      $('m-due').innerHTML = lines.length ? lines.map((l) => '<div>' + esc(l.charAt(0).toUpperCase() + l.slice(1)) + '</div>').join('') : 'Nada do plano vence até ' + km(tgt) + ' km.';
    }

    // Indicadores de manutenção
    const since = new Date(today + 'T12:00:00Z');
    since.setUTCFullYear(since.getUTCFullYear() - 1);
    const t12 = maintenanceTotals(v.id, d.services, d.items, since.toISOString().slice(0, 10));
    $('m-kpis').innerHTML = [
      ['Gasto em 12 meses', brl(t12.total), pl(t12.visits, 'ida à oficina', 'idas à oficina')],
      ['Peças × mão de obra', brl(t12.parts), 'mão de obra ' + brl(t12.labor)],
    ]
      .map((k) => '<div class="stat"><span class="k">' + k[0] + '</span><span class="v">' + k[1] + '</span><span class="s">' + k[2] + '</span></div>')
      .join('');

    // Idas à oficina
    $('m-hist-count').textContent = pl(svcs.length, 'registro', 'registros');
    $('m-hist').innerHTML = svcs.length
      ? svcs
          .map((s) => {
            const its = itemsOf(s.id);
            const tot = its.reduce((a, i) => a + i.parts_brl + i.labor_brl, 0);
            const hasAtt = !!s.attachment_path || d.pending.some((p) => p.service_id === s.id);
            const sub = [dmy(s.date), s.odometer_km ? km(s.odometer_km) + ' km' : '', pl(its.length, 'item', 'itens')].filter(Boolean).join(' · ');
            return (
              '<button type="button" class="row" data-svc="' + esc(s.id) + '"><span class="ic svc">' + ICON.wrench + '</span>' +
              '<span class="mid"><span class="a">' + esc(TYPE_LABEL[s.type] + (s.shop ? ' · ' + s.shop : '')) + '</span><span class="b">' + esc(sub) + '</span></span>' +
              '<span class="end"><span class="a">' + brl(tot) + '</span><span class="b' + (hasAtt ? ' blue' : '') + '">' + (hasAtt ? 'OS anexada' : TYPE_LABEL[s.type]) + '</span></span></button>'
            );
          })
          .join('')
      : '<div class="empty">Nenhuma manutenção registrada.</div>';

    $('plan-list').innerHTML = (plan?.items ?? []).map((i) => '<option value="' + esc(i.description) + '"></option>').join('');
  }

  function dueText(s: ItemState): string {
    const parts: string[] = [];
    if (s.due_km != null) parts.push((s.remaining_km! <= 0 ? 'venceu em ' : '') + km(s.due_km) + ' km');
    if (s.due_date) parts.push((s.remaining_days! <= 0 ? 'venceu em ' : 'até ') + monthYear(s.due_date));
    if (s.status !== 'vencida' && s.est_date && s.due_km != null) parts.push('≈ ' + monthYear(s.est_date));
    return parts.join(' · ');
  }

  function planRow(s: ItemState, curKm: number, today: string): string {
    const it = s.item;
    let left: string;
    let right = '';
    if (s.status === 'sem_historico') {
      left = 'Sem registro no app';
      right = it.interval_km || it.interval_months ? 'a cada ' + [it.interval_km ? km(it.interval_km) + ' km' : '', it.interval_months ? it.interval_months + ' meses' : ''].filter(Boolean).join(' ou ') : it.note ?? '';
    } else if (s.status === 'sem_intervalo') {
      left = 'Feito em ' + dmy(s.last_date!);
      right = it.note ?? '';
    } else {
      if (s.remaining_km != null) left = s.remaining_km > 0 ? (it.action === 'inspecionar' ? 'Inspeção em ' : 'Faltam ') + km(s.remaining_km) + ' km' : 'Passou ' + km(-s.remaining_km) + ' km';
      else left = s.remaining_days != null && s.remaining_days > 0 ? 'Troca por tempo' : 'Venceu pelo tempo';
      right = dueText(s);
    }
    const pct = progressOf(s, curKm, today);
    const tags = (it.action === 'inspecionar' ? '<span class="tag">inspeção</span>' : '') + (it.preliminary ? '<span class="tag">a confirmar</span>' : '');
    return (
      '<div class="plan-row"><div class="h"><span class="n">' + esc(it.description) + tags + '</span><span class="chip ' + s.status + '">' + STATUS_LABEL[s.status] + '</span></div>' +
      (pct != null ? '<div class="bar ' + s.status + '"><i style="width:' + Math.round(pct * 100) + '%"></i></div>' : '') +
      '<div class="row-meta"><span>' + esc(left) + '</span><span>' + esc(right) + '</span></div></div>'
    );
  }

  /* ---------- ações da aba ---------- */
  $('v-manut').addEventListener('click', async (e) => {
    const el = e.target as HTMLElement;
    const btn = el.closest<HTMLElement>('button');
    if (!btn) return;
    if (btn.id === 'm-new') return openService(null);
    if (btn.id === 'm-more') {
      expanded = !expanded;
      return render(data);
    }
    if (btn.dataset.plan && data.vehicle) {
      const id = btn.dataset.plan;
      const tpl = id.startsWith('tpl:') ? planByKey(id.slice(4)) : undefined;
      return openPlan(tpl ? { base: tpl.key, items: tpl.items.map((i) => ({ ...i })) } : { base: null, items: [] }, true);
    }
    if (btn.id === 'm-plan-edit' && data.vehicle) {
      const cur = planOf(data.vehicle);
      return openPlan({ base: data.vehicle.plan_custom?.base ?? data.vehicle.plan_key ?? null, items: (cur?.items ?? []).map((i) => ({ ...i })) }, false);
    }
    if (btn.dataset.svc) return openService(btn.dataset.svc);
  });
  $('v-manut').addEventListener('input', (e) => {
    if ((e.target as HTMLElement).id !== 'm-target') return;
    const n = c.parseIntLoose((e.target as HTMLInputElement).value);
    targetKm = Number.isFinite(n) ? n : null;
    render(data);
  });

  /* ---------- plano do carro: adotar um modelo, montar do zero, ajustar ou remover ---------- */
  let draft: CustomPlan | null = null;
  let draftNew = false;
  let planDelArmed = false;
  const COMMON: [string, string, PlanItem['action'], number | null, number | null][] = [
    ...BASIC_PLAN.items.map((i) => [i.key, i.description, i.action, i.interval_km, i.interval_months] as [string, string, PlanItem['action'], number | null, number | null]),
    ['fluido_cambio', 'Fluido do câmbio', 'trocar', 60000, null],
    ['meu_pastilhas_de_freio', 'Pastilhas de freio', 'inspecionar', 10000, null],
    ['meu_alinhamento_e_balanceamento', 'Alinhamento e balanceamento', 'trocar', 10000, 12],
    ['meu_correia_dentada', 'Correia dentada', 'trocar', 60000, 48],
    ['meu_pneus', 'Pneus', 'inspecionar', 10000, 12],
  ];

  function openPlan(p: CustomPlan, isNew: boolean) {
    draft = p;
    draftNew = isNew;
    planDelArmed = false;
    renderPlan();
    c.openSheet('plan-sheet');
  }

  function renderPlan() {
    if (!draft || !data.vehicle) return;
    const base = planByKey(draft.base);
    const num = (n: number | null) => (n == null ? '' : String(n));
    $('plan-title').textContent = draftNew ? 'Plano do ' + data.vehicle.name : 'Editar plano';
    $('plan-sub').textContent = base ? 'Partindo de: ' + base.name + '. Ajuste pelo manual do seu carro; deixe em branco o que não tiver intervalo.' : 'Escolha os itens e os intervalos. Deixe em branco o que não tiver intervalo.';
    $('plan-items').innerHTML = draft.items.length
      ? draft.items.map((it, i) =>
          '<div class="plan-edit" data-i="' + i + '">' +
          '<div class="r1"><input class="inp sm" data-p="description" value="' + esc(it.description) + '" aria-label="Item"><button type="button" class="link-btn muted" data-prm="' + i + '" aria-label="Tirar do plano">Tirar</button></div>' +
          '<div class="r2"><label class="mini"><span>O que fazer</span><select class="inp sm" data-p="action"><option value="trocar"' + (it.action === 'trocar' ? ' selected' : '') + '>Trocar</option><option value="inspecionar"' + (it.action === 'inspecionar' ? ' selected' : '') + '>Inspecionar</option></select></label>' +
          '<label class="mini"><span>A cada (km)</span><input class="inp sm" data-p="interval_km" inputmode="numeric" placeholder="—" value="' + num(it.interval_km) + '"></label>' +
          '<label class="mini"><span>Ou (meses)</span><input class="inp sm" data-p="interval_months" inputmode="numeric" placeholder="—" value="' + num(it.interval_months) + '"></label></div></div>').join('')
      : '<div class="empty">Nenhum item ainda. Adicione abaixo.</div>';
    const have = new Set(draft.items.map((i) => i.key));
    $('plan-add').innerHTML = '<option value="">+ Adicionar item…</option>' + COMMON.filter(([k]) => !have.has(k)).map(([k, d]) => '<option value="' + esc(k) + '">' + esc(d) + '</option>').join('') + '<option value="__outro">Outro (escrever)</option>';
    $('plan-del').hidden = draftNew;
    $('plan-del').textContent = planDelArmed ? 'Confirmar: remover o plano' : 'Remover plano';
    $('plan-del').classList.toggle('armed', planDelArmed);
  }

  /** Lê os campos da folha para o rascunho (sem redesenhar, para não perder o foco). */
  function readPlan() {
    if (!draft) return;
    document.querySelectorAll<HTMLElement>('#plan-items .plan-edit').forEach((row) => {
      const it = draft!.items[Number(row.dataset.i)];
      if (!it) return;
      const q = (k: string) => row.querySelector<HTMLInputElement>('[data-p="' + k + '"]')!.value;
      it.description = q('description').trim().slice(0, 80) || it.description;
      it.action = q('action') as PlanItem['action'];
      const kmv = c.parseIntLoose(q('interval_km')), mv = c.parseIntLoose(q('interval_months'));
      it.interval_km = Number.isFinite(kmv) && kmv > 0 ? kmv : null;
      it.interval_months = Number.isFinite(mv) && mv > 0 ? mv : null;
    });
  }

  document.body.insertAdjacentHTML(
    'beforeend',
    `<form class="sheet full" id="plan-sheet" novalidate aria-labelledby="plan-title">
      <div class="sheet-bar">
        <button type="button" class="text-btn" data-close style="justify-self:start">Cancelar</button>
        <h2 id="plan-title">Plano</h2>
        <span></span>
      </div>
      <div class="sheet-body"><div class="stack">
        <p class="hint" id="plan-sub"></p>
        <div id="plan-items" class="view" style="gap:10px"></div>
        <select class="inp sm" id="plan-add" aria-label="Adicionar item ao plano"></select>
        <p class="hint">Remover o plano não apaga as idas à oficina já registradas.</p>
        <button type="button" class="btn danger" id="plan-del">Remover plano</button>
      </div></div>
      <div class="sheet-foot"><button type="submit" class="btn primary block">Salvar plano</button></div>
    </form>`,
  );
  $('plan-items').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-prm]');
    if (!b || !draft) return;
    readPlan();
    draft.items.splice(Number(b.dataset.prm), 1);
    renderPlan();
  });
  $('plan-add').addEventListener('change', () => {
    const sel = $<HTMLSelectElement>('plan-add');
    if (!draft || !sel.value) return;
    readPlan();
    if (sel.value === '__outro') {
      draft.items.push({ key: customKey('item ' + Date.now().toString(36)), description: 'Novo item', action: 'trocar', interval_km: null, interval_months: 12, preliminary: false });
      renderPlan();
      const inputs = document.querySelectorAll<HTMLInputElement>('#plan-items [data-p="description"]');
      inputs[inputs.length - 1]?.select();
      return;
    }
    const cmn = COMMON.find(([k]) => k === sel.value);
    if (cmn) draft.items.push({ key: cmn[0], description: cmn[1], action: cmn[2], interval_km: cmn[3], interval_months: cmn[4], preliminary: false });
    renderPlan();
  });
  $('plan-del').addEventListener('click', async () => {
    const v = data.vehicle;
    if (!v) return;
    if (!planDelArmed) { planDelArmed = true; return renderPlan(); }
    await db.vehicles.put(stamp<Vehicle>({ ...v, plan_key: null, plan_custom: null }));
    draft = null;
    c.closeSheets();
    toast('Plano removido. As idas à oficina continuam no histórico.');
  });
  $('plan-sheet').addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = data.vehicle;
    if (!v || !draft) return;
    readPlan();
    const items = draft.items.filter((i) => i.description.trim());
    if (!items.length) return toast('Adicione pelo menos um item, ou use "Remover plano".');
    // itens escritos pela pessoa ganham chave própria; os da lista mantêm a chave (a importação reconhece)
    const seen = new Set<string>();
    for (const it of items) {
      if (it.key.startsWith('meu_item_')) it.key = customKey(it.description);
      while (seen.has(it.key)) it.key += '_2';
      seen.add(it.key);
      it.preliminary = false;
      delete it.severe_km;
    }
    await db.vehicles.put(stamp<Vehicle>({ ...v, plan_key: null, plan_custom: { base: draft.base, items } }));
    draft = null;
    c.closeSheets();
    toast(draftNew ? 'Plano criado para o ' + v.name : 'Plano atualizado');
  });

  /* ---------- formulário de manutenção ---------- */
  let editing: Service | null = null;
  let attach: { blob: Blob; name: string; type: string; pendingId: string | null } | null = null;
  let delArmed = false;

  function itemRow(it: { id: string; description: string; plan_item_key: string | null; parts_brl: number; labor_brl: number }) {
    const plan = data.vehicle ? planOf(data.vehicle) : undefined;
    const opts = '<option value="">Fora do plano</option>' + (plan?.items ?? []).map((p) => '<option value="' + esc(p.key) + '"' + (p.key === it.plan_item_key ? ' selected' : '') + '>' + esc(p.description) + '</option>').join('');
    const money = (n: number) => (n ? c.fmt(n, 2) : '');
    return (
      '<div class="item-row" data-id="' + esc(it.id) + '">' +
      '<div class="r1"><input class="inp sm" data-f="description" list="plan-list" placeholder="Descrição (ex.: Óleo 5W30)" value="' + esc(it.description) + '" aria-label="Descrição">' +
      '<button type="button" class="link-btn muted" data-rm aria-label="Remover item">Remover</button></div>' +
      '<select class="inp sm" data-f="plan" aria-label="Item do plano">' + opts + '</select>' +
      '<div class="grid2"><label class="field">Peça R$<input class="inp sm" data-f="parts" inputmode="decimal" value="' + money(it.parts_brl) + '"></label>' +
      '<label class="field">Mão de obra R$<input class="inp sm" data-f="labor" inputmode="decimal" value="' + money(it.labor_brl) + '"></label></div></div>'
    );
  }

  function readItems() {
    return [...document.querySelectorAll<HTMLElement>('#svc-items .item-row')].map((row) => {
      const q = (f: string) => row.querySelector<HTMLInputElement>('[data-f="' + f + '"]')!.value;
      const parts = c.parseNum(q('parts'));
      const labor = c.parseNum(q('labor'));
      return { id: row.dataset.id!, description: q('description').trim(), plan_item_key: q('plan') || null, parts_brl: Number.isFinite(parts) ? parts : 0, labor_brl: Number.isFinite(labor) ? labor : 0 };
    });
  }

  function updateTotal() {
    const its = readItems();
    const p = its.reduce((s, i) => s + i.parts_brl, 0);
    const l = its.reduce((s, i) => s + i.labor_brl, 0);
    $('svc-total').innerHTML = '<b>' + brl(p + l) + '</b> · peças ' + brl(p) + ' · m.o. ' + brl(l);
  }

  function renderAttach() {
    const hasRemote = !!editing?.attachment_path;
    const localPending = editing ? data.pending.find((p) => p.service_id === editing!.id) : null;
    const d = $('svc-att-d');
    if (attach) d.textContent = attach.name + (hasRemote ? ' (substitui o anexo atual)' : '');
    else if (localPending) d.textContent = localPending.name + ' · aguardando envio';
    else if (hasRemote) d.textContent = 'Guardada na nuvem';
    else d.textContent = 'Nenhum arquivo';
    $('svc-att-view').hidden = !(attach || localPending || hasRemote);
    $('svc-att-add').textContent = attach || localPending || hasRemote ? 'Trocar' : 'Anexar';
  }

  function openService(id: string | null) {
    const v = data.vehicle;
    if (!v) return toast('Cadastre o carro primeiro.');
    editing = id ? data.services.find((s) => s.id === id) ?? null : null;
    attach = null;
    delArmed = false;
    const del = $('svc-del');
    del.hidden = !editing;
    del.classList.remove('armed');
    del.textContent = 'Excluir';
    $('svc-title').textContent = editing ? 'Editar manutenção' : 'Registrar manutenção';
    $('svc-err').hidden = true;
    const set = (i: string, val: unknown) => ($<HTMLInputElement>(i).value = val == null ? '' : String(val));
    const src = editing;
    set('svc-date', src?.date ?? c.todayISO());
    set('svc-km', src?.odometer_km ?? '');
    set('svc-shop', src?.shop ?? '');
    set('svc-os', src?.os_number ?? '');
    set('svc-type', src?.type ?? 'revisao');
    set('svc-note', editing?.note ?? '');
    const lastShop = data.services.filter((s) => s.vehicle_id === v.id && !s.deleted_at && s.shop).sort((a, b) => b.date.localeCompare(a.date))[0]?.shop;
    $<HTMLInputElement>('svc-shop').placeholder = lastShop ?? 'Nome da oficina';
    const rows = editing
      ? data.items.filter((i) => i.service_id === editing!.id && !i.deleted_at).sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || a.description.localeCompare(b.description))
      : [{ id: uuid(), description: '', plan_item_key: null, parts_brl: 0, labor_brl: 0 }];
    $('svc-items').innerHTML = rows.map(itemRow).join('');
    $('svc-warn').hidden = true;
    $('svc-check').hidden = true;
    updateTotal();
    renderAttach();
    c.openSheet('svc-sheet');
  }

  $('svc-add-item').addEventListener('click', () => {
    $('svc-items').insertAdjacentHTML('beforeend', itemRow({ id: uuid(), description: '', plan_item_key: null, parts_brl: 0, labor_brl: 0 }));
    const rows = $('svc-items').querySelectorAll<HTMLInputElement>('[data-f="description"]');
    rows[rows.length - 1]?.focus();
  });
  $('svc-items').addEventListener('click', (e) => {
    const rm = (e.target as HTMLElement).closest('[data-rm]');
    if (rm) {
      rm.closest('.item-row')?.remove();
      updateTotal();
    }
  });
  $('svc-items').addEventListener('input', (e) => {
    const el = e.target as HTMLInputElement;
    if (el.dataset.f === 'description') {
      const plan = data.vehicle ? planOf(data.vehicle) : undefined;
      const match = plan?.items.find((i) => i.description.toLowerCase() === el.value.trim().toLowerCase());
      const sel = el.closest('.item-row')!.querySelector<HTMLSelectElement>('[data-f="plan"]')!;
      if (match && !sel.value) sel.value = match.key;
    }
    updateTotal();
  });

  $('svc-att-add').addEventListener('click', () => $<HTMLInputElement>('svc-att-file').click());
  $<HTMLInputElement>('svc-att-file').addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement;
    const f = input.files?.[0];
    input.value = '';
    if (!f) return;
    if (f.size > 10 * 1024 * 1024) return toast('Arquivo grande demais (máximo 10 MB).');
    attach = { blob: f, name: f.name, type: f.type, pendingId: null };
    renderAttach();
  });
  $('svc-att-view').addEventListener('click', async () => {
    const localPending = editing ? data.pending.find((p) => p.service_id === editing!.id) : null;
    const blob = attach?.blob ?? localPending?.blob;
    try {
      const href = blob ? URL.createObjectURL(blob) : await attachmentUrl(editing!.attachment_path!);
      const a = document.createElement('a');
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (err) {
      toast((err as Error).message);
    }
  });

  $('svc-del').addEventListener('click', async () => {
    if (!editing) return;
    if (!delArmed) {
      delArmed = true;
      $('svc-del').classList.add('armed');
      $('svc-del').textContent = 'Confirmar';
      return;
    }
    const sid = editing.id;
    await softDelete(db.services, sid);
    for (const it of data.items.filter((i) => i.service_id === sid && !i.deleted_at)) await softDelete(db.service_items, it.id);
    await db.pending_files.where('service_id').equals(sid).delete();
    c.closeSheets();
    toast('Manutenção excluída');
  });

  $('svc-sheet').addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = data.vehicle!;
    const err = (m: string) => {
      $('svc-err').textContent = m;
      $('svc-err').hidden = false;
    };
    const val = (i: string) => $<HTMLInputElement>(i).value.trim();
    const date = val('svc-date');
    if (!date) return err('Informe a data.');
    const kmv = c.parseIntLoose(val('svc-km'));
    const items = readItems().filter((i) => i.description || i.parts_brl || i.labor_brl);
    if (!items.length) return err('Adicione pelo menos um item.');
    if (items.some((i) => !i.description)) return err('Dê uma descrição a cada item.');
    const sid = editing?.id ?? uuid();
    const svc = stamp<Service>({
      id: sid,
      vehicle_id: editing?.vehicle_id ?? v.id,
      date,
      odometer_km: Number.isFinite(kmv) ? kmv : null,
      shop: val('svc-shop').slice(0, 80) || null,
      os_number: val('svc-os').slice(0, 40) || null,
      type: val('svc-type') as Service['type'],
      note: val('svc-note').slice(0, 300) || null,
      attachment_path: editing?.attachment_path ?? null,
    });
    const keep = new Set(items.map((i) => i.id));
    const old = editing ? data.items.filter((i) => i.service_id === sid && !i.deleted_at) : [];
    await db.transaction('rw', db.services, db.service_items, db.pending_files, async () => {
      await db.services.put(svc);
      for (const [position, it] of items.entries()) {
        const prev = old.find((o) => o.id === it.id);
        await db.service_items.put(
          stamp<ServiceItem>({
            id: it.id,
            service_id: sid,
            description: it.description.slice(0, 160),
            plan_item_key: it.plan_item_key,
            parts_brl: Math.round(it.parts_brl * 100) / 100,
            labor_brl: Math.round(it.labor_brl * 100) / 100,
            next_due_km: prev?.next_due_km ?? null,
            next_due_date: prev?.next_due_date ?? null,
            position,
          }),
        );
      }
      for (const o of old) if (!keep.has(o.id)) await softDelete(db.service_items, o.id);
      if (attach) {
        await db.pending_files.where('service_id').equals(sid).delete();
        if (attach.pendingId) await db.pending_files.update(attach.pendingId, { status: 'anexo', service_id: sid });
        else await db.pending_files.put({ id: uuid(), vehicle_id: svc.vehicle_id, service_id: sid, status: 'anexo', name: attach.name, type: attach.type, blob: attach.blob, created_at: new Date().toISOString() });
      }
    });
    c.closeSheets();
    toast(editing ? 'Manutenção atualizada' : 'Manutenção salva');
  });

  return { render, openService: (id: string) => openService(id) };
}
