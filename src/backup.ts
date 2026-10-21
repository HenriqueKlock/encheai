import Dexie from 'dexie';
import { db, type FuelLog, type Service, type ServiceItem, type Vehicle } from './db';

// Formato do arquivo de backup herdado da Caderneta do Carro (mantido para os dois apps lerem os mesmos arquivos)
export const BACKUP_APP = 'caderneta-carro';
export const BACKUP_VERSION = 1;

export interface Backup {
  app: typeof BACKUP_APP;
  version: number;
  exported_at: string;
  vehicles: Vehicle[];
  fuel_logs: FuelLog[];
  services: Service[];
  service_items: ServiceItem[];
}

export async function exportBackup(): Promise<Backup> {
  const strip = <T extends { _dirty: 0 | 1 }>(rows: T[]) => rows.map(({ _dirty, ...r }) => r as unknown as T);
  return {
    app: BACKUP_APP,
    version: BACKUP_VERSION,
    exported_at: new Date().toISOString(),
    vehicles: strip(await db.vehicles.toArray()),
    fuel_logs: strip(await db.fuel_logs.toArray()),
    services: strip(await db.services.toArray()),
    service_items: strip(await db.service_items.toArray()),
  };
}

export interface ImportResult {
  vehicles: number;
  fuel_logs: number;
  services: number;
  service_items: number;
}

/**
 * Importa um backup: insere ou atualiza por id. Quando a mesma linha existe dos dois lados,
 * fica a de `updated_at` mais recente. Tudo entra marcado para subir na próxima sincronização.
 */
export async function importBackup(raw: unknown): Promise<ImportResult> {
  const b = raw as Partial<Backup>;
  if (!b || b.app !== BACKUP_APP || typeof b.version !== 'number') {
    throw new Error('Este arquivo não é um backup do Enche Aí (nem da Caderneta do Carro).');
  }
  if (b.version > BACKUP_VERSION) {
    throw new Error('Backup criado por uma versão mais nova do app. Atualize o app e tente de novo.');
  }
  const res: ImportResult = { vehicles: 0, fuel_logs: 0, services: 0, service_items: 0 };
  await db.transaction('rw', [db.vehicles, db.fuel_logs, db.services, db.service_items], async () => {
    for (const name of ['vehicles', 'fuel_logs', 'services', 'service_items'] as const) {
      const rows = (b[name] ?? []) as Array<{ id: string; updated_at: string }>;
      const table = db[name] as any;
      for (const r of rows) {
        if (!r || typeof r.id !== 'string') continue;
        const cur = await table.get(r.id);
        if (cur && cur.updated_at >= r.updated_at) continue;
        await table.put({ deleted_at: null, ...r, _dirty: 1 });
        res[name]++;
      }
    }
  });
  return res;
}

/* ---------- dados do app anterior neste aparelho ---------- */
// O app anterior roda no mesmo endereço (henriqueklock.github.io), então o banco dele neste aparelho
// pode ser lido daqui. Só leitura: nada é alterado nele.
const LEGACY_DB = 'caderneta-carro';

export interface LegacyData { backup: Backup; places: Record<string, { label: string | null; lat: number | null; lon: number | null; data: Record<string, unknown>; deleted_at: string | null }>; counts: { vehicles: number; fuel_logs: number; services: number } }

export async function legacyData(): Promise<LegacyData | null> {
  try {
    if (!(await Dexie.exists(LEGACY_DB))) return null;
    const old = new Dexie(LEGACY_DB);
    await old.open();
    try {
      const names = new Set(old.tables.map((t) => t.name));
      const read = async (n: string) => (names.has(n) ? ((await old.table(n).toArray()) as any[]) : []);
      const strip = (rows: any[]) => rows.map(({ _dirty, ...r }) => r);
      const backup: Backup = {
        app: BACKUP_APP,
        version: BACKUP_VERSION,
        exported_at: new Date().toISOString(),
        vehicles: strip(await read('vehicles')),
        fuel_logs: strip(await read('fuel_logs')),
        // o anexo da OS ficou no servidor do app anterior: não vem junto
        services: strip(await read('services')).map((r) => ({ ...r, attachment_path: null })),
        service_items: strip(await read('service_items')),
      };
      const meta = names.has('meta') ? await old.table('meta').get('places') : null;
      const places = (meta?.value ?? {}) as LegacyData['places'];
      const live = <T extends { deleted_at?: string | null }>(r: T[]) => r.filter((x) => !x.deleted_at).length;
      const counts = { vehicles: live(backup.vehicles), fuel_logs: live(backup.fuel_logs), services: live(backup.services) };
      return counts.vehicles + counts.fuel_logs ? { backup, places, counts } : null;
    } finally {
      old.close();
    }
  } catch (e) {
    console.warn('app anterior', e);
    return null;
  }
}
