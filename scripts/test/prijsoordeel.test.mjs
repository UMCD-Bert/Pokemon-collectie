import test from 'node:test';
import assert from 'node:assert/strict';
import { oordeel, grootsteGroep, springerigheid, mediaan } from '../lib/prijsoordeel.mjs';

const b = (id, eur, extra = {}) => ({ id, label: id, eur, ...extra });

test('twee bronnen die overeenkomen: solide, mediaan', () => {
  const o = oordeel([b('cm', 10), b('tp', 12)]);
  assert.equal(o.niveau, 'solide');
  assert.equal(o.waarde, 11);
});

test('kleingeld telt als overeen (€ 0,24 tegen € 0,44)', () => {
  assert.equal(oordeel([b('cm', 0.24), b('tp', 0.44)]).niveau, 'solide');
});

test('tegenstrijdig: twijfel en de laagste', () => {
  const o = oordeel([b('cm', 136), b('tp', 15)]);
  assert.equal(o.niveau, 'twijfel');
  assert.equal(o.waarde, 15);
});

test('gedeeld product telt niet mee (Raikou)', () => {
  const o = oordeel([b('tcgdex', 136.17, { onbetrouwbaar: 'zelfde prijs als #13' }), b('pw', 16.7), b('tp', 14.7)]);
  assert.equal(o.niveau, 'solide');
  assert.ok(Math.abs(o.waarde - 15.7) < 0.01);
  assert.match(o.reden, /Niet meegeteld/);
});

test('meerderheid wint, uitschieter wordt genoemd', () => {
  const o = oordeel([b('a', 10), b('b', 11), b('c', 90)]);
  assert.equal(o.niveau, 'solide');
  assert.match(o.reden, /Wijkt af/);
  assert.equal(o.waarde, 10.5);
});

test('één bron: enkel; één bron met bekend probleem: twijfel', () => {
  assert.equal(oordeel([b('tcgdex', 5)]).niveau, 'enkel');
  assert.equal(oordeel([b('tcgdex', 5), b('x', 80, { onbetrouwbaar: 'gedeeld' })]).niveau, 'twijfel');
});

test('geen bruikbare bron', () => {
  assert.equal(oordeel([]).waarde, null);
  assert.equal(oordeel([b('x', 80, { onbetrouwbaar: 'gedeeld' })]).niveau, 'twijfel');
});

test('springerige markt maakt een overeenkomst toch twijfel', () => {
  const o = oordeel([b('cm', 80), b('tp', 90)], { springer: undefined, springerig: springerigheid(80, 19) });
  assert.equal(o.niveau, 'twijfel');
  assert.equal(springerigheid(80, 70), null);
  assert.equal(springerigheid(5, 1), null);
});

test('maxNiveau enkel: nooit solide (spel met één bron)', () => {
  const o = oordeel([b('lorcast', 3), b('x', 3.2)], { maxNiveau: 'enkel' });
  assert.notEqual(o.niveau, 'solide');
});

test('groep en mediaan', () => {
  assert.equal(grootsteGroep([b('a', 1), b('b', 100)]).length, 1);
  assert.equal(mediaan([3, 1, 2]), 2);
});
