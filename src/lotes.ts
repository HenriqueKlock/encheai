// Lotes de importação: cada importação (planilha, IA ou Claude) marca seus registros com um lote,
// e o app lista os lotes do carro para dar para desfazer uma importação inteira.
import type { ImportSource } from './db';

export const SOURCE_LABEL: Record<ImportSource, string> = { claude: 'Pelo Claude', ia: 'Com a sua IA', planilha: 'Planilha' };

interface Row { vehicle_id: string; date: string; updated_at: string; deleted_at: string | null; import_batch?: string | null; import_source?: ImportSource | null }

export interface Batch { id: string; source: ImportSource; fills: number; services: number; first: string; last: string; at: string }

/** Lotes do carro com pelo menos um registro ainda no histórico, do mais recente para o mais antigo. */
export function importBatches(fills: Row[], services: Row[], vehicleId: string): Batch[] {
  const m = new Map<string, Batch>();
  const add = (r: Row, kind: 'fills' | 'services') => {
    if (!r.import_batch || r.deleted_at || r.vehicle_id !== vehicleId) return;
    const b = m.get(r.import_batch) ?? { id: r.import_batch, source: r.import_source ?? 'ia', fills: 0, services: 0, first: r.date, last: r.date, at: r.updated_at };
    b[kind]++;
    if (r.date < b.first) b.first = r.date;
    if (r.date > b.last) b.last = r.date;
    if (r.updated_at < b.at) b.at = r.updated_at;
    m.set(r.import_batch, b);
  };
  fills.forEach((f) => add(f, 'fills'));
  services.forEach((s) => add(s, 'services'));
  return [...m.values()].sort((a, b) => b.at.localeCompare(a.at));
}
