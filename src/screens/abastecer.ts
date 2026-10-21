// Abastecer: o posto vem do GPS (com um toque para trocar), o preço sugerido vem da rede ou da ANP,
// e depois de salvar o app pede uma avaliação de um toque (bomba, atendimento, banheiro).
import { db, softDelete, stamp, uuid, type FuelLog, type FuelType } from '../db';
import { aggregate, intervals, parseIntLoose, parseNum } from '../calc';
import { gps } from '../lugares';
import { ageDays, type Fuel, type PricePoint, type Station } from '../postos';
import { currentSession, deleteRating, saveRating, type Vote } from '../sync';
import { invalidateNetwork } from '../rede';
import { S, carInfo, carLogs, current } from '../store';
import { $, ago, brl, closeSheets, dm, esc, fmt, km, openSheet, pl, todayISO, toast } from '../ui';
import { go } from '../router';
import { stationLabel, type PostosApi } from './postos';
import { ICON } from '../icons';

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
    hint.textContent = (pp.src === 'rede' ? 'Preço da rede (' + ago(pp.date) + ')' : pp.src === 'voce' ? 'Último preço que você pagou aqui (' + ago(pp.date) + ')' : 'Preço da pesquisa da ANP de ' + dm(pp.date)) + '. Confira na bomba.';
    hint.hidden = false;
    recalc();
  }

  /** Dica do combustível: qual compensa neste posto, com o rendimento do seu carro. */
  function fuelHint() {
    const el = $('f-fuel-hint');
    const v = current();
    el.hidden = true;
    if (!v || v.fuel_type !== 'flex' || !picked?.s) return;
    const g = postos.priceAt(picked.s, 'gasolina'), e = postos.priceAt(picked.s, 'etanol');
    if (!g || !e || ageDays(g.date, todayISO()) > 30 || ageDays(e.date, todayISO()) > 30) return;
    const m = carInfo().model;
    const ratio = m.kmlE / m.kmlG;
    const pct = e.price / g.price;
    el.innerHTML = (pct < ratio ? '<b>Etanol compensa aqui</b>' : '<b>Gasolina compensa aqui</b>') + ': etanol a ' + brl(e.price) + ' é ' + Math.round(pct * 100) + '% da gasolina; no seu carro rende ' + Math.round(ratio * 100) + '%.';
    el.hidden = false;
  }

  /* ---------- formulário ---------- */
  function open(id: string | null, at?: { s: Station; fuel: Fuel | null; price: PricePoint | null }) {
    const v = current();
    if (!v) {
      toast('Cadastre o carro primeiro.');
      return needCar();
    }
    editing = id ? S.logs.find((f) => f.id === id) ?? null : null;
    delArmed = false;
    pickerOpen = false;
    pickerQ = '';
    priceAuto = false;
    const del = $('f-del');
    del.hidden = !editing;
    del.classList.remove('armed');
    del.textContent = 'Excluir';
    $('fill-title').textContent = editing ? 'Editar abastecimento' : 'Abastecer';
    $('f-save').textContent = editing ? 'Salvar alterações' : 'Salvar';
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
      $('f-del').textContent = 'Confirmar';
      return;
    }
    await softDelete(db.fuel_logs, editing.id);
    await deleteRating(editing.id); // a avaliação vai junto
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
    const askRating = !wasEdit && !!st && S.prefs.contribute && !!(await currentSession()) && ageDays(date, todayISO()) <= 7;
    if (askRating) {
      openRating(row.id, true);
      return;
    }
    closeSheets(() => !wasEdit && go('inicio'));
    toast(wasEdit ? 'Alterações salvas' : 'Abastecimento salvo');
  });

  /* ---------- avaliação em um toque ---------- */
  let rating: { fill: FuelLog; bomba: Vote; atendimento: Vote; banheiro: Vote; justSaved: boolean; existed: boolean; locked: boolean } | null = null;
  /** Avaliação do posto de um abastecimento: logo depois de salvar, ou depois, pelo histórico (ver, mudar ou apagar). */
  function openRating(fillId: string, justSaved = false) {
    // a linha acabou de ser gravada: o estado em memória pode ainda não ter chegado
    db.fuel_logs.get(fillId).then((f) => {
      if (!f || !f.station_id) return;
      const prev = S.ratings[fillId];
      rating = {
        fill: f, bomba: prev?.bomba ?? null, atendimento: prev?.atendimento ?? null, banheiro: prev?.banheiro ?? null,
        justSaved, existed: !!prev, locked: ageDays(f.date, todayISO()) > 7,
      };
      renderRating();
      openSheet('rate-sheet');
    });
  }
  function renderRating() {
    if (!rating) return;
    const r = rating;
    const f = r.fill;
    const s = f.station_id ? postos.byId(f.station_id) : null;
    const name = s ? postos.nameOf(s) : (f.station ?? 'o posto').split(' · ')[0];
    const q = (key: 'bomba' | 'atendimento' | 'banheiro', label: string, opts: [Vote, string][]) =>
      '<div class="rate-q" role="radiogroup" aria-label="' + esc(label) + '"><span class="b15">' + label + '</span><div class="rate-opts">' +
      opts.map(([v, t]) => '<button type="button" role="radio" data-k="' + key + '" data-v="' + (v ?? 0) + '" aria-checked="' + (r[key] === v && v !== null ? 'true' : 'false') + '"' + (r.locked ? ' disabled' : '') + '>' + t + '</button>').join('') + '</div></div>';
    const n = (['bomba', 'atendimento', 'banheiro'] as const).filter((k) => r[k] !== null).length;
    const what = fmt(f.liters, 1) + ' l de ' + (f.fuel === 'etanol' ? 'etanol' : f.fuel) + ' · ' + brl(f.total_brl) + ' · ' + esc(name);
    const head = r.justSaved
      ? '<div class="saved-row"><span class="ok-ic">' + ICON.check + '</span><span class="mid"><span class="a">Abastecimento salvo</span><span class="b">' + what + '</span></span></div>' +
        '<div class="rate-head"><h2 id="rate-title">Como foi no posto?</h2><span class="hint">Opcional. Entra na média do posto sem o seu nome.</span></div>'
      : '<div class="rate-head"><h2 id="rate-title">' + (r.existed ? 'Sua avaliação' : 'Como foi no posto?') + '</h2><span class="hint">' + dm(f.date) + ' · ' + what + '</span></div>';
    const note = r.locked
      ? '<p class="hint">Já passaram 7 dias desse abastecimento: dá para apagar a avaliação, mas não mudar.</p>'
      : r.existed ? '<p class="hint">Entra na média do posto sem o seu nome. Mude as respostas ou apague.</p>' : '';
    const send = '<button type="button" class="btn primary" data-rate="send"' + (n ? '' : ' disabled') + '>' + (n ? (r.existed ? 'Salvar' : 'Enviar') : 'Escolha uma resposta') + '</button>';
    const btns = r.justSaved
      ? '<button type="button" class="btn" data-rate="skip">Pular</button>' + send
      : r.locked
        ? '<button type="button" class="btn" data-rate="skip">Fechar</button><button type="button" class="btn danger" data-rate="del">Apagar avaliação</button>'
        : r.existed
          ? '<button type="button" class="btn danger" data-rate="del">Apagar</button>' + send
          : '<button type="button" class="btn" data-rate="skip">Cancelar</button>' + send;
    $('rate-body').innerHTML =
      head +
      q('bomba', 'A bomba marcou certo?', [[1, 'Sim'], [-1, 'Não'], [null, 'Não sei']]) +
      q('atendimento', 'Atendimento', [[1, 'Bom'], [-1, 'Ruim'], [null, 'Não sei']]) +
      q('banheiro', 'Banheiro', [[1, 'Bom'], [-1, 'Ruim'], [null, 'Não usei']]) +
      note + '<div class="btn-row">' + btns + '</div>';
  }
  $('rate-body').addEventListener('click', async (e) => {
    const el = e.target as HTMLElement;
    const b = el.closest<HTMLElement>('[data-k]');
    if (b && rating && !rating.locked) {
      const k = b.dataset.k as 'bomba';
      const v = Number(b.dataset.v) as 1 | -1 | 0;
      rating[k] = v === 0 ? null : rating[k] === v ? null : v;
      return renderRating();
    }
    const act = el.closest<HTMLElement>('[data-rate]')?.dataset.rate;
    if (!act || !rating) return;
    const after = rating.justSaved;
    if (act === 'send') {
      await saveRating({ fuel_log_id: rating.fill.id, station_id: rating.fill.station_id!, bomba: rating.bomba, atendimento: rating.atendimento, banheiro: rating.banheiro });
      toast(rating.existed ? 'Avaliação atualizada' : 'Obrigado! Sua avaliação entra na média do posto.');
    } else if (act === 'del') {
      await deleteRating(rating.fill.id);
      toast('Avaliação apagada');
    } else if (after) toast('Abastecimento salvo');
    rating = null;
    closeSheets(() => after && go('inicio'));
  });

  return { open, openAt: (s: Station, fuel: Fuel | null, price: PricePoint | null) => open(null, { s, fuel, price }), openRating };
}

const PIN = '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>';
