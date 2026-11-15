# Étude de l'option B : affiner la propagation estimée

Étude écrite le 14 novembre 2026 et complétée le 15 novembre 2026 avec la lecture du rapport FWI2025 et la décision (partie 4). Elle ne contient aucun code et ne change rien au site.

Règles suivies :
- chaque affirmation sur une source vient d'une lecture datée (liste en fin de document) ;
- ce qui n'a pas été lu ou pas pu être ouvert est dit comme tel ;
- aucun chiffre n'est proposé s'il ne vient pas d'une source.

## 1. Point de départ

La propagation estimée en ligne depuis la PR n°41 (option A) :
- tête du feu à 3 à 8 % du vent moyen à 10 m prévu par AROME au foyer ;
- ellipse du système canadien FBP (1992, équation 79) ;
- 6 heures après la mise à jour, foyers actifs seulement ;
- toujours sous les données réelles.

Elle ignore l'humidité de la végétation, l'herbe, le relief et la végétation réelle. Elle n'a été comparée à aucun feu français.

J'ai souhaité étudier, sans chiffre inventé ou estimé :
1. l'humidité de la végétation morte et vivante, et si la fourchette de 3 à 8 % peut suivre cette humidité ;
2. l'herbe et la pente, et ce qu'elles changent (sous-estimation ou surestimation) ;
3. l'adaptation à la végétation française (pins, eucalyptus, garrigue et autres) ;
4. un calage sur des feux de forêt documentés, y compris bien avant ce projet ;
5. les pistes de ma conversation avec un autre assistant (Météo des forêts, réseau hydrique ONF et INRAE, BD Forêt, humidité de la végétation vivante), à vérifier uniquement à la source.

## 2. Données déjà disponibles dans le projet

Le pipeline écrit déjà, pour chaque foyer avec une détection dans les 24 dernières heures, les valeurs horaires AROME suivantes (`pipeline/src/veille_feux/meteo.py`) :
- température à 2 m ;
- humidité relative à 2 m ;
- précipitations ;
- vent à 10 m (vitesse, direction, rafales).

La fenêtre couvre 168 heures passées et 60 heures de prévision (`sources.py`). Les heures passées sont des prévisions archivées du modèle, pas des mesures.

Ce sont exactement les quatre entrées du code d'humidité des combustibles fins (FFMC) horaire. Il manque le rayonnement solaire et le taux de dessèchement de l'herbe (« curing »), demandés par les modèles d'herbe (partie 3.3).

## 3. Ce que disent les sources lues

### 3.1 Humidité de la végétation morte

**Cruz et Alexander (2019)**, déjà lu pour l'option A :
- La teneur en eau des combustibles morts fins (« fine dead fuel moisture content », MC) de leurs 118 feux est « estimée par des modèles propres à chaque type de combustible ». Ce n'est pas le FFMC canadien.
- Sous 7,5 % de MC, le biais moyen de la règle reste dans ± 0,5 km/h. Il monte à environ 1 km/h au-dessus de 10 %.
- La combinaison la plus défavorable est un MC au-dessus de 7,5 % avec un vent modéré (30 km/h au plus) : biais moyen de 0,93 km/h, erreur relative moyenne de 122 %, pour une vitesse moyenne observée de 1,05 km/h.
- Conclusion des auteurs : en conditions humides ou limites, la règle peut surestimer nettement.
- **Ils ne donnent aucune fraction du vent par classe d'humidité.** Seule la règle globale de 8 % (pente de régression) est publiée.

**Conséquence pour la fourchette.** Aucune source lue ne relie la fraction du vent (3 %, 8 %) à l'humidité. Faire varier la fourchette selon l'humidité demanderait un chiffre inventé. Ce qui est possible sans invention, c'est de signaler que l'estimation sort du domaine où la règle a été vérifiée (MC au-dessus de 7,5 %) et qu'elle surestime probablement.

**FFMC horaire (Van Wagner 1977)**, lu en entier :
- Il donne l'humidité des combustibles fins heure par heure, à partir de la température, de l'humidité relative, du vent et de la pluie.
- Il utilise l'ancienne échelle F (constante 205,2) et un taux de séchage horaire de 0,0579.
- Sa routine de pluie renvoie au rapport PS-X-58 (1975), introuvable de mon côté.
- Tableau 3 : en partant de la saturation, le FFMC horaire atteint son équilibre en 3 à 11 jours selon le cycle météo. 11 jours pour le cycle humide de juillet et août, 3 à 5 jours pour les quatre autres. Mes 168 heures (7 jours) d'historique couvrent donc 4 cycles sur 5.

**FFMC journalier (Forestry Technical Report 33, 1985)**, lu en entier :
- Il remplace l'ancienne échelle par la nouvelle : m = 147,2 (101 - F) / (59,5 + F).
- Sa routine de pluie est journalière : seule la pluie au-delà de 0,5 mm compte, avec la formule de mouillage en 42,5, 251 et 6,93.
- Il donne les valeurs de départ standard : FFMC 85, DMC 6, DC 15.

**FWI2025 : rapport d'information GLC-X-42 (Service canadien des forêts, 2025)**, lu en entier le 15 novembre 2026 :
- Le FFMC horaire reprend Van Wagner 1977, modifié (page 18). Un FFMC de 91 dans l'ancien système doit correspondre à environ 91 dans le nouveau.
- **Séchage deux fois plus rapide** (page 19) : des mesures de terrain montrent que le séchage du FFMC est trop lent (Beck et Armitage 2004, Wotton 2007, Anderson 1990, Nelson 2001, Van Wagner 1979). Le temps de réponse est donc divisé par deux. Les figures 7 et 8 comparent les versions à des prélèvements de combustibles fins (expériences ICFME, Territoires du Nord-Ouest, 1999).
- **Pluie** (page 18) : les 0,5 premiers mm d'un épisode de pluie sont interceptés par le couvert, en cumul sur l'épisode. Après six heures sans pluie, le couvert est supposé sec et le seuil s'applique de nouveau. La part de pluie absorbée par la litière (environ 5 %) est conservée.
- **Classes** (tableau 1, page 34) : FFMC de 90 à 92 « très élevé », 93 et plus « extrême », fondées sur l'inflammation avec flammes durables. Ces classes sont proposées pour un type générique de forêt de conifères au Canada.
- **Météo de modèle** (annexe C-1, page 47) : une sortie de modèle météo représente une moyenne sur sa maille, pas une mesure ponctuelle. Son biais doit être évalué, surtout en période sèche.
- **Démarrage** (annexe C, pages 48 et 50) : la valeur de départ 85 correspond à trois jours de séchage depuis la saturation. La couche du FFMC ne retient qu'environ 0,6 mm d'eau ; une erreur de départ disparaît assez vite.
- **Autres combustibles** (partie 5.2, page 33) : le système FBP donne des méthodes d'humidité selon le couvert du sol et la fermeture du couvert ; elles seront affinées dans un futur système d'humidité des combustibles.
- **Évolutions annoncées** (partie 6, page 35) : séchage tenant compte du rayonnement solaire, révision de la pluie efficace.
- **Licence** (page iv) : reproduction autorisée à des fins non commerciales, avec le titre complet et le nom de l'organisme. Je cite, je ne reproduis pas.

**FWI2025 : code cffdrs-ng (licence MPL-2.0)**, code Python lu, rien repris :
- FFMC horaire sur l'échelle de 1985, avec un taux de séchage de 0,1158 au lieu de 0,0579 : c'est le doublement annoncé par GLC-X-42.
- Pluie : la même formule de mouillage que le rapport de 1985, appliquée heure par heure, avec l'interception de 0,5 mm.
- **Écart tranché le 15 novembre 2026 :** le code remet le seuil d'interception à zéro à la cinquième heure sèche consécutive, le rapport parle de six heures sans pluie ; la comparaison sur le jeu d'essai de cffdrs-ng confirme l'écart. J'ai retenu le rapport (six heures).
- Le README du dépôt précise que le FWI2025 ne doit pas servir d'entrée au système FBP. Cela ne gêne pas un simple signalement d'humidité, qui n'utilise pas FBP.

**Seuils équivalents.** Avec la formule de 1985 :
- MC 7,5 % correspond à un FFMC d'environ 93,3 ;
- MC 10 % correspond à un FFMC d'environ 90,8.

Ce passage est une approximation : Cruz et Alexander n'ont pas utilisé le FFMC, mais des modèles propres à chaque combustible. Il faudrait l'écrire tel quel. Le seuil de 93,3 tombe au début de la classe « extrême » du tableau 1 de GLC-X-42 ; ce sont deux sources distinctes, et ces classes sont canadiennes.

### 3.2 Humidité de la végétation vivante

- **Jeu de données LFMC du réseau hydrique** (Mission zonale DFCI de l'ONF et DPFM, métadonnées INRA ; zenodo 10.5281/zenodo.162978) :
  - mesures hebdomadaires en été, de 1996 à 2016, 584 années-sites ;
  - aucune licence déclarée (« Other restrictions ») : réutilisation à demander aux auteurs ;
  - données ponctuelles et passées : rien pour l'heure et le lieu d'un foyer actif.
- **Météo des forêts** (Météo-France) :
  - l'API donne un niveau de danger par département pour J+1 et J+2, à partir des prévisions météo et de l'état de sécheresse de la végétation ;
  - compte nécessaire, 100 requêtes par minute ;
  - licence de l'API non indiquée sur data.gouv ; archives depuis le 3 juin 2024 sous Licence Ouverte ;
  - c'est un niveau de danger départemental, pas une humidité au foyer. La documentation détaillée de l'API n'a pas été lue.
- **Coefficients Sentinel-2 de ma conversation avec un autre assistant** :
  - la table donne des fourchettes de coefficients (a, b, c, d) par peuplement, sans référence vérifiable ;
  - les articles cités (Liu et al. 2026, Baehr et al. 2026) n'ont pas été retrouvés ;
  - **écartés** : aucun chiffre sans source.
- **Sauvagnargues-Lesage et al. (2001)** : lors des brûlages de Lozère, l'humidité de la végétation vivante variait peu, alors que celle des combustibles morts allait de 6 à 18,5 % et suivait l'humidité de l'air (r² = 0,81).

**Bilan :** aucune source ouverte trouvée ne donne l'humidité de la végétation vivante à l'heure et au lieu d'un foyer.

### 3.3 Herbe

- **Cruz et Alexander (2019)** :
  - sur 23 feux de prairie australienne (Cheney et al. 1998), avec une humidité moyenne de 3,5 %, le feu avance à environ 25 % du vent ;
  - la règle « ne devrait pas être appliquée aux prairies ouvertes ».
  - Sur l'herbe sèche, ma fourchette sous-estime donc fortement, d'un facteur 3 environ par rapport à 8 %.
- **Modèles d'herbe** : FBP O-1 (1992) et la propagation dans l'herbe du FWI2025 (Cheney 1998 et code CSIRO) demandent le taux de dessèchement de l'herbe. Le FWI2025 demande aussi le rayonnement solaire. Aucune source française de taux de dessèchement n'a été cherchée ni trouvée à ce stade.
- **GLC-X-42 sur l'herbe** (pages 13 à 26) :
  - le code d'humidité de l'herbe (GFMC, Wotton 2009) est une humidité « effective » qui tient compte de la part d'herbe verte ;
  - l'herbe sèche réagit en bien moins d'une heure, alors que le FFMC suit une litière sous couvert ;
  - rayonnement solaire : mesuré, tiré d'un modèle météo, ou estimé à partir du lieu, de la température et de l'humidité ;
  - dessèchement : observation locale, indice de verdure par satellite (par exemple un NDVI relatif, à recaler localement), ou courbe saisonnière par défaut du centre du Canada, jugée « très grossière » ;
  - les seuils de classes pour l'herbe ne sont pas encore validés.
- **Repérer l'herbe** autour d'un foyer est possible avec une carte de végétation (partie 3.5).

### 3.4 Pente

- **FBP (1992)** :
  - facteur de pente SF = exp(3,533 (GS/100)^1,2), avec GS la pente en %, non appliqué au-delà de 60 % ;
  - mais FBP ne multiplie pas simplement la vitesse par SF : la pente est convertie en vent équivalent, avec les équations propres à chaque type de combustible ;
  - appliquer SF à ma règle du vent s'écarterait de la source.
- **Cruz et Alexander (2019)** :
  - la règle convient aux terrains plats ou faiblement ondulés ;
  - elle peut convenir aux feux qui traversent plusieurs vallons, montées et descentes se compensant en moyenne.
  - En montée franche, elle sous-estime ; en descente franche, elle surestime. Aucun chiffre n'est publié pour ma règle.
- **Relief** : le RGE ALTI de l'IGN (modèle numérique de terrain au pas de 1 m et 5 m) figure parmi les données libres et gratuites de l'IGN (communiqué de 2021). Le catalogue Earth Engine indique la licence etalab-2.0. La page officielle de l'IGN (cartes.gouv.fr) n'a pas pu être ouverte depuis l'espace de développement : licence à confirmer à la source avant usage.
- Pour une estimation à l'échelle du kilomètre, un pas fin n'est pas nécessaire. Le choix du pas et le volume à télécharger restent à étudier.

**Pente, exposition et humidité** (ma remarque, 15 novembre 2026). La pente et l'altitude jouent aussi sur l'humidité de la végétation. État des connaissances dans ce qui a été lu :
- aucune source lue ne corrige l'humidité des combustibles selon la pente, l'exposition ou l'altitude ;
- le FWI2025 ne le fait pas encore : il annonce un futur séchage tenant compte du rayonnement solaire (GLC-X-42, partie 6) ;
- AROME donne une température et une humidité moyennes sur sa maille (GLC-X-42, annexe C-1).
- **Pistes à lire avant tout usage :**
  - la teneur en eau du feuillage dans FBP 1992, qui dépend de la latitude, de la longitude, de l'altitude et de la date (section non lue) ;
  - les tables d'humidité des combustibles morts de Rothermel (1983), connues pour corriger selon l'exposition, la pente et l'altitude (non lues).

### 3.5 Végétation française

- **Cruz et Alexander (2019)** : la pente de régression est presque la même pour les forêts de conifères (8,4 %), les forêts d'eucalyptus sèches (8,1 %) et les landes tempérées (8,0 %). Les auteurs en concluent que la vitesse vaut environ 8 % du vent, quel que soit le type de combustible, pour les forêts et les landes.
- **Ce que cela veut dire pour mon estimation** : pour les pins, les eucalyptus et la garrigue, le type de végétation change peu la règle. Les cas qui la font sortir de son domaine sont l'herbe (partie 3.3) et les zones peu ou pas combustibles. Aucune source lue ne donne de fraction du vent propre aux pins d'Alep, au pin maritime, aux eucalyptus ou à la garrigue française.
- **BD Forêt V2** (IGN, Licence Ouverte 2.0) :
  - photo-interprétation de 2007 à 2018, toute la métropole ;
  - surface minimale de 0,5 ha, nomenclature nationale de 32 postes, mises à jour « sans régularité ».
  - Les 32 postes n'ont pas pu être lus (descriptif de contenu inaccessible depuis l'espace de développement). Une présentation IGN de 2021 cite « Lande ligneuse » et « Formation herbacée » parmi les classes de segmentation, ce qui ne prouve pas qu'elles sont des postes de la nomenclature.
- **Version enrichie pour Provence-Alpes-Côte d'Azur** (plaquette de l'Observatoire de la forêt méditerranéenne, 2018) : 75 postes, dont 53 propres à la forêt méditerranéenne, avec les landes ligneuses (maquis, garrigues) et les formations herbacées. Licence non vérifiée.
- **Carte européenne des combustibles FirEUrisk** (Aragoneses, García, Chuvieco ; DOI 10.21950/YABYCN ; CC BY 4.0) :
  - maille de 1 km, 20 catégories cartographiées ;
  - correspondance avec les modèles de Scott et Burgan (système américain de Rothermel), pas avec FBP ;
  - précision de 88 % pour les grands types, 81 % pour l'ensemble.
- **Modèles propres à chaque combustible** (Rothermel avec Scott et Burgan, FBP par type) : ils demandent des entrées que je n'ai pas, dont l'humidité de la végétation vivante, et des choix de correspondance sans source française. Sauvagnargues-Lesage et al. (2001) ont testé BEHAVE (Rothermel) et FBP sur des brûlages français : selon les jeux de données, ils surestiment ou sous-estiment ; sur les brûlages des Pyrénées-Orientales, FBP (type S-2) surestime le plus, avec un rapport moyen de 3,35 entre vitesse prévue et vitesse observée.

### 3.6 Calage sur des feux documentés

- **Global Fire Atlas** (Andela et al. 2019, ESSD 11:529) :
  - suivi journalier des feux par MODIS à 500 m, feux de plus de 21 ha environ ;
  - vitesse et direction de propagation non validées.
  - Mise à jour sur zenodo (14065246, version du 11 avril 2025, CC BY 4.0) : 2002 à 2024, 7,7 Go, vitesse en km par jour, direction en 8 classes.
  - **Pas horaire** : calage possible seulement à l'échelle du jour, et il faudrait une météo passée sur toute la période. Les archives AROME d'Open-Meteo ne couvrent que 168 heures dans mon pipeline ; une autre source météo historique n'a pas été cherchée.
- **Prométhée et BDIFF** :
  - les extraits départementaux publiés sur data.gouv (Var, Hérault, Corse-du-Sud) sont sous Licence Ouverte 2.0 et contiennent des contours de feux et, pour la Corse-du-Sud, des points d'éclosion (contours depuis 1949).
  - Leurs pages ne décrivent pas les champs ; aucune ne parle de contours successifs ou d'heures de progression.
  - Les fichiers n'ont pas pu être téléchargés depuis l'espace de développement. Il faut ouvrir un fichier pour savoir s'il donne au moins une date et une heure d'alerte et une surface finale.
  - Une fiche BDIFF consultée ne montrait que des définitions de types de surface (forêt, maquis et garrigues, autres surfaces), sans mention de licence.
- **Données de Cruz et Alexander** : réservées aux utilisateurs autorisés. Leurs trois sources sont publiées (Alexander et Cruz 2006 ; Cheney et al. 2012 ; Anderson et al. 2015) mais n'ont pas été lues.
- **Jeu horaire d'indices IFM sur data.gouv** : inactif, inutilisable.

**Bilan :** aucun jeu ouvert trouvé ne donne la progression heure par heure de feux français. Un calage horaire n'est pas possible avec ce qui a été trouvé. Un calage journalier sur le Global Fire Atlas serait un travail d'analyse à part, hors du site.

## 4. Options et décision

Aucune option ne change la fourchette de 3 à 8 % : aucune source lue ne permet de la moduler sans chiffre inventé.

### Ma décision (15 novembre 2026)

- **Tout utiliser dans la mesure du possible.** B0 n'est pas retenue.
- **Ordre des parties :**
  1. B1, humidité des combustibles morts ;
  2. B3, pente, avec la recherche de son effet sur l'humidité ;
  3. B2, herbe et végétation ;
  4. B4, Météo des forêts.
  - B5, le calage sur des feux documentés, se fera en analyse à part, hors du site.
- **Choix pour B1 :**
  - FWI2025 réécrit à partir de Van Wagner 1977, du rapport technique 33 et de GLC-X-42, comparé au code cffdrs-ng sans le copier ;
  - calcul dans le pipeline, écrit dans `meteo-foyers.json` ;
  - affichage d'une phrase, du FFMC et de l'humidité dans la fiche, et d'un couloir plus pâle au-dessus de 7,5 % d'humidité.
- **Choix pour B1, après lecture de NOR-X-424 (15 novembre 2026) :**
  - jeux d'essai de NOR-X-424 (tableau 7) et de cffdrs-ng comparés dans l'espace de développement, sans être publiés dans le dépôt ;
  - interception de la pluie selon le rapport GLC-X-42 : six heures sans pluie avant un nouvel épisode.
- **Règle commune :** chaque partie commence par ses lectures (partie 5). Ce qui ne peut pas être sourcé n'est pas codé et reste écrit comme une limite.

### B0. Ne rien ajouter (non retenue)

- **Ce que c'est :** garder l'option A telle quelle.

### B1. Signaler l'humidité des combustibles morts

- **Ce que c'est :** calculer un FFMC horaire au foyer à partir des 168 heures passées et des 6 heures de prévision AROME déjà écrites, puis le convertir en MC. Au-dessus de 7,5 % (FFMC sous 93,3 environ), la fiche dirait que la végétation est probablement trop humide pour la règle et que l'estimation surestime probablement (Cruz et Alexander 2019).
- **Pourquoi :** c'est la seule piste qui utilise des données déjà présentes, sans nouvelle source ni nouveau chiffre.
- **Mes choix :** voir la décision ci-dessus.
- **Ce que cela ne fait pas :**
  - ne corrige pas la fourchette ;
  - ne tient pas compte de la végétation vivante ;
  - les heures passées sont des prévisions archivées, pas des mesures.
- **Limites à écrire :**
  - le seuil de 7,5 % vient d'humidités estimées autrement que par le FFMC ;
  - 7 jours d'historique ne suffisent pas toujours pour atteindre l'équilibre (11 jours pour un cycle humide) ;
  - AROME donne une moyenne sur sa maille, pas une mesure au foyer.
- **Travail :** une partie de lot (calcul, tests sur les exemples des rapports, comparaison au code cffdrs-ng, fiche, documentation).

### B2. Signaler l'herbe

- **Ce que c'est :** repérer si un foyer est en herbe, avec une carte de végétation, et le signaler.
- **Choix à faire :**
  - **Carte :** BD Forêt V2 (vectorielle, fine, sous réserve de ses postes), FirEUrisk (1 km, CC BY 4.0) ou une autre carte d'occupation du sol (Corine Land Cover ou OSO, non lues).
  - **Affichage :**
    - une phrase « herbe : le feu peut aller bien plus vite, environ 25 % du vent en prairie sèche australienne (Cruz et Alexander 2019) » ;
    - ou, en plus, une troisième ellipse à 25 % du vent, marquée comme venant de prairies australiennes très sèches.
- **Ce que cela ne fait pas :** sans taux de dessèchement de l'herbe, rien ne dit si l'herbe est sèche. Les 25 % valent pour une herbe très sèche (3,5 % en moyenne) : en herbe verte, c'est une forte surestimation.
- **Travail :** préparer la carte (volume, découpage, mise à jour), un test par foyer, la fiche et les crédits.

### B3. Indiquer la pente le long du trajet

- **Ce que c'est :** lire le relief le long du trajet estimé de la tête du feu et afficher la pente moyenne dans la fiche (« en montée » ou « en descente », en %), avec la remarque de Cruz et Alexander : sous-estimation en montée franche, surestimation en descente franche.
- **Ce que cela ne fait pas :**
  - ne change pas le couloir ;
  - aucun seuil n'est proposé, car aucun n'est publié pour ma règle.
  - Appliquer le facteur de pente FBP à la règle du vent s'écarterait de la source : non proposé.
- **Choix à faire :** source et pas du relief (RGE ALTI au pas de 5 m rééchantillonné, ou un modèle plus grossier à trouver), sous réserve de confirmer la licence à la source.
- **Humidité :** chercher et lire les sources sur l'effet de la pente, de l'exposition et de l'altitude sur l'humidité (partie 3.4). Rien ne sera ajouté sans source.
- **Travail :** préparation du relief côté pipeline ou service de tuiles, calcul, tests et documentation.

### B4. Végétation vivante et Météo des forêts

- **Ce que c'est :** aucune donnée ouverte d'humidité vivante au foyer n'a été trouvée. La seule piste opérationnelle serait d'afficher, à côté, le niveau de danger départemental de Météo des forêts pour J+1 et J+2.
- **Avant toute décision :** lire la documentation de l'API et vérifier sa licence de réutilisation. Elle demande un compte, comme l'abonnement Météo-France déjà en place.
- **Ce que cela ne fait pas :** ne donne pas d'humidité au foyer ; ne change pas l'estimation.

### B5. Calage sur des feux documentés (analyse à part)

- **Ce que c'est :** une étude rétrospective, hors du site :
  - comparer la règle à la vitesse journalière des feux français du Global Fire Atlas (2002 à 2024) ;
  - ensuite, si leurs fichiers le permettent, aux dates et surfaces de Prométhée et de la BDIFF.
- **Prérequis non remplis :**
  - une source de vent historique sur toute la période, à trouver et dont la licence est à vérifier ;
  - l'ouverture des fichiers Prométhée et BDIFF pour connaître leurs champs.
- **Ce que cela peut apporter :** un ordre de grandeur de l'écart entre la règle et des feux français, à l'échelle du jour.
- **Ce que cela ne peut pas apporter :** un calage horaire, car aucun jeu ouvert de progression horaire n'a été trouvé.
- **Travail :** le plus lourd de tous, hors du lot 2.

## 5. Ce qui reste à lire avant de coder une partie

| Pour | À lire ou à ouvrir |
|---|---|
| B1 | fait dans la partie 8 du lot 2 : NOR-X-424 lu, équations vérifiées sur son tableau 7 et sur le jeu d'essai de cffdrs-ng (résultats dans `TESTS.md`). NOR-X-424 cite PS-X-58 avec une adresse (cfs.nrcan.gc.ca, publication 23602), injoignable depuis l'espace de développement ; le rapport technique 33 le remplace pour la pluie |
| B3 | page officielle du RGE ALTI (licence, pas, formats) ; teneur en eau du feuillage dans FBP 1992 ; tables de Rothermel (1983) |
| B2 | descriptif de contenu de BD Forêt V2 (liste des 32 postes) ; licence de la version enrichie pour Provence-Alpes-Côte d'Azur ; fiches de Corine Land Cover et d'OSO ; sources françaises de verdure de l'herbe par satellite ; rayonnement solaire d'AROME |
| B4 | documentation et licence de l'API Météo des forêts |
| B5 | un fichier Prométhée et un fichier BDIFF ; une source de vent historique ; les trois sources de Cruz et Alexander |

## 6. Sources lues

Lues le 14 novembre 2026, sauf mention contraire.

| Source | Lecture | Licence |
|---|---|---|
| Cruz M.G., Alexander M.E. (2019). The 10% wind speed rule of thumb for estimating a wildfire's forward rate of spread in forests and shrublands. Annals of Forest Science 76:44 | article entier | © INRA et Springer-Verlag France |
| Sauvagnargues-Lesage S., Dusserre G., Robert F., Dray G., Pearson D.W. (2001). Experimental validation in Mediterranean shrub fuels of seven wildland fire rate of spread models. International Journal of Wildland Fire 10:15-22 (HAL, hal-02938979) | article entier | non indiquée |
| Forestry Canada Fire Danger Group (1992). Development and Structure of the Canadian Forest Fire Behavior Prediction System. Information Report ST-X-3 | sections pente, herbe et ellipse | publication du gouvernement du Canada |
| Van Wagner C.E. (1977). A method of computing fine fuel moisture content throughout the diurnal cycle. Information Report PS-X-69 | rapport entier | publication du gouvernement du Canada |
| Van Wagner C.E., Pickett T.L. (1985). Equations and FORTRAN program for the Canadian Forest Fire Weather Index System. Forestry Technical Report 33 | rapport entier | publication du gouvernement du Canada |
| cffdrs-ng, `FWI/Python/NG_FWI.py` et README (commit ed143d7) | fonctions FFMC, pluie et herbe ; rien repris | MPL-2.0 |
| Lettre d'information FWI2025 (mars 2025) | entière | non indiquée |
| Canadian Forest Service Fire Danger Group (2025). The 2025 Update to the FWI System: Structure, Changes and Interpretation. Information Report GLC-X-42 | rapport entier, lu le 15 novembre 2026 | reproduction non commerciale avec attribution |
| Wang Y., Anderson K.R., Suddaby R.M. (2015). Updated source code for calculating fire danger indices in the Canadian Forest Fire Weather Index System. Information Report NOR-X-424 | rapport entier, lu le 15 novembre 2026 | reproduction non commerciale avec attribution |
| BD Forêt V2, fiches IGN et data.gouv ; présentation IGN du 19 janvier 2021 | fiches | Licence Ouverte 2.0 |
| Plaquette BD Forêt enrichie, Observatoire de la forêt méditerranéenne (2018) | entière | non vérifiée |
| FirEUrisk European fuel map, e-cienciaDatos, DOI 10.21950/YABYCN | fiche | CC BY 4.0 |
| Jeu LFMC du réseau hydrique, zenodo 10.5281/zenodo.162978 | fiche | aucune déclarée |
| Andela N. et al. (2019). The Global Fire Atlas of individual fire size, duration, speed and direction. ESSD 11:529 ; mise à jour zenodo 14065246 | résumé, fiches | CC BY 4.0 |
| API Météo des forêts et archives, fiches data.gouv | fiches | API non indiquée ; archives Licence Ouverte |
| RGE ALTI : communiqué IGN de juillet 2021, catalogue Earth Engine `IGN/RGE_ALTI/1M/2_0` | pages | etalab-2.0 selon le catalogue, à confirmer à la source |
| Contours des feux de l'Hérault 2022 (Prométhée) et données feux de Corse-du-Sud, fiches data.gouv | fiches | Licence Ouverte 2.0 |

Non lus :
- le rapport PS-X-58 (introuvable) ;
- les articles Liu et al. 2026 et Baehr et al. 2026 (non retrouvés).
