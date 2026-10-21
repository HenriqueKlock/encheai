import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoMap, detect, missing, parseCsv, tableToParsed, TEMPLATES } from '../src/planilha.ts';

test('CSV com ; e aspas, do jeito que o Excel em português salva', () => {
  const rows = parseCsv('﻿Data;Valor;Obs\r\n14/03/2025;"250,30";"posto ""bom""; perto"\r\n');
  assert.deepEqual(rows, [['Data', 'Valor', 'Obs'], ['14/03/2025', '250,30', 'posto "bom"; perto']]);
});

test('cabeçalhos: preço por litro não vira litros nem valor', () => {
  const m = autoMap(['Dia', 'KM atual', 'Valor do litro', 'Litros', 'Total pago', 'Tipo', 'Completou?'], 'abastecimentos');
  assert.equal(m.data, 0);
  assert.equal(m.km, 1);
  assert.equal(m.preco_litro, 2);
  assert.equal(m.litros, 3);
  assert.equal(m.valor_total, 4);
  assert.equal(m.combustivel, 5);
  assert.equal(m.tanque_cheio, 6);
});

test('modelo de abastecimentos: reconhece e importa', () => {
  const t = { name: 'x', rows: parseCsv(TEMPLATES.abastecimentos.csv) };
  const d = detect(t)!;
  assert.deepEqual(d, { headerRow: 0, kind: 'abastecimentos' });
  const map = autoMap(t.rows[0], d.kind);
  assert.deepEqual(missing(map, d.kind), []);
  const p = tableToParsed(t, 0, d.kind, map);
  assert.equal(p.fills.length, 2);
  assert.equal(p.fills[1].fuel, 'etanol');
  assert.equal(p.fills[0].total_brl, 250.3);
});

test('modelo de manutenções: linhas da mesma OS viram uma ida à oficina', () => {
  const t = { name: 'x', rows: parseCsv(TEMPLATES.manutencoes.csv) };
  const d = detect(t)!;
  assert.equal(d.kind, 'manutencoes');
  const p = tableToParsed(t, 0, d.kind, autoMap(t.rows[0], d.kind));
  assert.equal(p.services.length, 2);
  assert.equal(p.services[0].items.length, 2);
  assert.equal(p.services[0].os_number, '1234');
  assert.deepEqual(p.services[0].items.map((i) => i.plan_item_key), ['oleo_motor', 'filtro_oleo']);
  assert.equal(p.services[1].type, 'pneus');
  assert.equal(p.services[1].items[0].labor_brl, 120);
});

test('título antes do cabeçalho, células mescladas e linha incompleta', () => {
  const t = { name: 'x', rows: [
    ['Controle do carro 2024', null, null, null],
    [],
    ['Data', 'Km', 'Serviço', 'Valor'],
    ['10/05/2024', 30000, 'Troca de óleo', 'R$ 200,00'],
    [null, null, 'Filtro de ar', '45'],
    ['sem data', null, 'Lavagem', '30'],
  ] };
  const d = detect(t)!;
  assert.deepEqual(d, { headerRow: 2, kind: 'manutencoes' });
  const p = tableToParsed(t, d.headerRow, d.kind, autoMap(t.rows[2], d.kind));
  assert.equal(p.services.length, 1);
  assert.equal(p.services[0].items.length, 2);
  assert.equal(p.services[0].items[1].plan_item_key, 'filtro_ar');
  assert.match(p.warnings.join('|'), /Linha 6: sem data/);
});

test('falta coluna obrigatória', () => {
  assert.deepEqual(missing(autoMap(['Data', 'Litros'], 'abastecimentos'), 'abastecimentos'), ['Km (odômetro)', 'dois entre Litros, Valor pago e Preço por litro']);
});
