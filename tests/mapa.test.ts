import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapPicks, type StationRow } from '../src/postos.ts';

const row = (c: string, o: { cost?: number; stale?: boolean; score?: number; level?: 'ok' | 'atencao' | 'evitar'; d?: number }): StationRow =>
  ({
    s: { c } as any, distKm: o.d ?? 1, extraKm: 0, gas: null, eth: null, opts: [], live: null,
    rel: { score: o.score ?? 4, level: o.level ?? 'ok' } as any,
    best: o.cost == null ? null : ({ cost: o.cost, stale: !!o.stale } as any),
  }) as StationRow;

const rows = [
  row('A', { cost: 300 }), row('B', { cost: 280, stale: true }), row('C', { cost: 290, level: 'evitar', score: 2 }),
  row('D', { score: 4.9 }), row('E', { cost: 310, score: 4.7 }), row('F', { score: 4.9, d: 0.5 }),
];
const ids = (r: StationRow[]) => r.map((x) => x.s.c).join('');

test('mapa por preço: só com preço; recentes antes, confiabilidade baixa e antigos no fim', () => {
  assert.equal(ids(mapPicks(rows, 'preco', null)), 'AECB');
});
test('mapa por avaliação: pela nota e, no empate, o mais perto', () => {
  assert.equal(ids(mapPicks(rows, 'avaliacao', null)), 'FDEABC');
});
test('o sugerido sempre aparece, mesmo fora dos primeiros', () => {
  assert.equal(ids(mapPicks(rows, 'avaliacao', 'C', 2)), 'FDC');
  assert.equal(ids(mapPicks(rows, 'preco', 'A', 2)), 'AE');
});
