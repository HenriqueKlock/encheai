// Estado central: tudo o que as telas mostram vem daqui, lido do banco do aparelho (IndexedDB)
// e atualizado sozinho quando algo muda (novo abastecimento, sincronização, troca de carro).
import { liveQuery } from 'dexie';
import { db, getMeta, type FuelLog, type PendingFile, type Service, type ServiceItem, type Vehicle } from './db';
import { aggregate, intervals, sortLogs, type Interval } from './calc';
import { getHomePrefs, getPlaces, getRatings, type HomePrefs, type Places, type RatingRow } from './sync';
import type { CarModel, Fuel } from './postos';

export interface CalcCfg { gas: string; eth: string; ratio: number }
export interface State {
  ready: boolean;
  vehicles: Vehicle[];
  logs: FuelLog[];
  currentId: string | null;
  calc: CalcCfg;
  pending: number;
  services: Service[];
  items: ServiceItem[];
  files: PendingFile[];
  prefs: HomePrefs;
  places: Places;
  ratings: Record<string, RatingRow>;
}

export let S: State = {
  ready: false, vehicles: [], logs: [], currentId: null, calc: { gas: '', eth: '', ratio: 0.7 }, pending: 0, services: [], items: [], files: [],
  prefs: { ids: ['gasto_mes', 'km_mes'], contribute: false, consent_at: null, terms_version: null, updated_at: '', dirty: false },
  places: {}, ratings: {},
};

const listeners = new Set<() => void>();
export function subscribe(fn: () => void) {
  listeners.add(fn);
}

export function startStore(onError: (e: unknown) => void) {
  liveQuery(async () => {
    const [vehicles, logs, currentId, calc, dirty, services, items, files, prefs, places, ratings] = await Promise.all([
      db.vehicles.toArray(),
      db.fuel_logs.toArray(),
      getMeta<string | null>('current_vehicle', null),
      getMeta<CalcCfg>('calc', { gas: '', eth: '', ratio: 0.7 }),
      Promise.all([db.vehicles, db.fuel_logs, db.services, db.service_items].map((t: any) => t.where('_dirty').equals(1).count())),
      db.services.toArray(),
      db.service_items.toArray(),
      db.pending_files.toArray(),
      getHomePrefs(),
      getPlaces(),
      getRatings(),
    ]);
    return {
      ready: true,
      vehicles: vehicles.filter((v) => !v.deleted_at),
      logs: logs.filter((f) => !f.deleted_at),
      currentId,
      calc,
      pending: (dirty as number[]).reduce((a, b) => a + b, 0),
      services: services.filter((x) => !x.deleted_at),
      items: items.filter((x) => !x.deleted_at),
      files,
      prefs,
      places,
      ratings,
    } as State;
  }).subscribe({
    next: (s) => {
      S = s;
      listeners.forEach((fn) => fn());
    },
    error: onError,
  });
}

export const activeVehicles = () => S.vehicles.filter((v) => !v.archived).sort((a, b) => a.name.localeCompare(b.name));
export const current = (): Vehicle | undefined => S.vehicles.find((v) => v.id === S.currentId && !v.archived) ?? activeVehicles()[0];
export function carLogs(): FuelLog[] {
  const v = current();
  return v ? sortLogs(S.logs.filter((f) => f.vehicle_id === v.id)) : [];
}
export function carIntervals(): Interval[] {
  return intervals(carLogs());
}
export const carServices = () => {
  const v = current();
  return v ? S.services.filter((s) => s.vehicle_id === v.id) : [];
};

export interface CarInfo { model: CarModel; name: string }
/** Rendimento do carro atual para comparar postos e combustíveis. */
export function carInfo(): CarInfo {
  const v = current();
  const iv = carIntervals();
  const g = aggregate(iv.filter((x) => x.fuel === 'gasolina'));
  const e = aggregate(iv.filter((x) => x.fuel === 'etanol'));
  // Um tanque fora da curva não pode virar o rendimento do etanol: fora de 55–85%, volta à regra dos 70%
  const raw = g.n > 0 && e.n > 0 ? e.kml / g.kml : NaN;
  const measured = raw >= 0.55 && raw <= 0.85;
  const ratio = measured ? raw : Number(S.calc.ratio) || 0.7;
  const kmlG = g.n ? g.kml : e.n ? e.kml / ratio : 10;
  const kmlE = measured ? e.kml : kmlG * ratio;
  const fulls = carLogs().filter((f) => f.full_tank).slice(-6);
  const liters = fulls.length ? fulls.reduce((a, f) => a + f.liters, 0) / fulls.length : 45;
  const ft = v?.fuel_type ?? 'flex';
  const fuels: Fuel[] = ft === 'flex' ? ['gasolina', 'etanol'] : ft === 'gasolina' ? ['gasolina'] : ft === 'etanol' ? ['etanol'] : [];
  return { name: v?.name ?? 'carro', model: { kmlG, kmlE, measured, fuels, kmTank: Math.max(100, Math.round((liters * kmlG) / 10) * 10) } };
}
