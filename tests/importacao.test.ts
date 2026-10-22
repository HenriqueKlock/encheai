import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { aiPrompt, extractJson, guessCategory, isoDate, num, parseImport, planImport, FORMATO } from '../src/importacao.ts';

test('números em vários formatos', () => {
  assert.equal(num('R$ 1.234,56', 'money'), 1234.56);
  assert.equal(num('250,30', 'money'), 250.3);
  assert.equal(num('45.210', 'int'), 45210);
  assert.equal(num('45.210 km', 'int'), 45210);
  assert.equal(num('40.5'), 40.5);
  assert.equal(num('40,512'), 40.512);
  assert.equal(num(6.18, 'money'), 6.18);
  assert.equal(num(''), null);
  assert.equal(num('abc'), null);
});

test('datas em vários formatos', () => {
  assert.equal(isoDate('2025-03-14'), '2025-03-14');
  assert.equal(isoDate('14/03/2025'), '2025-03-14');
  assert.equal(isoDate('4/3/25'), '2025-03-04');
  assert.equal(isoDate(45730), '2025-03-14'); // série do Excel
  assert.equal(isoDate('31/02/2025'), null);
  assert.equal(isoDate('ontem'), null);
});

test('acha o JSON no texto colado da IA, mesmo com vírgula sobrando', () => {
  const t = 'Aqui está:\n```json\n{"formato":"' + FORMATO + '","abastecimentos":[{"data":"2025-01-02","km":1000,"litros":40,"valor_total":240,},]}\n```\nQualquer coisa me avise.';
  const o = extractJson(t) as any;
  assert.equal(o.abastecimentos.length, 1);
  assert.throws(() => extractJson('não tenho dados'), /Não achei/);
});

test('lê o formato da IA: calcula o que falta, descarta o incompleto e guarda os avisos', () => {
  const p = parseImport({
    formato: FORMATO,
    abastecimentos: [
      { data: '2025-01-02', km: 1000, litros: 40, valor_total: 240, combustivel: 'Gasolina comum' },
      { data: '10/01/2025', km: '1.420', valor_total: '180,00', preco_litro: '4,50', combustivel: 'álcool', tanque_cheio: 'não' },
      { data: '2025-01-20', litros: 30, valor_total: 200 },
    ],
    manutencoes: [
      { data: '2025-02-01', km: 1500, oficina: 'Auto Center', os: '123', itens: [
        { descricao: 'Óleo 5W30 sintético', peca: 180, mao_de_obra: 60 },
        { descricao: 'Filtro de óleo', categoria: 'filtro_oleo', peca: 40 },
        { descricao: 'Pastilha de freio dianteira', peca: 220, mao_de_obra: 80 },
      ] },
    ],
    avisos: ['OS 2 ilegível'],
  });
  assert.equal(p.fills.length, 2);
  assert.deepEqual(p.fills[0], { date: '2025-01-02', odometer_km: 1000, liters: 40, total_brl: 240, price_per_l: 6, fuel: 'gasolina', full_tank: true, station: null, note: null });
  assert.equal(p.fills[1].liters, 40);
  assert.equal(p.fills[1].fuel, 'etanol');
  assert.equal(p.fills[1].full_tank, false);
  assert.equal(p.fills[1].odometer_km, 1420);
  assert.match(p.warnings.join('|'), /Abastecimento 3: sem km/);
  assert.match(p.warnings.join('|'), /Da IA: OS 2 ilegível/);
  const s = p.services[0];
  assert.equal(s.type, 'revisao');
  assert.deepEqual(s.items.map((i) => i.plan_item_key), ['oleo_motor', 'filtro_oleo', null]);
  assert.equal(s.items[0].labor_brl, 60);
});

test('backup não passa como importação', () => {
  assert.throws(() => parseImport({ app: 'caderneta-carro', version: 1 }), /backup/);
  assert.throws(() => parseImport({ foo: 1 }), /Não achei/);
});

test('categorias pela descrição', () => {
  assert.equal(guessCategory('Troca de óleo do motor 5W30'), 'oleo_motor');
  assert.equal(guessCategory('Filtro de ar condicionado'), 'filtro_cabine');
  assert.equal(guessCategory('FILTRO DE AR DO MOTOR'), 'filtro_ar');
  assert.equal(guessCategory('Filtro combustível'), 'filtro_combustivel');
  assert.equal(guessCategory('Fluido de freio DOT4'), 'fluido_freio');
  assert.equal(guessCategory('Jogo de velas'), 'velas');
  assert.equal(guessCategory('Aditivo radiador'), 'arrefecimento');
  assert.equal(guessCategory('Alinhamento e balanceamento'), null);
});

test('conferência: tira duplicados, avisa km fora de ordem e preço estranho', () => {
  const p = parseImport({
    abastecimentos: [
      { data: '2025-01-02', km: 1000, litros: 40, valor_total: 240 },   // já existe
      { data: '2025-01-02', km: 1000, litros: 40, valor_total: 240 },   // repetido no arquivo
      { data: '2025-01-15', km: 900, litros: 40, valor_total: 240 },    // km menor que o anterior
      { data: '2025-02-01', km: 1800, litros: 40, valor_total: 800 },   // R$ 20/l
    ],
    manutencoes: [{ data: '2025-02-01', km: 1500, itens: [{ descricao: 'Óleo', peca: 100 }] }],
  });
  const plan = planImport(p, { fills: [{ date: '2025-01-02', odometer_km: 1000, total_brl: 240 }], services: [{ date: '2025-02-01', odometer_km: 1502, shop: null }] }, 'flex');
  assert.equal(plan.fills.length, 2);
  assert.equal(plan.dupFills, 2);
  assert.equal(plan.services.length, 0);
  assert.equal(plan.dupServices, 1);
  assert.match(plan.warnings.join('|'), /Km fora de ordem: 15\/01\/2025/);
  assert.match(plan.warnings.join('|'), /Preço por litro estranho em 01\/02\/2025/);
});

test('prompt de referência cita o formato e as categorias', () => {
  const t = aiPrompt({ name: 'Creta', fuel_type: 'flex' });
  assert.match(t, /encheai-importacao-1/);
  assert.match(t, /oleo_motor, filtro_oleo/);
  assert.match(t, /Creta, flex/);
});

test('a função do servidor usa a mesma cópia do núcleo de importação', () => {
  const a = readFileSync(new URL('../src/importacao.ts', import.meta.url), 'utf8');
  const b = readFileSync(new URL('../supabase/functions/mcp/importacao.ts', import.meta.url), 'utf8');
  assert.equal(b, a, 'rode: cp src/importacao.ts supabase/functions/mcp/importacao.ts');
});

test('conferência avisa km repetido em dias diferentes (o carro não rodou nada entre os dois)', () => {
  const p = parseImport({ formato: FORMATO, abastecimentos: [{ data: '2026-10-20', km: 91110, litros: 30, valor_total: 200, combustivel: 'gasolina' }] });
  const plan = planImport(p, { fills: [{ date: '2026-10-13', odometer_km: 91110, total_brl: 275.13 }], services: [] }, 'flex');
  assert.equal(plan.fills.length, 1);
  assert.ok(plan.warnings.some((w) => w.startsWith('Km repetido: 20/10/2026 e 13/10/2026')), plan.warnings.join(' | '));
});
