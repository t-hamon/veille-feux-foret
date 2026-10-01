# Tests

Ce fichier consigne les tests du projet et les résultats des dernières exécutions réelles. Un test qui n'a pas pu être lancé est listé avec sa raison ; rien n'est indiqué comme réussi sans avoir été exécuté.

## Ce qui est testé

| Catégorie | Outil | Où |
|---|---|---|
| Lint et format Python | ruff | CI `pipeline` |
| Typage Python | mypy (strict) | CI `pipeline` |
| Tests unitaires Python et couverture | pytest, pytest-cov | CI `pipeline` |
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

## Résultats du lot 1a

Exécution locale du 1er octobre 2026, sur la branche `lot-1a/socle-ci`. Les résultats de la CI GitHub seront ajoutés dans la pull request dès le premier passage.

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

Les échecs disparaissent quand les navigateurs tournent un par un, et la CI Linux passe sur les trois moteurs avec les mêmes tests : ils venaient de la charge parallèle sur le poste, pas de l'application. Les exécutions locales utilisent depuis un seul navigateur à la fois par défaut.

### Intégration continue (GitHub Actions, Linux)

Run du 1er octobre 2026 sur le commit `1f5326f` : pipeline, web, Lighthouse et end-to-end (Chromium, Firefox, WebKit, desktop et mobile) réussis.

Lighthouse a été lancé localement avec `--no-sandbox`, l'espace de développement tournant en root. La CI le lance sans cette option.
