// Números da rede por posto (preço que os usuários pagaram, rendimento medido e avaliações).
// Vêm da tabela station_live (só agregados, recalculados a cada 5 min no servidor) e ficam
// guardados no aparelho para abrir sem internet.
import { db, getMeta, setMeta } from './db';
import { currentSession, supabase } from './sync';
import type { NetMap, StationLive } from './postos';

// v2: descarta cópias guardadas antes de as avaliações seguirem o abastecimento (podiam mostrar avaliação apagada)
const KEY = 'rede_cache_v2';
const OLD_KEYS = ['rede_cache_v1'];
const FRESH_MS = 5 * 60 * 1000;
const KEEP_MS = 7 * 86400000;
const CHUNK = 150;

type Cache = Record<string, { at: number; live: StationLive | null }>;
let cache: Cache | null = null;
const net: NetMap = new Map();
let saveTimer: number | undefined;

async function load(): Promise<Cache> {
  if (cache) return cache;
  cache = await getMeta<Cache>(KEY, {});
  for (const k of OLD_KEYS) db.meta.delete(k).catch(() => {});
  for (const [id, e] of Object.entries(cache)) if (e.live) net.set(id, e.live);
  return cache;
}

function persist() {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    if (!cache) return;
    const now = Date.now();
    for (const [k, e] of Object.entries(cache)) if (now - e.at > KEEP_MS) delete cache[k];
    setMeta(KEY, cache);
  }, 500);
}

/** O que já se sabe da rede (pode estar vazio antes da primeira busca). */
export function network(): NetMap {
  return net;
}

/**
 * Busca os números destes postos (em lotes). Devolve true se algo mudou.
 * Sem login ou sem internet, fica com o que já está guardado.
 */
export async function fetchNetwork(ids: string[]): Promise<boolean> {
  const c = await load();
  const now = Date.now();
  const need = [...new Set(ids)].filter((id) => !c[id] || now - c[id].at > FRESH_MS);
  if (!need.length || navigator.onLine === false || !(await currentSession())) return false;
  let changed = false;
  for (let i = 0; i < need.length; i += CHUNK) {
    const part = need.slice(i, i + CHUNK);
    const { data, error } = await supabase.from('station_live').select('station_id, price, yield, ratings').in('station_id', part);
    if (error) {
      console.warn('rede', error.message);
      return changed;
    }
    const got = new Map((data ?? []).map((r) => [r.station_id as string, r as StationLive]));
    for (const id of part) {
      const live = got.get(id) ?? null;
      const before = JSON.stringify(c[id]?.live ?? null);
      c[id] = { at: now, live };
      if (live) net.set(id, live);
      else net.delete(id);
      if (before !== JSON.stringify(live)) changed = true;
    }
  }
  persist();
  return changed;
}

/** Esquece o que foi buscado (depois de abastecer, para ver o próprio preço entrar na rede). */
export function invalidateNetwork(id?: string) {
  if (!cache) return;
  if (id) delete cache[id];
  else cache = {};
}
