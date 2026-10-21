import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canAskAfter, pendingAfter, previousFill, tankVsNormal, usedEnough } from '../src/depois.ts';

const today = '2026-10-21';
const f = (id: string, date: string, km: number, station: string | null, v = 'c1') => ({ id, vehicle_id: v, date, odometer_km: km, station_id: station, deleted_at: null as string | null });

test('a pergunta é sobre o abastecimento anterior, no posto dele (mesmo que o novo seja em outro posto)', () => {
  const logs = [f('a', '2026-10-01', 1000, 'P1'), f('b', '2026-10-10', 1400, 'P1'), f('x', '2026-10-12', 900, 'P9', 'outro'), f('c', '2026-10-20', 1800, 'P2')];
  assert.equal(previousFill(logs, logs[3])?.id, 'b');
  assert.equal(previousFill(logs, logs[3])?.station_id, 'P1');
  assert.equal(previousFill(logs, logs[0]), null);
  // mesmo dia: vale o km
  const sameDay = [f('m', '2026-10-20', 1700, 'P1'), f('n', '2026-10-20', 1750, 'P3')];
  assert.equal(previousFill(sameDay, sameDay[1])?.id, 'm');
});

test('só pergunta com posto, até 30 dias e sem resposta', () => {
  assert.equal(canAskAfter(f('a', '2026-10-01', 1, 'P1'), today), true);
  assert.equal(canAskAfter(f('a', '2026-09-10', 1, 'P1'), today), false);
  assert.equal(canAskAfter(f('a', '2026-10-01', 1, null), today), false);
  assert.equal(canAskAfter(f('a', '2026-10-01', 1, 'P1'), today, { after_effect: 'normal' }), false);
});

test('no histórico: no dia seguinte ou quando já abasteceu de novo', () => {
  const logs = [f('a', '2026-10-20', 1000, 'P1'), f('b', '2026-10-21', 1300, 'P2')];
  assert.equal(usedEnough(logs[0], logs, today), true); // já abasteceu de novo
  assert.equal(usedEnough(logs[1], logs, today), false); // hoje
  assert.equal(usedEnough(f('z', '2026-10-19', 1, 'P1'), [], today), true);
});

test('aviso no Início: último abastecimento do carro, de 1 a 30 dias, sem resposta e não dispensado', () => {
  const logs = [f('a', '2026-10-01', 1000, 'P1'), f('b', '2026-10-12', 1400, 'P1'), f('c', '2026-10-13', 500, 'P5', 'c2')];
  assert.equal(pendingAfter(logs, {}, today)?.id, 'c'); // o mais recente entre os carros
  assert.equal(pendingAfter(logs, { c: { after_effect: 'falhou' } }, today)?.id, 'b');
  assert.equal(pendingAfter(logs, {}, today, ['c', 'b']), null);
  assert.equal(pendingAfter([f('h', today, 1, 'P1')], {}, today), null); // abasteceu hoje
  assert.equal(pendingAfter([f('h', '2026-10-20', 1, 'P1')], {}, today)?.id, 'h'); // ontem: já pergunta
});

test('tanque comparado ao normal do carro', () => {
  const iv = [{ start_id: 'a', kml: 10, fuel: 'gasolina' }, { start_id: 'b', kml: 10.4, fuel: 'gasolina' }, { start_id: 'c', kml: 9.6, fuel: 'gasolina' }, { start_id: 'd', kml: 7, fuel: 'etanol' }];
  assert.equal(Math.round(tankVsNormal(iv, 'c')! * 1000) / 1000, -0.059); // 9,6 contra a mediana 10,2
  assert.equal(tankVsNormal(iv, 'd'), null); // sem base suficiente do mesmo combustível
  assert.equal(tankVsNormal(iv, 'zz'), null);
});
