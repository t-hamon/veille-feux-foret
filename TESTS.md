# Tests

Ce fichier consigne les tests du projet et les résultats des dernières exécutions réelles. Un test qui n'a pas pu être lancé est listé avec sa raison ; rien n'est indiqué comme réussi sans avoir été exécuté.

## Ce qui est testé

| Catégorie | Outil | Où |
|---|---|---|
| Lint et format Python | ruff | CI `pipeline` |
| Typage Python | mypy (strict) | CI `pipeline` |
| Tests unitaires Python et couverture | pytest, pytest-cov | CI `pipeline` |
| Parseurs et construction des données sur réponses réelles des sources | pytest, fixtures issues du workflow **Capture fixtures** | CI `pipeline` |
| Lint et format TypeScript | ESLint (typescript-eslint strict), Prettier | CI `web` |
| Typage TypeScript | tsc | CI `web` |
| Tests unitaires TypeScript et couverture | Vitest, couverture v8 | CI `web` |
| Build et poids des bundles | Vite, `scripts/bundle-size.mjs` (budget 250 ko JS, 30 ko CSS, gzip) | CI `web` |
| Audit des dépendances | pip-audit, npm audit | CI |
| End-to-end, desktop et mobile | Playwright (Chromium, Firefox, WebKit) | CI `e2e` |
| Accessibilité automatisée | axe-core, WCAG 2.2 AA, thèmes clair et sombre | CI `e2e` |
| Navigation au clavier | Playwright | CI `e2e` |
| Lecture et vérification des fichiers de données dans le navigateur, panneau de situation, frise, adresse de partage | Vitest (jsdom), fichiers écrits par le vrai pipeline (`web/e2e/fixtures/`) | CI `web` |
| Carte, couches, frise, partage, cas dégradés (source en panne, données absentes, anciennes, illisibles, fond de carte hors service), texte piégé | Playwright, données du pipeline, fonds de carte remplacés par un style local | CI `e2e` |
| Concordance des données de test avec le pipeline | pytest (`tools/test_build_web_fixtures.py`) | CI `pipeline` |
| Performance, accessibilité, bonnes pratiques | Lighthouse CI | CI `lighthouse` |
| Déclencheur des mises à jour : appel à l'API de GitHub, secret absent, refus de GitHub, jeton absent des messages | Vitest | CI `web` |

Les contrôles de sécurité (gitleaks, semgrep, bandit, zizmor, OWASP ZAP) sont décrits dans [SECURITY.md](SECURITY.md).

## Résultats du lot 1b : déclencheur des mises à jour

Exécution du 6 octobre 2026 dans l'espace de développement, branche `lot-1b/declencheur`.

Constat de départ : du 5 octobre 2026 à 15 h UTC au 6 octobre à 8 h UTC, 2 des 34 runs planifiés de Deploy ont démarré (21:58 et 02:14 UTC), tous deux réussis. Le 5 octobre au soir, sur la PR n°9, le job end-to-end (run CI 37368444395, deux tentatives) et le job zizmor (run Security 37368444406, première tentative) ont été annulés avec le message « The job was not acquired by Runner of type hosted even after multiple attempts », sans qu'aucune étape ait été exécutée ; la relance du lendemain matin a réussi.

| Test | Résultat |
|---|---|
| Vitest sur `web/trigger/` : adresse, méthode, en-têtes et corps de la demande à GitHub ; secret absent ou vide (aucun appel) ; refus de GitHub avec son explication et sans le jeton ; réponse longue ramenée sur une ligne ; code 200 traité comme un échec ; module principal n'exportant que son gestionnaire ; gestionnaire planifié avec le secret et le `fetch` global (remplacé par une doublure) | 8 tests réussis, couverture 100 % de `web/trigger/` ; au total 62 tests Vitest réussis |
| ESLint, Prettier, tsc (dont `tsconfig.trigger.json`) | aucun problème |
| `wrangler deploy --dry-run` avec `web/trigger/wrangler.jsonc`, ajouté au job `web` de la CI | Worker de 1,4 Kio, aucune liaison |
| Worker exécuté par `wrangler dev --test-scheduled` (moteur local de Cloudflare), tâche planifiée déclenchée, faux jeton | demande reçue par l'API de GitHub, refusée en HTTP 401 « Bad credentials » ; l'échec est signalé sur une ligne, sans le jeton |
| zizmor sur les 5 workflows, dont `trigger.yml` en profil le plus strict | aucun résultat |

Le premier essai dans le moteur local a révélé un défaut que les tests unitaires ne voyaient pas : le module principal d'un Worker ne peut exporter que ses gestionnaires. La logique est passée dans `web/trigger/dispatch.ts`.

Une relecture indépendante a relevé d'autres défauts, corrigés avant la livraison : journaux du Worker désactivés par wrangler à chaque déploiement faute de réglage (un jeton expiré serait passé inaperçu), appel prévu à 0 et 30 minutes, heures les plus chargées de GitHub, aucun contrôle automatique des exports du Worker ni de sa configuration, portée du jeton sous-estimée dans SECURITY.md, type de la variable chez Cloudflare non précisé.

| Non exécuté | Raison | Quand |
|---|---|---|
| Déploiement du Worker et de sa tâche planifiée | nécessite les identifiants Cloudflare, disponibles seulement dans l'environnement `production` | à la fusion, par le workflow **Deploy trigger** |
| Lancement réel de Deploy par le Worker | nécessite le jeton GitHub, créé par le mainteneur après le déploiement du Worker | résultats consignés après les premiers runs lancés par le déclencheur |

## Résultats du lot 1b, partie 2 : carte

Exécution du 5 octobre 2026 dans l'espace de développement, branche `lot-1b/carte`, Node.js 24.21, Python 3.11. Firefox et WebKit ne peuvent pas y être installés : ces deux moteurs sont testés par la CI.

| Test | Résultat |
|---|---|
| Prettier, ESLint (typescript-eslint strict), tsc | aucun problème |
| Vitest | 54 tests réussis |
| Couverture | `data.ts` 98 % des lignes, `share.ts` 97 %, `status.ts` 93 %, `timeline.ts`, `format.ts` et `ui.ts` 100 %. `main.ts`, `map.ts` et `maplibre.ts` (branchement au DOM et à MapLibre) ne sont couverts que par les tests end-to-end. |
| Build et poids (gzip) | page 10,4 kB de JS et 2,2 kB de CSS ; code de la carte 2,9 kB de JS et 10,2 kB de CSS ; MapLibre 297,4 kB (budget 320 kB), chargé après le premier affichage |
| npm audit | 0 vulnérabilité |
| Playwright, Chromium desktop et mobile (Pixel 7), build servi par wrangler | 73 scénarios réussis, 1 ignoré volontairement (navigation clavier sur mobile) ; même résultat sur une seconde exécution complète |
| axe-core WCAG 2.2 AA, page chargée avec un foyer choisi, thèmes clair et sombre | aucune violation (inclus dans les scénarios ci-dessus) |
| Lighthouse, une exécution sur le build avec les données de test | performance 100, accessibilité 100, bonnes pratiques 96, SEO 100 ; la seule erreur relevée est l'échec de chargement du fond de carte, dont le serveur n'est pas joignable depuis l'espace de développement |
| Outils : ruff, mypy strict, pytest (dont la concordance des données de test avec le pipeline) | aucun problème, 7 tests réussis |
| Pipeline (ajout du marqueur de typage `py.typed`) : ruff, mypy, pytest, bandit | aucun problème, 106 tests réussis |
| zizmor sur les workflows | aucun résultat |

Poste Windows du mainteneur, 5 octobre 2026, build servi par wrangler : Playwright sur les 5 profils (Chromium, Firefox et WebKit, desktop et mobile), 182 scénarios réussis, 3 ignorés volontairement (navigation clavier sur les profils mobiles et WebKit). Les captures d'écran de `docs/captures/lot-1b/` ont été prises sur ce poste avec `npm run captures`, avec les vrais fonds de carte.

Première CI de la PR : deux échecs. semgrep signalait une expression régulière construite à partir d'une variable dans un test end-to-end (`detect-non-literal-regexp`) : les boutons des foyers y sont maintenant désignés par leur attribut `data-foyer`. Lighthouse a échoué sans que le seuil en cause soit lisible hors du journal du job : ses résultats sont désormais publiés en annotations, comme ceux de semgrep et de ZAP.

Deuxième CI : les annotations montrent que seul le score de performance manque son seuil (0,64 à 0,70 sur trois passages, pour 0,9 demandé), à cause du temps de blocage du fil principal : 3,6 à 4,9 s, avec 5,4 à 8 s de travail sur ce fil. L'affichage, lui, reste rapide : premier contenu et plus grand contenu en 0,9 à 1,1 s, aucun décalage de mise en page ; accessibilité, bonnes pratiques et SEO à 1. Ce blocage vient du dessin de la carte WebGL, que le runner de la CI, sans carte graphique et avec un processeur ralenti 4 fois pour simuler un téléphone, exécute en logiciel ; il n'a pas pu être mesuré dans l'espace de développement, qui n'atteint pas les serveurs de fonds de carte. Deux mesures en découlent :

- le rendu de la carte est allégé : plus d'animation de fondu des étiquettes (chaque fondu redessine la carte pendant 300 ms), et au plus deux pixels physiques par pixel CSS ;
- les seuils de Lighthouse portent sur des mesures fiables, bloquantes : premier contenu sous 1,8 s, plus grand contenu sous 2,5 s, décalage de mise en page sous 0,1, accessibilité 0,95 et bonnes pratiques 0,9. Le score de performance (0,9) et le temps de blocage (600 ms) ne déclenchent plus qu'un avertissement ; leurs valeurs sont publiées en annotations à chaque passage. Choix validé par le mainteneur.

Les tests end-to-end n'interrogent aucun serveur tiers : chaque scénario échoue si la page tente de joindre un autre hôte que le build local et les deux serveurs de fonds de carte, eux-mêmes remplacés par un style local. Le scénario de clic sur la carte et celui du fond hors service demandent WebGL 2 ; ils sont ignorés, avec leur raison, sur un navigateur qui ne l'a pas.

Une relecture indépendante de la branche a relevé des défauts, tous corrigés et couverts par un test avant la livraison : réglages de la carte ignorés tant que les données n'étaient pas arrivées, frise figée et mentions fausses après l'échec d'un changement de fond, focus perdu au choix d'un foyer au clavier, panneau d'état relu toutes les minutes par les lecteurs d'écran, cercle de sélection affiché avant l'apparition du foyer, surfaces brûlées écartées sans être comptées, taille d'un fichier vérifiée seulement après son téléchargement.

Vérifications faites hors des tests automatisés, depuis un navigateur, le 5 octobre 2026 : `data.geopf.fr` et `tiles.openfreemap.org` répondent aux requêtes CORS de MapLibre (style, tuiles, glyphes, sprite) ; le sprite « @2x » du Plan IGN gris répond 404, d'où le recours au sprite simple.

### Intégration continue de la partie 2 (GitHub Actions, Linux)

Run final du 5 octobre 2026 sur le commit `8980eee`, fusionné dans `main` (PR #6) :

| Job | Résultat |
|---|---|
| Pipeline (Python), Web (lint, types, tests unitaires, build, budget de poids, npm audit) | réussis |
| End-to-end, 5 profils (Chromium, Firefox, WebKit, desktop et mobile) | 179 réussis, 6 ignorés : 3 volontairement (clavier sur mobile et WebKit), 3 scénarios qui demandent WebGL 2, absent sur un des profils de la CI ; le rapport de la CI ne dit pas lequel. Ces 3 scénarios passent sur les 5 profils du poste Windows. |
| Lighthouse, 3 passages | seuils bloquants tenus : premier contenu 0,9 à 1,0 s, plus grand contenu 1,0 à 1,3 s, décalage 0, accessibilité, bonnes pratiques et SEO à 1. Avertissements : performance 0,68 à 0,70, temps de blocage 3,2 à 5,2 s |
| gitleaks, semgrep, zizmor | aucun résultat |
| OWASP ZAP baseline | réussi ; seule alerte : 10049, informative, ignorée avec justification |

L'allègement du rendu de la carte n'a pas réduit le temps de blocage mesuré par la CI (3,6 à 4,9 s avant, 3,2 à 5,2 s après). Il sera mesuré sur le site déployé.

## Résultats du lot 1b, partie 3 : mise à jour et déploiement

Exécution du 5 octobre 2026 dans l'espace de développement, branche `lot-1b/deploiement`. Le déploiement lui-même ne peut être exercé que par le workflow, sur `main` : ses résultats seront consignés après le premier run.

Une relecture indépendante du workflow a relevé des défauts, corrigés avant la livraison : jeton Cloudflare présent sur la même machine que l'outillage npm (le workflow est désormais en deux jobs), fichier précédent mal formé qui bloquait toutes les constructions suivantes, date future qui figeait une source, message d'erreur repris sans contrôle dans le journal, délais cumulés des sources supérieurs à la durée du job, documentation inexacte sur quelques points.

| Test | Résultat |
|---|---|
| `tools/check_deployment.py` : déploiement correct, données anciennes encore servies, en-têtes manquants ou affaiblis, fichier `_headers` exposé, repli vers `index.html`, fichier d'état illisible, site injoignable, HTTP refusé | 8 tests réussis ; les en-têtes attendus sont relus dans `web/public/_headers` |
| Annotation de l'état des sources (`tools/ci_annotations.py status`) | test réussi |
| Outils : ruff, mypy strict, pytest | aucun problème, 18 tests réussis |
| Pipeline : construction face à des fichiers précédents piégés (surface brûlée `null`, date de mise à jour en 2099, détections illisibles, message d'erreur sur plusieurs lignes) | 4 nouveaux tests réussis ; au total ruff, mypy, 110 tests, couverture 97 % |
| zizmor sur les 4 workflows, dont `deploy.yml` en deux jobs | aucun résultat |
| `wrangler deploy --dry-run` avec la configuration du dépôt, dépendances installées avec `npm ci --ignore-scripts` comme dans le job de déploiement | configuration lue, fichiers du build listés, aucune liaison |
| Build servi par wrangler avec les données réelles du 5 octobre (`dist/data`) | `etat.json` servi avec `Cache-Control: no-cache` et la politique de sécurité ; `_headers` en 404 ; la page affiche 5 foyers et 41 détections ; les 4 316 surfaces brûlées se chargent en 0,3 s, aucune écartée ; aucune erreur dans la console |
| Vitest, Playwright Chromium desktop et mobile | 54 tests réussis ; 73 scénarios réussis, 1 ignoré volontairement |

CI de la PR n°7 sur GitHub : tous les contrôles réussis ; end-to-end 179 scénarios réussis, 6 ignorés volontairement ; Lighthouse réussi avec des avertissements sur le score de performance et le temps de blocage, qui ne bloquent pas (voir la partie 2).

### Premier déploiement

Run Deploy n°1 du 5 octobre 2026, déclenché par la fusion de la PR n°7 (commit `cb63c52`) :

| Étape | Résultat |
|---|---|
| Construction des données et du site | réussie ; 7 sources sur 7 ont répondu, données générées à 14:52:49Z |
| `wrangler deploy` | réussi |
| Vérification du site déployé (`tools/check_deployment.py`) | échec : HTTP 403 sur les quatre adresses vérifiées, pendant les 2 minutes d'essais |

Le même jour à 17 h 47 (heure de Paris), depuis un navigateur, le site déployé répondait correctement : page en 200 avec tous les en-têtes de `web/public/_headers`, `/data/etat.json` en 200 avec `Cache-Control: no-cache` et les données générées à 14:52:49Z, `/nexiste-pas` et `/_headers` en 404. Seules les requêtes du script étaient refusées. Cause probable, à confirmer par le prochain run : Cloudflare refuse l'identifiant de navigateur par défaut de Python (`Python-urllib`).

Correction : le script envoie son propre identifiant (`veille-feux-foret-deploy-check`), et une réponse inattendue est désormais décrite dans l'annotation (en-têtes `server`, `cf-ray`, `cf-mitigated`, `content-type` et début du corps, sur une ligne) ; un fichier précédent illisible est signalé par une annotation dans le job de construction.

| Test | Résultat |
|---|---|
| `tools/check_deployment.py` : identifiant envoyé, refus décrit avec ses en-têtes et son corps, corps d'une erreur HTTP conservé, extrait ramené sur une ligne courte, annotation échappée | 5 nouveaux tests réussis, qui échouent avec le script précédent ; au total ruff, mypy strict, 23 tests réussis |
| Requêtes réelles du script vers les pages du dépôt sur GitHub (404 et 200) | statut, en-têtes et début du corps lus correctement |

Run Deploy n°2 du 5 octobre 2026, déclenché par la fusion de la PR n°8 (commit `eeb8591`) :

| Étape | Résultat |
|---|---|
| Construction des données et du site | réussie en 29 s ; 7 sources sur 7 ont répondu, données générées à 17:28:58Z ; les 6 fichiers du déploiement précédent relus (aucune annotation de fichier illisible) |
| `wrangler deploy` puis vérification du site déployé | réussis en 28 s : avec son propre identifiant, le script n'est plus refusé, ce qui confirme la cause |

Vérification depuis un navigateur juste après, à 19 h 33 (heure de Paris) : fichier d'état généré à 17:28:58Z, 24 foyers listés, fond Plan IGN gris affiché avec les foyers et les détections, mentions des sources sous la carte et plus de pied de page, toutes les ressources de la page et du fond de carte en 200.

## Résultats du lot 1b, partie 1 : données

Exécution du 3 octobre 2026 dans l'espace de développement, branche `lot-1b/donnees`, Python 3.11.

| Test | Résultat |
|---|---|
| ruff, mypy strict (pipeline et outils) | aucun problème |
| pytest | 106 tests réussis, couverture 97 % |
| Chaque commit de la branche pris isolément : ruff, mypy, pytest | réussi pour chacun des 11 premiers commits ; le 12e, ajouté après la première CI, ne touche que le workflow de sécurité et SECURITY.md (voir plus bas) |
| bandit | aucun problème |
| pip-audit, environnement contenant uniquement les dépendances du projet | aucune vulnérabilité connue |
| Installation non éditable du paquet (celle du workflow de capture) | les 3 fichiers de données et les 2 commandes sont présents |
| Reproductibilité des fichiers générés (`tools/extract_effis_fixtures.py`, `tools/build_neighbours.py`) | fichiers identiques octet pour octet à une seconde exécution |
| gitleaks, historique complet | aucune fuite |

Mesures sur la capture réelle du 3 octobre 2026, 11 h 28 UTC :

| Étape | Résultat |
|---|---|
| Détections FIRMS en Europe sur 24 h | 3 837, toutes lues sans erreur |
| Dans la métropole | 143 |
| Écartées comme sites industriels | 97 (Fos-sur-Mer, Dunkerque, Florange, cimenteries, raffineries) |
| Détections conservées, foyers | 46 détections, 7 foyers |
| Surfaces brûlées EFFIS datées, françaises | 1 689 sur 3 086 ; 6 écartées car de surface nulle selon EFFIS |
| Surfaces brûlées EFFIS récentes touchant la France | 2 626 sur 5 073 |
| Bilan de la saison | 97 971 ha, moyenne depuis 2006 : 14 198 ha |
| Durée de la commande sur la capture complète | 16 s |
| Poids des fichiers produits, compressés | moins de 400 Kio, dont 383 Kio de surfaces brûlées |

Ces mesures ont été obtenues en servant les fichiers capturés à la commande à la place des sources. La collecte réelle depuis les serveurs sera exercée par le workflow de déploiement (partie 3 du lot).

### Intégration continue (GitHub Actions, Linux)

Le premier passage, sur le commit `05363b0`, a échoué sur semgrep : la règle `python37-compatibility-importlib2` signalait que `importlib.resources` demande Python 3.7 ou plus, alors que le pipeline exige Python 3.11. La règle est exclue par son identifiant (voir SECURITY.md) ; vérification locale avec semgrep 1.178.0 : le scan échoue sans l'exclusion et passe avec.

Run final du 5 octobre 2026 sur le commit `07112b1`, fusionné dans `main` (PR #3) :

| Job | Résultat |
|---|---|
| Pipeline (Python) : ruff, mypy, pytest, bandit, pip-audit, outils CI | réussi |
| Web : Prettier, ESLint, tsc, Vitest, build, budget de poids, npm audit | réussi |
| End-to-end, 5 profils (Chromium, Firefox, WebKit, desktop et mobile) | 52 réussis, 3 ignorés volontairement, en 32 secondes |
| Lighthouse CI | seuils atteints |
| gitleaks, semgrep, zizmor | aucun résultat |
| OWASP ZAP baseline | réussi ; seule alerte : 10049, informative, ignorée avec justification |

### Deuxième capture réelle, 5 octobre 2026

Le workflow **Capture fixtures** a été relancé après la fusion (run 37297343469, 10 h 33 UTC) : les 8 sources ont répondu, dont la recherche de commune de geo.api.gouv.fr, interrogée pour la première fois depuis la CI (réponse : Aix-en-Provence, code 13001, pour le point d'essai). La licence enregistrée dans le manifeste est celle vérifiée dans la PR #3.

La commande de construction a été rejouée dans l'espace de développement sur cette capture, de la même façon que sur la première : fichiers capturés servis à la place des sources, flux FIRMS de 24 h servis à la place des flux de 7 jours.

| Étape | Résultat |
|---|---|
| Détections FIRMS en Europe sur 24 h | 6 311, toutes lues sans erreur |
| Dans la métropole | 193 |
| Écartées comme sites industriels | 152 (Dunkerque, Fos-sur-Mer, raffineries, cimenteries, Florange) |
| Détections conservées, foyers | 41 détections, 5 foyers |
| Surfaces brûlées EFFIS datées, françaises | 1 690 sur 3 103 ; 6 écartées car de surface nulle selon EFFIS |
| Surfaces brûlées EFFIS récentes touchant la France | 2 626 sur 5 081 |
| Bilan de la saison | 97 971 ha, moyenne depuis 2006 : 14 198 ha, dernière semaine comptée : 30 septembre |
| Durée de la commande | 12,5 s |
| Poids des fichiers produits, compressés | 388 Kio, dont 386 Kio de surfaces brûlées |

Limite constatée : 4 des 5 foyers sont à moins de 0,5 km d'un foyer de la capture du 3 octobre. Une chaleur détectée au même endroit à deux jours d'intervalle évoque une source permanente plutôt qu'un feu, mais ces sites ne sont pas identifiés à ce stade et aucun n'a été ajouté à la liste des sites industriels sans vérification.

## Résultats du lot 1a

Exécutions du 1er au 3 octobre 2026 sur la branche `lot-1a/socle-ci` : espace de développement, poste Windows du mainteneur et CI GitHub.

### Pipeline Python (Python 3.11)

| Test | Résultat |
|---|---|
| ruff check, ruff format --check | aucun problème |
| mypy --strict sur src et tests | aucun problème (3 fichiers) |
| pytest | 13 tests réussis |
| Couverture | 96 % des instructions de `veille_feux` (lignes non couvertes : ouverture réseau réelle et point d'entrée `__main__`) |
| pip-audit, environnement contenant uniquement les dépendances du projet | aucune vulnérabilité connue |
| pytest sous Windows (Python 3.12.10, poste de développement) | 13 tests réussis, couverture 96 % |

### Application web (Node.js 24.21)

| Test | Résultat |
|---|---|
| Prettier, ESLint, tsc | aucun problème |
| Vitest | 8 tests réussis |
| Couverture | `theme.ts` : 100 % des lignes ; ensemble : 51 % des lignes. `main.ts` (branchement au DOM) n'est couvert que par les tests end-to-end. |
| Build | réussi |
| Poids des bundles (gzip) | JS 0,8 ko, CSS 0,9 ko, sous les budgets |
| npm audit (après surcharge d'`undici`, voir SECURITY.md) | 0 vulnérabilité |
| Playwright, Chromium desktop, build servi par wrangler | 10 scénarios réussis |
| Playwright, Chromium mobile (Pixel 7), build servi par wrangler | 9 scénarios réussis, 1 ignoré volontairement (navigation clavier, sans clavier physique sur un profil mobile) |
| axe-core WCAG 2.2 AA, thèmes clair et sombre | aucune violation (inclus dans les scénarios ci-dessus) |
| Lighthouse CI, 3 passages sur le build | performance 100, accessibilité 100, bonnes pratiques 100, SEO 100 |

### Non exécuté localement

| Test | Raison | Où il tourne |
|---|---|---|
| Playwright sur Firefox et WebKit, dans l'espace de développement | les navigateurs ne peuvent pas y être téléchargés (accès réseau restreint) | CI `e2e` et poste Windows du mainteneur (voir plus haut) |
| Navigation clavier sur WebKit | WebKit ne donne pas le focus aux liens avec Tab sans réglage système ; le scénario est couvert par Chromium et Firefox | non applicable |
| Tests des parseurs sur fixtures réelles | aucun parseur dans ce lot ; les fixtures seront capturées par le workflow dédié | lot 1b |
| Cas dégradés des sources (panne, données vides, réseau lent) | aucune source branchée dans ce lot ; l'enregistrement des pannes par la capture est testé en unitaire | lot 1b |

### Poste de développement Windows

Exécution par le mainteneur le 1er octobre 2026 (Node.js 24.19, Python 3.12.10), avant l'ajout des tests d'en-têtes.

| Test | Résultat |
|---|---|
| pytest | 13 tests réussis, couverture 96 % |
| Vitest | 8 tests réussis |
| Build | réussi |
| Playwright, les 5 profils en parallèle (4 navigateurs simultanés) | Chromium : 15 réussis, 1 ignoré. Firefox et WebKit : 7 réussis, 15 échecs par dépassement de délai ou arrêt brutal du navigateur, 2 ignorés |
| Playwright, Firefox desktop seul, 1 navigateur à la fois | 8 réussis |
| Playwright, WebKit desktop seul, 1 navigateur à la fois | 7 réussis, 1 ignoré (clavier) |
| Playwright, les 5 profils, 1 navigateur à la fois, build servi par wrangler | 46 réussis, 3 ignorés (clavier sur mobile et WebKit), 1 échec : Firefox, thème système sombre (voir ci-dessous) |

Les échecs disparaissent quand les navigateurs tournent un par un, et la CI Linux passe sur les trois moteurs avec les mêmes tests : ils venaient de la charge parallèle sur le poste, pas de l'application. Les exécutions locales utilisent depuis un seul navigateur à la fois par défaut.

L'échec Firefox est apparu quand le build a été servi avec les en-têtes de Cloudflare ; le job end-to-end de la CI a aussi échoué sur ce commit, sans que le test en cause soit connu (journal non lisible). Une expérience sur le poste Windows a isolé la cause, en retirant des en-têtes de la copie construite :

| En-têtes servis | Tests du thème sombre sous Firefox |
|---|---|
| tous | échec : la page reste en clair |
| sans `Cross-Origin-Opener-Policy` ni `Cross-Origin-Embedder-Policy` | réussis |
| sans `Cross-Origin-Embedder-Policy` seulement | échec |

En présence de `Cross-Origin-Opener-Policy`, la simulation du thème posée avant le premier chargement est perdue sous Firefox, qu'elle soit posée sur la page ou sur le contexte du navigateur. L'explication probable, non vérifiée dans le code de Firefox ou de Playwright, est que Firefox charge alors la page dans un nouveau groupe de contextes de navigation. L'en-tête est conservé pour sa valeur de sécurité ; les tests simulent désormais le thème une fois la page chargée, vérifient que la page suit le changement, puis qu'elle démarre dans le bon thème après rechargement. Avec ce correctif, Firefox desktop passe ses 11 scénarios sur le poste Windows, dont les deux tests du thème sombre.

### Intégration continue (GitHub Actions, Linux)

Run final du 3 octobre 2026 sur le commit `4cf6186` :

| Job | Résultat |
|---|---|
| Pipeline (Python) : ruff, mypy, pytest, bandit, pip-audit, outils CI | réussi |
| Web : Prettier, ESLint, tsc, Vitest, build, budget de poids, npm audit | réussi |
| End-to-end dans l'image `mcr.microsoft.com/playwright:v1.63.0-noble`, 5 profils (Chromium, Firefox, WebKit, desktop et mobile), build servi par wrangler | 52 réussis, 3 ignorés volontairement (navigation clavier sur les profils mobiles et WebKit), en 32 secondes |
| Lighthouse CI | seuils atteints (performance et bonnes pratiques 0,9, accessibilité 0,95) |

Avant le passage à l'image Playwright, l'installation des navigateurs sur le runner prenait de 51 secondes à plus de 28 minutes selon les runs ; le job complet prend désormais environ 1 min 20.

Lighthouse a été lancé localement avec `--no-sandbox`, l'espace de développement tournant en root. La CI le lance sans cette option.
