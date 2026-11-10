// Hoe vaak de prijs van een eigen druk ververst wordt, naar waarde (zie CLAUDE.md, "Prijsniveaus").
// Zuivere functies, zonder netwerk: getest met `node --test scripts/test`.
//
//   vanaf € 4        dagelijks
//   € 0,50 tot € 4   wekelijks
//   onder € 0,50     maandelijks
//
// De waarde waarmee gerekend wordt is de hoogste van de eigen waarde en de prijs in de setcache (TCGdex, elke dag vers): een goedkope
// kaart die ineens duurder wordt, gaat zo meteen naar een hoger niveau.

export const GRENS_LAAG = 0.5;
export const GRENS_HOOG = 4;
export const TCGPLAYER_DAGEN = 7;   // een hele set tegelijk ophalen kost meerdere verzoeken: nooit vaker dan wekelijks
const SPELING = 0.25;               // dagen; de dagelijkse run start niet op de minuut, dus 23,9 uur geleden telt als een dag

export function verversDagen(waarde) {
  const w = Number(waarde) || 0;
  return w >= GRENS_HOOG ? 1 : w >= GRENS_LAAG ? 7 : 30;
}

/** De waarde waarmee het niveau bepaald wordt: de hoogste van de eigen waarde en de prijs in de setcache. */
export function niveauWaarde(...waarden) {
  return Math.max(0, ...waarden.map(w => Number(w) || 0));
}

/** Is een eerder opgehaalde meting oud genoeg om opnieuw op te halen? Zonder datum altijd. */
export function aanDeBeurt(datum, dagen, nu = Date.now()) {
  const t = Date.parse(datum);
  if (!(t > 0)) return true;
  return (nu - t) / 86400000 >= dagen - SPELING;
}
