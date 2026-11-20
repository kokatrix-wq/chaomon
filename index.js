// index.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const {
  Client,
  Events,
  GatewayIntentBits,
  SlashCommandBuilder,
  AttachmentBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  ChannelType,
} = require('discord.js');

const {
  pool,
  ensureReady,
  drawBalancedCompleteCards,
  getOrCreatePlayer,
  regeneratePlayerToken,
  addCardToInventory,
  getPlayerTotalCards,
  resetPlayerInventory,
  markDailyActionUsedToday,
  claimDailyRsaPack,
  openOnePackForPlayer,
  getPlayerDecks,
  getCardById,
} = require('./src/db');
const { renderCardBuffer } = require('./src/cardRenderer');
const { startWebServer, resolveAvatarUrl } = require('./src/webServer');
const {
  getCurrentDuel,
  createPendingDuel,
  cancelPendingDuel,
  acceptPendingDuel,
} = require('./src/duelEngine');

const { DISCORD_TOKEN } = process.env;
if (!DISCORD_TOKEN) {
  console.error('❌ Erreur : renseigne DISCORD_TOKEN dans le fichier .env.');
  process.exit(1);
}

const PORT = Number(process.env.SERVER_PORT || process.env.PORT || 10262);

// Déclaré avec 'let' pour que le tunnel Cloudflare remplace automatiquement l'URL HTTP par l'URL HTTPS dès son ouverture
let PUBLIC_WEB_URL = (process.env.PUBLIC_WEB_URL || [URL]:${PORT}`).replace(/\/+$/, '');

const STARTER_PACK_SIZE = 50; // /commencer : 50 cartes
const WILD_CARD_LIFETIME_MS = 120 * 1000;     // 120 secondes avant suppression du message d'approche + de la carte
const PACK_MESSAGE_LIFETIME_MS = 120 * 1000;  // 120 secondes avant suppression automatique des messages d'ouverture de pack
const CARTE_DISPLAY_LIFETIME_MS = 120 * 1000; // 120 secondes avant suppression automatique d'une carte affichée via /carte

// ============================================================================
// PERSISTANCE MULTI-SERVEURS DES SALONS DE SPAWN (/zsalon & /zspawn)
// ============================================================================
const DEFAULT_SPAWN_CHANNEL_ID = process.env.SPAWN_CHANNEL_ID || '1215143054542114888';
const BOT_CONFIG_PATH = path.join(__dirname, 'DATA', 'bot_config.json');

// { spawnChannels: { [guildId]: channelId }, disabledGuilds: [guildId] }
let botConfig = {
  spawnChannels: {},
  disabledGuilds: []
};

function chargerConfigurationBot() {
  try {
    if (fs.existsSync(BOT_CONFIG_PATH)) {
      const data = JSON.parse(fs.readFileSync(BOT_CONFIG_PATH, 'utf-8'));
      if (data && typeof data === 'object') {
        botConfig.spawnChannels = data.spawnChannels && typeof data.spawnChannels === 'object'
          ? data.spawnChannels
          : {};
        botConfig.disabledGuilds = Array.isArray(data.disabledGuilds)
          ? data.disabledGuilds
          : [];
        // Compatibilité avec l'ancien format à salon unique
        if (data.spawnChannelId && !data._legacyMigrated) {
          botConfig._legacyChannelId = String(data.spawnChannelId).trim();
        }
      }
    }
  } catch (err) {
    console.warn('⚠️ Impossible de lire DATA/bot_config.json :', err.message);
  }
}

function sauvegarderConfigurationBot() {
  try {
    const dir = path.dirname(BOT_CONFIG_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      BOT_CONFIG_PATH,
      JSON.stringify(
        {
          spawnChannels: botConfig.spawnChannels,
          disabledGuilds: botConfig.disabledGuilds,
          _legacyMigrated: true
        },
        null,
        2
      ),
      'utf-8'
    );
  } catch (err) {
    console.warn('⚠️ Impossible de sauvegarder DATA/bot_config.json :', err.message);
  }
}

chargerConfigurationBot();

// Timers de suppression automatique des messages de packs
const packMessageTimers = new Map();

// Phrases d'annonce d'approche d'un Chaomon sauvage (affichées en gras 20s à 120s avant l'apparition)
const PHRASES_APPROCHE_CHAOMON = [
  "Un chaomon sous l'effet de substances approche, avec la ferme intention de boucler...",
  "Un chaomon membre du fan club de kOka approche, il a envie de boucler avec le papi en slip pendant quelques heures...",
  "Un chaomon qui vient de tout perdre aux paris sportifs cherche quelqu'un à qui en vouloir...",
  "Un chaomon qui tape des pavés à 4h du mat sans que personne ne réponde approche, il a encore des choses à dire...",
  "Un chaomon au pseudo « xX_DarkShadow_Xx » sur reddit approche, préparez-vous au dox...",
  "Un chaomon en misère affective est en approche... Donnez-lui de l'attention",
  "Un chaomon qui a très très envie de se faire attraper est dans le coin...",
  "Tu es prêt à rencontrer un Chaomon chaud dans ta région?",
  "Un chaomon qui screenshot tout « pour les preuves » est en embuscade dans le salon...",
  "Un chaomon qui propose de « régler ça comme des zhommes » avec quelqu'un qui habite à 800 km approche, il a déjà mis ses chaussures...",
  "Un chaomon qui n'a pas lavé ses draps depuis 1 mois et dont le caleçon tient debout tout seul approche...",
  "Un chaomon qui a tout misé sur une crypto « qui va exploser » approche... Spoiler alert : il est toujours aussi pauvre",
  "Un chaomon qui menace de « porter plainte » depuis 2019 approche, il n'a toujours pas trouvé le commissariat...",
  "Un chaomon en couple avec sa main droite surgit, il a des est toujours en attente d'un conseiller...",
  "Un chaomon qui a claqué la moitié de son SMIC pour un skin légendaire sur Dofus arrive, mais son perso a fière allure...",
  "Un chaomon qui met des émojis sous ses propres messages approche...",
  "Un chaomon qui menace de « tracer ton IP » alors qu'il n'arrive pas à redémarrer sa box approche...",
  "Un chaomon qui ping everyone pour faire chier tout le monde surgit, vous pouvez l'insulter à volonté...",
  "Un chaomon qui partage son écran par erreur avec 14 onglets très suspects ouverts apparaît... Trop tard, vous avez tout vu...",
  "Un chaomon qui a bu « juste une bière » il y a 2 bouteilles approche...",
  "Un chaomon qui a « fait ses recherches » est sorti de sa cave pour t'expliquer ce que tu n'as pas compris...",
  "Un chaomon diplômé AFPA a une montée d'hormones et se prend pour la fusion entre Einstein et Schwarzenegger, il arrive, prêt à en découdre...",
  "Un chaomon sauvage rôde près du vocal, attiré par l'odeur des dramas et de l'alcool...",
  "Un chaomon permaban revient avec un double compte...",
  "Un chaomon qui a déjà rédigé 14 paragraphes pour une dispute qui n'a pas encore commencé approche...",
  "Un chaomon insomniaque cherche quelqu'un avec qui débattre pendant 4 heures...",
  "Un chaomon sous perfusion de red bull ne cligne plus des yeux depuis ce matin... Et il te fixe...",
  "Un chaomon qui n'a pas dormi depuis 72h et vit uniquement de café noir et de mauvaises décisions approche..."
];

// Planificateur horaire et suivi indépendant des apparitions par serveur
let nextSpawnTimer = null;
let nextSpawnTargetTime = null;
const currentApproachMsgsByGuild = new Map(); // guildId -> Message
const activeWildSpawnsById = new Map();       // spawnId -> spawnEntry
const activeWildSpawnsByGuild = new Map();    // guildId -> spawnEntry

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

// ============================================================================
// DÉFINITION DES COMMANDES SLASH
// (/aide, /commencer, /deck, /duel, /rsa, /carte, /ouvrir, /zreset, /zsalon, /zspawn)
// ============================================================================
const aideCommand = new SlashCommandBuilder()
  .setName('aide')
  .setDescription('Affiche le guide des commandes pour jouer à Chaomon TCG.');

const commencerCommand = new SlashCommandBuilder()
  .setName('commencer')
  .setDescription('Obtiens ton pack de départ de 50 cartes Chaomon pour débuter l’aventure !');

const deckCommand = new SlashCommandBuilder()
  .setName('deck')
  .setDescription('Reçois ton lien magique personnel pour gérer ta Collection et tes Decks sur le Web.');

const duelCommand = new SlashCommandBuilder()
  .setName('duel')
  .setDescription('Défie un autre membre du serveur dans un duel Chaomon au tour par tour !')
  .addUserOption((option) =>
    option
      .setName('utilisateur')
      .setDescription('Le membre que tu souhaites provoquer en duel.')
      .setRequired(true)
  );

const rsaCommand = new SlashCommandBuilder()
  .setName('rsa')
  .setDescription('Récupère et ouvre immédiatement ton pack gratuit quotidien de 5 cartes Chaomon (1 fois par jour) !');

const carteCommand = new SlashCommandBuilder()
  .setName('carte')
  .setDescription('Affiche une carte Chaomon dans le salon à partir de son nom (pendant 120 secondes).')
  .addStringOption((option) =>
    option
      .setName('nom')
      .setDescription('Copie/colle le nom de la carte depuis ta collection (ex: koka). Insensible à la casse.')
      .setRequired(true)
  );

const ouvrirCommand = new SlashCommandBuilder()
  .setName('ouvrir')
  .setDescription('Ouvre un de tes packs de 5 cartes Chaomon !');

const zresetCommand = new SlashCommandBuilder()
  .setName('zreset')
  .setDescription('[Admin] Remet à 0 un joueur précis (@pseudo ou ID) ou TOUS les joueurs (avec confirmation).')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addStringOption((option) =>
    option
      .setName('cible')
      .setDescription('Mentionne un membre (@pseudo / ID Discord) OU écris TOUS pour réinitialiser tout le monde.')
      .setRequired(true)
  );

const zsalonCommand = new SlashCommandBuilder()
  .setName('zsalon')
  .setDescription('[Admin] Définit le salon où apparaissent les Chaomons sauvages toutes les heures.')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addStringOption((option) =>
    option
      .setName('salon')
      .setDescription('Mentionne le salon (#general), son nom ou son identifiant Discord.')
      .setRequired(true)
  );

const zspawnCommand = new SlashCommandBuilder()
  .setName('zspawn')
  .setDescription('[Admin] Active ou désactive l’apparition automatique (spawn) des cartes dans le salon.')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addStringOption((option) =>
    option
      .setName('etat')
      .setDescription('Choisis ON ou OFF (ou laisse vide pour inverser l’état actuel).')
      .setRequired(false)
      .addChoices(
        { name: '🟢 ON (Activer les spawns)', value: 'on' },
        { name: '🔴 OFF (Désactiver les spawns)', value: 'off' }
      )
  );

const commandsToRegister = [
  aideCommand,
  commencerCommand,
  deckCommand,
  duelCommand,
  rsaCommand,
  carteCommand,
  ouvrirCommand,
  zresetCommand,
  zsalonCommand,
  zspawnCommand,
];

const obsoleteCommandNames = new Set(['fetch', 'reloadcsv', 'test', 'web', 'give', 'don', 'reset', 'on-off']);

async function synchroniserCommandesSurServeur(guild) {
  try {
    const existingCommands = await guild.commands.fetch();

    for (const existing of existingCommands.values()) {
      if (obsoleteCommandNames.has(existing.name)) {
        await guild.commands.delete(existing.id);
        console.log(`🗑️ Ancienne commande /${existing.name} supprimée sur « ${guild.name} ».`);
      }
    }

    for (const commandBuilder of commandsToRegister) {
      const commandData = commandBuilder.toJSON();
      const existingCommand = existingCommands.find(
        (command) => command.name === commandData.name && command.type === commandData.type
      );

      if (existingCommand) {
        await guild.commands.edit(existingCommand.id, commandData);
      } else {
        await guild.commands.create(commandData);
      }
    }

    console.log(`⚡ Commandes (/aide, /commencer, /deck, /duel, /rsa, /carte, /ouvrir, /zreset, /zsalon, /zspawn) enregistrées sur « ${guild.name} ».`);
  } catch (error) {
    console.error(`⚠️ Erreur d’enregistrement des commandes sur « ${guild.name} » :`, error);
  }
}

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`✅ Bot connecté : ${readyClient.user.tag}`);

  // Rattache automatiquement le salon du .env (ou l'ancien salon unique) à son serveur d'origine
  const initialChannelId = botConfig._legacyChannelId || DEFAULT_SPAWN_CHANNEL_ID;
  if (initialChannelId) {
    try {
      const ch = await readyClient.channels.fetch(initialChannelId);
      if (ch && ch.guildId && !botConfig.spawnChannels[ch.guildId]) {
        botConfig.spawnChannels[ch.guildId] = ch.id;
        delete botConfig._legacyChannelId;
        sauvegarderConfigurationBot();
        console.log(`📍 Salon par défaut (.env) associé au serveur « ${ch.guild.name} » : #${ch.name} (${ch.id})`);
      }
    } catch {
      // Le salon du .env n'est pas accessible ou n'existe plus, on ignore sans bloquer
    }
  }

  for (const guild of readyClient.guilds.cache.values()) {
    await synchroniserCommandesSurServeur(guild);
  }

  // Démarrage du planificateur d'apparition horaire aléatoire
  planifierProchaineApparitionHoraire(true);
});

// Enregistre automatiquement les commandes si le bot rejoint un nouveau serveur Discord
client.on(Events.GuildCreate, async (guild) => {
  console.log(`🎉 Nouveau serveur rejoint : « ${guild.name} » (${guild.id}). Enregistrement des commandes...`);
  await synchroniserCommandesSurServeur(guild);
});

function extraireIdDiscord(input) {
  if (!input) return null;
  const digits = String(input).replace(/\D/g, '');
  return /^\d{15,22}$/.test(digits) ? digits : null;
}

// ============================================================================
// 0. EXÉCUTION DE LA COMMANDE /aide & DE LA COMMANDE /carte
// ============================================================================
async function executerCommandeAide(interaction) {
  const helpEmbed = new EmbedBuilder()
    .setColor(0x10b981)
    .setTitle('📖 Guide des commandes — Chaomon TCG')
    .setDescription(
      'Bienvenue dans **Chaomon TCG** ! Voici toutes les commandes à connaître pour collectionner les cartes du serveur, construire tes decks et affronter les autres membres :'
    )
    .addFields(
      {
        name: '🚀 `/commencer` — Démarrer ton aventure (1 seule fois)',
        value:
          "T'offre ton **pack de départ de 50 cartes Chaomon** ainsi que l'accès à ton espace Web.\n" +
          "⚠️ **La commande `/commencer` est indispensable pour commencer à jouer et pour pouvoir attraper les cartes sauvages qui apparaissent dans le salon (un joueur sans carte ne peut pas en attraper).**"
      },
      {
        name: '🌐 `/deck` — Gérer ta Collection, tes ChaOr et tes 3 Decks',
        value:
          "Génère ton **Lien Magique** personnel (visible uniquement par toi).\n" +
          "✨ **Ce lien magique te connecte automatiquement à ton espace Web (PC et Smartphone) en un seul clic, sans avoir besoin de te connecter avec Discord ni de saisir de mot de passe.**\n" +
          "Tu peux y consulter ta collection, composer tes **3 decks** (20 à 30 cartes uniques), recycler tes doublons en **ChaOr**, acheter des packs et t'entraîner contre le bot **kOkamini**."
      },
      {
        name: '⚔️ `/duel [@utilisateur]` — Défier un membre en Arène',
        value:
          "Lance un défi de combat au tour par tour contre un autre joueur du serveur (vous devez tous les deux posséder au moins un deck valide de 20 à 30 cartes uniques).\n" +
          "🏆 Le vainqueur gagne des points **Elo** au classement et remporte **1 Pack de 5 cartes** *(limité à 1 pack gagné par jour contre un même adversaire)*."
      },
      {
        name: '🎁 `/rsa` — Ton pack gratuit quotidien (1 fois par jour)',
        value:
          "Te donne **1 pack gratuit de 5 cartes** chaque jour et l'ouvre immédiatement dans le salon *(accessible dès le lendemain de ton `/commencer`)*."
      },
      {
        name: '🃏 `/carte [nom]` — Afficher une carte en grand dans le salon',
        value:
          "Permet d'afficher la carte de ton choix dans le salon : **il suffit de copier/coller le nom de la carte depuis ta collection Web dans le champ `nom` de la commande** (ex : `/carte nom:koka`).\n" +
          "La recherche est insensible aux majuscules/minuscules et la carte reste affichée pendant **120 secondes** avant de disparaître automatiquement."
      },
      {
        name: '📦 `/ouvrir` — Ouvrir tes packs en stock',
        value:
          "Permet d'ouvrir les packs de 5 cartes que tu as gagnés en duel ou achetés avec tes **ChaOr** sur l'interface Web."
      }
    )
    .setFooter({ text: 'Chaomon TCG • Un Chaomon sauvage apparaît aussi chaque heure dans le salon !' });

  await interaction.reply({
    embeds: [helpEmbed],
    ephemeral: true
  });
}

async function trouverCarteParNom(inputNom) {
  await ensureReady();
  const raw = String(inputNom || '').trim();
  if (!raw) return null;

  // Si le joueur a copié-collé "kOka (@kokatrix)" depuis la fenêtre de détails Web,
  // on nettoie automatiquement la partie "(@...)"
  const cleanedDisplay = raw.replace(/\s*\(@[^)]+\)\s*$/, '').trim();
  const cleanedUser = raw.replace(/^@/, '').trim();

  // 1. Recherche directe insensible à la casse dans MySQL
  const [rows] = await pool.query(
    `SELECT * FROM cards
     WHERE LOWER(display_name) = LOWER(?)
       OR LOWER(display_name) = LOWER(?)
       OR LOWER(username) = LOWER(?)
     LIMIT 1`,
    [raw, cleanedDisplay, cleanedUser]
  );

  if (rows && rows.length > 0) {
    return rows[0];
  }

  // 2. Fallback insensible à la casse ET aux accents sur le catalogue
  const normStr = (s) =>
    String(s || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim();

  const targetNorm = normStr(cleanedDisplay);
  const [allCards] = await pool.query('SELECT * FROM cards');
  for (const c of allCards) {
    if (normStr(c.display_name) === targetNorm || normStr(c.username) === targetNorm) {
      return c;
    }
  }

  return null;
}

async function executerCommandeCarte(interaction) {
  const queryName = interaction.options.getString('nom', true).trim();

  try {
    const card = await trouverCarteParNom(queryName);

    if (!card) {
      await interaction.reply({
        content:
          `❌ Aucune carte trouvée pour le nom **« ${queryName} »**.\n` +
          `💡 *Astuce : copie/colle directement le nom de la carte depuis ta collection Web (via \`/deck\`).*`,
        ephemeral: true
      });
      return;
    }

    await interaction.deferReply();

    const buffer = await renderCardBuffer(card);
    const attachment = new AttachmentBuilder(buffer, { name: `carte_${card.card_id}.png` });

    await interaction.editReply({
      content: `🃏 Carte **${card.display_name}** *(${card.rarity})* — demandée par <@${interaction.user.id}> :`,
      files: [attachment]
    });

    // Disparition automatique de la carte au bout de 120 secondes
    setTimeout(() => {
      interaction.deleteReply().catch(() => {});
    }, CARTE_DISPLAY_LIFETIME_MS);
  } catch (err) {
    console.error('❌ Erreur /carte :', err);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(`❌ Erreur lors de l'affichage de la carte : ${err.message}`).catch(() => {});
    } else {
      await interaction.reply({ content: `❌ Erreur lors de l'affichage de la carte : ${err.message}`, ephemeral: true }).catch(() => {});
    }
  }
}

// ============================================================================
// 1. SYSTÈME D'APPARITION HORAIRE ALÉATOIRE MULTI-SERVEURS
// ============================================================================
function estSpawnActifPourServeur(guildId) {
  return !botConfig.disabledGuilds.includes(String(guildId));
}

async function trouverSalonApparitionPourServeur(guild) {
  if (!guild) return null;

  // 1. Vérifie si un salon spécifique a été configuré pour ce serveur (via /zsalon ou .env)
  const configuredChannelId = botConfig.spawnChannels[guild.id];
  if (configuredChannelId) {
    try {
      const ch = await guild.channels.fetch(configuredChannelId);
      if (ch && ch.isTextBased()) return ch;
    } catch {
      console.warn(`⚠️ [Spawn Horaire] Le salon configuré (${configuredChannelId}) sur « ${guild.name} » est introuvable.`);
    }
  }

  // 2. Fallback : si le salon par défaut du .env appartient à ce serveur, on l'utilise et on le mémorise
  if (DEFAULT_SPAWN_CHANNEL_ID) {
    const defaultCh = guild.channels.cache.get(DEFAULT_SPAWN_CHANNEL_ID);
    if (defaultCh && defaultCh.isTextBased()) {
      botConfig.spawnChannels[guild.id] = defaultCh.id;
      sauvegarderConfigurationBot();
      return defaultCh;
    }
  }

  // 3. Fallback : premier salon textuel du serveur où le bot a la permission d'écrire
  const writableChannels = guild.channels.cache.filter(
    (c) => c.type === ChannelType.GuildText && c.permissionsFor(guild.members.me)?.has('SendMessages')
  );
  if (writableChannels.size > 0) {
    return writableChannels.first();
  }

  return null;
}

function nettoyerSpawnServeur(guildId) {
  const approachMsg = currentApproachMsgsByGuild.get(guildId);
  if (approachMsg) {
    approachMsg.delete().catch(() => {});
    currentApproachMsgsByGuild.delete(guildId);
  }

  const existingSpawn = activeWildSpawnsByGuild.get(guildId);
  if (existingSpawn) {
    existingSpawn.resolved = true;
    if (existingSpawn.expireTimer) clearTimeout(existingSpawn.expireTimer);
    if (existingSpawn.resolveTimer) clearTimeout(existingSpawn.resolveTimer);
    existingSpawn.approachMessage?.delete().catch(() => {});
    existingSpawn.message?.delete().catch(() => {});
    activeWildSpawnsByGuild.delete(guildId);
    activeWildSpawnsById.delete(existingSpawn.spawnId);
  }
}

function planifierProchaineApparitionHoraire(isInitialBoot = false) {
  if (nextSpawnTimer) {
    clearTimeout(nextSpawnTimer);
    nextSpawnTimer = null;
  }

  const now = new Date();
  const currentHourStart = new Date(now);
  currentHourStart.setMinutes(0, 0, 0);

  let targetHourStart = new Date(currentHourStart);
  if (!isInitialBoot) {
    targetHourStart.setHours(targetHourStart.getHours() + 1);
  }

  const randomOffsetMs = Math.floor((1 + Math.random() * 57) * 60 * 1000);
  let targetTime = new Date(targetHourStart.getTime() + randomOffsetMs);

  if (targetTime.getTime() <= now.getTime() + 10000) {
    const nextHourStart = new Date(currentHourStart);
    nextHourStart.setHours(nextHourStart.getHours() + 1);
    const nextOffsetMs = Math.floor((1 + Math.random() * 57) * 60 * 1000);
    targetTime = new Date(nextHourStart.getTime() + nextOffsetMs);
  }

  const delayMs = Math.max(5000, targetTime.getTime() - now.getTime());
  nextSpawnTargetTime = targetTime;

  const heureAffichee = targetTime.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  console.log(`⏰ [Spawn Horaire] Prochaine vague d'approche programmée à ${heureAffichee} (dans ${Math.round(delayMs / 60000)} min).`);

  nextSpawnTimer = setTimeout(async () => {
    nextSpawnTimer = null;
    await declencherSequenceApparitionSauvageTousServeurs().catch((err) =>
      console.error('❌ [Spawn Horaire] Erreur pendant la séquence :', err)
    );
    planifierProchaineApparitionHoraire(false);
  }, delayMs);

  return targetTime;
}

async function declencherSequenceApparitionSauvageTousServeurs() {
  const guilds = Array.from(client.guilds.cache.values());
  await Promise.allSettled(
    guilds.map((guild) => declencherSequenceApparitionSauvagePourServeur(guild))
  );
}

async function declencherSequenceApparitionSauvagePourServeur(guild) {
  if (!estSpawnActifPourServeur(guild.id)) return;

  const channel = await trouverSalonApparitionPourServeur(guild);
  if (!channel) {
    console.warn(`⚠️ [Spawn Horaire] Aucun salon textuel trouvé sur « ${guild.name} ».`);
    return;
  }

  try {
    // 1. Choisir aléatoirement une phrase d'approche et l'afficher en gras
    const phrase = PHRASES_APPROCHE_CHAOMON[Math.floor(Math.random() * PHRASES_APPROCHE_CHAOMON.length)];
    const approachMsg = await channel.send({
      content: `**${phrase}**`
    });
    currentApproachMsgsByGuild.set(guild.id, approachMsg);

    // 2. Attendre un délai aléatoire compris entre 20 secondes et 120 secondes
    const approachDelayMs = Math.floor((20 + Math.random() * 100) * 1000);
    console.log(`🐾 [Spawn Horaire][${guild.name}] Message d'approche envoyé dans #${channel.name}. Apparition dans ${Math.round(approachDelayMs / 1000)}s...`);

    await new Promise((r) => setTimeout(r, approachDelayMs));

    if (!estSpawnActifPourServeur(guild.id)) {
      await approachMsg.delete().catch(() => {});
      if (currentApproachMsgsByGuild.get(guild.id)?.id === approachMsg.id) {
        currentApproachMsgsByGuild.delete(guild.id);
      }
      return;
    }

    // 3. Tirer une carte aléatoire (proportionnelle à sa rareté) et générer son PNG
    const { tirage } = await drawBalancedCompleteCards(1);
    const card = tirage[0];
    if (!card) {
      await approachMsg.delete().catch(() => {});
      if (currentApproachMsgsByGuild.get(guild.id)?.id === approachMsg.id) {
        currentApproachMsgsByGuild.delete(guild.id);
      }
      return;
    }

    const buffer = await renderCardBuffer(card);
    const spawnId = `spawn_${guild.id}_${Date.now()}`;
    const attachment = new AttachmentBuilder(buffer, { name: 'chaomon_sauvage.png' });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`catch_chaomon:${spawnId}`)
        .setLabel('Attraper')
        .setStyle(ButtonStyle.Success)
    );

    // 4. Publier la carte dans un nouveau post avec le bouton "Attraper"
    const cardMsg = await channel.send({
      files: [attachment],
      components: [row]
    });

    const spawnEntry = {
      spawnId,
      guildId: guild.id,
      card,
      channelId: channel.id,
      approachMessage: approachMsg,
      message: cardMsg,
      candidates: new Map(),
      resolveTimer: null,
      expireTimer: null,
      resolved: false
    };

    activeWildSpawnsById.set(spawnId, spawnEntry);
    activeWildSpawnsByGuild.set(guild.id, spawnEntry);

    // 5. Suppression automatique au bout de 120 secondes (message d'approche + carte)
    spawnEntry.expireTimer = setTimeout(async () => {
      const wasCaught = spawnEntry.resolved;
      spawnEntry.resolved = true;

      if (spawnEntry.resolveTimer) {
        clearTimeout(spawnEntry.resolveTimer);
        spawnEntry.resolveTimer = null;
      }

      activeWildSpawnsById.delete(spawnId);
      if (activeWildSpawnsByGuild.get(guild.id)?.spawnId === spawnId) {
        activeWildSpawnsByGuild.delete(guild.id);
      }
      if (currentApproachMsgsByGuild.get(guild.id)?.id === approachMsg.id) {
        currentApproachMsgsByGuild.delete(guild.id);
      }

      await Promise.allSettled([
        approachMsg.delete(),
        cardMsg.delete()
      ]);

      if (!wasCaught) {
        console.log(`💨 [Spawn Horaire][${guild.name}] Le Chaomon « ${card.display_name} » n'a pas été attrapé en 120s et a disparu.`);
      } else {
        console.log(`🧹 [Spawn Horaire][${guild.name}] Nettoyage auto (120s) effectué pour « ${card.display_name} ».`);
      }
    }, WILD_CARD_LIFETIME_MS);
  } catch (err) {
    console.warn(`⚠️ [Spawn Horaire][${guild.name}] Impossible d'envoyer le spawn dans #${channel.name} :`, err.message);
  }
}

// ============================================================================
// EXÉCUTION DES COMMANDES ADMIN : /zspawn, /zsalon & /zreset
// ============================================================================
async function executerCommandeZspawn(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: '❌ Cette commande est réservée aux administrateurs.', ephemeral: true });
    return;
  }

  if (!interaction.guild) {
    await interaction.reply({ content: '❌ Cette commande doit être exécutée sur un serveur.', ephemeral: true });
    return;
  }

  const guildId = interaction.guild.id;
  const currentlyEnabled = estSpawnActifPourServeur(guildId);
  const choix = interaction.options.getString('etat');

  let newEnabledState;
  if (choix === 'on') newEnabledState = true;
  else if (choix === 'off') newEnabledState = false;
  else newEnabledState = !currentlyEnabled;

  if (!newEnabledState) {
    if (!botConfig.disabledGuilds.includes(guildId)) {
      botConfig.disabledGuilds.push(guildId);
      sauvegarderConfigurationBot();
    }
    nettoyerSpawnServeur(guildId);
    console.log(`🔴 [Spawn Horaire][${interaction.guild.name}] Spawns désactivés par ${interaction.user.tag}.`);
    await interaction.reply({
      content: '🔴 **Spawns de cartes DÉSACTIVÉS (`OFF`) sur ce serveur.**\nPlus aucun Chaomon sauvage n’apparaîtra ici jusqu’à la réactivation avec `/zspawn`.',
      ephemeral: true
    });
    return;
  }

  botConfig.disabledGuilds = botConfig.disabledGuilds.filter((id) => id !== guildId);
  sauvegarderConfigurationBot();

  if (!nextSpawnTimer) {
    planifierProchaineApparitionHoraire(true);
  }

  const spawnChannel = await trouverSalonApparitionPourServeur(interaction.guild);
  const salonMention = spawnChannel ? `<#${spawnChannel.id}>` : 'aucun salon configuré (`/zsalon`)';
  const heureStr = nextSpawnTargetTime
    ? nextSpawnTargetTime.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : 'bientôt';

  console.log(`🟢 [Spawn Horaire][${interaction.guild.name}] Spawns activés par ${interaction.user.tag} (prochain spawn à ${heureStr}).`);
  await interaction.reply({
    content:
      `🟢 **Spawns de cartes ACTIVÉS (\`ON\`) sur ce serveur.**\n` +
      `📍 Salon d'apparition : ${salonMention}\n` +
      `⏰ Prochaine approche prévue vers : **${heureStr}**`,
    ephemeral: true
  });
}

async function executerCommandeZsalon(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: '❌ Cette commande est réservée aux administrateurs.', ephemeral: true });
    return;
  }

  if (!interaction.guild) {
    await interaction.reply({ content: '❌ Cette commande doit être exécutée sur un serveur.', ephemeral: true });
    return;
  }

  const rawInput = interaction.options.getString('salon', true).trim();
  let targetChannel = null;

  // 1. Si l'admin a mentionné le salon (#general -> <#123456...>) ou entré son ID Discord
  const extractedId = extraireIdDiscord(rawInput);
  if (extractedId) {
    try {
      targetChannel = await interaction.guild.channels.fetch(extractedId);
    } catch {
      targetChannel = null;
    }
  }

  // 2. Sinon, recherche par nom de salon sur ce serveur uniquement
  if (!targetChannel) {
    const cleanName = rawInput.replace(/^#/, '').toLowerCase().trim();
    targetChannel = interaction.guild.channels.cache.find(
      (c) => c.isTextBased() && c.name.toLowerCase() === cleanName
    ) || null;
  }

  if (!targetChannel || !targetChannel.isTextBased() || targetChannel.guildId !== interaction.guild.id) {
    await interaction.reply({
      content:
        `❌ Salon introuvable sur ce serveur pour **« ${rawInput} »**.\n` +
        `💡 *Mentionne directement un salon textuel de ce serveur (ex: \`#general\`) ou renseigne son identifiant Discord.*`,
      ephemeral: true
    });
    return;
  }

  botConfig.spawnChannels[interaction.guild.id] = targetChannel.id;
  sauvegarderConfigurationBot();

  const heureStr = (estSpawnActifPourServeur(interaction.guild.id) && nextSpawnTargetTime)
    ? nextSpawnTargetTime.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : 'désactivé (/zspawn)';

  console.log(`📍 [Spawn Horaire][${interaction.guild.name}] Salon de spawn modifié par ${interaction.user.tag} -> #${targetChannel.name} (${targetChannel.id}).`);

  await interaction.reply({
    content:
      `✅ **Salon d'apparition des Chaomons mis à jour pour le serveur « ${interaction.guild.name} » !**\n` +
      `📍 Nouveau salon : <#${targetChannel.id}> (\`${targetChannel.id}\`)\n` +
      `⏰ Prochain spawn prévu : **${heureStr}**`,
    ephemeral: true
  });
}

async function executerCommandeZreset(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: '❌ Cette commande est réservée aux administrateurs.', ephemeral: true });
    return;
  }

  const rawTarget = interaction.options.getString('cible', true).trim();
  const isAll = /^(tous|tout|all|\*)$/i.test(rawTarget);

  if (isAll) {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`zreset_confirm_yes:${interaction.user.id}:ALL`)
        .setLabel('⚠️ OUI, réinitialiser TOUS les joueurs')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`zreset_confirm_no:${interaction.user.id}`)
        .setLabel('❌ Annuler')
        .setStyle(ButtonStyle.Secondary)
    );

    await interaction.reply({
      content:
        `⚠️ **CONFIRMATION REQUISE — RÉINITIALISATION GÉNÉRALE (\`TOUS\`)**\n` +
        `Es-tu absolument sûr de vouloir remettre à **0** l'inventaire de cartes, les decks, les ChaOr, les packs et l'Elo de **TOUS les joueurs** de la base de données ?\n` +
        `*Cette action est irréversible.*`,
      components: [row],
      ephemeral: true
    });
    return;
  }

  const targetDiscordId = extraireIdDiscord(rawTarget);
  if (!targetDiscordId) {
    await interaction.reply({
      content:
        `❌ Cible invalide (**« ${rawTarget} »**).\n` +
        `👉 Mentionne un joueur (\`@pseudo\` ou son ID Discord), ou écris **\`TOUS\`** pour réinitialiser l'ensemble des joueurs.`,
      ephemeral: true
    });
    return;
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`zreset_confirm_yes:${interaction.user.id}:${targetDiscordId}`)
      .setLabel('✅ Oui, remettre ce joueur à 0')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`zreset_confirm_no:${interaction.user.id}`)
      .setLabel('❌ Annuler')
      .setStyle(ButtonStyle.Secondary)
    );

  await interaction.reply({
    content:
      `⚠️ **Confirmation requise**\n` +
      `Veux-tu vraiment remettre à **0** l'inventaire de cartes, les ChaOr, les packs et les decks de <@${targetDiscordId}> (\`${targetDiscordId}\`) ?`,
    components: [row],
    ephemeral: true
  });
}

async function gererBoutonsZreset(interaction) {
  const parts = interaction.customId.split(':');
  const action = parts[0];
  const adminUserId = parts[1];
  const targetParam = parts[2];

  if (interaction.user.id !== adminUserId) {
    await interaction.reply({ content: '❌ Cette confirmation ne t’appartient pas.', ephemeral: true });
    return;
  }

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: '❌ Réservé aux administrateurs.', ephemeral: true });
    return;
  }

  if (action === 'zreset_confirm_no') {
    await interaction.update({
      content: '👌 Commande `/zreset` annulée. Aucune donnée n’a été modifiée.',
      components: []
    });
    return;
  }

  if (action === 'zreset_confirm_yes') {
    await interaction.update({
      content: '⏳ **Réinitialisation en cours...**',
      components: []
    });

    try {
      if (targetParam === 'ALL') {
        const [invRes] = await pool.query('DELETE FROM inventory');
        await pool.query('DELETE FROM decks');
        await pool.query('DELETE FROM duel_daily_rewards');
        const [pRes] = await pool.query(
          `UPDATE players SET chaor = 0, packs = 0, elo = 1000, wins = 0, losses = 0, last_daily_date = ''`
        );

        await interaction.editReply({
          content:
            `🗑️ **Réinitialisation générale effectuée !**\n` +
            `Tous les joueurs (**${pRes.affectedRows || 0}** profil(s) et **${invRes.affectedRows || 0}** pile(s) de cartes) ont été intégralement remis à **0**.`,
          components: []
        });
      } else {
        const deletedStacks = await resetPlayerInventory(targetParam);
        await pool.query(
          `UPDATE players SET elo = 1000, wins = 0, losses = 0 WHERE discord_id = ?`,
          [targetParam]
        );

        await interaction.editReply({
          content:
            `🗑️ L'inventaire de cartes, les ChaOr, les packs, l'Elo et les decks de <@${targetParam}> (\`${targetParam}\`) ont été intégralement remis à **0** (${deletedStacks} entrée(s) supprimée(s)).`,
          components: []
        });
      }
    } catch (err) {
      console.error('❌ Erreur confirmation /zreset :', err);
      await interaction.editReply({
        content: `❌ Erreur lors de la réinitialisation : ${err.message}`,
        components: []
      });
    }
  }
}

async function gererClicAttraperChaomon(interaction) {
  const [, spawnId] = interaction.customId.split(':');
  const currentSpawn = activeWildSpawnsById.get(spawnId);

  if (!currentSpawn || currentSpawn.resolved) {
    await interaction.reply({
      content: '❌ Trop tard ! Ce Chaomon a déjà été attrapé ou a disparu.',
      ephemeral: true
    });
    return;
  }

  // SÉCURITÉ STRICTE : un joueur qui ne possède aucune carte ne peut pas attraper de Chaomon
  const totalOwned = await getPlayerTotalCards(interaction.user.id);
  if (totalOwned === 0) {
    await interaction.reply({
      content: '❌ **Tu dois obligatoirement utiliser la commande `/commencer` pour obtenir ton pack de départ avant de pouvoir attraper des Chaomons dans le salon !**',
      ephemeral: true
    });
    return;
  }

  const displayName = interaction.member?.displayName || interaction.user.globalName || interaction.user.username;
  await interaction.deferUpdate().catch(() => {});

  currentSpawn.candidates.set(interaction.user.id, {
    userId: interaction.user.id,
    displayName
  });

  if (!currentSpawn.resolveTimer) {
    currentSpawn.resolveTimer = setTimeout(async () => {
      if (currentSpawn.resolved) return;
      currentSpawn.resolved = true;
      currentSpawn.resolveTimer = null;

      const contenders = Array.from(currentSpawn.candidates.values());
      if (contenders.length === 0) return;

      const winner = contenders[Math.floor(Math.random() * contenders.length)];

      try {
        await addCardToInventory(winner.userId, currentSpawn.card.card_id, 1, winner.displayName);

        const disabledRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`catch_chaomon:${spawnId}`)
            .setLabel('Attrapé')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(true)
        );

        await currentSpawn.message.edit({
          content: `Chaomon attrapé par <@${winner.userId}>`,
          components: [disabledRow]
        });

        console.log(`🎯 [Spawn Horaire] « ${currentSpawn.card.display_name} » attrapé par ${winner.displayName} (${winner.userId}). Suppression auto prévue à la fin des 120s.`);
      } catch (err) {
        console.error('❌ Erreur lors de l’attribution du Chaomon sauvage :', err);
      }
    }, 250);
  }
}

// ============================================================================
// CONSTRUCTION DU MESSAGE DE LIEN MAGIQUE (+ BOUTON ACTIVITÉ SI ACTIVÉ DANS .ENV)
// ============================================================================
function construireBoutonsLienMagique(token) {
  const magicUrl = `${PUBLIC_WEB_URL}/?token=${token}`;
  const row = new ActionRowBuilder();

  // Ce bouton n'apparaît que le jour où tu ajoutes DISCORD_ACTIVITY_ENABLED=true dans .env
  if (process.env.DISCORD_ACTIVITY_ENABLED === 'true') {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId('launch_discord_activity')
        .setLabel('🎮 Jouer dans Discord')
        .setStyle(ButtonStyle.Primary)
    );
  }

  row.addComponents(
    new ButtonBuilder()
      .setLabel('🌐 Ouvrir mon espace Chaomon TCG')
      .setStyle(ButtonStyle.Link)
      .setURL(magicUrl),
    new ButtonBuilder()
      .setCustomId('regen_magic_token')
      .setLabel('🔄 Régénérer mon lien secret')
      .setStyle(ButtonStyle.Secondary)
  );

  return row;
}

function construireMessageLienMagique(token, estRegenere = false) {
  const row = construireBoutonsLienMagique(token);
  const intro = estRegenere
    ? '🔄 **Ton nouveau lien magique a été généré !** (L’ancien lien est désormais désactivé).'
    : '✨ **Voici ton accès personnel à l’interface Web Chaomon TCG !**';

  return {
    content:
      `${intro}\n` +
      `Ce message n’est visible **que par toi**. Clique sur le bouton ci-dessous pour gérer ta **Collection**, recycler tes doublons en **ChaOr** et composer tes **3 Decks**.\n` +
      `⚠️ *Ne partage pas ce lien : il contient ta clé de connexion personnelle.*`,
    components: [row],
    ephemeral: true,
  };
}

// ============================================================================
// EXÉCUTION DE LA COMMANDE /commencer (PACK DE DÉPART DE 50 CARTES)
// ============================================================================
async function executerCommandeCommencer(interaction) {
  await interaction.deferReply({ ephemeral: true });

  try {
    const userId = interaction.user.id;
    const totalOwned = await getPlayerTotalCards(userId);

    if (totalOwned > 0) {
      await interaction.editReply({
        content:
          `❌ Tu possèdes déjà **${totalOwned} carte(s)** dans ta collection ! La commande \`/commencer\` est réservée aux nouveaux joueurs qui n'ont pas encore de cartes.\n` +
          `👉 Utilise la commande \`/deck\` pour accéder à ta collection et à tes decks.`
      });
      return;
    }

    const displayName = interaction.member?.displayName || interaction.user.globalName || interaction.user.username;
    const player = await getOrCreatePlayer(userId, displayName);

    const { tirage } = await drawBalancedCompleteCards(STARTER_PACK_SIZE);

    const countsByCardId = new Map();
    const summaryByRarity = {};

    for (const card of tirage) {
      countsByCardId.set(card.card_id, (countsByCardId.get(card.card_id) || 0) + 1);
      summaryByRarity[card.rarity] = (summaryByRarity[card.rarity] || 0) + 1;
    }

    for (const [cardId, qty] of countsByCardId.entries()) {
      await addCardToInventory(userId, cardId, qty, displayName);
    }

    await markDailyActionUsedToday(userId);

    const detailsRarete = ['Mythique', 'Légendaire', 'Épique', 'Rare', 'Commune']
      .filter((r) => summaryByRarity[r])
      .map((r) => `${r} : **${summaryByRarity[r]}**`)
      .join(' · ');

    const row = construireBoutonsLienMagique(player.auth_token);

    await interaction.editReply({
      content:
        `🎉 **Félicitations ! Tu viens de gagner ton pack de départ de ${tirage.length} cartes Chaomon !**\n` +
        `📊 **Répartition de ton tirage :** ${detailsRarete}\n\n` +
        `Clique sur le bouton ci-dessous pour découvrir ta **Collection** et composer ton premier **Deck** sur l'interface Web :\n` +
        `⚠️ *Ne partage pas ce lien : il contient ta clé de connexion personnelle.*`,
      components: [row]
    });

    const customFiesta = interaction.guild?.emojis.cache.find((e) => e.name.toLowerCase() === 'iconefiesta');
    const fiestaEmoji = customFiesta ? `${customFiesta}` : '🥳';
    const announcePayload = {
      content: `<@${userId}> possède désormais son pack de chaomons de départ ${fiestaEmoji}`
    };

    try {
      if (interaction.channel) {
        await interaction.channel.send(announcePayload);
      } else {
        await interaction.followUp(announcePayload);
      }
    } catch {
      // Si le bot n'a pas la permission SendMessages dans ce salon (50013),
      // on passe par le webhook de l'interaction (followUp public) qui ne nécessite aucune permission de salon.
      await interaction.followUp(announcePayload).catch(() => {});
    }
  } catch (err) {
    console.error('❌ Erreur /commencer :', err);
    await interaction.editReply(`❌ Une erreur est survenue lors de la génération de ton pack de départ : ${err.message}`);
  }
}

// ============================================================================
// FONCTIONS PARTAGÉES D'OUVERTURE & DE RAFRAÎCHISSEMENT DE PACK (5 CARTES)
// ============================================================================
function construireConfirmationOuverturePack(userId, packsCount) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`open_pack_yes:${userId}`)
      .setLabel(`✅ Oui (Packs restants : ${packsCount})`)
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`open_pack_no:${userId}`)
      .setLabel('❌ Non')
      .setStyle(ButtonStyle.Secondary)
  );

  return {
    content:
      `📦 Tu possèdes actuellement **${packsCount} pack(s)** de 5 cartes.\n` +
      `Veux-tu ouvrir **1 pack** maintenant ?`,
    components: [row]
  };
}

function construireBoutonSousPack(userId, remainingPacks, isLoading = false) {
  const hasMorePacks = remainingPacks > 0 && !isLoading;
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`open_another_pack:${userId}`)
      .setLabel(isLoading ? '⏳ Ouverture en cours...' : 'Ouvrir un autre pack')
      .setStyle(hasMorePacks ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setDisabled(!hasMorePacks)
  );
}

function planifierSuppressionMessagePack(message) {
  if (!message || !message.id) return;
  const existingTimer = packMessageTimers.get(message.id);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }
  const timer = setTimeout(() => {
    packMessageTimers.delete(message.id);
    message.delete().catch(() => {});
  }, PACK_MESSAGE_LIFETIME_MS);
  packMessageTimers.set(message.id, timer);
}

async function genererPayloadOuverturePack(userId, displayName) {
  const { cards, remainingPacks } = await openOnePackForPlayer(userId, displayName);

  const attachments = [];
  const batchTs = Date.now();
  for (let i = 0; i < cards.length; i++) {
    const c = cards[i];
    const buf = await renderCardBuffer(c);
    const fileName = `pack_${batchTs}_${i + 1}_${c.card_id}.png`;
    attachments.push(new AttachmentBuilder(buf, { name: fileName }));
  }

  const buttonRow = construireBoutonSousPack(userId, remainingPacks, false);
  const content = `✨ <@${userId}> vient d'ouvrir un pack de 5 cartes Chaomon ! **(${remainingPacks} packs restants à ouvrir)**`;

  return {
    content,
    files: attachments,
    components: [buttonRow],
    remainingPacks
  };
}

async function ouvrirEtPublierPackDansSalon(interaction, userId, displayName) {
  const payload = await genererPayloadOuverturePack(userId, displayName);
  const msgOptions = {
    content: payload.content,
    files: payload.files,
    components: payload.components
  };

  let sentPackMsg = null;
  try {
    if (interaction.channel) {
      sentPackMsg = await interaction.channel.send(msgOptions);
    } else {
      sentPackMsg = await interaction.followUp(msgOptions);
    }
  } catch {
    sentPackMsg = await interaction.followUp(msgOptions).catch(() => null);
  }

  if (sentPackMsg) {
    planifierSuppressionMessagePack(sentPackMsg);
  }

  return payload.remainingPacks;
}

// ============================================================================
// EXÉCUTION DE LA COMMANDE /rsa (1 PACK GRATUIT PAR JOUR -> OUVERT DIRECTEMENT)
// ============================================================================
async function executerCommandeRsa(interaction) {
  await interaction.deferReply({ ephemeral: true });

  try {
    const userId = interaction.user.id;
    const totalOwned = await getPlayerTotalCards(userId);

    if (totalOwned === 0) {
      await interaction.editReply({
        content: '❌ Tu ne possèdes pas encore de cartes ! Commence par utiliser la commande `/commencer` pour obtenir ton pack de départ de 50 cartes.'
      });
      return;
    }

    const displayName = interaction.member?.displayName || interaction.user.globalName || interaction.user.username;
    const result = await claimDailyRsaPack(userId, displayName);

    if (result.alreadyClaimed) {
      await interaction.editReply({
        content:
          `⏳ Tu as déjà perçu ton pack quotidien (ou utilisé \`/commencer\`) aujourd'hui !\n` +
          `Reviens demain pour toucher ton prochain \`/rsa\` *(Packs en stock : **${result.packs}**)*. \n` +
          `👉 Utilise \`/ouvrir\` si tu as des packs en attente d'ouverture !`
      });
      return;
    }

    await interaction.editReply({
      content: '🎁 **Jour de paie !** Ouverture immédiate de ton pack quotidien `/rsa` en cours...'
    });

    await ouvrirEtPublierPackDansSalon(interaction, userId, displayName);
    await interaction.deleteReply().catch(() => {});
  } catch (err) {
    console.error('❌ Erreur /rsa :', err);
    await interaction.editReply(`❌ Impossible de récupérer ou d'ouvrir ton /rsa : ${err.message}`);
  }
}

// ============================================================================
// EXÉCUTION DE LA COMMANDE /ouvrir & RAFRAÎCHISSEMENT DU MÊME MESSAGE
// ============================================================================
async function executerCommandeOuvrir(interaction) {
  await interaction.deferReply({ ephemeral: true });

  try {
    const userId = interaction.user.id;
    const totalOwned = await getPlayerTotalCards(userId);
    if (totalOwned === 0) {
      await interaction.editReply({
        content: '❌ Tu ne possèdes pas encore de cartes ! Commence par taper la commande `/commencer`.'
      });
      return;
    }

    const displayName = interaction.member?.displayName || interaction.user.globalName || interaction.user.username;
    const player = await getOrCreatePlayer(userId, displayName);
    const packsCount = Number(player.packs) || 0;

    if (packsCount < 1) {
      await interaction.editReply({
        content:
          `❌ Tu ne possèdes aucun pack à ouvrir (**0 pack**).\n` +
          `💡 *Tu peux gagner des packs avec \`/rsa\` (1 par jour), en remportant un \`/duel\`, ou en achetant des packs contre 100 ChaOr sur l'interface Web (\`/deck\`) !*`
      });
      return;
    }

    const payload = construireConfirmationOuverturePack(userId, packsCount);
    await interaction.editReply(payload);

    setTimeout(() => {
      interaction.deleteReply().catch(() => {});
    }, PACK_MESSAGE_LIFETIME_MS);
  } catch (err) {
    console.error('❌ Erreur /ouvrir :', err);
    await interaction.editReply(`❌ Erreur lors de la commande /ouvrir : ${err.message}`);
  }
}

async function gererBoutonsOuvrirPack(interaction) {
  const [action, targetUserId] = interaction.customId.split(':');
  if (interaction.user.id !== targetUserId) {
    await interaction.reply({ content: '❌ Ce bouton ne t’appartient pas.', ephemeral: true });
    return;
  }

  if (action === 'open_pack_no') {
    await interaction.update({
      content: '👌 Ouverture de pack annulée.',
      components: []
    });
    setTimeout(() => {
      interaction.deleteReply().catch(() => {});
    }, 5000);
    return;
  }

  if (action === 'open_pack_yes') {
    await interaction.update({
      content: '⏳ **Ouverture de ton pack en cours...** Génération de tes 5 cartes Chaomon...',
      components: []
    });

    try {
      const displayName = interaction.member?.displayName || interaction.user.globalName || interaction.user.username;
      await ouvrirEtPublierPackDansSalon(interaction, interaction.user.id, displayName);
      await interaction.deleteReply().catch(() => {});
    } catch (err) {
      console.error('❌ Erreur ouverture pack :', err);
      await interaction.editReply({
        content: `❌ Impossible d'ouvrir le pack : ${err.message}`,
        components: []
      });
    }
    return;
  }

  if (action === 'open_another_pack') {
    // Grise temporairement le bouton pendant le calcul des 5 nouvelles images
    const loadingRow = construireBoutonSousPack(interaction.user.id, 0, true);
    await interaction.update({
      components: [loadingRow]
    });

    try {
      const displayName = interaction.member?.displayName || interaction.user.globalName || interaction.user.username;
      const payload = await genererPayloadOuverturePack(interaction.user.id, displayName);

      // Rafraîchit le MÊME message en remplaçant les 5 anciennes cartes par les 5 nouvelles (attachments: [])
      const updatedMsg = await interaction.editReply({
        content: payload.content,
        files: payload.files,
        attachments: [],
        components: payload.components
      });

      // Réinitialise le délai de 120 secondes avant suppression automatique du message
      planifierSuppressionMessagePack(updatedMsg || interaction.message);
    } catch (err) {
      console.error('❌ Erreur ouverture pack suivant :', err);
      await interaction.followUp({
        content: `❌ Impossible d'ouvrir un autre pack : ${err.message}`,
        ephemeral: true
      }).catch(() => {});
    }
  }
}

// ============================================================================
// EXÉCUTION DE LA COMMANDE /deck
// ============================================================================
async function executerCommandeDeck(interaction) {
  await interaction.deferReply({ ephemeral: true });
  try {
    const totalOwned = await getPlayerTotalCards(interaction.user.id);
    if (totalOwned === 0) {
      await interaction.editReply({
        content: '❌ Tu ne possèdes pas encore de cartes ! Commence ton aventure en tapant la commande `/commencer` pour obtenir ton pack de départ de 50 cartes.'
      });
      return;
    }

    const displayName = interaction.member?.displayName || interaction.user.globalName || interaction.user.username;
    const player = await getOrCreatePlayer(interaction.user.id, displayName);
    const payload = construireMessageLienMagique(player.auth_token, false);
    await interaction.editReply(payload);
  } catch (err) {
    console.error('❌ Erreur /deck :', err);
    await interaction.editReply('❌ Impossible de générer ton lien magique pour le moment.');
  }
}

// ============================================================================
// EXÉCUTION DE LA COMMANDE /duel & GESTION DU BOUTON D'ACCEPTATION
// ============================================================================
async function executerCommandeDuel(interaction) {
  const challengerUser = interaction.user;
  const targetUser = interaction.options.getUser('utilisateur', true);

  if (targetUser.bot) {
    await interaction.reply({
      content: '💡 Pour t’entraîner contre le Bot, ouvre ton interface Web avec `/deck` et clique sur **« ⚔️ Lancer un duel d’entraînement contre kOkamini »** dans l’onglet **Arène de Duel** !',
      ephemeral: true
    });
    return;
  }
  if (targetUser.id === challengerUser.id) {
    await interaction.reply({ content: '❌ Tu ne peux pas te provoquer toi-même en duel.', ephemeral: true });
    return;
  }

  const p1TotalCards = await getPlayerTotalCards(challengerUser.id);
  if (p1TotalCards === 0) {
    await interaction.reply({
      content: '❌ Tu ne possèdes pas encore de cartes ! Commence par utiliser la commande `/commencer` pour recevoir ton pack de départ de 50 cartes.',
      ephemeral: true
    });
    return;
  }

  const existingDuel = getCurrentDuel();
  if (existingDuel) {
    await interaction.reply({
      content: `❌ Un duel est déjà en cours ou en attente d'acceptation. Attends qu'il se termine avant d'en lancer un nouveau !`,
      ephemeral: true
    });
    return;
  }

  const p1Decks = await getPlayerDecks(challengerUser.id);
  const p1Valid = p1Decks.some(d => d.is_valid);
  if (!p1Valid) {
    await interaction.reply({
      content: '❌ Tu ne possèdes aucun deck valide (20 à 30 cartes uniques). Rends-toi dans le **Deckbuilder Web** (via la commande `/deck`) pour composer et sauvegarder ton deck avant de lancer un duel !',
      ephemeral: true
    });
    return;
  }

  const p2Decks = await getPlayerDecks(targetUser.id);
  const p2Valid = p2Decks.some(d => d.is_valid);
  if (!p2Valid) {
    await interaction.reply({
      content: `❌ Le duel ne peut pas aboutir : <@${targetUser.id}> ne possède pas encore de deck valide (20 à 30 cartes uniques).`,
      ephemeral: true
    });
    return;
  }

  await interaction.reply({
    content: `⏳ En attente d'acceptation du joueur adverse (<@${targetUser.id}>)... *(Il dispose de 120 secondes pour accepter)*`,
    ephemeral: true
  });

  const p1Name = interaction.member?.displayName || challengerUser.globalName || challengerUser.username;
  let p2Name = targetUser.globalName || targetUser.username;
  try {
    const member2 = await interaction.guild?.members.fetch(targetUser.id);
    if (member2) p2Name = member2.displayName;
  } catch {
    // ignore
  }

  const player1 = await getOrCreatePlayer(challengerUser.id, p1Name);
  const player2 = await getOrCreatePlayer(targetUser.id, p2Name);
  player1.avatar_url = resolveAvatarUrl(player1.discord_id, 'neutre strict');
  player2.avatar_url = resolveAvatarUrl(player2.discord_id, 'neutre strict');

  const duel = await createPendingDuel({
    player1,
    player2,
    channelId: interaction.channelId,
    publicMessageId: null,
    challengerInteraction: interaction,
    onTimeoutCallback: async (expiredDuel) => {
      try {
        const ch = await client.channels.fetch(expiredDuel.channelId);
        if (ch && expiredDuel.publicMessageId) {
          const msg = await ch.messages.fetch(expiredDuel.publicMessageId);
          await msg.edit({
            content: `⌛ <@${expiredDuel.players.p2.discord_id}> n'a pas accepté à temps.`,
            components: []
          });
        }
      } catch (e) {
        console.error('⚠️ Erreur édition message timeout duel :', e.message);
      }
    },
    onMatchEndCallback: async (finishedDuel) => {
      try {
        const ch = await client.channels.fetch(finishedDuel.channelId);
        if (ch && finishedDuel.publicMessageId) {
          const msg = await ch.messages.fetch(finishedDuel.publicMessageId);
          const winner = finishedDuel.players[finishedDuel.winnerKey];
          const loserKey = finishedDuel.winnerKey === 'p1' ? 'p2' : 'p1';
          const loser = finishedDuel.players[loserKey];
          const packRewardLine = finishedDuel.rewardPackGranted
            ? `🎁 **+1 Pack de 5 cartes** remporté (tape \`/ouvrir\`) !`
            : `ℹ️ *Pack quotidien contre cet adversaire déjà remporté aujourd'hui.*`;

          await msg.edit({
            content:
              `🏆 **Duel terminé !** <@${winner.discord_id}> remporte la victoire face à <@${loser.discord_id}> (${finishedDuel.winReason}) !\n` +
              `📈 Classement : **+${finishedDuel.eloDelta || 16} Elo** pour ${winner.username}  •  ${packRewardLine}`,
            components: []
          });
        }
      } catch (e) {
        console.error('⚠️ Erreur édition message fin de duel :', e.message);
      }
    }
  });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`duel_accept:${duel.matchId}`)
      .setLabel('✅ Accepter le duel')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`duel_decline:${duel.matchId}`)
      .setLabel('❌ Refuser')
      .setStyle(ButtonStyle.Danger)
  );

  const duelMsgOptions = {
    content:
      `⚔️ <@${player1.discord_id}> défie <@${player2.discord_id}> en duel !\n` +
      `👉 <@${player2.discord_id}>, clique sur le bouton ci-dessous pour accepter le combat *(120 secondes)*.`,
    components: [row]
  };

  let publicMsg = null;
  try {
    if (interaction.channel) {
      publicMsg = await interaction.channel.send(duelMsgOptions);
    } else {
      publicMsg = await interaction.followUp(duelMsgOptions);
    }
  } catch {
    publicMsg = await interaction.followUp(duelMsgOptions).catch(() => null);
  }

  if (publicMsg) {
    duel.publicMessageId = publicMsg.id;
  }
}

async function gererBoutonsDuel(interaction) {
  const [action, matchId] = interaction.customId.split(':');
  const duel = getCurrentDuel();

  if (!duel || duel.matchId !== matchId || duel.status !== 'pending') {
    await interaction.reply({
      content: "❌ Ce défi n'est plus actif ou a déjà expiré.",
      ephemeral: true
    });
    return;
  }

  if (action === 'duel_decline') {
    if (interaction.user.id !== duel.players.p2.discord_id && interaction.user.id !== duel.players.p1.discord_id) {
      await interaction.reply({ content: '❌ Seuls les deux participants peuvent annuler ou refuser ce duel.', ephemeral: true });
      return;
    }
    await cancelPendingDuel('declined');
    await interaction.update({
      content: `🏳️ Le duel entre <@${duel.players.p1.discord_id}> et <@${duel.players.p2.discord_id}> a été refusé/annulé.`,
      components: []
    });
    return;
  }

  if (action === 'duel_accept') {
    if (interaction.user.id !== duel.players.p2.discord_id) {
      await interaction.reply({
        content: `❌ Seul <@${duel.players.p2.discord_id}> peut accepter ce duel !`,
        ephemeral: true
      });
      return;
    }

    await acceptPendingDuel(matchId);

    const p1 = await getOrCreatePlayer(duel.players.p1.discord_id, duel.players.p1.username);
    const p2 = await getOrCreatePlayer(duel.players.p2.discord_id, duel.players.p2.username);

    const p1MagicDuelUrl = `${PUBLIC_WEB_URL}/?token=${p1.auth_token}&match=${duel.matchId}`;
    const p2MagicDuelUrl = `${PUBLIC_WEB_URL}/?token=${p2.auth_token}&match=${duel.matchId}`;
    const spectateUrl = `${PUBLIC_WEB_URL}/?spectate=${duel.matchId}`;

    const spectateRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel('👁️ Regarder le duel en direct (Spectateur)')
        .setStyle(ButtonStyle.Link)
        .setURL(spectateUrl)
    );

    await interaction.update({
      content:
        `🔥 **Duel en cours : <@${p1.discord_id}> 🆚 <@${p2.discord_id}> !**\n` +
        `Les deux combattants ont rejoint l'arène Web. Les autres membres peuvent suivre la partie en direct :`,
      components: [spectateRow]
    });

    const p2Row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel('⚔️ Rejoindre mon duel sur le Web')
        .setStyle(ButtonStyle.Link)
        .setURL(p2MagicDuelUrl)
    );
    await interaction.followUp({
      content: `✅ **Tu as accepté le duel contre <@${p1.discord_id}> !**\nClique sur le bouton ci-dessous pour choisir ton deck et entrer dans l'arène :`,
      components: [p2Row],
      ephemeral: true
    });

    if (duel.challengerInteraction) {
      const p1Row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel('⚔️ Rejoindre mon duel sur le Web')
          .setStyle(ButtonStyle.Link)
          .setURL(p1MagicDuelUrl)
      );
      await duel.challengerInteraction.followUp({
        content: `⚔️ **<@${p2.discord_id}> a accepté votre duel !**\nClique sur le bouton ci-dessous pour accéder directement à l'arène avec ton lien magique :`,
        components: [p1Row],
        ephemeral: true
      }).catch(err => console.error('⚠️ Erreur followUp Joueur 1 :', err.message));
    }
  }
}

// ============================================================================
// GESTIONNAIRE GLOBAL D'INTERACTIONS (COMMANDES SLASH & BOUTONS)
// ============================================================================
client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isButton()) {
    if (interaction.customId === 'launch_discord_activity') {
      try {
        if (typeof interaction.launchActivity === 'function') {
          await interaction.launchActivity();
        } else {
          await interaction.reply({
            content: '❌ Les Activités ne sont pas encore activées sur le portail Discord de ce bot.',
            ephemeral: true
          });
        }
      } catch (err) {
        console.error('❌ Erreur lancement Activité Discord :', err);
        await interaction.reply({
          content: `❌ Impossible de lancer l'Activité Discord : ${err.message}`,
          ephemeral: true
        }).catch(() => {});
      }
      return;
    }

    if (interaction.customId === 'regen_magic_token') {
      try {
        const newToken = await regeneratePlayerToken(interaction.user.id);
        const payload = construireMessageLienMagique(newToken, true);
        await interaction.update(payload);
      } catch (err) {
        console.error('❌ Erreur régénération token :', err);
      }
      return;
    }

    if (interaction.customId.startsWith('catch_chaomon:')) {
      await gererClicAttraperChaomon(interaction);
      return;
    }

    if (
      interaction.customId.startsWith('open_pack_yes:') ||
      interaction.customId.startsWith('open_pack_no:') ||
      interaction.customId.startsWith('open_another_pack:')
    ) {
      await gererBoutonsOuvrirPack(interaction);
      return;
    }

    if (interaction.customId.startsWith('duel_accept:') || interaction.customId.startsWith('duel_decline:')) {
      await gererBoutonsDuel(interaction);
      return;
    }

    if (interaction.customId.startsWith('zreset_confirm_yes:') || interaction.customId.startsWith('zreset_confirm_no:')) {
      await gererBoutonsZreset(interaction);
      return;
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'aide') {
    await executerCommandeAide(interaction);
    return;
  }

  if (interaction.commandName === 'commencer') {
    await executerCommandeCommencer(interaction);
    return;
  }

  if (interaction.commandName === 'deck') {
    await executerCommandeDeck(interaction);
    return;
  }

  if (interaction.commandName === 'duel') {
    await executerCommandeDuel(interaction);
    return;
  }

  if (interaction.commandName === 'rsa') {
    await executerCommandeRsa(interaction);
    return;
  }

  if (interaction.commandName === 'carte') {
    await executerCommandeCarte(interaction);
    return;
  }

  if (interaction.commandName === 'ouvrir') {
    await executerCommandeOuvrir(interaction);
    return;
  }

  if (interaction.commandName === 'zreset') {
    await executerCommandeZreset(interaction);
    return;
  }

  if (interaction.commandName === 'zsalon') {
    await executerCommandeZsalon(interaction);
    return;
  }

  if (interaction.commandName === 'zspawn') {
    await executerCommandeZspawn(interaction);
    return;
  }
});

// ============================================================================
// TUNNEL HTTPS CLOUDFLARE AUTOMATIQUE (MÉTHODE 1) + DÉMARRAGE CONJOINT
// ============================================================================
async function demarrerTunnelCloudflare() {
  try {
    const { Tunnel } = require('cloudflared');
    const tunnel = process.env.CLOUDFLARE_TUNNEL_TOKEN
      ? Tunnel.withToken(process.env.CLOUDFLARE_TUNNEL_TOKEN)
      : Tunnel.quick(`http://127.0.0.1:${PORT}`);

    tunnel.on('url', (httpsUrl) => {
      PUBLIC_WEB_URL = httpsUrl.replace(/\/+$/, '');
      console.log(`🔒 [Tunnel HTTPS] Interface Web sécurisée accessible sur : ${PUBLIC_WEB_URL}`);
    });

    tunnel.on('error', (err) => {
      console.warn('⚠️ [Tunnel HTTPS] Erreur :', err.message);
    });
  } catch (err) {
    console.warn('ℹ️ [Tunnel HTTPS] Module cloudflared non chargé, maintien du HTTP standard.');
  }
}

(async () => {
  try {
    await ensureReady();
    startWebServer();
    await demarrerTunnelCloudflare();
    await client.login(DISCORD_TOKEN);
  } catch (error) {
    console.error('❌ Erreur critique au démarrage :', error);
    process.exit(1);
  }
})();
