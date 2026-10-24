// Ververst de Cardmarket-prijzen (EUR, via Scryfall) van de Magic-kaarten die je bezit: magic_exemplaren -> magic_kaarten.
// Alleen eigen kaarten; sets die je alleen hebt bekeken krijgen verse prijzen zodra je ze in de app ververst.
// Scryfall: User-Agent en Accept verplicht, minstens 50-100 ms tussen verzoeken, max 75 kaarten per /cards/collection.
//
// Gebruik: SUPABASE_URL=… SUPABASE_KEY=… node scripts/update-magic.mjs     (DRY_RUN=1: alleen ophalen en tellen)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const DRY_RUN = process.env.DRY_RUN === '1';
if (!SUPABASE_URL || !SUPABASE_KEY) { console.error('SUPABASE_URL en/of SUPABASE_KEY ontbreken.'); process.exit(1); }

import { oordeel } from './lib/prijsoordeel.mjs';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const SB = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' };

async function withRetry(fn, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) { last = e; await sleep(800 * (i + 1)); }
  }
  throw last;
}

async function eigenExemplaren() {
  let alles = [];
  for (let offset = 0; ; offset += 1000) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/magic_exemplaren?select=id,kaart_id,versie,waarde,prijs_betrouwbaarheid,prijs_toelichting&order=id.asc&limit=1000&offset=${offset}`, { headers: SB, cache: 'no-store' });
    if (!r.ok) throw new Error(`magic_exemplaren: status ${r.status}`);
    const batch = await r.json();
    alles = alles.concat(batch);
    if (batch.length < 1000) break;
  }
  return alles;
}

async function wisselkoers() {
  for (const url of ['https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR', 'https://api.frankfurter.app/latest?from=USD&to=EUR']) {
    try { const j = await (await fetch(url)).json(); if (j.rates && j.rates.EUR) return j.rates.EUR; } catch { /* volgende */ }
  }
  return 0.9;
}

/** Cardmarket-euro's en TCGplayer-dollars (omgerekend) van Scryfall zijn twee onafhankelijke bronnen. */
function beoordeel(kaart, versie, koers) {
  const p = kaart.prices || {};
  const [e, u] = versie === 'Foil' ? [p.eur_foil, p.usd_foil] : versie === 'Etched' ? [p.eur_etched, p.usd_etched] : [p.eur, p.usd];
  const bronnen = [];
  if (parseFloat(e) > 0) bronnen.push({ id: 'cardmarket', label: 'Cardmarket', eur: parseFloat(e), datum: new Date().toISOString().slice(0, 10) });
  if (parseFloat(u) > 0) bronnen.push({ id: 'tcgplayer', label: 'TCGplayer', eur: Math.round(parseFloat(u) * koers * 100) / 100, datum: new Date().toISOString().slice(0, 10) });
  return oordeel(bronnen);
}

const tekst = (s) => (s === undefined || s === null || s === '' ? null : s);
const getal = (s) => { const n = parseFloat(s); return Number.isFinite(n) ? n : null; };

function dbRij(k, nu) {
  const f = k.card_faces?.[0];
  return {
    id: k.id, oracle_id: tekst(k.oracle_id), set_code: k.set, set_naam: k.set_name, kaartnummer: k.collector_number,
    naam: k.name, taal: k.lang || 'en', rarity: tekst(k.rarity), mana_kosten: tekst(k.mana_cost ?? f?.mana_cost),
    type_regel: tekst(k.type_line),
    oracle_tekst: tekst(k.oracle_text ?? (k.card_faces ? k.card_faces.map(x => x.oracle_text).filter(Boolean).join('\n//\n') : null)),
    kleuren: tekst((k.colors ?? f?.colors ?? []).join(',')),
    afbeelding: tekst(k.image_uris?.normal ?? f?.image_uris?.normal), finishes: tekst((k.finishes || []).join(',')),
    prijs_normaal: getal(k.prices?.eur), prijs_foil: getal(k.prices?.eur_foil), prijs_etched: getal(k.prices?.eur_etched),
    prijs_updated: nu, released_at: tekst(k.released_at),
  };
}

async function scryfallCollectie(ids) {
  return withRetry(async () => {
    const r = await fetch('https://api.scryfall.com/cards/collection', {
      method: 'POST',
      headers: { 'User-Agent': 'pokemon-collectie-job/1.0', Accept: 'application/json;q=0.9,*/*;q=0.8', 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifiers: ids.map(id => ({ id })) }),
    });
    if (!r.ok) throw new Error(`Scryfall status ${r.status}`);
    return (await r.json()).data || [];
  });
}

async function upsert(rijen) {
  await withRetry(async () => {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/magic_kaarten?on_conflict=id`, {
      method: 'POST',
      headers: { ...SB, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(rijen),
    });
    if (!r.ok) throw new Error(`upsert status ${r.status}: ${await r.text()}`);
  });
}

async function main() {
  const exemplaren = await eigenExemplaren();
  const ids = [...new Set(exemplaren.map(e => e.kaart_id))];
  console.log(`${ids.length} verschillende Magic-kaarten in bezit.`);
  const koers = await wisselkoers();
  const nu = new Date().toISOString();
  let bijgewerkt = 0, mislukt = 0, gepatcht = 0;
  const tel = { solide: 0, enkel: 0, twijfel: 0 };
  for (let i = 0; i < ids.length; i += 75) {
    try {
      const kaarten = await scryfallCollectie(ids.slice(i, i + 75));
      if (!DRY_RUN && kaarten.length) await upsert(kaarten.map(k => dbRij(k, nu)));
      bijgewerkt += kaarten.length;
      const perId = new Map(kaarten.map(k => [k.id, k]));
      for (const e of exemplaren.filter(x => perId.has(x.kaart_id) && ids.slice(i, i + 75).includes(x.kaart_id))) {
        const o = beoordeel(perId.get(e.kaart_id), e.versie, koers);
        tel[o.niveau]++;
        const patch = { prijs_betrouwbaarheid: o.niveau, prijs_toelichting: o.reden, prijs_bewijs: { bronnen: o.bewijs, koers }, prijs_gecontroleerd_op: nu };
        if (o.waarde != null) patch.waarde = o.waarde;
        if (e.prijs_betrouwbaarheid === o.niveau && e.prijs_toelichting === o.reden && (o.waarde == null || Number(e.waarde) === o.waarde)) continue;
        if (DRY_RUN) { console.log(`${e.versie} ${perId.get(e.kaart_id).name}: ${o.niveau} ${o.waarde} ${o.reden}`); continue; }
        const r = await fetch(`${SUPABASE_URL}/rest/v1/magic_exemplaren?id=eq.${e.id}`, { method: 'PATCH', headers: { ...SB, Prefer: 'return=minimal' }, body: JSON.stringify(patch) });
        if (r.ok) gepatcht++; else console.log(`  ! patch ${e.id}: ${r.status} ${(await r.text()).slice(0, 200)}`);
      }
    } catch (e) {
      mislukt++;
      console.log(`✗ blok ${i / 75 + 1}: ${e.message}`);
    }
    await sleep(120);
  }
  console.log(`Klaar: ${bijgewerkt} kaarten bijgewerkt, ${mislukt} blokken mislukt. Oordeel: ${tel.solide} solide, ${tel.enkel} enkel, ${tel.twijfel} twijfel; ${gepatcht} exemplaren bijgewerkt.`);
  if (mislukt > 0 && bijgewerkt === 0) process.exitCode = 1;
}

main().catch(e => { console.error(e); process.exit(1); });
