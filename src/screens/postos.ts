// Aba Postos (mapa, filtros e lista), ficha do posto, "Outro local" e o card "Onde abastecer" do Início.
// Junta três fontes: o arquivo da ANP (cadastro, preços semanais, fiscalização), o Google (nota e foto,
// guardados no aparelho por 7 dias) e a rede (preço pago, rendimento medido e avaliações de quem usa o app).
import {
  EVENT_LABEL, ageDays, bboxAround, bestWithoutPrice, goodShare, haversineKm, matchGoogle, recommend, sortRows, stationsFor, usageVerdict, yieldOf,
  type Base, type CarModel, type Fuel, type GoogleMatch, type GoogleStation, type LatLon, type OwnPrice, type PricePoint,
  type Recommendation, type Station, type StationLive, type StationRow, type StationsFile, type StationUse,
} from '../postos';
import { gps, loadStations, route, type FoundPlace, type Route } from '../lugares';
import { currentSession, googlePhoto, googlePlaces, setPlace, type Places } from '../sync';
import { fetchNetwork, network } from '../rede';
import { getMeta, setMeta, stamp, db, type FuelLog } from '../db';
import { S, carInfo, carLogs, carIntervals, subscribe } from '../store';
import { stationUsage } from '../postos';
import { $, ago, brl, closeSheets, dm, esc, fmt, openSheet, onSheetClose, pl, todayISO, toast } from '../ui';
import { currentRoute, go, onShow } from '../router';
import { addressSearch } from './busca-endereco';
import { ICON } from '../icons';

type BaseKind = 'agora' | 'casa' | 'trabalho' | 'rota' | 'busca';
const REC_LABEL: Record<BaseKind, string> = {
  agora: 'Melhor opção perto de você', casa: 'Melhor opção perto de casa', trabalho: 'Melhor opção perto do trabalho',
  rota: 'Melhor opção no seu caminho', busca: 'Melhor opção perto do local escolhido',
};
const FUEL: Record<Fuel, string> = { gasolina: 'Gasolina', etanol: 'Etanol' };
const RADII = [2, 5, 10];
const DETOURS = [500, 1000, 2000];
const PIN = '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>';
const TARGET = '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/><circle cx="12" cy="12" r="7"/></svg>';
const HOUSE = '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/></svg>';
const BAG = '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 13h18"/></svg>';

/** Abre o posto no Google Maps já pronto para navegar até ele. */
/** "de hoje", "de ontem", "de 13/10" — para o preço do seu último abastecimento no posto. */
function deDia(iso: string, today: string) {
  const d = ago(iso, today);
  return d === 'hoje' || d === 'ontem' ? 'de ' + d : 'de ' + dm(iso);
}

export function mapsUrl(s: Station, g?: GoogleMatch) {
  if (g) return 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(g.name) + '&destination_place_id=' + encodeURIComponent(g.id);
  return 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(s.la + ',' + s.lo);
}

/** Texto do posto gravado no abastecimento: nome e endereço (dois postos podem ter o mesmo nome). */
export function stationLabel(s: Station, name = s.n) {
  return (name + ' · ' + s.e).slice(0, 110);
}

const kmTxt = (d: number) => (d < 0.95 ? Math.max(1, Math.round(d * 10)) * 100 + ' m' : fmt(d, 1) + ' km');

export interface Filters { fuel: 'auto' | Fuel; ok: boolean; recent: boolean; bath: boolean }

export function initPostos(ctx: { fillAt: (s: Station, fuel: Fuel | null, price: PricePoint | null) => void }) {
  let file: StationsFile | null = null;
  let loadFailed = false;
  let base: BaseKind = 'agora';
  let radius = 5;
  let here: { p: LatLon; at: number } | null = null;
  let locating = false;
  let other: FoundPlace | null = null;
  let showAll = false;
  let filters: Filters = { fuel: 'auto', ok: false, recent: false, bath: false };
  try {
    const saved = JSON.parse(localStorage.getItem('postos_filtros') ?? 'null');
    if (saved) filters = { ...filters, ...saved };
  } catch { /* sem acesso */ }

  /* ---------- Google: lugares ligados aos postos da ANP (nome, nota, foto, ponto exato) ---------- */
  const gmatch = new Map<string, GoogleMatch>();
  const google = new Map<string, { rating: number; count: number }>();
  const gTried = new Set<string>();
  const nm = (s: Station) => gmatch.get(s.c)?.name || s.n;
  let adjusted: Station[] | null = null;
  function stations(): Station[] {
    if (!file) return [];
    if (!gmatch.size) return file.postos;
    if (!adjusted) adjusted = file.postos.map((s) => { const g = gmatch.get(s.c); return g ? { ...s, la: g.lat, lo: g.lon, pg: 'n' as const } : s; });
    return adjusted;
  }
  function addMatches(m: Map<string, GoogleMatch>) {
    if (m.size) adjusted = null;
    for (const [c, g] of m) {
      gmatch.set(c, g);
      if (g.rating != null) google.set(c, { rating: g.rating, count: g.count });
    }
  }
  const googleDone = new Set<string>();
  let googleOn: boolean | null = null;

  async function ensureFile() {
    if (file) return file;
    file = await loadStations();
    loadFailed = !file;
    if (file) await restoreGoogle();
    return file;
  }

  /* Cache do Google no aparelho: cada área (e cada posto procurado) é buscada no máximo uma vez por semana. */
  const G_TTL = 7 * 86400000;
  const G_KEY = 'google_cache_v2';
  type GCache = Record<string, { at: number; places: GoogleStation[] }>;
  let gcache: GCache | null = null;
  let gBlocked = '';
  async function gGet(key: string): Promise<GoogleStation[] | null> {
    gcache ??= await getMeta<GCache>(G_KEY, {});
    const e = gcache[key];
    return e && Date.now() - e.at < G_TTL ? e.places : null;
  }
  async function gPut(key: string, places: GoogleStation[]) {
    gcache ??= await getMeta<GCache>(G_KEY, {});
    gcache[key] = { at: Date.now(), places };
    const keys = Object.keys(gcache).filter((k) => Date.now() - gcache![k].at < G_TTL).sort((a, b) => gcache![b].at - gcache![a].at);
    gcache = Object.fromEntries(keys.slice(0, 80).map((k) => [k, gcache![k]]));
    await setMeta(G_KEY, gcache);
  }
  /** Ao abrir o app, religa o que já foi buscado no Google (sem nova consulta). */
  async function restoreGoogle() {
    gcache ??= await getMeta<GCache>(G_KEY, {});
    const all = Object.values(gcache).filter((e) => Date.now() - e.at < G_TTL).flatMap((e) => e.places);
    if (!all.length || !file) return;
    googleOn = true;
    const ids = new Set(all.map((g) => g.id));
    void ids;
    // casa só com postos perto de algum lugar do Google (rápido mesmo com 2 mil postos)
    const near = file.postos.filter((s) => all.some((g) => Math.abs(g.lat - s.la) < 0.03 && Math.abs(g.lon - s.lo) < 0.03));
    addMatches(matchGoogle(all, near));
  }
  async function gError(e: unknown) {
    const res = (e as { context?: Response })?.context;
    if (res?.status === 429) {
      try { gBlocked = (await res.json()).error; } catch { gBlocked = 'Limite diário do Google atingido.'; }
      render();
    } else console.warn('google', e);
  }

  async function fetchGoogle(center: LatLon, radiusKm: number) {
    if (googleOn === false || gBlocked || !file) return;
    const snap = { lat: Math.round(center.lat / 0.02) * 0.02, lon: Math.round(center.lon / 0.02) * 0.02 };
    const r = radiusKm <= 4 ? 4 : radiusKm <= 7 ? 7 : 10;
    const key = 'nearby:' + snap.lat.toFixed(2) + ',' + snap.lon.toFixed(2) + ',' + r;
    if (googleDone.has(key)) return;
    googleDone.add(key);
    let places = await gGet(key);
    if (places) googleOn = true;
    else {
      if (navigator.onLine === false || !(await currentSession())) return;
      try {
        const res = await googlePlaces<GoogleStation>({ mode: 'nearby', lat: snap.lat, lon: snap.lon, radius_m: Math.round((r * 1000) / 1.3) });
        googleOn = res.configured;
        if (!res.configured) return;
        places = res.places;
        await gPut(key, places);
      } catch (e) {
        return gError(e);
      }
    }
    const bb = bboxAround(snap, r + 3);
    const near = file.postos.filter((s) => s.la > bb.s && s.la < bb.n && s.lo > bb.w && s.lo < bb.e && !gmatch.has(s.c));
    addMatches(matchGoogle(places, near));
    render();
    renderHome();
  }

  /* ---------- base de busca ---------- */
  function rota(pl: Places = S.places): (Route & { on: boolean; detour_m: number }) | null {
    const r = pl.rota;
    if (!r || r.deleted_at) return null;
    const d = r.data as Partial<Route & { on: boolean; detour_m: number }>;
    return { pts: d.pts ?? [], km: d.km ?? 0, min: d.min ?? 0, from: d.from ?? [0, 0], to: d.to ?? [0, 0], roads: d.roads, on: !!d.on, detour_m: d.detour_m ?? 1000 };
  }
  function place(kind: 'casa' | 'trabalho', pl: Places = S.places) {
    const p = pl[kind];
    return p && !p.deleted_at && p.lat != null && p.lon != null ? { lat: p.lat, lon: p.lon, label: p.label ?? '' } : null;
  }

  type Resolved = { base: Base; where: string; center: LatLon } | { need: 'gps' | 'casa' | 'trabalho' | 'rota'; where: string };
  function resolve(kind: BaseKind): Resolved {
    if (kind === 'agora') {
      if (!here) return { need: 'gps', where: 'Onde você está agora' };
      return { base: { kind: 'ponto', at: here.p, radiusKm: radius }, where: 'Onde você está agora', center: here.p };
    }
    if (kind === 'casa' || kind === 'trabalho') {
      const p = place(kind);
      if (!p) return { need: kind, where: kind === 'casa' ? 'Casa não cadastrada' : 'Trabalho não cadastrado' };
      return { base: { kind: 'ponto', at: p, radiusKm: radius }, where: (kind === 'casa' ? 'Casa · ' : 'Trabalho · ') + p.label, center: p };
    }
    if (kind === 'busca') {
      if (!other) return { need: 'gps', where: 'Escolha um local' };
      return { base: { kind: 'ponto', at: other, radiusKm: radius }, where: other.label, center: other };
    }
    const r = rota();
    if (!r || !r.on || r.pts.length < 2) return { need: 'rota', where: 'No caminho casa → trabalho' };
    const path = r.pts.map(([lat, lon]) => ({ lat, lon }));
    return { base: { kind: 'rota', path, detourKm: r.detour_m / 1000, roads: r.roads }, where: 'Casa → trabalho · ' + fmt(r.km, 1) + ' km', center: path[Math.floor(path.length / 2)] };
  }

  const own = (): OwnPrice[] =>
    S.logs.filter((f) => f.station_id && (f.fuel === 'gasolina' || f.fuel === 'etanol')).map((f) => ({ station_id: f.station_id!, fuel: f.fuel as Fuel, price: f.price_per_l || f.total_brl / f.liters, date: f.date }));
  const usage = (): StationUse[] => stationUsage(carLogs(), carIntervals(), todayISO());

  /** Modelo do carro com o filtro de combustível aplicado. */
  function model(): CarModel {
    const m = carInfo().model;
    if (filters.fuel === 'auto' || !m.fuels.includes(filters.fuel)) return m;
    return { ...m, fuels: [filters.fuel] };
  }
  function passes(r: StationRow) {
    if (filters.ok && r.rel.level !== 'ok') return false;
    if (filters.recent && !(r.best && ageDays(r.best.price.date, todayISO()) <= 7)) return false;
    if (filters.bath && !((goodShare(r.live, 'banheiro') ?? 0) >= 0.7)) return false;
    return true;
  }
  function compute(b: Base, filtered = true): { rows: StationRow[]; rec: Recommendation } {
    const all = stationsFor(stations(), b, model(), own(), todayISO(), google, network());
    const rows = filtered ? all.filter(passes) : all;
    return { rows, rec: recommend(rows) };
  }
  /** Busca os números da rede dos postos na tela e redesenha se algo chegou. */
  let netTimer: number | undefined;
  function askNetwork(rows: StationRow[]) {
    clearTimeout(netTimer);
    netTimer = window.setTimeout(async () => {
      if (await fetchNetwork(rows.slice(0, 200).map((r) => r.s.c))) {
        render();
        renderHome();
      }
    }, 150);
  }

  /* ---------- aba Postos ---------- */
  async function show(kind?: BaseKind) {
    if (kind) base = kind;
    else if (!kindChosen) base = rota()?.on ? 'rota' : place('casa') ? 'casa' : 'agora';
    kindChosen = true;
    showAll = false;
    render();
    await ensureFile();
    if (base === 'agora' && !here) locate();
    else render();
  }
  let kindChosen = false;

  async function locate() {
    if (locating) return;
    locating = true;
    render();
    try {
      here = { p: await gps(), at: Date.now() };
      base = 'agora';
    } catch (e) {
      toast((e as Error).message);
    } finally {
      locating = false;
      render();
    }
  }

  function scoreChip(r: StationRow) {
    const t = r.rel.level === 'ok' ? 'confiável' : r.rel.level === 'atencao' ? 'atenção' : r.rel.recentSerious ? 'ocorrência recente' : 'evitar';
    return '<span class="score ' + r.rel.level + '">' + fmt(r.rel.score, 1) + ' ' + t + '</span>';
  }
  function srcTxt(pp: PricePoint | null) {
    if (!pp) return '<span class="src none">sem preço recente</span>';
    const today = todayISO();
    const old = ageDays(pp.date, today) > 30;
    const txt = pp.src === 'voce' ? 'seu abastecimento ' + deDia(pp.date, today) : (pp.src === 'rede' ? 'rede' : 'ANP') + ' · ' + (pp.src === 'anp' ? dm(pp.date) : ago(pp.date, today));
    return '<span class="src ' + pp.src + (old ? ' old' : '') + '">' + txt + '</span>';
  }
  function distTxt(r: StationRow, b: Base) {
    if (b.kind === 'rota') return r.distKm < 0.15 ? 'no caminho' : '+' + kmTxt(r.extraKm) + ' de desvio';
    return kmTxt(r.distKm);
  }
  /** Selos da rede: rendimento medido e o destaque das avaliações. */
  function netBadges(live: StationLive | null, max = 2): string {
    const out: string[] = [];
    const y = yieldOf(live);
    if (y != null) out.push('<span class="nb ' + (y >= 1 ? 'good' : y < 0.97 ? 'warn' : '') + '">rende ' + Math.round((live!.yield!.r ?? y) * 100) + '%</span>');
    const bomba = goodShare(live, 'bomba');
    if (bomba != null && bomba < 0.6) out.push('<span class="nb warn">bomba ' + Math.round(bomba * 100) + '% ok</span>');
    const ban = goodShare(live, 'banheiro');
    if (ban != null && out.length < max) out.push('<span class="nb">banheiro ' + Math.round(ban * 100) + '% bom</span>');
    const at = goodShare(live, 'atendimento');
    if (at != null && out.length < max) out.push('<span class="nb">atendimento ' + Math.round(at * 100) + '% bom</span>');
    return out.slice(0, max).join('');
  }

  function recCard(kind: BaseKind, rec: Recommendation, b: Base) {
    const car = carInfo();
    const best = rec.best!;
    const dist = b.kind === 'rota' ? (best.distKm < 0.15 ? 'no caminho' : '+' + kmTxt(best.extraKm) + ' de desvio') : kmTxt(best.distKm);
    const tiles = rec.bestOther
      ? '<div class="rec-tiles"><div><span>Custo por km</span><b>' + brl(best.costPerKm) + '</b></div><div><span>vs. ' + FUEL[rec.bestOther.fuel].toLowerCase() + ' mais em conta</span><b class="up">−' + brl(rec.bestOther.cost - best.cost) + '</b></div></div>'
      : '<div class="rec-tiles"><div><span>Custo por km</span><b>' + brl(best.costPerKm) + '</b></div><div><span>Para rodar ' + Math.round(car.model.kmTank) + ' km</span><b>' + brl(best.cost) + '</b></div></div>';
    const foot = [
      car.model.fuels.length > 1 ? 'Etanol rende ' + Math.round((car.model.kmlE / car.model.kmlG) * 100) + '% da gasolina no ' + esc(car.name) + (car.model.measured ? ' (medido)' : ' (estimado)') : '',
      best.yieldR != null ? 'já conta o rendimento medido do posto' : '',
      'conta ida e volta',
    ].filter(Boolean).join(' · ');
    const warn = rec.cheaperUnsafe
      ? '<p class="rec-warn">' + ICON.warn + '<span>' + esc(nm(rec.cheaperUnsafe.s)) + ' sairia mais barato, mas ficou de fora: ' + (rec.cheaperUnsafe.rel.recentSerious ? 'teve autuação séria da ANP nos últimos 12 meses.' : 'confiabilidade baixa.') + '</span></p>'
      : '';
    return (
      '<button type="button" class="rec-card" data-posto="' + best.s.c + '"><span class="l">' + REC_LABEL[kind] + '</span>' +
      '<span class="t">' + FUEL[best.fuel] + ' no ' + esc(nm(best.s)) + '</span>' +
      '<span class="s">' + brl(best.price.price) + '/l · ' + dist + ' · ' + priceWho(best.price) + '</span>' +
      (netBadges(best.s.c ? network().get(best.s.c) ?? null : null) ? '<span class="rec-badges">' + netBadges(network().get(best.s.c) ?? null, 3) + '</span>' : '') +
      tiles + '<span class="f">' + foot + '</span></button>' + warn
    );
  }
  function priceWho(pp: PricePoint) {
    const today = todayISO();
    if (pp.src === 'rede') return 'preço da rede ' + ago(pp.date, today);
    if (pp.src === 'voce') return 'preço do seu abastecimento ' + deDia(pp.date, today);
    return 'ANP ' + dm(pp.date);
  }

  function compareCard(kind: BaseKind) {
    const opts: [BaseKind, string][] = [];
    if (place('casa')) opts.push(['casa', 'Casa']);
    if (place('trabalho')) opts.push(['trabalho', 'Trabalho']);
    const r = rota();
    if (r?.on && r.pts.length > 1) opts.push(['rota', 'No caminho']);
    if (opts.length < 2) return '';
    const res = opts.map(([k, label]) => {
      const rs = resolve(k);
      const best = 'base' in rs ? compute(rs.base).rec.best : null;
      return { k, label, best };
    });
    const valid = res.filter((x) => x.best);
    if (valid.length < 2) return '';
    const min = Math.min(...valid.map((x) => x.best!.cost));
    return (
      '<div class="card cmp"><span class="hint b">Para rodar ' + Math.round(carInfo().model.kmTank) + ' km no melhor posto de cada lugar</span><div class="cmp-grid">' +
      res.map((x) => {
        if (!x.best) return '<button type="button" class="cmp-cell" data-base="' + x.k + '"><span>' + x.label + '</span><b>–</b><em>sem preço</em></button>';
        const cheapest = x.best.cost === min;
        return '<button type="button" class="cmp-cell' + (cheapest ? ' win' : '') + (x.k === kind ? ' cur' : '') + '" data-base="' + x.k + '"><span>' + x.label + '</span><b>' + brl(x.best.cost) + '</b><em>' + (cheapest ? 'mais barato' : '+' + brl(x.best.cost - min)) + '</em></button>';
      }).join('') + '</div></div>'
    );
  }

  function needCard(need: string) {
    if (need === 'gps')
      return '<div class="card center"><p class="hint">' + (locating ? 'Pegando sua localização…' : 'Use a localização do celular ou escolha um endereço.') + '</p><div class="btn-row"><button type="button" class="btn primary" data-act="gps"' + (locating ? ' disabled' : '') + '>' + TARGET + 'Onde estou</button><button type="button" class="btn" data-act="outro">Outro local</button></div></div>';
    const txt = need === 'rota'
      ? 'Cadastre casa e trabalho e ligue “Postos no caminho” para ver os postos do seu trajeto.'
      : 'Cadastre ' + (need === 'casa' ? 'o endereço de casa' : 'o endereço do trabalho') + ' para comparar os postos de lá.';
    return '<div class="card center"><p class="hint">' + txt + '</p><a class="btn primary" href="#/locais">Cadastrar casa e trabalho</a></div>';
  }

  function stationRow(r: StationRow, b: Base, isBest: boolean) {
    const fav = favorite();
    const mineTag = fav?.s.c === r.s.c ? '<span class="tag mine">seu posto</span> ' : '';
    const p = r.best?.price ?? r.gas ?? r.eth;
    const m = model();
    const gasOn = m.fuels.includes('gasolina'), ethOn = m.fuels.includes('etanol');
    const sub = [distTxt(r, b), r.s.b === 'Bandeira branca' ? 'bandeira branca' : r.s.b, r.s.br].filter(Boolean).map(esc).join(' · ');
    const badges = netBadges(r.live);
    return (
      '<button type="button" class="st-row' + (isBest ? ' best' : '') + '" data-posto="' + r.s.c + '"><span class="h"><span class="n"><span>' + mineTag + esc(nm(r.s)) + '</span><span>' + sub + '</span></span>' + scoreChip(r) + '</span>' +
      '<span class="p">' + (gasOn ? '<span><i class="dot gas"></i>' + (r.gas ? brl(r.gas.price) : '–') + '</span>' : '') + (ethOn ? '<span><i class="dot eth"></i>' + (r.eth ? brl(r.eth.price) : '–') + '</span>' : '') + srcTxt(p) + '</span>' +
      (badges ? '<span class="badges">' + badges + '</span>' : '') + '</button>'
    );
  }

  /** Seu posto mais usado que está na lista da ANP. */
  function favorite(): { u: StationUse; s: Station } | null {
    if (!file) return null;
    for (const u of usage()) {
      const s = stations().find((x) => x.c === u.station_id);
      if (s) return { u, s };
    }
    return null;
  }
  function rowFor(s: Station, b: Base): StationRow {
    return stationsFor([s], b.kind === 'ponto' ? { ...b, radiusKm: 9999 } : { ...b, detourKm: 9999 }, model(), own(), todayISO(), google, network())[0];
  }

  function myCard(b: Base, rec: Recommendation) {
    const fav = favorite();
    if (!fav) return '';
    const { u, s } = fav;
    const row = rowFor(s, b);
    const kmT = Math.round(carInfo().model.kmTank);
    const mine = row.best && !row.best.stale ? row.best : null;
    let price = '';
    if (!mine) price = 'Sem preço recente deste posto. Ao abastecer lá, o preço que você pagar passa a valer.';
    else if (!rec.best) price = FUEL[mine.fuel] + ' a ' + brl(mine.price.price) + ' (' + priceWho(mine.price) + ') · ' + distTxt(row, b) + '.';
    else if (rec.best.s.c === s.c) price = '<b>É a melhor opção agora</b> (' + FUEL[mine.fuel].toLowerCase() + ' a ' + brl(mine.price.price) + ').';
    else {
      const diff = mine.cost - rec.best.cost;
      price = diff > 0.5
        ? FUEL[mine.fuel] + ' a ' + brl(mine.price.price) + ': para rodar ' + kmT + ' km sai <b>≈ ' + brl(diff) + ' mais caro</b> que a melhor opção.'
        : FUEL[mine.fuel] + ' a ' + brl(mine.price.price) + ': praticamente o mesmo custo da melhor opção.';
    }
    const v = usageVerdict(u);
    return (
      '<button type="button" class="card my-card" data-posto="' + s.c + '"><span class="l">Seu posto · ' + pl(u.fills, 'abastecimento', 'abastecimentos') + ', o último em ' + dm(u.last) + '</span>' +
      '<span class="t">' + esc(nm(s)) + '</span><span class="s">' + price + '</span>' + (v ? '<span class="s ' + v.tone + '">' + esc(v.text) + '</span>' : '') + '</button>'
    );
  }

  function noPriceCard(rows: StationRow[], b: Base) {
    const r = bestWithoutPrice(rows);
    const head = '<span class="l">Nenhum posto ' + (b.kind === 'rota' ? 'no caminho' : 'neste raio') + ' tem preço recente</span>';
    if (!r) return '<div class="card my-card">' + head + '<span class="s">Os postos daqui não têm preço e nenhum passou na confiabilidade.</span></div>';
    return (
      '<button type="button" class="card my-card" data-posto="' + r.s.c + '">' + head +
      '<span class="t">Melhor avaliado e mais perto: ' + esc(nm(r.s)) + '</span>' +
      '<span class="s">Confiabilidade ' + fmt(r.rel.score, 1) + ' · ' + distTxt(r, b) + ' · <b>sem preço</b>: confira na bomba. O preço que você pagar entra na rede.</span></button>'
    );
  }

  function renderFilters() {
    const car = carInfo().model;
    const chip = (key: string, on: boolean, label: string) => '<button type="button" class="fchip" data-f="' + key + '" aria-pressed="' + on + '">' + label + '</button>';
    const fuelChips = car.fuels.length > 1
      ? chip('gasolina', filters.fuel === 'gasolina', '<i class="dot gas"></i>Gasolina') + chip('etanol', filters.fuel === 'etanol', '<i class="dot eth"></i>Etanol')
      : '';
    $('p-filters').innerHTML = fuelChips + chip('ok', filters.ok, 'Só confiáveis') + chip('recent', filters.recent, 'Preço até 7 dias') + chip('bath', filters.bath, 'Banheiro bom');
  }

  function render() {
    if (currentRoute().view !== 'postos') return;
    document.querySelectorAll<HTMLElement>('#p-base button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.base === base)));
    renderFilters();
    const rs = resolve(base);
    const right = 'base' in rs && rs.base.kind === 'rota'
      ? '<span class="mini-seg">' + DETOURS.map((d) => '<button type="button" data-detour="' + d + '" aria-pressed="' + (rota()?.detour_m === d) + '">' + (d < 1000 ? d + ' m' : d / 1000 + ' km') + '</button>').join('') + '</span>'
      : '<span class="mini-seg">' + RADII.map((r) => '<button type="button" data-radius="' + r + '" aria-pressed="' + (radius === r) + '">' + r + ' km</button>').join('') + '</span>';
    $('p-where').innerHTML = '<span class="w">' + PIN + '<span>' + esc(rs.where) + '</span></span>' + right;
    const body = $('p-body');
    if (!file) {
      $('p-map').hidden = true;
      body.innerHTML = loadFailed
        ? '<div class="card center"><p class="hint">Não consegui carregar a lista de postos. Na primeira vez é preciso internet; depois ela fica no celular.</p><button type="button" class="btn" data-act="retry">Tentar de novo</button></div>'
        : '<div class="empty">Carregando postos…</div>';
      return;
    }
    if ('need' in rs) {
      $('p-map').hidden = true;
      body.innerHTML = needCard(rs.need) + compareCard(base) + sourcesNote();
      return;
    }
    const { rows, rec } = compute(rs.base);
    askNetwork(compute(rs.base, false).rows);
    if (rs.base.kind === 'ponto') fetchGoogle(rs.center, radius);
    else {
      const path = rs.base.path;
      let acc = 0;
      fetchGoogle(path[0], 4);
      for (let i = 1; i < path.length; i++) {
        acc += haversineKm(path[i - 1], path[i]);
        if (acc >= 7 || i === path.length - 1) { fetchGoogle(path[i], 4); acc = 0; }
      }
    }
    const sorted = sortRows(rows);
    const limit = showAll ? sorted.length : 20;
    let html = '';
    if (rec.best) html += recCard(base, rec, rs.base);
    else if (rows.length) html += noPriceCard(rows, rs.base);
    html += myCard(rs.base, rec);
    html += compareCard(base);
    const active = filters.ok || filters.recent || filters.bath;
    if (!rows.length) {
      html += '<div class="card center"><p class="hint">' + (active ? 'Nenhum posto passa nos filtros escolhidos. Tire um filtro ou aumente a distância.' : 'Nenhum posto ' + (rs.base.kind === 'rota' ? 'tão perto do caminho' : 'neste raio') + '. Aumente a distância acima.') + '</p></div>';
    } else {
      html += '<div class="sec-head"><span>' + pl(rows.length, 'posto', 'postos') + '</span><span class="hint">preço mais recente primeiro</span></div>';
      html += '<div class="list-card">' + sorted.slice(0, limit).map((r) => stationRow(r, rs.base, r.s.c === rec.best?.s.c)).join('') + (sorted.length > limit ? '<button type="button" class="list-more" data-act="all">Mostrar todos (' + sorted.length + ')</button>' : '') + '</div>';
    }
    body.innerHTML = html + sourcesNote();
    drawMap(rs, sorted.slice(0, limit), rec);
  }

  function sourcesNote() {
    if (!file) return '';
    const w = file.fontes.lpc_semanas[0];
    const g = gBlocked ? esc(gBlocked) + ' As notas já buscadas continuam valendo.' : googleOn === true ? 'Notas do Google atualizadas uma vez por semana.' : googleOn === false ? 'Notas do Google ainda não configuradas.' : '';
    return '<p class="foot-note">Preços: o que a rede pagou nos últimos 7 dias, os seus abastecimentos e a pesquisa semanal da ANP' + (w ? ' (mais recente: ' + dm(w[0]) + ' a ' + dm(w[1]) + ')' : '') + '. Confiabilidade: fiscalização da ANP nos últimos 5 anos, notas do Google e o rendimento medido pela rede. ' + g + ' Distâncias aproximadas.</p>';
  }

  /* ---------- mapa da aba ---------- */
  let L: typeof import('leaflet') | null = null;
  let pmap: import('leaflet').Map | null = null;
  let layer: import('leaflet').LayerGroup | null = null;
  let mapKey = '';
  async function loadLeaflet() {
    if (!L) [L] = await Promise.all([import('leaflet'), import('leaflet/dist/leaflet.css')]);
    return L;
  }
  async function drawMap(rs: Extract<Resolved, { base: Base }>, rows: StationRow[], rec: Recommendation) {
    const el = $('p-map');
    el.hidden = false;
    const Lf = await loadLeaflet();
    if (currentRoute().view !== 'postos') return;
    if (!pmap) {
      pmap = Lf.map(el, { zoomControl: false, attributionControl: true, scrollWheelZoom: false, zoomAnimation: false, fadeAnimation: false, markerZoomAnimation: false });
      pmap.attributionControl.setPrefix(false);
      Lf.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(pmap);
      layer = Lf.layerGroup().addTo(pmap);
    }
    pmap.invalidateSize();
    layer!.clearLayers();
    const pts: [number, number][] = [];
    if (rs.base.kind === 'rota') {
      const line = rs.base.path.map((p) => [p.lat, p.lon] as [number, number]);
      Lf.polyline(line, { color: '#1D4ED8', weight: 4, opacity: 0.7 }).addTo(layer!);
      pts.push(...line);
    } else {
      Lf.circleMarker([rs.center.lat, rs.center.lon], { radius: 7, color: '#FFFFFF', weight: 3, fillColor: '#1D4ED8', fillOpacity: 1 }).addTo(layer!);
      pts.push([rs.center.lat, rs.center.lon]);
    }
    // no mapa só os postos com preço recente (o melhor sempre aparece)
    for (const r of rows) {
      const best = r.s.c === rec.best?.s.c;
      if (!best && !(r.best && !r.best.stale)) continue;
      const price = fmt(r.best!.price.price, 2);
      const icon = Lf.divIcon({ className: 'pin ' + (r.best!.fuel === 'etanol' ? 'eth' : 'gas') + (best ? ' best' : '') + (r.rel.level === 'evitar' ? ' bad' : ''), html: '<span>' + price + '</span>', iconSize: undefined as any, iconAnchor: [20, 14] });
      Lf.marker([r.s.la, r.s.lo], { icon, title: nm(r.s), keyboard: false }).on('click', () => openPosto(r.s.c)).addTo(layer!);
      pts.push([r.s.la, r.s.lo]);
    }
    const key = base + '|' + radius + '|' + rows.length;
    if (key !== mapKey && pts.length) {
      mapKey = key;
      if (pts.length === 1) pmap.setView(pts[0], 14);
      else pmap.fitBounds(Lf.latLngBounds(pts).pad(0.08));
    }
  }

  $('p-base').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-base]');
    if (!b) return;
    base = b.dataset.base as BaseKind;
    showAll = false;
    if (base === 'agora' && !here) return locate();
    render();
  });
  $('p-filters').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-f]');
    if (!b) return;
    const f = b.dataset.f!;
    if (f === 'gasolina' || f === 'etanol') filters.fuel = filters.fuel === f ? 'auto' : f;
    else if (f === 'ok') filters.ok = !filters.ok;
    else if (f === 'recent') filters.recent = !filters.recent;
    else if (f === 'bath') filters.bath = !filters.bath;
    try { localStorage.setItem('postos_filtros', JSON.stringify(filters)); } catch { /* sem acesso */ }
    mapKey = '';
    render();
  });
  $('p-where').addEventListener('click', async (e) => {
    const el = e.target as HTMLElement;
    const r = el.closest<HTMLElement>('[data-radius]');
    const d = el.closest<HTMLElement>('[data-detour]');
    if (r) { radius = Number(r.dataset.radius); render(); }
    if (d && S.places.rota) await setPlace('rota', { label: 'Casa → Trabalho', lat: null, lon: null, data: { ...S.places.rota.data, detour_m: Number(d.dataset.detour) } });
  });
  $('p-body').addEventListener('click', (e) => {
    const el = e.target as HTMLElement;
    const act = el.closest<HTMLElement>('[data-act]')?.dataset.act;
    const posto = el.closest<HTMLElement>('[data-posto]')?.dataset.posto;
    const cmp = el.closest<HTMLElement>('.cmp-cell[data-base]')?.dataset.base;
    if (act === 'gps') return locate();
    if (act === 'outro') return openLocal();
    if (act === 'all') { showAll = true; return render(); }
    if (act === 'retry') { loadFailed = false; render(); ensureFile().then(render); return; }
    if (cmp) { base = cmp as BaseKind; return render(); }
    if (posto) openPosto(posto);
  });
  $('p-outro').addEventListener('click', () => openLocal());

  /* ---------- ficha do posto ---------- */
  let shown: Station | null = null;
  function openPosto(cnpj: string) {
    const s = stations().find((x) => x.c === cnpj);
    if (!s) return;
    shown = s;
    renderPosto(s);
    openSheet('posto-sheet');
    const gm = gmatch.get(s.c);
    if (!gm && googleOn !== false && !gTried.has(s.c)) lookupStation(s);
    if (gm?.photo) showPhoto(gm.photo);
    fetchNetwork([s.c]).then((ch) => ch && shown?.c === s.c && renderPosto(s));
    setTimeout(() => showMap(s), 280);
  }

  function renderPosto(s: Station) {
    const today = todayISO();
    const rs = resolve(base);
    const b: Base = 'base' in rs ? rs.base : { kind: 'ponto', at: here?.p ?? { lat: s.la, lon: s.lo }, radiusKm: 999 };
    const row = rowFor(s, b);
    const car = carInfo();
    const live = row.live;
    const rel = row.rel;
    const gm = gmatch.get(s.c);
    const g = google.get(s.c);
    const priceCell = (fuel: Fuel, pp: PricePoint | null) =>
      '<div class="pc"><span class="k"><i class="dot ' + (fuel === 'gasolina' ? 'gas' : 'eth') + '"></i>' + FUEL[fuel] + '</span><span class="v">' + (pp ? brl(pp.price) : '–') + '</span><span class="d ' + (pp?.src ?? '') + '">' +
      (pp ? (pp.src === 'rede' ? 'rede · ' + pl(pp.n ?? 1, 'pessoa', 'pessoas') + ' · ' + ago(pp.date, today) : pp.src === 'voce' ? 'seu último abastecimento aqui, ' + deDia(pp.date, today).replace(/^de /, '') : 'ANP · pesquisa de ' + dm(pp.date)) + (ageDays(pp.date, today) > 30 ? ' (antigo)' : '') : 'sem preço recente') + '</span></div>';
    const extra = (['ga', 'd10', 'ds', 'gnv'] as const).filter((k) => s.pr?.[k]).map((k) => ({ ga: 'Gasolina aditivada', d10: 'Diesel S10', ds: 'Diesel', gnv: 'GNV' })[k] + ' ' + brl(s.pr![k]![0])).join(' · ');
    let perKm = '';
    if (row.gas && row.eth && car.model.fuels.length > 1) {
      const cg = row.opts.find((o) => o.fuel === 'gasolina'), ce = row.opts.find((o) => o.fuel === 'etanol');
      if (cg && ce) {
        const winner = ce.costPerKm < cg.costPerKm ? 'etanol' : 'gasolina';
        perKm = 'No ' + esc(car.name) + ', ' + winner + ' sai <b>' + brl(Math.abs(cg.costPerKm - ce.costPerKm)) + ' mais barato por km</b> aqui.';
      }
    }
    const dist = 'base' in rs ? (b.kind === 'rota' ? (row.distKm < 0.15 ? 'no caminho' : '+' + kmTxt(row.extraKm) + ' de desvio') : kmTxt(row.distKm)) : '';

    // Rendimento medido pela rede
    const y = live?.yield;
    let yieldCard: string;
    if (y?.pub && y.r != null) {
      const pct = Math.round(y.r * 100);
      const tone = y.r >= 1 ? 'ok' : y.r < 0.97 ? 'warn' : 'neutral';
      const pos = Math.max(2, Math.min(98, 50 + (y.r - 1) * 250));
      yieldCard =
        '<div class="card"><div class="card-head"><span>Rendimento medido</span><span class="score ' + (tone === 'ok' ? 'ok' : tone === 'warn' ? 'atencao' : 'neutro') + '">' + (tone === 'ok' ? 'bom' : tone === 'warn' ? 'abaixo do normal' : 'normal') + '</span></div>' +
        '<div class="big-num"><b>' + pct + '%</b><span>do consumo normal de quem abastece aqui</span></div>' +
        '<div class="gauge" aria-hidden="true"><i class="mid"></i><i class="pt" style="left:' + pos + '%"></i></div><div class="gauge-l"><span>rende menos</span><span>100% = normal</span><span>rende mais</span></div>' +
        '<span class="hint">' + pl(y.tanks, 'tanque', 'tanques') + ' de ' + pl(y.people, 'pessoa', 'pessoas') + ' nos últimos 6 meses. Cada tanque é comparado com o consumo da própria pessoa nos outros postos.</span></div>';
    } else if (y && y.people > 0) {
      yieldCard =
        '<div class="card"><div class="card-head"><span>Rendimento medido</span><span class="hint">medindo</span></div>' +
        '<div class="progress2"><div><span>Pessoas</span><b>' + Math.min(y.people, 5) + ' de 5</b><div class="bar"><i style="width:' + Math.min(100, (y.people / 5) * 100) + '%"></i></div></div><div><span>Tanques</span><b>' + Math.min(y.tanks, 15) + ' de 15</b><div class="bar"><i style="width:' + Math.min(100, (y.tanks / 15) * 100) + '%"></i></div></div></div>' +
        '<span class="hint">O número aparece quando houver volume suficiente para ser justo com o posto.</span></div>';
    } else {
      yieldCard = '<div class="card"><div class="card-head"><span>Rendimento medido</span></div><span class="hint">Ainda sem medição. Cada tanque cheio registrado aqui conta: o app compara com o consumo normal de cada pessoa.</span></div>';
    }

    // Avaliações da rede
    const rat = live?.ratings;
    const ratLine = (k: 'bomba' | 'atendimento' | 'banheiro', label: string, yes: string) => {
      const t = rat?.[k];
      if (!t) return '';
      const p = Math.round((t[0] / t[1]) * 100);
      return '<div class="rel-part"><div class="h"><span>' + label + '</span><b>' + p + '% ' + yes + '</b></div><div class="bar"><i style="width:' + p + '%"></i></div></div>';
    };
    const ratBody = rat && (rat.bomba || rat.atendimento || rat.banheiro)
      ? ratLine('bomba', 'Bomba marcou certo', 'sim') + ratLine('atendimento', 'Atendimento', 'bom') + ratLine('banheiro', 'Banheiro', 'bom')
      : '<span class="hint">' + (rat?.n ? pl(rat.n, 'avaliação', 'avaliações') + ' até agora; cada item aparece com 3 respostas.' : 'Ainda sem avaliações. Depois de abastecer aqui, o app pergunta em um toque.') + '</span>';
    const ratCard =
      '<div class="card"><div class="card-head"><span>Quem abasteceu avaliou</span><span class="hint">' + (rat?.n ? pl(rat.n, 'avaliação', 'avaliações') + ' · 6 meses' : '') + '</span></div>' + ratBody +
      '<span class="hint">No Google: ' + (g ? fmt(g.rating, 1) + ' em ' + g.count.toLocaleString('pt-BR') + ' avaliações' : gBlocked ? esc(gBlocked) : googleOn ? (gTried.has(s.c) && !gm ? 'não encontrado' : 'procurando…') : googleOn === false ? 'não configurado' : 'disponível com a conta conectada') + '</span></div>';

    // Confiabilidade (ANP)
    const lvl = rel.level === 'ok' ? 'Confiável' : rel.level === 'atencao' ? 'Atenção' : 'Evitar';
    const ev = (s.f?.ev ?? []).filter(([d]) => ageDays(d, today) <= 5 * 366);
    const anpTxt = s.f
      ? s.f.n + (s.f.n === 1 ? ' fiscalização' : ' fiscalizações') + ' em 5 anos · ' + (rel.infractions ? pl(rel.infractions, 'infração', 'infrações') : 'nenhuma infração') + (rel.interdictions ? ' · ' + pl(rel.interdictions, 'interdição ou apreensão', 'interdições ou apreensões') : '')
      : 'Sem fiscalização registrada nos últimos 5 anos (nota neutra)';
    const relCard =
      '<div class="card rel"><div class="card-head"><span>Confiabilidade</span><span class="hint">de 0 a 5</span></div>' +
      '<div class="rel-score"><b>' + fmt(rel.score, 1) + '</b><span class="score ' + rel.level + '">' + lvl + '</span></div>' +
      (rel.netWarn ? '<p class="rec-warn">' + ICON.warn + '<span>' + (rel.netWarn === 'rendimento' ? 'Os tanques daqui rendem abaixo do normal para quem usa o app.' : 'Muita gente disse que a bomba não marcou certo.') + ' A nota fica limitada a “atenção”.</span></p>' : '') +
      '<div class="rel-part"><div class="h"><span>Fiscalização da ANP (5 anos)</span><b>' + fmt(rel.anp, 1) + '</b></div><div class="bar"><i style="width:' + Math.round((rel.anp / 5) * 100) + '%"></i></div><span class="hint">' + esc(anpTxt) + '</span></div>' +
      (ev.length ? '<ul class="ev-list">' + ev.slice(0, 6).map(([d, t, txt]) => '<li><span class="d">' + dm(d) + '/' + d.slice(2, 4) + '</span><span><b>' + EVENT_LABEL[t] + '</b>' + (txt ? ' · ' + esc(txt.replace(/^(Notificação|MRC)\s*-\s*(PR ?Comb\s*-\s*)?/i, '')) : '') + '</span></li>').join('') + '</ul>' : '') +
      '<details class="more"><summary>Como a nota é calculada<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 9l6 6 6-6"/></svg></summary><p class="hint">Começa em 5 e cada ocorrência da ANP nos últimos 5 anos desconta, mais quanto mais recente e mais grave. Infração de bomba, volume ou qualidade nos últimos 12 meses limita a nota em 2,5 e tira o posto da recomendação. A média do Google entra com peso de 35%, puxada para 4,0 quando há poucas avaliações. Rendimento medido abaixo de 95% ou bomba mal avaliada limitam a nota a 3,4. O rendimento medido também entra no custo por km da recomendação.</p></details></div>';

    // Você aqui
    const mine = S.logs.filter((f) => f.station_id === s.c).sort((a, b2) => b2.date.localeCompare(a.date));
    const u = usage().find((x) => x.station_id === s.c);
    const v = u ? usageVerdict(u) : null;
    const meCard =
      '<div class="card"><span class="b15">Você aqui</span>' +
      (v ? '<span class="hint ' + v.tone + '">' + esc(v.text) + (u!.kml ? ' Média daqui: ' + fmt(u!.kml, 2) + ' km/l.' : '') + '</span>' : '') +
      (mine.length ? '<ul class="ev-list">' + mine.slice(0, 5).map((f) => '<li><span class="d">' + dm(f.date) + '/' + f.date.slice(2, 4) + '</span><span>' + FUEL[f.fuel as Fuel] + ' · ' + brl(f.price_per_l) + '/l · ' + brl(f.total_brl) + '</span></li>').join('') + '</ul>' : '<span class="hint">Nenhum abastecimento seu aqui ainda.</span>') +
      linkOffer(s) + '</div>';

    $('posto-title').textContent = nm(s);
    $('posto-body').innerHTML =
      (gm?.photo ? '<figure class="ps-photo" id="ps-photo"><div class="ph"></div><figcaption>Foto: ' + esc(gm.photo.author || 'Google') + ' · Google</figcaption></figure>' : '') +
      '<div class="ps-head"><h2>' + esc(nm(s)) + '</h2>' + (gm && gm.name !== s.n ? '<span class="hint">No cadastro da ANP: ' + esc(s.n) + '</span>' : '') +
      '<span class="hint">' + [s.e, s.br, s.m].filter(Boolean).map(esc).join(', ') + '</span>' +
      '<span class="hint">' + [s.b === 'Bandeira branca' ? 'bandeira branca' : s.b, dist].filter(Boolean).map(esc).join(' · ') + (s.pg === 'b' ? ' · localização aproximada' : '') + '</span></div>' +
      '<div class="price-grid">' + (car.model.fuels.includes('gasolina') ? priceCell('gasolina', row.gas) : '') + (car.model.fuels.includes('etanol') ? priceCell('etanol', row.eth) : '') + '</div>' +
      (perKm ? '<p class="hint" style="margin-top:-6px">' + perKm + '</p>' : '') +
      (extra ? '<p class="hint" style="margin-top:-6px">Também: ' + esc(extra) + '</p>' : '') +
      yieldCard + ratCard + relCard + meCard +
      '<div class="card"><div class="card-head"><span>Como chegar</span><span class="hint" id="ps-eta"></span></div><div class="ps-map" id="ps-map" role="img" aria-label="Mapa com o posto e o caminho até ele"></div><span class="hint" id="ps-map-note"></span></div>';
  }

  /** Abastecimentos antigos sem posto: oferece ligar a este. */
  function linkOffer(s: Station) {
    const n = carLogs().filter((f) => !f.station_id && !f.station).length;
    if (!n) return '';
    return '<button type="button" class="btn sm" id="posto-mine" data-armed="0">É aqui que eu abasteço</button><span class="hint">Liga a este posto ' + (n === 1 ? 'o seu abastecimento' : 'os seus ' + n + ' abastecimentos') + ' sem posto anotado.</span>';
    void s;
  }

  const photoUris = new Map<string, string | null>();
  async function showPhoto(ph: { name: string }) {
    let uri = photoUris.get(ph.name);
    if (uri === undefined && !gBlocked) {
      try {
        uri = await googlePhoto(ph.name);
      } catch (e) {
        await gError(e);
        uri = null;
      }
      photoUris.set(ph.name, uri ?? null);
    }
    const fig = document.getElementById('ps-photo');
    if (!fig) return;
    if (!uri) return fig.remove();
    const img = new Image();
    img.alt = 'Foto do posto';
    img.decoding = 'async';
    img.onload = () => fig.querySelector('.ph')?.replaceWith(img);
    img.onerror = () => fig.remove();
    img.src = uri;
  }

  let map: import('leaflet').Map | null = null;
  const routes = new Map<string, { pts: [number, number][]; km: number; min: number } | null>();
  async function showMap(s: Station) {
    const el = document.getElementById('ps-map');
    if (!el || shown?.c !== s.c) return;
    const Lf = await loadLeaflet();
    map?.remove();
    map = Lf.map(el, { zoomControl: false, attributionControl: true, scrollWheelZoom: false, zoomAnimation: false, fadeAnimation: false, markerZoomAnimation: false });
    map.attributionControl.setPrefix(false);
    Lf.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
    const dest: [number, number] = [s.la, s.lo];
    Lf.circleMarker(dest, { radius: 9, color: '#FFFFFF', weight: 3, fillColor: '#C2410C', fillOpacity: 1 }).addTo(map).bindTooltip(nm(s), { direction: 'top', offset: [0, -8] });
    const fresh = here && Date.now() - here.at < 15 * 60000 ? here.p : null;
    const rs = resolve(base);
    const fromBase = base === 'rota' ? place('casa') : 'center' in rs ? rs.center : null;
    const origin = fresh ?? fromBase;
    const label = fresh ? 'de onde você está' : base === 'casa' || base === 'rota' ? 'de casa' : base === 'trabalho' ? 'do trabalho' : 'do local escolhido';
    const eta = document.getElementById('ps-eta')!, note = document.getElementById('ps-map-note')!;
    if (!origin) {
      map.setView(dest, 15);
      note.innerHTML = 'Toque em <b>Como chegar</b> para navegar até aqui.';
      return;
    }
    const o: [number, number] = [origin.lat, origin.lon];
    Lf.circleMarker(o, { radius: 7, color: '#FFFFFF', weight: 3, fillColor: '#1D4ED8', fillOpacity: 1 }).addTo(map);
    map.fitBounds(Lf.latLngBounds([o, dest]).pad(0.25));
    const key = o.map((x) => x.toFixed(4)).join(',') + '>' + s.c;
    let r = routes.get(key);
    if (r === undefined) {
      eta.textContent = 'calculando…';
      try {
        r = await route(origin, { lat: s.la, lon: s.lo });
      } catch {
        r = null;
      }
      routes.set(key, r);
    }
    if (!map || shown?.c !== s.c) return;
    if (!r) {
      eta.textContent = '';
      note.textContent = navigator.onLine === false ? 'Sem internet para calcular o caminho.' : 'Não consegui calcular o caminho agora.';
      return;
    }
    const line = Lf.polyline(r.pts, { color: '#1D4ED8', weight: 5, opacity: 0.85 }).addTo(map);
    map.fitBounds(line.getBounds().extend(dest).extend(o).pad(0.15));
    eta.textContent = '≈ ' + (r.min < 1 ? '1' : r.min) + ' min · ' + fmt(r.km, 1) + ' km';
    note.textContent = 'De carro, ' + label + ', sem contar trânsito.';
  }
  onSheetClose('posto-sheet', () => {
    map?.remove();
    map = null;
    shown = null;
  });

  async function lookupStation(s: Station) {
    gTried.add(s.c);
    const key = 'posto:' + s.c;
    let places = await gGet(key);
    if (!places && !gBlocked) {
      try {
        const res = await googlePlaces<GoogleStation>({ mode: 'posto', query: 'posto de combustível ' + s.e + ', ' + s.m + ' SC', lat: s.la, lon: s.lo });
        googleOn = res.configured;
        if (res.configured) {
          places = res.places;
          await gPut(key, places);
        }
      } catch (e) {
        await gError(e);
      }
    }
    if (places) addMatches(matchGoogle(places, [s]));
    if (shown?.c === s.c) {
      renderPosto(s);
      const gm = gmatch.get(s.c);
      if (gm?.photo) showPhoto(gm.photo);
      setTimeout(() => showMap(s), 50);
    }
    render();
  }
  $('posto-body').addEventListener('click', async (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('#posto-mine');
    if (!b || !shown) return;
    if (b.dataset.armed !== '1') {
      b.dataset.armed = '1';
      b.textContent = 'Confirmar';
      b.classList.add('primary');
      return;
    }
    const st = shown;
    const rows = carLogs().filter((f) => !f.station_id && !f.station);
    await db.fuel_logs.bulkPut(rows.map((f) => stamp<FuelLog>({ ...f, station_id: st.c, station: stationLabel(st, nm(st)) })));
    toast(pl(rows.length, 'abastecimento ligado', 'abastecimentos ligados') + ' a ' + nm(st));
    setTimeout(() => shown && renderPosto(shown), 300);
  });
  $('posto-route').addEventListener('click', () => {
    if (shown) window.open(mapsUrl(shown, gmatch.get(shown.c)), '_blank', 'noopener');
  });
  $('posto-fill').addEventListener('click', () => {
    if (!shown) return;
    const rs = resolve(base);
    const b: Base = 'base' in rs ? rs.base : { kind: 'ponto', at: { lat: shown.la, lon: shown.lo }, radiusKm: 999 };
    const best = rowFor(shown, b).best;
    ctx.fillAt(shown, best?.fuel ?? null, best && !best.stale ? best.price : null);
  });

  /* ---------- "Outro local" ---------- */
  function openLocal() {
    renderLocal();
    openSheet('local-sheet');
    search.clear();
  }
  function renderLocal() {
    const r = rota();
    const saved: string[] = [];
    for (const k of ['casa', 'trabalho'] as const) {
      const p = place(k);
      if (p) saved.push('<button type="button" class="row nav" data-pick="' + k + '"><span class="ic gray">' + (k === 'casa' ? HOUSE : BAG) + '</span><span class="mid"><span class="a">' + (k === 'casa' ? 'Casa' : 'Trabalho') + '</span><span class="b">' + esc(p.label) + '</span></span><span class="chev">' + ICON.chev + '</span></button>');
    }
    if (r?.on && r.pts.length > 1) saved.push('<button type="button" class="row nav" data-pick="rota"><span class="ic gray">' + PIN + '</span><span class="mid"><span class="a">No caminho casa → trabalho</span><span class="b">Desvio até ' + (r.detour_m < 1000 ? r.detour_m + ' m' : r.detour_m / 1000 + ' km') + '</span></span><span class="chev">' + ICON.chev + '</span></button>');
    $('local-saved').innerHTML = saved.join('') + '<button type="button" class="list-more" data-close-local>' + (saved.length ? 'Editar casa e trabalho' : 'Cadastrar casa e trabalho') + '</button>';
  }
  const search = addressSearch($<HTMLInputElement>('local-q'), $('local-results'), {
    near: () => here?.p ?? place('casa'),
    onPick: (p) => {
      other = p;
      base = 'busca';
      kindChosen = true;
      closeSheets(() => (currentRoute().view !== 'postos' ? go('postos') : render()));
    },
  });
  $('local-gps').addEventListener('click', () => {
    base = 'agora';
    kindChosen = true;
    here = null;
    closeSheets(() => {
      if (currentRoute().view !== 'postos') go('postos');
      locate();
    });
  });
  $('local-saved').addEventListener('click', (e) => {
    const el = e.target as HTMLElement;
    if (el.closest('[data-close-local]')) return closeSheets(() => go('locais'));
    const pick = el.closest<HTMLElement>('[data-pick]')?.dataset.pick;
    if (!pick) return;
    base = pick as BaseKind;
    kindChosen = true;
    closeSheets(() => (currentRoute().view !== 'postos' ? go('postos') : render()));
  });

  /* ---------- card "Onde abastecer" do Início ---------- */
  let homeLoading = false;
  function renderHome() {
    const el = $('home-rec');
    if (currentRoute().view !== 'inicio') return;
    const kind: BaseKind | null = rota()?.on && (rota()?.pts.length ?? 0) > 1 ? 'rota' : place('casa') ? 'casa' : place('trabalho') ? 'trabalho' : here ? 'agora' : null;
    if (!kind) {
      el.innerHTML =
        '<div class="rec-card static"><span class="l">Onde abastecer</span><span class="t">Veja o posto que mais compensa</span><span class="s">Perto de você, de casa ou do trabalho, com o preço mais recente e o rendimento medido por quem abastece lá.</span>' +
        '<div class="rec-actions"><a class="btn sm light" href="#/postos">' + TARGET + 'Perto de mim</a><a class="btn sm ghost" href="#/locais">Casa e trabalho</a></div></div>';
      return;
    }
    if (!file) {
      el.innerHTML = '<div class="rec-card static"><span class="l">Onde abastecer</span><span class="s">' + (loadFailed ? 'Lista de postos indisponível agora.' : 'Carregando postos…') + '</span></div>';
      if (!homeLoading && !loadFailed) {
        homeLoading = true;
        ensureFile().then(() => { homeLoading = false; renderHome(); });
      }
      return;
    }
    const rs = resolve(kind);
    if (!('base' in rs)) { el.innerHTML = ''; return; }
    const all = compute(rs.base, false);
    askNetwork(all.rows);
    const rec = all.rec;
    const where = kind === 'rota' ? 'No caminho para o trabalho' : kind === 'casa' ? 'Perto de casa' : kind === 'trabalho' ? 'Perto do trabalho' : 'Perto de você';
    if (!rec.best) {
      const r = bestWithoutPrice(all.rows);
      el.innerHTML = r
        ? '<a class="rec-card" href="#/postos" data-home-base="' + kind + '"><span class="l">' + where + '</span><span class="t">' + esc(nm(r.s)) + '</span><span class="s">Sem preço recente nos postos daqui · melhor avaliado e mais perto (confiabilidade ' + fmt(r.rel.score, 1) + ')</span></a>'
        : '';
      return;
    }
    const b = rec.best;
    const dist = rs.base.kind === 'rota' ? (b.distKm < 0.15 ? 'no caminho' : '+' + kmTxt(b.extraKm) + ' de desvio') : kmTxt(b.distKm);
    const fav = favorite();
    let favTxt = '';
    if (fav && fav.s.c === b.s.c) favTxt = 'É o seu posto de sempre.';
    else if (fav) {
      const o = rowFor(fav.s, rs.base).best;
      if (o && !o.stale && o.cost - b.cost > 0.5) favTxt = 'No seu posto de sempre sairia ≈ ' + brl(o.cost - b.cost) + ' a mais.';
    }
    const badges = netBadges(b.s.c ? network().get(b.s.c) ?? null : null, 2);
    el.innerHTML =
      '<a class="rec-card" href="#/postos" data-home-base="' + kind + '"><span class="l">' + where + '</span>' +
      '<span class="t">' + FUEL[b.fuel] + ' no ' + esc(nm(b.s)) + '</span>' +
      '<span class="s">' + brl(b.price.price) + '/l · ' + dist + (rec.bestOther ? ' · ' + brl(rec.bestOther.cost - b.cost) + ' a menos que ' + FUEL[rec.bestOther.fuel].toLowerCase() : '') + '</span>' +
      '<span class="rec-badges"><span class="nb on-dark ' + b.price.src + '">' + priceWho(b.price) + '</span>' + badges.replace(/class="nb/g, 'class="nb on-dark') + '<span class="nb on-dark">ANP ' + fmt(b.rel.anp, 1) + '</span></span>' +
      (favTxt ? '<span class="f">' + esc(favTxt) + '</span>' : '') +
      '<span class="more">Ver outros postos ' + ICON.chev + '</span></a>';
  }
  $('home-rec').addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest<HTMLElement>('[data-home-base]');
    if (a) base = a.dataset.homeBase as BaseKind;
    kindChosen = true;
  });

  /* ---------- usados pelo abastecimento ---------- */
  /** Postos perto de um ponto, do mais perto para o mais longe (já com o ponto do Google quando houver). */
  function nearby(p: LatLon, maxKm: number): { s: Station; d: number }[] {
    const bb = bboxAround(p, maxKm);
    return stations()
      .filter((s) => s.la > bb.s && s.la < bb.n && s.lo > bb.w && s.lo < bb.e)
      .map((s) => ({ s, d: haversineKm(p, { lat: s.la, lon: s.lo }) }))
      .filter((x) => x.d <= maxKm)
      .sort((a, b) => a.d - b.d);
  }
  function byId(c: string) {
    return stations().find((s) => s.c === c) ?? null;
  }
  /** Melhor preço conhecido de um posto para um combustível (seu, da rede ou da ANP). */
  function priceAt(s: Station, fuel: Fuel): PricePoint | null {
    const r = stationsFor([s], { kind: 'ponto', at: { lat: s.la, lon: s.lo }, radiusKm: 1 }, { ...carInfo().model, fuels: [fuel] }, own(), todayISO(), google, network())[0];
    return fuel === 'gasolina' ? r.gas : r.eth;
  }
  function setHere(p: LatLon) {
    here = { p, at: Date.now() };
  }

  /** Chamado quando os dados do app mudam (sincronização, novo abastecimento, locais). */
  function refresh() {
    renderHome();
    render();
  }
  subscribe(refresh);
  onShow('postos', () => {
    show();
    setTimeout(() => pmap?.invalidateSize(), 50);
  });

  return { refresh, renderHome, openPosto, ensureFile, nearby, byId, nameOf: nm, priceAt, setHere, usage, favorite, place, fetchGoogleAround: fetchGoogle };
}
export type PostosApi = ReturnType<typeof initPostos>;
