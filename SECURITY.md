# Sécurité

## Signaler une vulnérabilité

Merci de ne pas ouvrir de ticket public. Utilisez le signalement privé de GitHub : onglet Security du dépôt, puis "Report a vulnerability".

## Périmètre des tests d'intrusion

Les tests de sécurité visent uniquement ce projet : le code du dépôt, son build lancé en local ou dans la CI, et son propre déploiement. Ils ne visent jamais le site ou les serveurs des projets d'origine, ni les API tierces dont le projet lit les données (article 323-1 du Code pénal).

## Mesures en place

| Risque | Mesure |
|---|---|
| Injection de HTML ou de script via des données tierces | ESLint interdit `innerHTML`, `outerHTML`, `insertAdjacentHTML` et `document.write` ; le texte est rendu par `textContent` et des nœuds DOM |
| Chargement de ressources externes, script injecté | CSP envoyée en en-tête HTTP et répétée en balise meta : uniquement la même origine, aucun script ni style inline, `object-src 'none'`, `base-uri 'none'`, `form-action 'none'` ; vérifiée par des tests end-to-end |
| Intégration dans un cadre par un tiers (clickjacking) | `frame-ancestors 'none'` dans la CSP et `X-Frame-Options: DENY` |
| Autres en-têtes de sécurité | `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy` (caméra, micro, géolocalisation, paiement, etc. désactivés), isolation inter-origines (COOP, COEP, CORP), HSTS ; tous définis dans `web/public/_headers` et vérifiés par un test end-to-end |
| Secrets dans le dépôt | gitleaks sur tout l'historique à chaque PR, sur main et chaque semaine ; fichiers `.env` ignorés par Git |
| Workflow détourné (injection, jeton trop large) | jeton en lecture seule par défaut, `contents: write` seulement pour le job de capture, aucun paramètre libre dans les workflows, aucune donnée d'événement interpolée dans une commande, `persist-credentials: false`, actions épinglées par SHA ; audit par zizmor |
| Capture transformée en téléchargeur générique (SSRF) | liste de sources fixée dans le code, https uniquement, liste d'hôtes autorisés appliquée aussi aux redirections, taille maximale par réponse ; testé en unitaire |
| Dépendances vulnérables ou piégées | pip-audit et npm audit en CI ; Dependabot hebdomadaire avec 7 jours de carence ; `min-release-age=7` dans `web/.npmrc`, qui refuse toute version publiée depuis moins de 7 jours |
| Code vulnérable | semgrep (règles par défaut, Python, TypeScript, GitHub Actions, secrets) et bandit |
| Configuration du site servi | OWASP ZAP baseline dans la CI, sur le build servi par wrangler (moteur local de Cloudflare Workers) avec les mêmes en-têtes qu'en production |

## Hébergement et limites connues

Le site sera servi par Cloudflare Workers en fichiers statiques (déploiement au lot 1b). Ce mode permet de définir de vrais en-têtes HTTP, ce que GitHub Pages ne permet pas.

- **Isolation inter-origines stricte** (`Cross-Origin-Embedder-Policy: require-corp`) : elle convient tant que le site ne charge rien d'un autre domaine. Elle sera réexaminée au lot 1b, quand les tuiles de carte d'autres domaines arriveront.
- **Surcharge de dépendance** : wrangler 4.138.0 fixe `undici` en 7.29.0, version touchée par plusieurs failles corrigées en 7.29.1 (dont GHSA-r53p-7pc4-xj5r et GHSA-w293-vg96-wgc3). Les versions de wrangler qui adoptent le correctif ont moins de 7 jours et sont refusées par `min-release-age`. `web/package.json` force donc `undici` 7.29.1 sous miniflare, version corrective de la même branche publiée depuis plus de 7 jours. La surcharge sera retirée quand une version de wrangler assez ancienne inclura le correctif.
- **Règle ZAP ignorée** : 10049 (analyse informative du cache), avec sa justification dans `.zap/rules.tsv`. Toutes les autres règles font échouer le job.

## Résultats du lot 1a

Exécution locale du 1er octobre 2026, sur la branche `lot-1a/socle-ci`, puis CI GitHub (voir plus bas).

| Contrôle | Résultat |
|---|---|
| gitleaks 8.30.1, historique Git complet de la branche | aucune fuite |
| gitleaks 8.30.1, arborescence de travail | aucune fuite |
| bandit sur `pipeline/src` | aucun problème |
| zizmor 1.30.1, profil le plus strict (pedantic) | aucun problème |
| pip-audit, npm audit (après surcharge d'`undici`) | aucune vulnérabilité |
| Tests unitaires anti-SSRF de la capture (schéma, hôte, sous-domaine piège, `file://`, adresse de métadonnées cloud, redirection, taille) | réussis |
| Tests end-to-end des en-têtes servis par wrangler (CSP, `frame-ancestors`, `nosniff`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, COOP), du 404 et de la non-exposition de `_headers` | réussis sur Chromium desktop et mobile |

Workflow `Security`, run final du 3 octobre 2026 sur le commit `4cf6186` :

| Contrôle | Résultat |
|---|---|
| gitleaks, historique complet | aucune fuite |
| semgrep (règles par défaut, Python, TypeScript, GitHub Actions, secrets) | aucun résultat |
| zizmor | aucun problème |
| OWASP ZAP baseline sur le build servi par wrangler | réussi ; seule alerte : 10049, informative, ignorée avec justification |

Les deux règles semgrep relevées en cours de lot (délai de carence Dependabot, âge minimal des paquets npm) ont été corrigées, et les alertes ZAP d'en-têtes ont disparu avec le passage aux en-têtes de Cloudflare.

| Non exécuté | Raison | Quand |
|---|---|---|
| semgrep et ZAP dans l'espace de développement | le registre de règles semgrep et l'image de ZAP n'y sont pas joignables | couverts par la CI ci-dessus |
| SRI sur les scripts externes | non applicable : aucun script externe | à réévaluer à chaque lot |
| Injection SQL ou NoSQL, limitation de débit, relais ouvert | non applicable : aucune API ni base exposée | lot 5 si un back-end est retenu |
| Validation des paramètres d'URL de partage | non applicable : pas encore de partage par URL | lot 1b |
