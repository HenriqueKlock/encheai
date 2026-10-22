import { createClient, type Session } from '@supabase/supabase-js';
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from './config';
import { db, getMeta, now, setMeta } from './db';
import { loginEmailError } from './auth-errors';
import { DEFAULT_HOME, isIndicatorId, type IndicatorId } from './indicators';

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  // Login pelo link do e-mail: o Supabase devolve a sessão no fragmento (#access_token=…) da URL do app
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit', storageKey: 'encheai-auth' },
});

/** Ordem pai → filho: o banco recusa um filho cujo pai ainda não subiu. */
export const TABLES = ['vehicles', 'fuel_logs', 'services', 'service_items'] as const;
type TableName = (typeof TABLES)[number];

const PUSH_CHUNK = 200;
const PULL_PAGE = 1000;
/** Margem de segurança no pull: relê 5 min antes do último marco (aplicar de novo é inofensivo). */
const PULL_OVERLAP_MS = 5 * 60 * 1000;

export type SyncStatus =
  | { kind: 'signed-out' }
  | { kind: 'offline' }
  | { kind: 'syncing' }
  | { kind: 'ok'; at: string }
  | { kind: 'error'; message: string };

let status: SyncStatus = { kind: 'signed-out' };
const listeners = new Set<(s: SyncStatus) => void>();
export function onSyncStatus(fn: (s: SyncStatus) => void) {
  listeners.add(fn);
  fn(status);
  return () => listeners.delete(fn);
}
function emit(s: SyncStatus) {
  status = s;
  listeners.forEach((fn) => fn(s));
}

const NUMERIC: Partial<Record<TableName, string[]>> = {
  fuel_logs: ['liters', 'total_brl', 'price_per_l'],
  service_items: ['parts_brl', 'labor_brl'],
};

function toRemote(t: TableName, row: Record<string, any>) {
  const { _dirty, ...r } = row;
  if (t === 'vehicles') r.archived = !!r.archived;
  return r;
}

function fromRemote(t: TableName, row: Record<string, any>): Record<string, any> {
  const { user_id, server_updated_at, ...r } = row;
  if (t === 'vehicles') r.archived = r.archived ? 1 : 0;
  for (const k of NUMERIC[t] ?? []) if (r[k] != null) r[k] = Number(r[k]);
  // timestamps vêm do Postgres com offset; normaliza para ISO em UTC, igual ao que o app grava
  for (const k of ['updated_at', 'deleted_at']) if (r[k]) r[k] = new Date(r[k]).toISOString();
  return { ...r, _dirty: 0 as const };
}

function friendly(err: unknown): string {
  const e = err as { message?: string; code?: string };
  const msg = e?.message ?? String(err);
  if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) return 'Sem conexão com o servidor';
  if (/JWT|token/i.test(msg)) return 'Sessão expirada; entre de novo';
  return msg;
}

async function push(t: TableName) {
  const table = db[t] as any;
  const rows: Record<string, any>[] = await table.where('_dirty').equals(1).toArray();
  for (let i = 0; i < rows.length; i += PUSH_CHUNK) {
    const chunk = rows.slice(i, i + PUSH_CHUNK);
    const { error } = await supabase.from(t).upsert(chunk.map((r) => toRemote(t, r)), { onConflict: 'id' });
    if (error) throw error;
    // Só limpa a marca se a linha não mudou enquanto o envio acontecia
    await db.transaction('rw', table, async () => {
      for (const r of chunk) {
        const cur = await table.get(r.id);
        if (cur && cur.updated_at === r.updated_at) await table.update(r.id, { _dirty: 0 });
      }
    });
  }
}

async function pull(t: TableName) {
  const table = db[t] as any;
  const key = 'last_pull_' + t;
  const last = await getMeta<string | null>(key, null);
  let since = last ? new Date(Date.parse(last) - PULL_OVERLAP_MS).toISOString() : '1970-01-01T00:00:00Z';
  let newest = last;
  for (;;) {
    const { data, error } = await supabase.from(t).select('*').gt('server_updated_at', since).order('server_updated_at').limit(PULL_PAGE);
    if (error) throw error;
    if (!data.length) break;
    await db.transaction('rw', table, async () => {
      for (const remote of data) {
        const local = await table.get(remote.id);
        const incoming = fromRemote(t, remote);
        // Vence a alteração mais recente; uma edição local ainda não enviada e mais nova fica
        if (local && local._dirty && local.updated_at > incoming.updated_at) continue;
        await table.put(incoming);
      }
    });
    since = data[data.length - 1].server_updated_at;
    if (!newest || Date.parse(since) > Date.parse(newest)) newest = since;
    if (data.length < PULL_PAGE) break;
  }
  if (newest && newest !== last) await setMeta(key, newest);
}

let running: boolean = false;
let again: boolean = false;

/** Envia o que mudou no aparelho e recebe o que mudou na nuvem. Pode ser chamada à vontade. */
export async function sync(): Promise<void> {
  if (running) {
    again = true;
    return;
  }
  const session = await currentSession();
  if (!session) return emit({ kind: 'signed-out' });
  if (navigator.onLine === false) return emit({ kind: 'offline' });

  // Um aparelho com dados de outra conta não sincroniza: os dados iriam para a conta errada
  const owner = await getMeta<string | null>('owner_user_id', null);
  if (owner && owner !== session.user.id) {
    return emit({ kind: 'error', message: 'Este aparelho tem dados de outra conta. Exporte um backup e entre com a conta original.' });
  }

  running = true;
  emit({ kind: 'syncing' });
  try {
    await uploadAttachments(session.user.id);
    for (const t of TABLES) await push(t);
    for (const t of TABLES) await pull(t);
    await syncSettings();
    await syncPlaces();
    await syncRatings();
    if (!owner) await setMeta('owner_user_id', session.user.id);
    const at = new Date().toISOString();
    await setMeta('last_sync_at', at);
    emit({ kind: 'ok', at });
  } catch (err) {
    console.error('sync', err);
    emit(!(navigator.onLine as boolean) ? { kind: 'offline' } : { kind: 'error', message: friendly(err) });
  } finally {
    running = false;
    if (again) {
      again = false;
      setTimeout(sync, 0);
    }
  }
}

export async function currentSession(): Promise<Session | null> {
  try {
    const { data } = await supabase.auth.getSession();
    return data.session;
  } catch {
    return null;
  }
}

/* ---------- login sem senha pelo e-mail ---------- */
/** URL para onde o link do e-mail volta: a raiz do app publicado (ou o servidor local em desenvolvimento). */
export const APP_URL = location.origin + import.meta.env.BASE_URL;

/** Envia o e-mail de acesso. Com o modelo padrão do Supabase ele traz um link; com SMTP próprio pode trazer código. */
export async function sendLoginEmail(email: string) {
  const { error } = await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: true, emailRedirectTo: APP_URL } });
  if (error) throw new Error(loginEmailError(error.message));
}

export async function verifyCode(email: string, token: string) {
  const { error } = await supabase.auth.verifyOtp({ email, token, type: 'email' });
  if (error) throw new Error(/expired|invalid/i.test(error.message) ? 'Código inválido ou expirado. Peça um novo.' : error.message);
}

export async function signOut() {
  await supabase.auth.signOut({ scope: 'local' });
  emit({ kind: 'signed-out' });
}

/* ---------- gatilhos ---------- */
let debounce: number | undefined;
export function scheduleSync(delay = 2000) {
  clearTimeout(debounce);
  debounce = window.setTimeout(sync, delay);
}

export function startAutoSync() {
  supabase.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_IN') scheduleSync(0);
    if (event === 'SIGNED_OUT') emit({ kind: 'signed-out' });
  });
  window.addEventListener('online', () => scheduleSync(500));
  window.addEventListener('offline', () => status.kind !== 'signed-out' && emit({ kind: 'offline' }));
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && scheduleSync(500));
  setInterval(() => document.visibilityState === 'visible' && sync(), 5 * 60 * 1000);
  scheduleSync(300);
}

/* ---------- anexos de OS (Storage) ---------- */
const EXT: Record<string, string> = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic' };

/** Sobe os arquivos já ligados a uma manutenção salva e grava o caminho no registro. */
async function uploadAttachments(uid: string) {
  const files = await db.pending_files.where('status').equals('anexo').toArray();
  for (const f of files) {
    if (!f.service_id) continue;
    const svc = await db.services.get(f.service_id);
    if (!svc || svc.deleted_at) {
      await db.pending_files.delete(f.id);
      continue;
    }
    const path = uid + '/' + f.service_id + '.' + (EXT[f.type] ?? 'bin');
    const { error } = await supabase.storage.from('os').upload(path, f.blob, { upsert: true, contentType: f.type });
    if (error) throw error;
    await db.transaction('rw', db.services, db.pending_files, async () => {
      await db.services.update(f.service_id!, { attachment_path: path, updated_at: now(), _dirty: 1 });
      await db.pending_files.delete(f.id);
    });
  }
}

/** Link temporário para abrir o anexo guardado na nuvem. */
export async function attachmentUrl(path: string): Promise<string> {
  const { data, error } = await supabase.storage.from('os').createSignedUrl(path, 300);
  if (error || !data) throw new Error('Não consegui abrir o anexo agora.');
  return data.signedUrl;
}

/* ---------- preferências e consentimento (uma linha por usuário) ---------- */

export interface HomePrefs {
  ids: IndicatorId[];
  /** Aceitou contribuir com a rede (só agregados por posto). */
  contribute: boolean;
  consent_at: string | null;
  terms_version: string | null;
  updated_at: string;
  dirty: boolean;
}
const PREFS_KEY = 'settings';
const PREFS_DEFAULT: HomePrefs = { ids: [...DEFAULT_HOME], contribute: false, consent_at: null, terms_version: null, updated_at: '1970-01-01T00:00:00.000Z', dirty: false };

export async function getHomePrefs(): Promise<HomePrefs> {
  return { ...PREFS_DEFAULT, ...(await getMeta<Partial<HomePrefs>>(PREFS_KEY, {})) };
}

async function patchPrefs(patch: Partial<HomePrefs>) {
  await setMeta(PREFS_KEY, { ...(await getHomePrefs()), ...patch, updated_at: now(), dirty: true });
  scheduleSync(800);
}

/** Grava a escolha dos indicadores no aparelho e agenda o envio para a conta. */
export async function setHomePrefs(ids: IndicatorId[]) {
  await patchPrefs({ ids: ids.filter(isIndicatorId) });
}

/** Liga ou desliga a contribuição com a rede, registrando quando e em qual versão dos termos. */
export async function setContribute(on: boolean, termsVersion: string) {
  await patchPrefs({ contribute: on, consent_at: on ? now() : null, terms_version: termsVersion });
}

async function syncSettings() {
  const local = await getHomePrefs();
  if (local.dirty) {
    const { error } = await supabase.from('user_settings').upsert(
      { home_indicators: local.ids, contribute: local.contribute, consent_at: local.consent_at, terms_version: local.terms_version, updated_at: local.updated_at },
      { onConflict: 'user_id' },
    );
    if (error) throw error;
    const cur = await getHomePrefs();
    if (cur.updated_at === local.updated_at) await setMeta(PREFS_KEY, { ...cur, dirty: false });
  }
  const { data, error } = await supabase.from('user_settings').select('home_indicators, contribute, consent_at, terms_version, updated_at').maybeSingle();
  if (error) throw error;
  if (!data) return;
  const remoteAt = new Date(data.updated_at).toISOString();
  const cur = await getHomePrefs();
  if (!cur.dirty && remoteAt > cur.updated_at) {
    const ids = (Array.isArray(data.home_indicators) ? data.home_indicators : []).filter(isIndicatorId);
    await setMeta(PREFS_KEY, {
      ids, contribute: !!data.contribute, consent_at: data.consent_at ? new Date(data.consent_at).toISOString() : null,
      terms_version: data.terms_version, updated_at: remoteAt, dirty: false,
    });
  }
}

/* ---------- avaliações em um toque ---------- */

export type Vote = 1 | -1 | null;
export type AfterEffect = 'normal' | 'melhor' | 'falhou' | 'rendeu_menos';
export interface RatingRow {
  fuel_log_id: string; station_id: string; bomba: Vote; atendimento: Vote; banheiro: Vote;
  /** Nota geral, 1 a 5 (opcional). */
  stars?: number | null;
  /** Como o carro andou com o combustível desse abastecimento (perguntado depois). */
  after_effect?: AfterEffect | null;
  after_at?: string | null;
  dirty: boolean;
  /** apagada aqui; some do servidor na próxima sincronização */ deleted?: boolean;
}
const RATINGS_KEY = 'ratings';

export async function getRatings(): Promise<Record<string, RatingRow>> {
  return getMeta<Record<string, RatingRow>>(RATINGS_KEY, {});
}

/** Guarda a avaliação no aparelho; sobe na próxima sincronização. */
export async function saveRating(r: Omit<RatingRow, 'dirty' | 'deleted'>) {
  const all = await getRatings();
  all[r.fuel_log_id] = { ...r, dirty: true };
  await setMeta(RATINGS_KEY, all);
  scheduleSync(500);
}

/** Apaga a avaliação de um abastecimento (também quando o abastecimento é excluído ou muda de posto). */
export async function deleteRating(fuelLogId: string) {
  const all = await getRatings();
  const r = all[fuelLogId];
  if (!r) return;
  all[fuelLogId] = { ...r, deleted: true, dirty: true };
  await setMeta(RATINGS_KEY, all);
  scheduleSync(500);
}

async function syncRatings() {
  const all = await getRatings();
  const removed = new Set<string>();
  for (const r of Object.values(all).filter((x) => x.dirty)) {
    if (r.deleted) {
      const { error } = await supabase.from('ratings').delete().eq('fuel_log_id', r.fuel_log_id);
      if (error) throw error;
      delete all[r.fuel_log_id];
      removed.add(r.fuel_log_id);
      continue;
    }
    const { dirty: _d, deleted: _x, ...row } = r;
    const { error } = await supabase.from('ratings').upsert(row, { onConflict: 'fuel_log_id' });
    if (error) {
      // abastecimento ainda não subiu: tenta de novo na próxima; fora do prazo ou inválido: descarta
      if (error.code === '23503' && !/não encontrado/.test(error.message)) continue;
      if (error.code === '23514' || error.code === '23503') {
        delete all[r.fuel_log_id];
        continue;
      }
      throw error;
    }
    all[r.fuel_log_id] = { ...r, dirty: false };
  }
  const { data: got, error } = await supabase.from('ratings').select('fuel_log_id, station_id, bomba, atendimento, banheiro, stars, after_effect, after_at');
  if (error) throw error;
  // avaliação de abastecimento excluído ou que mudou de posto: apaga do servidor também
  const data: typeof got = [];
  for (const r of got ?? []) {
    const f = await db.fuel_logs.get(r.fuel_log_id);
    if (f && (f.deleted_at || f.station_id !== r.station_id)) {
      const { error: e2 } = await supabase.from('ratings').delete().eq('fuel_log_id', r.fuel_log_id);
      if (e2) throw e2;
      removed.add(r.fuel_log_id);
      continue;
    }
    data.push(r);
  }
  const cur = await getRatings();
  for (const k of removed) if (cur[k]?.deleted || !cur[k]?.dirty) delete cur[k]; // apagada e já removida do servidor
  for (const k of Object.keys(all)) if (cur[k]) cur[k].dirty = all[k].dirty;
  for (const k of Object.keys(cur)) if (!all[k] && !cur[k].dirty) delete cur[k];
  for (const r of data ?? []) if (!cur[r.fuel_log_id]?.dirty) cur[r.fuel_log_id] = { ...(r as Omit<RatingRow, 'dirty'>), dirty: false };
  await setMeta(RATINGS_KEY, cur);
}

/* ---------- excluir a conta ---------- */

/** Apaga a conta e tudo o que ela registrou no servidor; depois limpa este aparelho. */
export async function deleteAccount() {
  const { error } = await supabase.functions.invoke('excluir-conta', { body: { confirmar: 'EXCLUIR' } });
  if (error) {
    let msg = 'Não deu para excluir agora.';
    try {
      const body = await (error as any).context?.json?.();
      if (body?.error) msg = body.error;
    } catch {
      /* sem corpo */
    }
    throw new Error(msg);
  }
  await supabase.auth.signOut({ scope: 'local' }).catch(() => {});
  await db.delete();
  try { localStorage.clear(); } catch { /* sem acesso */ }
}

/* ---------- casa, trabalho e o caminho entre eles ---------- */

export type PlaceKind = 'casa' | 'trabalho' | 'rota';
export interface PlaceRow {
  kind: PlaceKind;
  label: string | null;
  lat: number | null;
  lon: number | null;
  data: Record<string, unknown>;
  updated_at: string;
  deleted_at: string | null;
  dirty: boolean;
}
export type Places = Partial<Record<PlaceKind, PlaceRow>>;
const PLACES_KEY = 'places';

export async function getPlaces(): Promise<Places> {
  return getMeta<Places>(PLACES_KEY, {});
}

/** Grava (ou apaga, com `null`) um local no aparelho e agenda o envio para a conta. */
export async function setPlace(kind: PlaceKind, v: Pick<PlaceRow, 'label' | 'lat' | 'lon' | 'data'> | null) {
  const cur = await getPlaces();
  const at = now();
  cur[kind] = v
    ? { kind, ...v, updated_at: at, deleted_at: null, dirty: true }
    : { kind, label: null, lat: null, lon: null, data: {}, updated_at: at, deleted_at: at, dirty: true };
  await setMeta(PLACES_KEY, cur);
  scheduleSync(800);
}

async function syncPlaces() {
  const local = await getPlaces();
  const dirty = Object.values(local).filter((p): p is PlaceRow => !!p?.dirty);
  if (dirty.length) {
    const { error } = await supabase
      .from('user_places')
      .upsert(dirty.map(({ dirty: _d, ...r }) => r), { onConflict: 'user_id,kind' });
    if (error) throw error;
  }
  const { data, error } = await supabase.from('user_places').select('kind, label, lat, lon, data, updated_at, deleted_at');
  if (error) throw error;
  const cur = await getPlaces();
  for (const p of dirty) {
    const c = cur[p.kind];
    if (c && c.updated_at === p.updated_at) c.dirty = false;
  }
  for (const r of data ?? []) {
    const kind = r.kind as PlaceKind;
    const remoteAt = new Date(r.updated_at).toISOString();
    const c = cur[kind];
    if (c && (c.dirty || c.updated_at >= remoteAt)) continue;
    cur[kind] = {
      kind, label: r.label, lat: r.lat, lon: r.lon, data: (r.data ?? {}) as Record<string, unknown>,
      updated_at: remoteAt, deleted_at: r.deleted_at ? new Date(r.deleted_at).toISOString() : null, dirty: false,
    };
  }
  await setMeta(PLACES_KEY, cur);
}

/* ---------- Google Places (opcional: só funciona com a chave configurada no servidor) ---------- */
export type GoogleMode = 'nearby' | 'posto' | 'address' | 'autocomplete' | 'details' | 'lugar';
/** Chave do mapa do Google da ficha (Maps Embed API: grátis e sem limite). null = ainda não configurada. */
let embedKey: Promise<string | null> | null = null;
export function googleEmbedKey(): Promise<string | null> {
  embedKey ??= (async () => {
    if (!(await currentSession())) return null;
    const { data, error } = await supabase.functions.invoke('postos-google', { body: { mode: 'mapa' } });
    if (error) throw error;
    return (data as { key?: string | null }).key ?? null;
  })().catch(() => { embedKey = null; return null; });
  return embedKey;
}
/** Nota e número de avaliações de um lugar do Google (chamada própria: é a que tem a faixa grátis menor). */
export async function googleNota(id: string): Promise<{ rating: number | null; count: number } | null> {
  if (!(await currentSession())) return null;
  const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error('O Google demorou para responder.')), 12000));
  const { data, error } = await Promise.race([supabase.functions.invoke('postos-google', { body: { mode: 'nota', id } }), timeout]);
  if (error) throw error;
  const d = data as { configured: boolean; rating: number | null; count: number };
  return d.configured ? { rating: d.rating, count: d.count } : null;
}
/** Link temporário (do Google) para a foto de um lugar; null quando não há. */
export async function googlePhoto(name: string): Promise<string | null> {
  if (!(await currentSession())) return null;
  const { data, error } = await supabase.functions.invoke('postos-google', { body: { mode: 'photo', name } });
  if (error) throw error;
  return (data as { uri?: string | null }).uri ?? null;
}
/** Chama a função postos-google; sem login ou sem chave devolve configured=false. */
export async function googlePlaces<T>(body: { mode: GoogleMode; lat?: number; lon?: number; radius_m?: number; query?: string; session?: string; id?: string }): Promise<{ configured: boolean; places: T[] }> {
  if (!(await currentSession())) return { configured: false, places: [] };
  // sem resposta em 12 s, desiste (a tela não fica presa em "procurando")
  const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error('O Google demorou para responder.')), 12000));
  const { data, error } = await Promise.race([supabase.functions.invoke('postos-google', { body }), timeout]);
  if (error) throw error;
  return data as { configured: boolean; places: T[] };
}

/** Uma avaliação do Google, como ele devolve (até 5, escolhidas por relevância). Não é guardada. */
export interface GoogleReview { rating: number | null; time: string | null; rel: string; text: string; author: string; authorUri: string; uri: string }
export interface GoogleReviews { rating: number | null; count: number; uri: string; reviewsUri: string; reviews: GoogleReview[] }
/** Avaliações de um lugar do Google, só quando a pessoa pede (toque na nota). */
export async function googleReviews(id: string): Promise<GoogleReviews | null> {
  if (!(await currentSession())) return null;
  const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error('O Google demorou para responder.')), 12000));
  const { data, error } = await Promise.race([supabase.functions.invoke('postos-google', { body: { mode: 'avaliacoes', id } }), timeout]);
  if (error) throw error;
  const d = data as GoogleReviews & { configured: boolean };
  return d.configured ? d : null;
}

/** Ligação posto da ANP → lugar do Google. null = "este posto não está no Google" (dito por quem usa o app). */
export interface PlaceLinks {
  /** O que vale neste aparelho: a ligação do servidor, com as correções da própria pessoa por cima. */
  place: Map<string, string | null>;
  /** O que a própria pessoa corrigiu ou confirmou (vale para ela na hora; para todos quando outra concordar). */
  mine: Map<string, string | null>;
  /** Postos cuja ligação foi decidida pelas pessoas (e não pela busca automática). */
  people: Set<string>;
}
const LINKS_KEY = 'station_places_v2';
type LinksCache = { at: number; rows: [string, string | null, boolean][]; mine: [string, string | null][] };
const toLinks = (c: LinksCache): PlaceLinks => {
  const place = new Map<string, string | null>(c.rows.map(([s, p]) => [s, p]));
  for (const [s, p] of c.mine) {
    // um lugar do Google fica com um posto só: a escolha da pessoa tira o lugar de outro posto
    if (p) for (const [o, q] of place) if (q === p && o !== s) place.delete(o);
    place.set(s, p);
  }
  return { place, mine: new Map(c.mine), people: new Set(c.rows.filter((r) => r[2]).map((r) => r[0])) };
};
/**
 * Postos já ligados ao Google (CNPJ → place_id; só o id, que pode ser guardado). Fica no aparelho por
 * uma hora; com `fresh`, busca de novo. Sem internet, vale a última cópia.
 */
export async function stationPlaces(fresh = false): Promise<PlaceLinks> {
  const cached = await getMeta<LinksCache | null>(LINKS_KEY, null);
  if (!fresh && cached && cached.rows.length && Date.now() - cached.at < 3600e3) return toLinks(cached);
  try {
    const { data, error } = await supabase.from('station_places').select('station_id,place_id,source').or('place_id.not.is.null,source.eq.pessoas').limit(5000);
    if (error) throw error;
    const rows = (data as { station_id: string; place_id: string | null; source: string }[]).map((r) => [r.station_id, r.place_id, r.source === 'pessoas'] as [string, string | null, boolean]);
    let mine: [string, string | null][] = cached?.mine ?? [];
    if (await currentSession()) {
      const v = await supabase.from('station_place_votes').select('station_id,place_id').limit(2000);
      if (!v.error) mine = (v.data as { station_id: string; place_id: string | null }[]).map((r) => [r.station_id, r.place_id]);
    }
    const c: LinksCache = { at: Date.now(), rows, mine };
    await setMeta(LINKS_KEY, c);
    return toLinks(c);
  } catch {
    return toLinks(cached ?? { at: 0, rows: [], mine: [] });
  }
}
/** Nome do posto na fachada, dado pelas pessoas (dado nosso: pode ficar guardado). */
export interface StationNames { names: Map<string, string>; mine: Map<string, string> }
const NAMES_KEY = 'station_names_v1';
type NamesCache = { at: number; rows: [string, string][]; mine: [string, string][] };
const toNames = (c: NamesCache): StationNames => {
  const names = new Map(c.rows);
  for (const [s, n] of c.mine) names.set(s, n);
  return { names, mine: new Map(c.mine) };
};
export async function stationNames(fresh = false): Promise<StationNames> {
  const cached = await getMeta<NamesCache | null>(NAMES_KEY, null);
  if (!fresh && cached && Date.now() - cached.at < 3600e3) return toNames(cached);
  try {
    const { data, error } = await supabase.from('station_names').select('station_id,name').limit(10000);
    if (error) throw error;
    const rows = (data as { station_id: string; name: string }[]).map((r) => [r.station_id, r.name] as [string, string]);
    let mine: [string, string][] = cached?.mine ?? [];
    if (await currentSession()) {
      const v = await supabase.from('station_name_votes').select('station_id,name').limit(2000);
      if (!v.error) mine = (v.data as { station_id: string; name: string }[]).map((r) => [r.station_id, r.name]);
    }
    const c: NamesCache = { at: Date.now(), rows, mine };
    await setMeta(NAMES_KEY, c);
    return toNames(c);
  } catch {
    return toNames(cached ?? { at: 0, rows: [], mine: [] });
  }
}
/** A pessoa diz o nome que aparece na fachada. Devolve se já vale para todos ou uma mensagem de erro. */
export async function voteName(stationId: string, name: string): Promise<{ applied: boolean; name: string } | { error: string }> {
  const s = await currentSession();
  if (!s) return { error: 'Entre na conta (Perfil) para corrigir o nome.' };
  const clean = name.replace(/\s+/g, ' ').trim();
  if (clean.length < 2 || clean.length > 60 || /[<>{}\\]/.test(clean)) return { error: 'Escreva o nome como aparece na fachada (2 a 60 letras).' };
  const { error } = await supabase.from('station_name_votes').upsert({ user_id: s.user.id, station_id: stationId, name: clean, created_at: new Date().toISOString() });
  if (error) return { error: /Muitas correções/.test(error.message) ? 'Muitas correções hoje. Tente amanhã.' : 'Não deu para salvar o nome agora.' };
  const cached = await getMeta<NamesCache | null>(NAMES_KEY, null);
  if (cached) await setMeta(NAMES_KEY, { ...cached, mine: [...cached.mine.filter(([c]) => c !== stationId), [stationId, clean]] });
  const row = await supabase.from('station_names').select('name').eq('station_id', stationId).maybeSingle();
  const r = row.data as { name: string } | null;
  return { applied: !!r && r.name.toLowerCase() === clean.toLowerCase(), name: clean };
}
/**
 * A pessoa diz qual é o posto no Google (ou null: não está no Google). Devolve se já vale para todos
 * (duas pessoas concordaram ou quem corrigiu administra o app) ou uma mensagem de erro.
 */
export async function votePlace(stationId: string, placeId: string | null): Promise<{ applied: boolean } | { error: string }> {
  const s = await currentSession();
  if (!s) return { error: 'Entre na conta (Perfil) para corrigir o posto.' };
  const { error } = await supabase.from('station_place_votes').upsert({ user_id: s.user.id, station_id: stationId, place_id: placeId, created_at: new Date().toISOString() });
  if (error) return { error: /Muitas correções/.test(error.message) ? 'Muitas correções hoje. Tente amanhã.' : 'Não deu para salvar a correção agora.' };
  const cached = await getMeta<LinksCache | null>(LINKS_KEY, null);
  if (cached) await setMeta(LINKS_KEY, { ...cached, mine: [...cached.mine.filter(([c]) => c !== stationId), [stationId, placeId]] });
  const row = await supabase.from('station_places').select('place_id,source').eq('station_id', stationId).maybeSingle();
  const r = row.data as { place_id: string | null; source: string } | null;
  return { applied: !!r && r.source === 'pessoas' && r.place_id === placeId };
}
