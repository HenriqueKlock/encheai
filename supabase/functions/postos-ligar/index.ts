// Edge Function (pg_cron, uma vez por dia): liga os postos da Grande Florianópolis aos lugares do Google.
// Guarda só o par CNPJ → place_id (os termos do Google permitem guardar o place_id sem prazo; nota, nome e
// avaliações não são guardados). Cada posto é conferido de novo a cada 30 dias, em lotes, para caber na
// cota gratuita. O app usa o place_id para casar a busca por perto sem adivinhação e pedir a nota do posto
// direto pelo id. Só aceita chamada com o cabeçalho x-cron igual ao segredo de push_keys (só o banco conhece).
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { nameTokens, rankForStation, type GoogleStation, type StationLike } from './casar.ts';

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
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': KEY, 'X-Goog-FieldMask': 'places.id,places.displayName,places.location,places.formattedAddress' },
    body: JSON.stringify({ textQuery: q, includedType: 'gas_station', languageCode: 'pt-BR', regionCode: 'BR', pageSize: 5, locationBias: { circle: { center: { latitude: s.la, longitude: s.lo }, radius: 3000 } } }),
  });
  if (!r.ok) throw new Error('google ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const d = await r.json();
  return (d.places ?? []).map((p: any) => ({ id: p.id, name: p.displayName?.text ?? '', address: p.formattedAddress ?? '', lat: p.location?.latitude, lon: p.location?.longitude, rating: null, count: 0 }));
}

type Owner = { station_id: string; score: number };
/**
 * Mesmo caminho da ficha no app: primeiro pelo endereço da ANP, depois pelo nome. Um lugar do Google fica
 * com um posto só: se outro posto já tem o lugar com nota maior, tenta o próximo candidato; se tem nota
 * menor, este posto fica com o lugar e o outro volta para a fila (é revisto na próxima rodada).
 */
async function link(s: StationLike & { br?: string; m: string }, owners: Map<string, Owner>): Promise<{ id: string; score: number; evict?: string } | null> {
  const pick = (cands: { g: GoogleStation; v: number }[]) => {
    for (const { g, v } of cands) {
      const o = owners.get(g.id);
      if (!o || o.station_id === s.c) return { id: g.id, score: v };
      if (o.score < v) return { id: g.id, score: v, evict: o.station_id };
    }
    return null;
  };
  let hit = pick(rankForStation(await search('posto de combustível ' + s.e + ', ' + (s.br ? s.br + ', ' : '') + s.m + ' - SC', s), s));
  if (!hit && nameTokens(s.n).length) hit = pick(rankForStation(await search(s.n + ', ' + s.m + ' - SC', s), s));
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

    const file = await (await fetch(DATA)).json();
    const region = (file.postos as (StationLike & { br?: string; m: string })[]).filter((s) => REGIAO.includes(norm(s.m)));
    const rows = (await rest('station_places?select=station_id,place_id,checked_at,score')) as { station_id: string; place_id: string | null; checked_at: string; score: number | null }[];
    const done = new Map<string, string>(rows.map((r) => [r.station_id, r.checked_at]));
    const owners = new Map<string, Owner>(rows.filter((r) => r.place_id).map((r) => [r.place_id!, { station_id: r.station_id, score: r.score ?? 0 }]));
    const limit = new Date(Date.now() - REVER_DIAS * 864e5).toISOString();
    const due = region.filter((s) => !done.has(s.c) || done.get(s.c)! < limit).sort((a, b) => Number(done.has(a.c)) - Number(done.has(b.c))).slice(0, LOTE);

    let matched = 0, failed = 0;
    for (const s of due) {
      try {
        for (const [pid, o] of owners) if (o.station_id === s.c) owners.delete(pid);
        const hit = await link(s, owners);
        if (hit) {
          matched++;
          if (hit.evict) {
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
    const r = { region: region.length, pending: Math.max(0, region.filter((s) => !done.has(s.c) || done.get(s.c)! < limit).length - due.length), checked: due.length - failed, matched, failed };
    console.log(JSON.stringify({ event: 'postos-ligar', ...r }));
    return json(200, r);
  } catch (e) {
    console.error(JSON.stringify({ event: 'postos-ligar-erro', error: String(e).slice(0, 300) }));
    return json(500, { error: 'Falhou.' });
  }
});
