// src/db.js
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const DATA_DIR = path.join(__dirname, '..', 'DATA');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DECK_MIN_CARDS = 20;
const DECK_MAX_CARDS = 30;
const MAX_DECK_SLOTS = 3;

const CHAOR_PER_DUPLICATE = 10;
const PACK_COST_CHAOR = 100;
const CARDS_PER_PACK = 5;

// ---------- Cache mémoire des cartes ----------
let cardsById = new Map();
let cardsByRarity = new Map();

// ---------- Connexion MySQL ----------
const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 5,
  queueLimit: 0,
  charset: 'utf8mb4'
});

let isReady = false;
let readyPromise = null;

function getParisDateString() {
  return new Intl.DateTimeFormat('fr-CA', {
    timeZone: 'Europe/Paris',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
}

async function initSchema() {
  const conn = await pool.getConnection();
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS cards (
        card_id VARCHAR(32) PRIMARY KEY,
        display_name VARCHAR(255) NOT NULL,
        username VARCHAR(255) DEFAULT '',
        rarity VARCHAR(50) DEFAULT 'Commune',
        alignment VARCHAR(100) DEFAULT '',
        creature VARCHAR(100) DEFAULT '',
        explanation TEXT,
        cout INT DEFAULT 0,
        attaque INT DEFAULT 0,
        vie INT DEFAULT 0,
        passif1 TEXT,
        passif2 TEXT,
        actif1 TEXT,
        actif2 TEXT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS players (
        discord_id VARCHAR(32) PRIMARY KEY,
        username VARCHAR(255) NOT NULL,
        auth_token VARCHAR(64) UNIQUE,
        elo INT DEFAULT 1000,
        wins INT DEFAULT 0,
        losses INT DEFAULT 0,
        chaor INT DEFAULT 0,
        packs INT DEFAULT 0,
        last_daily_date VARCHAR(16) DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    const [playerCols] = await conn.query(`SHOW COLUMNS FROM players`);
    const pColNames = playerCols.map(c => c.Field);
    if (!pColNames.includes('auth_token')) {
      await conn.query(`ALTER TABLE players ADD COLUMN auth_token VARCHAR(64) UNIQUE`);
    }
    if (!pColNames.includes('elo')) {
      await conn.query(`ALTER TABLE players ADD COLUMN elo INT DEFAULT 1000`);
    }
    if (!pColNames.includes('wins')) {
      await conn.query(`ALTER TABLE players ADD COLUMN wins INT DEFAULT 0`);
    }
    if (!pColNames.includes('losses')) {
      await conn.query(`ALTER TABLE players ADD COLUMN losses INT DEFAULT 0`);
    }
    if (!pColNames.includes('chaor')) {
      await conn.query(`ALTER TABLE players ADD COLUMN chaor INT DEFAULT 0`);
    }
    if (!pColNames.includes('packs')) {
      await conn.query(`ALTER TABLE players ADD COLUMN packs INT DEFAULT 0`);
    }
    if (!pColNames.includes('last_daily_date')) {
      await conn.query(`ALTER TABLE players ADD COLUMN last_daily_date VARCHAR(16) DEFAULT ''`);
    }

    await conn.query(`
      CREATE TABLE IF NOT EXISTS inventory (
        player_id VARCHAR(32) NOT NULL,
        card_id VARCHAR(32) NOT NULL,
        quantity INT DEFAULT 1,
        first_obtained_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (player_id, card_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS decks (
        deck_id INT AUTO_INCREMENT PRIMARY KEY,
        player_id VARCHAR(32) NOT NULL,
        slot_number TINYINT NOT NULL,
        name VARCHAR(100) NOT NULL DEFAULT 'Mon Deck',
        cards_json LONGTEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY unique_slot (player_id, slot_number)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS matches (
        match_id VARCHAR(64) PRIMARY KEY,
        player1_id VARCHAR(32) NOT NULL,
        player2_id VARCHAR(32) NOT NULL,
        status VARCHAR(30) DEFAULT 'pending',
        winner_id VARCHAR(32),
        state_json LONGTEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // Table anti-triche pour les récompenses de duel :
    // 1 seul pack gagné par jour pour un couple (winner_id -> loser_id) spécifique
    await conn.query(`
      CREATE TABLE IF NOT EXISTS duel_daily_rewards (
        winner_id VARCHAR(32) NOT NULL,
        loser_id VARCHAR(32) NOT NULL,
        reward_date VARCHAR(16) NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (winner_id, loser_id, reward_date)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    console.log('✅ [DB] Schéma MySQL OK');
  } finally {
    conn.release();
  }
}

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

function toIntOrZero(val) {
  if (val === undefined || val === null || val === '') return 0;
  const parsed = parseInt(val, 10);
  return isNaN(parsed) ? 0 : parsed;
}

async function loadCards() {
  let csvPath = path.join(DATA_DIR, 'users.csv');
  if (!fs.existsSync(csvPath)) {
    csvPath = path.join(__dirname, '..', 'users.csv');
  }

  if (fs.existsSync(csvPath)) {
    try {
      const count = await syncCardsFromCSV(csvPath);
      if (count > 0) return count;
    } catch (err) {
      console.error('❌ [DB] Erreur sync CSV :', err.message);
    }
  }

  try {
    const [rows] = await pool.query('SELECT * FROM cards');
    if (rows.length > 0) {
      cardsById = new Map();
      cardsByRarity = new Map();
      for (const card of rows) {
        cardsById.set(String(card.card_id), card);
        const r = card.rarity || 'Commune';
        if (!cardsByRarity.has(r)) cardsByRarity.set(r, []);
        cardsByRarity.get(r).push(card);
      }
      console.log(`✅ [DB] ${rows.length} cartes chargées depuis MySQL (fallback)`);
      return rows.length;
    }
  } catch (e) {
    console.error('❌ [DB] Fallback MySQL impossible :', e.message);
  }

  return 0;
}

async function syncCardsFromCSV(csvPath) {
  const content = fs.readFileSync(csvPath, 'utf-8').replace(/^\uFEFF/, '');
  const lines = content.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length < 2) return 0;

  const rawHeaders = parseCSVLine(lines[0]);

  const normalizeHeader = (value) => String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

  const normalizedHeaders = rawHeaders.map(normalizeHeader);
  const findCol = (...names) => {
    for (const name of names) {
      const index = normalizedHeaders.indexOf(normalizeHeader(name));
      if (index !== -1) return index;
    }
    return -1;
  };

  const idx = {
    id:          findCol('ID Discord'),
    displayName: findCol('Nom affiché sur le serveur'),
    username:    findCol('Nom utilisateur Discord'),
    alignment:   findCol('Alignement'),
    creature:    findCol('Créature'),
    explanation: findCol('Explication'),
    rarity:      findCol('Rareté'),
    cout:        findCol('cout'),
    attaque:     findCol('attaque'),
    vie:         findCol('vie'),
    passif1:     findCol('passif1'),
    passif2:     findCol('passif2'),
    actif1:      findCol('actif1'),
    actif2:      findCol('actif2')
  };

  const conn = await pool.getConnection();
  let count = 0;
  cardsById = new Map();
  cardsByRarity = new Map();
  const validCsvIds = [];

  try {
    await conn.beginTransaction();

    for (const row of lines.slice(1)) {
      const cols = parseCSVLine(row);
      const cardId = idx.id !== -1 ? String(cols[idx.id] || '').trim() : null;
      if (!cardId || !/^\d{15,22}$/.test(cardId)) continue;
      if (cardsById.has(cardId)) continue;

      const getStr = (i, fb = '') => (i !== -1 && cols[i] !== undefined) ? cols[i] : fb;

      const card = {
        card_id:      cardId,
        display_name: getStr(idx.displayName) || getStr(idx.username) || cardId,
        username:     getStr(idx.username),
        rarity:       getStr(idx.rarity, 'Commune') || 'Commune',
        alignment:    getStr(idx.alignment),
        creature:     getStr(idx.creature),
        explanation:  getStr(idx.explanation),
        cout:         idx.cout !== -1 ? toIntOrZero(cols[idx.cout]) : 0,
        attaque:      idx.attaque !== -1 ? toIntOrZero(cols[idx.attaque]) : 0,
        vie:          idx.vie !== -1 ? toIntOrZero(cols[idx.vie]) : 0,
        passif1:      getStr(idx.passif1),
        passif2:      getStr(idx.passif2),
        actif1:       getStr(idx.actif1),
        actif2:       getStr(idx.actif2)
      };

      await conn.query(
        `INSERT INTO cards (
          card_id, display_name, username, rarity, alignment, creature,
          explanation, cout, attaque, vie, passif1, passif2, actif1, actif2
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          display_name=VALUES(display_name), username=VALUES(username),
          rarity=VALUES(rarity), alignment=VALUES(alignment),
          creature=VALUES(creature), explanation=VALUES(explanation),
          cout=VALUES(cout), attaque=VALUES(attaque), vie=VALUES(vie),
          passif1=VALUES(passif1), passif2=VALUES(passif2),
          actif1=VALUES(actif1), actif2=VALUES(actif2)`,
        [
          card.card_id, card.display_name, card.username, card.rarity,
          card.alignment, card.creature, card.explanation,
          card.cout, card.attaque, card.vie,
          card.passif1, card.passif2, card.actif1, card.actif2
        ]
      );

      cardsById.set(card.card_id, card);
      validCsvIds.push(card.card_id);
      const r = card.rarity;
      if (!cardsByRarity.has(r)) cardsByRarity.set(r, []);
      cardsByRarity.get(r).push(card);
      count++;
    }

    if (validCsvIds.length > 0) {
      await conn.query(`DELETE FROM cards WHERE card_id NOT IN (?)`, [validCsvIds]);
      await conn.query(`DELETE FROM inventory WHERE card_id NOT IN (?)`, [validCsvIds]);
    }

    await conn.commit();
    console.log(`✅ [DB] ${count} cartes uniques synchronisées depuis users.csv → MySQL + cache mémoire`);
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  return count;
}

async function ensureReady() {
  if (isReady) return;

  if (!readyPromise) {
    readyPromise = (async () => {
      const conn = await pool.getConnection();
      console.log('✅ [DB] Connexion MySQL OK');
      conn.release();

      await initSchema();
      await loadCards();
      isReady = true;
    })();
  }

  await readyPromise;
}

async function getCardById(cardId) {
  await ensureReady();
  return cardsById.get(String(cardId).trim()) || null;
}

async function getRandomCardByRarity(rarity = null) {
  await ensureReady();
  if (rarity) {
    const list = cardsByRarity.get(rarity);
    if (!list || list.length === 0) return null;
    return list[Math.floor(Math.random() * list.length)];
  }
  const all = Array.from(cardsById.values());
  if (all.length === 0) return null;
  return all[Math.floor(Math.random() * all.length)];
}

// ============================================================================
// TIRAGE CENTRALISÉ SUR TOUTE LA COLLECTION (PROPORTIONNEL À LA RARETÉ)
// ============================================================================
async function drawBalancedCompleteCards(nombre = 1) {
  await ensureReady();

  const allCards = Array.from(cardsById.values());
  if (allCards.length === 0) {
    throw new Error('Aucune carte n’a été trouvée dans le catalogue.');
  }

  const weightedRarities = [];
  let totalWeight = 0;

  for (const [r, poolOfRarity] of cardsByRarity.entries()) {
    if (poolOfRarity && poolOfRarity.length > 0) {
      weightedRarities.push({ rarity: r, weight: poolOfRarity.length, pool: poolOfRarity });
      totalWeight += poolOfRarity.length;
    }
  }

  const tirage = [];
  for (let i = 0; i < nombre; i++) {
    if (weightedRarities.length === 0 || totalWeight <= 0) {
      tirage.push(allCards[Math.floor(Math.random() * allCards.length)]);
      continue;
    }

    let roll = Math.random() * totalWeight;
    let chosenPool = weightedRarities[0].pool;

    for (const item of weightedRarities) {
      if (roll < item.weight) {
        chosenPool = item.pool;
        break;
      }
      roll -= item.weight;
    }

    tirage.push(chosenPool[Math.floor(Math.random() * chosenPool.length)]);
  }

  return { tirage, totalDispo: allCards.length };
}

// ============================================================================
// JOUEURS, INVENTAIRE, CHAOR & PACKS
// ============================================================================
async function getOrCreatePlayer(discordId, username = 'Joueur') {
  await ensureReady();
  const cleanId = String(discordId).trim();
  const [rows] = await pool.query('SELECT * FROM players WHERE discord_id = ?', [cleanId]);

  if (rows.length > 0) {
    const player = rows[0];
    if (!player.auth_token || String(player.auth_token).length < 32 || player.auth_token === 'null') {
      const newToken = crypto.randomBytes(32).toString('hex');
      await pool.query('UPDATE players SET auth_token = ? WHERE discord_id = ?', [newToken, cleanId]);
      player.auth_token = newToken;
    }
    if (username && player.username !== username) {
      await pool.query('UPDATE players SET username = ? WHERE discord_id = ?', [username, cleanId]);
      player.username = username;
    }
    return player;
  }

  const token = crypto.randomBytes(32).toString('hex');
  await pool.query(
    'INSERT INTO players (discord_id, username, auth_token) VALUES (?, ?, ?)',
    [cleanId, username || 'Joueur', token]
  );
  const [newRows] = await pool.query('SELECT * FROM players WHERE discord_id = ?', [cleanId]);
  return newRows[0];
}

async function regeneratePlayerToken(discordId) {
  await ensureReady();
  const cleanId = String(discordId).trim();
  await getOrCreatePlayer(cleanId);
  const newToken = crypto.randomBytes(32).toString('hex');
  await pool.query('UPDATE players SET auth_token = ? WHERE discord_id = ?', [newToken, cleanId]);
  return newToken;
}

async function getPlayerByToken(token) {
  if (!token) return null;
  await ensureReady();
  const cleanToken = String(token).replace(/[^a-fA-F0-9]/g, '');
  if (cleanToken.length < 32) return null;

  const [rows] = await pool.query('SELECT * FROM players WHERE auth_token = ?', [cleanToken]);
  return rows[0] || null;
}

async function addCardToInventory(discordId, cardId, amount = 1, username = 'Joueur') {
  await ensureReady();
  const cleanId = String(discordId).trim();
  await getOrCreatePlayer(cleanId, username);
  await pool.query(
    `INSERT INTO inventory (player_id, card_id, quantity)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE quantity = quantity + VALUES(quantity)`,
    [cleanId, String(cardId).trim(), Number(amount) || 1]
  );
}

async function getPlayerTotalCards(discordId) {
  await ensureReady();
  const cleanId = String(discordId).trim();
  const [rows] = await pool.query(
    'SELECT COALESCE(SUM(quantity), 0) AS total FROM inventory WHERE player_id = ?',
    [cleanId]
  );
  return Number(rows[0]?.total) || 0;
}

async function resetPlayerInventory(discordId) {
  await ensureReady();
  const cleanId = String(discordId).trim();
  const [invRes] = await pool.query('DELETE FROM inventory WHERE player_id = ?', [cleanId]);
  await pool.query('DELETE FROM decks WHERE player_id = ?', [cleanId]);
  await pool.query('DELETE FROM duel_daily_rewards WHERE winner_id = ? OR loser_id = ?', [cleanId, cleanId]);
  await pool.query(
    `UPDATE players SET chaor = 0, packs = 0, last_daily_date = '' WHERE discord_id = ?`,
    [cleanId]
  );
  return invRes.affectedRows || 0;
}

async function markDailyActionUsedToday(discordId) {
  await ensureReady();
  const cleanId = String(discordId).trim();
  const today = getParisDateString();
  await pool.query('UPDATE players SET last_daily_date = ? WHERE discord_id = ?', [today, cleanId]);
}

async function claimDailyRsaPack(discordId, username = 'Joueur') {
  await ensureReady();
  const cleanId = String(discordId).trim();
  const player = await getOrCreatePlayer(cleanId, username);
  const today = getParisDateString();

  if (player.last_daily_date === today) {
    return {
      alreadyClaimed: true,
      packs: Number(player.packs) || 0
    };
  }

  await pool.query(
    'UPDATE players SET packs = packs + 1, last_daily_date = ? WHERE discord_id = ?',
    [today, cleanId]
  );

  const [updated] = await pool.query('SELECT packs FROM players WHERE discord_id = ?', [cleanId]);
  return {
    alreadyClaimed: false,
    packs: Number(updated[0]?.packs) || 1
  };
}

async function addPacksToPlayer(discordId, count = 1, username = 'Joueur') {
  await ensureReady();
  const cleanId = String(discordId).trim();
  await getOrCreatePlayer(cleanId, username);
  await pool.query(
    'UPDATE players SET packs = packs + ? WHERE discord_id = ?',
    [Number(count) || 1, cleanId]
  );
  const [rows] = await pool.query('SELECT packs FROM players WHERE discord_id = ?', [cleanId]);
  return Number(rows[0]?.packs) || 0;
}

// Système anti-triche des duels :
// Attribue 1 pack au vainqueur UNIQUEMENT s'il n'a pas déjà gagné de pack contre ce même adversaire aujourd'hui.
async function claimDuelWinPackIfEligible(winnerId, loserId, winnerUsername = 'Joueur') {
  await ensureReady();
  const cleanWin = String(winnerId).trim();
  const cleanLose = String(loserId).trim();
  const today = getParisDateString();

  await getOrCreatePlayer(cleanWin, winnerUsername);

  const [existing] = await pool.query(
    'SELECT 1 FROM duel_daily_rewards WHERE winner_id = ? AND loser_id = ? AND reward_date = ? LIMIT 1',
    [cleanWin, cleanLose, today]
  );

  if (existing.length > 0) {
    return { granted: false };
  }

  await pool.query(
    'INSERT IGNORE INTO duel_daily_rewards (winner_id, loser_id, reward_date) VALUES (?, ?, ?)',
    [cleanWin, cleanLose, today]
  );

  const newPackTotal = await addPacksToPlayer(cleanWin, 1, winnerUsername);
  return {
    granted: true,
    packs: newPackTotal
  };
}

async function openOnePackForPlayer(discordId, username = 'Joueur') {
  await ensureReady();
  const cleanId = String(discordId).trim();
  const player = await getOrCreatePlayer(cleanId, username);

  if ((Number(player.packs) || 0) < 1) {
    throw new Error("Tu n'as aucun pack à ouvrir !");
  }

  const { tirage } = await drawBalancedCompleteCards(CARDS_PER_PACK);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [pRows] = await conn.query('SELECT packs FROM players WHERE discord_id = ? FOR UPDATE', [cleanId]);
    const currentPacks = Number(pRows[0]?.packs) || 0;
    if (currentPacks < 1) {
      throw new Error("Tu n'as plus de pack disponible.");
    }

    await conn.query('UPDATE players SET packs = packs - 1 WHERE discord_id = ?', [cleanId]);

    for (const card of tirage) {
      await conn.query(
        `INSERT INTO inventory (player_id, card_id, quantity)
         VALUES (?, ?, 1)
         ON DUPLICATE KEY UPDATE quantity = quantity + 1`,
        [cleanId, card.card_id]
      );
    }

    await conn.commit();
    return {
      cards: tirage,
      remainingPacks: currentPacks - 1
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function recyclePlayerDuplicates(discordId) {
  await ensureReady();
  const cleanId = String(discordId).trim();

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [dupRows] = await conn.query(
      'SELECT COALESCE(SUM(quantity - 1), 0) AS dup_count FROM inventory WHERE player_id = ? AND quantity > 1 FOR UPDATE',
      [cleanId]
    );
    const recycledCount = Number(dupRows[0]?.dup_count) || 0;

    if (recycledCount <= 0) {
      await conn.rollback();
      const player = await getOrCreatePlayer(cleanId);
      return {
        recycledCount: 0,
        chaorGained: 0,
        chaor: Number(player.chaor) || 0
      };
    }

    const chaorGained = recycledCount * CHAOR_PER_DUPLICATE;

    await conn.query(
      'UPDATE inventory SET quantity = 1 WHERE player_id = ? AND quantity > 1',
      [cleanId]
    );

    await conn.query(
      'UPDATE players SET chaor = chaor + ? WHERE discord_id = ?',
      [chaorGained, cleanId]
    );

    const [pRows] = await conn.query('SELECT chaor FROM players WHERE discord_id = ?', [cleanId]);
    await conn.commit();

    return {
      recycledCount,
      chaorGained,
      chaor: Number(pRows[0]?.chaor) || 0
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function buyPackWithChaor(discordId) {
  await ensureReady();
  const cleanId = String(discordId).trim();

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [pRows] = await conn.query(
      'SELECT chaor, packs FROM players WHERE discord_id = ? FOR UPDATE',
      [cleanId]
    );
    if (!pRows.length) throw new Error('Joueur introuvable.');

    const currentChaor = Number(pRows[0].chaor) || 0;
    const packsToBuy = Math.floor(currentChaor / PACK_COST_CHAOR);

    if (packsToBuy < 1) {
      throw new Error(`ChaOr insuffisants (${currentChaor} / ${PACK_COST_CHAOR} ChaOr requis).`);
    }

    const totalCost = packsToBuy * PACK_COST_CHAOR;

    await conn.query(
      'UPDATE players SET chaor = chaor - ?, packs = packs + ? WHERE discord_id = ?',
      [totalCost, packsToBuy, cleanId]
    );

    const [updated] = await conn.query('SELECT chaor, packs FROM players WHERE discord_id = ?', [cleanId]);
    await conn.commit();

    return {
      packsBought: packsToBuy,
      costChaor: totalCost,
      chaor: Number(updated[0].chaor) || 0,
      packs: Number(updated[0].packs) || 0
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function getPlayerCollection(discordId) {
  await ensureReady();
  const cleanId = String(discordId).trim();
  const [invRows] = await pool.query(
    'SELECT card_id, SUM(quantity) AS quantity FROM inventory WHERE player_id = ? GROUP BY card_id',
    [cleanId]
  );

  const ownedMap = new Map();
  for (const r of invRows) {
    ownedMap.set(String(r.card_id).trim(), Number(r.quantity) || 0);
  }

  const rarityOrder = { 'Mythique': 1, 'Légendaire': 2, 'Épique': 3, 'Rare': 4, 'Commune': 5 };
  const result = [];

  for (const card of cardsById.values()) {
    const cid = String(card.card_id).trim();
    result.push({
      ...card,
      card_id: cid,
      owned_quantity: ownedMap.get(cid) || 0
    });
  }

  result.sort((a, b) => {
    const ra = rarityOrder[a.rarity] || 9;
    const rb = rarityOrder[b.rarity] || 9;
    if (ra !== rb) return ra - rb;
    return String(a.display_name || '').localeCompare(String(b.display_name || ''), 'fr', { sensitivity: 'base' });
  });

  return result;
}

// ============================================================================
// GESTION DES 3 DECKS : UNICITÉ STRICTE (1 SEUL EXEMPLAIRE PAR CARTE)
// ============================================================================
function deduplicateDeckCardIds(rawIds) {
  if (!Array.isArray(rawIds)) return [];
  const seenIds = new Set();
  const seenNames = new Set();
  const uniqueList = [];

  for (const raw of rawIds) {
    const cid = String(raw || '').trim();
    if (!cid || seenIds.has(cid)) continue;
    const cardObj = cardsById.get(cid);
    if (!cardObj) continue;

    const nameKey = String(cardObj.display_name || cid).toLowerCase().trim();
    if (seenNames.has(nameKey)) continue;

    seenIds.add(cid);
    seenNames.add(nameKey);
    uniqueList.push(cid);
  }
  return uniqueList;
}

async function getPlayerDecks(discordId) {
  await ensureReady();
  const cleanId = String(discordId).trim();
  const [rows] = await pool.query(
    'SELECT slot_number, name, cards_json, updated_at FROM decks WHERE player_id = ? ORDER BY slot_number ASC',
    [cleanId]
  );

  const bySlot = new Map();
  for (const row of rows) {
    let cards = [];
    try {
      cards = typeof row.cards_json === 'string' ? JSON.parse(row.cards_json) : (row.cards_json || []);
    } catch {
      cards = [];
    }
    const uniqueCards = deduplicateDeckCardIds(cards);
    const slotNum = Number(row.slot_number);
    bySlot.set(slotNum, {
      slot_number: slotNum,
      name: row.name || `Deck #${slotNum}`,
      cards: uniqueCards,
      updated_at: row.updated_at
    });
  }

  const slots = [];
  for (let s = 1; s <= MAX_DECK_SLOTS; s++) {
    const existing = bySlot.get(s) || {
      slot_number: s,
      name: `Deck #${s}`,
      cards: [],
      updated_at: null
    };
    existing.is_valid = existing.cards.length >= DECK_MIN_CARDS && existing.cards.length <= DECK_MAX_CARDS;
    slots.push(existing);
  }
  return slots;
}

async function savePlayerDeck(discordId, slotNumber, deckName, cardIdsArray) {
  await ensureReady();
  const cleanId = String(discordId).trim();
  const slot = Number(slotNumber);
  if (![1, 2, 3].includes(slot)) {
    throw new Error('Le numéro de slot doit être 1, 2 ou 3.');
  }
  if (!Array.isArray(cardIdsArray)) {
    throw new Error('Format de liste de cartes invalide.');
  }

  const uniqueCards = deduplicateDeckCardIds(cardIdsArray);

  if (uniqueCards.length > DECK_MAX_CARDS) {
    throw new Error(`Un deck ne peut pas contenir plus de ${DECK_MAX_CARDS} cartes uniques.`);
  }

  const [invRows] = await pool.query(
    'SELECT card_id, SUM(quantity) AS quantity FROM inventory WHERE player_id = ? GROUP BY card_id',
    [cleanId]
  );
  const ownedCounts = new Map(invRows.map(r => [String(r.card_id).trim(), Number(r.quantity)]));

  for (const cid of uniqueCards) {
    const ownedQty = ownedCounts.get(cid) || 0;
    if (ownedQty < 1) {
      const cardObj = cardsById.get(cid);
      const cardLabel = cardObj ? cardObj.display_name : cid;
      throw new Error(`Tu ne possèdes pas la carte « ${cardLabel} » dans ta collection.`);
    }
  }

  const safeName = String(deckName || `Deck #${slot}`).trim().slice(0, 60) || `Deck #${slot}`;
  const jsonPayload = JSON.stringify(uniqueCards);

  await pool.query(
    `INSERT INTO decks (player_id, slot_number, name, cards_json)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       name = VALUES(name),
       cards_json = VALUES(cards_json),
       updated_at = CURRENT_TIMESTAMP`,
    [cleanId, slot, safeName, jsonPayload]
  );

  return {
    slot_number: slot,
    name: safeName,
    cards: uniqueCards,
    is_valid: uniqueCards.length >= DECK_MIN_CARDS && uniqueCards.length <= DECK_MAX_CARDS
  };
}

async function getLeaderboard(limit = 50) {
  await ensureReady();
  const [players] = await pool.query(
    'SELECT discord_id, username, elo, wins, losses FROM players ORDER BY elo DESC LIMIT ?',
    [Number(limit) || 50]
  );
  const [invStats] = await pool.query(
    'SELECT player_id, COUNT(DISTINCT card_id) AS unique_cards, COALESCE(SUM(quantity), 0) AS total_cards FROM inventory GROUP BY player_id'
  );
  const statsMap = new Map(invStats.map(s => [String(s.player_id), s]));

  return players.map(p => {
    const st = statsMap.get(String(p.discord_id)) || { unique_cards: 0, total_cards: 0 };
    return {
      ...p,
      unique_cards: Number(st.unique_cards) || 0,
      total_cards: Number(st.total_cards) || 0
    };
  });
}

module.exports = {
  pool,
  DECK_MIN_CARDS,
  DECK_MAX_CARDS,
  MAX_DECK_SLOTS,
  CHAOR_PER_DUPLICATE,
  PACK_COST_CHAOR,
  CARDS_PER_PACK,
  ensureReady,
  drawBalancedCompleteCards,
  getOrCreatePlayer,
  regeneratePlayerToken,
  getPlayerByToken,
  addCardToInventory,
  getPlayerTotalCards,
  resetPlayerInventory,
  markDailyActionUsedToday,
  claimDailyRsaPack,
  addPacksToPlayer,
  claimDuelWinPackIfEligible,
  openOnePackForPlayer,
  recyclePlayerDuplicates,
  buyPackWithChaor,
  getPlayerCollection,
  getPlayerDecks,
  savePlayerDeck,
  getLeaderboard,
  getCardById,
  getRandomCardByRarity
};