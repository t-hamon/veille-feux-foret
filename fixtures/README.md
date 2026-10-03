# Fixtures

Échantillons réels des sources de données, utilisés par les tests des parseurs. Aucune donnée n'est fabriquée à la main pour imiter une source.

## Capture

L'espace de développement n'a pas accès aux serveurs des sources. La capture passe donc par le workflow GitHub Actions **Capture fixtures**, lancé à la main depuis l'onglet Actions :

1. Actions, puis **Capture fixtures**, puis **Run workflow** sur la branche `main`.
2. Le workflow télécharge les sources listées dans `pipeline/src/veille_feux/capture.py`, compresse chaque réponse et écrit un `manifest.json` (URL, date, statut HTTP, taille, SHA-256, licence, ou erreur si la source était indisponible).
3. Le résultat est poussé sur une branche `fixtures/capture-<identifiant du run>`. Rien n'est fusionné automatiquement.

La liste des sources est fixée dans le code : le workflow n'accepte aucun paramètre, il ne peut pas servir à télécharger autre chose.

## Organisation

- Les captures brutes restent sur leur branche `fixtures/capture-<identifiant du run>`, sur GitHub : elles pèsent plusieurs dizaines de Mo et ne sont pas fusionnées dans `main`.
- Les fixtures utilisées par les tests sont dans `pipeline/tests/fixtures/<horodatage de la capture>/`. Ce sont des copies ou des extraits réduits des captures brutes ; leur provenance exacte est décrite dans le `README.md` de ce dossier.
- Un extrait est produit par un script versionné et reproductible (`tools/extract_effis_fixtures.py`), jamais à la main.

## Licences des échantillons

| Source | Licence | Attribution |
|---|---|---|
| NASA FIRMS (VIIRS, MODIS) | politique de données ouvertes de la NASA | citation demandée et lien vers l'avertissement LANCE |
| Copernicus EFFIS | CC BY 4.0 | crédit à EFFIS (Commission européenne, Centre commun de recherche) et mention des modifications |
| geo.api.gouv.fr (recherche de commune) | à vérifier avant utilisation par la carte | à vérifier |
