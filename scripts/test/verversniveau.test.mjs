import test from 'node:test';
import assert from 'node:assert/strict';
import { verversDagen, niveauWaarde, aanDeBeurt } from '../lib/verversniveau.mjs';

const nu = Date.parse('2026-11-10T07:00:00Z');
const dagenGeleden = (d) => new Date(nu - d * 86400000).toISOString();

test('grenzen: vanaf 4 dagelijks, vanaf 0,50 wekelijks, daaronder maandelijks', () => {
  assert.equal(verversDagen(4), 1);
  assert.equal(verversDagen(181.09), 1);
  assert.equal(verversDagen(3.99), 7);
  assert.equal(verversDagen(0.5), 7);
  assert.equal(verversDagen(0.49), 30);
  assert.equal(verversDagen(0), 30);
  assert.equal(verversDagen(null), 30);
});
test('niveauWaarde neemt de hoogste, ook als er een ontbreekt', () => {
  assert.equal(niveauWaarde(0.3, 5), 5);
  assert.equal(niveauWaarde(0.3, null), 0.3);
  assert.equal(niveauWaarde(undefined, undefined), 0);
});
test('zonder datum altijd aan de beurt', () => {
  assert.equal(aanDeBeurt(undefined, 30, nu), true);
  assert.equal(aanDeBeurt('onzin', 30, nu), true);
});
test('dagelijks: 23,9 uur geleden telt als een dag, 2 uur geleden niet', () => {
  assert.equal(aanDeBeurt(new Date(nu - 23.9 * 3600000).toISOString(), 1, nu), true);
  assert.equal(aanDeBeurt(new Date(nu - 2 * 3600000).toISOString(), 1, nu), false);
});
test('wekelijks en maandelijks', () => {
  assert.equal(aanDeBeurt(dagenGeleden(5), 7, nu), false);
  assert.equal(aanDeBeurt(dagenGeleden(7), 7, nu), true);
  assert.equal(aanDeBeurt(dagenGeleden(20), 30, nu), false);
  assert.equal(aanDeBeurt(dagenGeleden(30), 30, nu), true);
});
