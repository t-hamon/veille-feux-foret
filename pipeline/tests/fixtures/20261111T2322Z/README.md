# Capture du 11 novembre 2026, 23 h 22 UTC

Origine : run 43119331056 du workflow **Capture fixtures**, branche `fixtures/capture-43119331056`, commit `9185f86`, dossier `fixtures/raw/20261111T2322Z/`. Le manifeste de la capture donne l'URL, la date, la taille et l'empreinte SHA-256 de chaque réponse.

Les réponses de l'API Package Observations de Météo-France (v2) servent aux tests du pipeline. Les autres réponses reprises ici (FIRMS, EFFIS, Open-Meteo) ne servent qu'au scénario `stations` des données de test du site (`tools/build_web_fixtures.py`, dossier `web/e2e/fixtures/stations/`), pour que le pipeline écrive tous les fichiers du site à partir de la même capture.

Licences : données de Météo-France sous Licence Ouverte (Etalab), source : Météo-France ; voir [CREDITS.md](../../../../CREDITS.md) pour les autres sources.

| Fichier | Contenu | Réponse brute (taille, SHA-256) |
|---|---|---|
| `meteofrance_stations.csv.gz` | copie intégrale : liste des 2 152 stations, métropole et outre-mer (séparateur `;`) | 139 977 octets, `bfada887...` |
| `meteofrance_hourly_20261111T23Z.json.gz` | copie intégrale : mesures horaires de toutes les stations, 11 novembre à 23:00 UTC | 967 231 octets, `04cbbc76...` |
| `meteofrance_hourly_20261111T22Z.json.gz` | copie intégrale : idem, 22:00 UTC | 977 737 octets, `20408058...` |
| `meteofrance_hourly_20261111T21Z.json.gz` | copie intégrale : idem, 21:00 UTC | 979 636 octets, `7bd7bb85...` |
| `meteofrance_department_13_24h.json.gz` | copie intégrale : paquet « 24 heures » des Bouches-du-Rhône | 1 139 296 octets, `92602368...` |
| `firms_viirs_snpp_24h.csv.gz` | copie intégrale : NASA FIRMS, VIIRS Suomi NPP, 24 heures | 112 octets, `fe0401e4...` |
| `firms_viirs_noaa20_24h.csv.gz` | copie intégrale : NASA FIRMS, VIIRS NOAA-20, 24 heures | 30 421 octets, `f8f7cdcb...` |
| `firms_viirs_noaa21_24h.csv.gz` | copie intégrale : NASA FIRMS, VIIRS NOAA-21, 24 heures | 31 083 octets, `4c870e6c...` |
| `firms_modis_24h.csv.gz` | copie intégrale : NASA FIRMS, MODIS, 24 heures | 2 460 octets, `339f2e0a...` |
| `effis_weekly_stats.json.gz` | copie intégrale : EFFIS, statistiques hebdomadaires | 22 638 octets, `251cd509...` |
| `effis_burned_dated.extract.geojson.gz` | extrait : 56 entités sur 3 173 | 19 259 735 octets, `5b6cb5d3...` |
| `effis_burned_nrt.extract.geojson.gz` | extrait : 53 entités sur 5 148 | 2 702 815 octets, `80d51399...` |
| `open_meteo_meta.json.gz` | copie intégrale : Open-Meteo, calcul du modèle du 11 novembre à 18:00 UTC, disponible à 23:02 UTC, fin des données annoncée le 13 novembre à 22:00 UTC (`data_end_time`) | 591 octets, `efb43580...` |
| `open_meteo_wind_grid_1.json.gz` | copie intégrale : Open-Meteo, vent des 250 premiers points de la grille | 1 463 661 octets, `4cda982b...` |
| `open_meteo_wind_grid_2.json.gz` | copie intégrale : Open-Meteo, vent des 165 points suivants | 959 951 octets, `28d5d53d...` |

Les copies intégrales sont identiques octet pour octet aux fichiers de la capture (empreintes vérifiées le 11 novembre 2026 pour Météo-France, le 12 novembre 2026 pour les autres). Les extraits EFFIS sont produits par `tools/extract_effis_fixtures.py`, avec les mêmes règles que pour la capture du 3 octobre ; leurs entités sont recopiées sans modification (vérifié le 12 novembre 2026 : chaque entité des extraits figure à l'identique dans la réponse brute). Le GeoJSON de 23:00 UTC, aussi capturé, n'est pas repris : il porte les mêmes mesures.

Constats mesurés sur ces réponses :
- une liste JSON d'objets, un par station : `geo_id_insee` (8 chiffres), `lat`, `lon`, `validity_time` (heure de la mesure, UTC), puis tous les paramètres du descriptif technique, `null` quand ils manquent ;
- à 23:00 UTC, 2 035 stations, dont 822 mesurent le vent (`ff`, `dd`, `raf` non nuls), 719 en métropole et en Corse ; 726 stations de métropole et de Corse ont du vent à au moins une des trois heures ;
- vitesses en m/s au dixième, directions de 10 en 10 degrés ; une direction 0 va toujours avec un vent nul (42 cas sur 42 à 23:00 UTC), le nord est noté 360 ;
- le paquet du département couvre 120 heures, du 7 novembre 00:00 au 11 novembre 23:00 UTC, et non 24 heures comme l'annonce la documentation ; ses 20 stations à 22:00 UTC sont identiques à celles du paquet de toutes les stations ;
- aucune valeur hors des bornes physiques retenues par le pipeline.
