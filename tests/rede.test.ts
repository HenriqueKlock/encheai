import { test } from 'node:test';
import assert from 'node:assert/strict';
import { goodShare, priceOf, recommend, reliability, stationsFor, yieldOf, type CarModel, type Station, type StationLive } from '../src/postos.ts';

const base = { lat: -27.6, lon: -48.5 };
const st = (c: string, pr: Station['pr']): Station => ({ c, n: 'Posto ' + c, b: 'Bandeira branca', e: 'Rua A', br: 'Centro', m: 'Cidade', pg: 'n', la: base.lat, lo: base.lon, pr, f: { n: 2, ult: '2025-01-01', ev: [] } });
const today = '2026-10-20';
const car: CarModel = { kmlG: 10, kmlE: 7, measured: true, fuels: ['gasolina', 'etanol'], kmTank: 450 };
const live = (c: string, p: Partial<StationLive>): StationLive => ({ station_id: c, price: {}, yield: null, ratings: null, ...p });

test('preço: o mais recente vale; no mesmo dia, o seu > rede > ANP', () => {
  const s = st('1', { gc: [6.5, '2026-10-08'] });
  const net = live('1', { price: { gasolina: { v: 6.3, d: '2026-10-18', n: 3 } } });
  assert.deepEqual(priceOf(s, 'gasolina', [], net), { price: 6.3, date: '2026-10-18', src: 'rede', n: 3 });
  const mine = [{ station_id: '1', fuel: 'gasolina' as const, price: 6.29, date: '2026-10-18' }];
  assert.equal(priceOf(s, 'gasolina', mine, net)?.src, 'voce');
  assert.equal(priceOf(s, 'gasolina', [], null)?.src, 'anp');
});

test('rendimento: só conta quando publicado, limitado a ±10%', () => {
  assert.equal(yieldOf(live('1', { yield: { r: 1.05, people: 9, tanks: 30, pub: true } })), 1.05);
  assert.equal(yieldOf(live('1', { yield: { r: null, people: 3, tanks: 7, pub: false } })), null);
  assert.equal(yieldOf(live('1', { yield: { r: 1.3, people: 9, tanks: 30, pub: true } })), 1.1);
});

test('rendimento medido entra no custo e muda a recomendação', () => {
  const a = st('1', { gc: [6.5, '2026-10-18'] }), b = st('2', { gc: [6.4, '2026-10-18'] });
  const net = new Map([['1', live('1', { yield: { r: 1.05, people: 9, tanks: 30, pub: true } })]]);
  const rows = stationsFor([a, b], { kind: 'ponto', at: base, radiusKm: 5 }, { ...car, fuels: ['gasolina'] }, [], today, undefined, net);
  // 6,50 rendendo 5% a mais sai mais barato por km que 6,40 normal
  assert.equal(recommend(rows).best?.s.c, '1');
  assert.equal(recommend(rows).best?.yieldR, 1.05);
});

test('rendimento baixo ou bomba mal avaliada limitam a nota a "atenção"', () => {
  const s = st('1', {});
  assert.equal(reliability(s, today, null, live('1', { yield: { r: 0.92, people: 6, tanks: 17, pub: true } })).netWarn, 'rendimento');
  assert.equal(reliability(s, today, null, live('1', { yield: { r: 0.92, people: 6, tanks: 17, pub: true } })).level, 'atencao');
  const bomba = live('1', { ratings: { n: 8, bomba: [3, 8], atendimento: null, banheiro: null } });
  assert.equal(reliability(s, today, null, bomba).netWarn, 'bomba');
  assert.equal(goodShare(bomba, 'bomba'), 3 / 8);
  assert.equal(reliability(s, today, null, null).netWarn, null);
});

test('preço informado (visto na bomba): marcado como informado e, no mesmo dia, o pago vale antes do visto', () => {
  const s: Station = { c: '9', n: 'Posto 9', b: 'Bandeira branca', e: 'Rua', br: 'Centro', m: 'Cidade', pg: 'n', la: -27.6, lo: -48.5, pr: { gc: [6.9, '2026-10-01'] } };
  const live: StationLive = { station_id: '9', price: { gasolina: { v: 6.49, d: '2026-10-19', n: 2, k: 'informado' } }, yield: null, ratings: null };
  assert.deepEqual(priceOf(s, 'gasolina', [], live), { price: 6.49, date: '2026-10-19', src: 'rede', n: 2, seen: true });
  const own = [{ station_id: '9', fuel: 'gasolina' as const, price: 6.45, date: '2026-10-20', seen: true }, { station_id: '9', fuel: 'gasolina' as const, price: 6.39, date: '2026-10-20' }];
  assert.deepEqual(priceOf(s, 'gasolina', own, live), { price: 6.39, date: '2026-10-20', src: 'voce' });
  assert.equal(priceOf(s, 'gasolina', [own[0]], live)!.seen, true);
});
