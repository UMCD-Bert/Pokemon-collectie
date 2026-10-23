// Ververst de Lorcana-kaarten en -prijzen (USD, TCGplayer) vanuit Lorcast naar de tabel lorcana_set_kaarten.
// Nieuwe sets en kaarten worden vanzelf toegevoegd; bezit (lorcana_exemplaren) blijft ongemoeid.
// Dezelfde rij-indeling als de native app (LorcastClient.Kaart.dbRij), upsert op lorcast_id.
//
// Gebruik: SUPABASE_URL=… SUPABASE_KEY=… node scripts/update-lorcana.mjs
//   DRY_RUN=1  alleen ophalen en tellen;  ONLY_SET=14  alleen die set.
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const DRY_RUN = process.env.DRY_RUN === '1';
const ONLY_SET = process.env.ONLY_SET || '';
if (!SUPABASE_URL || !SUPABASE_KEY) { console.error('SUPABASE_URL en/of SUPABASE_KEY ontbreken.'); process.exit(1); }

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const LORCAST = 'https://api.lorcast.com/v0';

async function withRetry(fn, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) { last = e; await sleep(600 * (i + 1)); }
  }
  throw last;
}

async function lorcast(pad) {
  return withRetry(async () => {
    const r = await fetch(`${LORCAST}/${pad}`, { headers: { 'User-Agent': 'pokemon-collectie-job/1.0' } });
    if (!r.ok) throw new Error(`Lorcast ${pad}: status ${r.status}`);
    return r.json();
  });
}

const tekst = (s) => (s === undefined || s === null || s === '' ? null : s);
const getal = (s) => { const n = parseFloat(s); return Number.isFinite(n) ? n : null; };

function dbRij(k, nu) {
  return {
    lorcast_id: k.id, set_code: k.set.code, set_naam: k.set.name, collector_number: k.collector_number,
    naam: k.name, versie: tekst(k.version), ink: tekst(k.ink ?? (k.inks ? k.inks.join('/') : null)),
    rarity: tekst(k.rarity), type: tekst(k.type ? k.type.join(', ') : null),
    kosten: k.cost ?? null, sterkte: k.strength ?? null, wilskracht: k.willpower ?? null, lore: k.lore ?? null,
    afbeelding: tekst(k.image_uris?.digital?.normal), flavor_text: tekst(k.flavor_text),
    prijs_normaal: getal(k.prices?.usd), prijs_foil: getal(k.prices?.usd_foil), prijs_updated: nu,
  };
}

async function upsert(rijen) {
  await withRetry(async () => {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/lorcana_set_kaarten?on_conflict=lorcast_id`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(rijen),
    });
    if (!r.ok) throw new Error(`upsert status ${r.status}: ${await r.text()}`);
  });
}

async function main() {
  const sets = (await lorcast('sets')).results.filter(s => !ONLY_SET || s.code === ONLY_SET);
  const nu = new Date().toISOString();
  let kaarten = 0, mislukt = 0;
  for (const s of sets) {
    try {
      const lijst = await lorcast(`sets/${encodeURIComponent(s.code)}/cards`);
      if (!lijst.length) continue;
      const rijen = lijst.map(k => dbRij(k, nu));
      if (!DRY_RUN) for (let i = 0; i < rijen.length; i += 100) await upsert(rijen.slice(i, i + 100));
      kaarten += rijen.length;
      console.log(`✓ ${s.code} ${s.name}: ${rijen.length} kaarten`);
    } catch (e) {
      mislukt++;
      console.log(`✗ ${s.code} ${s.name}: ${e.message}`);
    }
    await sleep(120);
  }
  console.log(`Klaar: ${kaarten} kaarten in ${sets.length - mislukt} sets bijgewerkt, ${mislukt} sets mislukt.`);
  if (mislukt === sets.length && sets.length > 0) process.exitCode = 1;
}

main().catch(e => { console.error(e); process.exit(1); });
