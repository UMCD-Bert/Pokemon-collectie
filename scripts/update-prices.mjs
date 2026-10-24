const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const TCGDEX_BASE = 'https://api.tcgdex.net/v2/en';
const REQUEST_DELAY_MS = 120;
const PHASES = new Set((process.env.JOB_PHASES || 'sets,tcgdex,photos,pwprices,instances,history').split(',').map(x => x.trim()));
const DRY_RUN = process.env.DRY_RUN === '1';
const POKEWALLET_KEY = process.env.POKEWALLET_KEY || '';
const PW_BASE = 'https://api.pokewallet.io';
const PW_MAX_CALLS = 85; // gratis plan: 100 verzoeken per uur, 1000 per dag
const PTCG_BASE = 'https://api.pokemontcg.io/v2';
const UA_HEADERS = { 'User-Agent': 'pokemon-collectie-job/1.0', Accept: 'application/json' };

// Droogloop: alleen lezen, schrijfacties worden niet uitgevoerd.
if (DRY_RUN) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => (opts && opts.method && opts.method !== 'GET')
    ? Promise.resolve(new Response('[]', { status: 200 }))
    : realFetch(url, opts);
}

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
function normalizeSetName(name) {
  return (name || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
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

// Data-driven alternatief voor het hardcoderen van een nog niet door TCGdex
// gepubliceerde nieuwe set: rijen in aangekondigde_sets worden hier elke
// dag gecheckt, en zodra TCGdex de set (met kaarten) kent, automatisch
// opgehaald en naar tcg_set_kaarten weggeschreven — precies zoals de
// "Deze set ophalen"-knop in index.html dat handmatig doet.
async function checkAangekondigdeSets() {
  let setsGeimporteerd = 0;
  let rows;
  try {
    const res = await fetch(restUrl('aangekondigde_sets', '?select=id,serie,set_naam,tcgdex_naam&opgehaald=eq.false'), { headers: authHeaders() });
    if (!res.ok) return 0;
    rows = await res.json();
  } catch (err) {
    console.error('Kon aangekondigde sets niet ophalen:', err.message);
    return 0;
  }
  if (rows.length === 0) return 0;

  let tcgdexSets;
  try {
    const res = await fetch(`${TCGDEX_BASE}/sets`);
    if (!res.ok) return 0;
    tcgdexSets = await res.json();
  } catch (err) {
    console.error('Kon TCGdex-setlijst niet ophalen:', err.message);
    return 0;
  }

  for (const row of rows) {
    const norm = normalizeSetName(row.tcgdex_naam || row.set_naam);
    const match = tcgdexSets.find(s => s && s.name && normalizeSetName(s.name) === norm);
    if (!match) continue; // TCGdex kent de set nog niet

    try {
      const setRes = await fetch(`${TCGDEX_BASE}/sets/${encodeURIComponent(match.id)}`);
      if (!setRes.ok) continue;
      const setData = await setRes.json();
      const briefCards = setData.cards || [];
      if (briefCards.length === 0) continue; // metadata bestaat al, kaarten nog niet

      const newRows = [];
      for (const brief of briefCards) {
        try {
          const cardRes = await fetch(`${TCGDEX_BASE}/sets/${encodeURIComponent(match.id)}/${encodeURIComponent(brief.localId)}`);
          await sleep(REQUEST_DELAY_MS);
          if (!cardRes.ok) continue;
          const card = await cardRes.json();
          let categorie = 'pokemon';
          if (card.category === 'Trainer') categorie = (card.trainerType || 'item').toLowerCase();
          else if (card.category === 'Energy') categorie = 'energy';
          const cmPricing = card.pricing && card.pricing.cardmarket;
          const priceSuggestsHolo = !!(cmPricing && (cmPricing['trend-holo'] != null || cmPricing['avg-holo'] != null));
          newRows.push({
            set_id: match.id,
            serie: row.serie || null,
            set_naam: row.set_naam,
            kaartnummer: card.localId,
            naam: card.name,
            afbeelding: card.image || null,
            categorie,
            dexid: (card.dexId && card.dexId[0]) || null,
            heeft_normaal: !!(card.variants && (card.variants.normal || card.variants.firstEdition || card.variants.wPromo)),
            heeft_holo: !!(card.variants && card.variants.holo) || priceSuggestsHolo,
            heeft_reverse: !!(card.variants && card.variants.reverse),
            release_datum: setData.releaseDate || null
          });
        } catch (err) {
          console.error(`Kon kaart ${brief.localId} van ${row.set_naam} niet ophalen:`, err.message);
        }
      }
      if (newRows.length === 0) continue;

      // Eerst leegmaken (zoals de "Deze set ophalen"-knop): twee elkaar
      // overlappende runs hadden anders dubbele kaarten opgeleverd.
      const delRes = await fetch(restUrl('tcg_set_kaarten', `?set_naam=eq.${encodeURIComponent(row.set_naam)}`), { method: 'DELETE', headers: authHeaders() });
      if (!delRes.ok) { console.error(`Leegmaken van ${row.set_naam} mislukt:`, await delRes.text()); continue; }
      const insRes = await fetch(restUrl('tcg_set_kaarten'), {
        method: 'POST', headers: authHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify(newRows)
      });
      if (!insRes.ok) { console.error(`Opslaan van ${row.set_naam} mislukt:`, await insRes.text()); continue; }

      await fetch(restUrl('aangekondigde_sets', `?id=eq.${row.id}`), {
        method: 'PATCH', headers: authHeaders({ Prefer: 'return=minimal' }),
        body: JSON.stringify({ opgehaald: true, opgehaald_op: new Date().toISOString() })
      });
      console.log(`Nieuwe set automatisch geïmporteerd: ${row.set_naam} (${newRows.length} kaarten).`);
      setsGeimporteerd++;
    } catch (err) {
      console.error(`Automatisch importeren van ${row.set_naam} mislukt:`, err.message);
    }
  }
  return setsGeimporteerd;
}


// pokemontcg.io geeft regelmatig tijdelijk 500/502: ruim opnieuw proberen.
async function getJson(url, options, tries = 6) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { ...options, signal: AbortSignal.timeout(60000) });
      if (res.status === 429) return { status: 429, json: null };
      if (!res.ok) throw new Error('status ' + res.status);
      return { status: res.status, json: await res.json(), headers: res.headers };
    } catch (err) {
      if (i === tries - 1) throw err;
      await sleep(Math.min(2000 * 2 ** i, 30000));
    }
  }
}
function normNum(n) { return normalizeKaartnummer(String(n || '').replace(/\s+/g, '')).toUpperCase(); }

// ---------- Foto's aanvullen uit pokemontcg.io (alleen foto's — hun prijzen lopen achter) ----------
const PTCG_SET_OVERRIDES = {
  'scarlet & violet promos': 'Scarlet & Violet Black Star Promos',
  '25th anniversary celebrations: classic collection': 'Celebrations: Classic Collection'
};

async function fillMissingPhotos() {
  const rows = await fetchAllPages('tcg_set_kaarten', 'select=id,set_naam,kaartnummer,naam&or=(afbeelding.is.null,afbeelding.eq.)&order=id.asc');
  if (rows.length === 0) return 0;
  const bySet = new Map();
  rows.forEach(r => { if (!bySet.has(r.set_naam)) bySet.set(r.set_naam, []); bySet.get(r.set_naam).push(r); });
  const setsRes = await getJson(`${PTCG_BASE}/sets?select=id,name&pageSize=250`, { headers: UA_HEADERS });
  const idByName = new Map(setsRes.json.data.map(x => [normalizeSetName(x.name), x.id]));
  let filled = 0;
  for (const [setNaam, list] of bySet) {
    const override = PTCG_SET_OVERRIDES[setNaam.trim().toLowerCase()];
    const ptcgId = idByName.get(normalizeSetName(override || setNaam));
    if (!ptcgId) { console.log(`Foto's: geen pokemontcg.io-set voor "${setNaam}" (${list.length} kaarten).`); continue; }
    const images = new Map();
    const byName = new Map(); // genormaliseerde kaartnaam -> url (alleen als de naam in de set uniek is)
    try {
      for (let page = 1; page <= 5; page++) {
        const r = await getJson(`${PTCG_BASE}/cards?q=set.id:${ptcgId}&page=${page}&pageSize=250&select=number,name,images`, { headers: UA_HEADERS });
        const data = (r.json && r.json.data) || [];
        data.forEach(c => {
          if (!(c.images && c.images.small)) return;
          images.set(normNum(c.number), c.images.small);
          const nk = normalizeSetName(c.name);
          byName.set(nk, byName.has(nk) ? null : c.images.small);
        });
        if (data.length < 250) break;
      }
    } catch (err) {
      console.log(`Foto's: "${setNaam}" overgeslagen (pokemontcg.io: ${err.message}), volgende run opnieuw.`);
      continue;
    }
    let n = 0;
    for (const row of list) {
      // Eerst op kaartnummer; lukt dat niet (bijv. Classic Collection heeft andere nummering), dan op unieke kaartnaam.
      const url = images.get(normNum(row.kaartnummer)) || byName.get(normalizeSetName(row.naam)) || null;
      if (!url) continue;
      const res = await fetch(restUrl('tcg_set_kaarten', `?id=eq.${row.id}`), {
        method: 'PATCH', headers: authHeaders({ Prefer: 'return=minimal' }),
        body: JSON.stringify({ afbeelding: url, afbeelding_bron: 'pokemontcg.io' })
      });
      if (res.ok) n++;
    }
    filled += n;
    console.log(`Foto's: ${setNaam}: ${n} van ${list.length} aangevuld.`);
  }
  return filled;
}

// ---------- Prijzen aanvullen uit PokéWallet (Cardmarket-EUR) voor kaarten waar TCGdex niets heeft ----------
const PW_SET_OVERRIDES = { '30th classic collection': '30th Celebration - Classic Collection' };
let pwCalls = 0;
let pwStop = false;
const pwPriceByKey = new Map(); // `${set_naam lower}|||${genormaliseerd nummer}` -> { normal, holo, updated }

async function pwGet(path) {
  if (pwStop || pwCalls >= PW_MAX_CALLS) { pwStop = true; return null; }
  pwCalls++;
  const res = await fetch(PW_BASE + path, { headers: { ...UA_HEADERS, 'X-API-Key': POKEWALLET_KEY } });
  if (res.status === 429) { pwStop = true; console.log('PokéWallet: limiet bereikt, de rest volgt een volgende run.'); return null; }
  if (!res.ok) throw new Error('PokéWallet status ' + res.status);
  await sleep(300);
  return await res.json();
}
function pwNumKey(cardNumber) { return normNum(String(cardNumber || '').split('/')[0]); }
function pwPrices(entry) {
  const prices = (entry.cardmarket && entry.cardmarket.prices) || [];
  const pick = t => { const x = prices.find(y => y.variant_type === t); return x ? firstPositive(x.trend, x.avg) : null; };
  return { normal: pick('normal'), holo: pick('holo'), updated: (prices.find(y => y.updated_at) || {}).updated_at || null };
}
function pwPickPrice(p, versie) {
  const v = (versie || '').toLowerCase().trim();
  if (v !== 'normaal' && v !== 'holo' && v !== 'reverse holo') return null;
  if (v.includes('holo')) return p.holo != null ? p.holo : p.normal;
  return p.normal != null ? p.normal : p.holo;
}
function pwIso(updated) {
  if (!updated) return new Date().toISOString();
  return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(updated) ? updated : updated + 'Z').toISOString();
}

async function fillPricesFromPokewallet() {
  if (!POKEWALLET_KEY) { console.log('PokéWallet: geen key, overgeslagen.'); return 0; }
  const cutoff = Date.now() - 14 * 86400000;
  const rows = (await fetchAllPages('tcg_set_kaarten',
    'select=id,set_naam,kaartnummer,naam,heeft_normaal,heeft_holo,heeft_reverse,prijs_bron,prijs_updated,prijs_normaal,prijs_holo,prijs_reverse' +
    '&or=(and(prijs_normaal.is.null,prijs_holo.is.null,prijs_reverse.is.null),prijs_bron.eq.pokewallet,prijs_bron.eq.pw-geen)&order=id.asc'))
    .filter(r => !(r.prijs_bron === 'pw-geen' && r.prijs_normaal == null && r.prijs_holo == null && r.prijs_reverse == null && Date.parse(r.prijs_updated) > cutoff));
  if (rows.length === 0) return 0;
  const groups = new Map();
  rows.forEach(r => { if (!groups.has(r.set_naam)) groups.set(r.set_naam, []); groups.get(r.set_naam).push(r); });
  const ordered = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);

  const setsData = await pwGet('/sets');
  if (!setsData) return 0;
  const pwSetByName = new Map((setsData.data || []).filter(x => x.language === 'eng').map(x => [normalizeSetName(x.name), x]));

  let updated = 0;
  for (const [setNaam, list] of ordered) {
    if (pwStop) break;
    const pwName = PW_SET_OVERRIDES[setNaam.trim().toLowerCase()] || setNaam;
    const pwSet = pwSetByName.get(normalizeSetName(pwName));
    if (!pwSet) continue;
    const wantedSet = normalizeSetName(pwSet.name);
    const entries = new Map();
    const collect = results => (results || []).forEach(r => {
      if (normalizeSetName(r.card_info && r.card_info.set_name) === wantedSet) entries.set(pwNumKey(r.card_info.card_number), pwPrices(r));
    });
    const searched = new Set();
    if (list.length >= 15) {
      for (let page = 1; page <= 5; page++) {
        const d = await pwGet(`/search?q=${encodeURIComponent(pwSet.name)}&limit=100&page=${page}`);
        if (!d) break;
        collect(d.results);
        if (page >= ((d.pagination && d.pagination.total_pages) || 1)) { list.forEach(r => searched.add(r.id)); break; }
      }
    } else {
      for (const row of list) {
        const d = await pwGet(`/search?q=${encodeURIComponent(row.naam + ' ' + pwSet.name)}&limit=20`);
        if (!d) break;
        collect(d.results);
        searched.add(row.id);
      }
    }
    let n = 0;
    for (const row of list) {
      const e = entries.get(normNum(row.kaartnummer));
      const patch = {};
      if (e) {
        if (row.heeft_normaal) patch.prijs_normaal = pwPickPrice(e, 'Normaal');
        if (row.heeft_holo) patch.prijs_holo = pwPickPrice(e, 'Holo');
        if (row.heeft_reverse) patch.prijs_reverse = pwPickPrice(e, 'Reverse Holo');
      }
      const any = ['prijs_normaal', 'prijs_holo', 'prijs_reverse'].some(f => patch[f] != null);
      if (any) {
        Object.keys(patch).forEach(f => { if (patch[f] == null) delete patch[f]; });
        patch.prijs_bron = 'pokewallet';
        patch.prijs_updated = pwIso(e.updated);
        pwPriceByKey.set(`${setNaam.trim().toLowerCase()}|||${normalizeKaartnummer(row.kaartnummer)}`, e);
      } else if (searched.has(row.id) && row.prijs_normaal == null && row.prijs_holo == null && row.prijs_reverse == null) {
        patch.prijs_bron = 'pw-geen';
        patch.prijs_updated = new Date().toISOString();
      } else continue;
      const res = await fetch(restUrl('tcg_set_kaarten', `?id=eq.${row.id}`), {
        method: 'PATCH', headers: authHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify(patch)
      });
      if (res.ok && any) { n++; updated++; }
    }
    console.log(`PokéWallet: ${setNaam}: ${n} van ${list.length} kaarten van een prijs voorzien.`);
  }
  console.log(`PokéWallet: ${pwCalls} verzoeken gebruikt, ${updated} kaarten bijgewerkt.`);
  return updated;
}

// ---------- Prijsverloop: alleen voor drukken die je bezit; hooguit wekelijks per druk (gratis opslag),
// of eerder bij een flinke sprong (>= 25% en >= € 0,10) ----------
async function recordPriceHistory() {
  const inst = await fetchAllPages('kaart_exemplaren',
    'select=set_naam,kaartnummer,versie,waarde,prijs_handmatig_datum,prijs_vast&set_naam=not.is.null&kaartnummer=not.is.null&versie=not.is.null&waarde=not.is.null&order=id.asc');
  const since = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
  const hist = await fetchAllPages('prijs_historie', `select=set_naam,kaartnummer,versie,prijs,gemeten_op&gemeten_op=gte.${since}&order=gemeten_op.desc,id.desc`);
  const last = new Map();
  hist.forEach(h => { const k = `${h.set_naam}|||${h.kaartnummer}|||${h.versie}`; if (!last.has(k)) last.set(k, { prijs: parseFloat(h.prijs), datum: h.gemeten_op }); });
  const seen = new Set();
  const rows = [];
  for (const i of inst) {
    const num = normalizeKaartnummer(i.kaartnummer);
    const k = `${i.set_naam}|||${num}|||${i.versie}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const w = parseFloat(i.waarde);
    if (!(w > 0)) continue;
    const prev = last.get(k);
    if (prev) {
      const delta = Math.abs(prev.prijs - w);
      const dagen = (Date.now() - Date.parse(prev.datum)) / 86400000;
      const sprong = delta >= 0.10 && delta / prev.prijs >= 0.25;
      if (delta < 0.005 || (dagen < 7 && !sprong)) continue;
    }
    rows.push({ set_naam: i.set_naam, kaartnummer: num, versie: i.versie, prijs: w, bron: (i.prijs_handmatig_datum || i.prijs_vast) ? 'handmatig' : 'cardmarket' });
  }
  for (let i = 0; i < rows.length; i += 500) {
    const res = await fetch(restUrl('prijs_historie'), {
      method: 'POST', headers: authHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify(rows.slice(i, i + 500))
    });
    if (!res.ok) throw new Error('prijsverloop opslaan mislukt: ' + await res.text());
  }
  console.log(`Prijsverloop: ${rows.length} wijzigingen vastgelegd (van ${seen.size} drukken in bezit).`);
  return rows.length;
}

async function runPhase(naam, fn) {
  if (!PHASES.has(naam)) return null;
  try { return await fn(); } catch (err) { console.error(`Fase "${naam}" mislukt:`, err.message); return null; }
}

async function main() {
  let setsVerwerkt = 0;
  let kaartenVerwerkt = 0;

  const nieuweSetsGeimporteerd = (await runPhase('sets', checkAangekondigdeSets)) || 0;

  const setKaarten = await fetchAllPages(
    'tcg_set_kaarten',
    'select=id,set_id,set_naam,kaartnummer,heeft_normaal,heeft_holo,heeft_reverse,prijs_bron&order=id.asc'
  );
  console.log(`${setKaarten.length} gecachte kaarten om te verversen.`);

  const pricingByKey = new Map();
  const setIdsSeen = new Set();

  if (PHASES.has('tcgdex')) {
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
        const fields = ['prijs_normaal', 'prijs_holo', 'prijs_reverse'];
        const any = fields.some(f => patch[f] != null);
        // Een door PokéWallet aangevulde prijs niet wissen met een lege TCGdex-uitkomst.
        if (row.prijs_bron === 'pokewallet') {
          fields.forEach(f => { if (f in patch && patch[f] == null) delete patch[f]; });
          if (!any) continue;
        }
        if (any) patch.prijs_bron = 'tcgdex';
        const patchRes = await fetch(restUrl('tcg_set_kaarten', `?id=eq.${row.id}`), {
          method: 'PATCH', headers: authHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify(patch)
        });
        if (patchRes.ok) kaartenVerwerkt++;
      } catch (err) {
        console.error(`Kaart ${row.set_naam} #${row.kaartnummer} mislukt:`, err.message);
      }
    }
    setsVerwerkt = setIdsSeen.size;
  }

  await runPhase('photos', fillMissingPhotos);
  await runPhase('pwprices', fillPricesFromPokewallet);

  if (PHASES.has('instances')) {
    const setNaamToId = new Map();
    setKaarten.forEach(row => {
      if (row.set_naam && row.set_id) setNaamToId.set(row.set_naam.trim().toLowerCase(), row.set_id);
    });

    const instances = await fetchAllPages(
      'kaart_exemplaren',
      'select=id,set_naam,kaartnummer,versie,prijs_handmatig_datum&prijs_handmatig_datum=is.null&prijs_vast=eq.false&set_naam=not.is.null&kaartnummer=not.is.null' +
      // prijzen die scripts/prijs-controle.mjs net heeft beoordeeld (solide/twijfel) laat deze fase met rust, tot de controle 10 dagen oud is
      `&or=(prijs_betrouwbaarheid.is.null,prijs_betrouwbaarheid.eq.enkel,prijs_gecontroleerd_op.lt.${new Date(Date.now() - 10 * 86400000).toISOString()})&order=id.asc`
    );
    console.log(`${instances.length} eigen exemplaren om te controleren.`);

    let exemplarenBijgewerkt = 0;
    for (const inst of instances) {
      const setKey = (inst.set_naam || '').trim().toLowerCase();
      const num = normalizeKaartnummer(inst.kaartnummer);
      const setId = setNaamToId.get(setKey);
      let price = null, datum = null;
      const cm = setId ? pricingByKey.get(`${setId}|||${num}`) : null;
      if (cm) { price = pickTcgdexPrice(cm, inst.versie); datum = cm.updated || null; }
      if (price == null) {
        const pw = pwPriceByKey.get(`${setKey}|||${num}`);
        if (pw) { price = pwPickPrice(pw, inst.versie); datum = pw.updated ? pwIso(pw.updated).slice(0, 10) : null; }
      }
      if (price == null) continue;
      try {
        const res = await fetch(restUrl('kaart_exemplaren', `?id=eq.${inst.id}`), {
          method: 'PATCH', headers: authHeaders({ Prefer: 'return=minimal' }),
          body: JSON.stringify({ waarde: price, prijs_bron_datum: datum, prijs_handmatig_datum: null })
        });
        if (res.ok) exemplarenBijgewerkt++;
      } catch (err) {
        console.error(`Exemplaar ${inst.id} bijwerken mislukt:`, err.message);
      }
    }
    console.log(`${exemplarenBijgewerkt} eigen exemplaren bijgewerkt.`);
  }

  await runPhase('history', recordPriceHistory);

  // Alleen een volledige run (met de TCGdex-fase) komt in het logboek; een deelrun zou "0 sets" tonen.
  if (PHASES.has('tcgdex')) await writeLog({ setsVerwerkt, kaartenVerwerkt, nieuweSetsGeimporteerd, succes: true, foutmelding: null });
}

async function writeLog({ setsVerwerkt, kaartenVerwerkt, nieuweSetsGeimporteerd, succes, foutmelding }) {
  try {
    await fetch(restUrl('prijs_update_log'), {
      method: 'POST', headers: authHeaders({ Prefer: 'return=minimal' }),
      body: JSON.stringify({
        run_at: new Date().toISOString(),
        sets_verwerkt: setsVerwerkt || 0,
        kaarten_verwerkt: kaartenVerwerkt || 0,
        nieuwe_sets_geimporteerd: nieuweSetsGeimporteerd || 0,
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
  await writeLog({ setsVerwerkt: 0, kaartenVerwerkt: 0, nieuweSetsGeimporteerd: 0, succes: false, foutmelding: String(err.message || err).slice(0, 500) });
  process.exit(1);
});
