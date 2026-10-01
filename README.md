# veille-feux-foret

Carte citoyenne des feux de forêt en France métropolitaine : situation des foyers, prévision à quelques heures, imagerie et lecture dans le temps.

Outil d'information citoyenne, pas un outil opérationnel ni une source officielle. En cas d'urgence, appelez le 18 ou le 112.

## État du projet

Le projet est construit par lots, chacun livré par une ou plusieurs pull requests testées.

| Lot | Contenu | État |
|---|---|---|
| 1a | Dépôt, intégration continue, contrôles de sécurité, capture de fixtures | en cours |
| 1b | Carte, foyers FIRMS, périmètres EFFIS, frise temporelle, déploiement | à venir |
| 2 | Prévision : vent, météo AROME, propagation | à venir |
| 3 | Imagerie et temps : comparaison, imagerie, relief 3D, fumée | à venir |
| 4 | Situation : score de menace, danger Météo-France, moyens aériens, enjeux exposés | à venir |
| 5 | Fil d'information et archive | à venir |

La démo en ligne, les captures d'écran et la comparaison détaillée avec les projets d'origine arrivent avec le lot 1b, quand la carte existe.

## Architecture

```
pipeline/   Python : collecte et normalisation des sources publiques (GitHub Actions)
web/        Vite + TypeScript : application statique, servie par Cloudflare Workers
fixtures/   échantillons réels des sources, utilisés par les tests
.github/    intégration continue, contrôles de sécurité, capture des fixtures
```

Le pipeline tourne dans GitHub Actions et produit des fichiers statiques que l'application lit. Le site sera servi par Cloudflare Workers en fichiers statiques : les requêtes y sont gratuites et sans plafond, ce qui garde le site disponible lors des pics de consultation pendant les grands feux, et les en-têtes de sécurité sont définis dans `web/public/_headers`. En local, `npm run serve` sert le build avec le même moteur (wrangler) et les mêmes en-têtes. Aucun serveur n'est nécessaire tant que les lots 1 à 4 le permettent ; le besoin d'un back-end sera tranché avant le lot 5.

## Développement

Prérequis : Python 3.11 ou plus, Node.js 24.15 ou plus (version LTS active, maintenue jusqu'en avril 2028). Avec une version plus ancienne, `npm ci` s'arrête avec un message explicite.

Linux, macOS, Git Bash :

```bash
# Pipeline
cd pipeline
python -m venv .venv && . .venv/bin/activate
pip install -e ".[dev]"
ruff check . && mypy src tests && pytest

# Application
cd ../web
npm ci
npm run dev          # serveur de développement
npm run build        # build de production dans web/dist
npm run serve        # sert le build avec le moteur de Cloudflare et ses en-têtes
npm test             # tests unitaires avec couverture
npx playwright install chromium firefox webkit
npm run test:e2e     # tests end-to-end sur le build local
```

Windows PowerShell (une commande par ligne, `&&` n'existe pas dans PowerShell 5.1) :

```powershell
cd pipeline
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -e ".[dev]"
pytest
deactivate
cd ..\web
npm ci
npm test
npm run build
npx playwright install chromium firefox webkit
npm run test:e2e
```

Si PowerShell refuse `Activate.ps1`, lancer d'abord `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass`, qui n'autorise les scripts que pour la fenêtre en cours.

Le détail des tests et de leurs derniers résultats est dans [TESTS.md](TESTS.md), la politique et les contrôles de sécurité dans [SECURITY.md](SECURITY.md).

## Fixtures

Les tests des parseurs utilisent des réponses réelles des sources, capturées par le workflow **Capture fixtures**. Voir [fixtures/README.md](fixtures/README.md).

## Crédits

- [carte-incendies](https://github.com/lgdlcs/feux-france) de Lucas Legrand (lgdlcs) : code d'origine sous licence MIT, réutilisé et modifié.
- [Flamap](https://github.com/rozierguillaume/flamap) de Guillaume Rozier (rozierguillaume) : inspiration fonctionnelle, réimplémentation indépendante, aucun code repris.
- [feux-france](https://github.com/the20100/feux-france) de Vincent (the20100) : inspiration fonctionnelle, réimplémentation indépendante, aucun code repris.

Détail des éléments repris, sources de données et licences : [CREDITS.md](CREDITS.md).

## Limites connues

- La politique d'isolation inter-origines est stricte tant que le site ne charge rien d'un autre domaine ; elle sera adaptée au lot 1b avec les tuiles de carte. Voir [SECURITY.md](SECURITY.md).
- Le déploiement sur Cloudflare arrive avec le lot 1b.

## Licence

MIT, voir [LICENSE](LICENSE). La mention de copyright de carte-incendies est conservée.
