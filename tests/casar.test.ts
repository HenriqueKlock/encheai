import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bestForStation, type GoogleStation } from '../src/casar.ts';

test('a função do servidor usa a mesma comparação que o app', () => {
  const a = readFileSync(new URL('../src/casar.ts', import.meta.url), 'utf8');
  const b = readFileSync(new URL('../supabase/functions/postos-ligar/casar.ts', import.meta.url), 'utf8');
  assert.equal(b, a, 'rode: cp src/casar.ts supabase/functions/postos-ligar/casar.ts');
});

test('busca pelo endereço acha o posto certo e recusa outra bandeira', () => {
  const s = { c: '1', n: 'Posto Galo', e: 'Rodovia Jose Carlos Daux SC-401, 7467', b: 'Petrobras', la: -27.5061, lo: -48.5188, pg: 'b' };
  const g = (id: string, name: string, address: string, lat: number, lon: number): GoogleStation => ({ id, name, address, lat, lon, rating: null, count: 0 });
  const hit = bestForStation([
    g('shell', 'Posto Shell Ponta das Canas', 'Rod. José Carlos Daux, 9000 - Florianópolis', -27.505, -48.517),
    g('galo', 'Posto Galo BR', 'Rod. José Carlos Daux, 7467 - Santo Antônio de Lisboa, Florianópolis - SC', -27.52, -48.50),
  ], s);
  assert.equal(hit?.id, 'galo');
});

test('mesmo endereço com dois cadastros no Google: os dois são o mesmo ponto', async () => {
  const { sameSpot } = await import('../src/casar.ts');
  const s = { c: '1', n: 'Posto Ipiranga', e: 'Rua Silva Jardim, 73', b: 'Shell', la: -27.6, lo: -48.55, pg: 'n' };
  const g = (id: string, name: string, address: string, lat: number, lon: number): GoogleStation => ({ id, name, address, lat, lon, rating: null, count: 0 });
  const a = g('sc', 'Posto SC', 'R. Silva Jardim, 73 - Centro, Florianópolis - SC', -27.6001, -48.5501);
  const b = g('shell', 'Shell', 'R. Silva Jardim, 73 - Centro, Florianópolis - SC', -27.6003, -48.5499);
  const c = g('outro', 'Posto Avenida', 'Av. Mauro Ramos, 900 - Centro, Florianópolis - SC', -27.59, -48.54);
  assert.equal(sameSpot(a, b, s), true);
  assert.equal(sameSpot(a, c, s), false);
});

test('nome da ANP sem a bandeira antiga', async () => {
  const { anpName } = await import('../src/postos.ts');
  assert.equal(anpName({ n: 'Posto Ipiranga', b: 'Shell' }), 'Posto Shell');
  assert.equal(anpName({ n: 'Posto Galo', b: 'Petrobras' }), 'Posto Galo');
  assert.equal(anpName({ n: 'Posto Ipiranga', b: 'Bandeira branca' }), 'Posto Ipiranga');
});
