// Edge Function (pg_cron, uma vez por dia): liga os postos da Grande Florianópolis aos lugares do Google.
// Guarda só o par CNPJ → place_id (os termos do Google permitem guardar o place_id sem prazo; nota, nome e
// avaliações não são guardados). Cada posto é conferido de novo a cada 30 dias, em lotes, para caber na
// cota gratuita. O app usa o place_id para casar a busca por perto sem adivinhação e pedir a nota do posto
// direto pelo id. Postos corrigidos pelas pessoas no app (source = 'pessoas') ficam como estão.
// Só aceita chamada com o cabeçalho x-cron igual ao segredo de push_keys (só o banco conhece).
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { brandConflict, nameTokens, rankForStation, sameSpot, type GoogleStation, type StationLike } from './casar.ts';

const URL_ = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const KEY = Deno.env.get('GOOGLE_MAPS_API_KEY') ?? '';
const DATA = 'https://henriqueklock.github.io/encheai/dados/postos-SC.json';
const REGIAO = ['florianopolis', 'sao jose', 'palhoca', 'biguacu', 'santo amaro da imperatriz', 'governador celso ramos', 'antonio carlos'];
const LOTE = 80;
const REVER_DIAS = 30;
const admin = { apikey: SERVICE, Authorization: 'Bearer ' + SERVICE, 'Content-Type': 'application/json' };
const norm = (t: string) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

async function rest(path: string, init: RequestInit = {}) {
  const r = await fetch(URL_ + '/rest/v1/' + path, { ...init, headers: { ...admin, ...(init.headers ?? {}) } });
  if (!r.ok) throw new Error('rest ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

function timingSafe(a: string, b: string) {
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** Busca por texto, só postos de combustível perto do ponto da ANP (SKU Pro: sem nota nem foto). */
async function search(q: string, s: StationLike): Promise<GoogleStation[]> {
  const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': KEY, 'X-Goog-FieldMask': 'places.id,places.displayName,places.location,places.formattedAddress,places.businessStatus' },
    body: JSON.stringify({ textQuery: q, includedType: 'gas_station', languageCode: 'pt-BR', regionCode: 'BR', pageSize: 5, locationBias: { circle: { center: { latitude: s.la, longitude: s.lo }, radius: 3000 } } }),
  });
  if (!r.ok) throw new Error('google ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const d = await r.json();
  return (d.places ?? []).map((p: any) => ({ id: p.id, name: p.displayName?.text ?? '', address: p.formattedAddress ?? '', lat: p.location?.latitude, lon: p.location?.longitude, rating: null, count: 0, status: p.businessStatus ?? '' }));
}

/** Quantas avaliações e se está aberto (Place Details; só nos empates, que são raros). */
async function popularity(id: string): Promise<{ count: number; status: string }> {
  const r = await fetch('https://places.googleapis.com/v1/places/' + id, { headers: { 'X-Goog-Api-Key': KEY, 'X-Goog-FieldMask': 'userRatingCount,businessStatus' } });
  if (!r.ok) throw new Error('google ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const p = await r.json();
  return { count: p.userRatingCount ?? 0, status: p.businessStatus ?? '' };
}

type Cand = { g: GoogleStation; v: number; count?: number };
/**
 * Ordem final dos candidatos: tira os fechados de vez e, quando há dois cadastros no mesmo ponto (o posto
 * trocou de nome ou de bandeira e o Google ficou com o antigo ao lado do novo), fica com o que está aberto
 * e tem mais avaliações. O nome antigo costuma bater melhor com a ANP, que demora a atualizar.
 */
async function order(cands: Cand[], s: StationLike): Promise<Cand[]> {
  const open = cands.filter((c) => c.g.status !== 'CLOSED_PERMANENTLY');
  if (open.length < 2) return open;
  const top = open[0];
  // cadastro com outra bandeira no nome não entra no desempate (pode ser o posto vizinho)
  const twins = open.filter((c) => c !== top && sameSpot(top.g, c.g, s) && !brandConflict(c.g, s) && c.v >= top.v - 2.5).slice(0, 2);
  if (!twins.length) return open;
  const group: Cand[] = [top, ...twins];
  for (const c of group) {
    const p = await popularity(c.g.id);
    c.count = p.count;
    if (p.status) c.g.status = p.status;
  }
  const rank = (c: Cand) => (c.g.status === 'OPERATIONAL' || !c.g.status ? 0 : 1);
  group.sort((a, b) => rank(a) - rank(b) || (b.count ?? 0) - (a.count ?? 0) || b.v - a.v);
  return [...group, ...open.filter((c) => !group.includes(c))];
}

type Owner = { station_id: string; score: number };
/**
 * Mesmo caminho da ficha no app: primeiro pelo endereço da ANP, depois pelo nome. Um lugar do Google fica
 * com um posto só: se outro posto já tem o lugar com nota maior, tenta o próximo candidato; se tem nota
 * menor, este posto fica com o lugar e o outro volta para a fila (é revisto na próxima rodada).
 */
async function link(s: StationLike & { br?: string; m: string }, owners: Map<string, Owner>, log?: unknown[]): Promise<{ id: string; score: number; evict?: string } | null> {
  const pick = (cands: Cand[]) => {
    log?.push(cands.map((c) => ({ id: c.g.id, name: c.g.name, address: c.g.address, status: c.g.status, score: Math.round(c.v * 100) / 100, count: c.count })));
    for (const { g, v } of cands) {
      const o = owners.get(g.id);
      if (!o || o.station_id === s.c) return { id: g.id, score: v };
      if (o.score < v) return { id: g.id, score: v, evict: o.station_id };
    }
    return null;
  };
  let hit = pick(await order(rankForStation(await search('posto de combustível ' + s.e + ', ' + (s.br ? s.br + ', ' : '') + s.m + ' - SC', s), s), s));
  if (!hit && nameTokens(s.n).length) hit = pick(await order(rankForStation(await search(s.n + ', ' + s.m + ' - SC', s), s), s));
  return hit;
}

Deno.serve(async (req) => {
  const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  if (req.method !== 'POST') return json(405, { error: 'Use POST.' });
  try {
    const given = req.headers.get('x-cron') ?? '';
    const secret: string = (await rest('push_keys?id=eq.1&select=cron_secret'))?.[0]?.cron_secret ?? '';
    if (!secret || given.length !== secret.length || !timingSafe(given, secret)) return json(401, { error: 'Não autorizado.' });
    if (!KEY) return json(200, { configured: false });

    // { only: [CNPJ], dry: true } confere só esses postos agora; com dry, mostra os candidatos sem gravar.
    // { since: data } revê (em lotes) tudo o que foi conferido antes dessa data, como depois de mudar a regra.
    let b: { only?: unknown; dry?: unknown; since?: unknown } = {};
    try { b = await req.json(); } catch { /* corpo vazio do pg_cron */ }
    const only = Array.isArray(b.only) ? b.only.filter((x): x is string => typeof x === 'string' && /^\d{14}$/.test(x)).slice(0, 10) : null;
    const dry = b.dry === true;

    const file = await (await fetch(DATA)).json();
    const region = (file.postos as (StationLike & { br?: string; m: string })[]).filter((s) => REGIAO.includes(norm(s.m)));
    const rows = (await rest('station_places?select=station_id,place_id,checked_at,score,source')) as { station_id: string; place_id: string | null; checked_at: string; score: number | null; source: string }[];
    const done = new Map<string, string>(rows.map((r) => [r.station_id, r.checked_at]));
    // o que as pessoas corrigiram no app não é revisto pela busca, e o lugar delas não é tomado por outro posto
    const byPeople = new Set(rows.filter((r) => r.source === 'pessoas').map((r) => r.station_id));
    const owners = new Map<string, Owner>(rows.filter((r) => r.place_id).map((r) => [r.place_id!, { station_id: r.station_id, score: r.source === 'pessoas' ? 1000 : r.score ?? 0 }]));
    const since = typeof b.since === 'string' && !isNaN(Date.parse(b.since)) ? new Date(b.since).toISOString() : null;
    const limit = since ?? new Date(Date.now() - REVER_DIAS * 864e5).toISOString();
    const due = only
      ? region.filter((s) => only.includes(s.c))
      : region.filter((s) => !byPeople.has(s.c) && (!done.has(s.c) || done.get(s.c)! < limit)).sort((a, b) => (done.get(a.c) ?? '').localeCompare(done.get(b.c) ?? '')).slice(0, LOTE);

    if (dry) {
      const out = [];
      for (const s of due) {
        const log: unknown[] = [];
        const hit = await link(s, new Map(owners), log);
        out.push({ station: s.c, name: s.n, address: s.e, brand: s.b, now: rows.find((r) => r.station_id === s.c) ?? null, hit, candidates: log });
      }
      return json(200, { dry: true, stations: out });
    }

    let matched = 0, failed = 0;
    for (const s of due) {
      try {
        if (byPeople.has(s.c)) continue;
        for (const [pid, o] of owners) if (o.station_id === s.c) owners.delete(pid);
        const hit = await link(s, owners);
        if (hit) {
          matched++;
          if (hit.evict && !byPeople.has(hit.evict)) {
            // o outro posto perde o lugar e volta para a fila
            await rest('station_places?station_id=eq.' + hit.evict, { method: 'PATCH', body: JSON.stringify({ place_id: null, score: null, checked_at: '2000-01-01T00:00:00Z' }) });
          }
          owners.set(hit.id, { station_id: s.c, score: hit.score });
        }
        await rest('station_places', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify({ station_id: s.c, place_id: hit?.id ?? null, score: hit?.score ?? null, checked_at: new Date().toISOString() }) });
      } catch (e) {
        failed++;
        console.error(JSON.stringify({ event: 'postos-ligar-erro', station: s.c, error: String(e).slice(0, 200) }));
        if (/google 429/.test(String(e))) break;
      }
    }
    const r = { region: region.length, pending: Math.max(0, region.filter((s) => !byPeople.has(s.c) && (!done.has(s.c) || done.get(s.c)! < limit)).length - due.length), checked: due.length - failed, matched, failed };
    console.log(JSON.stringify({ event: 'postos-ligar', ...r }));
    return json(200, r);
  } catch (e) {
    console.error(JSON.stringify({ event: 'postos-ligar-erro', error: String(e).slice(0, 300) }));
    return json(500, { error: 'Falhou.' });
  }
});
