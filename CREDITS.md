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

Les autres sources (Open-Meteo, Météo-France, orthophotos IGN, Sentinel-2, ADS-B) seront vérifiées avant leur intégration, lot par lot.

## Fonds de carte

Les deux fonds sont lus directement par le navigateur du visiteur sur leurs serveurs publics, sans clé. Conditions vérifiées le 5 octobre 2026.

| Fond | Ce qui est utilisé | Licence et conditions | Mention affichée sous la carte |
|---|---|---|---|
| Plan IGN, style gris (fond par défaut) | style `PLAN.IGN/gris.json`, tuiles vectorielles `PLAN.IGN`, glyphes et sprite, sur `data.geopf.fr` (Géoplateforme de l'IGN) | données sous Licence Ouverte 2.0 (fiche [Plan IGN](https://www.data.gouv.fr/datasets/plan-ign) sur data.gouv.fr) ; d'après la page [Limites d'usage](https://cartes.gouv.fr/aide/fr/guides-utilisateur/utiliser-les-services-de-la-geoplateforme/limites-d-usage/) de cartes.gouv.fr, le service de tuiles vectorielles TMS n'est pas soumis à la limitation de débit | © IGN, Plan IGN ; Licence Ouverte 2.0 |
| OpenFreeMap, style Positron (au choix) | style `positron`, tuiles vectorielles, raster de relief Natural Earth, glyphes et sprite, sur `tiles.openfreemap.org` | [OpenFreeMap](https://openfreemap.org) : instance publique gratuite, sans limite de vues ni clé, attribution obligatoire, aucune garantie de service ; données [OpenStreetMap](https://www.openstreetmap.org/copyright) (ODbL), schéma et styles dérivés d'[OpenMapTiles](https://www.openmaptiles.org/) | OpenFreeMap ; © OpenMapTiles ; Données © contributeurs OpenStreetMap |

Le style gris du Plan IGN ne publie son sprite qu'en une résolution : les fichiers « @2x » demandés par MapLibre sur les écrans à haute densité répondent 404. L'application demande alors le sprite simple (`web/src/basemaps.ts`) : les icônes du fond restent affichées, plus petites sur ces écrans.

La mention des fonds est écrite par l'application à partir de son propre texte, et non insérée telle que la renvoient les serveurs de tuiles (voir SECURITY.md).

## Bibliothèques livrées avec le site

| Bibliothèque | Version | Licence | Où |
|---|---|---|---|
| [MapLibre GL JS](https://maplibre.org) | 6.11.2 | BSD-3-Clause | fichiers publiés sans modification sous `assets/maplibre-gl-6.11.2/` du site, avec leur `LICENSE.txt` ; feuille de style intégrée au CSS de la carte |

Les autres dépendances npm ne servent qu'au développement et aux tests ; elles ne sont pas livrées aux visiteurs.

## Images et polices

Aucune image ni police externe pour l'instant. L'interface utilise les polices système.
