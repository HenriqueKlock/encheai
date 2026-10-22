// Postos: distância, confiabilidade e recomendação (puro, sem DOM — testado em tests/postos.test.ts).

export type PriceCode = 'gc' | 'ga' | 'et' | 'd10' | 'ds' | 'gnv';
/** Ocorrência da fiscalização: I infração, D interdição, A apreensão, S suspensão, N notificação, M medida reparadora. */
export type EventType = 'I' | 'D' | 'A' | 'S' | 'N' | 'M';

export interface Station {
  c: string; // CNPJ
  n: string;
  b: string;
  e: string;
  br: string;
  m: string;
  la: number;
  lo: number;
  pg: 'n' | 'r' | 'b'; // precisão do ponto: número, rua, bairro
  /** Nome no OpenStreetMap (o da fachada, quando alguém cadastrou lá). */
  o?: string;
  pr?: Partial<Record<PriceCode, [number, string]>>;
  f?: { n: number; ult: string; ev: [string, EventType, string][] };
}

export interface StationsFile {
  v: number;
  uf: string[];
  gerado: string;
  fontes: { lpc_semanas: [string, string][]; fisc_desde: string; fisc_ate: string | null; cadastro: string; osm?: string };
  postos: Station[];
}

export interface LatLon { lat: number; lon: number }
export type Fuel = 'gasolina' | 'etanol';

/* ---------- geometria ---------- */
const R = 6371;
const rad = (d: number) => (d * Math.PI) / 180;

export function haversineKm(a: LatLon, b: LatLon): number {
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Até onde um posto com endereço numa rua do caminho ainda conta como "no caminho" (o ponto pode estar errado). */
export const ON_ROAD_KM = 2.5;

function plain(s: string) {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}
/** O endereço do posto está numa das ruas do caminho? Compara o nome da rua (sem número) e siglas como SC-401. */
export function onRoads(endereco: string, roads?: string[]): boolean {
  if (!roads?.length) return false;
  const street = endereco.replace(/,\s*[^,]*$/, '');
  const st = plain(street);
  if (st.length < 6) return false;
  const refs = (street.match(/\b(SC|BR)[\s-]?\d{3}\b/gi) ?? []).map(plain);
  return roads.some((r) => {
    const rp = plain(r);
    if (rp.length < 5) return false;
    if (/^(SC|BR)\d{3}$/.test(rp)) return refs.includes(rp);
    return st.includes(rp) || rp.includes(st);
  });
}

/** Fator de ruas: a distância em linha reta subestima o trajeto de carro. */
export const ROAD = 1.3;

/** Menor distância (km, em linha reta) de um ponto até uma linha (lista de pontos lat/lon). */
export function distToPathKm(p: LatLon, path: LatLon[]): number {
  if (!path.length) return Infinity;
  if (path.length === 1) return haversineKm(p, path[0]);
  const kx = 111.32 * Math.cos(rad(p.lat)), ky = 110.57;
  let best = Infinity;
  for (let i = 1; i < path.length; i++) {
    const ax = (path[i - 1].lon - p.lon) * kx, ay = (path[i - 1].lat - p.lat) * ky;
    const bx = (path[i].lon - p.lon) * kx, by = (path[i].lat - p.lat) * ky;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    const d = Math.hypot(ax + t * dx, ay + t * dy);
    if (d < best) best = d;
  }
  return best;
}

/** Simplifica uma linha (Douglas–Peucker) para guardar a rota com poucos pontos. Tolerância em km. */
export function simplify(path: LatLon[], tolKm = 0.03): LatLon[] {
  if (path.length < 3) return path.slice();
  const keep = new Uint8Array(path.length);
  keep[0] = keep[path.length - 1] = 1;
  const stack: [number, number][] = [[0, path.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop()!;
    let idx = -1, max = 0;
    for (let k = i + 1; k < j; k++) {
      const d = distToPathKm(path[k], [path[i], path[j]]);
      if (d > max) { max = d; idx = k; }
    }
    if (idx > 0 && max > tolKm) {
      keep[idx] = 1;
      stack.push([i, idx], [idx, j]);
    }
  }
  return path.filter((_, k) => keep[k]);
}

export function bboxAround(c: LatLon, km: number) {
  const dLat = km / 110.57, dLon = km / (111.32 * Math.cos(rad(c.lat)));
  return { s: c.lat - dLat, n: c.lat + dLat, w: c.lon - dLon, e: c.lon + dLon };
}

/* ---------- confiabilidade ---------- */
// Infração ligada ao combustível ou à bomba pesa 1,2; a de papelada/cadastro, 0,5
const PESO: Record<EventType, number> = { D: 2.2, S: 2.2, A: 1.6, I: 0.5, M: 0.15, N: 0.1 };
const PESO_COMBUSTIVEL = 1.2;
export const EVENT_LABEL: Record<EventType, string> = {
  I: 'Auto de infração', D: 'Interdição', A: 'Apreensão', S: 'Suspensão', N: 'Notificação', M: 'Medida reparadora',
};

/** Infração ligada ao combustível ou à bomba (qualidade/quantidade), não só a papelada. */
export function aboutFuel(text: string): boolean {
  return /volume|quantidade|qualidade|especifica|adulter|teor|massa espec|afer(i|ç)|lacre|metanol|solvente|fraude|a menor/i.test(text);
}

function yearsBetween(a: string, b: string) {
  return (Date.parse(b) - Date.parse(a)) / (365.25 * 86400000);
}

/* ---------- rede (números agregados de quem usa o app) ---------- */
/** Preço da rede. k = 'informado' quando veio de quem viu na bomba (sem abastecimento na janela). */
export interface NetPrice { v: number; d: string; n: number; k?: 'informado' }
export type RatingTally = [number, number]; // [bons, total]
export interface StationLive {
  station_id: string;
  price: Partial<Record<'gasolina' | 'etanol' | 'diesel', NetPrice>>;
  /** Rendimento medido: r = km/l dos tanques daqui ÷ o normal de cada pessoa. Só vem com pub = true quando há volume. */
  yield: { r: number | null; people: number; tanks: number; pub: boolean } | null;
  ratings: {
    n: number; bomba: RatingTally | null; atendimento: RatingTally | null; banheiro: RatingTally | null;
    /** [soma das notas, quantas] — só com 5 ou mais */
    estrelas?: [number, number] | null;
    /** Como o carro andou depois — só com 3 ou mais respostas */
    depois?: { n: number; normal: number; melhor: number; falhou: number; rendeu_menos: number } | null;
  } | null;
}
export type NetMap = Map<string, StationLive>;

/** Rendimento publicado (0,9–1,1) ou null. */
export function yieldOf(live?: StationLive | null): number | null {
  const y = live?.yield;
  return y?.pub && y.r != null ? Math.max(0.9, Math.min(1.1, y.r)) : null;
}
/** Parcela de respostas "bom" num item avaliado (null sem respostas suficientes). */
export function goodShare(live: StationLive | null | undefined, k: 'bomba' | 'atendimento' | 'banheiro'): number | null {
  const t = live?.ratings?.[k];
  return t && t[1] >= 3 ? t[0] / t[1] : null;
}

/** Média das estrelas da rede (1 a 5), quando publicada. */
export function starsOf(live?: StationLive | null): { avg: number; n: number } | null {
  const e = live?.ratings?.estrelas;
  return e && e[1] >= 5 ? { avg: e[0] / e[1], n: e[1] } : null;
}

export interface Reliability {
  score: number; // 0–5
  anp: number; // 0–5
  google: number | null; // nota ajustada, 0–5
  level: 'ok' | 'atencao' | 'evitar';
  /** Ocorrência grave (interdição, apreensão, suspensão ou infração) nos últimos 12 meses. */
  recentSerious: boolean;
  infractions: number;
  interdictions: number;
  visits: number;
  /** Rede: tanques daqui rendem pouco (publicado) ou muita gente diz que a bomba não marcou certo. */
  netWarn: 'rendimento' | 'bomba' | 'falhas' | null;
  /** Média das estrelas de quem abasteceu (com 5 ou mais notas). */
  stars: number | null;
  /** Nota do Google como aparece lá (sem o ajuste), quando houver. */
  googleRaw: { rating: number; count: number } | null;
}

/**
 * ANP (peso maior): parte de 5 e desconta cada ocorrência dos últimos 5 anos, mais forte quanto mais recente.
 * Google: média bayesiana (nota puxada para 4,0 quando há poucas avaliações).
 * Ocorrência grave nos últimos 12 meses limita a nota em 2,5 (fica fora da recomendação).
 */
export function reliability(s: Station, today: string, g?: { rating: number; count: number } | null, live?: StationLive | null): Reliability {
  const ev = s.f?.ev ?? [];
  let anp = s.f ? 5 : 4.2; // sem fiscalização registrada: neutro, não perfeito
  let recentSerious = false, inf = 0, intd = 0;
  for (const [date, t, text] of ev) {
    const y = yearsBetween(date, today);
    if (y > 5) continue;
    const w = y < 1 ? 1 : y < 2 ? 0.7 : y < 3 ? 0.5 : 0.3;
    const fuelIssue = t === 'I' && aboutFuel(text);
    anp -= (fuelIssue ? PESO_COMBUSTIVEL : PESO[t]) * w;
    if (t === 'I') inf++;
    if (t === 'D' || t === 'S' || t === 'A') intd++;
    if (y < 1 && (t === 'D' || t === 'S' || t === 'A' || fuelIssue)) recentSerious = true;
  }
  anp = Math.max(0, Math.min(5, anp));
  let google: number | null = null;
  if (g && g.count > 0 && Number.isFinite(g.rating)) {
    const m = 30;
    google = (g.rating * g.count + 4.0 * m) / (g.count + m);
  }
  // Estrelas de quem abasteceu entram com peso pequeno: a fiscalização e o rendimento medido pesam mais
  const st = starsOf(live);
  let score = google == null ? anp : 0.65 * anp + 0.35 * google;
  if (st) score = google == null ? 0.8 * anp + 0.2 * st.avg : 0.6 * anp + 0.25 * google + 0.15 * st.avg;
  if (recentSerious) score = Math.min(score, 2.5);
  // Rede: rendimento medido baixo ou bomba mal avaliada limitam a nota a "atenção"
  let netWarn: Reliability['netWarn'] = null;
  const y = live?.yield;
  if (y?.pub && y.r != null && y.r < 0.95) netWarn = 'rendimento';
  else if ((live?.ratings?.bomba?.[1] ?? 0) >= 5 && (goodShare(live, 'bomba') ?? 1) < 0.6) netWarn = 'bomba';
  else if ((live?.ratings?.depois?.n ?? 0) >= 5 && live!.ratings!.depois!.falhou / live!.ratings!.depois!.n >= 0.25) netWarn = 'falhas';
  if (netWarn) score = Math.min(score, 3.4);
  score = Math.round(score * 10) / 10;
  const level = score >= 3.8 ? 'ok' : score >= 3 ? 'atencao' : 'evitar';
  return { score, anp: Math.round(anp * 10) / 10, google: google == null ? null : Math.round(google * 10) / 10, level, recentSerious, infractions: inf, interdictions: intd, visits: s.f?.n ?? 0, netWarn, stars: st ? Math.round(st.avg * 10) / 10 : null, googleRaw: google == null ? null : { rating: g!.rating, count: g!.count } };
}

/* ---------- preços ---------- */
/** seen = preço visto na bomba (informado), não pago num abastecimento. */
export interface PricePoint { price: number; date: string; src: 'anp' | 'voce' | 'rede'; n?: number; seen?: boolean }
export interface OwnPrice { station_id: string; fuel: Fuel; price: number; date: string; seen?: boolean }

/**
 * Preço mais recente entre o que você pagou, o que a rede pagou (últimos 7 dias) e a pesquisa da ANP.
 * No mesmo dia vale o seu, depois o da rede, depois a ANP.
 */
export function priceOf(s: Station, fuel: Fuel, own: OwnPrice[], live?: StationLive | null): PricePoint | null {
  const code: PriceCode = fuel === 'gasolina' ? 'gc' : 'et';
  const cands: PricePoint[] = [];
  // no mesmo dia, o que você pagou vale antes do que você viu na bomba
  const mine = own.filter((o) => o.station_id === s.c && o.fuel === fuel).sort((a, b) => b.date.localeCompare(a.date) || Number(!!a.seen) - Number(!!b.seen))[0];
  if (mine) cands.push(mine.seen ? { price: mine.price, date: mine.date, src: 'voce', seen: true } : { price: mine.price, date: mine.date, src: 'voce' });
  const net = live?.price?.[fuel];
  if (net && net.v > 0) cands.push(net.k === 'informado' ? { price: net.v, date: net.d, src: 'rede', n: net.n, seen: true } : { price: net.v, date: net.d, src: 'rede', n: net.n });
  const anp = s.pr?.[code];
  if (anp) cands.push({ price: anp[0], date: anp[1], src: 'anp' });
  // ordem estável: em caso de empate na data fica a fonte que entrou primeiro (você > rede > ANP)
  return cands.reduce<PricePoint | null>((best, c) => (!best || c.date > best.date ? c : best), null);
}

export function ageDays(date: string, today: string) {
  return Math.round((Date.parse(today) - Date.parse(date)) / 86400000);
}

/* ---------- recomendação ---------- */
export type Base =
  | { kind: 'ponto'; at: LatLon; radiusKm: number }
  | { kind: 'rota'; path: LatLon[]; detourKm: number; roads?: string[] };

export interface CarModel {
  kmlG: number; // km/l na gasolina
  kmlE: number; // km/l no etanol
  measured: boolean; // rendimento do etanol medido nos seus tanques (senão, 70%)
  fuels: Fuel[]; // combustíveis que o carro aceita
  /** km rodados com um tanque típico de gasolina: base para comparar custos. */
  kmTank: number;
}

export interface Option {
  s: Station;
  fuel: Fuel;
  price: PricePoint;
  /** km extras para ir ao posto e voltar ao caminho (ida e volta, já com o fator de ruas). */
  extraKm: number;
  /** Distância mostrada ao usuário (km por ruas, aproximada). */
  distKm: number;
  costPerKm: number;
  /** Custo para rodar `kmTank` km com esse combustível, somando o desvio (e o rendimento medido pela rede). */
  cost: number;
  /** Rendimento medido pela rede aplicado ao custo (1 = normal), quando publicado. */
  yieldR: number | null;
  rel: Reliability;
  stale: boolean;
  /** De onde veio o rendimento aplicado: rede (todos) ou os seus tanques. */
  yieldSrc: 'rede' | 'voce' | null;
  /** Nota usada na recomendação (0–5): confiabilidade com a sua experiência no posto. */
  quality: number;
  /** Custo ajustado (R$): custo + o que a confiabilidade e a idade do preço tiram. Menor é melhor. */
  value: number;
  personal: Personal | null;
}

/** O que você mesmo viveu no posto. */
export interface Personal {
  /** Média das suas estrelas para o posto (12 meses) e quantas. */
  stars: number | null;
  starsN: number;
  /** Quantas vezes você disse que o carro falhou depois de abastecer lá (6 meses). */
  falhou: number;
  /** Rendimento dos seus tanques que começaram lá vs. a sua média (1,03 = 3% acima), com 2 tanques ou mais. */
  yieldR: number | null;
}

/** Cada ponto de nota abaixo de 5 vale 3% do custo: nota 3,5 precisa sair ~4,5% mais barato para empatar com nota 5. */
export const QUALITY_PCT = 0.03;
/** Preço com mais de 7 dias perde 0,25% por dia (até 4%): pode já ter mudado. */
export const PRICE_AGE_PCT = 0.0025;

/** Nota do posto para a recomendação: confiabilidade (ANP, Google, rede) mais o atendimento e a sua experiência. */
export function qualityOf(rel: Reliability, live?: StationLive | null, p?: Personal | null): number {
  let q = rel.score;
  const at = goodShare(live, 'atendimento');
  if (at != null && at < 0.5) q -= 0.2;
  if (p?.stars != null && p.starsN > 0) {
    const w = p.starsN >= 2 ? 0.3 : 0.15;
    q = (1 - w) * q + w * p.stars;
  }
  if (p && p.falhou > 0) q = Math.min(q, 3);
  return Math.max(0, Math.min(5, Math.round(q * 100) / 100));
}

export function valueOf(cost: number, quality: number, priceAge: number): number {
  return cost * (1 + QUALITY_PCT * (5 - quality) + Math.min(0.04, PRICE_AGE_PCT * Math.max(0, priceAge - 7)));
}

const n1 = (x: number) => x.toFixed(1).replace('.', ',');
/** Pontos fracos de uma opção, em frases curtas (para explicar por que não é a sugerida). */
export function weakPoints(o: Option, today: string): string[] {
  const r = o.rel, out: string[] = [];
  if (r.recentSerious) out.push('autuação séria da ANP nos últimos 12 meses');
  else if (r.anp < 4.2 && r.infractions + r.interdictions > 0) out.push('ANP: ' + (r.infractions + r.interdictions) + (r.infractions + r.interdictions === 1 ? ' ocorrência' : ' ocorrências') + ' em 5 anos');
  if (r.googleRaw && r.googleRaw.rating < 4.0 && r.googleRaw.count >= 20) out.push('Google ' + n1(r.googleRaw.rating) + ' (' + r.googleRaw.count + ')');
  if (r.netWarn === 'rendimento') out.push('rende pouco nos tanques da rede');
  else if (r.netWarn === 'bomba') out.push('bomba mal avaliada na rede');
  else if (r.netWarn === 'falhas') out.push('relatos de falha depois de abastecer');
  if (r.stars != null && r.stars < 3.5) out.push(n1(r.stars) + '★ de quem abasteceu');
  if (o.personal?.falhou) out.push('você relatou falha depois de abastecer lá');
  else if (o.personal?.stars != null && o.personal.stars < 3.5) out.push('sua nota: ' + n1(o.personal.stars) + '★');
  if (o.personal?.yieldR != null && o.personal.yieldR < 0.97 && o.yieldSrc === 'voce') out.push('seus tanques de lá renderam ' + Math.round((1 - o.personal.yieldR) * 100) + '% menos');
  const age = ageDays(o.price.date, today);
  if (age > 7) out.push('preço de ' + age + ' dias atrás');
  return out;
}

export interface StationRow {
  s: Station;
  distKm: number;
  extraKm: number;
  gas: PricePoint | null;
  eth: PricePoint | null;
  rel: Reliability;
  opts: Option[]; // opções deste posto, da mais barata para a mais cara
  best: Option | null; // melhor combustível neste posto
  live: StationLive | null;
}

export const MAX_PRICE_AGE = 30;

/** Postos dentro da base (raio ou desvio máximo da rota), com distância, preços e confiabilidade. */
export function stationsFor(
  all: Station[], base: Base, car: CarModel, own: OwnPrice[], today: string,
  google?: Map<string, { rating: number; count: number }>,
  net?: NetMap,
  mine?: Map<string, Personal>,
): StationRow[] {
  const rows: StationRow[] = [];
  for (const s of all) {
    const p = { lat: s.la, lon: s.lo };
    let distKm: number, extraKm: number;
    if (base.kind === 'ponto') {
      const d = haversineKm(base.at, p) * ROAD;
      if (d > base.radiusKm) continue;
      distKm = d;
      extraKm = 2 * d;
    } else {
      const d = distToPathKm(p, base.path) * ROAD;
      if (d <= base.detourKm) {
        distKm = d;
        extraKm = 2 * d;
      } else if (d <= ON_ROAD_KM && onRoads(s.e, base.roads)) {
        // Endereço numa rua do caminho (rodovias longas costumam ter o ponto do endereço impreciso)
        distKm = 0;
        extraKm = 0;
      } else continue;
    }
    const live = net?.get(s.c) ?? null;
    const rel = reliability(s, today, google?.get(s.c), live);
    const gas = priceOf(s, 'gasolina', own, live);
    const eth = priceOf(s, 'etanol', own, live);
    const personal = mine?.get(s.c) ?? null;
    const netY = yieldOf(live);
    const myY = personal?.yieldR != null ? Math.max(0.9, Math.min(1.1, personal.yieldR)) : null;
    // rendimento: o da rede (muitas pessoas) vale antes dos seus tanques
    const yr = netY ?? myY;
    const yieldSrc = netY != null ? 'rede' : myY != null ? 'voce' : null;
    const quality = qualityOf(rel, live, personal);
    const opts: Option[] = [];
    for (const [fuel, pp] of [['gasolina', gas], ['etanol', eth]] as const) {
      if (!pp || !car.fuels.includes(fuel)) continue;
      const kml = (fuel === 'gasolina' ? car.kmlG : car.kmlE) * (yr ?? 1);
      const cpk = pp.price / kml;
      const cost = cpk * (car.kmTank + extraKm);
      const age = ageDays(pp.date, today);
      opts.push({ s, fuel, price: pp, extraKm, distKm, costPerKm: cpk, cost, rel, stale: age > MAX_PRICE_AGE, yieldR: yr, yieldSrc, quality, value: valueOf(cost, quality, age), personal });
    }
    opts.sort((a, b) => a.cost - b.cost);
    rows.push({ s, distKm, extraKm, gas, eth, rel, opts, best: opts[0] ?? null, live });
  }
  return rows;
}

/** Data do preço mais novo do posto (entre os combustíveis que o carro usa), ou null. */
export function priceDate(r: StationRow): string | null {
  return r.opts.reduce<string | null>((d, o) => (!d || o.price.date > d ? o.price.date : d), null);
}

export type MapMode = 'preco' | 'avaliacao';

/**
 * Principais opções para o mapa da aba Postos.
 * Preço: com preço, os recentes primeiro (os de confiabilidade baixa no fim), do mais em conta ao mais caro.
 * Avaliação: pela confiabilidade (ANP, Google e rede) e, no empate, o mais perto.
 * O posto sugerido sempre entra.
 */
export function mapPicks(rows: StationRow[], mode: MapMode, bestId: string | null | undefined, n = 12): StationRow[] {
  let ranked: StationRow[];
  if (mode === 'preco') {
    const group = (r: StationRow) => (r.best!.stale ? 2 : r.rel.level === 'evitar' ? 1 : 0);
    ranked = rows.filter((r) => r.best).sort((a, b) => group(a) - group(b) || a.best!.cost - b.best!.cost || a.distKm - b.distKm);
  } else {
    ranked = rows.slice().sort((a, b) => b.rel.score - a.rel.score || a.distKm - b.distKm);
  }
  const out = ranked.slice(0, n);
  const best = bestId ? rows.find((r) => r.s.c === bestId) : undefined;
  if (best && !out.includes(best)) out.push(best);
  return out;
}

/**
 * Ordem da lista: primeiro os preços mais recentes (e, no mesmo dia, o mais em conta);
 * depois os de confiabilidade baixa e os de preço antigo; por fim os sem preço, pela nota e pela distância.
 */
export function sortRows(rows: StationRow[]): StationRow[] {
  const group = (r: StationRow) => (!r.best ? 3 : r.best.stale ? 2 : r.rel.level === 'evitar' ? 1 : 0);
  return rows.slice().sort((a, b) => {
    const ga = group(a), gb = group(b);
    if (ga !== gb) return ga - gb;
    if (ga < 3) {
      const da = priceDate(a)!, db = priceDate(b)!;
      if (da !== db) return db.localeCompare(da);
      return a.best!.cost - b.best!.cost;
    }
    return b.rel.score - a.rel.score || a.distKm - b.distKm;
  });
}

/** Sem nenhum preço recente: o posto de melhor nota e mais perto (cada km de distância vale 0,25 de nota). */
export function bestWithoutPrice(rows: StationRow[]): StationRow | null {
  const cands = rows.filter((r) => r.rel.level !== 'evitar');
  if (!cands.length) return null;
  return cands.slice().sort((a, b) => (b.rel.score - 0.25 * b.distKm) - (a.rel.score - 0.25 * a.distKm))[0];
}

/* ---------- seu posto: uso e rendimento dos tanques ---------- */
export interface FillLike { id: string; date: string; station_id?: string | null; station?: string | null; fuel: string; full_tank: boolean }
export interface TankLike { start_id: string; kml: number; fuel: string }
export interface StationUse {
  station_id: string;
  name: string | null;
  fills: number;
  last: string;
  tanks: number;
  kml: number | null;
  /** Rendimento dos tanques deste posto vs. a sua média do mesmo combustível (0,03 = 3% acima). */
  delta: number | null;
}

/** Postos usados, do mais frequente (últimos 12 meses) para o menos; o rendimento conta o tanque que começou ali. */
export function stationUsage(fills: FillLike[], tanks: TankLike[], today: string): StationUse[] {
  const byId = new Map(fills.map((f) => [f.id, f]));
  const avg = new Map<string, number>();
  for (const fuel of new Set(tanks.map((t) => t.fuel))) {
    const ts = tanks.filter((t) => t.fuel === fuel);
    avg.set(fuel, ts.reduce((a, t) => a + t.kml, 0) / ts.length);
  }
  const map = new Map<string, StationUse & { ratios: number[]; kmls: number[]; recent: number }>();
  for (const f of fills) {
    if (!f.station_id) continue;
    const u = map.get(f.station_id) ?? { station_id: f.station_id, name: f.station ?? null, fills: 0, last: f.date, tanks: 0, kml: null, delta: null, ratios: [], kmls: [], recent: 0 };
    u.fills++;
    if (ageDays(f.date, today) <= 365) u.recent++;
    if (f.date >= u.last) { u.last = f.date; u.name = f.station ?? u.name; }
    map.set(f.station_id, u);
  }
  for (const t of tanks) {
    const f = byId.get(t.start_id);
    const u = f?.station_id ? map.get(f.station_id) : undefined;
    const a = avg.get(t.fuel);
    if (!u || !a || t.fuel === 'misto') continue;
    u.tanks++;
    u.kmls.push(t.kml);
    u.ratios.push(t.kml / a);
  }
  return [...map.values()]
    .map(({ ratios, kmls, recent, ...u }) => ({
      ...u,
      kml: kmls.length ? kmls.reduce((a, b) => a + b, 0) / kmls.length : null,
      delta: ratios.length ? ratios.reduce((a, b) => a + b, 0) / ratios.length - 1 : null,
      _recent: recent,
    }))
    .sort((a, b) => b._recent - a._recent || b.fills - a.fills || b.last.localeCompare(a.last))
    .map(({ _recent, ...u }) => u);
}

/** Frase curta sobre o rendimento; só afirma algo com 2 tanques ou mais. */
export function usageVerdict(u: StationUse): { tone: 'ok' | 'bad' | 'neutral'; text: string } | null {
  if (u.delta == null || u.tanks === 0) return null;
  const pct = Math.round(Math.abs(u.delta) * 100);
  if (u.tanks < 2) return { tone: 'neutral', text: '1 tanque medido daqui; com mais um dá para comparar com a sua média.' };
  if (pct < 3) return { tone: 'ok', text: 'Seus tanques daqui rendem como a sua média (' + u.tanks + ' tanques).' };
  if (u.delta > 0) return { tone: 'ok', text: 'Seus tanques daqui rendem ' + pct + '% acima da sua média (' + u.tanks + ' tanques).' };
  return {
    tone: pct >= 5 && u.tanks >= 3 ? 'bad' : 'neutral',
    text: 'Seus tanques daqui rendem ' + pct + '% abaixo da sua média (' + u.tanks + ' tanques)' + (pct >= 5 && u.tanks >= 3 ? ': pode ser combustível ou bomba; vale comparar com outro posto.' : '.'),
  };
}

export interface Recommendation {
  /** Sugerida: menor custo ajustado (preço, combustível, desvio e rendimento, pesados pela confiabilidade e pela idade do preço). */
  best: Option | null;
  /** Menor custo puro entre as opções aceitáveis (pode ser a própria sugerida). */
  cheapest: Option | null;
  /** Melhor opção do outro combustível (para mostrar quanto a escolha economiza). */
  bestOther: Option | null;
  /** Opção mais barata deixada de lado por confiabilidade baixa, para avisar. */
  cheaperUnsafe: Option | null;
  considered: number;
}

export function recommend(rows: StationRow[]): Recommendation {
  const all = rows.flatMap((r) => r.opts).filter((o) => !o.stale);
  const good = all.filter((o) => o.rel.level !== 'evitar').sort((a, b) => a.value - b.value || a.cost - b.cost);
  const best = good[0] ?? null;
  const cheapest = good.slice().sort((a, b) => a.cost - b.cost || a.value - b.value)[0] ?? null;
  const bestOther = best ? good.find((o) => o.fuel !== best.fuel) ?? null : null;
  const unsafe = all.filter((o) => o.rel.level === 'evitar').sort((a, b) => a.cost - b.cost)[0] ?? null;
  return { best, cheapest, bestOther, cheaperUnsafe: unsafe && cheapest && unsafe.cost < cheapest.cost ? unsafe : null, considered: good.length };
}

/* ---------- casar postos do Google com os da ANP (src/casar.ts, também usado no servidor) ---------- */
export { matchScore, bestForStation, matchGoogle, nameTokens, streetTokens, houseNumber, sameSpot, rankForStation } from './casar.ts';
export type { GooglePhoto, GoogleStation, GoogleMatch } from './casar.ts';

/**
 * Nome do posto quando não há o do Google: o da ANP, mas sem uma bandeira que o posto já não tem
 * ("Posto Ipiranga" que hoje é Shell vira "Posto Shell"). A ANP demora a atualizar o nome; a bandeira, não.
 */
export function anpName(s: Pick<Station, 'n' | 'b'>): string {
  const BIG: Record<string, string> = { shell: 'Shell', raizen: 'Shell', ipiranga: 'Ipiranga', petrobras: 'Petrobras', br: 'Petrobras', vibra: 'Petrobras', ale: 'Ale', alesat: 'Ale' };
  if (!['Shell', 'Ipiranga', 'Petrobras', 'Ale'].includes(s.b)) return s.n;
  let changed = false;
  const out = s.n.replace(/[A-Za-zÀ-ÿ]+/g, (w) => {
    const k = w.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    if (BIG[k] && BIG[k] !== s.b) { changed = true; return s.b; }
    return w;
  });
  return changed ? out.replace(new RegExp('\\b(' + s.b + ')(\\s+\\1\\b)+', 'g'), '$1') : s.n;
}
