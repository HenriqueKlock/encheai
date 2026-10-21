import { test } from 'node:test';
import assert from 'node:assert/strict';
import { photonLabel } from '../src/endereco.ts';

const describe = (_: string, f: () => void) => f();
const it = test;
const expect = (v: unknown) => ({ toEqual: (w: unknown) => assert.deepEqual(v, w), toBe: (w: unknown) => assert.equal(v, w), not: { toContain: (w: string) => assert.ok(!String(v).includes(w)) } });

describe('photonLabel (sugestões do OpenStreetMap)', () => {
  it('rua: nome e bairro, cidade e estado no detalhe', () => {
    expect(photonLabel({ type: 'street', osm_key: 'highway', name: 'Rua XV de Novembro', district: 'Centro', city: 'Blumenau', state: 'Santa Catarina' }))
      .toEqual({ label: 'Rua XV de Novembro · Centro', detail: 'Blumenau, Santa Catarina' });
  });
  it('endereço com número: guarda só a rua, nunca o número', () => {
    const r = photonLabel({ type: 'house', street: 'Rua das Flores', housenumber: '123', district: 'Itacorubi', city: 'Florianópolis', state: 'Santa Catarina' });
    expect(r.label).toBe('Rua das Flores · Itacorubi');
    expect(JSON.stringify(r)).not.toContain('123');
  });
  it('bairro e cidade', () => {
    expect(photonLabel({ type: 'district', name: 'Trindade', city: 'Florianópolis', state: 'Santa Catarina' }))
      .toEqual({ label: 'Trindade', detail: 'Florianópolis, Santa Catarina' });
    expect(photonLabel({ type: 'city', name: 'Joinville', state: 'Santa Catarina' })).toEqual({ label: 'Joinville', detail: 'Santa Catarina' });
  });
  it('estabelecimento: nome e rua, bairro no detalhe', () => {
    expect(photonLabel({ type: 'house', osm_key: 'amenity', name: 'Shopping Iguatemi', street: 'Av. Madre Benvenuta', district: 'Santa Mônica', city: 'Florianópolis', state: 'Santa Catarina' }))
      .toEqual({ label: 'Shopping Iguatemi · Av. Madre Benvenuta', detail: 'Santa Mônica, Florianópolis, Santa Catarina' });
    expect(photonLabel({ type: 'other', osm_key: 'amenity', name: 'UFSC', street: 'Rua Eng. Agronômico Andrei Cristian Ferreira', district: 'Trindade', city: 'Florianópolis', state: 'SC' }))
      .toEqual({ label: 'UFSC · Rua Eng. Agronômico Andrei Cristian Ferreira', detail: 'Trindade, Florianópolis, SC' });
  });
});
