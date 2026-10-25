// Bewaart elke dag de collectiewaarde per spel (tabel waarde_historie), voor de grafiek "Waarde door de tijd" in de native app.
// Alles in euro; Lorcana (dollars) wordt omgerekend met de ECB-koers van vandaag. Idempotent: één rij per dag per spel (upsert).
//
// Gebruik: SUPABASE_URL=… SUPABASE_KEY=… node scripts/waarde-snapshot.mjs     (DRY_RUN=1: alleen tonen)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const DRY_RUN = process.env.DRY_RUN === '1';
if (!SUPABASE_URL || !SUPABASE_KEY) { console.error('SUPABASE_URL en/of SUPABASE_KEY ontbreken.'); process.exit(1); }
const SB = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' };

async function alles(tabel, query) {
  let uit = [];
  for (let offset = 0; ; offset += 1000) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${tabel}?${query}&limit=1000&offset=${offset}`, { headers: SB });
    if (!r.ok) throw new Error(`${tabel}: status ${r.status}`);
    const b = await r.json(); uit = uit.concat(b);
    if (b.length < 1000) return uit;
  }
}
async function koers() {
  for (const url of ['https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR', 'https://api.frankfurter.app/latest?from=USD&to=EUR']) {
    try { const j = await (await fetch(url)).json(); if (j.rates && j.rates.EUR) return j.rates.EUR; } catch { /* volgende */ }
  }
  return 0.9;
}
const num = (x) => (x === null || x === undefined ? null : Number(x));

function stand(regels, sealed) {
  // regels: { waarde (per stuk, euro), aantal, niveau, vast, sleutel }
  const s = { kaarten_waarde: 0, sealed_waarde: sealed, aantal: 0, unieke: new Set(), solide: 0, enkel: 0, twijfel: 0 };
  for (const r of regels) {
    const w = (r.waarde || 0) * r.aantal;
    s.kaarten_waarde += w; s.aantal += r.aantal; s.unieke.add(r.sleutel);
    if (r.vast || r.niveau === 'solide') s.solide += w; else if (r.niveau === 'twijfel') s.twijfel += w; else s.enkel += w;
  }
  return { ...s, unieke: s.unieke.size };
}

async function main() {
  const datum = new Date().toISOString().slice(0, 10);
  const usd = await koers();
  const sealed = await alles('sealed_producten', 'select=spel,aantal,huidige_waarde');
  const sealedPer = (spel) => sealed.filter(p => (p.spel || 'pokemon') === spel).reduce((t, p) => t + (num(p.huidige_waarde) || 0) * Math.max(1, p.aantal || 1), 0);

  const pk = (await alles('kaart_exemplaren', 'select=id,parent_type,parent_id,waarde,aantal,prijs_betrouwbaarheid,prijs_vast,prijs_handmatig_datum&order=id.asc'))
    .map(e => ({ waarde: num(e.waarde), aantal: Math.max(1, e.aantal || 1), niveau: e.prijs_betrouwbaarheid, vast: e.prijs_vast || !!e.prijs_handmatig_datum, sleutel: `${e.parent_type}:${e.parent_id}` }));

  const lk = new Map((await alles('lorcana_set_kaarten', 'select=id,prijs_normaal,prijs_foil&order=id.asc')).map(k => [k.id, k]));
  const lc = (await alles('lorcana_exemplaren', 'select=id,parent_id,versie,aantal,waarde,prijs_betrouwbaarheid&order=id.asc')).map(e => {
    const k = lk.get(e.parent_id) || {};
    const prijs = num(e.waarde) ?? num(e.versie === 'Foil' ? k.prijs_foil : k.prijs_normaal);
    return { waarde: prijs === null ? 0 : prijs * usd, aantal: Math.max(1, e.aantal || 1), niveau: e.prijs_betrouwbaarheid, vast: false, sleutel: e.parent_id };
  });

  const mk = new Map((await alles('magic_kaarten', 'select=id,prijs_normaal,prijs_foil,prijs_etched&order=id.asc')).map(k => [k.id, k]));
  const mg = (await alles('magic_exemplaren', 'select=id,kaart_id,versie,aantal,waarde,prijs_betrouwbaarheid&order=id.asc')).map(e => {
    const k = mk.get(e.kaart_id) || {};
    const prijs = num(e.waarde) ?? num(e.versie === 'Foil' ? k.prijs_foil : e.versie === 'Etched' ? k.prijs_etched : k.prijs_normaal);
    return { waarde: prijs || 0, aantal: Math.max(1, e.aantal || 1), niveau: e.prijs_betrouwbaarheid, vast: false, sleutel: e.kaart_id };
  });

  const rijen = [['pokemon', pk], ['lorcana', lc], ['magic', mg]].map(([spel, regels]) => {
    const s = stand(regels, sealedPer(spel));
    const r = (x) => Math.round(x * 100) / 100;
    return { datum, spel, kaarten_waarde: r(s.kaarten_waarde), sealed_waarde: r(s.sealed_waarde), aantal: s.aantal, unieke: s.unieke,
             solide: r(s.solide), enkel: r(s.enkel), twijfel: r(s.twijfel) };
  });
  for (const r of rijen) console.log(`${r.datum} ${r.spel}: kaarten € ${r.kaarten_waarde}, sealed € ${r.sealed_waarde}, ${r.aantal} kaarten (${r.unieke} unieke)`);
  if (DRY_RUN) return;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/waarde_historie?on_conflict=datum,spel`, {
    method: 'POST', headers: { ...SB, Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rijen),
  });
  if (!res.ok) throw new Error(`waarde_historie: status ${res.status} ${await res.text()}`);
  console.log('Opgeslagen.');
}
main().catch(e => { console.error(e); process.exit(1); });
