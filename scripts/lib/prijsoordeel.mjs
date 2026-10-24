// Betrouwbaarheid van een prijs bepalen uit meerdere onafhankelijke bronnen (zie CLAUDE.md, "Robuuste prijzen").
// Zuivere functies, zonder netwerk: getest met `node --test scripts/test`.
//
// Een bron is { id, label, eur, datum?, onbetrouwbaar? } met `eur` in euro (dollars zijn al omgerekend). Heeft een bron
// `onbetrouwbaar` (een reden), dan telt hij niet mee maar staat hij wel in het bewijs (bijv. een gedeeld Cardmarket-product).

export const TOLERANTIE = 1.6;   // twee bronnen "komen overeen" als de duurste hooguit 1,6× de goedkoopste is...
export const KLEIN_BEDRAG = 1.5; // ...of als het verschil kleiner is dan dit bedrag (kleingeld is ruis)

export const eur = (x) => '€ ' + Number(x).toFixed(2).replace('.', ',');

export function mediaan(lijst) {
  const s = [...lijst].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const overeen = (a, b) => Math.abs(a - b) <= KLEIN_BEDRAG || Math.max(a, b) / Math.min(a, b) <= TOLERANTIE;

/** De grootste groep bronnen die onderling overeenkomt (bij gelijke grootte de goedkoopste). */
export function grootsteGroep(bronnen) {
  let beste = [];
  for (const b of [...bronnen].sort((x, y) => x.eur - y.eur)) {
    const groep = bronnen.filter(o => overeen(o.eur, b.eur) && overeen(o.eur, bronnen.filter(p => overeen(p.eur, b.eur)).reduce((m, p) => Math.min(m, p.eur), Infinity)));
    if (groep.length > beste.length) beste = groep;
  }
  return beste;
}

/**
 * @param bronnen  lijst bronnen (zie boven)
 * @param opties   { springerig?: string } reden als de markt springerig is (prijs wisselt sterk), { extra?: string } toelichting die altijd mee moet,
 *                 { maxNiveau?: 'enkel' } voor spellen met maar één bron
 * @returns { niveau: 'solide'|'enkel'|'twijfel', waarde: number|null, reden: string, bewijs: [...] }
 */
export function oordeel(bronnen, opties = {}) {
  const bewijs = bronnen.map(b => ({ bron: b.id, label: b.label, eur: b.eur ?? null, datum: b.datum ?? null, opmerking: b.onbetrouwbaar ?? null }));
  const geldig = bronnen.filter(b => b.eur > 0 && !b.onbetrouwbaar);
  const slecht = bronnen.filter(b => b.onbetrouwbaar);
  const lijstje = (l) => l.map(b => `${b.label} ${eur(b.eur)}`).join(', ');
  const noteer = (s) => [s, opties.extra].filter(Boolean).join(' ');
  const slechtTekst = slecht.map(b => `${b.label}: ${b.onbetrouwbaar}`).join('; ');

  if (geldig.length === 0) {
    return { niveau: slecht.length ? 'twijfel' : 'enkel', waarde: null,
             reden: noteer(slecht.length ? `Geen bruikbare prijs. ${slechtTekst}` : 'Geen prijs gevonden.'), bewijs };
  }
  if (geldig.length === 1) {
    const b = geldig[0];
    const twijfel = slecht.length > 0 || opties.springerig;
    return { niveau: twijfel ? 'twijfel' : 'enkel', waarde: b.eur,
             reden: noteer(`Alleen ${b.label} ${eur(b.eur)} (niet gecontroleerd).${slecht.length ? ' ' + slechtTekst + '.' : ''}${opties.springerig ? ' ' + opties.springerig : ''}`), bewijs };
  }
  const groep = grootsteGroep(geldig);
  if (groep.length >= 2 && !opties.maxNiveau) {
    const buiten = geldig.filter(b => !groep.includes(b));
    const waarde = mediaan(groep.map(b => b.eur));
    const twijfel = Boolean(opties.springerig);
    let reden = `${lijstje(groep)} komen overeen.`;
    if (buiten.length) reden += ` Wijkt af: ${lijstje(buiten)}.`;
    if (slecht.length) reden += ` Niet meegeteld: ${slechtTekst}.`;
    if (opties.springerig) reden += ' ' + opties.springerig;
    return { niveau: twijfel ? 'twijfel' : 'solide', waarde, reden: noteer(reden), bewijs };
  }
  // geen twee bronnen die overeenkomen: de laagste aanhouden, zodat je nooit te hoog staat
  const laagste = Math.min(...geldig.map(b => b.eur));
  return { niveau: 'twijfel', waarde: laagste,
           reden: noteer(`Bronnen spreken elkaar tegen: ${lijstje(geldig)}. Laagste aangehouden.${slecht.length ? ' ' + slechtTekst + '.' : ''}`), bewijs };
}

/** Springerige markt: de trend wijkt sterk af van het 30-dagengemiddelde (alleen boven € 10 de moeite). */
export function springerigheid(trend, avg30) {
  if (!(trend >= 10) || !(avg30 > 0)) return null;
  const r = trend / avg30;
  if (r > 1.8 || r < 0.55) return `Springerige markt: trend ${eur(trend)} tegenover 30-daags gemiddelde ${eur(avg30)}.`;
  return null;
}
