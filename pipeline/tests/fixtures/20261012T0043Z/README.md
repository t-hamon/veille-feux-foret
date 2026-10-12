# Capture du 12 octobre 2026, 0 h 43 UTC

Origine : run 38189075305 du workflow **Capture fixtures**, branche `fixtures/capture-38189075305`, commit `9ee9e41`, dossier `fixtures/raw/20261012T0043Z/`. Le manifeste de la capture donne l'URL, la date, la taille et l'empreinte SHA-256 de chaque réponse.

C'est la première capture qui contient la météo aux foyers récents, demandée aux lieux exacts que demande la construction des données sur ces mêmes fichiers FIRMS, à l'heure de la capture. Elle sert aux données de test du vent sur la carte (scénario `vent` de `tools/build_web_fixtures.py`) et à un test de construction sur la capture entière.

| Fichier | Contenu | Réponse brute (taille, SHA-256) |
|---|---|---|
| `firms_viirs_snpp_24h.csv.gz` | copie intégrale | 152 418 octets, `4faf3a59...` |
| `firms_viirs_noaa20_24h.csv.gz` | copie intégrale | 152 553 octets, `3aa6305d...` |
| `firms_viirs_noaa21_24h.csv.gz` | copie intégrale | 163 390 octets, `0700b511...` |
| `firms_modis_24h.csv.gz` | copie intégrale | 27 726 octets, `be1cfc62...` |
| `effis_weekly_stats.json.gz` | copie intégrale | 22 655 octets, `d06dc556...` |
| `effis_burned_dated.extract.geojson.gz` | extrait : 56 entités sur 3 103 | 18 793 995 octets, `030c6d04...` |
| `effis_burned_nrt.extract.geojson.gz` | extrait : 53 entités sur 5 089 | 2 679 424 octets, `d36428ea...` |
| `open_meteo_meta.json.gz` | copie intégrale : calcul du modèle du 11 octobre à 18:00 UTC, disponible à 23:03 UTC, dernière heure de données le 13 octobre à 21:00 UTC | 591 octets, `1ff85882...` |
| `open_meteo_wind_grid_1.json.gz` | copie intégrale : vent des 250 premiers points de la grille | 1 469 589 octets, `606e5b56...` |
| `open_meteo_wind_grid_2.json.gz` | copie intégrale : vent des 165 points suivants | 977 810 octets, `f745afc4...` |
| `open_meteo_fire_weather_1.json.gz` | copie intégrale : météo aux 3 foyers récents des fichiers FIRMS de 24 heures (49,4 ; 1,61, 43,79 ; 7,37 et 50,4 ; 3,56) | 26 750 octets, `b1b3cb5f...` |

Les copies intégrales sont identiques octet pour octet aux fichiers de la capture. Les extraits EFFIS sont produits par `tools/extract_effis_fixtures.py`, avec les mêmes règles que pour la capture du 3 octobre.

Les fichiers VIIRS de cette capture sont identiques à ceux de la capture du 11 octobre à 17:21 UTC (mêmes empreintes) : aucun nouveau passage n'avait été publié entre les deux, la dernière acquisition date du 11 octobre à 13:55 UTC.
