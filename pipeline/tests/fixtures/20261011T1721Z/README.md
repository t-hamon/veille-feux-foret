# Capture du 11 octobre 2026, 17 h 21 UTC

Origine : run 38159286544 du workflow **Capture fixtures**, branche `fixtures/capture-38159286544`, commit `ed834e0`, dossier `fixtures/raw/20261011T1721Z/`. Le manifeste de la capture donne l'URL, la date, la taille et l'empreinte SHA-256 de chaque réponse.

Seules les réponses d'Open-Meteo (modèle AROME France HD de Météo-France) sont reprises ici ; les autres sources de cette capture ne servent pas aux tests.

| Fichier | Contenu | Réponse brute (taille, SHA-256) |
|---|---|---|
| `open_meteo_meta.json.gz` | copie intégrale : calcul du modèle du 11 octobre à 12:00 UTC, disponible à 15:57 UTC, dernière heure de données le 13 octobre à 15:00 UTC | 591 octets, `75e63d75...` |
| `open_meteo_wind_grid_1.json.gz` | copie intégrale : vent des 250 premiers points de la grille | 1 468 070 octets, `b6e88abd...` |
| `open_meteo_wind_grid_2.json.gz` | copie intégrale : vent des 165 points suivants | 976 127 octets, `1729e7be...` |
| `open_meteo_weather_sample.json.gz` | copie intégrale : météo en deux points fixes, Aix-en-Provence (43,5297 ; 5,4474) et forêt des Landes (44,923 ; -0,997) | 17 870 octets, `0a64c760...` |

Les copies intégrales sont identiques octet pour octet aux fichiers de la capture.

Constats mesurés sur ces réponses : 228 heures par point, du 4 octobre 17:00 UTC au 14 octobre 04:00 UTC ; les 13 dernières heures, après le 13 octobre 15:00 UTC, sont vides pour tous les points et toutes les variables (fin des données du calcul) ; avec la sélection de la maille la plus proche, chaque point de la grille est répondu exactement à ses coordonnées ; aucune valeur hors des bornes physiques.

Les tests de construction servent la réponse en deux points pour une requête aux mêmes lieux arrondis à 0,01° (43,53 ; 5,45 et 44,92 ; -1,00), position des foyers de test. Vérifié depuis un navigateur le 11 octobre 2026 : Open-Meteo répond à ces lieux arrondis par les mêmes mailles du modèle. L'altitude qu'il retient pour ajuster la température diffère en revanche de quelques mètres (209 m contre 205 m, 40 m contre 34 m) : sa réponse réelle à la requête arrondie aurait des températures très légèrement différentes. Les tests ne vérifient que la forme et le traitement des valeurs, pas leur exactitude météorologique.
