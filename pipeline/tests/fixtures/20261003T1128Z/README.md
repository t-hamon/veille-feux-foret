# Capture du 3 octobre 2026, 11 h 28 UTC

Origine : run 37119741727 du workflow **Capture fixtures**, branche `fixtures/capture-37119741727`, commit `cec7079`, dossier `fixtures/raw/20261003T1128Z/`. Le manifeste de la capture donne l'URL, la date, la taille et l'empreinte SHA-256 de chaque réponse.

| Fichier | Contenu | Réponse brute (taille, SHA-256) |
|---|---|---|
| `firms_viirs_snpp_24h.csv.gz` | copie intégrale | 76 005 octets, `29a25c98...` |
| `firms_viirs_noaa20_24h.csv.gz` | copie intégrale | 129 370 octets, `4f9f4932...` |
| `firms_viirs_noaa21_24h.csv.gz` | copie intégrale | 86 465 octets, `209decd3...` |
| `firms_modis_24h.csv.gz` | copie intégrale | 22 835 octets, `89d4ca67...` |
| `effis_weekly_stats.json.gz` | copie intégrale | 22 661 octets, `4df1fcdc...` |
| `effis_burned_dated.extract.geojson.gz` | extrait : 56 entités sur 3 086 | 18 724 741 octets, `2c9ff4f1...` |
| `effis_burned_nrt.extract.geojson.gz` | extrait : 53 entités sur 5 073 | 2 673 456 octets, `c4010690...` |

Les copies intégrales sont identiques octet pour octet aux fichiers de la capture.

Les extraits EFFIS sont produits par `tools/extract_effis_fixtures.py`, à partir du dossier brut de la capture. Les entités sont recopiées sans modification (axes toujours dans l'ordre [latitude, longitude] d'EFFIS) :

- couche datée : les 40 premières entités françaises, 8 espagnoles, 2 italiennes et 2 sans pays (triées par date puis identifiant), plus toutes les entités qui ne sont pas un simple polygone (3 MultiPolygon, 1 GeometryCollection) ;
- couche NRT, sans attribut : 25 surfaces au cœur de la France, 3 MultiPolygon français, 15 surfaces au sud des Pyrénées et 10 à l'est des Alpes, choisies sur la position moyenne de leurs sommets.

Les nombres attendus par les tests (46 détections en France, 7 foyers, 43 surfaces datées, 28 surfaces récentes, 97 971 ha pour la saison) ont été mesurés sur ces fichiers.
