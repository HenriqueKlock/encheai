// Meu carro: resumo do consumo, histórico (abastecimentos e manutenções), manutenção,
// indicadores e a calculadora de etanol × gasolina.
import { setMeta, type FuelLog, type Vehicle } from '../db';
import { aggregate, intervals, kmPerDay, parseNum, type Interval } from '../calc';
import { CATALOG, computeIndicators, monthKey, monthName, monthlySpend, pricePoints, tankSeries, type IndicatorId, type Period } from '../indicators';
import { kmlBars, monthBars, priceLine, sparkBars } from '../charts';
import { setHomePrefs } from '../sync';
import { S, carIntervals, carLogs, carServices, current, subscribe, type CalcCfg } from '../store';
import { initMaintenance, currentKmOf } from '../manut';
import { $, brl, cap, closeSheets, dm, esc, fmt, km, monthYear, openSheet, pl, todayISO, toast, FUEL_LABEL } from '../ui';
import { currentRoute, onShow, type Route } from '../router';
import { parseIntLoose } from '../calc';
import { ICON } from '../icons';
import { isNovo } from '../visual';
import { planOf } from '../plans';
import { itemStates, lastDoneByKey, progressOf, sortStates } from '../maintenance';
import { AFTER_SHORT, canAskAfter, usedEnough, type AfterEffect } from '../depois';

const FUEL_TYPE: Record<string, string> = { flex: 'flex', gasolina: 'gasolina', etanol: 'etanol', diesel: 'diesel' };
const SWAP = '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M7 7h11l-3-3M17 17H6l3 3"/></svg>';
const UP = '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 19V5M6 11l6-6 6 6"/></svg>';
const DOWN = '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 5v14M6 13l6 6 6-6"/></svg>';
const SVC_LABEL = { revisao: 'Revisão', corretiva: 'Conserto', pneus: 'Pneus', outros: 'Manutenção' } as const;

export function initCarro(fill: { open: (id: string | null) => void; openRating: (id: string) => void }) {
  let sub: 'resumo' | 'historico' | 'manutencao' = 'resumo';
  let histFilter: 'tudo' | 'abast' | 'manut' = 'tudo';
  let period: Period = 'tudo';
  const maint = initMaintenance({ $, fmt, brl, km, esc, pl, todayISO, toast, openSheet, closeSheets, parseNum, parseIntLoose });

  function indInput() {
    const v = current()!;
    return { vehicleId: v.id, logs: carLogs(), services: S.services, items: S.items, today: todayISO() };
  }

  function render() {
    const v = current();
    document.querySelectorAll<HTMLElement>('.car-name').forEach((el) => (el.textContent = v ? v.name : 'Cadastrar carro'));
    const r = currentRoute();
    if (r.view === 'carro') {
      document.querySelectorAll<HTMLElement>('#carro-tabs a').forEach((a) => a.setAttribute('aria-selected', String(a.dataset.sub === sub)));
      $('carro-resumo').hidden = sub !== 'resumo';
      $('carro-hist').hidden = sub !== 'historico';
      $('v-manut').hidden = sub !== 'manutencao';
      if (sub === 'resumo') renderResumo(v);
      if (sub !== 'resumo') renderHead2(v);
      if (sub === 'historico') renderHist(v);
      if (sub === 'manutencao') maint.render({ vehicle: v, logs: carLogs(), services: S.services, items: S.items, pending: S.files });
    }
    if (r.view === 'indicadores') renderIndicadores(v);
    if (r.view === 'etanol') renderCalc(v, carLogs(), carIntervals());
  }

  /* ---------- resumo ---------- */
  /** Visual novo: o nome do carro como título, consumo com barras e números, manutenção com anéis. */
  function renderHead2(v: Vehicle | undefined) {
    const el = $('carro-head2');
    if (!isNovo()) { el.innerHTML = ''; return; }
    const curKm = v ? currentKmOf(v, carLogs(), S.services) : 0;
    const sub = v ? [[v.make, v.year].filter(Boolean).join(' '), FUEL_TYPE[v.fuel_type] ?? '', curKm ? km(curKm) + ' km' : ''].filter(Boolean).join(' · ') : '';
    el.innerHTML = '<div class="car2-head"><div><h1>' + esc(v ? v.name : 'Meu carro') + '</h1>' + (sub ? '<span>' + esc(sub) + '</span>' : '') + '</div>' +
      '<button type="button" class="x2" data-act="cars" aria-label="Trocar de carro">' + SWAP + '</button></div>';
  }

  function renderResumoNovo(v: Vehicle) {
    const el = $('carro-resumo');
    const fs = carLogs();
    const iv = carIntervals();
    const all = aggregate(iv);
    const last = iv[iv.length - 1];
    const rpk = all.km > 0 ? fs.filter((f) => iv.some((i) => i.id === f.id)).reduce((a, f) => a + f.total_brl, 0) / all.km : NaN;
    const kpd = kmPerDay(fs);
    const diff = last && iv.length > 1 ? last.kml / all.kml - 1 : NaN;
    const badge = Number.isFinite(diff) && Math.abs(diff) >= 0.01
      ? '<span class="cb2 ' + (diff > 0 ? 'up' : 'down') + '">' + (diff > 0 ? UP : DOWN) + Math.round(Math.abs(diff) * 100) + '% no último tanque</span>'
      : '';
    const bars = iv.slice(-8);
    const min = bars.length ? Math.min(...bars.map((d) => d.kml)) * 0.75 : 0, max = bars.length ? Math.max(...bars.map((d) => d.kml)) : 1;
    const g = aggregate(iv.filter((x) => x.fuel === 'gasolina')), e = aggregate(iv.filter((x) => x.fuel === 'etanol'));
    const third = v.fuel_type === 'flex'
      ? '<div><span>Etanol rende</span><b>' + (g.n && e.n ? Math.round((e.kml / g.kml) * 100) : 70) + '%</b>' + (g.n && e.n ? '' : '<em>estimado</em>') + '</div>'
      : '<div><span>Gasto total</span><b>' + brl(fs.reduce((a, f) => a + f.total_brl, 0)).replace(/,\d\d$/, '') + '</b></div>';
    const consumo =
      '<a class="card cons2" href="#/indicadores"><div class="cons2-top"><div><span class="k">Consumo médio</span><span class="v">' + (iv.length ? fmt(all.kml, 1) : '–') + ' <small>km/l</small></span></div>' + badge + '</div>' +
      (bars.length > 1
        ? '<div class="cons2-bars" aria-hidden="true">' + bars.map((d, i) => '<i' + (i === bars.length - 1 ? ' class="on"' : '') + ' style="height:' + Math.round(25 + ((d.kml - min) / (max - min || 1)) * 75) + '%"></i>').join('') + '</div>'
        : '<span class="hint">' + (fs.length ? 'Registre mais um tanque cheio para calcular o consumo.' : 'Toque em Abastecer para registrar o primeiro abastecimento.') + '</span>') +
      '<div class="cons2-stats"><div><span>Custo por km</span><b>' + (Number.isFinite(rpk) ? brl(rpk) : '–') + '</b></div>' +
      '<div><span>Por mês</span><b>' + (Number.isFinite(kpd) && kpd > 0 ? km(kpd * 30) + ' km' : '–') + '</b></div>' + third + '</div></a>';
    // manutenção: os três próximos itens do plano, com anel do quanto do intervalo já passou
    const plan = planOf(v);
    let manut = '';
    if (plan) {
      const curKm = currentKmOf(v, fs, S.services);
      const today = todayISO();
      const states = sortStates(itemStates(plan, lastDoneByKey(v.id, S.services, S.items), curKm, today, kmPerDay(fs)))
        .filter((x) => x.status === 'vencida' || x.status === 'proxima' || x.status === 'em_dia').slice(0, 3);
      const ring = (pct: number | null, st: string) => '<svg class="ring3 ' + st + '" aria-hidden="true" width="40" height="40" viewBox="0 0 36 36"><circle cx="18" cy="18" r="14" class="tr"/><circle cx="18" cy="18" r="14" class="fg" stroke-dasharray="' + ((pct ?? 0) * 88).toFixed(1) + ' 88" transform="rotate(-90 18 18)"/></svg>';
      manut = states.length
        ? '<a class="card mt2" href="#/carro/manutencao">' + states.map((x) => {
          const right = x.status === 'vencida' ? 'vencida' : x.remaining_km != null ? 'em ' + km(x.remaining_km) + ' km' : x.due_date ? monthYear(x.due_date) : '';
          const done = x.last_km != null ? 'feito aos ' + km(x.last_km) + ' km' : x.last_date ? 'feito em ' + monthYear(x.last_date) : 'sem registro';
          return '<span class="mt2-row">' + ring(progressOf(x, curKm, today), x.status) + '<span class="mid"><b>' + esc(x.item.description) + '</b><span>' + esc(done) + '</span></span><b class="r ' + x.status + '">' + esc(right) + '</b></span>';
        }).join('') + '</a>'
        : '<a class="card mn2" href="#/carro/manutencao"><span class="mn2-ic">' + ICON.wrench + '</span><span class="mn2-b"><b class="mn2-t">Manutenção</b><span class="mn2-sub">Registre a última revisão para ver as próximas trocas</span></span>' + ICON.chev + '</a>';
    }
    el.innerHTML = consumo +
      (!fs.length && !S.services.some((s2) => s2.vehicle_id === v.id && !s2.deleted_at)
        ? '<a class="card start-card" href="#/importar"><span class="ic gray">' + ICON.upload + '</span><span class="mid"><span class="a">Já tem histórico do ' + esc(v.name) + '?</span><span class="b">Planilha, PDF de manutenção com a sua IA ou o Claude.</span></span><span class="chev">' + ICON.chev + '</span></a>'
        : '') +
      manut +
      '<div class="car2-links"><a href="#/indicadores">' + ICON.chart + 'Indicadores</a><a href="#/etanol"><b>%</b>Etanol × gasolina</a></div>';
  }

  function renderResumo(v: Vehicle | undefined) {
    const el = $('carro-resumo');
    renderHead2(v);
    if (v && isNovo()) return renderResumoNovo(v);
    if (!v) {
      el.innerHTML = '<div class="card"><span class="b15">Nenhum carro cadastrado</span><p class="hint">Cadastre seu carro para acompanhar consumo, gastos e manutenção.</p><button type="button" class="btn primary" data-act="cars">Cadastrar carro</button></div>';
      return;
    }
    const fs = carLogs();
    const iv = carIntervals();
    const all = aggregate(iv);
    const l3 = aggregate(iv.slice(-3));
    const curKm = currentKmOf(v, fs, S.services);
    const tot = fs.reduce((a, f) => a + f.total_brl, 0);
    const rpk = all.km > 0 ? fs.filter((f) => iv.some((i) => i.id === f.id)).reduce((a, f) => a + f.total_brl, 0) / all.km : NaN;
    const kpd = kmPerDay(fs);
    el.innerHTML =
      '<div class="card hero-card"><span class="hint">Consumo médio</span>' +
      '<div class="hero-val"><strong>' + (iv.length ? fmt(all.kml, 2) : '–') + '</strong><span>km/l</span></div>' +
      '<span class="hint">' + (iv.length ? (iv.length >= 3 ? 'Últimos 3 tanques: <b>' + fmt(l3.kml, 2) + '</b> · ' : '') + km(all.km) + ' km medidos em ' + pl(iv.length, 'tanque', 'tanques') : fs.length ? 'Registre mais um tanque cheio para calcular o consumo.' : 'Toque em Abastecer para registrar o primeiro abastecimento.') + '</span>' +
      '<div class="spark" aria-hidden="true">' + sparkBars(iv) + '</div></div>' +
      (!fs.length && !S.services.some((s) => s.vehicle_id === v.id && !s.deleted_at)
        ? '<a class="card start-card" href="#/importar"><span class="ic gray">' + ICON.upload + '</span><span class="mid"><span class="a">Já tem histórico do ' + esc(v.name) + '?</span><span class="b">Traga de uma planilha, de PDFs de manutenção com a sua IA ou pelo Claude. Você confere antes de gravar.</span></span><span class="chev">' + ICON.chev + '</span></a>'
        : '') +
      '<div class="stat-grid three"><div class="stat"><span class="k">Custo</span><span class="v">' + (Number.isFinite(rpk) ? brl(rpk) : '–') + '</span><span class="s">por km</span></div>' +
      '<div class="stat"><span class="k">Odômetro</span><span class="v">' + km(curKm) + '</span><span class="s">' + (Number.isFinite(kpd) && kpd > 0 ? '≈ ' + km(kpd * 30) + ' km/mês' : 'km') + '</span></div>' +
      '<div class="stat"><span class="k">Gasto total</span><span class="v">' + brl(tot) + '</span><span class="s">' + pl(fs.length, 'abastecimento', 'abastecimentos') + '</span></div></div>' +
      '<div class="list-card">' +
      '<a class="row nav" href="#/indicadores"><span class="ic blue">' + ICON.chart + '</span><span class="mid"><span class="a">Indicadores</span><span class="b">Gráficos e o que aparece no início</span></span><span class="chev">' + ICON.chev + '</span></a>' +
      '<a class="row nav" href="#/etanol"><span class="ic green">%</span><span class="mid"><span class="a">Etanol × gasolina</span><span class="b">Com o rendimento medido no seu carro</span></span><span class="chev">' + ICON.chev + '</span></a>' +
      '<a class="row nav" href="#/carro/manutencao"><span class="ic gray">' + ICON.wrench + '</span><span class="mid"><span class="a">Plano de manutenção</span><span class="b">Próximas trocas e idas à oficina</span></span><span class="chev">' + ICON.chev + '</span></a>' +
      '</div>';
  }

  /* ---------- histórico ---------- */
  function renderHist(v: Vehicle | undefined) {
    document.querySelectorAll<HTMLElement>('#hist-filter button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.f === histFilter)));
    if (!v) {
      $('hist').innerHTML = '<div class="empty">Cadastre um carro para começar.</div>';
      return;
    }
    const fs = carLogs();
    const iv = intervals(fs);
    const byStart = new Map(iv.map((x) => [x.id, x]));
    const today = todayISO();
    type Entry = { date: string; odo: number; html: string; total: number; kind: 'f' | 's' };
    const entries: Entry[] = [];
    if (histFilter !== 'manut') {
      const firstFull = fs.find((f) => f.full_tank);
      for (const f of fs) {
        const i = byStart.get(f.id);
        const metric = i ? fmt(i.kml, 2) + ' km/l' : !f.full_tank ? 'parcial' : f === firstFull ? 'primeiro tanque' : '–';
        const st = f.station ? f.station.split(' · ')[0] : null;
        const rt = S.ratings[f.id];
        const canRate = !!f.station_id && !rt && S.prefs.contribute && Math.round((Date.parse(today) - Date.parse(f.date)) / 864e5) <= 30;
        // avaliado, mas ainda sem dizer como o carro andou (e o carro já rodou com esse combustível)
        const askAfter = !!rt && S.prefs.contribute && canAskAfter(f, today, rt) && usedEnough(f, fs, today);
        const sub = [km(f.odometer_km) + ' km', brl(f.price_per_l || f.total_brl / f.liters) + '/l'].join(' · ');
        entries.push({
          date: f.date, odo: f.odometer_km, total: f.total_brl, kind: 'f',
          html:
            '<div class="hrow"><button type="button" class="row" data-fill="' + esc(f.id) + '"><span class="day"><b>' + f.date.slice(8, 10) + '</b><span>' + monthName(monthKey(f.date)).slice(0, 3) + '</span></span>' +
            '<span class="mid"><span class="a' + (st ? '' : ' muted') + '">' + (st ? esc(st) : 'Sem posto') + '</span><span class="b"><i class="dot ' + (f.fuel === 'etanol' ? 'eth' : 'gas') + '"></i>' + FUEL_LABEL[f.fuel] + ' ' + fmt(f.liters, 1) + ' l · ' + brl(f.total_brl) + '</span><span class="b">' + esc(sub) + '</span></span>' +
            '<span class="end"><span class="a' + (i && i.kml ? '' : ' muted') + '">' + metric + '</span></span></button>' +
            (askAfter ? '<button type="button" class="rate-chip" data-rate-fill="' + esc(f.id) + '">Como o carro andou?</button>'
              : rt ? '<button type="button" class="rate-chip done" data-rate-fill="' + esc(f.id) + '">' + ICON.check + '<span>' + esc(ratingSummary(rt)) + '</span></button>'
              : canRate ? '<button type="button" class="rate-chip" data-rate-fill="' + esc(f.id) + '">Avaliar o posto</button>' : '') + '</div>',
        });
      }
    }
    if (histFilter !== 'abast') {
      for (const s of carServices()) {
        const its = S.items.filter((i) => i.service_id === s.id);
        const tot = its.reduce((a, i) => a + i.parts_brl + i.labor_brl, 0);
        const hasAtt = !!s.attachment_path || S.files.some((p) => p.service_id === s.id);
        const sub = [s.odometer_km ? km(s.odometer_km) + ' km' : '', pl(its.length, 'item', 'itens'), hasAtt ? 'OS anexada' : ''].filter(Boolean).join(' · ');
        entries.push({
          date: s.date, odo: s.odometer_km ?? 0, total: tot, kind: 's',
          html: '<div class="hrow"><button type="button" class="row" data-svc="' + esc(s.id) + '"><span class="day svc"><b>' + s.date.slice(8, 10) + '</b><span>' + monthName(monthKey(s.date)).slice(0, 3) + '</span></span><span class="mid"><span class="a">' + esc(SVC_LABEL[s.type] + (s.shop ? ' · ' + s.shop : '')) + '</span><span class="b">' + ICON.wrench + ' ' + esc(sub) + '</span></span><span class="end"><span class="a">' + brl(tot) + '</span></span></button></div>',
        });
      }
    }
    if (!entries.length) {
      $('hist').innerHTML = '<div class="empty">' + (histFilter === 'manut' ? 'Nenhuma manutenção registrada.' : 'Nenhum abastecimento ainda.') + '<br><a class="link-btn" href="#/importar">Trazer histórico (planilha, PDF de manutenção ou Claude)</a></div>';
      return;
    }
    entries.sort((a, b) => b.date.localeCompare(a.date) || b.odo - a.odo);
    const thisYear = today.slice(0, 4);
    const months = new Map<string, Entry[]>();
    for (const e of entries) {
      const k = monthKey(e.date);
      if (!months.has(k)) months.set(k, []);
      months.get(k)!.push(e);
    }
    const unlinked = fs.filter((f) => !f.station_id && !f.station).length;
    $('hist').innerHTML =
      (unlinked && histFilter !== 'manut' ? '<p class="foot-note">' + pl(unlinked, 'abastecimento está', 'abastecimentos estão') + ' sem posto. Toque num deles para escolher o posto, ou abra a ficha do seu posto e use “É aqui que eu abasteço”.</p>' : '') +
      [...months.entries()]
        .map(([k, list]) => {
          const total = list.reduce((a, e) => a + e.total, 0);
          return '<div class="month-head"><span>' + cap(monthName(k)) + (k.slice(0, 4) !== thisYear ? ' ' + k.slice(0, 4) : '') + '</span><span>' + brl(total) + '</span></div><div class="list-card">' + list.map((e) => e.html).join('') + '</div>';
        })
        .join('');
  }
  $('hist-filter').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-f]');
    if (!b) return;
    histFilter = b.dataset.f as typeof histFilter;
    renderHist(current());
  });
  $('hist').addEventListener('click', (e) => {
    const el = e.target as HTMLElement;
    const rate = el.closest<HTMLElement>('[data-rate-fill]');
    if (rate) return fill.openRating(rate.dataset.rateFill!);
    const r = el.closest<HTMLElement>('[data-fill],[data-svc]');
    if (!r) return;
    if (r.dataset.fill) fill.open(r.dataset.fill);
    else maint.openService(r.dataset.svc!);
  });

  /* ---------- indicadores ---------- */
  function renderIndicadores(v: Vehicle | undefined) {
    if (!v) {
      $('ind-list').innerHTML = '<div class="empty">Cadastre um carro para ver os indicadores.</div>';
      ['ch-month', 'ch-price', 'ch-kml'].forEach((id) => ($(id).innerHTML = ''));
      return;
    }
    $('ind-car').textContent = v.name + ' · escolha o que aparece no início';
    const input = indInput();
    const ind = computeIndicators(input);
    const avg = aggregate(intervals(input.logs)).kml;
    const focusedId = (document.activeElement as HTMLElement | null)?.dataset?.ind;
    $('ind-list').innerHTML =
      '<div class="ind-row"><span class="mid"><span>Consumo médio</span><span>' + (Number.isFinite(avg) ? fmt(avg, 2) + ' km/l · ' : '') + 'sempre em destaque</span></span><span class="muted">' + ICON.lock + '</span></div>' +
      CATALOG.map((c) => {
        const x = ind[c.id];
        const on = S.prefs.ids.includes(c.id);
        return '<div class="ind-row"><span class="mid"><span>' + esc(x.name) + '</span><span>' + esc(x.value + (x.sub ? ' · ' + x.sub : '')) + '</span></span><input type="checkbox" class="switch" role="switch" data-ind="' + c.id + '"' + (on ? ' checked' : '') + ' aria-label="Mostrar no início: ' + esc(x.name) + '"></div>';
      }).join('');
    if (focusedId) document.querySelector<HTMLElement>('[data-ind="' + focusedId + '"]')?.focus();
    document.querySelectorAll<HTMLElement>('#ind-period button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.p === period)));
    $('ch-month').innerHTML = monthBars(monthlySpend(input, period));
    $('ch-price').innerHTML = priceLine(pricePoints(input, period));
    const totL = input.logs.reduce((s, f) => s + f.liters, 0);
    $('ch-price-avg').textContent = totL ? 'média ' + brl(input.logs.reduce((s, f) => s + f.total_brl, 0) / totL) : '';
    const t = tankSeries(input, period);
    $('ch-kml').innerHTML = kmlBars(t.list, t.avg);
    $('ch-kml-avg').textContent = Number.isFinite(t.avg) ? 'média ' + fmt(t.avg, 2) : '';
  }
  $('ind-list').addEventListener('change', async (e) => {
    const el = e.target as HTMLInputElement;
    if (!el.dataset.ind) return;
    const on = new Set(S.prefs.ids);
    if (el.checked) on.add(el.dataset.ind as IndicatorId);
    else on.delete(el.dataset.ind as IndicatorId);
    await setHomePrefs(CATALOG.map((c) => c.id).filter((id) => on.has(id)));
  });
  $('ind-period').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-p]');
    if (!b) return;
    period = b.dataset.p as Period;
    renderIndicadores(current());
  });

  /* ---------- etanol × gasolina ---------- */
  function calcModel(v: Vehicle | undefined, fs: FuelLog[], iv: Interval[]) {
    const c = S.calc;
    const lastGas = [...fs].reverse().find((f) => f.fuel === 'gasolina');
    const gasDefault = lastGas ? lastGas.price_per_l || lastGas.total_brl / lastGas.liters : NaN;
    const g = aggregate(iv.filter((x) => x.fuel === 'gasolina'));
    const e = aggregate(iv.filter((x) => x.fuel === 'etanol'));
    const measured = g.n > 0 && e.n > 0;
    const ratio = measured ? e.kml / g.kml : Number(c.ratio) || 0.7;
    const gas = Number.isFinite(parseNum(c.gas)) ? parseNum(c.gas) : gasDefault;
    const eth = parseNum(c.eth);
    const kmlG = g.n ? g.kml : NaN;
    const kmlE = e.n ? e.kml : kmlG * ratio;
    return { gasDefault, measured, ratio, gas, eth, kmlG, kmlE, eN: e.n, flex: !v || v.fuel_type === 'flex', kmMonth: kmPerDay(fs) * 30, gK: g, eK: e };
  }
  function renderCalc(v: Vehicle | undefined, fs: FuelLog[], iv: Interval[]) {
    const m = calcModel(v, fs, iv);
    const c = S.calc;
    const g = $<HTMLInputElement>('c-gas'), e = $<HTMLInputElement>('c-eth');
    if (document.activeElement !== g) g.value = c.gas || '';
    if (document.activeElement !== e) e.value = c.eth || '';
    if (Number.isFinite(m.gasDefault)) g.placeholder = fmt(m.gasDefault, 2);
    const thr = m.gas * m.ratio;
    const rEl = $<HTMLInputElement>('c-ratio');
    rEl.disabled = m.measured;
    if (document.activeElement !== rEl) rEl.value = m.ratio.toFixed(2);
    $('c-ratio-out').textContent = Math.round(m.ratio * 100) + '%';
    $('c-ratio-hint').textContent = !m.flex
      ? 'Este carro não é flex; a comparação serve só como referência.'
      : m.measured
        ? 'Medido neste carro: ' + fmt(m.eK.kml, 2) + ' km/l no etanol vs ' + fmt(m.gK.kml, 2) + ' na gasolina.'
        : 'Estimativa pela regra dos 70%. Quando você registrar tanques de etanol, o app passa a usar o rendimento real.';
    $('c-thr').textContent = Number.isFinite(m.gas) ? brl(thr) : '–';
    $('c-thr-sub').textContent = Number.isFinite(m.gas) ? 'com gasolina a ' + brl(m.gas) + ' e rendimento de ' + Math.round(m.ratio * 100) + '%' : 'Informe o preço da gasolina.';
    const box = $('c-verdict');
    if (!Number.isFinite(m.gas) || !Number.isFinite(m.eth)) {
      box.innerHTML = '<span class="hint">Digite o preço do etanol no posto para ver qual compensa.</span>';
      return;
    }
    const pct = m.eth / m.gas;
    const ethWins = pct < m.ratio;
    const rpkG = m.gas / m.kmlG, rpkE = m.eth / m.kmlE;
    const diffM = Math.abs(rpkG - rpkE) * m.kmMonth;
    box.innerHTML =
      '<span class="hint">Etanol custa ' + fmt(pct * 100, 1) + '% da gasolina</span>' +
      '<span style="font-size:28px;font-weight:600;letter-spacing:-.5px;color:var(' + (ethWins ? '--eth' : '--gas') + ')">' + (ethWins ? 'Vá de etanol' : 'Fique na gasolina') + '</span>' +
      (Number.isFinite(rpkG)
        ? '<div class="grid2"><div><div class="hint">Gasolina</div><div style="font-size:20px;font-weight:600">' + brl(rpkG) + '/km</div><div class="hint">' + fmt(m.kmlG, 2) + ' km/l</div></div><div><div class="hint">Etanol</div><div style="font-size:20px;font-weight:600">' + brl(rpkE) + '/km</div><div class="hint">' + fmt(m.kmlE, 2) + ' km/l' + (m.eN ? '' : ' (estimado)') + '</div></div></div>'
        : '') +
      (Number.isFinite(diffM) ? '<span class="hint">Diferença de ≈ ' + brl(diffM) + ' por mês no seu ritmo de ' + km(m.kmMonth) + ' km.</span>' : '');
  }
  let calcTimer: number | undefined;
  function saveCalc(patch: Partial<CalcCfg>) {
    S.calc = { ...S.calc, ...patch };
    renderCalc(current(), carLogs(), carIntervals());
    clearTimeout(calcTimer);
    calcTimer = window.setTimeout(() => setMeta('calc', S.calc), 400);
  }
  $('c-gas').addEventListener('input', (e) => saveCalc({ gas: (e.target as HTMLInputElement).value }));
  $('c-eth').addEventListener('input', (e) => saveCalc({ eth: (e.target as HTMLInputElement).value }));
  $('c-ratio').addEventListener('input', (e) => saveCalc({ ratio: Number((e.target as HTMLInputElement).value) }));

  subscribe(render);
  onShow('carro', (r: Route) => {
    sub = r.sub === 'historico' ? 'historico' : r.sub === 'manutencao' ? 'manutencao' : 'resumo';
    render();
  });
  onShow('indicadores', () => render());
  onShow('etanol', () => render());
  return { render, dm };
}

/** "bomba ok · banheiro ruim": resumo da avaliação no histórico. */
function ratingSummary(r: { bomba: 1 | -1 | null; atendimento: 1 | -1 | null; banheiro: 1 | -1 | null; stars?: number | null; after_effect?: AfterEffect | null }) {
  const parts = [
    r.stars ? r.stars + '★' : '',
    r.after_effect ? AFTER_SHORT[r.after_effect] : '',
    r.bomba != null ? 'bomba ' + (r.bomba > 0 ? 'ok' : 'errada') : '',
    r.atendimento != null ? 'atendimento ' + (r.atendimento > 0 ? 'bom' : 'ruim') : '',
    r.banheiro != null ? 'banheiro ' + (r.banheiro > 0 ? 'bom' : 'ruim') : '',
  ].filter(Boolean);
  return parts.join(' · ');
}
