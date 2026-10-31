import test from 'node:test';
import assert from 'node:assert/strict';
import { teBewaren } from '../prijs-historie-spel.mjs';

const nu = Date.parse('2026-10-31T06:00:00Z');
const dagenGeleden = (d) => new Date(nu - d * 86400000).toISOString();

test('eerste meting wordt altijd bewaard', () => assert.equal(teBewaren(undefined, 1.5, nu), true));
test('geen prijs: niet bewaren', () => assert.equal(teBewaren(undefined, 0, nu), false));
test('binnen een week en kleine verandering: niet bewaren', () => assert.equal(teBewaren({ prijs: 2, gemeten_op: dagenGeleden(2) }, 2.2, nu), false));
test('na een week: wel bewaren, ook zonder verandering', () => assert.equal(teBewaren({ prijs: 2, gemeten_op: dagenGeleden(7) }, 2, nu), true));
test('sprong >= 25% en >= 0,10: eerder bewaren', () => assert.equal(teBewaren({ prijs: 2, gemeten_op: dagenGeleden(1) }, 3, nu), true));
test('grote procentuele sprong maar onder 0,10: niet bewaren', () => assert.equal(teBewaren({ prijs: 0.2, gemeten_op: dagenGeleden(1) }, 0.28, nu), false));
