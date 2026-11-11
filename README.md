# Pilotage PMO : installation avec base MySQL

Application web de pilotage de portefeuille projets (planning et Gantt, budget, risques, KPI, rapports, calendrier de travail).
Les données sont conservées dans **MySQL 8** (ou MariaDB 10.5+), pas dans le navigateur.

```
Navigateurs  ──HTTPS──►  Application Node.js (port 3000)  ──►  MySQL
  (interface)            API + connexion + historique         volume Docker pmo_db
```

Une page web ne peut pas parler directement à MySQL : l'application Node.js sert l'interface, vérifie les droits et écrit dans la base.

## 1. Installation avec Docker (recommandé)

Prérequis : un serveur Linux avec Docker et Docker Compose.

```bash
unzip pilotage-pmo-mysql.zip && cd pmo-mysql
cp .env.example .env
nano .env                      # changez TOUS les mots de passe, renseignez ADMIN_EMAIL / ADMIN_PASSWORD
# SESSION_SECRET : openssl rand -hex 32
docker compose up -d --build
docker compose logs -f app     # attendez « Pilotage PMO prêt sur le port 3000 »
```

Ouvrez `http://SERVEUR:3000` (ou l'adresse de votre proxy) et connectez-vous avec `ADMIN_EMAIL` / `ADMIN_PASSWORD`.
Les tables sont créées automatiquement au premier démarrage. Une fois connecté, vous pouvez retirer `ADMIN_PASSWORD` du fichier `.env`.

À la première connexion, l'application affiche 16 projets fictifs (non enregistrés). « Commencer avec mes données » les retire.

### HTTPS (obligatoire hors réseau interne de confiance)

Placez l'application derrière un proxy HTTPS et passez `COOKIE_SECURE=true` et `TRUST_PROXY=true` dans `.env`. Exemple Caddy (certificat automatique) :

```
pmo.votre-entreprise.com {
    reverse_proxy 127.0.0.1:3000
}
```

L'application doit être servie à la racine d'un domaine ou sous-domaine (pas dans un sous-dossier).

## 2. Comptes et rôles

| Rôle | Droits |
|---|---|
| `admin` | tout, y compris l'historique des modifications |
| `editor` | créer et modifier projets, calendrier et paramètres |
| `viewer` | consultation seule |

Gestion des comptes en ligne de commande (un mot de passe aléatoire est affiché si vous n'en donnez pas) :

```bash
docker compose exec app node scripts/user.js list
docker compose exec app node scripts/user.js add marie@votre-entreprise.com "Marie Ngo" editor
docker compose exec app node scripts/user.js role marie@votre-entreprise.com viewer
docker compose exec app node scripts/user.js passwd marie@votre-entreprise.com
docker compose exec app node scripts/user.js disable marie@votre-entreprise.com
```

Chaque utilisateur peut changer son mot de passe depuis le bas du menu latéral (10 caractères minimum).
Après 6 échecs sur une adresse ou 20 depuis une IP, la connexion est bloquée 15 minutes.

## 3. Sauvegardes (à mettre en place dès le premier jour)

```bash
./scripts/backup.sh                 # crée backups/pmo_AAAAMMJJ_HHMMSS.sql.gz (garde les 60 dernières)
./scripts/restore.sh backups/pmo_20261101_020000.sql.gz
```

Planification quotidienne à 2 h du matin (`crontab -e`) :

```
0 2 * * * cd /opt/pmo-mysql && ./scripts/backup.sh /opt/pmo-backups >> /var/log/pmo-backup.log 2>&1
```

Copiez ensuite le dossier de sauvegardes sur un autre serveur ou un stockage externe : un volume Docker sur la même machine ne protège pas d'une panne du disque.
Dans l'application, **Données > Sauvegarde complète** produit aussi un export JSON de tous les projets.

## 4. Reprendre vos données existantes

- **Classeur Excel actuel** : page *Données*, télécharger le modèle, y coller vos projets, tâches, budgets et risques, puis l'importer. Un projet existant (même code) est mis à jour.
- **Version navigateur de l'application** : *Données > Télécharger la sauvegarde* dans l'ancienne version, puis *Restaurer une sauvegarde* dans la nouvelle.

## 5. Sans Docker

Prérequis : Node.js 18 ou plus, un MySQL 8 / MariaDB existant.

```sql
CREATE DATABASE pmo CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'pmo'@'%' IDENTIFIED BY 'mot-de-passe-solide';
GRANT ALL PRIVILEGES ON pmo.* TO 'pmo'@'%';
```

```bash
npm ci --omit=dev
export DB_HOST=127.0.0.1 DB_NAME=pmo DB_USER=pmo DB_PASSWORD=... SESSION_SECRET=$(openssl rand -hex 32) \
       ADMIN_EMAIL=... ADMIN_PASSWORD=...
node server.js
```

Pour un service permanent, lancez `node server.js` avec systemd ou pm2. Le schéma (`db/schema.sql`) est appliqué au démarrage ; vous pouvez aussi le passer à votre DBA.

## 6. Mise à jour

```bash
docker compose down            # sans -v : le volume de données est conservé
# remplacer les fichiers de l'application par la nouvelle version
docker compose up -d --build
```

Sauvegardez avant chaque mise à jour.

## 7. Données et conservation

| Table | Contenu |
|---|---|
| `projects` | un enregistrement par projet (dates, budget, statut, version) |
| `tasks`, `budget_lines`, `risks` | tâches et jalons, lignes budgétaires, registre des risques |
| `status_updates` | points d'avancement hebdomadaires, avec les indicateurs figés ce jour-là |
| `settings` | paramètres, seuils d'alerte, calendrier de travail, fériés et événements |
| `audit_log` | qui a fait quoi et quand (connexions, créations, modifications, suppressions) |
| `users` | comptes (mots de passe chiffrés avec bcrypt) |

Aucun projet n'est supprimé physiquement : la suppression l'archive (`projects.deleted_at`). Pour le récupérer, `UPDATE projects SET deleted_at = NULL WHERE id = '...';` puis rechargez la page.
Les tables sont lisibles directement en SQL pour vos propres états (Power BI, Excel via ODBC, etc.) : utilisez un compte MySQL en lecture seule.

## 8. Fonctionnement multi-utilisateurs

- Chaque projet porte un numéro de version. Si deux personnes modifient le même projet, la seconde sauvegarde est refusée et la version à jour s'affiche avec un message : personne n'écrase le travail d'un autre sans le savoir.
- Les modifications des autres apparaissent automatiquement (vérification toutes les 20 secondes).
- Une session dure 12 heures (`SESSION_HOURS`).

## 9. Limites connues

- Les polices viennent de Google Fonts ; sans accès Internet, des polices système les remplacent, sans effet sur le fonctionnement.
- Les dates des fêtes religieuses (Aïd el-Fitr, Tabaski) sont calculées : ajustez-les dans la page *Calendrier* selon le décret officiel.
- Les mots de passe oubliés se réinitialisent en ligne de commande (`scripts/user.js passwd`), il n'y a pas d'envoi d'e-mail.

## 10. Vérifications effectuées avant livraison

Testé sur MariaDB 10.11 avec un navigateur réel : connexion, création et relecture de projets après rechargement, caractères accentués et non latins, détection de conflit entre deux utilisateurs, synchronisation, archivage, historique, import Excel, restauration de sauvegarde, rôle lecture seule, enregistrement de 16 projets. **Non testé** : le conteneur `mysql:8.4` et le build Docker (pas de Docker disponible dans l'environnement de développement). Lancez `docker compose up -d --build` puis vérifiez la connexion et la création d'un projet avant la mise en service.
