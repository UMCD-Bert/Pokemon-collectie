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
const SB = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' };
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

// Lorcana heeft maar één prijsbron (Lorcast = TCGplayer, dollars): nooit "solide", wel "twijfel" bij verdachte patronen.
const DUUR_VOOR_GEWONE = 15;   // $ - een Common/Uncommon boven dit bedrag is verdacht
function beoordeel(kaart, versie, vorige) {
  const usd = parseFloat(versie === 'Foil' ? kaart.prices?.usd_foil : kaart.prices?.usd);
  if (!(usd > 0)) return { niveau: 'enkel', waarde: null, reden: 'Geen prijs bij Lorcast.', bewijs: [] };
  const redenen = [];
  const norm = parseFloat(kaart.prices?.usd), foil = parseFloat(kaart.prices?.usd_foil);
  const rarity = (kaart.rarity || '').toLowerCase();
  if ((rarity === 'common' || rarity === 'uncommon') && usd > DUUR_VOOR_GEWONE) redenen.push(`een ${kaart.rarity} voor $ ${usd.toFixed(2)} is ongebruikelijk`);
  if (versie === 'Foil' && norm > 0 && foil < norm * 0.8) redenen.push(`foil ($ ${foil.toFixed(2)}) is goedkoper dan normaal ($ ${norm.toFixed(2)})`);
  if (vorige > 0 && usd / vorige >= 3 && usd - vorige > 5) redenen.push(`sprong van $ ${vorige.toFixed(2)} naar $ ${usd.toFixed(2)} sinds de vorige meting`);
  const bewijs = [{ bron: 'lorcast', label: 'TCGplayer (via Lorcast)', usd, datum: new Date().toISOString().slice(0, 10) }];
  return redenen.length
    ? { niveau: 'twijfel', waarde: usd, reden: `Controleer: ${redenen.join('; ')}.`, bewijs }
    : { niveau: 'enkel', waarde: usd, reden: `Alleen TCGplayer $ ${usd.toFixed(2)} (geen tweede bron voor Lorcana).`, bewijs };
}

async function eigenExemplaren() {
  let alles = [];
  for (let offset = 0; ; offset += 1000) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/lorcana_exemplaren?select=id,parent_id,versie,waarde,prijs_betrouwbaarheid,prijs_toelichting&order=id.asc&limit=1000&offset=${offset}`, { headers: SB });
    if (!r.ok) throw new Error(`lorcana_exemplaren: status ${r.status}`);
    const b = await r.json(); alles = alles.concat(b);
    if (b.length < 1000) return alles;
  }
}

async function main() {
  const sets = (await lorcast('sets')).results.filter(s => !ONLY_SET || s.code === ONLY_SET);
  const nu = new Date().toISOString();
  const exemplaren = await eigenExemplaren();
  const perLorcastId = new Map();   // lorcast_id → kaart (voor het oordeel)
  const idVanLorcast = new Map();   // lorcast_id → uuid in lorcana_set_kaarten
  let kaarten = 0, mislukt = 0;
  for (const s of sets) {
    try {
      const lijst = await lorcast(`sets/${encodeURIComponent(s.code)}/cards`);
      if (!lijst.length) continue;
      const rijen = lijst.map(k => dbRij(k, nu));
      if (!DRY_RUN) for (let i = 0; i < rijen.length; i += 100) await upsert(rijen.slice(i, i + 100));
      lijst.forEach(k => perLorcastId.set(k.id, k));
      kaarten += rijen.length;
      console.log(`✓ ${s.code} ${s.name}: ${rijen.length} kaarten`);
    } catch (e) {
      mislukt++;
      console.log(`✗ ${s.code} ${s.name}: ${e.message}`);
    }
    await sleep(120);
  }
  console.log(`Klaar: ${kaarten} kaarten in ${sets.length - mislukt} sets bijgewerkt, ${mislukt} sets mislukt.`);

  // oordeel over de eigen exemplaren
  if (!ONLY_SET) {
    const uuids = new Map();
    for (let offset = 0; ; offset += 1000) {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/lorcana_set_kaarten?select=id,lorcast_id&order=id.asc&limit=1000&offset=${offset}`, { headers: SB });
      const b = await r.json(); b.forEach(x => uuids.set(x.id, x.lorcast_id));
      if (b.length < 1000) break;
    }
    const tel = { enkel: 0, twijfel: 0 }; let gepatcht = 0;
    for (const e of exemplaren) {
      const kaart = perLorcastId.get(uuids.get(e.parent_id));
      if (!kaart) continue;
      const o = beoordeel(kaart, e.versie, Number(e.waarde));
      tel[o.niveau]++;
      const patch = { prijs_betrouwbaarheid: o.niveau, prijs_toelichting: o.reden, prijs_bewijs: { bronnen: o.bewijs }, prijs_gecontroleerd_op: nu };
      if (o.waarde != null) patch.waarde = o.waarde;
      if (e.prijs_betrouwbaarheid === o.niveau && e.prijs_toelichting === o.reden && (o.waarde == null || Number(e.waarde) === o.waarde)) continue;
      if (DRY_RUN) { console.log(`${e.versie} ${kaart.name}: ${o.niveau} $${o.waarde} ${o.reden}`); continue; }
      const r = await fetch(`${SUPABASE_URL}/rest/v1/lorcana_exemplaren?id=eq.${e.id}`, { method: 'PATCH', headers: { ...SB, Prefer: 'return=minimal' }, body: JSON.stringify(patch) });
      if (r.ok) gepatcht++; else console.log(`  ! patch ${e.id}: ${r.status} ${(await r.text()).slice(0, 200)}`);
    }
    console.log(`Oordeel: ${tel.enkel} enkel, ${tel.twijfel} twijfel; ${gepatcht} exemplaren bijgewerkt.`);
  }
  if (mislukt === sets.length && sets.length > 0) process.exitCode = 1;
}

main().catch(e => { console.error(e); process.exit(1); });
