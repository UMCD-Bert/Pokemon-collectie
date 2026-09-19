# Pokémon/TCG-verzamelapp (Bert & Ellen)

Eén zelfstandig HTML-bestand (`index.html`, lokaal soms ook aangeleverd als
`supabase_pokemon_collectie.html`), gehost op GitHub Pages, met Supabase als
backend (gratis tier, publishable key hardcoded in het bestand). Gedeeld door
twee gebruikers (Bert & Ellen). Huidige versie: **v3.26**. Sinds v3.17 een echte PWA (`manifest.json`,
`service-worker.js`, `icons/`, Pokéball-icoon uit `icon-source.svg`); updates
comen vanzelf door (service worker haalt netwerk-eerst met `cache: 'no-store'`),
dus de snelkoppeling hoeft na een deploy niet opnieuw toegevoegd te worden.

GitHub-repo: <https://github.com/UMCD-Bert/Pokemon-collectie> (net als bij Budget en
Gezinsapp: GitHub Pages vereist dat het live bestand letterlijk `index.html`
heet).

## Werkafspraken (altijd volgen, ook zonder dat de gebruiker ze herhaalt)

- **Wijzigingen pas na een expliciete "GO"** — ook bij een lijst met meerdere
  wensen tegelijk: eerst alles verzamelen en het plan voorleggen, dan pas
  bouwen.
- Bij elke fix expliciet checken op parallelle/vergelijkbare code-plekken die
  dezelfde aanpassing nodig hebben (dit is al meermaals de daadwerkelijke
  oorzaak van "half gefixte" bugs gebleken — zie versiegeschiedenis).
- `node --check` op de JS vóór opleveren, plus een div-tag-balanscheck na
  grotere HTML-wijzigingen. (Deze app gebruikt geen jsdom-testsuite zoals de
  Budget-app — alleen deze twee checks.)
- Type-en-kies-velden: geen `<datalist>`, wel tekstveld + knop-dropdown
  (iOS-bug).
- Nieuwe Supabase-kolommen/tabellen: geef expliciete SQL als los blok, en
  stel altijd de RLS-vraag — het standaardantwoord is "nee" (geen RLS op wat
  dan ook in dit project).
- Zuinig met tokens: kort en zakelijk antwoorden.
- Consistentie tussen de Pokémon- en Trainers/Energy-detailschermen is een
  vaste eis.
- App-versienummer ophogen bij elke inhoudelijke wijziging (is al eens een
  paar versies lang vergeten — expliciet checken bij opleveren).

## Wat de app is

Pokémon, Lorcana (nog niet gebouwd) en Magic (nog niet gebouwd) horen bij
elkaar te leven in hetzelfde Supabase-project **"Verzamelingen"**, samen met
de handbagcollectie-app ([[tassenverzameling]] / "Ellens Treasures",
inmiddels gemigreerd). Dat project bevat nu 4 collecties; er is nog een vrij
tweede gratis-tier-projectslot voor huishoudapps zoals de budgetapp (aparte
"Huishouden"-project).

Foto's, prijzen (Cardmarket **EU/EUR**, nooit TCGplayer US/USD automatisch)
en set-opzoeking lopen allemaal via **TCGdex** (gratis, geen API-key).

## Architectuur — 6 tabbladen

- **Pokémon** — Pokédex-hoofdpagina (`records`-tabel) + detailvenster per
  kaart. Geen bezit-vinkje op de kaart-tegel zelf (verwijderd wegens
  misklik-risico) — "in bezit" wordt automatisch afgeleid uit aanwezigheid
  van kaartexemplaren, handmatig te zetten via het vinkje ín het
  detailvenster.
- **Trainers & Energy** — samengevoegd tabblad — `tcg_extra` (items) +
  `kaart_exemplaren`, met een type-filterdropdown.
- **Serie/Set** — `tcg_set_kaarten`, cache van TCGdex-setinhoud. Live
  "X van Y zichtbaar"-teller. Voortgangscirkel update live bij elke
  aan/uitvink-actie. Elke kaart toont een 📖-badge naast een versie-vinkje
  als dat exemplaar in de Pokédex-binder zit, en (sinds v3.15/v3.16) een
  rechts uitgelijnd "Dex #<nummer>"-badge naast het setinterne kaartnummer.
  Klikken op een kaart opent een klein kaartvenster met "🔄 Ververs deze
  kaart" én "📋 Open volledige kaart".
- **Sealed** — sealed producten (ETB's e.d.) voor doorverkoop, tabel
  `sealed_producten` (aankoopprijs vs handmatig bijgehouden huidige_waarde,
  geen prijs-API voor sealed).
- **📦 Verkoop** (v3.19) — verkoopkavels voor dubbele kaarten (Vinted). Tabel
  `verkoop_bundels` (naam, status open/verkocht, vraagprijs, verkocht_bedrag,
  verkocht_op) + kolom `kaart_exemplaren.verkoop_bundel_id`. Kaarten uit
  meerdere sets in één kavel; alleen eigen, nog niet gereserveerde exemplaren
  komen in beeld; een rij met `aantal` > 1 wordt gesplitst als je er minder van
  toevoegt. Marktwaarde = som van `kaart_exemplaren.waarde` (via
  `instanceLineValue`). "Markeer als verkocht" verwijdert de gekoppelde
  exemplaren definitief (voorraad bijgewerkt), de kavel blijft als historie.
  Exemplaren in een kavel tonen een 📦-badge in Serie/Set en het detailvenster.
- **Dashboard** — hub-scherm: tegel-grid, een tegel verbergt het overzicht en
  toont alleen die sectie + "Terug"-knop. Instellingen (⚙️) bevat de
  prijsupdate-statusregel en de checklist-weergave-toggle.

### Dashboard-onderdelen (tegels)

Totaalwaarde + taartdiagram · 🔢 Aantallen (incl. Binderwaarde) · 🔄
Pokedex-wissels · 📦 Meeste exemplaren van 1 kaart (top 20, gepagineerd) · ♻️
Meer dan 2x dezelfde druk (gepagineerd, rijen klikbaar) · 📊 Meest complete
sets · 💰 Sets op waarde · 💎 Duurste kaarten (🔍-link per rij naar
Cardmarket-zoekresultaat) · ⚠️ Verdachte prijzen.

## Tabellen

- `records` — Pokédex, incl. `inbezit` (auto-afgeleid).
- `tcg_extra` — Trainers/Energy-items.
- `kaart_exemplaren` — losse kaartexemplaren (ruim over 2000 rijen). Incl.
  `in_pokedex` (boolean, max 1 per record afgedwongen), `waarde`,
  `prijs_bron_datum`, `prijs_handmatig_datum` (blokkeert automatische
  prijsoverschrijving tenzij de online-datum aantoonbaar nieuwer is).
- `tcg_set_kaarten` — cache van opgehaalde sets, incl. `release_datum`
  (tiebreaks), `dexid`, `prijs_normaal/prijs_holo/prijs_reverse` (**alleen**
  een schatting voor niet-bezeten drukken — zie prijzensync hieronder),
  `prijs_updated`.
- `sealed_producten` — zie Sealed hierboven.
- `prijs_update_log` — logboek van de dagelijkse GitHub Actions prijsupdate
  (incl. `nieuwe_sets_geimporteerd`).
- `aangekondigde_sets` (v3.18) — sets die (nog) niet in `CARD_SERIES` staan:
  serie, set_naam, optioneel `tcgdex_naam` (als TCGdex de set anders noemt),
  verwachte_datum, `opgehaald`. Data-driven in plaats van hardcoden: rijen
  verschijnen altijd in de set-kiezers, en de dagelijkse job importeert een set
  automatisch zodra TCGdex hem met kaarten kent. Nieuwe set = gewoon een rij
  toevoegen. Let op: TCGdex' setlijst bevat geen serie-info, dus de dynamische
  ontdekking in de app vult niets aan.
- `verkoop_bundels` — zie het tabblad Verkoop.

## Belangrijke architectuurbeslissing: prijzen (sinds v3.15)

Er zijn twee soorten prijs-opslag die vroeger onafhankelijk van elkaar
konden ver­verst worden en daardoor uit elkaar liepen: de setcache
(`tcg_set_kaarten.prijs_*`) en het eigen exemplaar
(`kaart_exemplaren.waarde`). **Sinds v3.15 is `kaart_exemplaren.waarde` de
enige bron van waarheid voor elke druk die je bezit**, overal waar een prijs
getoond wordt (Serie/Set, "Alle bekende drukken", sorteren op waarde) — via
de helper `effectivePriceForRow(row, versie)`. De setcache blijft alleen de
schatting voor drukken die je *niet* bezit. Elke ververs-actie die een
bezeten druk raakt schrijft daarom ook door naar het eigen exemplaar, met
dezelfde `prijs_handmatig_datum`-bescherming als de detailpagina altijd al
had (`manualPriceBlocksUpdate` / `applyPriceToInstanceIfEligible`).

**Als je hier ooit weer iets aan verandert: check alle drie de
ververs-ingangen tegelijk** — los kaartje in Serie/Set, hele set in één
keer, én de collectiebrede bulk-sync (`fetchPriceForBulk`/`applyBulkPrice`)
— dat is precies de plek waar deze klasse van bugs eerder ontstond.

## Dagelijkse automatische prijsupdate (GitHub Actions)

`scripts/update-prices.mjs` + `.github/workflows/daily-price-update.yml` (met vóór
de prijsupdate een fase die `aangekondigde_sets` afloopt en gevonden sets importeert;
maakt de set eerst leeg om dubbelen te voorkomen),
cron 05:00 UTC (~07:00 lokaal), ook handmatig te starten via de Actions-tab.
Gebruikt dezelfde publishable key als de app (RLS staat uit). Ververst
`tcg_set_kaarten`-cache én `kaart_exemplaren.waarde` voor
niet-handmatig-overschreven exemplaren; respecteert `prijs_handmatig_datum`
volledig. Schrijft naar `prijs_update_log`; status zichtbaar in het
instellingenpaneel. Draait succesvol — deze twee bestanden staan al in de
repo, dit CLAUDE.md hoeft ze niet te reproduceren.

## Vaste technische lessen (opgelost, niet opnieuw laten gebeuren)

- Kaartnummers: voorloopnullen-tolerant matchen, ook na een
  lettervoorvoegsel; setnamen case-insensitief en genormaliseerd naar
  canonieke schrijfwijze bij het verlaten van een veld.
- ID-vergelijkingen altijd met `String(...)`, nooit strikte `===`.
- `TCGDEX_NAME_OVERRIDES` voor bekende naamsverschillen (EX-prefix,
  Celebrations: Classic Collection, SVP/MEP Black Star Promos, enz.).
- "Trainer's Pokémon"-kaarten (bijv. "Iono's Kilowattrel", "Larry's
  Braviary") herkend via het "Naam's Soort"-patroon
  (`extractCoreSpeciesName`), vallen terug op naam-matching i.p.v. dexid —
  geldt zowel voor de parent-koppeling als (sinds v3.16) voor de Dex-badge
  in Serie/Set (`effectiveDexId`).
- Kaartnaam → Pokédex-soort (`extractCoreSpeciesName`): negeert regionale
  voorvoegsels (Alolan/Galarian/Hisuian/Paldean) en zet ♀/♂ om naar " f"/" m"
  (Pokédex heet "Nidoran F/M"). Nodig omdat TCGdex bij sommige sets (30th
  Celebration) helemaal geen dexid meegeeft.
- Bekend TCGdex-gat bij nieuwe sets: geen foto's/prijzen in de eerste dagen,
  en `heeft_normaal/holo/reverse` kan onjuist zijn (30th Celebration is
  alleen Holo; handmatig gezet, "Deze set opnieuw ophalen" zet het terug).
  Foto's worden bij bestaande sets niet door de job aangevuld.
- `pickTcgdexPrice()` prijst bijzondere drukken (Master Ball Holo e.d.) nooit
  automatisch.
- Een druk-vinkje (Normaal/Holo/Reverse Holo) verschijnt ook als er een
  eigen exemplaar bestaat, ongeacht wat TCGdex's eigen
  `heeft_normaal/heeft_holo/heeft_reverse`-vlaggen zeggen (kunnen onvolledig
  zijn per kaart).
- Setnaam-groepsleutel voor foto-aanvulling/prijsvergelijking:
  `parent_type + parent_id + serie + set_naam + kaartnummer`.
- Alle Supabase-fetches gebruiken `cache: 'no-store'` (iOS-PWA cachte anders
  te agressief tussen apparaten).
- Nieuwe "haal alles op"-functies altijd standaard pagineren (PostgREST
  default-limiet is 1000 rijen) — heeft al eens tot valse
  "kaart verdwenen"-meldingen geleid.

## Nog niet (volledig) opgelost

- Pokémon TCG Classic (Charizard/Blastoise/Venusaur) — exacte TCGdex-naam
  nog niet bevestigd.
- Letternummer-kaarten (Aquapolis "H03" e.d.) krijgen soms een prijs maar
  nooit een foto — bevestigd TCGdex-datagat, geen appfout.
- "Verdachte prijzen" blijft fundamenteel een handmatig-controle-hulpmiddel,
  geen waterdicht automatisch systeem.

## Ook besproken (niet gebouwd)

- Commerciële/App Store-versie afgeraden (Pokémon-IP/TCGdex-voorwaarden/
  Nintendo-handhaving).
- Lorcana/Magic-zusterapps besproken, nog niet gebouwd.
- pokemontcg.io als fallback-beeldbron voor TCGdex-datagaten (bijv. Dragon
  Majesty, set-id "sm75") — nog niet geïmplementeerd, alleen genoteerd.
- Nieuwe Dashboard-ideeën geopperd (nog geen besluit): overzicht ontbrekende
  foto's, Sealed-rendement, "net begonnen sets", recent-toegevoegd-logboek,
  binder-compleetheid % per serie.

## Versiegeschiedenis (kort, chronologisch vanaf v3.10)

- v3.10: druk-vinkje verdween onterecht bij onvolledige TCGdex-variantdata —
  nu ook zichtbaar bij een bestaand eigen exemplaar, in alle drie de
  betrokken plekken.
- v3.11: "📋 Open volledige kaart"-knop in het Serie/Set-kaartvenster.
- v3.12: sluiten van het detailvenster keert terug naar Serie/Set als het
  van daaruit geopend was.
- v3.13: pokedex-wissel kopieert meteen een zusje-foto als het net gekozen
  exemplaar er zelf geen heeft (was pas bij volgende page-load).
- v3.14: 📖-badge in Serie/Set + "Alle bekende drukken"; setgauge update nu
  live bij elke toggle (was alleen bij volledige re-render).
- v3.15: **prijzensync-bug gefixt** — zie architectuurbeslissing hierboven;
  Dex #-badge toegevoegd in Serie/Set.
- v3.16: Dex #-badge valt nu ook terug op naam-matching
  (`effectiveDexId`/`findRecordBySpeciesName`) voor "Naam's Soort"-kaarten
  zonder eigen TCGdex-dexid.
- v3.17: PWA (manifest, service worker, iconen).
- v3.18: `aangekondigde_sets` + automatische set-import in de dagelijkse job.
- v3.19–v3.24: tabblad Verkoop (kavels), kandidatenlijst met kaartnummer/sortering,
  breedte 700px, kavel hernoemen.
- v3.25: set-kiezers tonen altijd alle `aangekondigde_sets`.
- v3.26: regionale vormen en Nidoran koppelen op naam aan de juiste Pokémon.
