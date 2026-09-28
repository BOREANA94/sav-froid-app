# sav-froid-app

Application interne de suivi SAV et gestion des bouteilles de gaz frigorigène.

**Étape 1 (actuelle)** : savoir quel technicien a quelle bouteille dans son camion.

- Chaque bouteille a un numéro unique (`BTL-0001`…) et une étiquette QR imprimable (planche A4 3 × 8, 70 × 37 mm).
- Le technicien scanne la bouteille avec son téléphone et choisit **Je la prends** ou **Je la rends au stock**.
- Le bureau voit le stock, qui a quoi, et l'historique des mouvements.

Front-end : GitHub Pages (ce dépôt). Back-end : Supabase (base de données + comptes).

## Mise en place

1. **Supabase > SQL Editor** : exécuter `supabase/01_securite_et_scan.sql` (après la création des tables `bottles` et `movements`).
2. **Supabase > Authentication > Sign In / Providers** : désactiver « Allow new users to sign up » (seul le bureau crée les comptes).
3. **Supabase > Authentication > Users > Add user > Create new user** : un compte par technicien (cocher « Auto Confirm User »).
4. Passer ton propre compte en admin (SQL Editor) :
   ```sql
   update public.profiles set role = 'admin'
   where id = (select id from auth.users where email = 'ton.email@exemple.fr');
   ```
5. **config.js** : coller la clé *Publishable* (`sb_publishable_…`). Jamais la clé secrète.
6. **Settings > Pages** : Source « Deploy from a branch », branche `main`, dossier `/ (root)`.

L'appli est alors disponible sur `https://boreana94.github.io/sav-froid-app/`.

## Fichiers

| Fichier | Rôle |
|---|---|
| `index.html`, `app.js`, `style.css` | Appli (scan, mon camion, stock, étiquettes, historique, équipe) |
| `etiquettes.html` | Page d'impression des étiquettes QR |
| `config.js` | Adresse du projet Supabase + clé publishable |
| `supabase/01_securite_et_scan.sql` | Profils, sécurité (RLS), fonctions `scan_bottle` et `create_bottles` |

## Prochaines étapes envisagées

- Bons d'intervention : quantité de gaz utilisée par intervention.
- Pesée / stock restant par bouteille, et facturation du gaz réellement utilisé.
