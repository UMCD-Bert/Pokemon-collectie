// Robuuste prijzen voor Pokémon: elke prijs van een eigen exemplaar wordt gecontroleerd tegen onafhankelijke bronnen en krijgt een
// betrouwbaarheid (solide / enkel / twijfel), een toelichting en het bewijs. Zie CLAUDE.md ("Robuuste prijzen").
//
// Bronnen (alles omgerekend naar euro):
//   tcgdex   Cardmarket via TCGdex (de setcache) - onbetrouwbaar als meerdere kaarten in de set exact dezelfde prijzen hebben
//   pw-cm    Cardmarket via PokéWallet, per kaart (gericht zoeken, 1 verzoek per kaart)
//   pw-tp    TCGplayer via PokéWallet (hele set in 1 verzoek), dollars x ECB-koers
//
// Gebruik: SUPABASE_URL=… SUPABASE_KEY=… POKEWALLET_KEY=… node scripts/prijs-controle.mjs
//   DRY_RUN=1 alleen rekenen en tonen · ONLY_SET="Neo Revelation" · MAX_DRUKKEN=30 · PW_MAX_CALLS=380 · PW_PACE_MS=38000 (100 per uur toegestaan)
import { oordeel, springerigheid, eur } from './lib/prijsoordeel.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL, SUPABASE_KEY = process.env.SUPABASE_KEY, PW_KEY = process.env.POKEWALLET_KEY || '';
const DRY_RUN = process.env.DRY_RUN === '1';
const PW_MAX_CALLS = parseInt(process.env.PW_MAX_CALLS || '380', 10);
const PW_PACE_MS = parseInt(process.env.PW_PACE_MS || '38000', 10);
const MAX_DRUKKEN = parseInt(process.env.MAX_DRUKKEN || '0', 10) || Infinity;
const ONLY_SET = (process.env.ONLY_SET || '').toLowerCase();
const VERS = 7 * 86400000;   // zo oud mag een eerder opgehaalde bronprijs zijn
if (!SUPABASE_URL || !SUPABASE_KEY) { console.error('SUPABASE_URL en/of SUPABASE_KEY ontbreken.'); process.exit(1); }

const SB = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const nr = (n) => String(n || '').trim().replace(/^([A-Za-z]*)0+(?=\d)/, '$1').toUpperCase();
// Sets waarin 1st Edition en Unlimited bestaan en het verschil de prijs bepaalt (Base Set ook Shadowless)
const EDITIE_SETS = new Set(['base set', 'jungle', 'fossil', 'team rocket', 'gym heroes', 'gym challenge', 'neo genesis', 'neo discovery', 'neo revelation', 'neo destiny']);
const PW_SET = { '30th classic collection': '30th Celebration - Classic Collection' };

async function sbAll(table, query) {
  let alles = [], offset = 0;
  for (;;) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}&limit=1000&offset=${offset}`, { headers: SB });
    if (!r.ok) throw new Error(`${table}: status ${r.status}`);
    const b = await r.json(); alles = alles.concat(b);
    if (b.length < 1000) return alles;
    offset += 1000;
  }
}
async function sbPatch(table, filter, body) {
  if (DRY_RUN) return true;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, { method: 'PATCH', headers: { ...SB, Prefer: 'return=minimal' }, body: JSON.stringify(body) });
  if (!r.ok) console.log(`  ! ${table} patch ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.ok;
}

// ---------- PokéWallet met budget en tempo ----------
let pwCalls = 0, pwStop = false, laatste = 0;
async function pw(path) {
  if (!PW_KEY || pwStop || pwCalls >= PW_MAX_CALLS) { pwStop = true; return null; }
  const wacht = laatste + PW_PACE_MS - Date.now();
  if (wacht > 0 && pwCalls >= 3) await sleep(wacht);   // de eerste paar verzoeken meteen, daarna 1 per PW_PACE_MS
  laatste = Date.now(); pwCalls++;
  const r = await fetch('https://api.pokewallet.io' + path, { headers: { 'X-API-Key': PW_KEY, 'User-Agent': 'pokemon-collectie-job/1.0', Accept: 'application/json' } });
  if (r.status === 429) { console.log('PokéWallet: limiet bereikt, rest volgende keer.'); pwStop = true; return null; }
  if (!r.ok) { console.log(`PokéWallet ${path} status ${r.status}`); return null; }
  return r.json();
}

/** PokéWallet-set bij onze setnaam: gelijk, zonder "EX ", of met een code ervoor ("SWSH04: Vivid Voltage"). */
let pwByName = new Map();
function pwSetVoor(setNaam) {
  const eigen = norm(PW_SET[norm(setNaam)] || setNaam);
  for (const kandidaat of [eigen, eigen.replace(/^ex /, '')]) {
    if (pwByName.has(kandidaat)) return pwByName.get(kandidaat);
    for (const [naam, set] of pwByName) {
      const m = naam.match(/^(\S+) (.+)$/);
      if (m && m[2] === kandidaat && /\d/.test(m[1])) return set;   // code-voorvoegsel zoals swsh04
    }
  }
  return null;
}

async function wisselkoers() {
  for (const url of ['https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR', 'https://api.frankfurter.app/latest?from=USD&to=EUR']) {
    try { const j = await (await fetch(url)).json(); if (j.rates && j.rates.EUR) return j.rates.EUR; } catch { /* volgende */ }
  }
  return 0.9;
}

// ---------- Bronnen per druk ----------
function tpSubtype(versie, editie, setNaam) {
  const v = (versie || '').toLowerCase();
  const holo = v === 'holo', reverse = v.includes('reverse');
  if (reverse) return 'Reverse Holofoil';
  if (EDITIE_SETS.has(norm(setNaam))) {
    if (editie === '1st Edition') return holo ? '1st Edition Holofoil' : '1st Edition';
    if (editie === 'Unlimited') return holo ? 'Unlimited Holofoil' : 'Unlimited';
    if (editie === 'Shadowless') return holo ? 'Holofoil' : 'Normal';
    return holo ? 'Unlimited Holofoil' : 'Unlimited';   // onbekend: voorzichtig, de goedkoopste
  }
  return holo ? 'Holofoil' : 'Normal';
}
function cmWaarde(cm, versie) {
  if (!cm) return null;
  const v = (versie || '').toLowerCase();
  const pak = (x) => x && (x.trend > 0 ? x.trend : x.avg > 0 ? x.avg : null);
  const normaal = pak(cm.normal), holo = pak(cm.holo);
  return v.includes('holo') ? (holo ?? normaal) : (normaal ?? holo);
}
function cmDetail(cm, versie) {
  const v = (versie || '').toLowerCase();
  return v.includes('holo') ? (cm.holo || cm.normal) : (cm.normal || cm.holo);
}

async function main() {
  const koers = await wisselkoers();
  console.log(`USD→EUR ${koers}`);
  const exemplaren = (await sbAll('kaart_exemplaren',
    'select=id,parent_type,set_naam,kaartnummer,versie,editie,waarde,aantal,prijs_vast,prijs_handmatig_datum,prijs_betrouwbaarheid,prijs_toelichting,prijs_bewijs,prijs_gecontroleerd_op&set_naam=not.is.null&kaartnummer=not.is.null&versie=not.is.null&order=id.asc'))
    .filter(e => !e.prijs_vast && !e.prijs_handmatig_datum && (!ONLY_SET || norm(e.set_naam) === norm(ONLY_SET)));
  const cache = await sbAll('tcg_set_kaarten', 'select=set_naam,kaartnummer,naam,prijs_normaal,prijs_holo,prijs_reverse,prijs_bron,prijs_updated');

  // setcache per set → kaart; gedeelde prijzen opsporen (zelfde prijsset bij ≥ 2 kaarten in één set, vanaf € 3)
  const perSet = new Map();
  for (const c of cache) { const k = norm(c.set_naam); if (!perSet.has(k)) perSet.set(k, new Map()); perSet.get(k).set(nr(c.kaartnummer), c); }
  const gedeeld = new Map();   // `${set}|${nr}` → ['#13']
  for (const [setK, kaarten] of perSet) {
    const groepen = new Map();
    for (const [n, c] of kaarten) {
      if (c.prijs_bron !== 'tcgdex' || !(c.prijs_normaal >= 3) || c.prijs_holo == null) continue;
      const sleutel = [c.prijs_normaal, c.prijs_holo, c.prijs_reverse].join('/');
      if (!groepen.has(sleutel)) groepen.set(sleutel, []);
      groepen.get(sleutel).push(n);
    }
    for (const lijst of groepen.values()) if (lijst.length > 1) for (const n of lijst) gedeeld.set(`${setK}|${n}`, lijst.filter(x => x !== n).slice(0, 4).map(x => '#' + x));
  }

  // drukken = unieke combinaties van set, nummer, versie, editie
  const drukken = new Map();
  for (const e of exemplaren) {
    const sleutel = [norm(e.set_naam), nr(e.kaartnummer), (e.versie || '').toLowerCase(), e.editie || ''].join('|');
    if (!drukken.has(sleutel)) drukken.set(sleutel, { sleutel, setNaam: e.set_naam, setK: norm(e.set_naam), nummer: nr(e.kaartnummer), versie: e.versie, editie: e.editie || null, exemplaren: [], waarde: 0 });
    const d = drukken.get(sleutel); d.exemplaren.push(e); d.waarde = Math.max(d.waarde, (e.waarde || 0));
    const ruw = e.prijs_bewijs && e.prijs_bewijs.ruw;
    if (ruw && Date.now() - Date.parse(ruw.datum) < VERS) d.ruw = ruw;   // eerder opgehaald en nog vers
  }
  let lijst = [...drukken.values()].sort((a, b) => b.waarde - a.waarde).slice(0, MAX_DRUKKEN);
  console.log(`${exemplaren.length} exemplaren in ${lijst.length} drukken om te controleren.`);

  // pass 1: TCGplayer per set (1 verzoek per set), duurste sets eerst
  const pwSets = PW_KEY ? await pw('/sets') : null;
  pwByName = new Map(((pwSets && pwSets.data) || []).filter(x => x.language === 'eng').map(x => [norm(x.name), x]));
  const setWaarde = new Map();
  lijst.forEach(d => setWaarde.set(d.setK, (setWaarde.get(d.setK) || 0) + d.waarde));
  const tpPerSet = new Map();
  for (const [setK] of [...setWaarde].sort((a, b) => b[1] - a[1])) {
    const heeftVers = lijst.filter(d => d.setK === setK).every(d => d.ruw && d.ruw.tp);
    if (heeftVers || pwStop) continue;
    const naam = lijst.find(d => d.setK === setK).setNaam;
    const set = pwSetVoor(naam);
    if (!set) { console.log(`PokéWallet kent de set niet: ${naam}`); continue; }
    const wensen = [set];
    if (setK === 'base set' && lijst.some(d => d.setK === setK && d.editie === 'Shadowless') && pwByName.get('base set shadowless')) wensen.push(pwByName.get('base set shadowless'));
    const kaartenPerPwSet = new Map();
    for (const w of wensen) {
      const kaarten = new Map();
      for (let p = 1; p <= 5; p++) {
        const d = await pw(`/search?q=${encodeURIComponent(w.name)}&limit=100&page=${p}`);
        if (!d) break;
        (d.results || []).filter(r => norm(r.card_info.set_name) === norm(w.name)).forEach(r => kaarten.set(nr(String(r.card_info.card_number).split('/')[0]), r));
        if (p >= ((d.pagination && d.pagination.total_pages) || 1)) break;
      }
      kaartenPerPwSet.set(norm(w.name), kaarten);
    }
    tpPerSet.set(setK, { kaarten: kaartenPerPwSet.get(norm(set.name)), schaduwKaarten: kaartenPerPwSet.get('base set shadowless') || new Map() });
    console.log(`TCGplayer: ${naam}: ${tpPerSet.get(setK).kaarten.size} kaarten (verzoeken tot nu: ${pwCalls}).`);
  }
  const tpPrijzen = (c) => Object.fromEntries(((c && c.tcgplayer && c.tcgplayer.prices) || []).filter(p => p.market_price > 0 || p.mid_price > 0).map(p => [p.sub_type_name, p.market_price > 0 ? p.market_price : p.mid_price]));
  for (const d of lijst) {
    const set = tpPerSet.get(d.setK);
    if (!set) continue;
    const c = (d.editie === 'Shadowless' && set.schaduwKaarten.get(d.nummer)) || set.kaarten.get(d.nummer);
    d.ruw = { ...(d.ruw || {}), tp: c ? tpPrijzen(c) : (d.ruw && d.ruw.tp) || {}, datum: new Date().toISOString() };
  }

  // pass 2: Cardmarket per kaart (PokéWallet), duurste drukken eerst, alleen als er nog geen verse waarde is
  const nodig = lijst.filter(d => !(d.ruw && d.ruw.cm) && PW_KEY);
  for (const d of nodig) {
    if (pwStop) break;
    const naam = (drukkenNaam(d, perSet) || '').replace(/δ/g, '').trim();
    if (!naam) continue;
    const res = await pw(`/search?q=${encodeURIComponent(naam + ' ' + d.nummer)}&limit=20`);
    if (!res) continue;
    const pwNaam = norm((pwSetVoor(d.setNaam) || {}).name || d.setNaam);
    const hit = (res.results || []).find(r => norm(r.card_info.set_name) === pwNaam && nr(String(r.card_info.card_number).split('/')[0]) === d.nummer);
    const cmPrijzen = (hit && hit.cardmarket && hit.cardmarket.prices) || [];
    const per = (t) => { const x = cmPrijzen.find(p => p.variant_type === t); return x ? { trend: x.trend, avg: x.avg, avg7: x.avg7, avg30: x.avg30, low: x.low } : null; };
    d.ruw = { ...(d.ruw || {}), cm: cmPrijzen.length ? { normal: per('normal'), holo: per('holo'), datum: new Date().toISOString() } : { geen: true, datum: new Date().toISOString() }, datum: new Date().toISOString() };
    if ((pwCalls % 40) === 0) await schrijf(lijst, perSet, gedeeld, koers);   // tussentijds bewaren
  }
  await schrijf(lijst, perSet, gedeeld, koers);
  console.log(`Klaar: ${pwCalls} PokéWallet-verzoeken.`);
}

function drukkenNaam(d, perSet) {
  const c = perSet.get(d.setK) && perSet.get(d.setK).get(d.nummer);
  return c && c.naam;
}

function bepaal(d, perSet, gedeeld, koers) {
  const c = perSet.get(d.setK) && perSet.get(d.setK).get(d.nummer);
  const vintage = EDITIE_SETS.has(d.setK);
  const ruw = d.ruw || {};
  const maak = (editie) => {
    const bronnen = [];
    const geschiktA = !vintage || editie === 'Unlimited' || editie === null;      // Cardmarket-gemiddelde is niet editiespecifiek
    // A: TCGdex
    if (c && c.prijs_bron === 'tcgdex') {
      const v = (d.versie || '').toLowerCase();
      const a = v.includes('reverse') ? (c.prijs_reverse ?? c.prijs_holo) : v === 'holo' ? (c.prijs_holo ?? c.prijs_normaal) : c.prijs_normaal;
      if (a > 0) {
        const deel = gedeeld.get(`${d.setK}|${d.nummer}`);
        bronnen.push({ id: 'tcgdex', label: 'Cardmarket (TCGdex)', eur: Number(a), datum: c.prijs_updated?.slice(0, 10),
          onbetrouwbaar: deel ? `deelt exact dezelfde prijzen met ${deel.join(', ')}` : (!geschiktA ? `niet specifiek voor ${editie}` : undefined) });
      }
    }
    // B: Cardmarket via PokéWallet
    if (ruw.cm && !ruw.cm.geen) {
      const w = cmWaarde(ruw.cm, d.versie), det = cmDetail(ruw.cm, d.versie) || {};
      if (w > 0) bronnen.push({ id: 'pw-cm', label: 'Cardmarket (PokéWallet)', eur: w, datum: ruw.cm.datum?.slice(0, 10), onbetrouwbaar: geschiktA ? undefined : `niet specifiek voor ${editie}`, det });
    }
    // C: TCGplayer
    const sub = tpSubtype(d.versie, editie, d.setNaam);
    const usd = ruw.tp && ruw.tp[sub];
    if (usd > 0) bronnen.push({ id: 'pw-tp', label: `TCGplayer ${sub}`, eur: Math.round(usd * koers * 100) / 100, datum: ruw.datum?.slice(0, 10) });
    const cm = bronnen.find(b => b.id === 'pw-cm');
    return { bronnen, springer: cm && cm.det ? springerigheid(cm.det.trend, cm.det.avg30) : null };
  };
  if (vintage && d.editie === null) {
    const onbekend = maak(null);
    const eerste = maak('1st Edition');
    const o = oordeel(onbekend.bronnen, { springerig: onbekend.springer });
    const dure = eerste.bronnen.find(b => b.id === 'pw-tp');
    const uitleg = dure && o.waarde && dure.eur > o.waarde * 1.6
      ? `Editie onbekend: Unlimited ≈ ${eur(o.waarde)}, 1st Edition ≈ ${eur(dure.eur)} (TCGplayer). Stel de editie in voor een betrouwbare prijs.` : null;
    if (uitleg) { o.reden = uitleg + ' ' + o.reden; o.niveau = 'twijfel'; }
    return o;
  }
  const s = maak(d.editie);
  return oordeel(s.bronnen, { springerig: s.springer });
}

async function schrijf(lijst, perSet, gedeeld, koers) {
  const nu = new Date().toISOString();
  const tel = { solide: 0, enkel: 0, twijfel: 0 };
  let gepatcht = 0;
  for (const d of lijst) {
    const o = bepaal(d, perSet, gedeeld, koers);
    tel[o.niveau]++;
    const bewijs = { bronnen: o.bewijs, ruw: d.ruw || null };
    for (const e of d.exemplaren) {
      const patch = { prijs_betrouwbaarheid: o.niveau, prijs_toelichting: o.reden, prijs_bewijs: bewijs, prijs_gecontroleerd_op: nu };
      if (o.waarde != null && o.niveau !== 'enkel') patch.waarde = o.waarde;
      if (process.env.DRY_RUN === '1') continue;
      if (e.prijs_betrouwbaarheid === o.niveau && e.prijs_toelichting === o.reden && (patch.waarde == null || Number(e.waarde) === patch.waarde) && d.ruw && e.prijs_bewijs && JSON.stringify(e.prijs_bewijs.ruw) === JSON.stringify(d.ruw)) continue;
      if (await sbPatch('kaart_exemplaren', `id=eq.${e.id}`, patch)) gepatcht++;
    }
    if (DRY_RUN || process.env.TOON === '1') {
      const huidig = d.exemplaren[0].waarde;
      console.log(`${d.setNaam} #${d.nummer} ${d.versie}${d.editie ? ' (' + d.editie + ')' : ''}: app ${eur(huidig)} → ${o.waarde != null ? eur(o.waarde) : '—'} [${o.niveau}] ${o.reden}`);
    }
  }
  console.log(`Oordeel: ${tel.solide} solide, ${tel.enkel} enkel, ${tel.twijfel} twijfel; ${gepatcht} exemplaren bijgewerkt.`);
}

main().catch(e => { console.error(e); process.exit(1); });
