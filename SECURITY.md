# Sécurité

## Signaler une vulnérabilité

Merci de ne pas ouvrir de ticket public. Utilisez le signalement privé de GitHub : onglet Security du dépôt, puis "Report a vulnerability".

## Périmètre des tests d'intrusion

Les tests de sécurité visent uniquement ce projet : le code du dépôt, son build lancé en local ou dans la CI, et son propre déploiement. Ils ne visent jamais le site ou les serveurs des projets d'origine, ni les API tierces dont le projet lit les données (article 323-1 du Code pénal).

## Mesures en place

| Risque | Mesure |
|---|---|
| Injection de HTML ou de script via des données tierces | ESLint interdit `innerHTML`, `outerHTML`, `insertAdjacentHTML` et `document.write` ; le texte est rendu par `textContent` et des nœuds DOM |
| Chargement de ressources externes, script injecté | CSP en balise meta : uniquement la même origine, aucun script ni style inline, `object-src 'none'`, `base-uri 'none'`, `form-action 'none'` ; vérifiée par un test end-to-end |
| Secrets dans le dépôt | gitleaks sur tout l'historique à chaque PR, sur main et chaque semaine ; fichiers `.env` ignorés par Git |
| Workflow détourné (injection, jeton trop large) | jeton en lecture seule par défaut, `contents: write` seulement pour le job de capture, aucun paramètre libre dans les workflows, aucune donnée d'événement interpolée dans une commande, `persist-credentials: false`, actions épinglées par SHA ; audit par zizmor |
| Capture transformée en téléchargeur générique (SSRF) | liste de sources fixée dans le code, https uniquement, liste d'hôtes autorisés appliquée aussi aux redirections, taille maximale par réponse ; testé en unitaire |
| Dépendances vulnérables | pip-audit et npm audit en CI, Dependabot hebdomadaire |
| Code vulnérable | semgrep (règles par défaut, Python, TypeScript, GitHub Actions, secrets) et bandit |
| Configuration du site servi | OWASP ZAP baseline sur le build local, dans la CI |

## Limites connues

- **En-têtes HTTP** : GitHub Pages n'accepte pas d'en-têtes personnalisés. La CSP passe donc par une balise meta, et la directive `frame-ancestors` n'y est pas prise en compte : le site peut être intégré dans un cadre par un tiers (clickjacking). Le site ne contient ni formulaire ni action sensible, ce qui limite l'impact. Les règles ZAP correspondantes (10020, 10021, 10038) sont ignorées avec leur justification dans `.zap/rules.tsv`.
- **X-Content-Type-Options** : dépend de l'hébergement ; à vérifier sur le déploiement au lot 1b.

## Résultats du lot 1a

Exécution locale du 1er octobre 2026, sur la branche `lot-1a/socle-ci`.

| Contrôle | Résultat |
|---|---|
| gitleaks 8.30.1, historique Git complet de la branche (8 commits) | aucune fuite |
| gitleaks 8.30.1, arborescence de travail | aucune fuite |
| bandit sur `pipeline/src` | aucun problème |
| zizmor 1.30.1, profil le plus strict (pedantic) | aucun problème |
| pip-audit, npm audit | aucune vulnérabilité |
| Tests unitaires anti-SSRF de la capture (schéma, hôte, sous-domaine piège, `file://`, adresse de métadonnées cloud, redirection, taille) | réussis |
| Test end-to-end de la CSP du build | réussi sur Chromium desktop et mobile |

| Non exécuté localement | Raison | Où il tourne |
|---|---|---|
| semgrep | le registre de règles semgrep.dev n'est pas joignable depuis l'espace de développement | CI `security` |
| OWASP ZAP baseline | l'image de ZAP ne peut pas être téléchargée dans l'espace de développement | CI `security` |
| SRI sur les scripts externes | non applicable : aucun script externe | à réévaluer à chaque lot |
| Injection SQL ou NoSQL, limitation de débit, relais ouvert | non applicable : aucune API ni base exposée | lot 5 si un back-end est retenu |
| Validation des paramètres d'URL de partage | non applicable : pas encore de partage par URL | lot 1b |
