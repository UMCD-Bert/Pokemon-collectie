// Spiegelt de kaartfoto's van je eigen exemplaren naar de eigen Supabase-opslag (bucket "afbeeldingen",
// map "spiegel/"), zodat ze blijven werken als TCGdex (assets.tcgdex.net) een storing heeft.
//
// Per eigen exemplaar met een TCGdex-foto: haal <basis>/high.jpg (~90 KB) op, bewaar die als
// spiegel/<sleutel>.jpg, en zet daarna de foto van het exemplaar én van de bijbehorende setcache-rijen
// (tcg_set_kaarten) op de eigen URL. Idempotent: bestaande spiegels worden niet opnieuw opgehaald, mislukte
// downloads komen de volgende keer opnieuw aan de beurt. Draait na de prijsupdate in de dagelijkse job.
//
// Gebruik: SUPABASE_URL=… SUPABASE_KEY=… node scripts/mirror-photos.mjs
//   MIRROR_LIMIT=5  alleen de eerste 5 verwerken (test);  DRY_RUN=1  alleen lezen.
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const DRY_RUN = process.env.DRY_RUN === '1';
const LIMIT = parseInt(process.env.MIRROR_LIMIT || '0', 10) || Infinity;
const BUCKET = 'afbeeldingen';
const PARALLEL = 6;

if (!SUPABASE_URL || !SUPABASE_KEY) { console.error('SUPABASE_URL en/of SUPABASE_KEY ontbreken.'); process.exit(1); }

const authHeaders = (extra) => Object.assign({ apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }, extra || {});
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const TCGDEX_ASSETS = 'https://assets.tcgdex.net/';

async function fetchAllPages(table, query) {
  let all = [], offset = 0;
  while (true) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}&limit=1000&offset=${offset}`, { headers: authHeaders(), cache: 'no-store' });
    if (!res.ok) throw new Error(`${table}: status ${res.status}`);
    const batch = await res.json();
    all = all.concat(batch);
    if (batch.length < 1000) break;
    offset += 1000;
  }
  return all;
}

async function withRetry(fn, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) { last = e; await sleep(500 * (i + 1)); }
  }
  throw last;
}

/** https://assets.tcgdex.net/en/base/base1/44[/high.png] -> { base, key } of null als het geen TCGdex-foto is. */
function tcgdexBron(url) {
  if (!url || !url.startsWith(TCGDEX_ASSETS)) return null;
  const base = url.replace(/\/(high|low)\.(png|jpg|webp)$/, '');
  const key = base.slice(TCGDEX_ASSETS.length).replace(/[^A-Za-z0-9_-]/g, '_');
  return { base, key };
}

const publiekeUrl = (key) => `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/spiegel/${key}.jpg`;

async function bestaat(key) {
  const res = await fetch(publiekeUrl(key), { method: 'HEAD' });
  return res.status === 200;
}

async function spiegel(bron) {
  if (await bestaat(bron.key)) return 'bestond';
  const res = await withRetry(async () => {
    const r = await fetch(`${bron.base}/high.jpg`, { headers: { 'User-Agent': 'pokemon-collectie-job/1.0' } });
    if (!r.ok) throw new Error(`TCGdex status ${r.status}`);
    return r;
  });
  const data = Buffer.from(await res.arrayBuffer());
  if (data.length < 2000) throw new Error('te klein bestand');
  if (DRY_RUN) return 'droogloop';
  const up = await withRetry(async () => {
    const r = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/spiegel/${bron.key}.jpg`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'image/jpeg', 'x-upsert': 'true', 'cache-control': 'max-age=31536000' }),
      body: data
    });
    if (!r.ok) throw new Error(`upload status ${r.status}: ${await r.text()}`);
    return r;
  });
  void up;
  return 'nieuw';
}

async function patch(table, filter, body) {
  if (DRY_RUN) return;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, {
    method: 'PATCH',
    headers: authHeaders({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`${table} patch status ${res.status}: ${await res.text()}`);
}

async function main() {
  const rows = await fetchAllPages('kaart_exemplaren', 'select=afbeelding&afbeelding=like.' + encodeURIComponent(TCGDEX_ASSETS + '*') + '&order=id.asc');
  const uniek = [...new Set(rows.map(r => r.afbeelding))].slice(0, LIMIT);
  console.log(`${uniek.length} unieke TCGdex-foto's van eigen exemplaren om te spiegelen.`);
  let nieuw = 0, bestond = 0, mislukt = 0, gepatcht = 0, i = 0;
  const werk = async () => {
    while (i < uniek.length) {
      const url = uniek[i++];
      const bron = tcgdexBron(url);
      if (!bron) continue;
      try {
        const status = await spiegel(bron);
        if (status === 'nieuw') nieuw++; else bestond++;
        const eigen = publiekeUrl(bron.key);
        await patch('kaart_exemplaren', `afbeelding=eq.${encodeURIComponent(url)}`, { afbeelding: eigen });
        // setcache-rijen van deze kaart (basis-URL zonder suffix) wijzen ook naar de eigen kopie
        await patch('tcg_set_kaarten', `afbeelding=eq.${encodeURIComponent(bron.base)}`, { afbeelding: eigen, afbeelding_bron: 'spiegel' });
        gepatcht++;
      } catch (e) {
        mislukt++;
        console.log(`✗ ${url}: ${e.message}`);
      }
      if ((nieuw + bestond + mislukt) % 100 === 0) console.log(`… ${nieuw + bestond + mislukt}/${uniek.length}`);
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, werk));
  console.log(`Klaar: ${nieuw} nieuw gespiegeld, ${bestond} bestonden al, ${mislukt} mislukt, ${gepatcht} exemplaar-URL's omgezet.`);
  if (mislukt > 0) process.exitCode = 0; // een volgende run probeert de mislukte opnieuw
}

main().catch(e => { console.error(e); process.exit(1); });
