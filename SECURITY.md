# Sécurité

## Signaler une vulnérabilité

Merci de ne pas ouvrir de ticket public. Utilisez le signalement privé de GitHub : onglet Security du dépôt, puis "Report a vulnerability".

## Périmètre des tests d'intrusion

Les tests de sécurité visent uniquement ce projet : le code du dépôt, son build lancé en local ou dans la CI, et son propre déploiement. Ils ne visent jamais le site ou les serveurs des projets d'origine, ni les API tierces dont le projet lit les données (article 323-1 du Code pénal).

## Mesures en place

| Risque | Mesure |
|---|---|
| Injection de HTML ou de script via des données tierces | ESLint interdit `innerHTML`, `outerHTML`, `insertAdjacentHTML` et `document.write` ; le texte est rendu par `textContent` et des nœuds DOM ; les fichiers de données sont vérifiés champ par champ dans le navigateur (`web/src/data.ts`) : entrée mal formée écartée et comptée, texte nettoyé et raccourci, taille et nombre d'entités plafonnés ; testé en unitaire et en end-to-end avec des noms piégés (`<img onerror>`, `<script>`) |
| Chargement de ressources externes, script injecté | CSP envoyée en en-tête HTTP et répétée en balise meta, identiques à `frame-ancestors` près (vérifié par un test end-to-end) : scripts, styles, polices et worker de la même origine seulement, aucun script ni style inline, `object-src 'none'`, `base-uri 'none'`, `form-action 'none'` ; connexions limitées au site et aux deux serveurs de fonds de carte (`data.geopf.fr`, `tiles.openfreemap.org`) ; images de la même origine, `data:` et `blob:` (MapLibre décode certaines tuiles par une URL `blob:` sur les navigateurs sans `createImageBitmap`) |
| Intégration dans un cadre par un tiers (clickjacking) | `frame-ancestors 'none'` dans la CSP et `X-Frame-Options: DENY` |
| Autres en-têtes de sécurité | `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy` (caméra, micro, géolocalisation, paiement, etc. désactivés), isolation inter-origines (COOP, COEP, CORP), HSTS ; tous définis dans `web/public/_headers` et vérifiés par un test end-to-end |
| Secrets dans le dépôt | gitleaks sur tout l'historique à chaque PR, sur main et chaque semaine ; fichiers `.env` ignorés par Git |
| Workflow détourné (injection, jeton trop large) | jeton en lecture seule par défaut, `contents: write` seulement pour le job de capture, secrets Cloudflare seulement dans le job de déploiement, aucun paramètre libre dans les workflows, aucune donnée d'événement interpolée dans une commande, `persist-credentials: false`, actions épinglées par SHA ; audit par zizmor |
| Collecte détournée vers une autre cible (SSRF) | toutes les URL sont construites dans `sources.py` à partir de constantes, liste blanche de 4 hôtes dérivée de ces constantes, https uniquement, liste blanche appliquée aussi aux redirections, statut HTTP 200 exigé, taille maximale par réponse ; testé en unitaire pour la capture et la construction des données |
| Données tierces malformées ou piégées | lignes FIRMS invalides comptées et écartées, jamais devinées ; page d'erreur HTML à la place d'un CSV refusée ; couche EFFIS deux fois plus pauvre que la précédente refusée ; coordonnées et nombres validés avant écriture |
| Texte HTML renvoyé par les serveurs de tuiles | le contrôle d'attribution de MapLibre est désactivé : il insère tel quel le HTML d'attribution des serveurs ; la mention des fonds est écrite par l'application à partir de son propre texte (`web/src/basemaps.ts`) |
| Adresse de partage piégée | l'état partagé (position, fond, instant, foyer, couche) est dans le fragment de l'URL, jamais envoyé au serveur ; chaque valeur doit correspondre à un motif strict et à une plage, sinon elle est ignorée, jamais recopiée dans la page ; fragment de plus de 300 caractères ignoré ; testé en unitaire et en end-to-end (`javascript:`, balises, nombres hors plage) |
| Worker chargé depuis une URL `blob:` | le worker de MapLibre est un fichier du site, chargé depuis le même dossier que la bibliothèque : `worker-src 'self'` suffit |
| Dépendances vulnérables ou piégées | pip-audit et npm audit en CI ; Dependabot hebdomadaire avec 7 jours de carence ; `min-release-age=7` dans `web/.npmrc`, qui empêche npm de choisir une version publiée depuis moins de 7 jours quand il résout les dépendances (`npm ci` installe ensuite `package-lock.json` tel quel, voir plus bas) ; `PIP_UPLOADED_PRIOR_TO=P7D` dans les quatre workflows, qui fait de même pour pip (pip 26.2.1 installé en premier, les versions antérieures à 26.0 ignorant ce réglage) |
| Code vulnérable | semgrep (règles par défaut, Python, TypeScript, GitHub Actions, secrets) et bandit |
| Configuration du site servi | OWASP ZAP baseline dans la CI, sur le build servi par wrangler (moteur local de Cloudflare Workers) avec les mêmes en-têtes qu'en production ; après chaque déploiement, vérification du site déployé (en-têtes de sécurité, données servies, 404 pour les chemins inconnus et le fichier `_headers`) ; ZAP baseline sur le site déployé chaque semaine et à la demande |
| Identifiants de déploiement | jeton d'API Cloudflare du modèle « Edit Cloudflare Workers », valable un an, et identifiant de compte, stockés comme secrets de l'environnement GitHub `production`, qui n'accepte que la branche `main` ; le pipeline et l'outillage npm tournent dans un job sans aucun secret ; le job de déploiement, sur une autre machine, installe les dépendances sans exécuter leurs scripts d'installation, et ne transmet les identifiants qu'à l'étape `wrangler deploy` ; aucun secret dans le dépôt. Wrangler, et les modules qu'il charge, reçoivent le jeton : c'est le seul outil auquel il est confié. |
| Déclencheur des mises à jour | Worker Cloudflare distinct du site (`web/trigger/`), sans adresse publique ni gestionnaire de requêtes : il ne fait qu'appeler l'API de GitHub à heure fixe pour lancer Deploy sur `main` ; son jeton GitHub à accès fin est limité à ce dépôt et à la permission « Actions » en écriture (plus la lecture des métadonnées, imposée par GitHub), avec une expiration à un an ; il est stocké comme secret du Worker chez Cloudflare, ni dans les secrets GitHub ni dans le dépôt, et n'apparaît jamais dans les messages d'erreur (testé). Avec ce jeton, un tiers pourrait notamment lancer, annuler, relancer ou désactiver les workflows de ce dépôt et supprimer leurs runs, journaux et artefacts, mais pas modifier le code ni lire les secrets. Désactiver Deploy figerait le site ; relancer un ancien run de Deploy (possible pendant 30 jours) redéploierait une version antérieure de `main`. Le jeton d'API Cloudflare de l'environnement `production` permet de redéployer ce Worker avec un autre code, donc de lire ce secret : la protection du jeton GitHub repose aussi sur celle du jeton Cloudflare. |
| Données reprises du déploiement précédent | lues uniquement à l'adresse fixe du site, en HTTPS, 60 Mo au plus par fichier ; un fichier n'est repris que s'il a la forme qu'écrit le pipeline (objet JSON, collection d'entités) ; dans le fichier d'état, seuls les champs connus sont gardés, avec leur type, une date future est ignorée et un message d'erreur est ramené sur une ligne avant d'être écrit dans le journal du workflow ; la page vérifie ensuite chaque entrée comme pour des données fraîches ; testé en unitaire avec des fichiers piégés |

## Hébergement et limites connues

Le site est servi par Cloudflare Workers en fichiers statiques, à l'adresse gratuite du compte (`veille-feux-foret.hamonthibaud.workers.dev`), sans adresse de prévisualisation par version. Ce mode permet de définir de vrais en-têtes HTTP, ce que GitHub Pages ne permet pas.

- **Isolation inter-origines stricte** (`Cross-Origin-Embedder-Policy: require-corp`) : conservée avec les fonds de carte. Les seules requêtes vers d'autres domaines sont celles de MapLibre vers les deux serveurs de fonds, faites avec CORS ; vérifié le 5 octobre 2026 depuis un navigateur que `data.geopf.fr` et `tiles.openfreemap.org` acceptent ces requêtes (style, tuiles, glyphes, sprite). Si l'un d'eux cessait d'envoyer les en-têtes CORS, son fond ne s'afficherait plus et l'interface proposerait l'autre fond.
- **Surcharges de dépendances** : wrangler 4.138.0 fixe `undici` en 7.29.0, version touchée par plusieurs failles corrigées en 7.29.1 (dont GHSA-r53p-7pc4-xj5r et GHSA-w293-vg96-wgc3). Les versions de wrangler qui adoptent le correctif ont moins de 7 jours et sont refusées par `min-release-age`. `web/package.json` force donc `undici` 7.29.1 sous miniflare, version corrective de la même branche publiée depuis plus de 7 jours. La surcharge sera retirée quand une version de wrangler assez ancienne inclura le correctif. De même, miniflare 5.20260925.0-alpha (sous wrangler 4.141.0) fixe `sharp` en 0.35.4, touché par GHSA-wq5f-xc86-pv6w (faille de `librsvg`, sévérité élevée, publiée le 30 septembre 2026, corrigée en 0.35.5) ; `web/package.json` force `sharp` 0.35.5, publié le 27 septembre 2026, donc accepté par `min-release-age`. Seul le moteur local de wrangler (`wrangler dev`, tests end-to-end, scan ZAP) charge `sharp` ; rien n'en est déployé. Cette surcharge sera retirée de la même façon.
- **Fichier `package-lock.json` d'origine** : il a été créé le 1er octobre 2026 à 13 h 54, avant l'ajout de `min-release-age` (17 h 31 le même jour). Il contenait 52 paquets publiés moins de 7 jours avant sa création, le plus récent étant vite 8.3.2, publié le matin même ; ils sont toujours dans le fichier. Les modifications suivantes du fichier, le 1er octobre au soir et par Dependabot le 3 octobre, n'ont ajouté aucun paquet de moins de 7 jours. Vérification du 5 octobre 2026 sur les 294 paquets du fichier : aucun n'est déprécié ni retiré du registre npm, et npm audit ne signale aucune vulnérabilité. Le plus récent atteint 7 jours le 8 octobre 2026.
- **Règle ZAP ignorée** : 10049 (analyse informative du cache), avec sa justification dans `.zap/rules.tsv`. Toutes les autres règles font échouer le job.
- **Règle semgrep exclue** : `python37-compatibility-importlib2`, qui signale que `importlib.resources` demande Python 3.7 ou plus. Le pipeline exige Python 3.11, l'avertissement ne peut donc pas s'appliquer. C'est une règle de compatibilité, pas de sécurité ; la justification est aussi dans `.github/workflows/security.yml`. Toutes les autres règles font échouer le job.

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
| SRI sur les scripts externes | non applicable : aucun script externe, MapLibre est servi par le site lui-même | à réévaluer à chaque lot |
| Injection SQL ou NoSQL, limitation de débit, relais ouvert | non applicable : aucune API ni base exposée | lot 5 si un back-end est retenu |
