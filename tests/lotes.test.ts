import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importBatches } from '../src/lotes.ts';

test('lotes de importação: agrupa por lote, ignora excluídos e outros carros, mais recente primeiro', () => {
  const r = (date: string, batch: string | null, extra: Record<string, unknown> = {}) => ({ vehicle_id: 'c1', date, updated_at: '2026-10-21T10:00:00Z', deleted_at: null, import_batch: batch, import_source: 'claude' as const, ...extra });
  const fills = [r('2026-09-10', 'L1'), r('2026-10-01', 'L1'), r('2026-10-05', 'L1', { deleted_at: '2026-10-21T11:00:00Z' }), r('2026-10-07', null), r('2026-10-08', 'L2', { vehicle_id: 'c2' }),
    r('2026-08-01', 'L3', { import_source: 'planilha', updated_at: '2026-10-22T09:00:00Z' })];
  const services = [r('2026-09-11', 'L1')];
  const b = importBatches(fills, services, 'c1');
  assert.deepEqual(b.map((x) => x.id), ['L3', 'L1']);
  assert.deepEqual({ fills: b[1].fills, services: b[1].services, first: b[1].first, last: b[1].last }, { fills: 2, services: 1, first: '2026-09-10', last: '2026-10-01' });
  assert.equal(b[0].source, 'planilha');
});
