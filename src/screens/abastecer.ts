// Abastecer: o posto vem do GPS (com um toque para trocar), o preço sugerido vem da rede ou da ANP,
// e depois de salvar o app pede uma avaliação de um toque (bomba, atendimento, banheiro).
import { db, softDelete, stamp, uuid, type FuelLog, type FuelType } from '../db';
import { aggregate, intervals, parseIntLoose, parseNum } from '../calc';
import { gps } from '../lugares';
import { ageDays, type Fuel, type PricePoint, type Station } from '../postos';
import { currentSession, deleteRating, saveRating, type RatingRow, type Vote } from '../sync';
import { AFTER_OPTIONS, MAX_DAYS, canAskAfter, previousFill, tankVsNormal, usedEnough, type AfterEffect } from '../depois';
import { invalidateNetwork } from '../rede';
import { S, carInfo, carIntervals, carLogs, current } from '../store';
import { $, ago, brl, closeSheets, dm, esc, fmt, km, openSheet, pl, todayISO, toast } from '../ui';
import { go } from '../router';
import { stationLabel, type PostosApi } from './postos';
import { ICON } from '../icons';
import { isNovo } from '../visual';

type Picked = { s: Station; how: 'gps' | 'escolha' | 'registro'; d?: number } | { s: null; text: string } | null;

export function initAbastecer(postos: PostosApi, needCar: () => void) {
  let editing: FuelLog | null = null;
  let picked: Picked = null;
  let detecting = false;
  let pickerOpen = false;
  let pickerQ = '';
  let here: { lat: number; lon: number } | null = null;
  let delArmed = false;
  let recent: string[] = [];
  let priceAuto = false;
  const FIELD_OF = { total: 'fld-total', liters: 'fld-liters', price: 'fld-price' } as const;

  const fuelNow = (): Fuel | null => {
    const v = current();
    if (!v) return null;
    if (v.fuel_type === 'flex') return $<HTMLInputElement>('f-fuel-e').checked ? 'etanol' : 'gasolina';
    return v.fuel_type === 'gasolina' || v.fuel_type === 'etanol' ? v.fuel_type : null;
  };

  /* ---------- posto ---------- */
  function renderStation() {
    const box = $('f-station-box');
    const sName = (s: Station) => postos.nameOf(s);
    let head: string;
    if (picked && picked.s) {
      const sub = picked.how === 'gps' ? 'reconhecido pelo GPS' + (picked.d != null ? ' · a ' + Math.max(10, Math.round((picked.d * 1000) / 10) * 10) + ' m' : '') : picked.how === 'registro' ? picked.s.e : 'escolhido · ' + picked.s.e;
      head = '<div class="st-box ' + (picked.how === 'gps' ? 'gps' : '') + '"><span class="ic">' + PIN + '</span><span class="mid"><span class="a">' + esc(sName(picked.s)) + '</span><span class="b">' + esc(sub) + '</span></span><button type="button" class="link-btn" data-st="toggle">' + (pickerOpen ? 'Fechar' : 'Trocar') + '</button></div>';
    } else if (picked && !picked.s) {
      head = '<div class="st-box"><span class="ic">' + PIN + '</span><span class="mid"><span class="a">' + esc(picked.text) + '</span><span class="b">anotado à mão</span></span><button type="button" class="link-btn" data-st="toggle">' + (pickerOpen ? 'Fechar' : 'Trocar') + '</button></div>';
    } else if (detecting) {
      head = '<div class="st-box empty"><span class="ic spin">' + PIN + '</span><span class="mid"><span class="a">Procurando o posto…</span><span class="b">pelo GPS do celular</span></span><button type="button" class="link-btn" data-st="toggle">Escolher</button></div>';
    } else {
      head = '<button type="button" class="st-box empty" data-st="toggle"><span class="ic">' + PIN + '</span><span class="mid"><span class="a">Qual posto?</span><span class="b">Ligar ao posto mede o rendimento e ajuda a rede</span></span><span class="chev">' + ICON.chev + '</span></button>';
    }
    box.innerHTML = head + (pickerOpen ? picker() : '');
    if (pickerOpen) {
      const q = document.getElementById('f-pick-q') as HTMLInputElement | null;
      if (q && document.activeElement !== q) q.value = pickerQ;
    }
  }

  function picker() {
    const list: { s: Station; note: string }[] = [];
    const seen = new Set<string>();
    const add = (s: Station | null, note: string) => {
      if (!s || seen.has(s.c)) return;
      seen.add(s.c);
      list.push({ s, note });
    };
    const q = norm(pickerQ);
    if (q.length >= 3) {
      const center = here ?? postos.place('casa') ?? postos.place('trabalho');
      const pool = center ? postos.nearby(center, 40).map((x) => x.s) : [];
      for (const s of pool) {
        if (list.length >= 12) break;
        if (norm(postos.nameOf(s) + ' ' + s.n + ' ' + s.e + ' ' + s.b + ' ' + s.br).includes(q)) add(s, s.e + (s.br ? ' · ' + s.br : ''));
      }
    } else {
      for (const u of postos.usage().slice(0, 3)) add(postos.byId(u.station_id), 'você abastece aqui · ' + pl(u.fills, 'vez', 'vezes'));
      if (here) for (const x of postos.nearby(here, 2).slice(0, 8)) add(x.s, Math.max(10, Math.round((x.d * 1000) / 10) * 10) + ' m · ' + x.s.e);
    }
    return (
      '<div class="picker"><input class="inp sm" id="f-pick-q" placeholder="Buscar pelo nome, rua ou bairro" autocomplete="off" aria-label="Buscar posto">' +
      '<div class="list-card">' +
      (list.length
        ? list.map((x) => '<button type="button" class="row simple" data-pick="' + x.s.c + '"><span class="mid"><span class="a">' + esc(postos.nameOf(x.s)) + '</span><span class="b">' + esc(x.note) + '</span></span><span></span><span class="chev">' + ICON.chev + '</span></button>').join('')
        : '<div class="list-note">' + (q.length >= 3 ? 'Nenhum posto com esse nome por perto.' : here ? 'Nenhum posto a menos de 2 km.' : 'Digite o nome ou a rua do posto.') + '</div>') +
      '<button type="button" class="list-more muted" data-st="none">Sem posto</button></div></div>'
    );
  }
  const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

  async function detect() {
    detecting = true;
    renderStation();
    try {
      await postos.ensureFile();
      const p = await gps();
      here = p;
      postos.setHere(p);
      const fav = postos.usage().map((u) => u.station_id);
      const cands = postos.nearby(p, 0.6);
      // o ponto da ANP pode estar deslocado; o seu posto de sempre ganha 300 m de vantagem
      const best = cands
        .map((x) => ({ ...x, score: x.d - (fav.includes(x.s.c) ? 0.3 : 0) }))
        .filter((x) => x.d <= 0.25 || (fav.includes(x.s.c) && x.d <= 0.6))
        .sort((a, b) => a.score - b.score)[0];
      if (best && !picked) {
        picked = { s: best.s, how: 'gps', d: best.d };
        suggestPrice();
      }
      if (!best) postos.fetchGoogleAround(p, 4);
    } catch {
      /* sem GPS: a pessoa escolhe */
    } finally {
      detecting = false;
      renderStation();
      updateHints();
    }
  }

  function choose(s: Station | null) {
    picked = s ? { s, how: 'escolha' } : null;
    pickerOpen = false;
    pickerQ = '';
    renderStation();
    suggestPrice();
    updateHints();
  }

  $('f-station-box').addEventListener('click', (e) => {
    const el = e.target as HTMLElement;
    const st = el.closest<HTMLElement>('[data-st]')?.dataset.st;
    const pick = el.closest<HTMLElement>('[data-pick]')?.dataset.pick;
    if (st === 'toggle') {
      pickerOpen = !pickerOpen;
      renderStation();
      if (pickerOpen) setTimeout(() => (document.getElementById('f-pick-q') as HTMLInputElement | null)?.focus({ preventScroll: true }), 50);
      return;
    }
    if (st === 'none') return choose(null);
    if (pick) choose(postos.byId(pick));
  });
  $('f-station-box').addEventListener('input', (e) => {
    const el = e.target as HTMLInputElement;
    if (el.id !== 'f-pick-q') return;
    pickerQ = el.value;
    const list = $('f-station-box').querySelector('.picker .list-card');
    const tmp = document.createElement('div');
    tmp.innerHTML = picker();
    const fresh = tmp.querySelector('.list-card');
    if (list && fresh) list.replaceWith(fresh);
  });

  /** Preço sugerido: o mais recente conhecido no posto (seu, da rede ou da ANP), se tiver até 30 dias. */
  function suggestPrice() {
    const f = fuelNow();
    const priceEl = $<HTMLInputElement>('f-price');
    const hint = $('f-price-hint');
    if (editing || !picked?.s || !f) return;
    if (priceEl.value && !priceAuto) return;
    const pp = postos.priceAt(picked.s, f);
    if (!pp || ageDays(pp.date, todayISO()) > 30) {
      if (priceAuto) priceEl.value = '';
      priceAuto = false;
      hint.hidden = true;
      return;
    }
    priceEl.value = fmt(pp.price, Math.round(pp.price * 1000) % 10 ? 3 : 2);
    priceAuto = true;
    if (!recent.includes('price')) recent = [...recent.filter((x) => x !== 'price'), 'price'].slice(-2);
    hint.textContent = (pp.src === 'rede' ? (pp.seen ? 'Preço informado por quem passou aqui (' : 'Preço da rede (') + ago(pp.date) + ')' : pp.src === 'voce' ? (pp.seen ? 'Preço que você viu na bomba (' : 'Último preço que você pagou aqui (') + ago(pp.date) + ')' : 'Preço da pesquisa da ANP de ' + dm(pp.date)) + '. Confira na bomba.';
    hint.hidden = false;
    recalc();
  }

  /** Dica do combustível: qual compensa neste posto, com o rendimento do seu carro. */
  function fuelHint() {
    const el = $('f-fuel-hint');
    const v = current();
    el.hidden = true;
    fuelCards(null, null);
    if (!v || v.fuel_type !== 'flex' || !picked?.s) return;
    const fresh = (pp: PricePoint | null) => (pp && ageDays(pp.date, todayISO()) <= 30 ? pp : null);
    const g = fresh(postos.priceAt(picked.s, 'gasolina')), e = fresh(postos.priceAt(picked.s, 'etanol'));
    fuelCards(g, e);
    if (!g || !e) return;
    const m = carInfo().model;
    const ratio = m.kmlE / m.kmlG;
    const pct = e.price / g.price;
    el.innerHTML = (pct < ratio ? '<b>Etanol compensa aqui</b>' : '<b>Gasolina compensa aqui</b>') + ': etanol a ' + brl(e.price) + ' é ' + Math.round(pct * 100) + '% da gasolina; no seu carro rende ' + Math.round(ratio * 100) + '%.';
    el.hidden = false;
  }

  /** Visual novo: o preço de cada combustível no próprio botão e a dica de qual compensa. */
  function fuelCards(g: PricePoint | null, e: PricePoint | null) {
    const v = current();
    const tip = $('f-tip');
    $('f-fp-g').textContent = g ? fmt(g.price, 2) : '–';
    $('f-fp-e').textContent = e ? fmt(e.price, 2) : '–';
    $('f-fn-g').textContent = '';
    $('f-fn-e').textContent = '';
    tip.hidden = true;
    if (!v || v.fuel_type !== 'flex') return;
    const m = carInfo().model;
    const ratio = m.kmlE / m.kmlG;
    if (!g || !e) {
      if (g) { tip.innerHTML = LEAF + '<span>Etanol rende ' + Math.round(ratio * 100) + '% da gasolina no ' + esc(v.name) + ': compensa até ' + brl(g.price * ratio) + '.</span>'; tip.hidden = false; }
      return;
    }
    const cg = (m.kmTank / m.kmlG) * g.price, ce = (m.kmTank / m.kmlE) * e.price;
    const win = ce < cg ? 'e' : 'g';
    const diff = Math.round(Math.abs(cg - ce));
    $(win === 'e' ? 'f-fn-e' : 'f-fn-g').textContent = 'compensa no ' + v.name;
    $(win === 'e' ? 'f-fn-g' : 'f-fn-e').textContent = diff >= 1 ? 'R$ ' + diff + ' a mais no tanque' : 'quase o mesmo';
    tip.innerHTML = LEAF + '<span>Etanol rende ' + Math.round(ratio * 100) + '% da gasolina no ' + esc(v.name) + ': compensa até ' + brl(g.price * ratio) + '.</span>';
    tip.hidden = false;
  }

  /** Visual novo: com o preço conhecido, os litros saem do valor pago numa linha; senão, os campos aparecem. */
  let adjust = false;
  function calcLine() {
    const box = $('f-calc');
    const t = parseNum($<HTMLInputElement>('f-total').value), l = parseNum($<HTMLInputElement>('f-liters').value), p = parseNum($<HTMLInputElement>('f-price').value);
    const known = p > 0 && !adjust && !editing;
    $('fill-sheet').classList.toggle('pl-hide', known);
    box.hidden = !(p > 0) || adjust || !!editing;
    box.innerHTML = '= <b>' + (t > 0 && l > 0 ? fmt(l, 1) + ' litros' : '– litros') + '</b> a ' + brl(p) + '/l <button type="button" class="link-btn" data-adj>Ajustar</button>';
  }
  $('f-calc').addEventListener('click', (e) => {
    if (!(e.target as HTMLElement).closest('[data-adj]')) return;
    adjust = true;
    calcLine();
    setTimeout(() => $<HTMLInputElement>('f-price').focus(), 30);
  });

  /* ---------- formulário ---------- */
  function open(id: string | null, at?: { s: Station; fuel: Fuel | null; price: PricePoint | null }) {
    const v = current();
    if (!v) {
      toast('Cadastre o carro primeiro.');
      return needCar();
    }
    editing = id ? S.logs.find((f) => f.id === id) ?? null : null;
    delArmed = false;
    adjust = false;
    pickerOpen = false;
    pickerQ = '';
    priceAuto = false;
    const del = $('f-del');
    del.hidden = !editing;
    del.classList.remove('armed');
    del.textContent = 'Excluir abastecimento';
    $('fill-title').textContent = editing ? 'Editar abastecimento' : 'Abastecer';
    $('f-save').textContent = editing ? 'Salvar alterações' : isNovo() ? 'Salvar abastecimento' : 'Salvar';
    $('f-err').hidden = true;
    $('f-price-hint').hidden = true;
    const fs = carLogs();
    const last = fs[fs.length - 1];
    const flex = v.fuel_type === 'flex';
    $('f-fuel-seg').hidden = !flex;
    const fuel: FuelType = editing?.fuel ?? at?.fuel ?? (flex ? last?.fuel ?? 'gasolina' : (v.fuel_type as FuelType));
    const set = (i: string, val: string) => ($<HTMLInputElement>(i).value = val);
    set('f-date', editing?.date ?? todayISO());
    set('f-total', editing ? fmt(editing.total_brl, 2) : '');
    set('f-liters', editing ? fmt(editing.liters, editing.liters % 1 && String(editing.liters).split('.')[1]?.length > 2 ? 3 : 2) : '');
    set('f-price', editing ? fmt(editing.price_per_l, 3) : '');
    set('f-odo', editing ? String(editing.odometer_km) : '');
    set('f-range', editing?.range_left_km != null ? String(editing.range_left_km) : '');
    set('f-note', editing?.note ?? '');
    $<HTMLInputElement>('f-full').checked = editing ? editing.full_tank : true;
    $<HTMLInputElement>(fuel === 'etanol' ? 'f-fuel-e' : 'f-fuel-g').checked = true;
    $<HTMLInputElement>('f-odo').placeholder = last ? String(last.odometer_km + 380) : v.initial_km ? String(v.initial_km) : '';
    $<HTMLInputElement>('f-price').placeholder = last ? fmt(last.price_per_l, 2) : '0,00';
    ($('f-more') as HTMLDetailsElement).open = !!(editing && (editing.note || editing.range_left_km != null || editing.date !== todayISO()));
    recent = editing ? ['total', 'liters'] : [];
    Object.values(FIELD_OF).forEach((f) => $(f).classList.remove('auto'));
    // posto
    picked = null;
    if (editing) {
      const s = editing.station_id ? postos.byId(editing.station_id) : null;
      picked = s ? { s, how: 'registro' } : editing.station ? { s: null, text: editing.station } : null;
      if (editing.station_id && !s) postos.ensureFile().then(() => {
        const s2 = postos.byId(editing!.station_id!);
        if (s2 && editing) { picked = { s: s2, how: 'registro' }; renderStation(); }
      });
    } else if (at) {
      picked = { s: at.s, how: 'escolha' };
    }
    renderStation();
    openSheet('fill-sheet');
    if (!editing) {
      if (at?.price) suggestPrice();
      else if (!at) detect();
      else suggestPrice();
      setTimeout(() => $('f-total').focus({ preventScroll: true }), 260);
    }
    updateHints();
  }

  function recalc() {
    if (recent.length < 2) return;
    const target = (['total', 'liters', 'price'] as const).find((x) => !recent.includes(x))!;
    const t = parseNum($<HTMLInputElement>('f-total').value), l = parseNum($<HTMLInputElement>('f-liters').value), p = parseNum($<HTMLInputElement>('f-price').value);
    let val = NaN, d = 2;
    if (target === 'price' && t > 0 && l > 0) { val = t / l; d = 3; }
    else if (target === 'total' && l > 0 && p > 0) val = l * p;
    else if (target === 'liters' && t > 0 && p > 0) { val = t / p; d = 3; }
    if (Number.isFinite(val)) {
      $<HTMLInputElement>('f-' + target).value = fmt(val, d);
      $(FIELD_OF[target]).classList.add('auto');
    }
  }

  function updateHints() {
    const v = current();
    if (!v) return;
    fuelHint();
    calcLine();
    const others = carLogs().filter((f) => !editing || f.id !== editing.id);
    const odo = parseIntLoose($<HTMLInputElement>('f-odo').value);
    const before = Number.isFinite(odo) ? others.filter((f) => f.odometer_km < odo).pop() : others[others.length - 1];
    const hint = $('f-hint');
    if (before && Number.isFinite(odo)) hint.textContent = km(odo - before.odometer_km) + ' km desde o abastecimento anterior (' + km(before.odometer_km) + ' km)';
    else if (before) hint.textContent = 'Último odômetro: ' + km(before.odometer_km) + ' km';
    else hint.textContent = '';
    const date = $<HTMLInputElement>('f-date').value;
    $('f-more-sum').textContent = date === todayISO() ? 'hoje' : date ? dm(date) : '';
    const prev = $('f-preview');
    const liters = parseNum($<HTMLInputElement>('f-liters').value);
    const full = $<HTMLInputElement>('f-full').checked;
    const prevFull = Number.isFinite(odo) ? others.filter((f) => f.full_tank && f.odometer_km < odo).pop() : undefined;
    if (!full || !(liters > 0) || !Number.isFinite(odo) || !prevFull) {
      prev.hidden = true;
      return;
    }
    const partials = others.filter((f) => !f.full_tank && f.odometer_km > prevFull.odometer_km && f.odometer_km < odo).reduce((s, f) => s + f.liters, 0);
    const kml = (odo - prevFull.odometer_km) / (liters + partials);
    const avg = aggregate(intervals(others)).kml;
    if (!(kml > 0) || kml > 60) {
      prev.hidden = true;
      return;
    }
    const better = !Number.isFinite(avg) || kml >= avg;
    prev.className = 'good' + (better ? '' : ' low');
    prev.innerHTML = (better ? ICON.trendUp : ICON.trendDown) + '<div><b>' + fmt(kml, 2) + ' km/l</b> no tanque que terminou' + (Number.isFinite(avg) ? '<br>' + (better ? 'acima' : 'abaixo') + ' da sua média de ' + fmt(avg, 2) : '') + '</div>';
    prev.hidden = false;
  }

  (['total', 'liters', 'price'] as const).forEach((k) =>
    $('f-' + k).addEventListener('input', () => {
      if (k === 'price') {
        priceAuto = false;
        $('f-price-hint').hidden = true;
      }
      recent = recent.filter((x) => x !== k);
      recent.push(k);
      if (recent.length > 2) recent.shift();
      $(FIELD_OF[k]).classList.remove('auto');
      recalc();
      updateHints();
    }),
  );
  for (const id of ['f-odo', 'f-date']) $(id).addEventListener('input', updateHints);
  $('f-full').addEventListener('change', updateHints);
  $('f-fuel-seg').addEventListener('change', () => {
    suggestPrice();
    updateHints();
  });

  $('f-del').addEventListener('click', async () => {
    if (!editing) return;
    if (!delArmed) {
      delArmed = true;
      $('f-del').classList.add('armed');
      $('f-del').textContent = 'Toque de novo para excluir';
      return;
    }
    await softDelete(db.fuel_logs, editing.id);
    await deleteRating(editing.id); // a avaliação vai junto
    if (editing.station_id) invalidateNetwork(editing.station_id);
    closeSheets();
    toast('Abastecimento excluído');
  });

  $('fill-sheet').addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = current()!;
    const val = (id: string) => $<HTMLInputElement>(id).value;
    const t = parseNum(val('f-total')), l = parseNum(val('f-liters'));
    let p = parseNum(val('f-price'));
    const odo = parseIntLoose(val('f-odo'));
    const date = val('f-date');
    const err = (m: string) => { $('f-err').textContent = m; $('f-err').hidden = false; };
    if (!(t > 0)) return err('Informe o valor total pago.');
    if (!(l > 0)) return err('Informe os litros, ou o preço por litro.');
    if (!(odo > 0)) return err('Informe o odômetro.');
    if (!date) return err('Informe a data.');
    if (!(p > 0)) p = t / l;
    const others = carLogs().filter((f) => !editing || f.id !== editing.id);
    const before = others.filter((f) => f.date < date || (f.date === date && f.odometer_km < odo)).pop();
    if (before && odo <= before.odometer_km) return err('O odômetro precisa ser maior que ' + km(before.odometer_km) + ' km (registro de ' + dm(before.date) + ').');
    const after = others.find((f) => f.date > date);
    if (after && odo >= after.odometer_km) return err('O odômetro precisa ser menor que ' + km(after.odometer_km) + ' km (registro de ' + dm(after.date) + ').');
    const rng = parseIntLoose(val('f-range'));
    const flex = v.fuel_type === 'flex';
    const fuel: FuelType = flex ? ($<HTMLInputElement>('f-fuel-e').checked ? 'etanol' : 'gasolina') : (v.fuel_type as FuelType);
    const st = picked?.s ?? null;
    const row = stamp<FuelLog>({
      id: editing?.id ?? uuid(),
      vehicle_id: editing?.vehicle_id ?? v.id,
      date,
      odometer_km: odo,
      liters: Math.round(l * 1000) / 1000,
      total_brl: Math.round(t * 100) / 100,
      price_per_l: Math.round(p * 1000) / 1000,
      fuel,
      full_tank: $<HTMLInputElement>('f-full').checked,
      range_left_km: Number.isFinite(rng) ? rng : null,
      station: st ? stationLabel(st, postos.nameOf(st)) : picked && !picked.s ? picked.text : null,
      station_id: st?.c ?? null,
      note: val('f-note').trim().slice(0, 140) || null,
    });
    const wasEdit = !!editing;
    // mudou de posto: a avaliação era do posto anterior
    if (editing && editing.station_id !== row.station_id) await deleteRating(editing.id);
    await db.fuel_logs.put(row);
    if (st) invalidateNetwork(st.c);
    // avaliar o posto de agora e perguntar como o carro andou com o combustível do abastecimento anterior
    if (!wasEdit && (await openAfterSave(row))) return;
    closeSheets(() => !wasEdit && go('inicio'));
    toast(wasEdit ? 'Alterações salvas' : 'Abastecimento salvo');
  });

  /* ---------- avaliação: estrelas, bomba/atendimento/banheiro e "como o carro andou depois" ---------- */
  type Sheet = {
    /** Abastecimento cujo posto está sendo avaliado (null: só a pergunta do depois). */
    fill: FuelLog | null;
    bomba: Vote; atendimento: Vote; banheiro: Vote; stars: number | null;
    existed: boolean; locked: boolean;
    /** Abastecimento sobre cujo combustível se pergunta "como o carro andou" (o anterior, ou o próprio pelo histórico). */
    after: FuelLog | null; afterVal: AfterEffect | null; afterLocked: boolean;
    /** Logo depois de salvar um abastecimento. */
    saved: FuelLog | null;
  };
  let rating: Sheet | null = null;
  const canRateNow = async () => S.prefs.contribute && !!(await currentSession());

  /** Depois de salvar: avaliar o posto de agora e perguntar do combustível do abastecimento anterior (o posto dele). */
  async function openAfterSave(row: FuelLog): Promise<boolean> {
    if (!(await canRateNow())) return false;
    const today = todayISO();
    const fill = row.station_id && ageDays(row.date, today) <= MAX_DAYS ? row : null;
    const logs = await db.fuel_logs.where('vehicle_id').equals(row.vehicle_id).toArray();
    const prev = previousFill(logs, row);
    const after = prev && canAskAfter(prev, today, S.ratings[prev.id]) ? prev : null;
    if (!fill && !after) return false;
    rating = { fill, bomba: null, atendimento: null, banheiro: null, stars: null, existed: false, locked: false, after, afterVal: null, afterLocked: false, saved: row };
    renderRating();
    openSheet('rate-sheet');
    return true;
  }

  /** Pelo histórico: ver, mudar ou apagar a avaliação de um abastecimento, e dizer como o carro andou com ele. */
  function openRating(fillId: string) {
    db.fuel_logs.get(fillId).then(async (f) => {
      if (!f || !f.station_id) return;
      const prev = S.ratings[fillId];
      const today = todayISO();
      const locked = ageDays(f.date, today) > MAX_DAYS;
      const logs = await db.fuel_logs.where('vehicle_id').equals(f.vehicle_id).toArray();
      const showAfter = !!prev?.after_effect || usedEnough(f, logs, today);
      rating = {
        fill: f, bomba: prev?.bomba ?? null, atendimento: prev?.atendimento ?? null, banheiro: prev?.banheiro ?? null, stars: prev?.stars ?? null,
        existed: !!prev, locked, after: showAfter ? f : null, afterVal: prev?.after_effect ?? null, afterLocked: locked, saved: null,
      };
      renderRating();
      openSheet('rate-sheet');
    });
  }

  const stationName = (f: FuelLog) => {
    const st = f.station_id ? postos.byId(f.station_id) : null;
    return st ? postos.nameOf(st) : (f.station ?? 'o posto').split(' · ')[0];
  };
  const STAR = '<svg aria-hidden="true" width="30" height="30" viewBox="0 0 24 24"><path d="M12 3.2l2.7 5.6 6.1.8-4.5 4.2 1.1 6.1L12 17l-5.4 2.9 1.1-6.1-4.5-4.2 6.1-.8z" fill="currentColor"/></svg>';

  /** Visual novo: topo "Abastecido.", estrelas com etiquetas de um toque e o combustível anterior em 2×2. */
  const CHIP: Record<'bomba' | 'atendimento' | 'banheiro', [string, string]> = {
    bomba: ['Bomba marcou certo', 'Bomba marcou errado'],
    atendimento: ['Bom atendimento', 'Atendimento ruim'],
    banheiro: ['Banheiro limpo', 'Banheiro ruim'],
  };
  /** Quanto o abastecimento saiu mais barato que o outro combustível no mesmo posto (para o mesmo km). */
  function savedVsOther(f: FuelLog): number {
    if (f.fuel !== 'etanol' && f.fuel !== 'gasolina') return 0;
    const st = f.station_id ? postos.byId(f.station_id) : null;
    const m = carInfo().model;
    if (!st || m.fuels.length < 2) return 0;
    const other: Fuel = f.fuel === 'etanol' ? 'gasolina' : 'etanol';
    const op = postos.priceAt(st, other);
    if (!op || ageDays(op.date, todayISO()) > 30) return 0;
    const km = f.liters * (f.fuel === 'etanol' ? m.kmlE : m.kmlG);
    return (km / (other === 'etanol' ? m.kmlE : m.kmlG)) * op.price - f.total_brl;
  }
  function renderRatingNovo(r: Sheet) {
    const sheet = $('rate-sheet');
    sheet.classList.toggle('rate2-full', !!r.saved);
    const parts: string[] = [];
    if (r.saved) {
      const f = r.saved;
      const save = savedVsOther(f);
      parts.push('<div class="rate2-head"><span class="ok2">' + CHECK2 + '</span><h2 id="rate-title">Abastecido.</h2><span>' + fmt(f.liters, 1) + ' l de ' + f.fuel + ' · ' + brl(f.total_brl) +
        (save >= 1 ? ' · <b>R$ ' + Math.round(save) + ' a menos</b> que ' + (f.fuel === 'etanol' ? 'gasolina' : 'etanol') : '') + '</span></div>');
    }
    if (r.fill) {
      const f = r.fill;
      const stars = '<div class="stars2" role="radiogroup" aria-label="Nota geral do posto">' +
        [1, 2, 3, 4, 5].map((n) => '<button type="button" role="radio" data-star="' + n + '" aria-label="' + n + (n === 1 ? ' estrela' : ' estrelas') + '" aria-checked="' + (r.stars === n) + '" class="' + (r.stars != null && n <= r.stars ? 'on' : '') + '"' + (r.locked ? ' disabled' : '') + '>' + STAR + '</button>').join('') + '</div>';
      const chips = (['bomba', 'atendimento', 'banheiro'] as const).map((k) => {
        const v = r[k];
        const label = v === -1 ? CHIP[k][1] : CHIP[k][0];
        return '<button type="button" class="chip2' + (v === 1 ? ' good' : v === -1 ? ' bad' : '') + '" data-chip="' + k + '" aria-label="' + esc(CHIP[k][0]) + ': ' + (v === 1 ? 'sim' : v === -1 ? 'não' : 'sem resposta') + '"' + (r.locked ? ' disabled' : '') + '>' + (v === 1 ? '✓ ' : v === -1 ? '✕ ' : '') + label + '</button>';
      }).join('');
      parts.push('<div class="card rate2"><b class="rate2-t"' + (r.saved ? '' : ' id="rate-title"') + '>' + (r.existed && !r.saved ? 'Sua avaliação' : 'Como foi no posto?') + '</b>' +
        (r.saved ? '' : '<span class="hint">' + dm(f.date) + ' · ' + esc(stationName(f)) + '</span>') + stars +
        '<div class="chips2">' + chips + '</div><span class="hint">1 toque: sim · 2 toques: não. Sem o seu nome.</span></div>');
    }
    if (r.after) {
      const a = r.after;
      const same = r.fill?.id === a.id;
      const delta = tankVsNormal(carIntervals(), a.id);
      const measured = delta == null ? '' : '<span class="hint">Pelos seus números, esse tanque rendeu ' + (Math.abs(delta) < 0.02 ? 'como o seu normal' : Math.round(Math.abs(delta) * 100) + '% ' + (delta > 0 ? 'acima' : 'abaixo') + ' do seu normal') + '.</span>';
      const AFTER_V2: Record<AfterEffect, string> = { normal: 'Andou normal', melhor: 'Melhor que o normal', falhou: 'Falhou ou engasgou', rendeu_menos: 'Rendeu menos' };
      parts.push('<div class="card rate2" role="radiogroup" aria-label="Como o carro andou"><div class="rate2-h"><b class="rate2-t"' + (!r.saved && !r.fill ? ' id="rate-title"' : '') + '>' + (same ? 'Como o carro andou com esse combustível?' : r.fill || r.saved ? 'E o combustível anterior?' : 'Como o carro andou?') + '</b>' +
        (same ? '' : '<span class="hint">' + esc(stationName(a)) + ', ' + dm(a.date) + '. Desde então, o carro…</span>') + '</div>' + measured +
        '<div class="after2">' + AFTER_OPTIONS.map(([v]) => '<button type="button" role="radio" data-after="' + v + '" aria-checked="' + (r.afterVal === v) + '"' + (r.afterLocked ? ' disabled' : '') + '>' + AFTER_V2[v] + '</button>').join('') + '</div></div>');
    }
    const n = (['bomba', 'atendimento', 'banheiro'] as const).filter((k) => r[k] !== null).length + (r.stars ? 1 : 0) + (r.afterVal && !r.afterLocked ? 1 : 0);
    const note = r.locked ? '<p class="hint">Já passaram 30 dias desse abastecimento: dá para apagar a avaliação, mas não mudar.</p>' : '';
    const send = '<button type="button" class="btn primary" data-rate="send"' + (n ? '' : ' disabled') + '>' + (r.existed ? 'Salvar' : 'Enviar') + '</button>';
    const btns = r.saved
      ? '<button type="button" class="btn" data-rate="skip">Pular</button>' + send
      : r.locked
        ? '<button type="button" class="btn" data-rate="skip">Fechar</button><button type="button" class="btn danger" data-rate="del">Apagar avaliação</button>'
        : r.existed
          ? '<button type="button" class="btn danger" data-rate="del">Apagar</button>' + send
          : '<button type="button" class="btn" data-rate="skip">Cancelar</button>' + send;
    $('rate-body').innerHTML = parts.join('') + note + '<div class="btn-row rate2-btns">' + btns + '</div>';
  }

  function renderRating() {
    if (!rating) return;
    const r = rating;
    if (isNovo()) return renderRatingNovo(r);
    $('rate-sheet').classList.remove('rate2-full');
    const parts: string[] = [];
    if (r.saved) {
      const f = r.saved;
      parts.push('<div class="saved-row"><span class="ok-ic">' + ICON.check + '</span><span class="mid"><span class="a">Abastecimento salvo</span><span class="b">' + fmt(f.liters, 1) + ' l de ' + (f.fuel === 'etanol' ? 'etanol' : f.fuel) + ' · ' + brl(f.total_brl) + (f.station_id ? ' · ' + esc(stationName(f)) : '') + '</span></span></div>');
    }
    if (r.fill) {
      const f = r.fill;
      const q = (key: 'bomba' | 'atendimento' | 'banheiro', label: string, opts: [Vote, string][]) =>
        '<div class="rate-q" role="radiogroup" aria-label="' + esc(label) + '"><span class="b15">' + label + '</span><div class="rate-opts">' +
        opts.map(([v, t]) => '<button type="button" role="radio" data-k="' + key + '" data-v="' + (v ?? 0) + '" aria-checked="' + (r[key] === v && v !== null ? 'true' : 'false') + '"' + (r.locked ? ' disabled' : '') + '>' + t + '</button>').join('') + '</div></div>';
      const stars = '<div class="stars" role="radiogroup" aria-label="Nota geral do posto">' +
        [1, 2, 3, 4, 5].map((n) => '<button type="button" role="radio" data-star="' + n + '" aria-label="' + n + (n === 1 ? ' estrela' : ' estrelas') + '" aria-checked="' + (r.stars === n) + '" class="' + (r.stars != null && n <= r.stars ? 'on' : '') + '"' + (r.locked ? ' disabled' : '') + '>' + STAR + '</button>').join('') + '</div>';
      parts.push(
        '<div class="rate-head"><h2 id="rate-title">' + (r.saved ? 'Como foi no posto?' : r.existed ? 'Sua avaliação' : 'Como foi no posto?') + '</h2><span class="hint">' +
        (r.saved ? 'Opcional. Entra na média do posto sem o seu nome.' : dm(f.date) + ' · ' + esc(stationName(f))) + '</span></div>' +
        '<div class="rate-q"><span class="b15">Nota geral</span>' + stars + '</div>' +
        q('bomba', 'A bomba marcou certo?', [[1, 'Sim'], [-1, 'Não'], [null, 'Não sei']]) +
        q('atendimento', 'Atendimento', [[1, 'Bom'], [-1, 'Ruim'], [null, 'Não sei']]) +
        q('banheiro', 'Banheiro', [[1, 'Bom'], [-1, 'Ruim'], [null, 'Não usei']]),
      );
    }
    if (r.after) {
      const a = r.after;
      const same = r.fill?.id === a.id;
      const delta = tankVsNormal(carIntervals(), a.id);
      const measured = delta == null ? '' : '<span class="hint after-measured">Pelos seus números, esse tanque rendeu ' + (Math.abs(delta) < 0.02 ? 'como o seu normal' : Math.round(Math.abs(delta) * 100) + '% ' + (delta > 0 ? 'acima' : 'abaixo') + ' do seu normal') + '.</span>';
      parts.push(
        '<div class="rate-q after-q" role="radiogroup" aria-label="Como o carro andou"><span class="b15">' +
        (same ? 'Como o carro andou com esse combustível?' : (r.fill || r.saved ? 'E o combustível anterior?' : 'Como o carro andou?')) + '</span>' +
        (same ? '' : '<span class="hint">Abastecido em ' + dm(a.date) + ' no ' + esc(stationName(a)) + '. Desde então, o carro…</span>') + measured +
        '<div class="after-opts">' + AFTER_OPTIONS.map(([v, t]) => '<button type="button" role="radio" data-after="' + v + '" aria-checked="' + (r.afterVal === v) + '"' + (r.afterLocked ? ' disabled' : '') + '>' + t + '</button>').join('') + '</div></div>',
      );
    }
    if (!r.saved && !r.fill) parts.unshift('<div class="rate-head"><h2 id="rate-title">Como o carro andou?</h2></div>');
    const n = (['bomba', 'atendimento', 'banheiro'] as const).filter((k) => r[k] !== null).length + (r.stars ? 1 : 0) + (r.afterVal && !r.afterLocked ? 1 : 0);
    const note = r.locked
      ? '<p class="hint">Já passaram 30 dias desse abastecimento: dá para apagar a avaliação, mas não mudar.</p>'
      : r.existed ? '<p class="hint">Entra na média do posto sem o seu nome. Mude as respostas ou apague.</p>' : '';
    const send = '<button type="button" class="btn primary" data-rate="send"' + (n ? '' : ' disabled') + '>' + (n ? (r.existed ? 'Salvar' : 'Enviar') : 'Escolha uma resposta') + '</button>';
    const btns = r.saved
      ? '<button type="button" class="btn" data-rate="skip">Pular</button>' + send
      : r.locked
        ? '<button type="button" class="btn" data-rate="skip">Fechar</button><button type="button" class="btn danger" data-rate="del">Apagar avaliação</button>'
        : r.existed
          ? '<button type="button" class="btn danger" data-rate="del">Apagar</button>' + send
          : '<button type="button" class="btn" data-rate="skip">Cancelar</button>' + send;
    $('rate-body').innerHTML = parts.join('') + note + '<div class="btn-row">' + btns + '</div>';
  }

  /** Grava (junta com o que já existe na avaliação daquele abastecimento). */
  async function store(f: FuelLog, patch: Partial<RatingRow>) {
    const cur = S.ratings[f.id];
    await saveRating({
      fuel_log_id: f.id, station_id: f.station_id!,
      bomba: cur?.bomba ?? null, atendimento: cur?.atendimento ?? null, banheiro: cur?.banheiro ?? null,
      stars: cur?.stars ?? null, after_effect: cur?.after_effect ?? null, after_at: cur?.after_at ?? null,
      ...patch,
    });
    invalidateNetwork(f.station_id!);
  }

  $('rate-body').addEventListener('click', async (e) => {
    const el = e.target as HTMLElement;
    if (!rating) return;
    const b = el.closest<HTMLElement>('[data-k]');
    if (b && !rating.locked) {
      const k = b.dataset.k as 'bomba';
      const v = Number(b.dataset.v) as 1 | -1 | 0;
      rating[k] = v === 0 ? null : rating[k] === v ? null : v;
      return renderRating();
    }
    const ch = el.closest<HTMLElement>('[data-chip]');
    if (ch && !rating.locked) {
      const k = ch.dataset.chip as 'bomba' | 'atendimento' | 'banheiro';
      rating[k] = rating[k] === null ? 1 : rating[k] === 1 ? -1 : null;
      return renderRating();
    }
    const st = el.closest<HTMLElement>('[data-star]');
    if (st && !rating.locked) {
      const v = Number(st.dataset.star);
      rating.stars = rating.stars === v ? null : v;
      return renderRating();
    }
    const af = el.closest<HTMLElement>('[data-after]');
    if (af && !rating.afterLocked) {
      const v = af.dataset.after as AfterEffect;
      rating.afterVal = rating.afterVal === v ? null : v;
      return renderRating();
    }
    const act = el.closest<HTMLElement>('[data-rate]')?.dataset.rate;
    if (!act) return;
    const r = rating;
    const after = !!r.saved;
    if (act === 'send') {
      const now = new Date().toISOString();
      const sameAfter = r.after && r.fill && r.after.id === r.fill.id;
      const hasRate = r.bomba != null || r.atendimento != null || r.banheiro != null || r.stars != null;
      if (r.fill && (hasRate || r.existed || (sameAfter && r.afterVal))) {
        await store(r.fill, {
          bomba: r.bomba, atendimento: r.atendimento, banheiro: r.banheiro, stars: r.stars,
          ...(sameAfter ? { after_effect: r.afterVal, after_at: r.afterVal ? S.ratings[r.fill.id]?.after_at ?? now : null } : {}),
        });
      }
      if (r.after && !sameAfter && r.afterVal) await store(r.after, { after_effect: r.afterVal, after_at: now });
      toast(r.existed ? 'Avaliação atualizada. A média do posto muda em até 5 minutos.' : 'Obrigado! Sua avaliação entra na média do posto.');
    } else if (act === 'del' && r.fill) {
      await deleteRating(r.fill.id);
      invalidateNetwork(r.fill.station_id!);
      toast('Avaliação apagada. Sai da média do posto em até 5 minutos.');
    } else if (after) toast('Abastecimento salvo');
    rating = null;
    closeSheets(() => after && go('inicio'));
  });

  /** Resposta rápida do aviso no Início. */
  async function answerAfter(fillId: string, v: AfterEffect) {
    const f = await db.fuel_logs.get(fillId);
    if (!f || !f.station_id) return;
    await store(f, { after_effect: v, after_at: new Date().toISOString() });
    toast('Obrigado! Isso ajuda a saber a qualidade do combustível de cada posto.');
  }

  return { open, openAt: (s: Station, fuel: Fuel | null, price: PricePoint | null) => open(null, { s, fuel, price }), openRating, answerAfter };
}

const CHECK2 = '<svg aria-hidden="true" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5 9-10"/></svg>';
const LEAF = '<svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 19c0-8 5.5-13 14-14 0 8.5-5.5 14-14 14z"/><path d="M5 19l8-8"/></svg>';
const PIN = '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>';
