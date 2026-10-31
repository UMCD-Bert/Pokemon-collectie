// Bewaart het prijsverloop per eigen Lorcana- en Magic-kaart (tabel prijs_historie_spel), voor de knop "Prijsverloop" in de native app.
// Zelfde regel als bij Pokémon (prijs_historie): hooguit wekelijks per druk, of eerder bij een sprong (>= 25% en >= 0,10).
// Prijs = wat de app toont: de waarde van het exemplaar (prijscontrole) of anders de prijs van de kaart. Lorcana in dollars, Magic in euro.
// Idempotent: draait het twee keer op één dag, dan komt er geen dubbele rij.
//
// Gebruik: SUPABASE_URL=… SUPABASE_KEY=… node scripts/prijs-historie-spel.mjs     (DRY_RUN=1: alleen tonen)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const DRY_RUN = process.env.DRY_RUN === '1';
const SB = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' };
const WEEK_MS = 6.5 * 24 * 3600 * 1000;

async function alles(tabel, query) {
  let uit = [];
  for (let offset = 0; ; offset += 1000) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${tabel}?${query}&limit=1000&offset=${offset}`, { headers: SB });
    if (!r.ok) throw new Error(`${tabel}: status ${r.status}`);
    const b = await r.json(); uit = uit.concat(b);
    if (b.length < 1000) return uit;
  }
}
const num = (x) => (x === null || x === undefined ? null : Number(x));

// Moet een nieuwe meting worden bewaard? `laatste` = { prijs, gemeten_op } of undefined.
export function teBewaren(laatste, prijs, nu = Date.now()) {
  if (!(prijs > 0)) return false;
  if (!laatste) return true;
  if (nu - new Date(laatste.gemeten_op).getTime() >= WEEK_MS) return true;
  const delta = Math.abs(prijs - laatste.prijs);
  return delta >= 0.10 && laatste.prijs > 0 && delta / laatste.prijs >= 0.25;
}

async function main() {
  if (!SUPABASE_URL || !SUPABASE_KEY) { console.error('SUPABASE_URL en/of SUPABASE_KEY ontbreken.'); process.exit(1); }
  const lk = new Map((await alles('lorcana_set_kaarten', 'select=id,prijs_normaal,prijs_foil&order=id.asc')).map(k => [k.id, k]));
  const mk = new Map((await alles('magic_kaarten', 'select=id,prijs_normaal,prijs_foil,prijs_etched&order=id.asc')).map(k => [k.id, k]));
  const huidig = new Map(); // sleutel -> { spel, kaart_id, versie, prijs }
  for (const e of await alles('lorcana_exemplaren', 'select=id,parent_id,versie,waarde&order=id.asc')) {
    const k = lk.get(e.parent_id) || {};
    const p = num(e.waarde) ?? num(e.versie === 'Foil' ? k.prijs_foil : k.prijs_normaal);
    if (p) huidig.set(`lorcana|${e.parent_id}|${e.versie}`, { spel: 'lorcana', kaart_id: e.parent_id, versie: e.versie, prijs: p });
  }
  for (const e of await alles('magic_exemplaren', 'select=id,kaart_id,versie,waarde&order=id.asc')) {
    const k = mk.get(e.kaart_id) || {};
    const p = num(e.waarde) ?? num(e.versie === 'Foil' ? k.prijs_foil : e.versie === 'Etched' ? k.prijs_etched : k.prijs_normaal);
    if (p) huidig.set(`magic|${e.kaart_id}|${e.versie}`, { spel: 'magic', kaart_id: e.kaart_id, versie: e.versie, prijs: p });
  }

  // Laatste meting per druk (alle rijen, nieuwste eerst; de tabel blijft klein).
  const laatste = new Map();
  for (const r of await alles('prijs_historie_spel', 'select=spel,kaart_id,versie,prijs,gemeten_op&order=gemeten_op.desc,id.desc')) {
    const s = `${r.spel}|${r.kaart_id}|${r.versie}`;
    if (!laatste.has(s)) laatste.set(s, { prijs: num(r.prijs), gemeten_op: r.gemeten_op });
  }

  const nieuw = [];
  for (const [s, d] of huidig) if (teBewaren(laatste.get(s), d.prijs)) nieuw.push({ ...d, bron: 'nachtelijk' });
  console.log(`Eigen drukken: ${huidig.size}; nieuwe metingen: ${nieuw.length}`);
  if (DRY_RUN || !nieuw.length) return;
  for (let i = 0; i < nieuw.length; i += 500) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/prijs_historie_spel`, { method: 'POST', headers: { ...SB, Prefer: 'return=minimal' }, body: JSON.stringify(nieuw.slice(i, i + 500)) });
    if (!r.ok) throw new Error(`insert: status ${r.status} ${await r.text()}`);
  }
  console.log('Bewaard.');
}
if (process.argv[1] && process.argv[1].endsWith('prijs-historie-spel.mjs')) main().catch(e => { console.error(e); process.exit(1); });
