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
| Performance, accessibilité, bonnes pratiques | Lighthouse CI | CI `lighthouse` |

Les contrôles de sécurité (gitleaks, semgrep, bandit, zizmor, OWASP ZAP) sont décrits dans [SECURITY.md](SECURITY.md).

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
