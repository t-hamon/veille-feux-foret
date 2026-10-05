# Crédits

## Projets d'origine

| Projet | Auteur | Licence | Ce qui est repris |
|---|---|---|---|
| [carte-incendies](https://github.com/lgdlcs/feux-france) ([démo](https://carte-incendies.fr)) | Lucas Legrand (lgdlcs) | MIT | Code d'origine sous licence MIT, réutilisé et modifié (détail ci-dessous). |
| [Flamap](https://github.com/rozierguillaume/flamap) ([démo](https://flamap.fr)) | Guillaume Rozier (rozierguillaume) | aucune licence déclarée | Inspiration fonctionnelle, réimplémentation indépendante, aucun code repris. Seuls le README et la démo publique ont été consultés. |
| [feux-france](https://github.com/the20100/feux-france) | Vincent (the20100) | aucune licence visible | Inspiration fonctionnelle, réimplémentation indépendante, aucun code repris. Seul le README a été consulté. |

### Éléments repris de carte-incendies

| Élément | Où | Modifications |
|---|---|---|
| Texte de la licence MIT | `LICENSE` | ajout d'une ligne de copyright |
| URL des flux FIRMS, URL et paramètres des requêtes EFFIS (WFS et statistiques), emprise de la métropole | `pipeline/src/veille_feux/sources.py` | regroupés dans un module unique qui sert aussi de liste blanche des hôtes |
| Liste des sites industriels à chaleur permanente (21 sites) | `pipeline/src/veille_feux/data/sites_industriels.json` | tirets longs remplacés par des tirets courts dans 3 noms |
| Test d'appartenance à la France par lancer de rayon, avec index par bandes de latitude | `pipeline/src/veille_feux/geo.py` | arêtes horizontales conservées pour le calcul de distance ; marge côtière ajoutée |
| Regroupement des détections en foyers (grille de 0,02°, 8-connexité, 3 détections minimum, surface estimée) | `pipeline/src/veille_feux/foyers.py` | ordre et identifiants déterministes, emprise par enveloppe convexe calculée côté données |
| Lecture des surfaces brûlées EFFIS : permutation des axes, simplification Douglas-Peucker, test France de la couche NRT, garde-fou contre une couche anormalement pauvre | `pipeline/src/veille_feux/effis.py`, `build.py` | les GeometryCollection gardent leur partie polygone au lieu d'être écartées |
| Bilan national de la saison à partir des statistiques hebdomadaires EFFIS | `pipeline/src/veille_feux/effis.py` | les semaines non encore publiées sont ignorées explicitement |

## Données géographiques embarquées

| Fichier | Source | Licence |
|---|---|---|
| `pipeline/src/veille_feux/data/metropole.geojson` | [france-geojson](https://github.com/gregoiredavid/france-geojson) de Grégoire David, fichier `metropole.geojson`, conversion simplifiée d'IGN Admin Express COG 2018 | Licence Ouverte (IGN) ; fichier identique à celui utilisé par carte-incendies |
| `pipeline/src/veille_feux/data/voisins.geojson` | [Natural Earth](https://www.naturalearthdata.com), `ne_10m_admin_0_countries`, dépôt [natural-earth-vector](https://github.com/nvkelso/natural-earth-vector) (commit `ca96624`) ; extrait par `tools/build_neighbours.py` | domaine public. Made with Natural Earth. |

## Sources de données

| Source | Licence | Statut |
|---|---|---|
| NASA FIRMS (VIIRS 375 m, MODIS 1 km) | politique de données ouvertes de la NASA, citation et avertissement LANCE | vérifiée, utilisée par la commande de construction des données |
| Copernicus EFFIS (surfaces brûlées, statistiques) | CC BY 4.0 | vérifiée, utilisée par la commande de construction des données |
| geo.api.gouv.fr (recherche de commune), service de la DINUM | Licence Ouverte (Etalab) pour les données de la métropole : noms et codes des communes issus du Code officiel géographique de l'INSEE, contours issus d'IGN ADMIN EXPRESS | vérifiée le 3 octobre 2026, utilisée seulement par la capture d'un échantillon |

La licence de geo.api.gouv.fr a été vérifiée dans les dépôts dont le service est construit, [api-geo](https://github.com/datagouv/api-geo), [decoupage-administratif](https://github.com/datagouv/decoupage-administratif) et [contours-administratifs](https://github.com/datagouv/contours-administratifs) : la fiche de l'API sur data.gouv.fr indique un accès ouvert, limité à 50 appels par seconde et par adresse IP, sans nommer de licence. Le code de ces dépôts est sous licence MIT ; il n'est pas repris ici.

Les autres sources (Open-Meteo, Météo-France, IGN, OpenFreeMap, Sentinel-2, ADS-B) seront vérifiées avant leur intégration, lot par lot.

## Images et polices

Aucune image ni police externe pour l'instant. L'interface utilise les polices système.
