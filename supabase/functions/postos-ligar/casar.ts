// Liga lugares do Google (Places) aos postos do cadastro da ANP: endereço, nome, bandeira e distância.
// Usado no app (src/postos.ts) e na função que liga os postos da região ao Google uma vez por mês
// (supabase/functions/postos-ligar/casar.ts é cópia idêntica: rode `cp src/casar.ts supabase/functions/postos-ligar/casar.ts`).

/** O que a comparação precisa saber de um posto da ANP. */
export interface StationLike { c: string; n: string; e: string; b: string; la: number; lo: number; pg?: string }

function distKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface GooglePhoto { name: string; author: string; authorUri: string }
export interface GoogleStation { id: string; name: string; address: string; lat: number; lon: number; rating: number | null; count: number; photo?: GooglePhoto | null }
export interface GoogleMatch { id: string; name: string; rating: number | null; count: number; lat: number; lon: number; photo?: GooglePhoto | null }

const STOP = new Set('posto postos auto autoposto ltda me epp eireli sa s a comercio com de da do das dos e combustiveis combustivel derivados petroleo servicos servico serv conveniencia rede abastecimento center centro and the loja filial'.split(' '));
const BRANDS: Record<string, string> = { shell: 'Shell', raizen: 'Shell', ipiranga: 'Ipiranga', petrobras: 'Petrobras', br: 'Petrobras', vibra: 'Petrobras', ale: 'Ale', alesat: 'Ale' };

function words(s: string): string[] {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}
export function nameTokens(s: string) {
  return words(s).filter((w) => w.length >= 3 && !STOP.has(w) && !BRANDS[w] && !/^\d+$/.test(w));
}
function brandOf(s: string): string | null {
  for (const w of words(s)) if (BRANDS[w]) return BRANDS[w];
  return null;
}

// Endereços da ANP vêm abreviados ("Rod", "Gal", "Dep") e o Google às vezes também ("R.", "Av."):
// expande antes de comparar, e ignora o tipo de via, que sozinho não prova nada.
const ABBR: Record<string, string> = {
  r: 'rua', rod: 'rodovia', av: 'avenida', avda: 'avenida', al: 'alameda', tv: 'travessa', trav: 'travessa', est: 'estrada', estr: 'estrada',
  pc: 'praca', pca: 'praca', gal: 'general', gen: 'general', dep: 'deputado', dr: 'doutor', sen: 'senador', pres: 'presidente',
  prof: 'professor', eng: 'engenheiro', cel: 'coronel', cap: 'capitao', ten: 'tenente', maj: 'major', mal: 'marechal', gov: 'governador',
  sta: 'santa', sto: 'santo', s: 'sao', n: 'nossa', sra: 'senhora', pe: 'padre', vig: 'vigario', ver: 'vereador', des: 'desembargador',
};
const STREET_TYPES = new Set(['rua', 'rodovia', 'avenida', 'alameda', 'travessa', 'estrada', 'praca', 'servidao', 'beco', 'largo', 'via', 'acesso', 'marginal', 'contorno']);

/** Palavras do endereço que identificam a via (rodovias viram "sc401", "br101"). */
export function streetTokens(addr: string): string[] {
  const hw = [...addr.matchAll(/\b(br|sc|rs|pr|sp)\s*-?\s*(\d{3})\b/gi)].map((m) => m[1].toLowerCase() + m[2]);
  const ws = words(addr).map((w) => ABBR[w] ?? w).filter((w) => w.length >= 3 && !STREET_TYPES.has(w) && !STOP.has(w) && !/^\d+$/.test(w) && !/^(sc|br)\d{3}$/.test(w));
  return [...new Set([...hw, ...ws])];
}
/** Número do endereço da ANP ("Rua X, 1619", "Rod SC-401, Km 5", "Av Y, nº 300 - Loja 2"). */
export function houseNumber(addr: string): string | null {
  const m = /,\s*(?:n[º°o.]?\s*|km\s*)?(\d{1,6})\b/i.exec(addr) ?? /\bkm\s*(\d{1,4})\b/i.exec(addr);
  return m ? m[1] : null;
}
function addressEvidence(g: GoogleStation, s: StationLike) {
  const gTokens = new Set(streetTokens(g.address));
  const gWords = words(g.address);
  const num = houseNumber(s.e);
  const street = streetTokens(s.e.replace(/,.*$/, '')).filter((w) => gTokens.has(w)).length;
  return { num: !!num && gWords.includes(num), street };
}

/** Pontua o quanto um lugar do Google parece ser este posto (endereço, nome, bandeira e distância). */
export function matchScore(g: GoogleStation, s: StationLike): number {
  const d = distKm({ lat: s.la, lon: s.lo }, g);
  const ev = addressEvidence(g, s);
  const addr = ev.num && ev.street >= 1;
  // endereço completo bate: o ponto da ANP pode estar bem longe (geocodificação de rodovia, bairro);
  // sem isso, o ponto pela rua/número pode estar até 1 km longe e pelo bairro, até 2,5 km
  const maxD = addr ? 15 : s.pg === 'n' ? 1.0 : 2.5;
  if (d > maxD) return 0;
  const gName = new Set(nameTokens(g.name));
  const overlap = nameTokens(s.n).filter((w) => gName.has(w)).length;
  const gBrand = brandOf(g.name), sBrand = s.b in { Shell: 1, Ipiranga: 1, Petrobras: 1, Ale: 1 } ? s.b : null;
  const streetOnly = !addr && ev.street >= 2;
  let score = (addr ? 3 : streetOnly ? 1.2 : 0) + Math.min(overlap, 2) * 1.5 + (gBrand && gBrand === sBrand ? 1 : 0);
  score += d < 0.1 ? 2 : d < 0.25 ? 1.2 : d < 0.5 ? 0.6 : 0;
  if (gBrand && sBrand && gBrand !== sBrand) score -= 2;
  const evidence = addr || overlap > 0 || streetOnly || (gBrand && gBrand === sBrand) || d < 0.15;
  return evidence && score >= 1.5 ? score : 0;
}

/**
 * Resultados de uma busca feita para ESTE posto (pelo endereço dele, só postos de combustível), do mais
 * parecido para o menos. Além das regras gerais, aceita o posto do Google mais perto do ponto quando está
 * bem perto e não é de outra bandeira (com nota baixa): a busca já veio filtrada pelo endereço.
 */
export function rankForStation(places: GoogleStation[], s: StationLike): { g: GoogleStation; v: number }[] {
  const sBrand = s.b in { Shell: 1, Ipiranga: 1, Petrobras: 1, Ale: 1 } ? s.b : null;
  const out: { g: GoogleStation; v: number }[] = [];
  for (const g of places) {
    if (!Number.isFinite(g.lat) || !Number.isFinite(g.lon)) continue;
    let v = matchScore(g, s);
    if (!v) {
      const d = distKm({ lat: s.la, lon: s.lo }, g);
      const gBrand = brandOf(g.name);
      if (d <= (s.pg === 'n' ? 0.35 : 0.8) && !(gBrand && sBrand && gBrand !== sBrand)) v = 1 - d;
    }
    if (v > 0) out.push({ g, v });
  }
  return out.sort((a, b) => b.v - a.v);
}

/** O melhor resultado de uma busca feita para este posto (veja rankForStation). */
export function bestForStation(places: GoogleStation[], s: StationLike): GoogleMatch | null {
  const best = rankForStation(places, s)[0]?.g;
  return best ? { id: best.id, name: best.name, rating: best.rating, count: best.count, lat: best.lat, lon: best.lon, photo: best.photo ?? null } : null;
}

/** Liga cada lugar do Google a no máximo um posto da ANP (os pares mais parecidos primeiro). */
export function matchGoogle(places: GoogleStation[], stations: StationLike[]): Map<string, GoogleMatch> {
  const pairs: { g: GoogleStation; s: StationLike; v: number }[] = [];
  for (const g of places) {
    if (!Number.isFinite(g.lat) || !Number.isFinite(g.lon)) continue;
    for (const s of stations) {
      const v = matchScore(g, s);
      if (v > 0) pairs.push({ g, s, v });
    }
  }
  pairs.sort((a, b) => b.v - a.v);
  const usedG = new Set<string>(), out = new Map<string, GoogleMatch>();
  for (const { g, s } of pairs) {
    if (usedG.has(g.id) || out.has(s.c)) continue;
    usedG.add(g.id);
    out.set(s.c, { id: g.id, name: g.name, rating: g.rating, count: g.count, lat: g.lat, lon: g.lon, photo: g.photo ?? null });
  }
  return out;
}
