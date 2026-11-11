# Capture du 11 novembre 2026, 23 h 22 UTC

Origine : run 43119331056 du workflow **Capture fixtures**, branche `fixtures/capture-43119331056`, commit `9185f86`, dossier `fixtures/raw/20261111T2322Z/`. Le manifeste de la capture donne l'URL, la date, la taille et l'empreinte SHA-256 de chaque réponse.

Seules les réponses de l'API Package Observations de Météo-France (v2) sont reprises ici. Données sous Licence Ouverte (Etalab), source : Météo-France.

| Fichier | Contenu | Réponse brute (taille, SHA-256) |
|---|---|---|
| `meteofrance_stations.csv.gz` | copie intégrale : liste des 2 152 stations, métropole et outre-mer (séparateur `;`) | 139 977 octets, `bfada887...` |
| `meteofrance_hourly_20261111T23Z.json.gz` | copie intégrale : mesures horaires de toutes les stations, 11 novembre à 23:00 UTC | 967 231 octets, `04cbbc76...` |
| `meteofrance_hourly_20261111T22Z.json.gz` | copie intégrale : idem, 22:00 UTC | 977 737 octets, `20408058...` |
| `meteofrance_hourly_20261111T21Z.json.gz` | copie intégrale : idem, 21:00 UTC | 979 636 octets, `7bd7bb85...` |
| `meteofrance_department_13_24h.json.gz` | copie intégrale : paquet « 24 heures » des Bouches-du-Rhône | 1 139 296 octets, `92602368...` |

Les copies intégrales sont identiques octet pour octet aux fichiers de la capture (empreintes vérifiées le 11 novembre 2026). Le GeoJSON de 23:00 UTC, aussi capturé, n'est pas repris : il porte les mêmes mesures.

Constats mesurés sur ces réponses :
- une liste JSON d'objets, un par station : `geo_id_insee` (8 chiffres), `lat`, `lon`, `validity_time` (heure de la mesure, UTC), puis tous les paramètres du descriptif technique, `null` quand ils manquent ;
- à 23:00 UTC, 2 035 stations, dont 822 mesurent le vent (`ff`, `dd`, `raf` non nuls), 719 en métropole et en Corse ; 726 stations de métropole et de Corse ont du vent à au moins une des trois heures ;
- vitesses en m/s au dixième, directions de 10 en 10 degrés ; une direction 0 va toujours avec un vent nul (42 cas sur 42 à 23:00 UTC), le nord est noté 360 ;
- le paquet du département couvre 120 heures, du 7 novembre 00:00 au 11 novembre 23:00 UTC, et non 24 heures comme l'annonce la documentation ; ses 20 stations à 22:00 UTC sont identiques à celles du paquet de toutes les stations ;
- aucune valeur hors des bornes physiques retenues par le pipeline.
