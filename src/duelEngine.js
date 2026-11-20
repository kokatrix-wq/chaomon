// src/duelEngine.js
const crypto = require('crypto');
const {
  pool,
  getCardById,
  getPlayerCollection,
  getPlayerDecks,
  savePlayerDeck,
  getOrCreatePlayer,
  addPacksToPlayer,
  claimDuelWinPackIfEligible,
  drawBalancedCompleteCards
} = require('./db');

const HERO_START_HP = 30;
const MAX_MANA = 10;
const MAX_HAND_SIZE = 10;
const MAX_BOARD_SIZE = 7;
const ACCEPT_TIMEOUT_MS = 120 * 1000;
const BOT_DISCORD_ID = 'BOT_CHAOMON_AI';

let currentDuel = null;

function norm(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function shuffleArray(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function parseActiveAbility(rawText) {
  if (!rawText || !String(rawText).trim()) return null;
  const text = String(rawText).trim();
  const sepIdx = text.indexOf(':');
  if (sepIdx === -1) return null;

  const costPart = norm(text.slice(0, sepIdx));
  const effectText = text.slice(sepIdx + 1).trim();
  const effectNorm = norm(effectText);

  let manaCost = 0;
  const manaMatch = costPart.match(/(\d+)\s*mana/);
  if (manaMatch) manaCost = parseInt(manaMatch[1], 10);

  const requiresTap = costPart.includes('engager');
  const requiresSacrifice = costPart.includes('sacrifier');
  let hpCost = 0;
  const hpMatch = costPart.match(/payer\s+(\d+)\s*pv/);
  if (hpMatch) hpCost = parseInt(hpMatch[1], 10);

  return {
    raw: text,
    manaCost,
    requiresTap,
    requiresSacrifice,
    hpCost,
    effectText,
    effectNorm,
    targetType: getEffectTargetType(effectNorm)
  };
}

function getEffectTargetType(effectNorm) {
  if (!effectNorm) return null;
  if (effectNorm.includes('aléatoire') || effectNorm.includes('aleatoire')) return null;
  if (effectNorm.includes('toutes')) return null;

  if (effectNorm.includes('a une cible')) return 'any';
  if (effectNorm.includes('une creature au silence')) return 'any_creature';
  if (effectNorm.includes('une creature ennemie')) return 'enemy_creature';
  if (effectNorm.includes("d'une creature ennemie")) return 'enemy_creature';
  if (effectNorm.includes('a une creature alliee')) return 'ally_creature';

  return null;
}

function getBattlecryEffectNorm(card) {
  for (const p of [card.passif1, card.passif2]) {
    const n = norm(p);
    if (n.startsWith('cri de guerre :')) {
      return n.replace(/^cri de guerre\s*:\s*/, '').trim();
    }
  }
  return null;
}

function getCurrentDuel() {
  return currentDuel;
}

async function createPendingDuel({
  player1,
  player2,
  channelId,
  publicMessageId,
  challengerInteraction,
  onTimeoutCallback,
  onMatchEndCallback
}) {
  // Si un simple duel contre le Bot était ouvert, le duel PvP Discord prend la priorité
  if (currentDuel && !currentDuel.isBotMatch && ['pending', 'deck_select', 'active'].includes(currentDuel.status)) {
    throw new Error('Un duel entre joueurs est déjà en attente ou en cours sur le serveur.');
  }

  const matchId = `duel_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

  await pool.query(
    `INSERT INTO matches (match_id, player1_id, player2_id, status, state_json)
     VALUES (?, ?, ?, 'pending', '{}')`,
    [matchId, player1.discord_id, player2.discord_id]
  );

  currentDuel = {
    matchId,
    isBotMatch: false,
    status: 'pending',
    createdAt: Date.now(),
    channelId,
    publicMessageId,
    challengerInteraction,
    onMatchEndCallback,
    acceptTimer: null,
    uidCounter: 1,
    logs: [],
    turnNumber: 1,
    activePlayerKey: null,
    winnerKey: null,
    winReason: '',
    rewardPackGranted: false,
    players: {
      p1: {
        key: 'p1',
        discord_id: String(player1.discord_id),
        username: player1.username,
        avatar_url: player1.avatar_url || '/assets/avatars/dnn.png',
        selectedDeckSlot: null,
        deckName: '',
        hp: HERO_START_HP,
        maxHp: HERO_START_HP,
        mana: 0,
        maxMana: 0,
        turnsTaken: 0,
        fatigue: 0,
        deck: [],
        hand: [],
        board: [],
        graveyard: []
      },
      p2: {
        key: 'p2',
        discord_id: String(player2.discord_id),
        username: player2.username,
        avatar_url: player2.avatar_url || '/assets/avatars/dnn.png',
        selectedDeckSlot: null,
        deckName: '',
        hp: HERO_START_HP,
        maxHp: HERO_START_HP,
        mana: 0,
        maxMana: 0,
        turnsTaken: 0,
        fatigue: 0,
        deck: [],
        hand: [],
        board: [],
        graveyard: []
      }
    }
  };

  currentDuel.acceptTimer = setTimeout(async () => {
    if (currentDuel && currentDuel.matchId === matchId && currentDuel.status === 'pending') {
      const expiredDuel = currentDuel;
      currentDuel = null;
      await pool.query(`UPDATE matches SET status = 'expired' WHERE match_id = ?`, [matchId]).catch(() => {});
      if (onTimeoutCallback) {
        await onTimeoutCallback(expiredDuel);
      }
    }
  }, ACCEPT_TIMEOUT_MS);

  return currentDuel;
}

// Crée un duel d'entraînement contre le Bot directement depuis l'interface Web
async function createBotTrainingDuel(player1, resolveAvatarUrlFn) {
  // Si un vrai duel PvP entre deux joueurs est en cours, on ne l'écrase pas
  if (currentDuel && !currentDuel.isBotMatch && ['pending', 'deck_select', 'active'].includes(currentDuel.status)) {
    throw new Error('Un duel entre joueurs est déjà en cours sur le serveur.');
  }

  // Si le joueur n'a pas encore sauvegardé de deck valide (20-30 cartes uniques),
  // on lui compose automatiquement son Deck #1 avec 25 cartes uniques de sa collection !
  let p1Decks = await getPlayerDecks(player1.discord_id);
  let hasValidDeck = p1Decks.some(d => d.is_valid);

  if (!hasValidDeck) {
    const col = await getPlayerCollection(player1.discord_id);
    const ownedUnique = col.filter(c => (Number(c.owned_quantity) || 0) > 0);
    if (ownedUnique.length < 20) {
      throw new Error(`Tu possèdes seulement ${ownedUnique.length} carte(s) unique(s). Il en faut au moins 20 pour former un deck (utilise /commencer ou /ouvrir sur Discord).`);
    }
    const autoDeckIds = shuffleArray(ownedUnique).slice(0, Math.min(25, ownedUnique.length)).map(c => String(c.card_id));
    await savePlayerDeck(player1.discord_id, 1, 'Deck Auto #1', autoDeckIds);
    p1Decks = await getPlayerDecks(player1.discord_id);
  }

  const matchId = `bot_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;

  // Générer un deck de 25 cartes uniques pour le Bot
  const { tirage } = await drawBalancedCompleteCards(60);
  const botUniqueMap = new Map();
  for (const c of tirage) {
    if (!botUniqueMap.has(c.card_id) && botUniqueMap.size < 25) {
      botUniqueMap.set(c.card_id, {
        ...c,
        cout: Number(c.cout) || 1,
        attaque: Number(c.attaque) || 1,
        vie: Number(c.vie) || 1,
        avatar_url: resolveAvatarUrlFn ? resolveAvatarUrlFn(c.card_id, c.alignment) : '/assets/avatars/dnn.png'
      });
    }
  }

  currentDuel = {
    matchId,
    isBotMatch: true,
    status: 'deck_select',
    createdAt: Date.now(),
    channelId: null,
    publicMessageId: null,
    challengerInteraction: null,
    onMatchEndCallback: null,
    acceptTimer: null,
    uidCounter: 1,
    logs: [],
    turnNumber: 1,
    activePlayerKey: null,
    winnerKey: null,
    winReason: '',
    rewardPackGranted: false,
    players: {
      p1: {
        key: 'p1',
        discord_id: String(player1.discord_id),
        username: player1.username,
        avatar_url: player1.avatar_url || '/assets/avatars/dnn.png',
        selectedDeckSlot: null,
        deckName: '',
        hp: HERO_START_HP,
        maxHp: HERO_START_HP,
        mana: 0,
        maxMana: 0,
        turnsTaken: 0,
        fatigue: 0,
        deck: [],
        hand: [],
        board: [],
        graveyard: []
      },
      p2: {
        key: 'p2',
        discord_id: BOT_DISCORD_ID,
        username: 'kOkamini',
        avatar_url: '/assets/chao.jpg',
        selectedDeckSlot: 1,
        deckName: 'Deck IA Chaomon',
        hp: HERO_START_HP,
        maxHp: HERO_START_HP,
        mana: 0,
        maxMana: 0,
        turnsTaken: 0,
        fatigue: 0,
        deck: [],
        hand: [],
        board: [],
        graveyard: []
      }
    }
  };

  currentDuel.players.p2.deck = shuffleArray(Array.from(botUniqueMap.values())).map(c =>
    createCardInstance(currentDuel, c, 'p2')
  );

  addLog(currentDuel, `🤖 Duel d'entraînement initialisé contre kOkamini ! Choisis ton deck pour commencer.`);
  return currentDuel;
}

async function cancelPendingDuel(reason = 'cancelled') {
  if (!currentDuel) return null;
  const duel = currentDuel;
  if (duel.acceptTimer) clearTimeout(duel.acceptTimer);
  currentDuel = null;
  await pool.query(`UPDATE matches SET status = ? WHERE match_id = ?`, [reason, duel.matchId]).catch(() => {});
  return duel;
}

async function acceptPendingDuel(matchId) {
  if (!currentDuel || currentDuel.matchId !== matchId || currentDuel.status !== 'pending') {
    throw new Error("Ce défi n'est plus valide ou a expiré.");
  }
  if (currentDuel.acceptTimer) {
    clearTimeout(currentDuel.acceptTimer);
    currentDuel.acceptTimer = null;
  }
  currentDuel.status = 'deck_select';
  addLog(currentDuel, `⚔️ ${currentDuel.players.p2.username} a accepté le duel ! En attente du choix des decks...`);
  await pool.query(`UPDATE matches SET status = 'deck_select' WHERE match_id = ?`, [matchId]);
  return currentDuel;
}

function getPlayerKeyByDiscordId(duel, discordId) {
  if (!duel || !discordId) return null;
  const idStr = String(discordId);
  if (duel.players.p1.discord_id === idStr) return 'p1';
  if (duel.players.p2.discord_id === idStr) return 'p2';
  return null;
}

function getOpponentKey(playerKey) {
  return playerKey === 'p1' ? 'p2' : 'p1';
}

function addLog(duel, message) {
  const time = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  duel.logs.push(`[${time}] ${message}`);
  if (duel.logs.length > 80) duel.logs.shift();
}

async function selectDeckForPlayer(matchId, discordId, slotNumber, resolveAvatarUrlFn) {
  if (!currentDuel || (matchId && currentDuel.matchId !== matchId)) {
    throw new Error('Duel introuvable ou terminé.');
  }
  if (currentDuel.status !== 'deck_select') {
    return currentDuel;
  }

  const pKey = getPlayerKeyByDiscordId(currentDuel, discordId);
  if (!pKey) throw new Error('Tu ne participes pas à ce duel.');

  const pState = currentDuel.players[pKey];
  // Verrouillage immédiat AVANT les await pour empêcher tout double appel (Socket.io + HTTP ou double clic)
  if (pState.selectedDeckSlot || pState.isLockingDeck) {
    return currentDuel;
  }
  pState.isLockingDeck = true;

  try {
    const decks = await getPlayerDecks(discordId);
    const chosen = decks.find(d => d.slot_number === Number(slotNumber));
    if (!chosen || !chosen.is_valid) {
      pState.isLockingDeck = false;
      throw new Error('Ce deck est invalide (il doit contenir entre 20 et 30 cartes uniques).');
    }

    // Garantie absolue d'unicité : 1 seul exemplaire maximum par card_id et par nom
    const seenCardIds = new Set();
    const seenCardNames = new Set();
    const fullCards = [];

    for (const rawCid of chosen.cards) {
      const cid = String(rawCid || '').trim();
      if (!cid || seenCardIds.has(cid)) continue;

      const c = await getCardById(cid);
      if (!c) continue;

      const nameKey = String(c.display_name || cid).toLowerCase().trim();
      if (seenCardNames.has(nameKey)) continue;

      seenCardIds.add(cid);
      seenCardNames.add(nameKey);

      fullCards.push({
        ...c,
        cout: Number(c.cout) || 0,
        attaque: Number(c.attaque) || 0,
        vie: Number(c.vie) || 1,
        avatar_url: resolveAvatarUrlFn ? resolveAvatarUrlFn(c.card_id, c.alignment) : `/assets/avatars/${c.card_id}.png`
      });
    }

    pState.selectedDeckSlot = chosen.slot_number;
    pState.deckName = chosen.name;
    pState.hand = [];
    pState.board = [];
    pState.graveyard = [];
    pState.deck = shuffleArray(fullCards).map(c => createCardInstance(currentDuel, c, pKey));

    addLog(currentDuel, `✅ ${pState.username} a verrouillé son deck « ${chosen.name} » (${pState.deck.length} cartes uniques).`);

    if (
      currentDuel.status === 'deck_select' &&
      currentDuel.players.p1.selectedDeckSlot &&
      currentDuel.players.p2.selectedDeckSlot
    ) {
      await startActiveMatch(currentDuel);
    }

    return currentDuel;
  } catch (err) {
    pState.isLockingDeck = false;
    throw err;
  }
}

function createCardInstance(duel, cardData, ownerKey) {
  return {
    uid: `c_${duel.uidCounter++}`,
    card_id: cardData.card_id,
    display_name: cardData.display_name,
    username: cardData.username,
    rarity: cardData.rarity || 'Commune',
    alignment: cardData.alignment || '',
    creature: cardData.creature || 'Entité Mystérieuse',
    explanation: cardData.explanation || '',
    cout: Number(cardData.cout) || 0,
    baseAtk: Number(cardData.attaque) || 0,
    baseHp: Number(cardData.vie) || 1,
    currentHp: Number(cardData.vie) || 1,
    maxHp: Number(cardData.vie) || 1,
    permAtkBonus: 0,
    permHpBonus: 0,
    tempAtkBonus: 0,
    tempHpBonus: 0,
    passif1: cardData.passif1 || '',
    passif2: cardData.passif2 || '',
    actif1: cardData.actif1 || '',
    actif2: cardData.actif2 || '',
    avatar_url: cardData.avatar_url || '/assets/avatars/dnn.png',
    ownerKey,
    originalOwnerKey: ownerKey,
    isToken: false,
    silenced: false,
    tapped: false,
    attacksThisTurn: 0,
    summonedThisTurn: true,
    frozen: false,
    stealth: false,
    divineShield: false,
    reborn: false,
    tempIndestructible: false,
    tempControlledUntilEndOfTurn: false
  };
}

function initCreatureKeywordsOnSummon(unit) {
  unit.summonedThisTurn = true;
  unit.tapped = false;
  unit.attacksThisTurn = 0;
  unit.tempIndestructible = false;
  if (unit.silenced) return;

  const pText = norm(`${unit.passif1} | ${unit.passif2}`);
  unit.divineShield = /\bbouclier divin\b/.test(pText);
  unit.stealth = /\bcamouflage\b/.test(pText);
  unit.reborn = /\brenaissance\b/.test(pText);
}

async function startActiveMatch(duel) {
  if (duel.status === 'active') return;
  duel.status = 'active';

  // Réinitialise proprement les mains avant la distribution initiale
  duel.players.p1.hand = [];
  duel.players.p2.hand = [];
  duel.players.p1.turnsTaken = 0;
  duel.players.p2.turnsTaken = 0;

  const firstKey = duel.isBotMatch ? 'p1' : (Math.random() < 0.5 ? 'p1' : 'p2');
  const secondKey = getOpponentKey(firstKey);
  duel.activePlayerKey = firstKey;
  duel.turnNumber = 1;

  addLog(duel, `🎲 Tirage au sort : ${duel.players[firstKey].username} joue en premier (3 cartes), ${duel.players[secondKey].username} joue en second (4 cartes).`);

  for (let i = 0; i < 3; i++) drawCard(duel, firstKey, false);
  for (let i = 0; i < 4; i++) drawCard(duel, secondKey, false);

  beginPlayerTurn(duel, firstKey);
  if (!duel.isBotMatch) {
    await pool.query(`UPDATE matches SET status = 'active' WHERE match_id = ?`, [duel.matchId]).catch(() => {});
  }
}

function hasKeyword(duel, unit, keywordNorm) {
  if (unit.silenced) return false;
  const pText = norm(`${unit.passif1} | ${unit.passif2}`);
  if (new RegExp(`\\b${keywordNorm}\\b`).test(pText)) return true;

  if (keywordNorm === 'vol') {
    const owner = duel.players[unit.ownerKey];
    for (const ally of owner.board) {
      if (ally.uid !== unit.uid && !ally.silenced) {
        const allyP = norm(`${ally.passif1} | ${ally.passif2}`);
        if (allyP.includes('aura : vos autres creatures gagnent vol')) {
          return true;
        }
      }
    }
  }
  return false;
}

function getActiveCostReduction(duel, playerKey) {
  let reduction = 0;
  for (const ally of duel.players[playerKey].board) {
    if (ally.silenced) continue;
    for (const p of [ally.passif1, ally.passif2]) {
      const n = norm(p);
      if (n.includes('aura : vos capacites actives coutent 2 mana de moins')) reduction += 2;
      else if (n.includes('aura : vos capacites actives coutent 1 mana de moins')) reduction += 1;
    }
  }
  return reduction;
}

function recomputeBoardAuras(duel) {
  for (const pKey of ['p1', 'p2']) {
    const oppKey = getOpponentKey(pKey);
    const allies = duel.players[pKey].board;
    const enemies = duel.players[oppKey].board;

    let enemyAtkPenalty = 0;
    for (const en of enemies) {
      if (en.silenced) continue;
      for (const p of [en.passif1, en.passif2]) {
        const n = norm(p);
        if (n.includes('aura : les creatures ennemies perdent 2 atk')) enemyAtkPenalty += 2;
        else if (n.includes('aura : les creatures ennemies perdent 1 atk')) enemyAtkPenalty += 1;
      }
    }

    for (const unit of allies) {
      let auraAtk = 0;
      let auraHp = 0;
      for (const other of allies) {
        if (other.uid === unit.uid || other.silenced) continue;
        for (const p of [other.passif1, other.passif2]) {
          const n = norm(p);
          if (n.includes('aura : vos autres creatures gagnent +2/+2')) { auraAtk += 2; auraHp += 2; }
          else if (n.includes('aura : vos autres creatures gagnent +1/+1')) { auraAtk += 1; auraHp += 1; }
          else if (n.includes('aura : vos autres creatures gagnent +1/+0')) { auraAtk += 1; }
          else if (n.includes('aura : vos autres creatures gagnent +0/+1')) { auraHp += 1; }
        }
      }

      const newMaxHp = Math.max(1, unit.baseHp + unit.permHpBonus + unit.tempHpBonus + auraHp);
      const hpDiff = newMaxHp - unit.maxHp;
      unit.maxHp = newMaxHp;
      if (hpDiff > 0) unit.currentHp += hpDiff;
      if (unit.currentHp > unit.maxHp) unit.currentHp = unit.maxHp;

      let enrageBonus = 0;
      if (!unit.silenced && unit.currentHp < unit.maxHp) {
        const pText = norm(`${unit.passif1} | ${unit.passif2}`);
        if (pText.includes('enrage : +2 atk')) enrageBonus = 2;
      }

      if (hasKeyword(duel, unit, 'defenseur')) {
        unit.effectiveAtk = 0;
      } else {
        const penalty = hasKeyword(duel, unit, 'immunite') ? 0 : enemyAtkPenalty;
        unit.effectiveAtk = Math.max(
          0,
          unit.baseAtk + unit.permAtkBonus + unit.tempAtkBonus + auraAtk + enrageBonus - penalty
        );
      }
    }
  }
}

function drawCard(duel, playerKey, logDraw = true) {
  const player = duel.players[playerKey];
  if (player.deck.length === 0) {
    player.fatigue += 1;
    player.hp -= player.fatigue;
    addLog(duel, `💀 Fatigue ! ${player.username} n'a plus de cartes dans son deck et subit ${player.fatigue} dégât(s) de fatigue (PV : ${player.hp}).`);
    checkWinCondition(duel);
    return;
  }

  const card = player.deck.shift();
  if (player.hand.length >= MAX_HAND_SIZE) {
    player.graveyard.push(card);
    addLog(duel, `🔥 Main pleine (${MAX_HAND_SIZE} cartes) ! La carte piochée par ${player.username} (« ${card.display_name} ») est envoyée au cimetière.`);
    return;
  }

  player.hand.push(card);
  if (logDraw) {
    addLog(duel, `🃏 ${player.username} pioche une carte.`);
  }
}

function summonToken(duel, playerKey, atk, hp) {
  const player = duel.players[playerKey];
  if (player.board.length >= MAX_BOARD_SIZE) {
    addLog(duel, `⚠️ Terrain plein (${MAX_BOARD_SIZE} créatures max) : impossible d'invoquer le Jeton ${atk}/${hp}.`);
    return null;
  }

  const token = {
    uid: `tok_${duel.uidCounter++}`,
    card_id: `token_${atk}_${hp}`,
    display_name: `Jeton ${atk}/${hp}`,
    username: 'jeton',
    rarity: 'Commune',
    alignment: 'Neutre Strict',
    creature: 'Invocation',
    explanation: 'Jeton invoqué par une capacité.',
    cout: Math.min(10, Math.max(1, Math.round((atk + hp) / 2))),
    baseAtk: atk,
    baseHp: hp,
    currentHp: hp,
    maxHp: hp,
    effectiveAtk: atk,
    permAtkBonus: 0,
    permHpBonus: 0,
    tempAtkBonus: 0,
    tempHpBonus: 0,
    passif1: '',
    passif2: '',
    actif1: '',
    actif2: '',
    avatar_url: '/assets/avatars/dnn.png',
    ownerKey: playerKey,
    originalOwnerKey: playerKey,
    isToken: true,
    silenced: false,
    tapped: false,
    attacksThisTurn: 0,
    summonedThisTurn: true,
    frozen: false,
    stealth: false,
    divineShield: false,
    reborn: false,
    tempIndestructible: false,
    tempControlledUntilEndOfTurn: false
  };

  player.board.push(token);
  recomputeBoardAuras(duel);
  addLog(duel, `✨ ${player.username} invoque un Jeton ${atk}/${hp}.`);
  return token;
}

function beginPlayerTurn(duel, playerKey) {
  if (duel.status !== 'active') return;
  const player = duel.players[playerKey];
  const oppKey = getOpponentKey(playerKey);

  duel.activePlayerKey = playerKey;
  player.turnsTaken += 1;
  player.maxMana = Math.min(MAX_MANA, player.turnsTaken);
  player.mana = player.maxMana;

  for (const unit of player.board) {
    unit.tapped = false;
    unit.attacksThisTurn = 0;
    unit.summonedThisTurn = false;
    unit.tempIndestructible = false;
  }

  addLog(duel, `🔔 Début du tour de ${player.username} (Tour ${player.turnsTaken} — ${player.mana}/${player.maxMana} Mana).`);

  drawCard(duel, playerKey, true);
  if (duel.status !== 'active') return;

  for (const unit of [...player.board]) {
    if (unit.silenced) continue;
    for (const p of [unit.passif1, unit.passif2]) {
      const n = norm(p);
      if (n.includes('debut de votre tour : infliger 1 degat a une creature ennemie aleatoire')) {
        const enemies = duel.players[oppKey].board.filter(e => !hasKeyword(duel, e, 'immunite'));
        if (enemies.length > 0) {
          const target = enemies[Math.floor(Math.random() * enemies.length)];
          addLog(duel, `⚡ [${unit.display_name}] inflige 1 dégât à ${target.display_name}.`);
          dealDamageToCreature(duel, target, 1, unit);
        }
      }
    }
  }

  recomputeBoardAuras(duel);
  processDeaths(duel);
  checkWinCondition(duel);
}

function endPlayerTurn(duel, discordId) {
  if (!duel || duel.status !== 'active') throw new Error("Le duel n'est pas actif.");
  const playerKey = getPlayerKeyByDiscordId(duel, discordId);
  if (playerKey !== duel.activePlayerKey) {
    throw new Error("Ce n'est pas ton tour !");
  }

  const player = duel.players[playerKey];
  const oppKey = getOpponentKey(playerKey);

  for (const unit of [...player.board]) {
    if (unit.silenced) continue;
    for (const p of [unit.passif1, unit.passif2]) {
      const n = norm(p);
      if (n.includes('fin de votre tour : soigner 2 pv a une creature alliee')) {
        const wounded = player.board.filter(a => a.currentHp < a.maxHp);
        const target = wounded.length > 0
          ? wounded.sort((a, b) => (b.maxHp - b.currentHp) - (a.maxHp - a.currentHp))[0]
          : unit;
        healCreature(duel, target, 2);
        addLog(duel, `💚 [${unit.display_name}] soigne 2 PV à ${target.display_name}.`);
      } else if (n.includes('fin de votre tour : invoquer un jeton 1/1')) {
        summonToken(duel, playerKey, 1, 1);
      } else if (n.includes('fin de votre tour : gagner +1/+1 definitivement')) {
        unit.permAtkBonus += 1;
        unit.permHpBonus += 1;
        unit.maxHp += 1;
        unit.currentHp += 1;
        addLog(duel, `📈 [${unit.display_name}] gagne +1/+1 définitivement.`);
      }
    }
  }

  for (const k of ['p1', 'p2']) {
    for (const u of [...duel.players[k].board]) {
      u.tempAtkBonus = 0;
      u.tempHpBonus = 0;
      u.tempIndestructible = false;
      recomputeBoardAuras(duel);

      if (hasKeyword(duel, u, 'regeneration') && u.currentHp < u.maxHp) {
        u.currentHp = u.maxHp;
        addLog(duel, `🌿 Régénération : ${u.display_name} récupère tous ses PV (${u.maxHp}).`);
      }
    }
  }

  for (const u of [...player.board]) {
    if (u.tempControlledUntilEndOfTurn) {
      u.tempControlledUntilEndOfTurn = false;
      const idx = player.board.findIndex(x => x.uid === u.uid);
      if (idx !== -1) player.board.splice(idx, 1);
      if (duel.players[oppKey].board.length < MAX_BOARD_SIZE) {
        u.ownerKey = oppKey;
        u.tapped = false;
        duel.players[oppKey].board.push(u);
        addLog(duel, `🔄 ${u.display_name} retourne sous le contrôle de ${duel.players[oppKey].username}.`);
      } else {
        duel.players[oppKey].graveyard.push(u);
      }
    }
  }

  for (const u of player.board) {
    if (u.frozen && u.attacksThisTurn === 0) {
      u.frozen = false;
    }
  }

  recomputeBoardAuras(duel);
  processDeaths(duel);
  if (checkWinCondition(duel)) return duel;

  duel.turnNumber += 1;
  beginPlayerTurn(duel, oppKey);
  return duel;
}

function dealDamageToHero(duel, targetPlayerKey, amount, sourceUnit = null) {
  if (amount <= 0) return 0;
  const targetPlayer = duel.players[targetPlayerKey];
  targetPlayer.hp -= amount;

  if (sourceUnit && hasKeyword(duel, sourceUnit, 'lien de vie')) {
    healHero(duel, sourceUnit.ownerKey, amount);
    addLog(duel, `💖 Lien de vie : ${duel.players[sourceUnit.ownerKey].username} récupère ${amount} PV.`);
  }
  return amount;
}

function healHero(duel, targetPlayerKey, amount) {
  if (amount <= 0) return;
  const p = duel.players[targetPlayerKey];
  p.hp = Math.min(p.maxHp, p.hp + amount);
}

function healCreature(duel, unit, amount) {
  if (amount <= 0) return;
  unit.currentHp = Math.min(unit.maxHp, unit.currentHp + amount);
  recomputeBoardAuras(duel);
}

function dealDamageToCreature(duel, targetUnit, amount, sourceUnit = null) {
  if (amount <= 0) return 0;

  if (hasKeyword(duel, targetUnit, 'immunite')) {
    addLog(duel, `🛡️ Immunité : ${targetUnit.display_name} ne subit aucun dégât.`);
    return 0;
  }

  if (targetUnit.divineShield) {
    targetUnit.divineShield = false;
    addLog(duel, `✨ Le Bouclier divin de ${targetUnit.display_name} absorbe les dégâts !`);
    return 0;
  }

  targetUnit.currentHp -= amount;

  if (targetUnit.currentHp <= 0 && (hasKeyword(duel, targetUnit, 'indestructible') || targetUnit.tempIndestructible)) {
    targetUnit.currentHp = 1;
    addLog(duel, `🛡️ Indestructible : ${targetUnit.display_name} survit à 1 PV !`);
  }

  if (
    sourceUnit &&
    amount > 0 &&
    hasKeyword(duel, sourceUnit, 'contact mortel') &&
    !hasKeyword(duel, targetUnit, 'indestructible') &&
    !targetUnit.tempIndestructible
  ) {
    targetUnit.currentHp = 0;
    addLog(duel, `☠️ Contact mortel : ${sourceUnit.display_name} condamne ${targetUnit.display_name} !`);
  }

  if (sourceUnit && hasKeyword(duel, sourceUnit, 'lien de vie')) {
    healHero(duel, sourceUnit.ownerKey, amount);
    addLog(duel, `💖 Lien de vie : ${duel.players[sourceUnit.ownerKey].username} récupère ${amount} PV.`);
  }

  recomputeBoardAuras(duel);
  return amount;
}

function destroyCreature(duel, targetUnit) {
  if (
    hasKeyword(duel, targetUnit, 'immunite') ||
    hasKeyword(duel, targetUnit, 'indestructible') ||
    targetUnit.tempIndestructible
  ) {
    addLog(duel, `🛡️ ${targetUnit.display_name} résiste à la destruction (Indestructible / Immunité).`);
    return false;
  }
  targetUnit.currentHp = 0;
  targetUnit.forceDestroyed = true;
  return true;
}

function silenceCreature(duel, targetUnit) {
  targetUnit.silenced = true;
  targetUnit.divineShield = false;
  targetUnit.stealth = false;
  targetUnit.reborn = false;
  targetUnit.tempIndestructible = false;
  recomputeBoardAuras(duel);
  addLog(duel, `🤫 ${targetUnit.display_name} est réduit au silence et perd toutes ses capacités.`);
}

function processDeaths(duel, killerUnit = null) {
  let anyDied = false;

  for (const pKey of ['p1', 'p2']) {
    const player = duel.players[pKey];
    const survivors = [];
    const deadUnits = [];

    for (const u of player.board) {
      if (u.currentHp <= 0 || u.forceDestroyed) {
        deadUnits.push(u);
      } else {
        survivors.push(u);
      }
    }

    if (deadUnits.length > 0) {
      anyDied = true;
      player.board = survivors;

      for (const dead of deadUnits) {
        if (!dead.isToken) {
          duel.players[dead.originalOwnerKey].graveyard.push(dead);
        }
        addLog(duel, `🪦 ${dead.display_name} (${player.username}) est détruit.`);

        if (killerUnit && killerUnit.currentHp > 0 && !killerUnit.silenced) {
          const kp = norm(`${killerUnit.passif1} | ${killerUnit.passif2}`);
          if (kp.includes('quand elle detruit une creature : se soigner entierement')) {
            killerUnit.currentHp = killerUnit.maxHp;
            addLog(duel, `💚 [${killerUnit.display_name}] se soigne entièrement après avoir détruit ${dead.display_name} !`);
          }
        }

        for (const ally of player.board) {
          if (ally.silenced) continue;
          const ap = norm(`${ally.passif1} | ${ally.passif2}`);
          if (ap.includes('quand une autre creature alliee est detruite : gagner +1/+1 definitivement')) {
            ally.permAtkBonus += 1;
            ally.permHpBonus += 1;
            ally.maxHp += 1;
            ally.currentHp += 1;
            addLog(duel, `📈 [${ally.display_name}] gagne +1/+1 suite à la mort de ${dead.display_name}.`);
          }
        }

        if (!dead.silenced) {
          triggerDeathrattles(duel, dead, pKey);
        }

        if (!dead.silenced && dead.reborn && player.board.length < MAX_BOARD_SIZE) {
          const rebornCopy = createCardInstance(duel, dead, pKey);
          initCreatureKeywordsOnSummon(rebornCopy);
          rebornCopy.reborn = false;
          rebornCopy.currentHp = 1;
          player.board.push(rebornCopy);
          addLog(duel, `🔥 Renaissance : ${dead.display_name} revient à la vie avec 1 PV !`);
        }
      }
    }
  }

  recomputeBoardAuras(duel);
  if (anyDied) {
    processDeaths(duel, null);
  }
}

function triggerDeathrattles(duel, deadUnit, ownerKey) {
  const oppKey = getOpponentKey(ownerKey);

  for (const raw of [deadUnit.passif1, deadUnit.passif2]) {
    const n = norm(raw);
    if (!n.startsWith("rale d'agonie :")) continue;
    const eff = n.replace(/^rale d'agonie\s*:\s*/, '').trim();

    const mDmgRand = eff.match(/infliger\s+(\d+)\s*degats?\s+a une creature ennemie aleatoire/);
    if (mDmgRand) {
      const dmg = parseInt(mDmgRand[1], 10);
      const enemies = duel.players[oppKey].board.filter(e => !hasKeyword(duel, e, 'immunite'));
      if (enemies.length > 0) {
        const target = enemies[Math.floor(Math.random() * enemies.length)];
        addLog(duel, `💀 Râle d'agonie (${deadUnit.display_name}) : ${dmg} dégât(s) sur ${target.display_name}.`);
        dealDamageToCreature(duel, target, dmg, deadUnit);
      }
      continue;
    }

    const mToken = eff.match(/invoquer un jeton\s+(\d+)\/(\d+)/);
    if (mToken) {
      summonToken(duel, ownerKey, parseInt(mToken[1], 10), parseInt(mToken[2], 10));
      continue;
    }

    const mDraw = eff.match(/piocher\s+(\d+)\s*cartes?/);
    if (mDraw) {
      const count = parseInt(mDraw[1], 10);
      for (let i = 0; i < count; i++) drawCard(duel, ownerKey, true);
      continue;
    }

    if (eff.includes('infliger 2 degats a toutes les creatures')) {
      addLog(duel, `💥 Râle d'agonie (${deadUnit.display_name}) : 2 dégâts à toutes les créatures !`);
      for (const k of ['p1', 'p2']) {
        for (const u of [...duel.players[k].board]) {
          dealDamageToCreature(duel, u, 2, deadUnit);
        }
      }
      continue;
    }

    if (eff.includes('detruire une creature ennemie aleatoire')) {
      const enemies = duel.players[oppKey].board.filter(
        e => !hasKeyword(duel, e, 'immunite') && !hasKeyword(duel, e, 'indestructible') && !e.tempIndestructible
      );
      if (enemies.length > 0) {
        const target = enemies[Math.floor(Math.random() * enemies.length)];
        addLog(duel, `💀 Râle d'agonie (${deadUnit.display_name}) détruit ${target.display_name} !`);
        destroyCreature(duel, target);
      }
    }
  }
}

function findTargetUnit(duel, targetId) {
  if (!targetId) return null;
  for (const k of ['p1', 'p2']) {
    const found = duel.players[k].board.find(u => u.uid === targetId);
    if (found) return { unit: found, ownerKey: k };
  }
  return null;
}

function validateTarget(duel, actorKey, targetType, targetId, isEnemyEffect = true) {
  if (!targetType) return null;
  const oppKey = getOpponentKey(actorKey);

  if (targetType === 'any') {
    if (targetId === 'hero_p1' || targetId === 'hero_p2') {
      return { kind: 'hero', playerKey: targetId === 'hero_p1' ? 'p1' : 'p2' };
    }
  }

  const found = findTargetUnit(duel, targetId);
  if (!found) {
    throw new Error('Sélectionne une cible valide pour cet effet.');
  }

  const { unit, ownerKey } = found;

  if (targetType === 'enemy_creature' && ownerKey !== oppKey) {
    throw new Error('Tu dois cibler une créature ennemie.');
  }
  if (targetType === 'ally_creature' && ownerKey !== actorKey) {
    throw new Error('Tu dois cibler une créature alliée.');
  }

  if (ownerKey === oppKey) {
    if (unit.stealth) {
      throw new Error(`Impossible de cibler ${unit.display_name} tant qu'elle a Camouflage.`);
    }
    if (hasKeyword(duel, unit, 'insaisissable')) {
      throw new Error(`${unit.display_name} est Insaisissable et ne peut pas être ciblée par tes pouvoirs.`);
    }
    if (isEnemyEffect && hasKeyword(duel, unit, 'immunite')) {
      throw new Error(`${unit.display_name} possède Immunité et ne peut pas être affectée négativement.`);
    }
  }

  return { kind: 'unit', unit, ownerKey };
}

function executeEffect(duel, actorKey, sourceUnit, effectNorm, targetId) {
  const oppKey = getOpponentKey(actorKey);
  const targetType = getEffectTargetType(effectNorm);

  const isHelpful = effectNorm.startsWith('soigner') || effectNorm.startsWith('donner +') || effectNorm.includes('bouclier divin');

  let resolvedTarget = null;
  if (targetType) {
    const hasValidCandidate = checkIfAnyValidTargetExists(duel, actorKey, targetType, !isHelpful);
    if (hasValidCandidate) {
      resolvedTarget = validateTarget(duel, actorKey, targetType, targetId, !isHelpful);
    } else {
      addLog(duel, `ℹ️ Aucune cible valide disponible pour l'effet de ${sourceUnit.display_name}.`);
      return;
    }
  }

  let m = effectNorm.match(/^soigner\s+(\d+)\s*pv\s+a une (cible|creature alliee)/);
  if (m && resolvedTarget) {
    const healAmt = parseInt(m[1], 10);
    if (resolvedTarget.kind === 'hero') {
      healHero(duel, resolvedTarget.playerKey, healAmt);
      addLog(duel, `💚 ${sourceUnit.display_name} soigne ${healAmt} PV à ${duel.players[resolvedTarget.playerKey].username}.`);
    } else {
      healCreature(duel, resolvedTarget.unit, healAmt);
      addLog(duel, `💚 ${sourceUnit.display_name} soigne ${healAmt} PV à ${resolvedTarget.unit.display_name}.`);
    }
    return;
  }

  m = effectNorm.match(/^soigner\s+(\d+)\s*pv\s+a toutes vos creatures/);
  if (m) {
    const healAmt = parseInt(m[1], 10);
    for (const ally of duel.players[actorKey].board) {
      healCreature(duel, ally, healAmt);
    }
    addLog(duel, `💚 ${sourceUnit.display_name} soigne ${healAmt} PV à toutes vos créatures.`);
    return;
  }

  m = effectNorm.match(/^infliger\s+(\d+)\s*degats?\s+a une cible/);
  if (m && resolvedTarget) {
    const dmg = parseInt(m[1], 10);
    if (resolvedTarget.kind === 'hero') {
      dealDamageToHero(duel, resolvedTarget.playerKey, dmg, sourceUnit);
      addLog(duel, `🔥 ${sourceUnit.display_name} inflige ${dmg} dégât(s) à ${duel.players[resolvedTarget.playerKey].username}.`);
    } else {
      dealDamageToCreature(duel, resolvedTarget.unit, dmg, sourceUnit);
      addLog(duel, `🔥 ${sourceUnit.display_name} inflige ${dmg} dégât(s) à ${resolvedTarget.unit.display_name}.`);
    }
    return;
  }

  m = effectNorm.match(/^infliger\s+(\d+)\s*degats?\s+a toutes les creatures ennemies/);
  if (m) {
    const dmg = parseInt(m[1], 10);
    addLog(duel, `💥 ${sourceUnit.display_name} inflige ${dmg} dégât(s) à toutes les créatures ennemies !`);
    for (const en of [...duel.players[oppKey].board]) {
      dealDamageToCreature(duel, en, dmg, sourceUnit);
    }
    return;
  }

  m = effectNorm.match(/^infliger\s+(\d+)\s*degats?\s+au heros adverse/);
  if (m) {
    const dmg = parseInt(m[1], 10);
    dealDamageToHero(duel, oppKey, dmg, sourceUnit);
    addLog(duel, `🏹 ${sourceUnit.display_name} inflige ${dmg} dégâts au héros adverse (${duel.players[oppKey].username}).`);
    return;
  }

  m = effectNorm.match(/^voler\s+(\d+)\s*pv\s+au heros adverse/);
  if (m) {
    const drain = parseInt(m[1], 10);
    duel.players[oppKey].hp -= drain;
    healHero(duel, actorKey, drain);
    addLog(duel, `🧛 ${sourceUnit.display_name} vole ${drain} PV à ${duel.players[oppKey].username} !`);
    return;
  }

  m = effectNorm.match(/^invoquer un jeton\s+(\d+)\/(\d+)/);
  if (m) {
    summonToken(duel, actorKey, parseInt(m[1], 10), parseInt(m[2], 10));
    return;
  }

  m = effectNorm.match(/^piocher\s+(\d+)\s*cartes?/);
  if (m) {
    const count = parseInt(m[1], 10);
    for (let i = 0; i < count; i++) drawCard(duel, actorKey, true);
    return;
  }

  m = effectNorm.match(/^donner\s+\+(\d+)\/\+(\d+)\s+a une creature alliee/);
  if (m && resolvedTarget && resolvedTarget.kind === 'unit') {
    const bAtk = parseInt(m[1], 10);
    const bHp = parseInt(m[2], 10);
    const isTemp = effectNorm.includes("jusqu'a la fin du tour");
    if (isTemp) {
      resolvedTarget.unit.tempAtkBonus += bAtk;
      resolvedTarget.unit.tempHpBonus += bHp;
    } else {
      resolvedTarget.unit.permAtkBonus += bAtk;
      resolvedTarget.unit.permHpBonus += bHp;
    }
    recomputeBoardAuras(duel);
    addLog(duel, `⚔️ ${sourceUnit.display_name} donne +${bAtk}/+${bHp} à ${resolvedTarget.unit.display_name}${isTemp ? ' pour ce tour' : ''}.`);
    return;
  }

  m = effectNorm.match(/^donner\s+\+(\d+)\/\+(\d+)\s+a toutes vos creatures/);
  if (m) {
    const bAtk = parseInt(m[1], 10);
    const bHp = parseInt(m[2], 10);
    for (const ally of duel.players[actorKey].board) {
      ally.tempAtkBonus += bAtk;
      ally.tempHpBonus += bHp;
    }
    recomputeBoardAuras(duel);
    addLog(duel, `📯 ${sourceUnit.display_name} donne +${bAtk}/+${bHp} à toutes vos créatures jusqu'à la fin du tour !`);
    return;
  }

  m = effectNorm.match(/^gagner\s+\+(\d+)\/\+(\d+)\s+definitivement/);
  if (m) {
    const bAtk = parseInt(m[1], 10);
    const bHp = parseInt(m[2], 10);
    sourceUnit.permAtkBonus += bAtk;
    sourceUnit.permHpBonus += bHp;
    recomputeBoardAuras(duel);
    addLog(duel, `💪 ${sourceUnit.display_name} gagne +${bAtk}/+${bHp} définitivement !`);
    return;
  }

  if (effectNorm.startsWith('geler une creature ennemie') && resolvedTarget && resolvedTarget.kind === 'unit') {
    resolvedTarget.unit.frozen = true;
    addLog(duel, `❄️ ${sourceUnit.display_name} gèle ${resolvedTarget.unit.display_name} !`);
    return;
  }

  if (effectNorm.startsWith('reduire une creature au silence') && resolvedTarget && resolvedTarget.kind === 'unit') {
    silenceCreature(duel, resolvedTarget.unit);
    return;
  }

  if (effectNorm.startsWith('donner bouclier divin a une creature alliee') && resolvedTarget && resolvedTarget.kind === 'unit') {
    resolvedTarget.unit.divineShield = true;
    addLog(duel, `✨ ${sourceUnit.display_name} confère Bouclier divin à ${resolvedTarget.unit.display_name} !`);
    return;
  }

  if (effectNorm.startsWith('devenir indestructible')) {
    sourceUnit.tempIndestructible = true;
    addLog(duel, `🛡️ ${sourceUnit.display_name} devient Indestructible jusqu'à la fin du tour !`);
    return;
  }

  if (effectNorm.startsWith('renvoyer une creature ennemie dans sa main') && resolvedTarget && resolvedTarget.kind === 'unit') {
    const target = resolvedTarget.unit;
    const enemyBoard = duel.players[oppKey].board;
    const idx = enemyBoard.findIndex(x => x.uid === target.uid);
    if (idx !== -1) enemyBoard.splice(idx, 1);

    if (!target.isToken) {
      if (duel.players[oppKey].hand.length < MAX_HAND_SIZE) {
        const freshCopy = createCardInstance(duel, target, oppKey);
        duel.players[oppKey].hand.push(freshCopy);
        addLog(duel, `🌪️ ${target.display_name} est renvoyée dans la main de ${duel.players[oppKey].username}.`);
      } else {
        duel.players[oppKey].graveyard.push(target);
        addLog(duel, `🔥 Main adverse pleine : ${target.display_name} est envoyée au cimetière !`);
      }
    } else {
      addLog(duel, `🌪️ Le jeton ${target.display_name} est dissipé.`);
    }
    recomputeBoardAuras(duel);
    return;
  }

  m = effectNorm.match(/^faire defausser\s+(\d+)\s*cartes?\s+a l'adversaire/);
  if (m) {
    const count = parseInt(m[1], 10);
    const oppHand = duel.players[oppKey].hand;
    for (let i = 0; i < count; i++) {
      if (oppHand.length === 0) break;
      const rIdx = Math.floor(Math.random() * oppHand.length);
      const [discarded] = oppHand.splice(rIdx, 1);
      duel.players[oppKey].graveyard.push(discarded);
      addLog(duel, `🗑️ ${duel.players[oppKey].username} défausse « ${discarded.display_name} » !`);
    }
    return;
  }

  m = effectNorm.match(/^detruire une creature ennemie dont l'atk est de\s+(\d+)\s+ou moins/);
  if (m && resolvedTarget && resolvedTarget.kind === 'unit') {
    const maxAtk = parseInt(m[1], 10);
    if ((resolvedTarget.unit.effectiveAtk ?? resolvedTarget.unit.baseAtk) > maxAtk) {
      throw new Error(`Cette capacité ne peut cibler qu'une créature ayant ${maxAtk} ATK ou moins.`);
    }
    destroyCreature(duel, resolvedTarget.unit);
    return;
  }

  if (effectNorm.startsWith('detruire toutes les autres creatures')) {
    addLog(duel, `🌋 Cataclysme ! ${sourceUnit.display_name} détruit toutes les autres créatures !`);
    for (const k of ['p1', 'p2']) {
      for (const u of duel.players[k].board) {
        if (u.uid !== sourceUnit.uid) {
          destroyCreature(duel, u);
        }
      }
    }
    return;
  }

  if (effectNorm.startsWith('detruire une creature ennemie') && resolvedTarget && resolvedTarget.kind === 'unit') {
    destroyCreature(duel, resolvedTarget.unit);
    return;
  }

  if (effectNorm.startsWith("prendre le controle d'une creature ennemie") || effectNorm.startsWith("prendre definitivement le controle d'une creature ennemie")) {
    if (!resolvedTarget || resolvedTarget.kind !== 'unit') return;
    if (duel.players[actorKey].board.length >= MAX_BOARD_SIZE) {
      throw new Error(`Ton terrain est plein (${MAX_BOARD_SIZE} créatures max).`);
    }
    const target = resolvedTarget.unit;
    const isTemp = effectNorm.includes("jusqu'a la fin du tour");
    const enemyBoard = duel.players[oppKey].board;
    const idx = enemyBoard.findIndex(x => x.uid === target.uid);
    if (idx !== -1) enemyBoard.splice(idx, 1);

    target.ownerKey = actorKey;
    target.tapped = false;
    target.summonedThisTurn = !isTemp;
    target.tempControlledUntilEndOfTurn = isTemp;
    duel.players[actorKey].board.push(target);
    recomputeBoardAuras(duel);
    addLog(duel, `🌀 ${duel.players[actorKey].username} prend le contrôle de ${target.display_name}${isTemp ? " jusqu'à la fin du tour" : ' définitivement'} !`);
    return;
  }

  if (effectNorm.startsWith('reanimer la derniere creature alliee detruite')) {
    const grave = duel.players[actorKey].graveyard;
    if (grave.length === 0) {
      addLog(duel, `ℹ️ Cimetière vide : aucune créature à réanimer.`);
      return;
    }
    if (duel.players[actorKey].board.length >= MAX_BOARD_SIZE) {
      addLog(duel, `⚠️ Terrain plein (${MAX_BOARD_SIZE} max) : impossible de réanimer.`);
      return;
    }
    const deadCard = grave.pop();
    const revived = createCardInstance(duel, deadCard, actorKey);
    initCreatureKeywordsOnSummon(revived);
    duel.players[actorKey].board.push(revived);
    recomputeBoardAuras(duel);
    addLog(duel, `✨ ${sourceUnit.display_name} réanime ${revived.display_name} !`);
    return;
  }

  if (effectNorm.startsWith('reanimer toutes vos creatures detruites')) {
    const grave = duel.players[actorKey].graveyard;
    let count = 0;
    while (grave.length > 0 && duel.players[actorKey].board.length < MAX_BOARD_SIZE) {
      const deadCard = grave.pop();
      const revived = createCardInstance(duel, deadCard, actorKey);
      initCreatureKeywordsOnSummon(revived);
      duel.players[actorKey].board.push(revived);
      count++;
    }
    recomputeBoardAuras(duel);
    addLog(duel, `🌟 ${sourceUnit.display_name} réanime ${count} créature(s) alliée(s) !`);
    return;
  }

  m = effectNorm.match(/^produire\s+(\d+)\s*mana/);
  if (m) {
    const gain = parseInt(m[1], 10);
    duel.players[actorKey].mana = Math.min(MAX_MANA, duel.players[actorKey].mana + gain);
    addLog(duel, `💧 ${sourceUnit.display_name} produit +${gain} mana !`);
  }
}

function checkIfAnyValidTargetExists(duel, actorKey, targetType, isEnemyEffect) {
  if (!targetType) return false;
  if (targetType === 'any') return true;

  const oppKey = getOpponentKey(actorKey);
  const canTargetUnit = (u, ownerKey) => {
    if (ownerKey === oppKey) {
      if (u.stealth) return false;
      if (hasKeyword(duel, u, 'insaisissable')) return false;
      if (isEnemyEffect && hasKeyword(duel, u, 'immunite')) return false;
    }
    return true;
  };

  if (targetType === 'ally_creature') {
    return duel.players[actorKey].board.some(u => canTargetUnit(u, actorKey));
  }
  if (targetType === 'enemy_creature') {
    return duel.players[oppKey].board.some(u => canTargetUnit(u, oppKey));
  }
  if (targetType === 'any_creature') {
    return (
      duel.players[actorKey].board.some(u => canTargetUnit(u, actorKey)) ||
      duel.players[oppKey].board.some(u => canTargetUnit(u, oppKey))
    );
  }
  return false;
}

function playCardFromHand(duel, discordId, cardUid, targetId = null) {
  if (!duel || duel.status !== 'active') throw new Error("Le duel n'est pas actif.");
  const playerKey = getPlayerKeyByDiscordId(duel, discordId);
  if (playerKey !== duel.activePlayerKey) throw new Error("Ce n'est pas ton tour !");

  const player = duel.players[playerKey];
  const handIdx = player.hand.findIndex(c => c.uid === cardUid);
  if (handIdx === -1) throw new Error('Carte introuvable dans ta main.');

  if (player.board.length >= MAX_BOARD_SIZE) {
    throw new Error(`Tu as déjà atteint la limite de ${MAX_BOARD_SIZE} créatures sur le terrain.`);
  }

  const card = player.hand[handIdx];
  if (player.mana < card.cout) {
    throw new Error(`Mana insuffisant (${player.mana}/${card.cout} mana requis).`);
  }

  const bcNorm = getBattlecryEffectNorm(card);
  if (bcNorm) {
    const tType = getEffectTargetType(bcNorm);
    const isHelpful = bcNorm.startsWith('soigner') || bcNorm.startsWith('donner +') || bcNorm.includes('bouclier divin');
    if (tType && checkIfAnyValidTargetExists(duel, playerKey, tType, !isHelpful)) {
      validateTarget(duel, playerKey, tType, targetId, !isHelpful);
    }
  }

  player.mana -= card.cout;
  player.hand.splice(handIdx, 1);
  initCreatureKeywordsOnSummon(card);
  player.board.push(card);
  recomputeBoardAuras(duel);

  addLog(duel, `🃏 ${player.username} invoque « ${card.display_name} » (${card.cout} mana).`);

  if (bcNorm) {
    executeEffect(duel, playerKey, card, bcNorm, targetId);
  }

  recomputeBoardAuras(duel);
  processDeaths(duel, card);
  checkWinCondition(duel);
  return duel;
}

function useCreatureAbility(duel, discordId, unitUid, abilityIndex, targetId = null) {
  if (!duel || duel.status !== 'active') throw new Error("Le duel n'est pas actif.");
  const playerKey = getPlayerKeyByDiscordId(duel, discordId);
  if (playerKey !== duel.activePlayerKey) throw new Error("Ce n'est pas ton tour !");

  const player = duel.players[playerKey];
  const unit = player.board.find(u => u.uid === unitUid);
  if (!unit) throw new Error('Créature introuvable sur ton terrain.');
  if (unit.silenced) throw new Error('Cette créature a été réduite au silence.');

  const rawAb = Number(abilityIndex) === 2 ? unit.actif2 : unit.actif1;
  const parsed = parseActiveAbility(rawAb);
  if (!parsed) throw new Error('Cette capacité active est indisponible.');

  const reduction = getActiveCostReduction(duel, playerKey);
  const finalManaCost = Math.max(0, parsed.manaCost - reduction);

  if (player.mana < finalManaCost) {
    throw new Error(`Mana insuffisant (${player.mana}/${finalManaCost} mana requis).`);
  }

  if (parsed.requiresTap) {
    if (unit.tapped) throw new Error('Cette créature est déjà engagée.');
    if (unit.summonedThisTurn && !hasKeyword(duel, unit, 'celerite')) {
      throw new Error("Cette créature vient d'être invoquée et ne peut pas encore s'engager (sauf Célérité).");
    }
  }

  if (parsed.hpCost > 0 && player.hp <= parsed.hpCost) {
    throw new Error(`Points de vie insuffisants pour payer ${parsed.hpCost} PV.`);
  }

  if (parsed.targetType) {
    const isHelpful = parsed.effectNorm.startsWith('soigner') || parsed.effectNorm.startsWith('donner +') || parsed.effectNorm.includes('bouclier divin');
    validateTarget(duel, playerKey, parsed.targetType, targetId, !isHelpful);
  }

  player.mana -= finalManaCost;
  if (parsed.requiresTap) unit.tapped = true;
  if (parsed.hpCost > 0) {
    player.hp -= parsed.hpCost;
    addLog(duel, `🩸 ${player.username} paie ${parsed.hpCost} PV.`);
  }

  addLog(duel, `⚡ [${unit.display_name}] active : « ${parsed.effectText} ».`);

  executeEffect(duel, playerKey, unit, parsed.effectNorm, targetId);

  if (parsed.requiresSacrifice) {
    unit.currentHp = 0;
    unit.forceDestroyed = true;
  }

  recomputeBoardAuras(duel);
  processDeaths(duel, unit);
  checkWinCondition(duel);
  return duel;
}

function getMaxAttacksPerTurn(duel, unit) {
  if (hasKeyword(duel, unit, 'mega-furie des vents')) return 3;
  if (hasKeyword(duel, unit, 'furie des vents')) return 2;
  return 1;
}

// Détermine si une créature adverse `enemyUnit` est capable de bloquer `attacker` (protection du Héros adverse)
function canEnemyUnitBlockAttacker(duel, enemyUnit, attacker) {
  if (enemyUnit.stealth || enemyUnit.frozen || enemyUnit.tapped) return false;

  const attackerFlies = hasKeyword(duel, attacker, 'vol');
  const attackerHasReach = hasKeyword(duel, attacker, 'portee');
  const enemyFlies = hasKeyword(duel, enemyUnit, 'vol');
  const enemyHasReach = hasKeyword(duel, enemyUnit, 'portee');

  if (attackerFlies) {
    // Une créature qui vole ne peut être bloquée que par une créature avec Vol ou Portée
    return enemyFlies || enemyHasReach;
  }

  // Une créature au sol (sans Vol) ne peut pas atteindre une créature volante (sauf si elle a Portée) :
  // une créature ennemie volante ne bloque donc pas un attaquant au sol sans Portée.
  if (enemyFlies && !attackerHasReach) {
    return false;
  }

  return true;
}

// Retourne la liste exacte des identifiants ('hero_p1'/'hero_p2' et/ou uids des créatures ennemies)
// que `attacker` a le droit d'attaquer ce tour-ci.
function getValidAttackTargets(duel, attacker) {
  if (!duel || duel.status !== 'active' || !attacker) return [];
  const playerKey = attacker.ownerKey;
  if (playerKey !== duel.activePlayerKey) return [];

  if (hasKeyword(duel, attacker, 'defenseur')) return [];
  if (attacker.frozen || attacker.tapped) return [];
  if (attacker.summonedThisTurn && !hasKeyword(duel, attacker, 'celerite')) return [];

  const maxAttacks = getMaxAttacksPerTurn(duel, attacker);
  if (attacker.attacksThisTurn >= maxAttacks) return [];

  const oppKey = getOpponentKey(playerKey);
  const player = duel.players[playerKey];
  const opponent = duel.players[oppKey];

  const attackerCanHitFlying = hasKeyword(duel, attacker, 'vol') || hasKeyword(duel, attacker, 'portee');

  // 1. Créatures ennemies capables de bloquer notre attaquant
  const capableBlockers = opponent.board.filter(en => canEnemyUnitBlockAttacker(duel, en, attacker));

  // 2. Parmi ces bloqueurs, vérifier s'il y a des Provocations
  const tauntBlockers = capableBlockers.filter(en => {
    if (!hasKeyword(duel, en, 'provocation')) return false;
    if (hasKeyword(duel, en, 'menace') && player.board.length < 2) return false;
    return true;
  });

  if (tauntBlockers.length > 0) {
    return tauntBlockers.map(en => en.uid);
  }

  // 3. Liste des créatures ennemies que l'attaquant peut cibler sur le terrain
  const attackableCreatures = opponent.board.filter(en => {
    if (en.stealth) return false;
    if (hasKeyword(duel, en, 'menace') && player.board.length < 2) return false;
    if (hasKeyword(duel, en, 'vol') && !attackerCanHitFlying) {
      return false;
    }
    return true;
  });

  const targets = attackableCreatures.map(en => en.uid);

  // 4. Peut-on attaquer directement le Héros adverse ?
  // Règle Magic : impossible d'attaquer le joueur adverse directement si une créature adverse
  // non engagée est capable de bloquer notre créature (sauf Menace qui exige au moins 2 bloqueurs).
  const minBlockersRequired = hasKeyword(duel, attacker, 'menace') ? 2 : 1;
  const isBlockedFromHero = capableBlockers.length >= minBlockersRequired;

  if (!isBlockedFromHero) {
    targets.push(`hero_${oppKey}`);
  }

  return targets;
}

function attackWithCreature(duel, discordId, attackerUid, targetId) {
  if (!duel || duel.status !== 'active') throw new Error("Le duel n'est pas actif.");
  const playerKey = getPlayerKeyByDiscordId(duel, discordId);
  if (playerKey !== duel.activePlayerKey) throw new Error("Ce n'est pas ton tour !");

  const oppKey = getOpponentKey(playerKey);
  const player = duel.players[playerKey];
  const opponent = duel.players[oppKey];

  const attacker = player.board.find(u => u.uid === attackerUid);
  if (!attacker) throw new Error('Créature attaquante introuvable.');

  if (hasKeyword(duel, attacker, 'defenseur')) {
    throw new Error('Une créature avec Défenseur ne peut pas attaquer.');
  }
  if (attacker.frozen) {
    throw new Error('Cette créature est gelée et ne peut pas attaquer.');
  }
  if (attacker.tapped) {
    throw new Error('Cette créature est déjà engagée.');
  }
  if (attacker.summonedThisTurn && !hasKeyword(duel, attacker, 'celerite')) {
    throw new Error("Cette créature vient d'être invoquée ce tour-ci (elle doit attendre le prochain tour pour attaquer, sauf Célérité).");
  }

  const maxAttacks = getMaxAttacksPerTurn(duel, attacker);
  if (attacker.attacksThisTurn >= maxAttacks) {
    throw new Error('Cette créature a déjà effectué toutes ses attaques pour ce tour.');
  }

  const normalizedTargetId = (targetId === 'enemy_hero') ? `hero_${oppKey}` : targetId;
  const isTargetingHero = (normalizedTargetId === `hero_${oppKey}`);
  const validTargets = getValidAttackTargets(duel, attacker);

  if (!validTargets.includes(normalizedTargetId)) {
    if (isTargetingHero) {
      const attackerFlies = hasKeyword(duel, attacker, 'vol');
      if (attackerFlies) {
        throw new Error("Impossible d'attaquer le joueur adverse directement : une créature ennemie avec Vol ou Portée bloque le passage !");
      }
      throw new Error("Impossible d'attaquer le joueur adverse directement tant qu'une créature ennemie est capable de bloquer ton attaquant !");
    }
    throw new Error('Cette cible ne peut pas être attaquée (vérifie Provocation, Vol, Camouflage ou Menace).');
  }

  const targetUnit = isTargetingHero ? null : opponent.board.find(u => u.uid === normalizedTargetId);

  if (attacker.stealth) attacker.stealth = false;
  attacker.attacksThisTurn += 1;

  if (attacker.attacksThisTurn >= maxAttacks && !hasKeyword(duel, attacker, 'vigilance')) {
    attacker.tapped = true;
  }

  if (!attacker.silenced) {
    for (const p of [attacker.passif1, attacker.passif2]) {
      const n = norm(p);
      if (n.includes('quand elle attaque : piocher 1 carte')) {
        drawCard(duel, playerKey, true);
      } else if (n.includes('quand elle attaque : geler la cible') && targetUnit) {
        targetUnit.frozen = true;
        addLog(duel, `❄️ [${attacker.display_name}] gèle ${targetUnit.display_name} en l'attaquant !`);
      }
    }
  }

  recomputeBoardAuras(duel);
  const atkDmg = attacker.effectiveAtk ?? attacker.baseAtk;

  if (isTargetingHero) {
    addLog(duel, `⚔️ ${attacker.display_name} attaque directement ${opponent.username} (${atkDmg} dégâts) !`);
    dealDamageToHero(duel, oppKey, atkDmg, attacker);
  } else {
    const defDmg = targetUnit.effectiveAtk ?? targetUnit.baseAtk;
    const atkHasDouble = hasKeyword(duel, attacker, 'double initiative');
    const atkHasFirst = atkHasDouble || hasKeyword(duel, attacker, 'initiative');
    const defHasDouble = hasKeyword(duel, targetUnit, 'double initiative');
    const defHasFirst = defHasDouble || hasKeyword(duel, targetUnit, 'initiative');
    const hasTrample = hasKeyword(duel, attacker, 'pietinement');

    addLog(duel, `⚔️ ${attacker.display_name} (${atkDmg}/${attacker.currentHp}) attaque ${targetUnit.display_name} (${defDmg}/${targetUnit.currentHp}).`);

    const applyStrikeWithTrample = (dmgAmount) => {
      const hpBefore = Math.max(0, targetUnit.currentHp);
      const hadShield = targetUnit.divineShield;
      const isImmune = hasKeyword(duel, targetUnit, 'immunite');
      dealDamageToCreature(duel, targetUnit, dmgAmount, attacker);

      if (hasTrample && !hadShield && !isImmune && dmgAmount > hpBefore) {
        const excess = dmgAmount - hpBefore;
        addLog(duel, `🦏 Piétinement : ${excess} dégât(s) d'excédent infligé(s) à ${opponent.username} !`);
        dealDamageToHero(duel, oppKey, excess, attacker);
      }
    };

    const isAlive = (u) => u.currentHp > 0 && !u.forceDestroyed;

    // Phase 1 : Dégâts d'Initiative (si l'un des deux possède Initiative ou Double initiative)
    if (atkHasFirst || defHasFirst) {
      if (atkHasFirst && defHasFirst) {
        applyStrikeWithTrample(atkDmg);
        dealDamageToCreature(duel, attacker, defDmg, targetUnit);
      } else if (atkHasFirst) {
        applyStrikeWithTrample(atkDmg);
      } else if (defHasFirst) {
        dealDamageToCreature(duel, attacker, defDmg, targetUnit);
      }

      // Phase 2 : Dégâts normaux (seulement pour les survivants qui frappent en phase normale ou en Double initiative)
      if (isAlive(attacker) && isAlive(targetUnit)) {
        const atkStrikesNormal = !atkHasFirst || atkHasDouble;
        const defStrikesNormal = !defHasFirst || defHasDouble;
        if (atkStrikesNormal) applyStrikeWithTrample(atkDmg);
        if (defStrikesNormal) dealDamageToCreature(duel, attacker, defDmg, targetUnit);
      }
    } else {
      // Combat standard simultané (sans Initiative)
      applyStrikeWithTrample(atkDmg);
      dealDamageToCreature(duel, attacker, defDmg, targetUnit);
    }
  }

  processDeaths(duel, attacker);
  checkWinCondition(duel);
  return duel;
}

// ============================================================================
// IA DU BOT D'ENTRAÎNEMENT (RESPECTE LA NOUVELLE RÈGLE DE BLOCAGE)
// ============================================================================
function pickAiTargetForEffect(duel, botKey, effectNorm) {
  const oppKey = getOpponentKey(botKey);
  const tType = getEffectTargetType(effectNorm);
  if (!tType) return null;

  const isHelpful = effectNorm.startsWith('soigner') || effectNorm.startsWith('donner +') || effectNorm.includes('bouclier divin');

  if (tType === 'ally_creature') {
    const allies = duel.players[botKey].board;
    return allies.length > 0 ? allies[0].uid : null;
  }

  const validEnemies = duel.players[oppKey].board.filter(
    u => !u.stealth && !hasKeyword(duel, u, 'insaisissable') && !hasKeyword(duel, u, 'immunite')
  );

  if (tType === 'enemy_creature' || tType === 'any_creature') {
    return validEnemies.length > 0 ? validEnemies[0].uid : null;
  }

  if (tType === 'any') {
    if (isHelpful) return `hero_${botKey}`;
    return validEnemies.length > 0 ? validEnemies[0].uid : `hero_${oppKey}`;
  }
  return null;
}

async function runBotTurnIfNeeded(duel, broadcastFn) {
  if (!duel || !duel.isBotMatch || duel.status !== 'active' || duel.activePlayerKey !== 'p2') {
    return;
  }

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  await sleep(650);

  if (!currentDuel || currentDuel.matchId !== duel.matchId || duel.status !== 'active') return;

  const bot = duel.players.p2;
  const opp = duel.players.p1;

  let playedSomething = true;
  while (playedSomething && duel.status === 'active' && bot.board.length < MAX_BOARD_SIZE) {
    playedSomething = false;
    const playable = bot.hand
      .filter(c => c.cout <= bot.mana)
      .sort((a, b) => b.cout - a.cout);

    if (playable.length > 0) {
      const card = playable[0];
      const bcNorm = getBattlecryEffectNorm(card);
      const targetId = bcNorm ? pickAiTargetForEffect(duel, 'p2', bcNorm) : null;
      try {
        playCardFromHand(duel, BOT_DISCORD_ID, card.uid, targetId);
        playedSomething = true;
        if (broadcastFn) broadcastFn(duel);
        await sleep(650);
      } catch {
        break;
      }
    }
  }

  for (const unit of [...bot.board]) {
    if (duel.status !== 'active') break;
    while (duel.status === 'active') {
      const validTargets = getValidAttackTargets(duel, unit);
      if (validTargets.length === 0) break;

      let chosenTargetId = null;
      // Si le Bot peut attaquer directement le Héros du joueur (ex: créature volante non bloquée ou terrain vide), il le fait
      if (validTargets.includes('hero_p1')) {
        chosenTargetId = 'hero_p1';
      } else {
        // Sinon il attaque l'une des créatures bloqueuses du joueur
        const unitDmg = unit.effectiveAtk ?? unit.baseAtk;
        const candidateUnits = opp.board.filter(u => validTargets.includes(u.uid));
        const killable = candidateUnits.filter(u => u.currentHp <= unitDmg && !u.divineShield);
        if (killable.length > 0) {
          killable.sort((a, b) => (b.effectiveAtk ?? b.baseAtk) - (a.effectiveAtk ?? a.baseAtk));
          chosenTargetId = killable[0].uid;
        } else if (candidateUnits.length > 0) {
          candidateUnits.sort((a, b) => (b.effectiveAtk ?? b.baseAtk) - (a.effectiveAtk ?? a.baseAtk));
          chosenTargetId = candidateUnits[0].uid;
        } else {
          chosenTargetId = validTargets[0];
        }
      }

      if (!chosenTargetId) break;

      try {
        attackWithCreature(duel, BOT_DISCORD_ID, unit.uid, chosenTargetId);
        if (broadcastFn) broadcastFn(duel);
        await sleep(600);
      } catch {
        break;
      }
    }
  }

  if (duel.status === 'active' && duel.activePlayerKey === 'p2') {
    try {
      endPlayerTurn(duel, BOT_DISCORD_ID);
      if (broadcastFn) broadcastFn(duel);
    } catch (e) {
      console.error('Erreur fin de tour Bot :', e.message);
    }
  }
}

async function forfeitDuel(matchId, discordId) {
  if (!currentDuel || (matchId && currentDuel.matchId !== matchId)) {
    throw new Error('Duel introuvable.');
  }
  const pKey = getPlayerKeyByDiscordId(currentDuel, discordId);
  if (!pKey) throw new Error('Tu ne participes pas à ce duel.');

  const winnerKey = getOpponentKey(pKey);
  addLog(currentDuel, `🏳️ ${currentDuel.players[pKey].username} a abandonné le duel !`);
  await finishDuel(currentDuel, winnerKey, 'Abandon');
  return currentDuel;
}

function checkWinCondition(duel) {
  if (!duel || duel.status === 'finished') return true;
  const p1Dead = duel.players.p1.hp <= 0;
  const p2Dead = duel.players.p2.hp <= 0;

  if (!p1Dead && !p2Dead) return false;

  let winnerKey = null;
  if (p1Dead && !p2Dead) winnerKey = 'p2';
  else if (p2Dead && !p1Dead) winnerKey = 'p1';
  else winnerKey = duel.activePlayerKey;

  finishDuel(duel, winnerKey, 'KO').catch(console.error);
  return true;
}

async function finishDuel(duel, winnerKey, reason = 'KO') {
  if (duel.status === 'finished') return;
  duel.status = 'finished';
  duel.winnerKey = winnerKey;
  duel.winReason = reason;

  const loserKey = getOpponentKey(winnerKey);
  const winner = duel.players[winnerKey];
  const loser = duel.players[loserKey];

  addLog(duel, `🏆 VICTOIRE DE ${winner.username.toUpperCase()} (${reason}) !`);

  if (!duel.isBotMatch) {
    try {
      const pWin = await getOrCreatePlayer(winner.discord_id, winner.username);
      const pLose = await getOrCreatePlayer(loser.discord_id, loser.username);

      const expectedWin = 1 / (1 + Math.pow(10, ((pLose.elo || 1000) - (pWin.elo || 1000)) / 400));
      const delta = Math.max(8, Math.round(32 * (1 - expectedWin)));

      await pool.query(
        'UPDATE players SET elo = elo + ?, wins = wins + 1 WHERE discord_id = ?',
        [delta, winner.discord_id]
      );
      await pool.query(
        'UPDATE players SET elo = GREATEST(100, elo - ?), losses = losses + 1 WHERE discord_id = ?',
        [delta, loser.discord_id]
      );

      // Anti-triche : 1 seul pack gagné par jour par vainqueur contre un même adversaire spécifique
      const packCheck = await claimDuelWinPackIfEligible(winner.discord_id, loser.discord_id, winner.username);
      if (packCheck.granted) {
        duel.rewardPackGranted = true;
        addLog(duel, `🎁 ${winner.username} remporte 1 Pack de 5 cartes pour sa victoire ! (Tape /ouvrir sur Discord)`);
      } else {
        duel.rewardPackGranted = false;
        addLog(duel, `ℹ️ ${winner.username} a déjà remporté son pack quotidien contre ${loser.username} aujourd'hui (prochain pack contre cet adversaire demain).`);
      }

      await pool.query(
        'UPDATE matches SET status = ?, winner_id = ? WHERE match_id = ?',
        ['finished', winner.discord_id, duel.matchId]
      );

      duel.eloDelta = delta;
    } catch (err) {
      console.error('❌ [Duel] Erreur mise à jour MySQL fin de match :', err);
    }
  } else {
    addLog(duel, `ℹ️ Fin du duel d'entraînement contre le Bot.`);
  }

  const finishedDuel = duel;
  currentDuel = null;

  if (finishedDuel.onMatchEndCallback) {
    await finishedDuel.onMatchEndCallback(finishedDuel).catch(() => {});
  }
}

function serializeUnitForClient(duel, unit) {
  const act1 = parseActiveAbility(unit.actif1);
  const act2 = parseActiveAbility(unit.actif2);
  const reduction = getActiveCostReduction(duel, unit.ownerKey);

  return {
    uid: unit.uid,
    card_id: unit.card_id,
    display_name: unit.display_name,
    username: unit.username,
    rarity: unit.rarity,
    alignment: unit.alignment,
    creature: unit.creature,
    explanation: unit.explanation,
    cout: unit.cout,
    attaque: unit.effectiveAtk ?? unit.baseAtk,
    baseAtk: unit.baseAtk,
    vie: unit.currentHp,
    maxHp: unit.maxHp,
    passif1: unit.passif1,
    passif2: unit.passif2,
    actif1: unit.actif1,
    actif2: unit.actif2,
    avatar_url: unit.avatar_url,
    ownerKey: unit.ownerKey,
    isToken: unit.isToken,
    silenced: unit.silenced,
    tapped: unit.tapped,
    frozen: unit.frozen,
    stealth: unit.stealth,
    divineShield: unit.divineShield,
    reborn: unit.reborn,
    summonedThisTurn: unit.summonedThisTurn,
    attacksThisTurn: unit.attacksThisTurn,
    maxAttacks: getMaxAttacksPerTurn(duel, unit),
    hasTaunt: hasKeyword(duel, unit, 'provocation'),
    hasFlying: hasKeyword(duel, unit, 'vol'),
    hasReach: hasKeyword(duel, unit, 'portee'),
    hasHaste: hasKeyword(duel, unit, 'celerite'),
    hasDefender: hasKeyword(duel, unit, 'defenseur'),
    hasImmune: hasKeyword(duel, unit, 'immunite'),
    hasIndestructible: hasKeyword(duel, unit, 'indestructible') || unit.tempIndestructible,
    validAttackTargets: getValidAttackTargets(duel, unit),
    parsedActif1: act1 ? { ...act1, effectiveManaCost: Math.max(0, act1.manaCost - reduction) } : null,
    parsedActif2: act2 ? { ...act2, effectiveManaCost: Math.max(0, act2.manaCost - reduction) } : null
  };
}

function serializeHandCardForClient(duel, playerKey, card) {
  const bcNorm = getBattlecryEffectNorm(card);
  let battlecryTargetType = null;
  if (bcNorm) {
    const rawTargetType = getEffectTargetType(bcNorm);
    const isHelpful = bcNorm.startsWith('soigner') || bcNorm.startsWith('donner +') || bcNorm.includes('bouclier divin');
    if (rawTargetType && checkIfAnyValidTargetExists(duel, playerKey, rawTargetType, !isHelpful)) {
      battlecryTargetType = rawTargetType;
    }
  }
  return {
    uid: card.uid,
    card_id: card.card_id,
    display_name: card.display_name,
    username: card.username,
    rarity: card.rarity,
    alignment: card.alignment,
    creature: card.creature,
    explanation: card.explanation,
    cout: card.cout,
    attaque: card.baseAtk,
    vie: card.baseHp,
    passif1: card.passif1,
    passif2: card.passif2,
    actif1: card.actif1,
    actif2: card.actif2,
    avatar_url: card.avatar_url,
    battlecryTargetType
  };
}

function getSerializedStateForViewer(duel, viewerDiscordId = null) {
  if (!duel) return null;
  const viewerKey = getPlayerKeyByDiscordId(duel, viewerDiscordId);

  const formatPlayer = (pKey) => {
    const p = duel.players[pKey];
    const isSelf = (viewerKey === pKey);
    return {
      key: pKey,
      discord_id: p.discord_id,
      username: p.username,
      avatar_url: p.avatar_url,
      selectedDeckSlot: p.selectedDeckSlot,
      deckName: p.deckName,
      hp: p.hp,
      maxHp: p.maxHp,
      mana: p.mana,
      maxMana: p.maxMana,
      deckCount: p.deck.length,
      handCount: p.hand.length,
      graveyardCount: p.graveyard.length,
      graveyardNames: p.graveyard.slice(-8).map(g => g.display_name),
      hand: isSelf ? p.hand.map(c => serializeHandCardForClient(duel, pKey, c)) : [],
      board: p.board.map(u => serializeUnitForClient(duel, u))
    };
  };

  return {
    matchId: duel.matchId,
    isBotMatch: Boolean(duel.isBotMatch),
    status: duel.status,
    turnNumber: duel.turnNumber,
    activePlayerKey: duel.activePlayerKey,
    viewerRole: viewerKey || 'spectator',
    winnerKey: duel.winnerKey,
    winReason: duel.winReason,
    eloDelta: duel.eloDelta || 0,
    rewardPackGranted: Boolean(duel.rewardPackGranted),
    logs: duel.logs,
    players: {
      p1: formatPlayer('p1'),
      p2: formatPlayer('p2')
    }
  };
}

module.exports = {
  getCurrentDuel,
  createPendingDuel,
  createBotTrainingDuel,
  cancelPendingDuel,
  acceptPendingDuel,
  selectDeckForPlayer,
  playCardFromHand,
  useCreatureAbility,
  attackWithCreature,
  endPlayerTurn,
  forfeitDuel,
  runBotTurnIfNeeded,
  getSerializedStateForViewer
};