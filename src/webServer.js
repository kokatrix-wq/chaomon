// src/webServer.js
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');

const {
  DECK_MIN_CARDS,
  DECK_MAX_CARDS,
  CHAOR_PER_DUPLICATE,
  PACK_COST_CHAOR,
  getOrCreatePlayer,
  getPlayerTotalCards,
  getPlayerByToken,
  getPlayerCollection,
  getPlayerDecks,
  savePlayerDeck,
  recyclePlayerDuplicates,
  buyPackWithChaor,
  getLeaderboard,
  getCardById
} = require('./db');
const { renderCardBuffer } = require('./cardRenderer');
const {
  getCurrentDuel,
  createBotTrainingDuel,
  selectDeckForPlayer,
  playCardFromHand,
  useCreatureAbility,
  attackWithCreature,
  endPlayerTurn,
  forfeitDuel,
  runBotTurnIfNeeded,
  getSerializedStateForViewer
} = require('./duelEngine');

const DATA_DIR = path.join(__dirname, '..', 'DATA');
const AVATARS_DIR = path.join(DATA_DIR, 'useravatar');
const TEMPLATES_DIR = path.join(DATA_DIR, 'templates');
const FONTS_DIR = path.join(DATA_DIR, 'fonts');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const localAvatarFiles = new Set();
function indexLocalAvatars() {
  localAvatarFiles.clear();
  if (!fs.existsSync(AVATARS_DIR)) return;
  for (const file of fs.readdirSync(AVATARS_DIR)) {
    if (file.toLowerCase().endsWith('.png')) {
      localAvatarFiles.add(file);
    }
  }
  console.log(`🖼️ [Web] ${localAvatarFiles.size} fichiers d'avatars locaux indexés depuis DATA/useravatar/`);
}

const DEFAULT_AVATAR_FILES = {
  'loyal bon':         'dlb.png',
  'neutre bon':        'dnb.png',
  'chaotique bon':     'dcb.png',
  'loyal neutre':      'dln.png',
  'neutre strict':     'dnn.png',
  'neutre neutre':     'dnn.png',
  'chaotique neutre':  'dcn.png',
  'loyal mauvais':     'dlm.png',
  'neutre mauvais':    'dnm.png',
  'chaotique mauvais': 'dcm.png'
};

function normalizeAlignment(alignment) {
  return String(alignment || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function getDefaultAvatarFile(alignment) {
  const key = normalizeAlignment(alignment);
  return DEFAULT_AVATAR_FILES[key] || 'dnn.png';
}

function resolveAvatarUrl(cardId, alignment) {
  const customFile = `${cardId}.png`;
  if (localAvatarFiles.has(customFile)) {
    return `/assets/avatars/${customFile}`;
  }
  return `/assets/avatars/${getDefaultAvatarFile(alignment)}`;
}

async function authMiddleware(req, res, next) {
  try {
    let rawToken = null;
    if (req.query && req.query.token) {
      rawToken = String(req.query.token);
    } else if (req.headers['x-auth-token']) {
      rawToken = String(req.headers['x-auth-token']);
    } else if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
      rawToken = req.headers.authorization.slice(7);
    }

    const cleanToken = String(rawToken || '').replace(/[^a-fA-F0-9]/g, '');

    if (!cleanToken) {
      return res.status(401).json({
        error: 'Aucun token reçu par le serveur. Utilise le bouton de la commande /deck sur Discord.'
      });
    }

    const player = await getPlayerByToken(cleanToken);
    if (!player) {
      return res.status(401).json({
        error: 'Ce lien magique ne correspond à aucun joueur en base de données. Tape /deck sur Discord.'
      });
    }

    req.player = player;
    next();
  } catch (err) {
    console.error('❌ [Web Auth] Erreur :', err);
    res.status(500).json({ error: `Erreur serveur d'authentification : ${err.message}` });
  }
}

let ioInstance = null;

function broadcastDuelState(duel) {
  if (!ioInstance || !duel) return;
  const room = ioInstance.sockets.adapter.rooms.get(`match:${duel.matchId}`);
  if (!room) return;

  for (const socketId of room) {
    const clientSocket = ioInstance.sockets.sockets.get(socketId);
    if (clientSocket) {
      const state = getSerializedStateForViewer(duel, clientSocket.discordId || null);
      clientSocket.emit('duel_state', state);
    }
  }
}

function startWebServer() {
  indexLocalAvatars();

  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, {
    cors: { origin: '*' }
  });
  ioInstance = io;

  app.use(express.json({ limit: '1mb' }));

  app.get('/assets/chao.jpg', (req, res) => {
    const candidates = [
      path.join(__dirname, 'chao.jpg'),
      path.join(__dirname, '..', 'chao.jpg'),
      path.join(DATA_DIR, 'chao.jpg'),
      path.join(PUBLIC_DIR, 'chao.jpg')
    ];
    for (const filePath of candidates) {
      if (fs.existsSync(filePath)) {
        res.set('Cache-Control', 'public, max-age=86400');
        return res.sendFile(filePath);
      }
    }
    res.status(404).send('Logo chao.jpg introuvable');
  });

  // Route automatique pour les images de fond des terrains (allié et ennemi)
  app.get('/assets/terrain/:side', (req, res) => {
    const side = req.params.side === 'ennemi' ? 'terrain_ennemi' : 'terrain_allie';
    const searchDirs = [TEMPLATES_DIR, DATA_DIR, PUBLIC_DIR, __dirname, path.join(__dirname, '..')];
    const fileCandidates = [
      `${side}.jpg`,
      `${side}.png`,
      `${side}.webp`,
      'terrain.jpg',
      'terrain.png',
      'terrain.webp'
    ];

    for (const dir of searchDirs) {
      for (const fname of fileCandidates) {
        const fullPath = path.join(dir, fname);
        if (fs.existsSync(fullPath)) {
          res.set('Cache-Control', 'public, max-age=3600');
          return res.sendFile(fullPath);
        }
      }
    }
    res.status(204).end();
  });

  app.use('/assets/templates', express.static(TEMPLATES_DIR, { maxAge: '7d' }));
  app.use('/assets/avatars', express.static(AVATARS_DIR, { maxAge: '7d' }));
  app.use('/assets/fonts', express.static(FONTS_DIR, { maxAge: '30d' }));
  app.use(express.static(PUBLIC_DIR));

  // ============================================================================
  // SUPPORT NATIF DISCORD ACTIVITY (SDK + OAUTH2 AUTOMATIQUE)
  // ============================================================================
  app.use(
    '/vendor/discord-sdk',
    express.static(path.join(__dirname, '..', 'node_modules', '@discord', 'embedded-app-sdk', 'output'))
  );

  app.get('/api/discord-activity/config', (req, res) => {
    res.json({
      clientId: process.env.DISCORD_CLIENT_ID || null
    });
  });

  app.post('/api/discord-activity/auth', async (req, res) => {
    try {
      const { code } = req.body || {};
      const clientId = process.env.DISCORD_CLIENT_ID;
      const clientSecret = process.env.DISCORD_CLIENT_SECRET;

      if (!code) {
        return res.status(400).json({ error: 'Code OAuth2 manquant.' });
      }
      if (!clientId || !clientSecret) {
        return res.status(500).json({ error: 'DISCORD_CLIENT_ID ou DISCORD_CLIENT_SECRET manquant dans .env.' });
      }

      // 1. Échange du code contre un access_token auprès de l'API Discord
      const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: 'authorization_code',
          code: String(code)
        })
      });

      const tokenData = await tokenResponse.json().catch(() => ({}));
      if (!tokenResponse.ok || !tokenData.access_token) {
        return res.status(401).json({ error: 'Échec de validation du code OAuth2 auprès de Discord.' });
      }

      // 2. Récupération de l'identité Discord du joueur
      const userResponse = await fetch('https://discord.com/api/users/@me', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` }
      });
      const discordUser = await userResponse.json().catch(() => ({}));
      if (!userResponse.ok || !discordUser.id) {
        return res.status(401).json({ error: 'Impossible de récupérer le profil Discord.' });
      }

      // 3. Vérification que le joueur a bien démarré son aventure avec /commencer
      const totalOwned = await getPlayerTotalCards(discordUser.id);
      if (totalOwned === 0) {
        return res.status(403).json({
          error: "Tu ne possèdes pas encore de cartes ! Ferme cette fenêtre et tape d'abord la commande /commencer dans le salon Discord pour obtenir ton pack de départ de 50 cartes."
        });
      }

      // 4. Récupération de son profil Chaomon et renvoi de son auth_token
      const displayName = discordUser.global_name || discordUser.username || 'Joueur';
      const player = await getOrCreatePlayer(discordUser.id, displayName);

      return res.json({
        token: player.auth_token,
        player: {
          discord_id: player.discord_id,
          username: player.username
        }
      });
    } catch (err) {
      console.error('❌ [Web] Erreur /api/discord-activity/auth :', err);
      return res.status(500).json({ error: err.message });
    }
  });

  // ============================================================================
  // API REST JOUEUR, COLLECTION, ÉCONOMIE & DECKS
  // ============================================================================
  app.get('/api/me', authMiddleware, async (req, res) => {
    try {
      const collection = await getPlayerCollection(req.player.discord_id);
      const decks = await getPlayerDecks(req.player.discord_id);
      const activeDuel = getCurrentDuel();

      let uniqueOwned = 0;
      let totalOwned = 0;
      let duplicateCount = 0;
      for (const c of collection) {
        const qty = Number(c.owned_quantity) || 0;
        if (qty > 0) {
          uniqueOwned++;
          totalOwned += qty;
          if (qty > 1) {
            duplicateCount += (qty - 1);
          }
        }
      }

      res.json({
        player: {
          discord_id: req.player.discord_id,
          username: req.player.username,
          elo: Number(req.player.elo) || 1000,
          wins: Number(req.player.wins) || 0,
          losses: Number(req.player.losses) || 0,
          chaor: Number(req.player.chaor) || 0,
          packs: Number(req.player.packs) || 0,
          avatar_url: resolveAvatarUrl(req.player.discord_id, 'neutre strict')
        },
        stats: {
          total_catalog: collection.length,
          unique_owned: uniqueOwned,
          total_owned: totalOwned,
          duplicate_count: duplicateCount,
          potential_chaor: duplicateCount * CHAOR_PER_DUPLICATE
        },
        economy: {
          chaor_per_duplicate: CHAOR_PER_DUPLICATE,
          pack_cost_chaor: PACK_COST_CHAOR
        },
        deck_rules: {
          min_cards: DECK_MIN_CARDS,
          max_cards: DECK_MAX_CARDS
        },
        decks,
        active_match_id: activeDuel ? activeDuel.matchId : null
      });
    } catch (err) {
      console.error('❌ [API /api/me] :', err);
      res.status(500).json({ error: `Erreur /api/me : ${err.message}` });
    }
  });

  app.get('/api/collection', authMiddleware, async (req, res) => {
    try {
      const rows = await getPlayerCollection(req.player.discord_id);
      const cards = rows.map(c => ({
        card_id:        c.card_id,
        display_name:   c.display_name,
        username:       c.username,
        rarity:         c.rarity || 'Commune',
        alignment:      c.alignment || '',
        creature:       c.creature || '',
        explanation:    c.explanation || '',
        cout:           Number(c.cout) || 0,
        attaque:        Number(c.attaque) || 0,
        vie:            Number(c.vie) || 0,
        passif1:        c.passif1 || '',
        passif2:        c.passif2 || '',
        actif1:         c.actif1 || '',
        actif2:         c.actif2 || '',
        owned_quantity: Number(c.owned_quantity) || 0,
        avatar_url:     resolveAvatarUrl(c.card_id, c.alignment)
      }));

      res.json({ cards });
    } catch (err) {
      console.error('❌ [API /api/collection] :', err);
      res.status(500).json({ error: `Erreur /api/collection : ${err.message}` });
    }
  });

  app.post('/api/recycle', authMiddleware, async (req, res) => {
    try {
      const result = await recyclePlayerDuplicates(req.player.discord_id);
      res.json({
        success: true,
        recycled_count: result.recycledCount,
        chaor_gained: result.chaorGained,
        chaor: result.chaor
      });
    } catch (err) {
      res.status(400).json({ error: err.message || 'Erreur lors du recyclage des doublons.' });
    }
  });

  app.post('/api/shop/buy-pack', authMiddleware, async (req, res) => {
    try {
      const result = await buyPackWithChaor(req.player.discord_id);
      res.json({
        success: true,
        packs_bought: result.packsBought,
        cost_chaor: result.costChaor,
        chaor: result.chaor,
        packs: result.packs
      });
    } catch (err) {
      res.status(400).json({ error: err.message || "Erreur lors de l'achat de packs." });
    }
  });

  app.get('/api/decks', authMiddleware, async (req, res) => {
    try {
      const decks = await getPlayerDecks(req.player.discord_id);
      res.json({
        decks,
        rules: { min_cards: DECK_MIN_CARDS, max_cards: DECK_MAX_CARDS }
      });
    } catch (err) {
      console.error('❌ [API GET /api/decks] :', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/decks/:slot', authMiddleware, async (req, res) => {
    try {
      const slot = Number(req.params.slot);
      const { name, cards } = req.body;
      const saved = await savePlayerDeck(req.player.discord_id, slot, name, cards);
      res.json({ success: true, deck: saved });
    } catch (err) {
      res.status(400).json({ error: err.message || 'Erreur lors de la sauvegarde du deck.' });
    }
  });

  app.get('/api/leaderboard', authMiddleware, async (req, res) => {
    try {
      const rows = await getLeaderboard(50);
      const leaderboard = rows.map((r, idx) => ({
        rank: idx + 1,
        discord_id: r.discord_id,
        username: r.username,
        elo: Number(r.elo) || 1000,
        wins: Number(r.wins) || 0,
        losses: Number(r.losses) || 0,
        unique_cards: Number(r.unique_cards) || 0,
        total_cards: Number(r.total_cards) || 0,
        avatar_url: resolveAvatarUrl(r.discord_id, 'neutre strict')
      }));
      res.json({ leaderboard });
    } catch (err) {
      console.error('❌ [API /api/leaderboard] :', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/card-image/:cardId', async (req, res) => {
    try {
      const card = await getCardById(req.params.cardId);
      if (!card) return res.status(404).send('Carte introuvable');
      const buffer = await renderCardBuffer(card);
      res.set('Content-Type', 'image/png');
      res.set('Cache-Control', 'public, max-age=300');
      res.send(buffer);
    } catch (err) {
      console.error('❌ [API /api/card-image] :', err);
      res.status(500).send('Erreur de génération PNG');
    }
  });

  // ============================================================================
  // API REST DUEL (FIABILITÉ TOTALE SUR HTTP + DIFFUSION SOCKET.IO)
  // ============================================================================
  app.get('/api/duel/state', async (req, res) => {
    try {
      let viewerId = null;
      const rawToken = req.query.token || req.headers['x-auth-token'];
      if (rawToken) {
        const cleanToken = String(rawToken).replace(/[^a-fA-F0-9]/g, '');
        const p = await getPlayerByToken(cleanToken);
        if (p) viewerId = p.discord_id;
      }
      const duel = getCurrentDuel();
      res.json({
        duel: duel ? getSerializedStateForViewer(duel, viewerId) : null
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/duel/start-bot', authMiddleware, async (req, res) => {
    try {
      req.player.avatar_url = resolveAvatarUrl(req.player.discord_id, 'neutre strict');
      const duel = await createBotTrainingDuel(req.player, resolveAvatarUrl);
      const decks = await getPlayerDecks(req.player.discord_id);
      broadcastDuelState(duel);
      res.json({
        duel: getSerializedStateForViewer(duel, req.player.discord_id),
        decks
      });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/duel/select-deck', authMiddleware, async (req, res) => {
    try {
      const { matchId, slotNumber } = req.body;
      const duel = await selectDeckForPlayer(matchId, req.player.discord_id, slotNumber, resolveAvatarUrl);
      broadcastDuelState(duel);
      await runBotTurnIfNeeded(duel, broadcastDuelState);
      res.json({
        duel: getSerializedStateForViewer(duel, req.player.discord_id)
      });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/duel/play-card', authMiddleware, async (req, res) => {
    try {
      const { cardUid, targetId } = req.body;
      const duel = getCurrentDuel();
      if (!duel) throw new Error('Aucun duel en cours.');
      const updated = playCardFromHand(duel, req.player.discord_id, cardUid, targetId);
      broadcastDuelState(updated);
      await runBotTurnIfNeeded(updated, broadcastDuelState);
      res.json({
        duel: getSerializedStateForViewer(updated, req.player.discord_id)
      });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/duel/use-ability', authMiddleware, async (req, res) => {
    try {
      const { unitUid, abilityIndex, targetId } = req.body;
      const duel = getCurrentDuel();
      if (!duel) throw new Error('Aucun duel en cours.');
      const updated = useCreatureAbility(duel, req.player.discord_id, unitUid, abilityIndex, targetId);
      broadcastDuelState(updated);
      await runBotTurnIfNeeded(updated, broadcastDuelState);
      res.json({
        duel: getSerializedStateForViewer(updated, req.player.discord_id)
      });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/duel/attack', authMiddleware, async (req, res) => {
    try {
      const { attackerUid, targetId } = req.body;
      const duel = getCurrentDuel();
      if (!duel) throw new Error('Aucun duel en cours.');
      const updated = attackWithCreature(duel, req.player.discord_id, attackerUid, targetId);
      broadcastDuelState(updated);
      await runBotTurnIfNeeded(updated, broadcastDuelState);
      res.json({
        duel: getSerializedStateForViewer(updated, req.player.discord_id)
      });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/duel/end-turn', authMiddleware, async (req, res) => {
    try {
      const duel = getCurrentDuel();
      if (!duel) throw new Error('Aucun duel en cours.');
      const updated = endPlayerTurn(duel, req.player.discord_id);
      broadcastDuelState(updated);
      await runBotTurnIfNeeded(updated, broadcastDuelState);
      res.json({
        duel: getSerializedStateForViewer(updated, req.player.discord_id)
      });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/duel/forfeit', authMiddleware, async (req, res) => {
    try {
      const { matchId } = req.body;
      const duel = getCurrentDuel();
      if (!duel) return res.json({ duel: null });
      const updated = await forfeitDuel(matchId || duel.matchId, req.player.discord_id);
      broadcastDuelState(updated);
      res.json({
        duel: getSerializedStateForViewer(updated, req.player.discord_id)
      });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ============================================================================
  // SOCKET.IO : ARÈNE DE DUEL EN TEMPS RÉEL (SPECTATEURS & SYNCHRO PVP)
  // ============================================================================
  io.on('connection', (socket) => {
    socket.on('join_duel', async ({ matchId, token }) => {
      try {
        let player = null;
        if (token) {
          const cleanToken = String(token).replace(/[^a-fA-F0-9]/g, '');
          player = await getPlayerByToken(cleanToken);
        }

        socket.discordId = player ? player.discord_id : null;
        const duel = getCurrentDuel();

        if (!duel || (matchId && duel.matchId !== matchId)) {
          return;
        }

        socket.matchId = duel.matchId;
        socket.join(`match:${duel.matchId}`);

        const state = getSerializedStateForViewer(duel, socket.discordId);
        socket.emit('duel_state', state);
      } catch (err) {
        socket.emit('duel_error', { message: err.message });
      }
    });

    socket.on('duel_start_bot', async ({ token }) => {
      try {
        const cleanToken = String(token || '').replace(/[^a-fA-F0-9]/g, '');
        const player = await getPlayerByToken(cleanToken);
        if (!player) throw new Error('Authentification requise.');

        socket.discordId = player.discord_id;
        player.avatar_url = resolveAvatarUrl(player.discord_id, 'neutre strict');

        const duel = await createBotTrainingDuel(player, resolveAvatarUrl);
        socket.matchId = duel.matchId;
        socket.join(`match:${duel.matchId}`);

        broadcastDuelState(duel);
      } catch (err) {
        socket.emit('duel_action_error', { message: err.message });
      }
    });
  });

  const port = Number(process.env.SERVER_PORT || process.env.PORT || 10262);
  server.listen(port, '0.0.0.0', () => {
    const publicUrl = process.env.PUBLIC_WEB_URL || `[URL]:${port}`;
    console.log(`🌐 [Web] Interface Chaomon TCG active sur le port ${port} (${publicUrl})`);
  });

  return { app, server, io };
}

module.exports = { startWebServer, resolveAvatarUrl, broadcastDuelState };