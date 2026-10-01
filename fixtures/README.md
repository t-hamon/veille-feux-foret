# Fixtures

Échantillons réels des sources de données, utilisés par les tests des parseurs. Aucune donnée n'est fabriquée à la main pour imiter une source.

## Capture

L'espace de développement n'a pas accès aux serveurs des sources. La capture passe donc par le workflow GitHub Actions **Capture fixtures**, lancé à la main depuis l'onglet Actions :

1. Actions, puis **Capture fixtures**, puis **Run workflow** sur la branche `main`.
2. Le workflow télécharge les sources listées dans `pipeline/src/veille_feux/capture.py`, compresse chaque réponse et écrit un `manifest.json` (URL, date, statut HTTP, taille, SHA-256, licence, ou erreur si la source était indisponible).
3. Le résultat est poussé sur une branche `fixtures/capture-<identifiant du run>`. Rien n'est fusionné automatiquement.

La liste des sources est fixée dans le code : le workflow n'accepte aucun paramètre, il ne peut pas servir à télécharger autre chose.

## Organisation

- `raw/<horodatage>/` : réponses brutes d'une capture, telles que reçues.
- Les fixtures utilisées par les tests sont des extraits de ces captures, choisis et réduits dans la pull request du lot concerné. Chaque extrait garde la référence de la capture d'origine.

## Licences des échantillons

| Source | Licence | Attribution |
|---|---|---|
| NASA FIRMS (VIIRS, MODIS) | politique de données ouvertes de la NASA | citation demandée et lien vers l'avertissement LANCE |
| Copernicus EFFIS | CC BY 4.0 | crédit à EFFIS (Commission européenne, Centre commun de recherche) et mention des modifications |
