# Résumé Technique Complet — Bot Chaomons

Ce document rassemble la synthèse technique complète du projet **Bot Chaomons**, structurée selon l'ensemble des modules, architectures et mécaniques du jeu.

---

## 1. Vue d’ensemble du projet

Le projet **Bot Chaomons** est un **Trading Card Game (TCG) hybride** inspiré de jeux comme *Hearthstone* et *Magic: The Gathering*, conçu sur mesure pour les membres d'une communauté Discord.

* **Concept central** : Chaque membre du serveur Discord devient une **carte de jeu à collectionner** dotée d'illustrations, de statistiques de combat (**Points de Vie / PV**, **Attaque / ATK**, **Coût / Mana**), d'un **alignement JDR** (parmi 9 classiques), d'un archétype de **créature/divinité**, d'une **explication psychologique (lore)** et de **capacités spéciales** (jusqu'à 2 passifs et 2 actifs).
* **Catalogue** : Le jeu comprend un catalogue central de **1 101 cartes/membres** réparties en 5 niveaux de rareté :
  * **Commune** : 731
  * **Rare** : 169
  * **Épique** : 143
  * **Légendaire** : 55
  * **Mythique** : 3
* **Expérience utilisateur** :
  * **Sur Discord** : Acquisition des cartes via packs de départ, apparitions aléatoires (*drops*), tirages et défis.
  * **Sur le Web** : Consultation de la collection, confection de decks (20 à 30 cartes uniques), gestion de la boutique/recyclage, et arène de combat en tour par tour en temps réel avec mode spectateur et bot d'entraînement.

---

## 2. Architecture globale (composants principaux et leurs interactions)

L'architecture du système repose sur trois grands piliers interconnectés :

```text
               +----------------------------------+
               |   Pipeline Python + Gemini (IA)  |
               |  (Enrichissement local users.csv) |
               +----------------+-----------------+
                                |
                                v
                   +--------------------------+
                   |  DATA/users.csv (Source) |
                   +------------+-------------+
                                | (Sync au démarrage)
                                v
               +----------------------------------+
               |     Backend Unifié Node.js       |
               |  (src/db.js - SQLite/MySQL)      |
               +--------+----------------+--------+
                        |                |
         +--------------+                +--------------+
         | (discord.js)                                 | (Express + Socket.io)
         v                                              v
+------------------+                          +-------------------+
|   Bot Discord    |                          |   Interface Web   |
| (Drops, /commencer|                          | (Collection, Decks|
| /deck, /duel)    |                          |  Arène Temps Réel)|
+------------------+                          +-------------------+
```

1. **Le Pipeline de Pré-traitement Python + Gemini (Hors-Ligne)** :
   * Analyse les archives de messages Discord (`archives/MD<ID>.txt`).
   * Détermine dynamiquement la rareté, l'alignement, la créature et le lore psychologique de chaque utilisateur, puis met à jour le fichier `DATA/users.csv`.
2. **Le Backend Unifié Node.js (Serveur Central)** :
   * Exécute conjointement le **Bot Discord** (discord.js v14) et le **Serveur Web** (Express + Socket.io) dans un point d'entrée unique (`index.js`).
   * Synchronise le fichier `users.csv` vers une base de données SQL (`tcg.db`) à chaque démarrage sans altérer la progression des joueurs.
3. **Le Double Moteur de Rendu Graphique** :
   * **Rendu Serveur (Canvas)** : Génère des images PNG dynamiques (750×1004 px) transmises sur Discord lors des tirages et apparitions.
   * **Rendu Client (HTML5 / CSS3)** : Superpose les calques (avatar, template, textes) directement dans le navigateur du joueur pour une netteté vectorielle optimale et responsive.

---

## 3. Bot Discord (Node.js) – structure, commandes, fonctionnalités

Le bot est développé en **JavaScript (Node.js)** avec `discord.js` (v14). Il est hébergé sur la plateforme **fps.ms**.

### Structure des fichiers clés
* `index.js` : Point d'entrée principal qui enregistre les commandes Slash, écoute les interactions Discord et lance le serveur Web.
* `src/db.js` : Gestion de la persistance SQL, synchronisation du CSV et requêtes d'inventaire/decks/joueurs.
* `src/webServer.js` : Serveur Express distribuant les API REST, les assets statiques et gérant les connexions WebSocket Socket.io pour l'arène.
* `src/cardRenderer.js` : Moteur de génération graphique Canvas 2D pour Discord.
* `src/duelEngine.js` : Moteur de règles du jeu de cartes, gestion des tours, des mains, du plateau et des duels contre le bot.

### Commandes Slash principales
* `/commencer` : Réservée aux nouveaux joueurs (0 carte). Attribue un **pack de départ de 50 cartes complètes** piochées de manière équilibrée selon les raretés réelles du catalogue et délivre le Lien Magique d'accès.
* `/deck` (ex-`/web`) : Génère et renvoie le **Lien Magique éphémère** du joueur pour accéder à l'interface Web (gestion de la collection et composition des decks).
* `/duel [utilisateur]` : Provoque un membre en combat. Vérifie l'existence de decks valides pour les deux participants, envoie les invitations privées avec boutons et génère le lien d'accès spectateur.
* `/zreset [utilisateur / tous]` *(Admin)* : Remet à zéro l'inventaire et les decks du joueur ciblé ou de l'ensemble de la communauté (avec demande de confirmation).
* `/zspawn` *(Admin)* : Active ou désactive le système d'apparition automatique des cartes dans les salons textuels.
* `/zsalon` *(Admin)* : Définit le salon Discord officiel d'apparition des cartes.
* `/fetch` *(Utilitaire Admin)* : Parcourt `DATA/users.csv` pour télécharger et uniformiser l'ensemble des avatars des membres depuis le CDN Discord (`DATA/useravatar/<ID>.png`) en gérant les Rate Limits HTTP 429.

### Système d'Authentification par "Lien Magique"
* Lors de l'exécution d'une commande (`/commencer`, `/deck`, `/duel`), le bot génère ou récupère un **jeton cryptographique unique de 64 caractères** (`auth_token`) stocké en BDD.
* Le bot répond avec un bouton privé (message éphémère) redirigeant vers `http://IP:PORT/?token=AUTH_TOKEN`.
* Ce système permet aux membres de se connecter automatiquement à leur espace Web sans créer de mot de passe. Un bouton de réinitialisation permet d'invalider un token compromis à tout moment.

---

## 4. Base de données MySQL + fichier CSV (rôle et organisation des données)

### Fichier Source : `DATA/users.csv`
Le fichier `users.csv` est la **source de vérité absolue** de la liste des cartes. Il comprend 1 101 lignes et contient la structure de colonnes suivante :
`ID Discord`, `Nom affiché sur le serveur`, `Nom utilisateur Discord`, `Alignement`, `Créature`, `Explication`, `Rareté`, `cout`, `attaque`, `vie`, `passif1`, `passif2`, `actif1`, `actif2`.

### Organisation des tables SQL (`tcg.db` / MySQL)
Au démarrage, `src/db.js` lit `users.csv` et synchronise les données dans 5 tables SQL relationnelles :

| Table | Rôle principal | Colonnes de référence |
| :--- | :--- | :--- |
| **`cards`** | Catalogue complet des cartes du jeu | `card_id` (PK), `display_name`, `username`, `rarity`, `alignment`, `creature`, `explanation`, `cout`, `attaque`, `vie`, `passif1`, `passif2`, `actif1`, `actif2` |
| **`players`** | Profils utilisateurs, ELO et auth | `discord_id` (PK), `username`, `auth_token` (UNIQUE), `elo`, `wins`, `losses`, `chaor`, `packs` |
| **`inventory`** | Collections de cartes possédées | `player_id` (FK), `card_id` (FK), `quantity` (gère les doublons x2, x3...) |
| **`decks`** | Decks sauvegardés (3 max par joueur) | `deck_id` (PK), `player_id` (FK), `slot_number` (1, 2 ou 3), `name`, `cards_json` |
| **`matches`** | État des combats et historique | `match_id` (PK), `player1_id`, `player2_id`, `status`, `winner_id`, `state_json` |

---

## 5. Script Python + Gemini (rôle exact, ce qu’il génère, comment il est utilisé)

Le traitement psychologique et la classification des cartes s'appuient sur un script Python autonome (`DATA/alignement_creature.py`) qui interagit avec l'API Google Gemini.

```text
  [Archives Discord MD<ID>.txt]
               |
               v
  [Script Python alignement_creature.py] ---> [API Google Gemini (3.8-flash à 3.5-flash)]
               |
               +---> Mise à jour de DATA/users.csv (Alignement, Créature, Lore)
               +---> Mise à jour de DATA/cache.json (Anti-doublons & Diversité)
```

### Rôle exact et processus
1. **Lecture des archives** : Le script parcourt le dossier `DATA/archives/` pour lire l'historique des discussions textuelles des membres (`MD<ID>.txt`), tronqué aux 150 derniers Ko pour respecter la fenêtre de contexte.
2. **Ordre de priorité par Rareté** : Les analyses Gemini s'exécutent en suivant une file d'attente stricte : **Mythique** → **Légendaire** → **Épique** → **Rare** → **Commune**.
3. **Analyse Gemini & Structure des réponses** : L'IA analyse le style d'écriture, l'humour et le comportement du membre puis génère un objet JSON contenant :
   * L'**Alignement JDR** (parmi les 9 alignements officiels : *Loyal Bon*, *Chaotique Neutre*, etc.).
   * La **Créature / Divinité** (ex: *Hermès*, *Satyre*, *Tanuki*, *Amanojaku*, *Dionysos*).
   * Le **Lore / Explication** (1 à 2 phrases percutantes résumant le tempérament du membre).
4. **Système Anti-Doublons & Diversité (`cache.json`)** :
   * Pour éviter que tout le serveur se retrouve associé aux mêmes créatures génériques (*Gobelin*, *Troll*...), le script s'appuie sur `cache.json`.
   * Il applique la **Roue des Lores** (8 univers : *Mythologies*, *Cyberpunk*, *Yokai*, *Lovecraft*, *D&D*, etc.) et restreint le nombre maximal d'exemplaires par espèce.
5. **Gestion du Rate Limiting** : Implémente une temporisation stricte (12,5 s entre requêtes), la gestion des jetons glissants par minute (TPM/RPM), la bascule automatique sur des modèles de secours (`gemini-3.8-flash` à `gemini-3.5-flash`), et le calcul de l'heure exacte de réinitialisation des quotas journaliers de Google.
6. **Script d'Attribution des Raretés (`raretes.py`)** : Un script dédié calcule la rareté des membres d'après leur activité. Il réserve la rareté **Mythique** aux membres listés dans `myth.txt`, distribue les raretés supérieures aux membres actifs et assigne d'office la rareté **Commune** aux "membres fantômes" (sans archive).

---

## 6. Mécaniques de jeu (cartes, combat, deckbuilding, apparition aléatoire, duels, etc.)

### Apparitions aléatoires (Drops sur Discord)
* **Compteur Furtif** : Le bot surveille les messages d'un ou plusieurs salons configurés (`/zsalon`).
* Quand l'activité atteint un seuil aléatoire `[MIN - MAX]`, le bot fait apparaître une carte dans le salon dédié sous forme d'Embed Canvas avec un bouton **« Capturer 🔴 »**. Le premier membre qui clique remporte la carte dans son inventaire BDD.

### Deckbuilding (Règles de composition)
* **Limite par Deck** : Chaque deck doit comporter obligatoirement entre **20 et 30 cartes**.
* **Règle d'Unicité** : Un deck ne peut contenir **qu'un seul exemplaire d'une même carte** (les doublons sont strictement interdits dans un même deck).
* **Sauvegarde** : Chaque joueur dispose de **3 emplacements de decks** sauvegardables en BDD sur la page Web, avec affichage en temps réel de la courbe de mana et du coût moyen.

### Arène de Duel en temps réel (Socket.io)
Le combat se déroule en tour par tour sur l'interface Web via Socket.io :

* **Paramètres de départ** :
  * **PV du Héros** : 30 PV au début du combat.
  * **Main de départ** : 3 cartes pour le joueur 1, 4 cartes pour le joueur 2.
  * **Pioche** : 1 carte piochée au début de chaque tour + gain progressif de Mana (jusqu'à 10).
  * **Limite de Plateau** : 7 créatures maximum simultanément sur le terrain par joueur.
* **Déroulement & Contrôles Tactiles/Souris** :
  * **Invocation** : Glisser-déposer une carte depuis sa main vers le terrain (consomme le coût en mana de la carte).
  * **Attaque** : Glisser-déposer une créature alliée prête vers la créature ennemie ou directement sur la **grande sphère du Héros adverse** (style *Path of Exile*).
  * **Capacités actives/passives** : Résolution dynamique des mots-clés (*Provocation*, *Bouclier divin*, *Initiative*, *Vol*, *Régénération*, *Voler des PV*, *Geler*, *Silence*, etc.).
  * **Mode Entraînement Solo** : Bouton permettant de lancer un duel d'entraînement contre le bot AI **kOkamini**.
  * **Mode Spectateur** : Un lien éphémère permet aux autres membres du serveur de regarder le plateau en direct sans voir les mains privées des joueurs.

### Économie et Gestion des Doublons (ChaOr & Packs)
* **ChaOr** : Monnaie virtuelle du jeu obtenue en **recyclant les doublons** de sa collection (cartes possédées en x2, x3...).
* **Boutique & Packs** : Les joueurs peuvent dépenser leur ChaOr pour acheter des **Packs de 5 cartes** (100 ChaOr) ou en gagner en remportant des duels.

---

## 7. Rendu graphique des cartes (PNG, avatars, etc.)

Le projet utilise deux approches de rendu selon le contexte :

```text
              +-------------------------------------+
              |    Dimensions Template Source       |
              |          1792 x 2400 px             |
              +------------------+------------------+
                                 |
         +-----------------------+-----------------------+
         |                                               |
         v                                               v
+-------------------------------+               +-------------------------------+
|     Rendu Canvas (Discord)    |               |      Rendu CSS/HTML (Web)     |
|   Canvas Node @napi-rs/canvas |               |  Superposition de calques CSS |
|    Fichier PNG 750x1004 px    |               |   Responsive & Vectoriel net  |
+-------------------------------+               +-------------------------------+
```

### 1. Rendu Serveur Discord (`src/cardRenderer.js`)
* **Technologie** : `@napi-rs/canvas` (moteur Canvas 2D ultra-rapide en C++, sans dépendances système lourdes).
* **Processus d'assemblage en mémoire (<15 ms)** :
  1. Chargement du template de rareté JPEG/PNG correspondant (`Template_Common.jpg`, `Template_Epic.jpg`...).
  2. Découpe de l'avatar du membre (`DATA/useravatar/<ID>.png`) via un masque géométrique ajusté aux coordonnées de l'illustration. En cas d'absence d'avatar, sélection d'un avatar par défaut selon l'alignement (`dlb.png`, `dnn.png`...).
  3. Redessinement des calques de superposition (l'orbe de mana, la volute supérieure et le cristal central du template passent *devant* l'avatar).
  4. Écriture du nom avec la police dédiée MTG (`Beleren-Bold.ttf`, `MagicMedieval.ttf` ou `Georgia`) avec ajustement automatique de taille de police.
  5. Positionnement du Coût, du bandeau Créature / Alignement, du bloc de Capacités/Lore, et du cartouche d'Attaque / Vie.
  6. Export sous forme de Buffer PNG 750×1004 px prêt à être envoyé dans Discord.

### 2. Rendu Client Web (`public/style.css`, `public/app.js`)
* Les cartes sur le site web ne sont pas des images fixes générées côté serveur : elles sont **assemblées dynamiquement en HTML/CSS**.
* Un composant `.tcg-card` superpose l'avatar en fond, le template PNG par-dessus (avec centre transparent) et les conteneurs de texte positionnés en pourcentages (`position: absolute; container-type: inline-size`).
* **Responsive** : Utilisation des unités de conteneur (`cqw`) pour que la typographical des compétences et du lore s'adapte à la perfection, de la miniature de deck au zoom grand écran.

---

## 8. État actuel du projet (ce qui est terminé, ce qui reste à améliorer ou à faire)

### Ce qui est terminé et totalement opérationnel
* **Architecture backend unifiée** : Moteur Node.js unifiant Discord.js, Express, Socket.io et SQLite/MySQL.
* **Synchronisation BDD** : Lecture et mise à jour transparente depuis `users.csv`.
* **Commandes Slash Discord** : `/commencer`, `/deck`, `/duel`, `/zreset`, `/zspawn`, `/zsalon`, `/fetch` fonctionnelles.
* **Authentification Web** : Connexion par Lien Magique éphémère totalement sécurisée.
* **Interface Web responsive** :
  * Vue Collection avec filtres multi-critères (rareté, alignement, possession, coût, recherche textuelle).
  * Deckbuilder complet (3 slots, vérification de la règle de 20-30 cartes uniques, courbe de mana).
  * Système d'économie (Recyclage des doublons, gain de ChaOr, achat et ouverture de packs).
  * Classement général Elo et statistiques de victoires/défaites.
  * Arène de duel en temps réel avec drag-and-drop, globes de vie/mana, journal de combat, mode spectateur et Bot IA d'entraînement (kOkamini).
* **Pipeline d'Analyse Python + Gemini** : Script autonome prêt à tourner pour qualifier les membres à partir des archives textuelles.

### Ce qui reste à améliorer ou à faire
* **Affinage de l'équilibrage des capacités** : Finaliser le codage spécifique de certains passifs et actifs très complexes parmi les 84 passifs et 141 actifs recensés dans le lore.
* **Système d'échanges direct** : Implémenter une commande d'échange entre deux joueurs (`/echange`).

---

## 9. Points d’attention / décisions techniques importantes

1. **Gestion de la Source de Vérité (`users.csv`)** :
   * `users.csv` reste le fichier maître. Le serveur met à jour les données des cartes en BDD à chaque redémarrage sans jamais réinitialiser l'inventaire ou les decks des joueurs.
2. **Correction du Bug Historique de Mélange (`shuffleArray`)** :
   * Un bug critique d'apparition de doublons dans la main lors des duels a été résolu. L'erreur venait d'une mauvaise affectation dans la fonction de mélange de `src/duelEngine.js` (`[copy[i], copy[j]] = [copy[i], copy[i]]` qui écrasait des cartes au lieu de les échanger, corrigé en `[copy[j], copy[i]]`).
3. **Portabilité Multi-Serveurs** :
   * La collection, les decks, l'Elo et le solde de ChaOr des membres sont liés exclusivement à leur `discord_id` universel. Si un membre est présent sur plusieurs serveurs Discord utilisant le bot, sa progression est **partagée et synchronisée en temps réel** sur tous les serveurs.
4. **Optimisation des Performances et Contournement des Rate Limits** :
   * Enregistrement en mémoire tampon des templates de cartes (temps de rendu Canvas <15 ms).
   * Temporisation préventive des requêtes CDN Discord dans la commande `/fetch` pour respecter les Rate Limits (HTTP 429).
   * Gestion glissante du TPM/RPM et bascule automatique de modèles pour l'API Gemini.
