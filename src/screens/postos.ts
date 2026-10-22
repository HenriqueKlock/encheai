// Aba Postos (mapa, filtros e lista), ficha do posto, "Outro local" e o card "Onde abastecer" do Início.
// Junta três fontes: o arquivo da ANP (cadastro, preços semanais, fiscalização), o Google (nota e foto,
// guardados no aparelho por 7 dias) e a rede (preço pago, rendimento medido e avaliações de quem usa o app).
import {
  EVENT_LABEL, ageDays, anpName, bboxAround, bestWithoutPrice, goodShare, haversineKm, bestForStation, matchGoogle, nameTokens, rankForStation, recommend, starsOf, sortRows, stationsFor, usageVerdict, weakPoints, yieldOf,
  type Base, type CarModel, type Fuel, type GoogleMatch, type GoogleStation, type LatLon, type OwnPrice, type Personal, type PricePoint,
  type Recommendation, type Station, type StationLive, type StationRow, type StationsFile, type StationUse,
} from '../postos';
import { gps, loadStations, route, type FoundPlace, type Route } from '../lugares';
import { currentSession, googleNota, googlePhoto, googlePlaces, googleReviews, setPlace, stationPlaces, votePlace, type GoogleReviews, type PlaceLinks, type Places } from '../sync';
import { fetchNetwork, invalidateNetwork, network } from '../rede';
import { plausible, reportPrices, reportedAsOwn } from '../precos';
import { getMeta, setMeta, stamp, db, type FuelLog } from '../db';
import { S, carInfo, carLogs, carIntervals, subscribe } from '../store';
import { mapPicks, stationUsage, type MapMode } from '../postos';
import { $, ago, brl, closeSheets, dm, esc, fmt, openSheet, onSheetClose, pl, sheetOpen, todayISO, toast } from '../ui';
import { currentRoute, go, onShow } from '../router';
import { addressSearch } from './busca-endereco';
import { ICON } from '../icons';
import { isNovo } from '../visual';
import { initFolha } from '../folha';
import { brandBadge, isBranca as isBrancaB } from '../bandeira';

type BaseKind = 'agora' | 'casa' | 'trabalho' | 'rota' | 'busca' | 'viagem';
const REC_LABEL: Record<BaseKind, string> = {
  agora: 'Melhor opção perto de você', casa: 'Melhor opção perto de casa', trabalho: 'Melhor opção perto do trabalho',
  rota: 'Melhor opção no seu caminho', busca: 'Melhor opção perto do local escolhido', viagem: 'Melhor opção no caminho até o destino',
};
const FUEL: Record<Fuel, string> = { gasolina: 'Gasolina', etanol: 'Etanol' };
const RADII = [2, 5, 10, 20, 40];
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
  /** Nota do Google por posto, só para mostrar na ficha: não entra mais na conta da confiabilidade nem no sugerido. */
  const google = new Map<string, { rating: number; count: number }>();
  const NO_G = new Map<string, { rating: number; count: number }>();
  const gTried = new Set<string>();
  /** Postos sendo procurados no Google agora (só eles mostram "procurando"). */
  const gPending = new Set<string>();
  /** O que dizer quando não há nota do Google para o posto. */
  const gStatus = (c: string, short: boolean) =>
    placeOf.has(c) && placeOf.get(c) === null ? (short ? 'fora do Google' : 'não está no Google')
      : notaPending.has(c) ? 'buscando…'
      : gmatch.has(c) && notaBlocked && !notaNone.has(c) ? (short ? 'hoje não' : notaBlocked)
      : gmatch.has(c) ? 'sem nota no Google'
      : gBlocked && !(placeOf.get(c) && !lugarBlocked) ? (short ? 'indisponível' : gBlocked)
      : gPending.has(c) ? 'procurando…'
      : googleOn === false ? 'não configurado'
      : gTried.has(c) ? (short ? 'não achado' : 'não encontrado')
      : googleOn ? (short ? 'sem nota' : 'sem nota no Google') : (short ? 'com a conta' : 'disponível com a conta conectada');
  const nm = (s: Station) => gmatch.get(s.c)?.name || anpName(s);
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
      else applyNota(c, g.id);
    }
  }

  /*
   * Nota do Google: chamada própria (a faixa grátis dela é a menor), só quando a ficha abre, uma vez por dia
   * por posto. Não entra na confiabilidade nem no sugerido; aparece na ficha como informação.
   */
  const N_KEY = 'google_notas_v1';
  type NCache = Record<string, { at: number; rating: number | null; count: number }>;
  let ncache: NCache = {};
  let notaBlocked = '';
  const notaPending = new Set<string>();
  /** Postos que o Google respondeu sem nota (hoje). */
  const notaNone = new Set<string>();
  function applyNota(c: string, id: string) {
    const e = ncache[id];
    if (!e || !fresh(e.at)) return false;
    if (e.rating != null) google.set(c, { rating: e.rating, count: e.count });
    else notaNone.add(c);
    return true;
  }
  async function loadNota(s: Station) {
    const gm = gmatch.get(s.c);
    if (!gm || google.has(s.c) || notaNone.has(s.c) || applyNota(s.c, gm.id)) return;
    if (notaBlocked || notaPending.has(s.c) || navigator.onLine === false || !(await currentSession())) return;
    notaPending.add(s.c);
    try {
      const d = await googleNota(gm.id);
      if (d) {
        ncache = Object.fromEntries(Object.entries(ncache).filter(([, e]) => fresh(e.at)));
        ncache[gm.id] = { at: Date.now(), rating: d.rating, count: d.count };
        await setMeta(N_KEY, ncache);
        applyNota(s.c, gm.id);
      }
    } catch (e) {
      const res = (e as { context?: Response })?.context;
      if (res?.status === 429) {
        try { notaBlocked = (await res.json()).error; } catch { notaBlocked = 'O limite gratuito do Google de hoje acabou.'; }
      } else console.warn('google nota', e);
    } finally {
      notaPending.delete(s.c);
      if (shown?.c === s.c && gmatch.get(s.c)?.id === gm.id) rerenderPosto(s);
    }
  }
  const googleDone = new Set<string>();
  /**
   * Postos já ligados ao Google (CNPJ → place_id), na Grande Florianópolis: pela busca do servidor ou pelas
   * pessoas (com a correção da própria pessoa por cima). null = o posto não está no Google.
   */
  let links: PlaceLinks = { place: new Map(), mine: new Map(), people: new Set() };
  let placeOf = links.place;
  const toMatch = (g: GoogleStation): GoogleMatch => ({ id: g.id, name: g.name, rating: g.rating, count: g.count, lat: g.lat, lon: g.lon, photo: g.photo ?? null, address: g.address });
  /** Liga lugares do Google aos postos: pelo place_id quando o servidor já ligou; pela comparação nos outros. */
  function linkPlaces(places: GoogleStation[], near: Station[]): Map<string, GoogleMatch> {
    const out = new Map<string, GoogleMatch>();
    const byPlace = new Map([...placeOf].filter(([, p]) => p).map(([c, p]) => [p!, c]));
    const rest: GoogleStation[] = [];
    for (const g of places) {
      const c = byPlace.get(g.id);
      if (c) out.set(c, toMatch(g));
      else rest.push(g);
    }
    for (const [c, m] of matchGoogle(rest, near.filter((s) => !out.has(s.c) && !placeOf.has(s.c)))) out.set(c, m);
    return out;
  }
  let googleOn: boolean | null = null;

  async function ensureFile() {
    if (file) return file;
    file = await loadStations();
    loadFailed = !file;
    if (file) {
      links = await stationPlaces();
      placeOf = links.place;
      ncache = await getMeta<NCache>(N_KEY, {});
      await restoreGoogle();
    }
    return file;
  }

  /*
   * Cache do Google no aparelho só até o fim do dia: cada área (e cada posto procurado) é buscada uma vez por
   * dia, e o que o Google devolveu não fica guardado de um dia para o outro (só o place_id pode ficar).
   */
  const G_KEY = 'google_cache_v3';
  const fresh = (at: number) => at >= new Date().setHours(0, 0, 0, 0);
  type GCache = Record<string, { at: number; places: GoogleStation[] }>;
  let gcache: GCache | null = null;
  /** Busca por perto e por texto bloqueada (cota do app ou do Google); a nota pelo id e as fotos têm a própria. */
  let gBlocked = '';
  let lugarBlocked = false;
  let photoBlocked = false;
  async function gGet(key: string): Promise<GoogleStation[] | null> {
    gcache ??= await getMeta<GCache>(G_KEY, {});
    const e = gcache[key];
    return e && fresh(e.at) ? e.places : null;
  }
  async function gPut(key: string, places: GoogleStation[]) {
    gcache ??= await getMeta<GCache>(G_KEY, {});
    gcache[key] = { at: Date.now(), places };
    const keys = Object.keys(gcache).filter((k) => fresh(gcache![k].at)).sort((a, b) => gcache![b].at - gcache![a].at);
    gcache = Object.fromEntries(keys.slice(0, 80).map((k) => [k, gcache![k]]));
    await setMeta(G_KEY, gcache);
  }
  /** Ao abrir o app, religa o que já foi buscado no Google (sem nova consulta). */
  async function restoreGoogle() {
    gcache ??= await getMeta<GCache>(G_KEY, {});
    const all = Object.values(gcache).filter((e) => fresh(e.at)).flatMap((e) => e.places);
    if (!all.length || !file) return;
    googleOn = true;
    const ids = new Set(all.map((g) => g.id));
    void ids;
    // casa só com postos perto de algum lugar do Google (rápido mesmo com 2 mil postos)
    const near = file.postos.filter((s) => all.some((g) => Math.abs(g.lat - s.la) < 0.03 && Math.abs(g.lon - s.lo) < 0.03));
    addMatches(linkPlaces(all, near));
  }
  async function gError(e: unknown, kind: 'busca' | 'lugar' | 'foto' = 'busca') {
    const res = (e as { context?: Response })?.context;
    if (res?.status === 429) {
      if (kind === 'lugar') lugarBlocked = true;
      else if (kind === 'foto') photoBlocked = true;
      else {
        try { gBlocked = (await res.json()).error; } catch { gBlocked = 'Limite diário do Google atingido.'; }
        render();
      }
    } else console.warn('google', e);
  }

  async function fetchGoogle(center: LatLon, radiusKm: number) {
    if (googleOn === false || gBlocked || !file) return;
    const small = radiusKm <= 1.5;
    const step = small ? 0.01 : 0.02;
    const snap = { lat: Math.round(center.lat / step) * step, lon: Math.round(center.lon / step) * step };
    const r = small ? 1.5 : radiusKm <= 4 ? 4 : radiusKm <= 7 ? 7 : 10;
    const key = 'nearby:' + snap.lat.toFixed(2) + ',' + snap.lon.toFixed(2) + ',' + r;
    if (googleDone.has(key)) return;
    googleDone.add(key);
    let places = await gGet(key);
    if (places) googleOn = true;
    else {
      if (navigator.onLine === false || !(await currentSession())) return;
      try {
        const res = await googlePlaces<GoogleStation>({ mode: 'nearby', lat: snap.lat, lon: snap.lon, radius_m: small ? 1600 : Math.round((r * 1000) / 1.3) });
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
    addMatches(linkPlaces(places, near));
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

  /*
   * Caminho até um destino: sai de onde a pessoa está agora até um endereço escolhido e mostra os postos
   * no caminho. Fica só na memória do app (o destino não é guardado nem vai para a conta).
   */
  let viagem: { label: string; r: Route } | null = null;
  let viagemDetour = 1000;
  let tracing = false;
  const detourM = () => (base === 'viagem' ? viagemDetour : rota()?.detour_m ?? 1000);
  async function startTrip(p: FoundPlace) {
    base = 'viagem';
    kindChosen = true;
    showAll = false;
    tracing = true;
    render();
    try {
      const from = here && Date.now() - here.at < 10 * 60000 ? here.p : await gps();
      here = { p: from, at: Date.now() };
      viagem = { label: p.label, r: await route(from, p) };
      mapKey = '';
    } catch (e) {
      toast((e as Error).message);
    } finally {
      tracing = false;
      render();
    }
  }

  type Resolved = { base: Base; where: string; center: LatLon } | { need: 'gps' | 'casa' | 'trabalho' | 'rota' | 'viagem'; where: string };
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
    if (kind === 'viagem') {
      if (!viagem) return { need: 'viagem', where: 'Caminho até um destino' };
      const path = viagem.r.pts.map(([lat, lon]) => ({ lat, lon }));
      return { base: { kind: 'rota', path, detourKm: viagemDetour / 1000, roads: viagem.r.roads }, where: 'Até ' + viagem.label + ' · ' + fmt(viagem.r.km, 1) + ' km', center: path[Math.floor(path.length / 2)] };
    }
    const r = rota();
    if (!r || !r.on || r.pts.length < 2) return { need: 'rota', where: 'No caminho casa → trabalho' };
    const path = r.pts.map(([lat, lon]) => ({ lat, lon }));
    return { base: { kind: 'rota', path, detourKm: r.detour_m / 1000, roads: r.roads }, where: 'Casa → trabalho · ' + fmt(r.km, 1) + ' km', center: path[Math.floor(path.length / 2)] };
  }

  const own = (): OwnPrice[] => [
    ...S.logs.filter((f) => f.station_id && (f.fuel === 'gasolina' || f.fuel === 'etanol')).map((f) => ({ station_id: f.station_id!, fuel: f.fuel as Fuel, price: f.price_per_l || f.total_brl / f.liters, date: f.date })),
    ...reportedAsOwn(),
  ];
  const usage = (): StationUse[] => stationUsage(carLogs(), carIntervals(), todayISO());
  /** O que você mesmo viveu em cada posto: suas estrelas (12 meses), falhas relatadas (6 meses) e o rendimento dos seus tanques. */
  function mine(): Map<string, Personal> {
    const today = todayISO();
    const m = new Map<string, Personal & { sum: number }>();
    const get = (c: string) => m.get(c) ?? (m.set(c, { stars: null, starsN: 0, falhou: 0, yieldR: null, sum: 0 }), m.get(c)!);
    const logs = new Map(S.logs.map((f) => [f.id, f]));
    for (const r of Object.values(S.ratings)) {
      const f = logs.get(r.fuel_log_id);
      if (!f || f.deleted_at || !r.station_id) continue;
      const age = ageDays(f.date, today);
      const p = get(r.station_id);
      if (r.stars && age <= 365) { p.sum += r.stars; p.starsN++; p.stars = p.sum / p.starsN; }
      if (r.after_effect === 'falhou' && age <= 180) p.falhou++;
    }
    for (const u of usage()) if (u.tanks >= 2 && u.delta != null) get(u.station_id).yieldR = 1 + u.delta;
    return new Map([...m].map(([k, { sum: _s, ...v }]) => [k, v]));
  }

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
    const all = stationsFor(stations(), b, model(), own(), todayISO(), NO_G, network(), mine());
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
    const txt = pp.src === 'voce' ? (pp.seen ? 'você viu ' + ago(pp.date, today) : 'seu abastecimento ' + deDia(pp.date, today)) : (pp.src === 'rede' ? (pp.seen ? 'informado' : 'rede') : 'ANP') + ' · ' + (pp.src === 'anp' ? dm(pp.date) : ago(pp.date, today));
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

  /** Visual novo: o preço como placa de posto e o selo de confiança (só aparecem com a classe v2). */
  function totem(o: { fuel: Fuel; price: PricePoint }) {
    return '<span class="rec-totem only-v2"><em><i class="dot ' + (o.fuel === 'gasolina' ? 'gas' : 'eth') + '"></i>' + FUEL[o.fuel].toUpperCase() + '</em><b>' + fmt(o.price.price, 2) + '</b></span>';
  }
  function selo(r: StationRow['rel']) {
    return '<span class="rec-selo only-v2 ' + r.level + '">' + SHIELD + fmt(r.score, 1) + '</span>';
  }
  /** Visual novo, fora do cartão clássico: placa do preço e selo de confiança sem as classes de alternância. */
  function totemTag(o: { fuel: Fuel; price: PricePoint }) {
    return '<span class="totem2"><em><i class="dot ' + (o.fuel === 'gasolina' ? 'gas' : 'eth') + '"></i>' + FUEL[o.fuel].toUpperCase() + '</em><b>' + fmt(o.price.price, 2) + '</b></span>';
  }
  function seloTag(r: StationRow['rel']) {
    return '<span class="selo2 ' + r.level + '">' + SHIELD + fmt(r.score, 1) + '</span>';
  }
  /** Idade do preço em poucas palavras: "preço de hoje", "preço há 3 dias", "ANP 14/10". */
  function priceShort(pp: PricePoint) {
    if (pp.src === 'anp') return 'ANP ' + dm(pp.date);
    const d = ago(pp.date, todayISO());
    return 'preço ' + (d === 'hoje' || d === 'ontem' ? 'de ' + d : d);
  }

  function recCard(kind: BaseKind, rec: Recommendation, b: Base) {
    const car = carInfo();
    const best = rec.best!;
    const dist = b.kind === 'rota' ? (best.distKm < 0.15 ? 'no caminho' : '+' + kmTxt(best.extraKm) + ' de desvio') : kmTxt(best.distKm);
    // o outro combustível só aparece como comparação quando de fato sai mais caro
    const other = rec.bestOther && rec.bestOther.cost - best.cost >= 0.5 ? rec.bestOther : null;
    const tiles = other
      ? '<div class="rec-tiles"><div><span>Custo por km</span><b>' + brl(best.costPerKm) + '</b></div><div><span>vs. ' + FUEL[other.fuel].toLowerCase() + ' mais em conta</span><b class="up">−' + brl(other.cost - best.cost) + '</b></div></div>'
      : '<div class="rec-tiles"><div><span>Custo por km</span><b>' + brl(best.costPerKm) + '</b></div><div><span>Para rodar ' + Math.round(car.model.kmTank) + ' km</span><b>' + brl(best.cost) + '</b></div></div>';
    const foot = [
      car.model.fuels.length > 1 ? 'Etanol rende ' + Math.round((car.model.kmlE / car.model.kmlG) * 100) + '% da gasolina no ' + esc(car.name) + (car.model.measured ? ' (medido)' : ' (estimado)') : '',
      best.yieldR != null ? (best.yieldSrc === 'voce' ? 'já conta o rendimento dos seus tanques de lá' : 'já conta o rendimento medido do posto') : '',
      'conta ida e volta',
    ].filter(Boolean).join(' · ');
    const cheap = cheapNote(rec, car.model.kmTank);
    const warn = rec.cheaperUnsafe
      ? '<p class="rec-warn">' + ICON.warn + '<span>' + esc(nm(rec.cheaperUnsafe.s)) + ' sairia mais barato, mas ficou de fora: ' + (rec.cheaperUnsafe.rel.recentSerious ? 'teve autuação séria da ANP nos últimos 12 meses.' : 'confiabilidade baixa.') + '</span></p>'
      : '';
    return (
      '<button type="button" class="rec-card" data-posto="' + best.s.c + '"><span class="l">' + REC_LABEL[kind] + '</span>' + selo(best.rel) +
      '<span class="t"><span class="only-v1">' + FUEL[best.fuel] + ' no </span>' + esc(nm(best.s)) + '</span>' + totem(best) +
      '<span class="s"><span class="only-v1">' + brl(best.price.price) + '/l · </span>' + dist + ' · ' + priceWho(best.price) + '</span>' +
      (netBadges(best.s.c ? network().get(best.s.c) ?? null : null) ? '<span class="rec-badges">' + netBadges(network().get(best.s.c) ?? null, 3) + '</span>' : '') +
      tiles + '<span class="f">' + foot + '</span></button>' + cheap + warn
    );
  }
  /** Quando o mais barato não é o sugerido: mostra o menor preço e por que ficou atrás. */
  function cheapNote(rec: Recommendation, kmTank: number, short = false) {
    const c = rec.cheapest, b = rec.best;
    if (!c || !b || c.s.c === b.s.c) return '';
    const save = b.cost - c.cost;
    const weak = weakPoints(c, todayISO());
    const why = weak.length ? weak.slice(0, 3).join(' · ') : 'nota ' + fmt(c.quality, 1) + ' contra ' + fmt(b.quality, 1) + ' do sugerido';
    if (short) return 'Menor preço: ' + nm(c.s) + ' (' + FUEL[c.fuel].toLowerCase() + ' a ' + brl(c.price.price) + ', ≈ ' + brl(save) + ' a menos) · ' + why + '.';
    return (
      '<button type="button" class="rec-cheap" data-posto="' + c.s.c + '"><span class="tag cheap">Menor preço</span>' +
      '<span class="t">' + FUEL[c.fuel] + ' no ' + esc(nm(c.s)) + ' · ' + brl(c.price.price) + '/l</span>' +
      '<span class="s">' + (save >= 0.5 ? '≈ ' + brl(save) + ' a menos para rodar ' + Math.round(kmTank) + ' km, mas ' : 'Quase o mesmo custo, mas ') + esc(why) + '.</span></button>'
    );
  }
  function priceWho(pp: PricePoint) {
    const today = todayISO();
    if (pp.src === 'rede') return (pp.seen ? 'preço informado ' : 'preço da rede ') + ago(pp.date, today);
    if (pp.src === 'voce') return pp.seen ? 'preço que você viu ' + ago(pp.date, today) : 'preço do seu abastecimento ' + deDia(pp.date, today);
    return 'ANP ' + dm(pp.date);
  }

  /** Visual novo: onde sai mais barato encher, numa linha no topo da lista (só com casa, trabalho ou caminho). */
  function compareStrip(kind: BaseKind) {
    const opts: [BaseKind, string][] = [];
    if (place('casa')) opts.push(['casa', 'Casa']);
    if (place('trabalho')) opts.push(['trabalho', 'Trabalho']);
    const r = rota();
    if (r?.on && r.pts.length > 1) opts.push(['rota', 'Caminho']);
    if (opts.length < 2) return '';
    const res = opts.map(([k, label]) => {
      const rs = resolve(k);
      return { k, label, best: 'base' in rs ? compute(rs.base).rec.best : null };
    });
    const valid = res.filter((x) => x.best);
    if (valid.length < 2) return '';
    const min = Math.min(...valid.map((x) => x.best!.cost));
    return '<div class="cmp2" aria-label="Onde sai mais barato encher"><span class="cmp2-l">Tanque de ' + Math.round(carInfo().model.kmTank) + ' km</span>' +
      res.map((x) => {
        if (!x.best) return '<button type="button" class="cmp-cell c2" data-base="' + x.k + '">' + x.label + ' <b>–</b></button>';
        const win = x.best.cost === min;
        return '<button type="button" class="cmp-cell c2' + (win ? ' win' : '') + (x.k === kind ? ' cur' : '') + '" data-base="' + x.k + '" aria-pressed="' + (x.k === kind) + '">' + x.label + ' <b>' + (win ? 'R$ ' + Math.round(x.best.cost) : '+R$ ' + Math.round(x.best.cost - min)) + '</b></button>';
      }).join('') + '</div>';
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
    if (need === 'viagem' || need === 'rota')
      return '<div class="card center"><p class="hint">' + (tracing ? 'Traçando o caminho de onde você está até o destino…' : need === 'viagem'
        ? 'Escolha para onde vai: o app traça o caminho de onde você está até lá e mostra os postos no caminho.'
        : 'Escolha um destino para ver os postos no caminho de onde você está até lá, ou cadastre casa e trabalho para o caminho de todo dia.') + '</p>' +
        '<div class="btn-row"><button type="button" class="btn primary" data-act="destino"' + (tracing ? ' disabled' : '') + '>' + PIN + 'Escolher destino</button>' + (need === 'rota' ? '<a class="btn" href="#/locais">Casa e trabalho</a>' : '') + '</div></div>';
    const txt = need === 'rota'
      ? 'Cadastre casa e trabalho e ligue “Postos no caminho” para ver os postos do seu trajeto.'
      : 'Cadastre ' + (need === 'casa' ? 'o endereço de casa' : 'o endereço do trabalho') + ' para comparar os postos de lá.';
    return '<div class="card center"><p class="hint">' + txt + '</p><a class="btn primary" href="#/locais">Cadastrar casa e trabalho</a></div>';
  }

  function stationRow(r: StationRow, b: Base, isBest: boolean, isCheap = false) {
    const fav = favorite();
    const mineTag = (isBest ? '<span class="tag best">sugerido</span> ' : '') + (isCheap ? '<span class="tag cheap">menor preço</span> ' : '') + (fav?.s.c === r.s.c ? '<span class="tag mine">seu posto</span> ' : '');
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
    return stationsFor([s], b.kind === 'ponto' ? { ...b, radiusKm: 9999 } : { ...b, detourKm: 9999 }, model(), own(), todayISO(), NO_G, network(), mine())[0];
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
    let dist = '';
    if (isNovo()) {
      // visual novo: o raio (ou o desvio do caminho) vira um chip que alterna entre as opções
      const rs = resolve(base);
      const dm_ = detourM();
      dist = 'base' in rs && rs.base.kind === 'rota'
        ? '<button type="button" class="fchip dist" data-f="desvio" aria-label="Desvio máximo, toque para mudar">' + (dm_ < 1000 ? dm_ + ' m' : dm_ / 1000 + ' km') + ' de desvio</button>'
        : '<button type="button" class="fchip dist" data-f="raio" aria-label="Distância, toque para mudar">' + radius + ' km</button>';
    }
    const lupa = isNovo() ? '<button type="button" class="fchip lupa" data-f="busca" aria-pressed="' + searching + '" aria-label="Procurar posto pelo nome ou rua">' + LUPA + '</button>' : '';
    $('p-filters').innerHTML = lupa + fuelChips + chip('ok', filters.ok, 'Só confiáveis') + dist + chip('recent', filters.recent, 'Preço até 7 dias') + chip('bath', filters.bath, 'Banheiro bom');
  }

  function render() {
    if (currentRoute().view !== 'postos') return;
    document.querySelectorAll<HTMLElement>('#p-base button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.base === base || (b.dataset.base === 'rota' && base === 'viagem'))));
    renderFilters();
    const rs = resolve(base);
    const right = 'base' in rs && rs.base.kind === 'rota'
      ? '<span class="mini-seg">' + DETOURS.map((d) => '<button type="button" data-detour="' + d + '" aria-pressed="' + (detourM() === d) + '">' + (d < 1000 ? d + ' m' : d / 1000 + ' km') + '</button>').join('') + '</span>'
      : '<span class="mini-seg">' + RADII.map((r) => '<button type="button" data-radius="' + r + '" aria-pressed="' + (radius === r) + '">' + r + ' km</button>').join('') + '</span>';
    if (isNovo() && searching) {
      // o campo não é redesenhado enquanto a pessoa digita
      if (!document.getElementById('p-q')) {
        $('p-where').innerHTML = '<div class="q2">' + LUPA + '<input id="p-q" type="search" placeholder="Nome do posto, rua ou bairro" autocomplete="off" enterkeyhint="search" aria-label="Procurar posto pelo nome, rua ou bairro"><button type="button" data-q-close aria-label="Fechar a busca">' + XS + '</button></div>';
        ($('p-q') as HTMLInputElement).value = query;
      }
    } else $('p-where').innerHTML = isNovo()
      ? '<button type="button" class="w w2" data-local>' + PIN + '<span>' + esc(rs.where) + '</span><em>Trocar</em></button>'
      : '<span class="w">' + PIN + '<span>' + esc(rs.where) + '</span></span>' + right;
    const body = $('p-body');
    if (!file) {
      $('p-map-wrap').hidden = true;
      body.innerHTML = loadFailed
        ? '<div class="card center"><p class="hint">Não consegui carregar a lista de postos. Na primeira vez é preciso internet; depois ela fica no celular.</p><button type="button" class="btn" data-act="retry">Tentar de novo</button></div>'
        : '<div class="empty">Carregando postos…</div>';
      return;
    }
    if ('need' in rs) {
      $('p-map-wrap').hidden = true;
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
    if (isNovo()) {
      const busca = searching && norm(query).length >= 2;
      body.innerHTML = busca ? searchBody(rs, rec) : bodyNovo(rs.base, rows, rec, sorted, limit);
      drawMap(rs, rows, rec);
      const shownIds = [...(rec.best ? [rec.best.s.c] : []), ...(rec.cheapest ? [rec.cheapest.s.c] : []), ...sorted.map((r) => r.s.c)].slice(0, Math.min(limit, 20));
      nameRows(busca ? searchRows(rs).slice(0, 12) : shownIds.map((c) => rows.find((r) => r.s.c === c)).filter((r): r is StationRow => !!r));
      return;
    }
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
      html += '<div class="list-card">' + sorted.slice(0, limit).map((r) => stationRow(r, rs.base, r.s.c === rec.best?.s.c, r.s.c === rec.cheapest?.s.c)).join('') + (sorted.length > limit ? '<button type="button" class="list-more" data-act="all">Mostrar todos (' + sorted.length + ')</button>' : '') + '</div>';
    }
    body.innerHTML = html + sourcesNote();
    drawMap(rs, rows, rec);
  }

  /** Visual novo: a lista é a folha que sobe do mapa; sugerido e menor preço no topo, cartões de um preço. */
  function bodyNovo(b: Base, rows: StationRow[], rec: Recommendation, sorted: StationRow[], limit: number) {
    const active = filters.ok || filters.recent || filters.bath;
    if (!rows.length) {
      return '<div class="card center"><p class="hint">' + (active ? 'Nenhum posto passa nos filtros. Tire um filtro ou aumente a distância.' : 'Nenhum posto ' + (b.kind === 'rota' ? 'tão perto do caminho' : 'neste raio') + '. Aumente a distância.') + '</p></div>' + compareCard(base);
    }
    const bestId = rec.best?.s.c;
    const cheapId = rec.cheapest && rec.cheapest.s.c !== bestId ? rec.cheapest.s.c : undefined;
    const top = [bestId, cheapId].map((c) => (c ? rows.find((r) => r.s.c === c) : undefined)).filter((r): r is StationRow => !!r);
    const list = [...top, ...sorted.filter((r) => r.s.c !== bestId && r.s.c !== cheapId)];
    let html = compareStrip(base) + (rec.best ? '' : noPriceCard(rows, b));
    const why = '<details class="why2s"><summary>' + INFO + 'Por que este é o sugerido</summary>' + sourcesNote() + '</details>';
    html += '<div class="st2-list">' + list.slice(0, limit).map((r) => row2(r, b, rec, r.s.c === bestId, r.s.c === cheapId) + (r.s.c === bestId ? why : '')).join('') +
      (list.length > limit ? '<button type="button" class="list-more" data-act="all">Mostrar todos (' + list.length + ')</button>' : '') + '</div>';
    if (rec.cheaperUnsafe) html += '<p class="rec-warn">' + ICON.warn + '<span>' + esc(nm(rec.cheaperUnsafe.s)) + ' sairia mais barato, mas ficou de fora: ' + (rec.cheaperUnsafe.rel.recentSerious ? 'autuação séria da ANP nos últimos 12 meses.' : 'confiabilidade baixa.') + '</span></p>';
    return html;
  }
  function row2(r: StationRow, b: Base, rec: Recommendation, isBest: boolean, isCheap: boolean) {
    const o = isBest ? rec.best! : isCheap ? rec.cheapest! : r.best;
    const lvl = r.rel.level;
    const sl = lvl === 'ok'
      ? '<span class="sl ok">' + SHIELD14 + fmt(r.rel.score, 1) + '</span>'
      : '<span class="sl ' + lvl + '">' + fmt(r.rel.score, 1) + (lvl === 'atencao' ? ' atenção' : r.rel.recentSerious ? ' ocorrência' : ' evitar') + '</span>';
    let extra = '';
    if (isCheap) extra = weakPoints(rec.cheapest!, todayISO())[0] ?? 'nota menor que o sugerido';
    else if (favorite()?.s.c === r.s.c) extra = 'seu posto';
    else {
      const y = yieldOf(r.live);
      extra = y != null ? 'rende ' + Math.round((r.live!.yield!.r ?? y) * 100) + '%' : o ? priceShort(o.price) : '';
    }
    const tag = isBest ? '<span class="t2 best">Sugerido</span>' : isCheap ? '<span class="t2 cheap">Menor preço</span>' : '';
    const price = o
      ? '<span class="pr' + (isCheap ? ' cheap' : '') + (o.stale ? ' old' : '') + '"><i class="dot ' + (o.fuel === 'gasolina' ? 'gas' : 'eth') + '"></i>' + fmt(o.price.price, 2) + '</span>'
      : '<span class="pr none">sem preço</span>';
    return '<button type="button" class="st2' + (isBest ? ' best' : '') + '" data-posto="' + r.s.c + '"><span class="nm">' + brandBadge(r.s.b, 24) + tag + '<b>' + esc(nm(r.s)) + '</b></span>' + price +
      '<span class="sb">' + sl + '<span>· ' + esc(distTxt(r, b)) + (extra ? ' · ' + esc(extra) : '') + '</span></span></button>';
  }

  /* ---------- busca pelo nome do posto ---------- */
  let searching = false;
  let query = '';
  const norm = (t: string) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  /** Postos até 25 km do lugar escolhido cujo nome (Google ou ANP), rua, bairro ou bandeira têm todas as palavras digitadas. */
  function searchRows(rs: Resolved): StationRow[] {
    const words = norm(query).split(/\s+/).filter((w) => w.length >= 2);
    if (!words.length || !('center' in rs)) return [];
    const at = rs.center;
    const bb = bboxAround(at, 25);
    const cands = stations().filter((s) => s.la > bb.s && s.la < bb.n && s.lo > bb.w && s.lo < bb.e && words.every((w) => norm(nm(s) + ' ' + s.n + ' ' + s.e + ' ' + s.br + ' ' + s.m + ' ' + s.b).includes(w)));
    return stationsFor(cands, { kind: 'ponto', at, radiusKm: 25 }, model(), own(), todayISO(), NO_G, network(), mine()).sort((a, b) => a.distKm - b.distKm).slice(0, 30);
  }
  function searchBody(rs: Resolved, rec: Recommendation) {
    const found = searchRows(rs);
    const b: Base = 'base' in rs ? rs.base : { kind: 'ponto', at: here?.p ?? { lat: 0, lon: 0 }, radiusKm: 25 };
    const g = gBlocked || googleOn === false ? '' : '<button type="button" class="list-more" data-act="gsearch">' + (found.length ? 'Não é nenhum desses? Procurar no Google' : 'Procurar “' + esc(query.trim()) + '” no Google') + '</button>';
    return (found.length
      ? '<div class="st2-list">' + found.map((r) => row2(r, b, rec, false, false)).join('') + '</div>'
      : '<div class="card center"><p class="hint">Nenhum posto com esse nome por perto. O nome na fachada pode ser diferente do cadastro: tente a rua ou o bairro.</p></div>') + g;
  }
  /** Procura no Google o que foi digitado e liga os resultados aos postos da ANP (nome e ponto exatos). */
  async function googleSearch() {
    const rs = resolve(base);
    if (!('center' in rs) || !file) return;
    if (!(await currentSession())) return toast('Entre na conta (Perfil) para procurar no Google.');
    const at = rs.center;
    const q = query.trim();
    const key = 'busca:' + norm(q) + ':' + at.lat.toFixed(2) + ',' + at.lon.toFixed(2);
    let places = await gGet(key);
    if (!places) {
      try {
        const res = await googlePlaces<GoogleStation>({ mode: 'posto', query: q + ' posto de combustível', lat: at.lat, lon: at.lon });
        googleOn = res.configured;
        if (!res.configured) return;
        places = res.places;
        await gPut(key, places);
      } catch (e) {
        return gError(e);
      }
    }
    const got = places;
    const near = file.postos.filter((s) => got.some((g) => Math.abs(g.lat - s.la) < 0.02 && Math.abs(g.lon - s.lo) < 0.02));
    const m = linkPlaces(got, near);
    addMatches(m);
    if (!m.size) toast('O Google não achou um posto da lista da ANP com esse nome por perto.');
    render();
  }

  /* ---------- nomes do Google na lista ---------- */
  // Os postos da lista que ainda estão com o nome da ANP ganham o nome do Google: uma busca por perto de cada
  // grupo sem nome (no máximo 3 por vez; cada área fica guardada por uma semana no aparelho).
  const nameTried = new Set<string>();
  let naming = false;
  async function nameRows(rows: StationRow[]) {
    if (naming || googleOn === false || gBlocked || !file) return;
    naming = true;
    try {
      for (let i = 0; i < 3; i++) {
        const miss = rows.find((r) => !gmatch.has(r.s.c) && !nameTried.has(r.s.c));
        if (!miss) break;
        const at = { lat: miss.s.la, lon: miss.s.lo };
        for (const r of rows) if (haversineKm(at, { lat: r.s.la, lon: r.s.lo }) < 1.1) nameTried.add(r.s.c);
        await fetchGoogle(at, 1.5);
      }
    } finally {
      naming = false;
    }
  }

  function sourcesNote() {
    if (!file) return '';
    const w = file.fontes.lpc_semanas[0];
    const g = gBlocked ? esc(gBlocked) + ' Os nomes já buscados hoje continuam valendo.' : googleOn === true ? 'Nomes e fotos do Google buscados uma vez por dia; a nota do Google aparece na ficha de cada posto.' : googleOn === false ? 'Google ainda não configurado.' : '';
    return '<p class="foot-note">Preços: o que a rede pagou nos últimos 7 dias, os seus abastecimentos e a pesquisa semanal da ANP' + (w ? ' (mais recente: ' + dm(w[0]) + ' a ' + dm(w[1]) + ')' : '') + '. Sugerido: o menor custo para rodar (preço, combustível, desvio e rendimento medido), pesado pela confiabilidade (fiscalização da ANP nos últimos 5 anos, avaliações da rede e as suas) e pela idade do preço; o menor preço aparece à parte. ' + g + ' Distâncias aproximadas.</p>';
  }

  const folha = initFolha($('p-sheet'), $('p-grab'), $('p-body'), () => {
    if (!lastMap || currentRoute().view !== 'postos') return;
    mapKey = '';
    drawMap(lastMap.rs, lastMap.rows, lastMap.rec);
  });

  /* ---------- mapa da aba ---------- */
  let L: typeof import('leaflet') | null = null;
  let pmap: import('leaflet').Map | null = null;
  let layer: import('leaflet').LayerGroup | null = null;
  let mapKey = '';
  async function loadLeaflet() {
    if (!L) [L] = await Promise.all([import('leaflet'), import('leaflet/dist/leaflet.css')]);
    return L;
  }
  // Sem escolha da pessoa, o mapa abre em Avaliação; só abre em Preço quando há preços recentes para comparar
  let mapChoice: MapMode | null = null;
  let mapMode: MapMode = 'avaliacao';
  const autoMode = (rows: StationRow[]): MapMode => (rows.filter((r) => r.best && !r.best.stale).length >= 3 ? 'preco' : 'avaliacao');
  let lastMap: { rs: Extract<Resolved, { base: Base }>; rows: StationRow[]; rec: Recommendation } | null = null;

  async function drawMap(rs: Extract<Resolved, { base: Base }>, rows: StationRow[], rec: Recommendation, refit = true) {
    lastMap = { rs, rows, rec };
    mapMode = mapChoice ?? autoMode(rows);
    const wrap = $('p-map-wrap');
    wrap.hidden = false;
    const el = $('p-map');
    document.querySelectorAll<HTMLElement>('#p-map-mode [data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mapMode)));
    const Lf = await loadLeaflet();
    if (currentRoute().view !== 'postos') return;
    if (!pmap) {
      pmap = Lf.map(el, { zoomControl: false, attributionControl: true, scrollWheelZoom: mouse(), zoomAnimation: false, fadeAnimation: false, markerZoomAnimation: false });
      if (mouse()) Lf.control.zoom({ position: 'bottomright', zoomInTitle: 'Aproximar', zoomOutTitle: 'Afastar' }).addTo(pmap);
      pmap.attributionControl.setPrefix(false);
      Lf.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(pmap);
      layer = Lf.layerGroup().addTo(pmap);
      // ao aproximar ou afastar, refaz as etiquetas sem mexer no enquadramento
      pmap.on('zoomend', () => lastMap && drawMap(lastMap.rs, lastMap.rows, lastMap.rec, false));
    }
    pmap.invalidateSize();
    layer!.clearLayers();
    const pts: [number, number][] = [];
    if (rs.base.kind === 'rota') {
      const line = rs.base.path.map((p) => [p.lat, p.lon] as [number, number]);
      Lf.polyline(line, { color: isNovo() ? '#1E7A4E' : '#1D4ED8', weight: 4, opacity: 0.7 }).addTo(layer!);
      pts.push(...line);
    } else {
      if (isNovo()) Lf.circleMarker([rs.center.lat, rs.center.lon], { radius: 16, stroke: false, fillColor: '#1E7A4E', fillOpacity: 0.18, interactive: false }).addTo(layer!);
      Lf.circleMarker([rs.center.lat, rs.center.lon], { radius: 7, color: '#FFFFFF', weight: 3, fillColor: isNovo() ? '#1E7A4E' : '#1D4ED8', fillOpacity: 1 }).addTo(layer!);
      pts.push([rs.center.lat, rs.center.lon]);
    }
    // principais opções ao redor; a sugerida fica em destaque, por cima das outras
    const bestId = rec.best?.s.c;
    const cheapId = rec.cheapest && rec.cheapest.s.c !== bestId ? rec.cheapest.s.c : null;
    const picks = mapPicks(rows, mapMode, bestId);
    const cheapRow = cheapId ? rows.find((r) => r.s.c === cheapId) : undefined;
    if (cheapRow && !picks.includes(cheapRow)) picks.push(cheapRow);
    for (const r of picks) pts.push([r.s.la, r.s.lo]);
    const key = base + '|' + radius + '|' + rows.length + '|' + mapMode;
    if (refit && key !== mapKey && pts.length) {
      mapKey = key;
      // no visual novo a folha cobre a parte de baixo do mapa: enquadra os postos na parte visível
      const pad = isNovo() ? { paddingTopLeft: [24, 120] as [number, number], paddingBottomRight: [24, folha.cover() + 24] as [number, number] } : {};
      if (pts.length === 1) pmap.setView(pts[0], 14);
      else pmap.fitBounds(Lf.latLngBounds(pts).pad(isNovo() ? 0 : 0.1), pad);
    }
    // sem etiquetas encavaladas: a sugerida primeiro, depois na ordem da lista; aproximar mostra as escondidas
    const placed: { x: number; y: number }[] = [];
    let hidden = 0, staleShown = false;
    const rank = (r: StationRow) => (r.s.c === bestId ? 2 : r.s.c === cheapId ? 1 : 0);
    const order = picks.slice().sort((a, b) => rank(b) - rank(a));
    for (const r of order) {
      const pt = pmap.latLngToContainerPoint([r.s.la, r.s.lo]);
      if (placed.some((q) => Math.abs(q.x - pt.x) < 58 && Math.abs(q.y - pt.y) < 28)) { hidden++; continue; }
      placed.push({ x: pt.x, y: pt.y });
      if (mapMode === 'preco' && r.s.c !== bestId && r.best?.stale) staleShown = true;
      const best = r.s.c === bestId;
      const lvl = r.rel.level;
      let cls = 'pin';
      let label: string;
      const cheap = r.s.c === cheapId;
      if (mapMode === 'preco') {
        const o = best ? rec.best! : cheap ? rec.cheapest! : r.best!;
        cls += ' ' + (o.fuel === 'etanol' ? 'eth' : 'gas') + (o.stale ? ' old' : '') + (lvl === 'evitar' ? ' bad' : '');
        label = fmt(o.price.price, 2);
      } else {
        cls += ' nota nv-' + lvl;
        label = '★ ' + fmt(r.rel.score, 1);
      }
      if (best) cls += ' best';
      if (cheap) cls += ' cheap';
      const icon = Lf.divIcon({ className: cls, html: '<span>' + (best ? '<em>sugerido</em>' : cheap ? '<em>menor preço</em>' : '') + label + '</span>', iconSize: undefined as any, iconAnchor: [20, 14] });
      Lf.marker([r.s.la, r.s.lo], { icon, title: nm(r.s), keyboard: false, zIndexOffset: best ? 1000 : cheap ? 900 : 0 }).on('click', () => openPosto(r.s.c)).addTo(layer!);
    }
    const stale = staleShown;
    $('p-map-legend').textContent = !picks.length
      ? mapMode === 'preco' ? 'Nenhum posto daqui tem preço. Veja por avaliação.' : ''
      : (mapMode === 'preco'
        ? pl(picks.length, 'opção mais em conta', 'opções mais em conta') + (stale ? ' · em cinza, preço com mais de 30 dias' : '')
        : pl(picks.length, 'posto mais confiável', 'postos mais confiáveis') + ' · ANP e rede') + (hidden ? ' · aproxime para ver ' + (hidden === 1 ? 'mais 1' : 'mais ' + hidden) : '') + ' · toque para abrir';
  }
  $('p-map-mode').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-mode]');
    if (!b || b.dataset.mode === mapMode) return;
    mapChoice = b.dataset.mode as MapMode; // vale enquanto o app está aberto
    if (lastMap) drawMap(lastMap.rs, lastMap.rows, lastMap.rec);
  });

  $('p-base').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-base]');
    if (!b) return;
    base = b.dataset.base as BaseKind;
    // "Caminho": o destino escolhido agora vale antes do caminho casa → trabalho; sem nenhum, pede o destino
    if (base === 'rota' && (viagem || !(rota()?.on && (rota()?.pts.length ?? 0) > 1))) base = 'viagem';
    showAll = false;
    if (base === 'agora' && !here) return locate();
    render();
    if (base === 'viagem' && !viagem && !tracing) openLocal(true);
  });
  $('p-filters').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-f]');
    if (!b) return;
    const f = b.dataset.f!;
    if (f === 'gasolina' || f === 'etanol') filters.fuel = filters.fuel === f ? 'auto' : f;
    else if (f === 'ok') filters.ok = !filters.ok;
    else if (f === 'recent') filters.recent = !filters.recent;
    else if (f === 'bath') filters.bath = !filters.bath;
    else if (f === 'busca') {
      searching = !searching;
      if (!searching) query = '';
      render();
      if (searching) { folha.set('aberta'); setTimeout(() => document.getElementById('p-q')?.focus(), 60); }
      return;
    }
    else if (f === 'raio') { radius = RADII[(RADII.indexOf(radius) + 1) % RADII.length]; mapKey = ''; return render(); }
    else if (f === 'desvio') {
      const cur = detourM();
      if (base === 'viagem') { viagemDetour = DETOURS[(DETOURS.indexOf(cur) + 1) % DETOURS.length]; mapKey = ''; return render(); }
      if (S.places.rota) void setPlace('rota', { label: 'Casa → Trabalho', lat: null, lon: null, data: { ...S.places.rota.data, detour_m: DETOURS[(DETOURS.indexOf(cur) + 1) % DETOURS.length] } });
      return;
    }
    try { localStorage.setItem('postos_filtros', JSON.stringify(filters)); } catch { /* sem acesso */ }
    mapKey = '';
    render();
  });
  $('p-where').addEventListener('click', async (e) => {
    const el = e.target as HTMLElement;
    const r = el.closest<HTMLElement>('[data-radius]');
    const d = el.closest<HTMLElement>('[data-detour]');
    if (el.closest('[data-local]')) return openLocal();
    if (el.closest('[data-q-close]')) { searching = false; query = ''; return render(); }
    if (r) { radius = Number(r.dataset.radius); render(); }
    if (d && base === 'viagem') { viagemDetour = Number(d.dataset.detour); mapKey = ''; return render(); }
    if (d && S.places.rota) await setPlace('rota', { label: 'Casa → Trabalho', lat: null, lon: null, data: { ...S.places.rota.data, detour_m: Number(d.dataset.detour) } });
  });
  $('p-where').addEventListener('input', (e) => {
    const el = e.target as HTMLInputElement;
    if (el.id !== 'p-q') return;
    query = el.value;
    render();
  });
  $('p-body').addEventListener('click', (e) => {
    const el = e.target as HTMLElement;
    const act = el.closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'gsearch') return void googleSearch();
    const posto = el.closest<HTMLElement>('[data-posto]')?.dataset.posto;
    const cmp = el.closest<HTMLElement>('.cmp-cell[data-base]')?.dataset.base;
    if (act === 'gps') return locate();
    if (act === 'outro') return openLocal();
    if (act === 'destino') return openLocal(true);
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
    if (shown?.c !== s.c) reviewsOpen = null;
    shown = s;
    // a ligação mudou (correção, servidor) depois que este posto foi casado: esquece o lugar antigo
    const old = gmatch.get(s.c);
    if (old && placeOf.has(s.c) && placeOf.get(s.c) !== old.id) { gmatch.delete(s.c); google.delete(s.c); adjusted = null; gTried.delete(s.c); }
    renderPosto(s);
    openSheet('posto-sheet');
    const gm = gmatch.get(s.c);
    if (!gm && googleOn !== false && !gTried.has(s.c)) lookupStation(s);
    if (gm) void loadNota(s);
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
      (pp ? (pp.src === 'rede' ? (pp.seen ? 'informado por ' : 'rede · ') + pl(pp.n ?? 1, 'pessoa', 'pessoas') + ' · ' + ago(pp.date, today) : pp.src === 'voce' ? (pp.seen ? 'você viu na bomba ' + ago(pp.date, today) : 'seu último abastecimento aqui, ' + deDia(pp.date, today).replace(/^de /, '')) : 'ANP · pesquisa de ' + dm(pp.date)) + (ageDays(pp.date, today) > 30 ? ' (antigo)' : '') : 'sem preço recente') + '</span></div>';
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
    const stars = starsOf(live);
    const starsLine = stars
      ? '<div class="stars-line"><span class="stars-avg">' + fmt(stars.avg, 1) + '</span><span class="stars-show" aria-hidden="true">' + [1, 2, 3, 4, 5].map((n) => '<i class="' + (stars.avg >= n - 0.25 ? 'on' : stars.avg >= n - 0.75 ? 'half' : '') + '">★</i>').join('') + '</span><span class="hint">' + pl(stars.n, 'nota', 'notas') + ' de quem abasteceu</span></div>'
      : '';
    const dp = rat?.depois;
    const depoisLine = dp
      ? '<div class="rel-part"><div class="h"><span>Depois de abastecer aqui, o carro</span><b>' + Math.round(((dp.normal + dp.melhor) / dp.n) * 100) + '% sem problema</b></div><div class="bar"><i style="width:' + Math.round(((dp.normal + dp.melhor) / dp.n) * 100) + '%"></i></div>' +
        '<span class="hint">' + [pl(dp.n, 'resposta', 'respostas'), dp.melhor ? pl(dp.melhor, 'achou melhor', 'acharam melhor') : '', dp.falhou ? pl(dp.falhou, 'relato de falha', 'relatos de falha') : '', dp.rendeu_menos ? pl(dp.rendeu_menos, 'achou que rendeu menos', 'acharam que rendeu menos') : ''].filter(Boolean).join(' · ') + '</span></div>'
      : '';
    const ratBody = rat && (rat.bomba || rat.atendimento || rat.banheiro || stars || dp)
      ? starsLine + depoisLine + ratLine('bomba', 'Bomba marcou certo', 'sim') + ratLine('atendimento', 'Atendimento', 'bom') + ratLine('banheiro', 'Banheiro', 'bom')
      : '<span class="hint">' + (rat?.n ? pl(rat.n, 'avaliação', 'avaliações') + ' até agora; cada item aparece com 3 respostas.' : 'Ainda sem avaliações. Depois de abastecer aqui, o app pergunta em um toque.') + '</span>';
    const ratCard =
      '<div class="card"><div class="card-head"><span>Quem abasteceu avaliou</span><span class="hint">' + (rat?.n ? pl(rat.n, 'avaliação', 'avaliações') + ' · 6 meses' : '') + '</span></div>' + ratBody +
      '<span class="hint">No Google: ' + (g ? fmt(g.rating, 1) + ' em ' + g.count.toLocaleString('pt-BR') + ' avaliações' : esc(gStatus(s.c, false))) + '</span>' +
      (gm ? '<button type="button" class="link-btn" data-grv style="align-self:flex-start;padding-left:0">' + (reviewsOpen === s.c ? 'Esconder avaliações do Google' : 'Ver avaliações do Google') + '</button>' : '') + '</div>' + reviewsBox(s);

    // Confiabilidade (ANP)
    const lvl = rel.level === 'ok' ? 'Confiável' : rel.level === 'atencao' ? 'Atenção' : 'Evitar';
    const ev = (s.f?.ev ?? []).filter(([d]) => ageDays(d, today) <= 5 * 366);
    const anpTxt = s.f
      ? s.f.n + (s.f.n === 1 ? ' fiscalização' : ' fiscalizações') + ' em 5 anos · ' + (rel.infractions ? pl(rel.infractions, 'infração', 'infrações') : 'nenhuma infração') + (rel.interdictions ? ' · ' + pl(rel.interdictions, 'interdição ou apreensão', 'interdições ou apreensões') : '')
      : 'Sem fiscalização registrada nos últimos 5 anos (nota neutra)';
    const relCard =
      '<div class="card rel"><div class="card-head"><span>Confiabilidade</span><span class="hint">de 0 a 5</span></div>' +
      '<div class="rel-score"><b>' + fmt(rel.score, 1) + '</b><span class="score ' + rel.level + '">' + lvl + '</span></div>' +
      (rel.netWarn ? '<p class="rec-warn">' + ICON.warn + '<span>' + (rel.netWarn === 'rendimento' ? 'Os tanques daqui rendem abaixo do normal para quem usa o app.' : rel.netWarn === 'falhas' ? 'Vários relatos de carro falhando depois de abastecer aqui.' : 'Muita gente disse que a bomba não marcou certo.') + ' A nota fica limitada a “atenção”.</span></p>' : '') +
      '<div class="rel-part"><div class="h"><span>Fiscalização da ANP (5 anos)</span><b>' + fmt(rel.anp, 1) + '</b></div><div class="bar"><i style="width:' + Math.round((rel.anp / 5) * 100) + '%"></i></div><span class="hint">' + esc(anpTxt) + '</span></div>' +
      (ev.length ? '<ul class="ev-list">' + ev.slice(0, 6).map(([d, t, txt]) => '<li><span class="d">' + dm(d) + '/' + d.slice(2, 4) + '</span><span><b>' + EVENT_LABEL[t] + '</b>' + (txt ? ' · ' + esc(txt.replace(/^(Notificação|MRC)\s*-\s*(PR ?Comb\s*-\s*)?/i, '')) : '') + '</span></li>').join('') + '</ul>' : '') +
      '<details class="more"><summary>Como a nota é calculada<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 9l6 6 6-6"/></svg></summary><p class="hint">Começa em 5 e cada ocorrência da ANP nos últimos 5 anos desconta, mais quanto mais recente e mais grave. Infração de bomba, volume ou qualidade nos últimos 12 meses limita a nota em 2,5 e tira o posto da recomendação. A nota do Google aparece à parte e não entra na conta. Rendimento medido abaixo de 95% ou bomba mal avaliada limitam a nota a 3,4. O rendimento medido também entra no custo por km da recomendação.</p></details></div>';

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
    if (isNovo()) {
      // visual novo: cabeçalho verde com selo e as duas placas; rendimento num anel; "de onde vem a nota" em três números
      const lvlTxt = rel.level === 'ok' ? 'confiável' : rel.level === 'atencao' ? 'atenção' : rel.recentSerious ? 'ocorrência recente' : 'evitar';
      const who = (pp: PricePoint) => pp.src === 'rede'
        ? (pp.seen ? 'informado · ' : pl(pp.n ?? 1, 'pessoa', 'pessoas') + ' · ') + ago(pp.date, today)
        : pp.src === 'voce' ? (pp.seen ? 'você viu · ' : 'você pagou · ') + ago(pp.date, today) : 'ANP · ' + dm(pp.date);
      const plate = (fuel: Fuel, pp: PricePoint | null) => {
        const k = '<span class="k"><i class="dot ' + (fuel === 'gasolina' ? 'gas' : 'eth') + '"></i>' + FUEL[fuel].toUpperCase() + '</span>';
        if (reportOpen === s.c && reportFuel === fuel) {
          // informando o preço da bomba: o próprio cartão vira o campo
          return '<div class="pl2 edit">' + k + '<label class="sr" for="pr-' + fuel + '">Preço do ' + FUEL[fuel].toLowerCase() + ' na bomba, em reais por litro</label>' +
            '<input class="v" id="pr-' + fuel + '" inputmode="decimal" autocomplete="off" placeholder="' + (pp ? fmt(pp.price, 2) : '0,00') + '" enterkeyhint="send">' +
            '<span class="pl2-acts"><button type="button" data-pr="cancel" aria-label="Cancelar">' + XS + '</button><button type="button" class="go" data-pr="send">Enviar</button></span></div>';
        }
        return '<div class="pl2' + (row.best && !row.best.stale && row.best.fuel === fuel ? ' win' : '') + '">' + k +
          '<span class="v">' + (pp ? fmt(pp.price, 2) : '–') + '</span><span class="d">' + (pp ? esc(who(pp)) + (ageDays(pp.date, today) > 30 ? ' (antigo)' : '') : 'sem preço recente') + '</span>' +
          '<button type="button" class="pl2-add" data-pr="open" data-fuel="' + fuel + '" aria-label="Informar o preço do ' + FUEL[fuel].toLowerCase() + ' na bomba">' + PLUS + 'Informar preço</button></div>';
      };
      const head =
        '<div class="ps2-head"><div class="ps2-top"><button type="button" class="ps2-back" data-close aria-label="Voltar">' + BACK + '</button>' +
        '<span class="ps2-selo ' + rel.level + '">' + SHIELD_OK + fmt(rel.score, 1) + ' ' + lvlTxt + '</span></div>' +
        '<div class="ps2-name"><h2>' + brandBadge(s.b, 30) + esc(nm(s)) + '</h2><span>' + esc([s.e, dist].filter(Boolean).join(' · ')) + (s.pg === 'b' ? ' · local aproximado' : '') + '</span></div>' +
        photoFig(s) +
        '<div class="ps2-plates">' + (car.model.fuels.includes('etanol') ? plate('etanol', row.eth) : '') + (car.model.fuels.includes('gasolina') ? plate('gasolina', row.gas) : '') + '</div></div>';
      // anel do rendimento
      let pctTxt = '–', frac = 0, ringTone = 'ok', yT = 'Rendimento sem medição', yS = 'Cada tanque cheio registrado aqui conta: o app compara com o consumo normal de cada pessoa.';
      if (y?.pub && y.r != null) {
        pctTxt = Math.round(y.r * 100) + '%';
        frac = Math.max(0.05, Math.min(1, (y.r - 0.85) / 0.2));
        ringTone = y.r >= 0.97 ? 'ok' : 'warn';
        yT = y.r >= 1 ? 'Rende bem' : y.r < 0.97 ? 'Rende menos' : 'Rende normal';
        yS = 'Comparado com o consumo normal de cada pessoa. ' + pl(y.tanks, 'tanque', 'tanques') + ', ' + pl(y.people, 'pessoa', 'pessoas') + '.';
      } else if (y && y.people > 0) {
        frac = Math.min(1, (Math.min(y.people, 5) / 5 + Math.min(y.tanks, 15) / 15) / 2);
        ringTone = 'wait';
        yT = 'Medindo o rendimento';
        yS = Math.min(y.people, 5) + ' de 5 pessoas e ' + Math.min(y.tanks, 15) + ' de 15 tanques até agora.';
      }
      const ring = '<div class="ring2 ' + ringTone + '"><svg aria-hidden="true" viewBox="0 0 36 36"><circle cx="18" cy="18" r="15" class="tr"/><circle cx="18" cy="18" r="15" class="fg" stroke-dasharray="' + (frac * 94.2).toFixed(1) + ' 94.2" transform="rotate(-90 18 18)"/></svg><b>' + pctTxt + '</b></div>';
      const yieldBox = '<div class="card y2">' + ring + '<div class="y2-t"><b>' + yT + '</b><span>' + yS + '</span></div></div>';
      // de onde vem a nota
      const tile = (k: string, v: string, d: string) => '<div class="tl2"><span>' + k + '</span><b>' + v + '</b><span>' + d + '</span></div>';
      const share = (t: [number, number] | null | undefined, label: string) => (t ? { p: Math.round((t[0] / t[1]) * 100), label } : null);
      const chips = [
        share(rat?.bomba, 'bomba certa'),
        share(rat?.atendimento, 'atendimento'),
        dp ? { p: Math.round(((dp.normal + dp.melhor) / dp.n) * 100), label: 'carro sem problema' } : null,
        share(rat?.banheiro, 'banheiro'),
      ].filter((c): c is { p: number; label: string } => !!c);
      const gSub = g ? g.count.toLocaleString('pt-BR') + ' notas' : gStatus(s.c, false);
      const whyBox =
        '<div class="card why2"><b class="why2-t">De onde vem o ' + fmt(rel.score, 1) + '</b><div class="why2-tiles">' +
        tile('ANP', fmt(rel.anp, 1), rel.infractions ? pl(rel.infractions, 'infração', 'infrações') : s.f ? 'sem infração' : 'sem registro') +
        tile('Quem abasteceu', stars ? fmt(stars.avg, 1) + '★' : '–', stars ? pl(stars.n, 'nota', 'notas') : rat?.n ? pl(rat.n, 'avaliação', 'avaliações') : 'sem notas') + '</div>' +
        // Google: informação à parte (não entra no número acima)
        (gm
          ? '<button type="button" class="g2line" data-grv aria-expanded="' + (reviewsOpen === s.c) + '"><span class="g2-k">No Google</span><b>' + (g ? fmt(g.rating, 1) + '★' : '–') + '</b><span class="g2-s">' + esc(g ? '(' + g.count.toLocaleString('pt-BR') + ')' : gStatus(s.c, true)) + '</span><span class="g2-go">Avaliações' + CHEV_S + '</span></button>'
          : '<div class="g2line off"><span class="g2-k">No Google</span><b>–</b><span class="g2-s">' + esc(gStatus(s.c, true)) + '</span></div>') +
        '<p class="g2-note">' + (gm && !g && notaBlocked && !notaNone.has(s.c) ? esc(notaBlocked) + ' ' : '') + 'A nota do Google é só informação: não entra no ' + fmt(rel.score, 1) + ' nem no sugerido.</p>' +
        (chips.length ? '<div class="why2-chips">' + chips.map((c) => '<span class="' + (c.p >= 70 ? 'ok' : 'warn') + '">' + c.label + ' ' + c.p + '%</span>').join('') + '</div>' : '') +
        (rel.netWarn ? '<p class="rec-warn">' + ICON.warn + '<span>' + (rel.netWarn === 'rendimento' ? 'Os tanques daqui rendem abaixo do normal para quem usa o app.' : rel.netWarn === 'falhas' ? 'Vários relatos de carro falhando depois de abastecer aqui.' : 'Muita gente disse que a bomba não marcou certo.') + '</span></p>' : '') +
        (ev.length ? '<details class="more"><summary>Fiscalização da ANP (' + ev.length + ')<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 9l6 6 6-6"/></svg></summary><ul class="ev-list">' + ev.slice(0, 6).map(([d, t, txt]) => '<li><span class="d">' + dm(d) + '/' + d.slice(2, 4) + '</span><span><b>' + EVENT_LABEL[t] + '</b>' + (txt ? ' · ' + esc(txt.replace(/^(Notificação|MRC)\s*-\s*(PR ?Comb\s*-\s*)?/i, '')) : '') + '</span></li>').join('') + '</ul></details>' : '') +
        '</div>';
      const me = mine.length || linkOffer(s)
        ? '<div class="card"><span class="b15">Você aqui</span>' + (v ? '<span class="hint ' + v.tone + '">' + esc(v.text) + '</span>' : '') +
          (mine.length ? '<span class="hint">' + pl(mine.length, 'abastecimento', 'abastecimentos') + ', o último em ' + dm(mine[0].date) + (u?.kml ? ' · ' + fmt(u.kml, 1) + ' km/l' : '') + '</span>' : '') + linkOffer(s) + '</div>'
        : '';
      $('posto-body').innerHTML = head + yieldBox + whyBox + reviewsBox(s) + placeCard(s) +
        (perKm ? '<p class="hint">' + perKm + '</p>' : '') + me +
        '<div class="card"><div class="card-head"><span>Como chegar</span><span class="hint" id="ps-eta"></span></div><div class="ps-map" id="ps-map" role="img" aria-label="Mapa com o posto e o caminho até ele"></div><span class="hint" id="ps-map-note"></span></div>';
      const ph = gmatch.get(s.c)?.photo;
      if (ph && photoUris.get(ph.name) === undefined) void showPhoto(ph);
      return;
    }
    $('posto-body').innerHTML =
      (gm?.photo ? '<figure class="ps-photo" id="ps-photo" data-name="' + esc(gm.photo.name) + '"><div class="ph"></div><figcaption>Foto: ' + esc(gm.photo.author || 'Google') + ' · Google</figcaption></figure>' : '') +
      '<div class="ps-head"><h2>' + esc(nm(s)) + '</h2>' + (gm && gm.name !== s.n ? '<span class="hint">No cadastro da ANP: ' + esc(s.n) + '</span>' : '') +
      '<span class="hint">' + [s.e, s.br, s.m].filter(Boolean).map(esc).join(', ') + '</span>' +
      '<span class="hint">' + [s.b === 'Bandeira branca' ? 'bandeira branca' : s.b, dist].filter(Boolean).map(esc).join(' · ') + (s.pg === 'b' ? ' · localização aproximada' : '') + '</span></div>' +
      '<div class="price-grid">' + (car.model.fuels.includes('gasolina') ? priceCell('gasolina', row.gas) : '') + (car.model.fuels.includes('etanol') ? priceCell('etanol', row.eth) : '') + '</div>' +
      reportBlock(s, row) +
      (perKm ? '<p class="hint" style="margin-top:-6px">' + perKm + '</p>' : '') +
      (extra ? '<p class="hint" style="margin-top:-6px">Também: ' + esc(extra) + '</p>' : '') +
      yieldCard + ratCard + relCard + meCard +
      '<div class="card"><div class="card-head"><span>Como chegar</span><span class="hint" id="ps-eta"></span></div><div class="ps-map" id="ps-map" role="img" aria-label="Mapa com o posto e o caminho até ele"></div><span class="hint" id="ps-map-note"></span></div>';
  }

  /* ---------- avaliações do Google (só quando a pessoa toca na nota; ficam só na memória) ---------- */
  let reviewsOpen: string | null = null;
  const reviews = new Map<string, GoogleReviews | 'carregando' | 'erro'>();
  let reviewsErr = '';
  function reviewsBox(s: Station) {
    const gm = gmatch.get(s.c);
    if (reviewsOpen !== s.c || !gm) return '';
    const d = reviews.get(gm.id);
    const head = '<div class="grv-h"><b>Avaliações no Google</b><button type="button" class="grv-x" data-grv aria-label="Fechar">' + XS + '</button></div>';
    if (!d || d === 'carregando') return '<div class="card grv" id="grv">' + head + '<span class="hint">Carregando as avaliações do Google…</span></div>';
    if (d === 'erro') return '<div class="card grv" id="grv">' + head + '<span class="hint">' + esc(reviewsErr || 'O Google não respondeu agora.') + '</span><button type="button" class="btn sm" data-grv-retry>Tentar de novo</button></div>';
    const today = todayISO();
    const list = d.reviews.slice().sort((a, b) => (b.time ?? '').localeCompare(a.time ?? ''));
    const newest = list.find((r) => r.time);
    const age = newest?.time ? ageDays(newest.time.slice(0, 10), today) : null;
    const dmy = (t: string) => t.slice(8, 10) + '/' + t.slice(5, 7) + '/' + t.slice(0, 4);
    const stars = (n: number | null) => '<span class="rv-st" aria-label="' + (n ?? 0) + ' de 5">' + '★★★★★'.slice(0, Math.round(n ?? 0)) + '<i>' + '★★★★★'.slice(Math.round(n ?? 0)) + '</i></span>';
    const recency = newest?.time
      ? '<p class="grv-rec' + (age! > 180 ? ' old' : '') + '">' + (age! > 180 ? ICON.warn : '') + '<span>A mais recente das ' + list.length + ' que o Google mostra é de <b>' + esc(newest.rel || dmy(newest.time)) + '</b> (' + dmy(newest.time) + ').' + (age! > 180 ? ' Pode ter mudado algo no posto desde então: veja as mais recentes no Google Maps.' : '') + '</span></p>'
      : '<p class="grv-rec">O Google não mostrou avaliações escritas deste posto.</p>';
    return '<div class="card grv" id="grv">' + head +
      '<div class="grv-sum"><b>' + (d.rating != null ? fmt(d.rating, 1) : '–') + '</b>' + stars(d.rating) + '<span>' + d.count.toLocaleString('pt-BR') + ' avaliações</span></div>' + recency +
      list.map((r) => '<div class="rv"><div class="rv-h">' + stars(r.rating) + '<span>' + esc(r.rel) + (r.time ? ' · ' + dmy(r.time) : '') + '</span></div>' +
        (r.text ? '<p class="rv-t">' + esc(r.text) + '</p>' : '') +
        (r.author ? (r.authorUri ? '<a class="rv-a" href="' + esc(r.authorUri) + '" target="_blank" rel="noopener">' + esc(r.author) + '</a>' : '<span class="rv-a">' + esc(r.author) + '</span>') : '') + '</div>').join('') +
      ((d.reviewsUri || d.uri) ? '<a class="btn block" href="' + esc(d.reviewsUri || d.uri) + '" target="_blank" rel="noopener">Ver todas no Google Maps</a>' : '') +
      '<span class="hint">Avaliações do Google. Ele mostra até 5, escolhidas por relevância; no Google Maps dá para ordenar pelas mais recentes. Nada disso fica guardado no app.</span></div>';
  }
  async function toggleReviews(st: Station, retry = false) {
    const gm = gmatch.get(st.c);
    if (!gm) return;
    if (!retry && reviewsOpen === st.c) { reviewsOpen = null; return rerenderPosto(st); }
    reviewsOpen = st.c;
    const cur = reviews.get(gm.id);
    if (!cur || cur === 'erro') {
      reviews.set(gm.id, 'carregando');
      rerenderPosto(st, true);
      try {
        const d = await googleReviews(gm.id);
        reviews.set(gm.id, d ?? 'erro');
        if (d) {
          ncache[gm.id] = { at: Date.now(), rating: d.rating, count: d.count };
          await setMeta(N_KEY, ncache);
          applyNota(st.c, gm.id);
        }
      } catch (e) {
        // erro só das avaliações: mostra no painel, sem desligar o resto do Google no app
        reviews.set(gm.id, 'erro');
        reviewsErr = '';
        const res = (e as { context?: Response })?.context;
        try { if (res) reviewsErr = (await res.json()).error ?? ''; } catch { /* sem corpo */ }
        if (!res) reviewsErr = (e as Error)?.message ?? '';
      }
    }
    if (shown?.c === st.c && reviewsOpen === st.c) rerenderPosto(st, true);
  }
  function rerenderPosto(st: Station, scroll = false) {
    const body = document.querySelector<HTMLElement>('#posto-sheet .sheet-body');
    const y = body?.scrollTop ?? 0;
    renderPosto(st);
    if (body) body.scrollTop = y;
    setTimeout(() => showMap(st), 50);
    if (scroll) setTimeout(() => document.getElementById('grv')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 60);
  }

  /** "Informar preço": quem está no posto conta o preço da bomba, sem precisar abastecer. */
  let reportOpen: string | null = null;
  /** Visual novo: qual combustível está sendo informado (o cartão dele vira campo). */
  let reportFuel: Fuel | null = null;
  function reportBlock(s: Station, row: StationRow) {
    const fuels = carInfo().model.fuels;
    if (reportOpen !== s.c) {
      return '<button type="button" class="link-btn pr-open" data-pr="open">' + ICON.plus + 'Informar o preço da bomba</button>';
    }
    const ph = (pp: PricePoint | null) => (pp ? fmt(pp.price, 2) : '0,00');
    const inp = (fuel: Fuel, pp: PricePoint | null) =>
      '<label class="field"><span><i class="dot ' + (fuel === 'gasolina' ? 'gas' : 'eth') + '"></i>' + FUEL[fuel] + ' R$/l</span><input class="inp sm" id="pr-' + fuel + '" inputmode="decimal" autocomplete="off" placeholder="' + ph(pp) + '"></label>';
    return (
      '<div class="card pr-card"><span class="b15">Preço na bomba agora</span>' +
      '<span class="hint">Não precisa abastecer. Aparece para todos como "informado" por 7 dias; o preço de quem abastece aqui vale antes.</span>' +
      '<div class="grid2">' + (fuels.includes('gasolina') ? inp('gasolina', row.gas) : '') + (fuels.includes('etanol') ? inp('etanol', row.eth) : '') + '</div>' +
      '<div class="btn-row"><button type="button" class="btn sm" data-pr="cancel">Cancelar</button><button type="button" class="btn sm primary" data-pr="send">Enviar</button></div></div>'
    );
  }
  $('posto-body').addEventListener('keydown', (e) => {
    const el = e.target as HTMLElement;
    if (e.key === 'Enter' && el.matches('.pl2.edit input')) { e.preventDefault(); el.closest('.pl2')?.querySelector<HTMLButtonElement>('[data-pr="send"]')?.click(); }
    if (e.key === 'Escape' && el.matches('.pl2.edit input')) el.closest('.pl2')?.querySelector<HTMLButtonElement>('[data-pr="cancel"]')?.click();
  });
  $('posto-body').addEventListener('click', (e) => {
    const el = e.target as HTMLElement;
    if (!shown) return;
    el.closest('.rv-t')?.classList.toggle('full');
    if (el.closest('[data-grv-retry]')) return void toggleReviews(shown, true);
    if (el.closest('[data-grv]')) return void toggleReviews(shown);
  });
  $('posto-body').addEventListener('click', async (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-pr]');
    if (!b || !shown) return;
    const st = shown;
    const act = b.dataset.pr;
    if (act === 'open') {
      if (!(await currentSession())) return toast('Entre na conta (Perfil) para informar preços.');
      if (!S.prefs.contribute) return toast('Ligue "Contribuir com a rede" no Perfil para informar preços.');
      reportOpen = st.c;
      reportFuel = (b.dataset.fuel as Fuel | undefined) ?? null;
      renderPosto(st);
      setTimeout(() => (document.querySelector<HTMLInputElement>('#posto-body .pr-card input, #posto-body .pl2.edit input'))?.focus(), 50);
      return;
    }
    if (act === 'cancel') { reportOpen = null; reportFuel = null; return renderPosto(st); }
    if (act === 'send') {
      const items: { fuel: Fuel; price: number }[] = [];
      for (const fuel of ['gasolina', 'etanol'] as const) {
        const el = document.getElementById('pr-' + fuel) as HTMLInputElement | null;
        const v = el?.value.trim();
        if (!v) continue;
        const price = Number(v.replace(/[^\d,.]/g, '').replace(',', '.'));
        if (!Number.isFinite(price) || !plausible(fuel, price)) return toast('O preço de ' + fuel + ' parece errado. Use o valor por litro, como 6,49.');
        items.push({ fuel, price });
      }
      if (!items.length) return toast('Digite pelo menos um preço.');
      b.disabled = true;
      const err = await reportPrices(st.c, items);
      b.disabled = false;
      if (err) return toast(err);
      reportOpen = null;
      reportFuel = null;
      invalidateNetwork(st.c);
      toast('Obrigado! O preço aparece para todos em até 5 minutos.');
      renderPosto(st);
      render();
      renderHome();
    }
  });

  /** Abastecimentos antigos sem posto: oferece ligar a este. */
  function linkOffer(s: Station) {
    const n = carLogs().filter((f) => !f.station_id && !f.station).length;
    if (!n) return '';
    return '<button type="button" class="btn sm" id="posto-mine" data-armed="0">É aqui que eu abasteço</button><span class="hint">Liga a este posto ' + (n === 1 ? 'o seu abastecimento' : 'os seus ' + n + ' abastecimentos') + ' sem posto anotado.</span>';
    void s;
  }

  /** Link temporário da foto (do Google), só na memória; null = sem foto ou não carregou. */
  const photoUris = new Map<string, string | null>();
  const P_KEY = 'google_fotos_v1';
  const photoLoading = new Set<string>();
  async function showPhoto(ph: { name: string }) {
    let uri = photoUris.get(ph.name);
    if (uri === undefined) {
      // o link da foto vale o dia (a faixa grátis de fotos é pequena): não busca de novo a cada ficha
      const day = await getMeta<Record<string, { at: number; uri: string }>>(P_KEY, {});
      const e = day[ph.name];
      if (e && fresh(e.at)) { uri = e.uri; photoUris.set(ph.name, uri); }
    }
    if (uri === undefined) {
      if (photoBlocked || photoLoading.has(ph.name)) return;
      photoLoading.add(ph.name);
      try {
        uri = await googlePhoto(ph.name);
        if (uri) {
          const day = Object.fromEntries(Object.entries(await getMeta<Record<string, { at: number; uri: string }>>(P_KEY, {})).filter(([, x]) => fresh(x.at)));
          day[ph.name] = { at: Date.now(), uri };
          await setMeta(P_KEY, day);
        }
      } catch (e) {
        await gError(e, 'foto');
        uri = null;
      } finally {
        photoLoading.delete(ph.name);
      }
      photoUris.set(ph.name, uri ?? null);
    }
    const fig = document.getElementById('ps-photo');
    if (!fig || fig.dataset.name !== ph.name) return;
    if (!uri) return fig.remove();
    if (!fig.querySelector('.ph')) return;
    const img = new Image();
    img.alt = 'Foto do posto';
    img.decoding = 'async';
    img.onload = () => {
      if (!isNovo()) return fig.querySelector('.ph')?.replaceWith(img);
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ps2-ph';
      b.dataset.photo = '';
      b.setAttribute('aria-label', 'Ver a foto em tela cheia');
      b.append(img);
      fig.querySelector('.ph')?.replaceWith(b);
    };
    img.onerror = async () => {
      // link vencido: esquece e não tenta de novo nesta sessão
      photoUris.set(ph.name, null);
      fig.remove();
      const day = await getMeta<Record<string, { at: number; uri: string }>>(P_KEY, {});
      delete day[ph.name];
      await setMeta(P_KEY, day);
    };
    img.src = uri;
  }
  /** Visual novo: foto do posto (do Google) logo abaixo do nome, com o crédito que o Google exige. */
  function photoFig(s: Station) {
    const ph = gmatch.get(s.c)?.photo;
    if (!ph || photoUris.get(ph.name) === null) return '';
    const uri = photoUris.get(ph.name);
    const who = ph.author ? (ph.authorUri ? '<a href="' + esc(ph.authorUri) + '" target="_blank" rel="noopener">' + esc(ph.author) + '</a>' : esc(ph.author)) : 'Google';
    return '<figure class="ps2-photo" id="ps-photo" data-name="' + esc(ph.name) + '">' +
      (uri ? '<button type="button" class="ps2-ph" data-photo aria-label="Ver a foto em tela cheia"><img src="' + esc(uri) + '" alt="Foto do posto"></button>' : '<div class="ph"></div>') +
      '<figcaption>Foto: ' + who + ' · Google</figcaption></figure>';
  }
  /** Foto em tela cheia: toque em qualquer lugar ou Esc fecha. */
  function openLightbox(s: Station) {
    const ph = gmatch.get(s.c)?.photo;
    const uri = ph ? photoUris.get(ph.name) : null;
    if (!ph || !uri) return;
    const box = document.createElement('div');
    box.className = 'lb';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', 'Foto de ' + nm(s));
    box.innerHTML = '<img src="' + esc(uri) + '" alt="Foto de ' + esc(nm(s)) + '"><div class="lb-cap">' + esc(nm(s)) + ' · Foto: ' + esc(ph.author || 'Google') + ' · Google</div>' +
      '<button type="button" class="lb-x" aria-label="Fechar a foto">' + XS + '</button>';
    const back = document.activeElement as HTMLElement | null;
    const close = () => { box.remove(); document.removeEventListener('keydown', key, true); back?.focus(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(); } };
    box.addEventListener('click', close);
    document.addEventListener('keydown', key, true);
    document.body.append(box);
    box.querySelector<HTMLButtonElement>('.lb-x')!.focus();
  }

  let map: import('leaflet').Map | null = null;
  const routes = new Map<string, { pts: [number, number][]; km: number; min: number } | null>();
  async function showMap(s: Station) {
    const el = document.getElementById('ps-map');
    if (!el || shown?.c !== s.c) return;
    const Lf = await loadLeaflet();
    map?.remove();
    map = Lf.map(el, { zoomControl: false, attributionControl: true, scrollWheelZoom: mouse(), zoomAnimation: false, fadeAnimation: false, markerZoomAnimation: false });
    if (mouse()) Lf.control.zoom({ position: 'bottomright', zoomInTitle: 'Aproximar', zoomOutTitle: 'Afastar' }).addTo(map);
    map.attributionControl.setPrefix(false);
    Lf.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
    const dest: [number, number] = [s.la, s.lo];
    Lf.circleMarker(dest, { radius: 9, color: '#FFFFFF', weight: 3, fillColor: '#C2410C', fillOpacity: 1 }).addTo(map).bindTooltip(nm(s), { direction: 'top', offset: [0, -8] });
    const fresh = here && Date.now() - here.at < 15 * 60000 ? here.p : null;
    const rs = resolve(base);
    const fromBase = base === 'rota' ? place('casa') : base === 'viagem' && viagem ? { lat: viagem.r.from[0], lon: viagem.r.from[1] } : 'center' in rs ? rs.center : null;
    const origin = fresh ?? fromBase;
    const label = fresh ? 'de onde você está' : base === 'casa' || base === 'rota' ? 'de casa' : base === 'trabalho' ? 'do trabalho' : base === 'viagem' ? 'de onde você saiu' : 'do local escolhido';
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

  /** Busca de texto no Google só de postos de combustível, guardada por 7 dias no aparelho. */
  async function searchFor(key: string, query: string, s: Station): Promise<GoogleStation[] | null> {
    let places = await gGet(key);
    if (!places && !gBlocked) {
      try {
        const res = await googlePlaces<GoogleStation>({ mode: 'posto', query, lat: s.la, lon: s.lo });
        googleOn = res.configured;
        if (res.configured) {
          places = res.places;
          await gPut(key, places);
        }
      } catch (e) {
        await gError(e);
      }
    }
    return places ?? null;
  }

  /**
   * Acha este posto no Google: primeiro pelo endereço da ANP (com bairro e cidade); se nada casar,
   * pelo nome. O nome da ANP costuma ser a razão social, por isso o endereço vem antes.
   */
  async function lookupStation(s: Station) {
    gTried.add(s.c);
    gPending.add(s.c);
    try {
      await lookupInner(s);
    } finally {
      // se a busca falhou no meio, tira o "procurando" mesmo assim
      if (gPending.delete(s.c) && shown?.c === s.c) { renderPosto(s); setTimeout(() => showMap(s), 50); }
    }
  }
  async function lookupInner(s: Station) {
    if (placeOf.has(s.c)) {
      const pid = placeOf.get(s.c);
      // quem usa o app disse que este posto não está no Google
      if (!pid) return afterLookup(s);
      // já ligado: pede a nota direto pelo id, sem busca por texto (vale mesmo com a busca por perto bloqueada)
      const key = 'lugar:' + pid;
      let places = await gGet(key);
      if (!places && !lugarBlocked) {
        try {
          const res = await googlePlaces<GoogleStation>({ mode: 'lugar', id: pid });
          googleOn = res.configured;
          if (res.configured) { places = res.places; await gPut(key, places); }
        } catch (e) {
          await gError(e, 'lugar');
        }
      }
      if (places?.[0]) addMatches(new Map([[s.c, toMatch(places[0])]]));
      return afterLookup(s);
    }
    const byAddr = await searchFor('posto:' + s.c, 'posto de combustível ' + s.e + ', ' + (s.br ? s.br + ', ' : '') + s.m + ' - SC', s);
    let hit = byAddr ? bestForStation(byAddr, s) : null;
    if (!hit && byAddr && nameTokens(s.n).length) {
      const byName = await searchFor('posto-nome:' + s.c, s.n + ', ' + s.m + ' - SC', s);
      hit = byName ? bestForStation(byName, s) : null;
    }
    if (hit) addMatches(new Map([[s.c, hit]]));
    afterLookup(s);
  }
  function afterLookup(s: Station) {
    gPending.delete(s.c);
    if (gmatch.has(s.c)) void loadNota(s);
    if (shown?.c === s.c) {
      renderPosto(s);
      const gm = gmatch.get(s.c);
      if (gm?.photo) showPhoto(gm.photo);
      setTimeout(() => showMap(s), 50);
    }
    render();
  }
  /* ---------- "É este o posto no Google?": a pessoa confirma ou corrige a ligação ---------- */
  /** Cartão na ficha: qual lugar do Google está ligado a este posto, com confirmar e corrigir. */
  function placeCard(s: Station) {
    if (googleOn === false) return '';
    const gm = gmatch.get(s.c);
    const pid = placeOf.get(s.c);
    const none = placeOf.has(s.c) && pid === null;
    const mineV = links.mine.has(s.c) ? links.mine.get(s.c) : undefined;
    const confirmed = mineV !== undefined && (mineV === (gm?.id ?? null) || (none && mineV === null));
    const who = links.people.has(s.c) ? '<span class="gp2-tag">confirmado por quem usa o app</span>' : '';
    const what = gm
      ? '<b class="gp2-n">' + esc(gm.name) + '</b>' + (gm.address ? '<span class="hint">' + esc(gm.address) + '</span>' : '')
      : none ? '<span class="hint">Marcado como fora do Google: o app não mostra nota do Google para ele.</span>'
      : gPending.has(s.c) ? '<span class="hint">Procurando no Google…</span>'
      : '<span class="hint">Ainda não achamos este posto no Google.</span>';
    const anp = nm(s) !== s.n ? '<span class="hint">No cadastro da ANP: ' + esc(s.n) + '</span>' : '';
    const acts = confirmed
      ? '<span class="gp2-ok">' + ICON.check + 'Você confirmou</span><button type="button" class="link-btn" data-gfix>Corrigir</button>'
      : gm ? '<button type="button" class="btn sm" data-gok>É este</button><button type="button" class="btn sm" data-gfix>Não é este</button>'
      : '<button type="button" class="btn sm" data-gfix>' + (none ? 'Achar no Google' : 'Procurar no Google') + '</button>';
    return '<div class="card gp2"><div class="gp2-h"><span>Este posto no Google</span>' + who + '</div>' + what + anp + '<div class="gp2-acts">' + acts + '</div></div>';
  }

  let fixFor: string | null = null;
  const fixCands = new Map<string, GoogleStation>();
  let fixLoading = false;
  let fixErr = '';
  /** Candidatos: o lugar ligado agora, as buscas pelo endereço e pelo nome e o que já veio da busca por perto. */
  async function gatherCands(s: Station, typed?: string) {
    const add = (gs: GoogleStation[] | null | undefined) => { for (const g of gs ?? []) if (g?.id && Number.isFinite(g.lat)) fixCands.set(g.id, g); };
    const gm = gmatch.get(s.c);
    if (gm) fixCands.set(gm.id, { id: gm.id, name: gm.name, address: gm.address ?? '', lat: gm.lat, lon: gm.lon, rating: gm.rating, count: gm.count, photo: gm.photo });
    gcache ??= await getMeta<GCache>(G_KEY, {});
    add(Object.values(gcache).filter((e) => fresh(e.at)).flatMap((e) => e.places).filter((g) => haversineKm({ lat: s.la, lon: s.lo }, g) < 0.6));
    fixErr = '';
    if (typed) {
      try {
        const res = await googlePlaces<GoogleStation>({ mode: 'posto', query: typed + ', ' + s.m + ' - SC', lat: s.la, lon: s.lo });
        if (res.configured) add(res.places);
      } catch (e) {
        const res = (e as { context?: Response })?.context;
        try { fixErr = res ? (await res.json()).error ?? '' : (e as Error).message; } catch { fixErr = 'O Google não respondeu agora.'; }
      }
      return;
    }
    add(await searchFor('posto:' + s.c, 'posto de combustível ' + s.e + ', ' + (s.br ? s.br + ', ' : '') + s.m + ' - SC', s));
    if (nameTokens(s.n).length) add(await searchFor('posto-nome:' + s.c, s.n + ', ' + s.m + ' - SC', s));
    if (gBlocked) fixErr = gBlocked;
  }
  function renderFix(s: Station) {
    const cur = placeOf.get(s.c) ?? gmatch.get(s.c)?.id ?? null;
    const at = { lat: s.la, lon: s.lo };
    const score = new Map(rankForStation([...fixCands.values()], s).map((x) => [x.g.id, x.v]));
    // parecido com o cadastro da ANP primeiro; no mesmo endereço, o cadastro com mais avaliações (o atual)
    const weight = (g: GoogleStation) => (score.get(g.id) ?? 0) + Math.log10(1 + (g.count || 0)) * 0.4;
    const list = [...fixCands.values()]
      .sort((a, b) => Number(b.id === cur) - Number(a.id === cur) || weight(b) - weight(a) || haversineKm(at, a) - haversineKm(at, b))
      .slice(0, 8);
    const row = (g: GoogleStation) =>
      '<button type="button" class="gfix-row' + (g.id === cur ? ' cur' : '') + '" data-pick="' + esc(g.id) + '">' +
      '<span class="gfix-t"><b>' + esc(g.name || 'Sem nome') + '</b>' + (g.id === cur ? '<em>ligado agora</em>' : '') + '</span>' +
      '<span class="hint">' + esc(g.address) + '</span>' +
      '<span class="hint">' + (g.rating != null ? '★ ' + fmt(g.rating, 1) + ' · ' + (g.count === 1 ? '1 avaliação' : g.count.toLocaleString('pt-BR') + ' avaliações') : 'sem avaliações no Google') + ' · ' + kmTxt(haversineKm(at, g)) + ' do ponto da ANP</span></button>';
    $('gfix-body').innerHTML =
      '<h2 class="sheet-title" id="gfix-title">Qual é este posto no Google?</h2>' +
      '<p class="hint">Cadastro da ANP: <b>' + esc(s.n) + '</b> · ' + esc([s.e, s.br, s.m].filter(Boolean).join(', ')) + ' · bandeira ' + esc(isBrancaB(s.b) ? 'branca' : s.b) + '. No Google o mesmo endereço pode ter mais de um cadastro (nome antigo, bandeira antiga): escolha o que é o posto de hoje, normalmente o com mais avaliações.</p>' +
      '<form class="gfix-q" id="gfix-form"><input class="inp sm" id="gfix-q" placeholder="Outro nome no Google" autocomplete="off" enterkeyhint="search" aria-label="Procurar outro nome no Google"><button type="submit" class="btn sm">Procurar</button></form>' +
      (fixLoading ? '<p class="hint">Procurando no Google…</p>' : '') +
      (fixErr ? '<p class="hint">' + esc(fixErr) + '</p>' : '') +
      (list.length ? '<div class="gfix-list">' + list.map(row).join('') + '</div>' : !fixLoading ? '<p class="hint">Nenhum posto do Google perto deste endereço.</p>' : '') +
      '<button type="button" class="btn block' + (placeOf.get(s.c) === null && placeOf.has(s.c) ? ' cur' : '') + '" data-pick="none">Nenhum desses: não está no Google</button>' +
      '<p class="hint">Sua escolha vale na hora para você e passa a valer para todos quando outra pessoa escolher o mesmo. O app guarda só qual lugar do Google é este posto.</p>';
  }
  async function openFix(s: Station) {
    if (!(await currentSession())) return toast('Entre na conta (Perfil) para corrigir o posto.');
    fixFor = s.c;
    fixCands.clear();
    fixLoading = true;
    renderFix(s);
    openSheet('gfix-sheet');
    await gatherCands(s);
    fixLoading = false;
    if (fixFor === s.c) renderFix(s);
  }
  async function pickPlace(s: Station, id: string | null) {
    const cand = id ? fixCands.get(id) ?? null : null;
    const r = await votePlace(s.c, id);
    if ('error' in r) return toast(r.error);
    // um lugar do Google fica com um posto só
    if (id) for (const [c, p] of [...placeOf]) if (p === id && c !== s.c) { placeOf.delete(c); if (gmatch.get(c)?.id === id) { gmatch.delete(c); google.delete(c); } }
    placeOf.set(s.c, id);
    links.mine.set(s.c, id);
    if (r.applied) links.people.add(s.c);
    gmatch.delete(s.c);
    google.delete(s.c);
    adjusted = null;
    gTried.delete(s.c);
    if (reviewsOpen === s.c) reviewsOpen = null;
    if (cand) addMatches(new Map([[s.c, toMatch(cand)]]));
    toast(r.applied ? 'Corrigido para todos. Obrigado!' : 'Corrigido para você. Vale para todos quando outra pessoa confirmar.');
    render();
    renderHome();
    if (sheetOpen() === 'gfix-sheet') closeSheets(); // o fechamento reabre a ficha
    else if (shown?.c === s.c) renderPosto(s);
  }
  onSheetClose('gfix-sheet', () => {
    const c = fixFor;
    fixFor = null;
    if (c) setTimeout(() => openPosto(c), 0);
  });
  $('gfix-body').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-pick]');
    const s = fixFor ? stations().find((x) => x.c === fixFor) : null;
    if (!b || !s) return;
    const id = b.dataset.pick === 'none' ? null : b.dataset.pick!;
    void pickPlace(s, id);
  });
  $('gfix-body').addEventListener('submit', async (e) => {
    e.preventDefault();
    const s = fixFor ? stations().find((x) => x.c === fixFor) : null;
    const q = (document.getElementById('gfix-q') as HTMLInputElement | null)?.value.trim() ?? '';
    if (!s || q.length < 3) return;
    fixLoading = true;
    renderFix(s);
    await gatherCands(s, q);
    fixLoading = false;
    if (fixFor === s.c) renderFix(s);
  });
  $('posto-body').addEventListener('click', (e) => {
    const el = e.target as HTMLElement;
    if (!shown) return;
    if (el.closest('[data-photo]')) return openLightbox(shown);
    if (el.closest('[data-gfix]')) return void openFix(shown);
    if (el.closest('[data-gok]')) { const gm = gmatch.get(shown.c); if (gm) void pickPlace(shown, gm.id); }
  });

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
  function openLocal(dest = false) {
    renderLocal();
    openSheet('local-sheet');
    search.clear();
    destSearch.clear();
    if (dest) setTimeout(() => { const i = $<HTMLInputElement>('local-dest'); i.scrollIntoView({ block: 'center' }); i.focus(); }, 280);
  }
  function renderLocal() {
    const r = rota();
    const saved: string[] = [];
    for (const k of ['casa', 'trabalho'] as const) {
      const p = place(k);
      if (p) saved.push('<button type="button" class="row nav" data-pick="' + k + '"><span class="ic gray">' + (k === 'casa' ? HOUSE : BAG) + '</span><span class="mid"><span class="a">' + (k === 'casa' ? 'Casa' : 'Trabalho') + '</span><span class="b">' + esc(p.label) + '</span></span><span class="chev">' + ICON.chev + '</span></button>');
    }
    if (viagem) saved.push('<button type="button" class="row nav" data-pick="viagem"><span class="ic gray">' + PIN + '</span><span class="mid"><span class="a">Até ' + esc(viagem.label) + '</span><span class="b">Caminho de ' + fmt(viagem.r.km, 1) + ' km saindo de onde você estava</span></span><span class="chev">' + ICON.chev + '</span></button>');
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
  const destSearch = addressSearch($<HTMLInputElement>('local-dest'), $('local-dest-results'), {
    near: () => here?.p ?? place('casa'),
    onPick: (p) => closeSheets(() => {
      if (currentRoute().view !== 'postos') go('postos');
      void startTrip(p);
    }),
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
        ? '<div class="rec-card"><button type="button" class="rec-main" data-home-posto="' + r.s.c + '" data-base="' + kind + '"><span class="l">' + where + '</span><span class="t">' + esc(nm(r.s)) + '</span><span class="s">Sem preço recente nos postos daqui · melhor avaliado e mais perto (confiabilidade ' + fmt(r.rel.score, 1) + ')</span></button>' +
          '<a class="more" href="#/postos" data-home-base="' + kind + '">Ver outros postos ' + ICON.chev + '</a></div>'
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
    const cheapTxt = cheapNote(rec, carInfo().model.kmTank, true);
    if (isNovo()) {
      nameRows(all.rows.filter((r) => r.s.c === b.s.c));
      // visual novo: o cartão inteiro abre a ficha; embaixo, a economia contra o outro combustível
      const save = rec.bestOther && rec.bestOther.cost - b.cost >= 0.5 ? '<b>R$ ' + Math.round(rec.bestOther.cost - b.cost) + ' a menos</b> que ' + FUEL[rec.bestOther.fuel].toLowerCase() + ' no tanque' : favTxt ? esc(favTxt) : 'Ver a ficha do posto';
      el.innerHTML =
        '<button type="button" class="rec2" data-home-posto="' + b.s.c + '" data-base="' + kind + '">' +
        '<span class="r2-top"><span class="l">' + where + ' · agora</span>' + seloTag(b.rel) + '</span>' +
        '<span class="r2-mid"><span class="r2-n"><span class="t">' + brandBadge(b.s.b, 26) + esc(nm(b.s)) + '</span><span class="s">' + dist + ' · ' + priceShort(b.price) + '</span></span>' + totemTag(b) + '</span>' +
        (cheapTxt ? '<span class="r2-cheap">' + esc(cheapTxt) + '</span>' : '') +
        '<span class="r2-foot"><span>' + save + '</span>' + ICON.chev + '</span></button>';
      return;
    }
    const badges = netBadges(b.s.c ? network().get(b.s.c) ?? null : null, 2);
    el.innerHTML =
      '<div class="rec-card"><button type="button" class="rec-main" data-home-posto="' + b.s.c + '" data-base="' + kind + '"><span class="l">' + where + '</span>' + selo(b.rel) +
      '<span class="t"><span class="only-v1">' + FUEL[b.fuel] + ' no </span>' + esc(nm(b.s)) + '</span>' + totem(b) +
      '<span class="s"><span class="only-v1">' + brl(b.price.price) + '/l · </span>' + dist + '<span class="only-v2"> · ' + priceWho(b.price) + '</span>' + (rec.bestOther && rec.bestOther.cost - b.cost >= 0.5 ? '<span class="save"> · <b>' + brl(rec.bestOther.cost - b.cost) + ' a menos</b> que ' + FUEL[rec.bestOther.fuel].toLowerCase() + '</span>' : '') + '</span>' +
      '<span class="rec-badges"><span class="nb on-dark ' + b.price.src + '">' + priceWho(b.price) + '</span>' + badges.replace(/class="nb/g, 'class="nb on-dark') + '<span class="nb on-dark">ANP ' + fmt(b.rel.anp, 1) + '</span></span>' +
      (favTxt ? '<span class="f">' + esc(favTxt) + '</span>' : '') + (cheapTxt ? '<span class="f cheap-f">' + esc(cheapTxt) + '</span>' : '') + '</button>' +
      '<a class="more" href="#/postos" data-home-base="' + kind + '">Ver outros postos ' + ICON.chev + '</a></div>';
  }
  $('home-rec').addEventListener('click', (e) => {
    const el = e.target as HTMLElement;
    // o posto recomendado abre a ficha; só "Ver outros postos" leva para a aba Postos
    const p = el.closest<HTMLElement>('[data-home-posto]');
    if (p) {
      base = p.dataset.base as BaseKind;
      kindChosen = true;
      return openPosto(p.dataset.homePosto!);
    }
    const a = el.closest<HTMLElement>('[data-home-base]');
    if (a) { base = a.dataset.homeBase as BaseKind; kindChosen = true; }
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
    const r = stationsFor([s], { kind: 'ponto', at: { lat: s.la, lon: s.lo }, radiusKm: 1 }, { ...carInfo().model, fuels: [fuel] }, own(), todayISO(), NO_G, network())[0];
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

const BACK = '<svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M15 6l-6 6 6 6"/></svg>';
const SHIELD_OK = '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24"><path d="M12 2.5l7.5 3.2v5.9c0 4.6-3.2 8.6-7.5 10-4.3-1.4-7.5-5.4-7.5-10V5.7z" fill="currentColor"/><path d="M8.8 12.2l2.2 2.2 4.4-4.6" stroke="var(--sh-in, #C3F25C)" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const INFO = '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.5v.5"/></svg>';
/** Computador com mouse: o mapa ganha botões de zoom e a rodinha aproxima (no celular, o gesto de pinça já faz isso). */
const mouse = () => matchMedia('(hover: hover) and (pointer: fine)').matches;
const LUPA = '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>';
const CHEV_S = '<svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M9 6l6 6-6 6"/></svg>';
const XS = '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
const PLUS = '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
const SHIELD14 = '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24"><path d="M12 2.5l7.5 3.2v5.9c0 4.6-3.2 8.6-7.5 10-4.3-1.4-7.5-5.4-7.5-10V5.7z" fill="currentColor"/></svg>';
const SHIELD = '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24"><path d="M12 2.5l7.5 3.2v5.9c0 4.6-3.2 8.6-7.5 10-4.3-1.4-7.5-5.4-7.5-10V5.7z" fill="currentColor"/></svg>';
