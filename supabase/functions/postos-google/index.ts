// Edge Function: dados do Google Places para o app (só usuários logados, verify_jwt).
// Custo zero: cada pedido ao Google passa antes pelo orçamento do app inteiro (consume_google_budget), que
// nunca deixa um tipo de chamada (SKU) passar da faixa grátis do mês. Nota e avaliações só vêm nas chamadas
// próprias (nota, avaliacoes), que têm a faixa grátis menor; as buscas trazem nome, endereço, ponto e foto.
//  - mode "nearby":  postos perto de um ponto, com nome, endereço e foto (sem nota: SKU Pro);
//  - mode "nota":    nota e número de avaliações de um posto pelo place_id (SKU Enterprise);
//  - mode "posto":   procura um posto específico pelo endereço (quando o "nearby" não achou);
//  - mode "address": busca de endereço para cadastrar casa e trabalho;
//  - mode "photo":   link temporário de uma foto do posto (sem expor a chave);
//  - mode "lugar":   nome, endereço e foto de um posto já ligado ao Google (pelo place_id; sem nota: SKU Pro);
//  - mode "avaliacoes": até 5 avaliações do Google (as que ele escolhe), com data, e o link para ver todas
//    no Google Maps. Só quando a pessoa toca na nota; nada disso é guardado;
//  - mode "mapa":    a chave do mapa do Google na ficha (Maps Embed API, grátis e sem limite). É uma chave de
//    navegador, que aparece no mapa de qualquer jeito; fica no segredo GOOGLE_EMBED_KEY para não ir para o
//    repositório, restrita no Google Cloud à Maps Embed API e ao endereço do app;
//  - mode "autocomplete" + "details": sugestões enquanto a pessoa digita o endereço (Places Autocomplete,
//    com token de sessão: as sugestões e o detalhe escolhido contam como uma sessão no Google).
// A chave fica no segredo GOOGLE_MAPS_API_KEY; sem ela, devolve { configured: false }.
// Nada é guardado no servidor e nenhuma localização vai para o log.
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

const ALLOWED_ORIGINS = ['https://henriqueklock.github.io', 'http://localhost:5173', 'http://localhost:4173'];
const PLACES = 'https://places.googleapis.com/v1/places:';
// Só campos do SKU Pro (nota e número de avaliações são Enterprise e vêm à parte, no modo "nota")
const STATION_FIELDS = 'places.id,places.displayName,places.location,places.formattedAddress,places.photos';
const ADDRESS_FIELDS = 'places.id,places.displayName,places.location,places.formattedAddress,places.addressComponents,places.types';

function cors(origin: string | null) {
  return {
    'Access-Control-Allow-Origin': origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
}

/** Exige um usuário logado de verdade. O gateway aceita a chave publicável como se fosse login (papel anon). */
async function currentUser(req: Request): Promise<string | null> {
  const url = Deno.env.get('SUPABASE_URL');
  const auth = req.headers.get('authorization') ?? '';
  const apikey = req.headers.get('apikey') ?? Deno.env.get('SUPABASE_ANON_KEY') ?? '';
  if (!url || !/^Bearer eyJ/.test(auth)) return null;
  try {
    const r = await fetch(url + '/auth/v1/user', { headers: { apikey, Authorization: auth } });
    if (!r.ok) return null;
    const u = await r.json();
    return typeof u?.id === 'string' ? u.id : null;
  } catch {
    return null;
  }
}

/** Cota diária por usuário (tabela api_usage). Sem confirmação da cota, não chama o serviço pago. */
async function withinQuota(req: Request, fn: string, max: number): Promise<boolean> {
  const url = Deno.env.get('SUPABASE_URL');
  const apikey = req.headers.get('apikey') ?? Deno.env.get('SUPABASE_ANON_KEY') ?? '';
  const auth = req.headers.get('authorization') ?? '';
  if (!url || !auth) return false;
  try {
    const r = await fetch(url + '/rest/v1/rpc/consume_quota', {
      method: 'POST',
      headers: { apikey, Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_fn: fn, p_max: max }),
    });
    return r.ok && (await r.json()) === true;
  } catch {
    return false;
  }
}

// Por pessoa e por dia (para uma pessoa não gastar a faixa grátis de todo mundo)
const LIMITS: Record<string, number> = { nearby: 25, posto: 15, address: 30, photo: 10, autocomplete: 150, details: 30, lugar: 30, nota: 10, avaliacoes: 8 };

/**
 * Faixa grátis do Google por SKU (por mês), com 5% de folga, e um teto por dia para durar o mês todo.
 * Valores da tabela de preços de out/2026: Essentials 10 mil, Pro 5 mil, Enterprise mil chamadas por mês.
 */
const BUDGET: Record<string, { day: number; month: number }> = {
  nearby_pro: { day: 150, month: 4750 }, // busca por perto (Pro)
  text_pro: { day: 150, month: 4750 }, // busca por texto: posto, endereço e a ligação noturna (Pro)
  details_pro: { day: 150, month: 4750 }, // lugar pelo id e detalhe do endereço (Pro)
  details_ent: { day: 30, month: 950 }, // nota pelo id (Enterprise)
  details_atm: { day: 30, month: 950 }, // avaliações (Enterprise + Atmosphere)
  photo: { day: 30, month: 950 }, // foto (Place Details Photos)
  autocomplete: { day: 300, month: 9500 }, // sugestões de endereço (Essentials)
};
const SKU: Record<string, string> = { nearby: 'nearby_pro', posto: 'text_pro', address: 'text_pro', lugar: 'details_pro', details: 'details_pro', nota: 'details_ent', avaliacoes: 'details_atm', photo: 'photo', autocomplete: 'autocomplete' };
const FREE_OVER = 'O limite gratuito do Google de hoje acabou. Volta amanhã.';

/** Orçamento do app inteiro (custo zero): só a chave de serviço chama. Sem confirmação, não chama o Google. */
async function withinBudget(mode: string): Promise<boolean> {
  const url = Deno.env.get('SUPABASE_URL'), key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const b = BUDGET[SKU[mode]];
  if (!url || !key || !b) return false;
  try {
    const r = await fetch(url + '/rest/v1/rpc/consume_google_budget', {
      method: 'POST',
      headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_sku: SKU[mode], p_day_max: b.day, p_month_max: b.month }),
    });
    return r.ok && (await r.json()) === true;
  } catch {
    return false;
  }
}
/** Cota da pessoa e depois o orçamento do app; devolve a mensagem quando não pode chamar o Google. */
async function allowed(req: Request, mode: string, personal: string): Promise<string | null> {
  if (!(await withinQuota(req, 'google_' + mode, LIMITS[mode]))) return personal;
  if (!(await withinBudget(mode))) {
    console.log(JSON.stringify({ event: 'postos-google-orcamento', sku: SKU[mode] }));
    return FREE_OVER;
  }
  return null;
}

const inBrazil = (lat: number, lon: number) => lat >= -34 && lat <= 6 && lon >= -74 && lon <= -34;

function station(p: any) {
  return {
    id: p.id,
    name: p.displayName?.text ?? '',
    address: p.formattedAddress ?? '',
    lat: p.location?.latitude,
    lon: p.location?.longitude,
    rating: typeof p.rating === 'number' ? p.rating : null,
    count: p.userRatingCount ?? 0,
    photo: p.photos?.[0]
      ? { name: p.photos[0].name, author: p.photos[0].authorAttributions?.[0]?.displayName ?? '', authorUri: p.photos[0].authorAttributions?.[0]?.uri ?? '' }
      : null,
  };
}

function address(p: any) {
  const comp = (type: string) => (p.addressComponents ?? []).find((c: any) => (c.types ?? []).includes(type))?.longText ?? '';
  return {
    id: p.id,
    name: p.displayName?.text ?? '',
    address: p.formattedAddress ?? '',
    lat: p.location?.latitude,
    lon: p.location?.longitude,
    route: comp('route'),
    hood: comp('sublocality_level_1') || comp('sublocality') || comp('neighborhood'),
    city: comp('administrative_area_level_2') || comp('locality'),
    state: (p.addressComponents ?? []).find((c: any) => (c.types ?? []).includes('administrative_area_level_1'))?.shortText ?? '',
    types: p.types ?? [],
  };
}

Deno.serve(async (req) => {
  const headers = cors(req.headers.get('origin'));
  if (req.method === 'OPTIONS') return new Response('ok', { headers });
  const json = (status: number, data: unknown) =>
    new Response(JSON.stringify(data), { status, headers: { ...headers, 'Content-Type': 'application/json' } });
  if (req.method !== 'POST') return json(405, { error: 'Use POST.' });

  if (!(await currentUser(req))) return json(401, { error: 'Entre na sua conta para usar esta função.' });

  const key = Deno.env.get('GOOGLE_MAPS_API_KEY');
  if (!key) return json(200, { configured: false, places: [] });

  let b: any;
  try {
    b = await req.json();
  } catch {
    return json(400, { error: 'Corpo inválido.' });
  }
  const mode = b.mode ?? 'nearby';
  if (mode === 'mapa') {
    const k = Deno.env.get('GOOGLE_EMBED_KEY') ?? '';
    return json(200, { configured: !!k, key: k || null });
  }
  const lat = Number(b.lat), lon = Number(b.lon);
  const hasPoint = Number.isFinite(lat) && Number.isFinite(lon) && inBrazil(lat, lon);

  if (mode === 'photo') {
    const name = String(b.name ?? '');
    if (!/^places\/[A-Za-z0-9_-]{10,}\/photos\/[A-Za-z0-9_-]{10,}$/.test(name)) return json(400, { error: 'Foto inválida.' });
    const no = await allowed(req, 'photo', 'Limite diário de fotos do Google atingido para esta conta. Tente amanhã.');
    if (no) return json(429, { error: no });
    const r = await fetch('https://places.googleapis.com/v1/' + name + '/media?maxWidthPx=800&maxHeightPx=500&skipHttpRedirect=true', { headers: { 'X-Goog-Api-Key': key } });
    if (!r.ok) {
      console.error(JSON.stringify({ event: 'postos-google-error', mode, status: r.status }));
      return json(r.status === 429 ? 429 : 502, { error: r.status === 429 ? FREE_OVER : 'O Google não devolveu a foto agora.' });
    }
    const d = await r.json();
    return json(200, { configured: true, uri: d.photoUri ?? null });
  }

  if (mode === 'lugar' || mode === 'avaliacoes' || mode === 'nota') {
    const id = String(b.id ?? '');
    if (!/^[A-Za-z0-9_-]{10,300}$/.test(id)) return json(400, { error: 'Lugar inválido.' });
    const no = await allowed(req, mode, mode === 'avaliacoes' ? 'Limite diário de avaliações do Google atingido para esta conta. Tente amanhã.' : mode === 'nota' ? 'Limite diário de notas do Google atingido para esta conta. Tente amanhã.' : 'Limite diário de buscas no Google atingido para esta conta. Tente amanhã.');
    if (no) return json(429, { error: no });
    const mask = mode === 'lugar'
      ? STATION_FIELDS.replace(/places\./g, '')
      : mode === 'nota' ? 'rating,userRatingCount'
      : 'rating,userRatingCount,reviews,googleMapsUri,googleMapsLinks';
    const r = await fetch('https://places.googleapis.com/v1/places/' + id + '?languageCode=pt-BR&regionCode=BR', { headers: { 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': mask } });
    if (!r.ok) {
      console.error(JSON.stringify({ event: 'postos-google-error', mode, status: r.status }));
      return json(r.status === 429 ? 429 : 502, { error: r.status === 429 ? FREE_OVER : 'O Google não respondeu agora.' });
    }
    const p = await r.json();
    if (mode === 'lugar') return json(200, { configured: true, places: [station(p)] });
    if (mode === 'nota') return json(200, { configured: true, rating: typeof p.rating === 'number' ? p.rating : null, count: p.userRatingCount ?? 0 });
    const reviews = (p.reviews ?? []).map((v: any) => ({
      rating: typeof v.rating === 'number' ? v.rating : null,
      time: v.publishTime ?? null,
      rel: v.relativePublishTimeDescription ?? '',
      text: v.text?.text ?? v.originalText?.text ?? '',
      author: v.authorAttribution?.displayName ?? '',
      authorUri: v.authorAttribution?.uri ?? '',
      uri: v.googleMapsUri ?? '',
    }));
    return json(200, { configured: true, rating: typeof p.rating === 'number' ? p.rating : null, count: p.userRatingCount ?? 0, uri: p.googleMapsUri ?? '', reviewsUri: p.googleMapsLinks?.reviewsUri ?? '', reviews });
  }

  const token = String(b.session ?? '');
  const validToken = /^[A-Za-z0-9_-]{16,64}$/.test(token);

  if (mode === 'autocomplete') {
    const q = String(b.query ?? '').trim().slice(0, 120);
    if (q.length < 3 || !validToken) return json(400, { error: 'Busca muito curta.' });
    const no = await allowed(req, 'autocomplete', 'Limite diário de sugestões do Google atingido para esta conta. Tente amanhã.');
    if (no) return json(429, { error: no });
    const body: Record<string, unknown> = { input: q, sessionToken: token, languageCode: 'pt-BR', regionCode: 'BR', includedRegionCodes: ['br'] };
    if (hasPoint) body.locationBias = { circle: { center: { latitude: lat, longitude: lon }, radius: 30000 } };
    const r = await fetch(PLACES + 'autocomplete', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key }, body: JSON.stringify(body) });
    if (!r.ok) {
      console.error(JSON.stringify({ event: 'postos-google-error', mode, status: r.status }));
      return json(r.status === 429 ? 429 : 502, { error: r.status === 429 ? FREE_OVER : 'O Google não respondeu agora.' });
    }
    const d = await r.json();
    const places = (d.suggestions ?? [])
      .map((x: any) => x.placePrediction)
      .filter(Boolean)
      .slice(0, 6)
      .map((p: any) => ({ id: p.placeId, main: p.structuredFormat?.mainText?.text ?? p.text?.text ?? '', secondary: p.structuredFormat?.secondaryText?.text ?? '' }));
    return json(200, { configured: true, places });
  }

  if (mode === 'details') {
    const id = String(b.id ?? '');
    if (!/^[A-Za-z0-9_-]{10,300}$/.test(id) || !validToken) return json(400, { error: 'Lugar inválido.' });
    const no = await allowed(req, 'details', 'Limite diário de buscas no Google atingido para esta conta. Tente amanhã.');
    if (no) return json(429, { error: no });
    const r = await fetch('https://places.googleapis.com/v1/places/' + id + '?languageCode=pt-BR&regionCode=BR&sessionToken=' + token, {
      headers: { 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': ADDRESS_FIELDS.replace(/places\./g, '') },
    });
    if (!r.ok) {
      console.error(JSON.stringify({ event: 'postos-google-error', mode, status: r.status }));
      return json(r.status === 429 ? 429 : 502, { error: 'O Google não respondeu agora.' });
    }
    return json(200, { configured: true, places: [address(await r.json())] });
  }

  let url: string, fields: string, body: Record<string, unknown>;
  if (mode === 'nearby') {
    if (!hasPoint) return json(400, { error: 'Envie lat e lon de um ponto no Brasil.' });
    const radius = Math.min(Math.max(Number(b.radius_m) || 3000, 200), 20000);
    url = PLACES + 'searchNearby';
    fields = STATION_FIELDS;
    body = { includedTypes: ['gas_station'], maxResultCount: 20, rankPreference: 'DISTANCE', languageCode: 'pt-BR', regionCode: 'BR', locationRestriction: { circle: { center: { latitude: lat, longitude: lon }, radius } } };
  } else if (mode === 'posto' || mode === 'address') {
    const q = String(b.query ?? '').trim().slice(0, 200);
    if (q.length < 3) return json(400, { error: 'Busca muito curta.' });
    url = PLACES + 'searchText';
    fields = mode === 'posto' ? STATION_FIELDS : ADDRESS_FIELDS;
    body = { textQuery: q, languageCode: 'pt-BR', regionCode: 'BR', pageSize: mode === 'posto' ? 5 : 6 };
    if (mode === 'posto') body.includedType = 'gas_station';
    if (hasPoint) body.locationBias = { circle: { center: { latitude: lat, longitude: lon }, radius: mode === 'posto' ? 3000 : 30000 } };
  } else {
    return json(400, { error: 'Modo desconhecido.' });
  }

  const no = await allowed(req, mode, 'Limite diário de buscas no Google atingido para esta conta. Tente amanhã.');
  if (no) return json(429, { error: no });
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': fields }, body: JSON.stringify(body) });
  if (!r.ok) {
    console.error(JSON.stringify({ event: 'postos-google-error', mode, status: r.status, body: (await r.text()).slice(0, 300) }));
    if (r.status === 429) return json(429, { error: FREE_OVER });
    return json(502, { error: 'O Google não respondeu agora.' });
  }
  const data = await r.json();
  const places = (data.places ?? []).map(mode === 'address' ? address : station);
  console.log(JSON.stringify({ event: 'postos-google', mode, n: places.length }));
  return json(200, { configured: true, places });
});
