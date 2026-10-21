// "Como o carro andou depois?": a pergunta é sempre sobre o combustível de UM abastecimento (o posto dele),
// feita no próximo abastecimento, pelo histórico ou no dia seguinte (aviso no Início e notificação).
// Puro: testado em tests/depois.test.ts.

export type AfterEffect = 'normal' | 'melhor' | 'falhou' | 'rendeu_menos';

export const AFTER_OPTIONS: [AfterEffect, string][] = [
  ['normal', 'Andou normal'],
  ['melhor', 'Melhor que o normal'],
  ['falhou', 'Falhou, engasgou ou acendeu luz'],
  ['rendeu_menos', 'Pareceu render menos'],
];
export const AFTER_SHORT: Record<AfterEffect, string> = { normal: 'carro normal', melhor: 'carro melhor', falhou: 'carro falhou', rendeu_menos: 'rendeu menos' };

/** Janela em que o servidor aceita avaliar um abastecimento. */
export const MAX_DAYS = 30;
/** O aviso no Início (e a notificação) aparece a partir deste dia. */
export const REMIND_DAYS = 1;

export interface FillLike { id: string; vehicle_id: string; date: string; odometer_km: number; station_id?: string | null; deleted_at?: string | null }
export interface RatingLike { after_effect?: AfterEffect | null }

const days = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 864e5);
const order = (a: FillLike, b: FillLike) => a.date.localeCompare(b.date) || a.odometer_km - b.odometer_km;

/** Abastecimento imediatamente anterior a este, no mesmo carro (de onde veio o combustível que o carro usou até agora). */
export function previousFill<T extends FillLike>(logs: T[], fill: FillLike): T | null {
  const same = logs.filter((f) => f.vehicle_id === fill.vehicle_id && f.id !== fill.id && !f.deleted_at && order(f, fill) < 0).sort(order);
  return same[same.length - 1] ?? null;
}

/** Ainda dá para dizer como o carro andou com o combustível deste abastecimento? */
export function canAskAfter(f: FillLike, today: string, rating?: RatingLike | null): boolean {
  return !!f.station_id && !f.deleted_at && days(f.date, today) <= MAX_DAYS && !rating?.after_effect;
}

/** O carro já rodou com esse combustível (no dia seguinte, ou já abasteceu de novo)? */
export function usedEnough<T extends FillLike>(f: FillLike, logs: T[], today: string): boolean {
  return days(f.date, today) >= REMIND_DAYS || logs.some((x) => x.vehicle_id === f.vehicle_id && x.id !== f.id && !x.deleted_at && order(f, x) < 0);
}

/**
 * Para o aviso no Início: o último abastecimento de cada carro, com posto, de 1 a 30 dias atrás e sem resposta.
 * Se já houve outro abastecimento depois, a pergunta apareceu ao registrar; não insiste.
 */
export function pendingAfter<T extends FillLike>(logs: T[], ratings: Record<string, RatingLike>, today: string, dismissed: string[] = []): T | null {
  const latest = new Map<string, T>();
  for (const f of logs) {
    if (f.deleted_at) continue;
    const cur = latest.get(f.vehicle_id);
    if (!cur || order(cur, f) < 0) latest.set(f.vehicle_id, f);
  }
  const due = [...latest.values()].filter((f) => canAskAfter(f, today, ratings[f.id]) && days(f.date, today) >= REMIND_DAYS && !dismissed.includes(f.id));
  return due.sort((a, b) => order(b, a))[0] ?? null;
}

/** Quanto o tanque que começou neste abastecimento rendeu em relação ao normal do carro (mesmo combustível). */
export function tankVsNormal(intervals: { start_id: string; kml: number; fuel: string }[], fillId: string): number | null {
  const it = intervals.find((i) => i.start_id === fillId);
  if (!it) return null;
  const others = intervals.filter((i) => i.fuel === it.fuel && i.start_id !== fillId).map((i) => i.kml).sort((a, b) => a - b);
  if (others.length < 2) return null;
  const mid = others.length / 2;
  const med = others.length % 2 ? others[Math.floor(mid)] : (others[mid - 1] + others[mid]) / 2;
  return med > 0 ? it.kml / med - 1 : null;
}
