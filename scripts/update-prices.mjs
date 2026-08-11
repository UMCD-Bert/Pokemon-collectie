const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const TCGDEX_BASE = 'https://api.tcgdex.net/v2/en';
const REQUEST_DELAY_MS = 120;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('SUPABASE_URL en/of SUPABASE_KEY ontbreken.');
  process.exit(1);
}

function authHeaders(extra) {
  return Object.assign({ apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' }, extra || {});
}
function restUrl(table, path) { return `${SUPABASE_URL}/rest/v1/${table}${path || ''}`; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function firstPositive(...values) {
  for (const v of values) if (typeof v === 'number' && v > 0) return v;
  return null;
}
function pickTcgdexPrice(prices, versie) {
  if (!prices) return null;
  const v = (versie || '').toLowerCase().trim();
  if (v !== 'normaal' && v !== 'holo' && v !== 'reverse holo') return null;
  const holoPrice = firstPositive(prices['trend-holo'], prices['avg-holo']);
  const normalPrice = firstPositive(prices.trend, prices.avg);
  if (v.includes('holo')) return holoPrice != null ? holoPrice : normalPrice;
  return normalPrice != null ? normalPrice : holoPrice;
}
function normalizeKaartnummer(n) {
  return String(n || '').trim().replace(/^([A-Za-z]*)0+(?=\d)/, '$1');
}

async function fetchAllPages(table, query) {
  let all = [];
  let offset = 0;
  const pageSize = 1000;
  while (true) {
    const res = await fetch(restUrl(table, `?${query}&limit=${pageSize}&offset=${offset}`), { headers: authHeaders() });
    if (!res.ok) throw new Error(`${table} ophalen mislukt: status ${res.status} — ${await res.text()}`);
    const batch = await res.json();
    all = all.concat(batch);
    if (batch.length < pageSize) break;
    offset += pageSize;
  }
  return all;
}

async function main() {
  let setsVerwerkt = 0;
  let kaartenVerwerkt = 0;

  const setKaarten = await fetchAllPages(
    'tcg_set_kaarten',
    'select=id,set_id,set_naam,kaartnummer,heeft_normaal,heeft_holo,heeft_reverse&order=id.asc'
  );
  console.log(`${setKaarten.length} gecachte kaarten om te verversen.`);

  const pricingByKey = new Map();
  const setIdsSeen = new Set();

  for (const row of setKaarten) {
    if (!row.set_id || !row.kaartnummer) continue;
    setIdsSeen.add(row.set_id);
    try {
      const res = await fetch(`${TCGDEX_BASE}/sets/${encodeURIComponent(row.set_id)}/${encodeURIComponent(row.kaartnummer)}`);
      await sleep(REQUEST_DELAY_MS);
      if (!res.ok) continue;
      const card = await res.json();
      const cm = card.pricing ? card.pricing.cardmarket : null;
      if (!cm) continue;
      pricingByKey.set(`${row.set_id}|||${normalizeKaartnummer(row.kaartnummer)}`, cm);

      const nu = new Date().toISOString();
      const patch = { prijs_updated: nu };
      if (row.heeft_normaal) patch.prijs_normaal = pickTcgdexPrice(cm, 'Normaal');
      if (row.heeft_holo) patch.prijs_holo = pickTcgdexPrice(cm, 'Holo');
      if (row.heeft_reverse) patch.prijs_reverse = pickTcgdexPrice(cm, 'Reverse Holo');
      const patchRes = await fetch(restUrl('tcg_set_kaarten', `?id=eq.${row.id}`), {
        method: 'PATCH', headers: authHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify(patch)
      });
      if (patchRes.ok) kaartenVerwerkt++;
    } catch (err) {
      console.error(`Kaart ${row.set_naam} #${row.kaartnummer} mislukt:`, err.message);
    }
  }
  setsVerwerkt = setIdsSeen.size;

  const setNaamToId = new Map();
  setKaarten.forEach(row => {
    if (row.set_naam && row.set_id) setNaamToId.set(row.set_naam.trim().toLowerCase(), row.set_id);
  });

  const instances = await fetchAllPages(
    'kaart_exemplaren',
    'select=id,set_naam,kaartnummer,versie,prijs_handmatig_datum&prijs_handmatig_datum=is.null&set_naam=not.is.null&kaartnummer=not.is.null&order=id.asc'
  );
  console.log(`${instances.length} eigen exemplaren om te controleren.`);

  let exemplarenBijgewerkt = 0;
  for (const inst of instances) {
    const setId = setNaamToId.get((inst.set_naam || '').trim().toLowerCase());
    if (!setId) continue;
    const cm = pricingByKey.get(`${setId}|||${normalizeKaartnummer(inst.kaartnummer)}`);
    if (!cm) continue;
    const price = pickTcgdexPrice(cm, inst.versie);
    if (price == null) continue;
    try {
      const res = await fetch(restUrl('kaart_exemplaren', `?id=eq.${inst.id}`), {
        method: 'PATCH', headers: authHeaders({ Prefer: 'return=minimal' }),
        body: JSON.stringify({ waarde: price, prijs_bron_datum: cm.updated || null, prijs_handmatig_datum: null })
      });
      if (res.ok) exemplarenBijgewerkt++;
    } catch (err) {
      console.error(`Exemplaar ${inst.id} bijwerken mislukt:`, err.message);
    }
  }
  console.log(`${exemplarenBijgewerkt} eigen exemplaren bijgewerkt.`);

  await writeLog({ setsVerwerkt, kaartenVerwerkt, succes: true, foutmelding: null });
}

async function writeLog({ setsVerwerkt, kaartenVerwerkt, succes, foutmelding }) {
  try {
    await fetch(restUrl('prijs_update_log'), {
      method: 'POST', headers: authHeaders({ Prefer: 'return=minimal' }),
      body: JSON.stringify({
        run_at: new Date().toISOString(),
        sets_verwerkt: setsVerwerkt || 0,
        kaarten_verwerkt: kaartenVerwerkt || 0,
        succes,
        foutmelding
      })
    });
  } catch (err) {
    console.error('Kon logregel niet wegschrijven:', err.message);
  }
}

main().catch(async (err) => {
  console.error('Prijsupdate mislukt:', err);
  await writeLog({ setsVerwerkt: 0, kaartenVerwerkt: 0, succes: false, foutmelding: String(err.message || err).slice(0, 500) });
  process.exit(1);
});
