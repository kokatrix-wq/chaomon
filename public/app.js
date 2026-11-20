// public/app.js
const RARITY_TEMPLATES = {
  'Commune':    '/assets/templates/Template_Common.jpg?v=3',
  'Rare':       '/assets/templates/Template_Rare.jpg?v=3',
  'Épique':     '/assets/templates/Template_Epic.jpg?v=3',
  'Légendaire': '/assets/templates/Template_Legend.jpg?v=3',
  'Mythique':   '/assets/templates/Template_Mythique.jpg?v=3'
};

const RARITY_ORDER = { 'Mythique': 1, 'Légendaire': 2, 'Épique': 3, 'Rare': 4, 'Commune': 5 };
const ACTIVE_COST_RE = /^\s*(\d+)\s*mana\s*[:\-–—]?\s*/i;

const measureCanvas = document.createElement('canvas');
const measureCtx = measureCanvas.getContext('2d');

const EMPTY_DRAG_IMG = new Image();
EMPTY_DRAG_IMG.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

function normalizeForMatch(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['’]/g, "'");
}

// ============================================================================
// DICTIONNAIRE OFFICIEL DES EFFETS NON EXPLICITES
// ============================================================================
const ABILITY_GLOSSARY = [
  { label: 'Immunité', pattern: /\bimmunite\b/, desc: 'Ne subit aucun dégât et ne peut pas être affectée négativement par les pouvoirs adverses.' },
  { label: 'Indestructible', pattern: /\bindestructible\b/, desc: 'Ne peut pas être détruite, ni par des dégâts ni par un effet « Détruire ».' },
  { label: 'Défenseur', pattern: /\bdefenseur\b/, desc: 'Ne peut pas attaquer (son ATK est toujours 0).' },
  { label: 'Piétinement', pattern: /\bpietinement\b/, desc: "Si ses dégâts dépassent les PV de la créature qui la bloque, l'excédent est infligé au héros adverse." },
  { label: 'Portée', pattern: /\bportee\b/, desc: 'Peut bloquer et attaquer les créatures ennemies qui possèdent Vol.' },
  { label: 'Provocation', pattern: /\bprovocation\b/, desc: 'Les créatures ennemies doivent attaquer cette carte en priorité avant toute autre cible.' },
  { label: 'Vigilance', pattern: /\bvigilance\b/, desc: "Attaquer ne l'engage pas : elle reste disponible pour bloquer et utiliser ses pouvoirs « Engager »." },
  { label: 'Double initiative', pattern: /\bdouble initiative\b/, desc: 'Inflige ses dégâts de combat deux fois : une première fois avant son adversaire, puis une seconde fois en même temps que lui.' },
  { label: 'Initiative', pattern: /(?<!double )\binitiative\b/, desc: 'Inflige ses dégâts de combat avant son adversaire : si elle le détruit, elle ne subit aucun dégât en retour.' },
  { label: 'Menace', pattern: /\bmenace\b/, desc: 'Ne peut être attaquée ou bloquée que si l’adversaire contrôle au moins deux créatures.' },
  { label: 'Bouclier divin', pattern: /\bbouclier divin\b/, desc: 'Ignore la première source de dégâts qu’elle subit, puis perd son Bouclier divin.' },
  { label: 'Camouflage', pattern: /\bcamouflage\b/, desc: "L'adversaire ne peut pas cibler cette créature tant qu'elle n'a pas encore attaqué." },
  { label: 'Célérité', pattern: /\bcelerite\b/, desc: 'Peut attaquer et activer ses pouvoirs « Engager » dès le tour où elle est jouée.' },
  { label: 'Lien de vie', pattern: /\blien de vie\b/, desc: 'Les dégâts que cette créature inflige soignent votre héros du même montant.' },
  { label: 'Vol', pattern: /\bvol\b/, desc: 'Ne peut être bloquée ou attaquée que par une créature ennemie possédant Vol ou Portée.' },
  { label: 'Contact mortel', pattern: /\bcontact mortel\b/, desc: 'Toute créature qui subit au moins 1 dégât de la part de cette carte est immédiatement détruite.' },
  { label: 'Insaisissable', pattern: /\binsaisissable\b/, desc: "Ne peut pas être ciblée par les pouvoirs actifs ou passifs de l'adversaire." },
  { label: 'Régénération', pattern: /\bregeneration\b/, desc: 'Récupère l’intégralité de ses PV à la fin de chaque tour.' },
  { label: 'Méga-furie des vents', pattern: /\bmega-furie des vents\b/, desc: 'Peut attaquer jusqu’à trois fois par tour.' },
  { label: 'Furie des vents', pattern: /(?<!mega-)\bfurie des vents\b/, desc: 'Peut attaquer deux fois par tour.' },
  { label: 'Renaissance', pattern: /\brenaissance\b/, desc: "La première fois qu'elle est détruite, elle revient immédiatement en jeu avec 1 PV (puis perd Renaissance)." },
  { label: 'Cri de guerre', pattern: /\bcri de guerre\b/, desc: 'Effet qui se déclenche une seule fois, au moment où la carte est jouée depuis votre main.' },
  { label: "Râle d'agonie", pattern: /\brale d'agonie\b/, desc: 'Effet qui se déclenche automatiquement lorsque cette créature est détruite.' },
  { label: 'Aura', pattern: /\baura\s*:/, desc: 'Effet passif continu qui reste actif tant que cette créature est en jeu sur le terrain.' },
  { label: 'Enragé', pattern: /\benrage\b/, desc: "Bonus actif tant qu'il manque au moins 1 PV à cette créature (créature blessée)." },
  { label: 'Engager', pattern: /\bengager\b/, desc: 'Coût d’activation : la carte s’épuise (elle ne peut plus attaquer ni payer un autre coût « Engager » avant votre prochain tour).' },
  { label: 'Sacrifier cette créature', pattern: /\bsacrifier cette creature\b/, desc: 'Coût d’activation : cette carte est volontairement détruite et envoyée au cimetière pour déclencher son effet.' },
  { label: 'Payer des PV', pattern: /\bpayer \d+ pv\b/, desc: 'Coût d’activation : votre héros perd le montant de points de vie indiqué pour activer ce pouvoir.' },
  { label: 'Jeton (n/n)', pattern: /\bjeton\s+\d+\/\d+\b/, desc: 'Créature supplémentaire invoquée sur votre terrain avec les statistiques ATK/PV indiquées, sans capacité spéciale.' },
  { label: 'Geler', pattern: /\bgeler\b/, desc: 'Une cible gelée ne peut pas attaquer lors de son prochain tour.' },
  { label: 'Réduire au silence', pattern: /\bsilence\b/, desc: 'La créature ciblée perd définitivement toutes ses capacités (passives et actives).' },
  { label: 'Réanimer', pattern: /\breanimer\b/, desc: 'Remet en jeu sur votre terrain une créature alliée depuis votre cimetière avec ses statistiques d’origine.' },
  { label: 'Voler des PV', pattern: /\bvoler \d+ pv\b/, desc: 'Drain de vie : le héros adverse perd ce montant de PV et votre héros en gagne autant.' },
  { label: 'Détruire', pattern: /\bdetruire\b/, desc: 'Envoie directement la créature au cimetière quels que soient ses PV restants (sans effet sur Indestructible et Immunité).' }
];

function getNonExplicitExplanations(card) {
  const rawCombined = [card.passif1, card.passif2, card.actif1, card.actif2].filter(Boolean).join(' \n ');
  if (!rawCombined.trim()) return [];
  const normalizedCombined = normalizeForMatch(rawCombined);
  return ABILITY_GLOSSARY.filter(item => item.pattern.test(normalizedCombined));
}

const state = {
  token: null,
  matchIdFromUrl: null,
  spectateIdFromUrl: null,
  activeTab: 'collection',
  isMobile: false,
  manualDeviceOverride: null,
  player: null,
  economy: { chaor_per_duplicate: 10, pack_cost_chaor: 100 },
  cards: [],
  cardsById: new Map(),
  decks: [
    { slot_number: 1, name: 'Deck #1', cards: [] },
    { slot_number: 2, name: 'Deck #2', cards: [] },
    { slot_number: 3, name: 'Deck #3', cards: [] }
  ],
  activeSlot: 1,
  deckViewFilter: 'ALL',
  rules: { min_cards: 20, max_cards: 30 },
  socket: null,
  duel: null,
  pendingAction: null,
  draggedHandCard: null,
  draggedAttackUnit: null,
  lastDragPos: { x: 0, y: 0 },
  duelBannerMsg: '',
  mobileLogOpen: false
};

// ============================================================================
// 0. DÉTECTION AUTOMATIQUE DU SMARTPHONE & PLEIN ÉCRAN PAYSAGE EN DUEL ACTIF
// ============================================================================
function detectIsSmartphone() {
  if (state.manualDeviceOverride === 'mobile') return true;
  if (state.manualDeviceOverride === 'pc') return false;

  const ua = navigator.userAgent || navigator.vendor || window.opera || '';
  const isMobileUA = /Android|webOS|iPhone|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua);
  const isSmallViewport = window.innerWidth <= 920 && window.innerHeight <= 920;
  const hasTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);

  return isMobileUA || (isSmallViewport && hasTouch) || window.innerWidth <= 640;
}

function isDuelBoardCurrentlyActive() {
  return Boolean(
    state.isMobile &&
    state.activeTab === 'duel' &&
    state.duel &&
    (state.duel.status === 'active' || state.duel.status === 'finished')
  );
}

function syncMobileDuelBoardClass() {
  const isActiveDuelBoard = isDuelBoardCurrentlyActive();
  document.body.classList.toggle('duel-active-board', isActiveDuelBoard);
}

async function lockMobileLandscapeMode(requestFullscreenToo = true) {
  if (!state.isMobile) return;
  try {
    const docEl = document.documentElement;
    const isFs = document.fullscreenElement || document.webkitFullscreenElement;
    if (requestFullscreenToo && !isFs) {
      if (docEl.requestFullscreen) {
        await docEl.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
      } else if (docEl.webkitRequestFullscreen) {
        docEl.webkitRequestFullscreen();
      }
    }
    if (screen.orientation && screen.orientation.lock) {
      await screen.orientation.lock('landscape').catch(() => {});
    }
    setTimeout(() => window.scrollTo(0, 1), 60);
  } catch {
    // ignore
  }
}

async function unlockMobileLandscapeMode() {
  try {
    if (screen.orientation && screen.orientation.unlock) {
      screen.orientation.unlock();
    }
    const isFs = document.fullscreenElement || document.webkitFullscreenElement;
    if (isFs) {
      if (document.exitFullscreen) {
        await document.exitFullscreen().catch(() => {});
      } else if (document.webkitExitFullscreen) {
        document.webkitExitFullscreen();
      }
    }
  } catch {
    // ignore
  }
}

function applyDeviceMode() {
  const shouldBeMobile = detectIsSmartphone();
  const changed = state.isMobile !== shouldBeMobile;
  state.isMobile = shouldBeMobile;

  document.body.classList.toggle('is-mobile', state.isMobile);
  syncMobileDuelBoardClass();

  const btn = document.getElementById('toggleDeviceModeBtn');
  if (btn) {
    btn.textContent = state.isMobile ? '🖥️ Vue PC' : '📱 Vue Mobile';
  }

  if (changed && state.cards.length > 0) {
    renderCollectionGrid();
    renderDeckbuilder();
    renderDuelArena();
  }
}

// ============================================================================
// 1. GESTION DU TOKEN & PARAMÈTRES D'URL (?token, ?match, ?spectate)
// ============================================================================
function initAuthToken() {
  const params = new URLSearchParams(window.location.search);
  const rawUrlToken = params.get('token');
  const cleanUrlToken = rawUrlToken ? rawUrlToken.replace(/[^a-fA-F0-9]/g, '') : '';

  state.matchIdFromUrl = params.get('match') || null;
  state.spectateIdFromUrl = params.get('spectate') || null;

  if (cleanUrlToken && cleanUrlToken.length >= 32) {
    state.token = cleanUrlToken;
    try {
      localStorage.setItem('chaomon_token', cleanUrlToken);
    } catch (e) {
      // ignore
    }
    return;
  }

  try {
    const saved = localStorage.getItem('chaomon_token');
    const cleanSaved = saved ? saved.replace(/[^a-fA-F0-9]/g, '') : '';
    if (cleanSaved && cleanSaved.length >= 32) {
      state.token = cleanSaved;
    }
  } catch (e) {
    // ignore
  }
}

async function apiFetch(endpoint, options = {}) {
  const headers = options.headers || {};
  if (state.token) {
    headers['Authorization'] = `Bearer ${state.token}`;
    headers['X-Auth-Token'] = state.token;
  }
  if (options.body && typeof options.body === 'object') {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(options.body);
  }

  const separator = endpoint.includes('?') ? '&' : '?';
  const urlWithToken = state.token
    ? `${endpoint}${separator}token=${encodeURIComponent(state.token)}`
    : endpoint;

  const response = await fetch(urlWithToken, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Erreur HTTP ${response.status}`);
  }
  return data;
}

function switchTab(tabName) {
  state.activeTab = tabName;
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tabName));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${tabName}`));

  const economyBar = document.getElementById('economyBar');
  if (economyBar) {
    if (tabName === 'duel' || (!state.token && state.spectateIdFromUrl)) {
      economyBar.classList.add('hidden');
    } else {
      economyBar.classList.remove('hidden');
    }
  }

  if (state.isMobile) {
    if (tabName === 'duel' && state.duel && (state.duel.status === 'active' || state.duel.status === 'finished')) {
      lockMobileLandscapeMode(true);
    } else if (tabName !== 'duel') {
      unlockMobileLandscapeMode();
    }
  }

  syncMobileDuelBoardClass();
  closeMobileDeckDrawer();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ============================================================================
// 1B. BARRE ÉCONOMIE : CHAOR, PACKS, RECYCLAGE DES DOUBLONS & BOUTIQUE
// ============================================================================
function computeDuplicatesCount() {
  let dupCount = 0;
  let uniqueOwned = 0;
  let totalOwned = 0;
  for (const c of state.cards) {
    const qty = Number(c.owned_quantity) || 0;
    if (qty > 0) {
      uniqueOwned++;
      totalOwned += qty;
      if (qty > 1) dupCount += (qty - 1);
    }
  }
  return { dupCount, uniqueOwned, totalOwned };
}

function updateEconomyUI() {
  if (!state.player) return;

  const { dupCount, uniqueOwned, totalOwned } = computeDuplicatesCount();
  const chaor = Number(state.player.chaor) || 0;
  const packs = Number(state.player.packs) || 0;
  const chaorPerDup = state.economy.chaor_per_duplicate || 10;
  const packCost = state.economy.pack_cost_chaor || 100;
  const potentialChaor = dupCount * chaorPerDup;
  const maxPacksBuyable = Math.floor(chaor / packCost);

  const chaorEl = document.getElementById('chaorBalanceText');
  if (chaorEl) chaorEl.textContent = `${chaor} ChaOr`;

  const packsEl = document.getElementById('packsBalanceText');
  if (packsEl) packsEl.textContent = `${packs} Pack${packs > 1 ? 's' : ''}`;

  const recycleBtn = document.getElementById('recycleDuplicatesBtn');
  if (recycleBtn) {
    recycleBtn.disabled = dupCount <= 0;
    recycleBtn.textContent = dupCount > 0
      ? `♻️ Recycler ${dupCount} doublon${dupCount > 1 ? 's' : ''} (+${potentialChaor} ChaOr)`
      : '♻️ Aucun doublon à recycler';
  }

  const buyPackBtn = document.getElementById('buyPackBtn');
  if (buyPackBtn) {
    buyPackBtn.disabled = maxPacksBuyable < 1;
    if (maxPacksBuyable >= 1) {
      const totalCost = maxPacksBuyable * packCost;
      buyPackBtn.textContent = `🛒 Acheter ${maxPacksBuyable} Pack${maxPacksBuyable > 1 ? 's' : ''} (${totalCost} ChaOr)`;
    } else {
      buyPackBtn.textContent = `🛒 Acheter 1 Pack (${packCost} ChaOr)`;
    }
  }

  const playerStatsEl = document.getElementById('playerStats');
  if (playerStatsEl) {
    playerStatsEl.textContent =
      `🏆 ${state.player.elo} Elo · 🪙 ${chaor} ChaOr · 📦 ${packs} Pack${packs > 1 ? 's' : ''}`;
  }

  const summaryBadgeEl = document.getElementById('collectionSummaryBadge');
  if (summaryBadgeEl) {
    summaryBadgeEl.textContent =
      `Débloquées : ${uniqueOwned} / ${state.cards.length} (Total : ${totalOwned})`;
  }
}

function showEconomyFeedback(msg, isError = false) {
  const el = document.getElementById('economyFeedbackMsg');
  if (!el) return;
  el.textContent = msg;
  el.style.color = isError ? '#fca5a5' : '#6ee7b7';
  el.style.borderColor = isError ? 'rgba(239,68,68,0.45)' : 'rgba(16,185,129,0.35)';
  el.style.background = isError ? 'rgba(239,68,68,0.14)' : 'rgba(16,185,129,0.14)';
  el.classList.remove('hidden');
  clearTimeout(el._hideTimer);
  el._hideTimer = setTimeout(() => el.classList.add('hidden'), 5000);
}

async function handleRecycleDuplicates() {
  const { dupCount } = computeDuplicatesCount();
  if (dupCount <= 0) return;

  const recycleBtn = document.getElementById('recycleDuplicatesBtn');
  try {
    if (recycleBtn) recycleBtn.disabled = true;
    const res = await apiFetch('/api/recycle', { method: 'POST' });

    for (const c of state.cards) {
      if ((c.owned_quantity || 0) > 1) {
        c.owned_quantity = 1;
      }
    }
    state.player.chaor = res.chaor;

    updateEconomyUI();
    renderCollectionGrid();
    renderDeckbuilder();

    showEconomyFeedback(
      `♻️ ${res.recycled_count} doublon(s) recyclé(s) avec succès ! Tu as reçu +${res.chaor_gained} ChaOr (Solde : ${res.chaor} ChaOr).`
    );
  } catch (err) {
    showEconomyFeedback(`❌ ${err.message}`, true);
    updateEconomyUI();
  }
}

async function handleBuyPack() {
  const buyBtn = document.getElementById('buyPackBtn');
  try {
    if (buyBtn) buyBtn.disabled = true;
    const res = await apiFetch('/api/shop/buy-pack', { method: 'POST' });

    state.player.chaor = res.chaor;
    state.player.packs = res.packs;
    updateEconomyUI();

    const nb = res.packs_bought || 1;
    showEconomyFeedback(
      `🎉 ${nb} Pack${nb > 1 ? 's' : ''} de 5 cartes acheté${nb > 1 ? 's' : ''} (-${res.cost_chaor || nb * 100} ChaOr) ! Tu possèdes maintenant ${res.packs} pack${res.packs > 1 ? 's' : ''}. Tape /ouvrir sur Discord pour les ouvrir !`
    );
  } catch (err) {
    showEconomyFeedback(`❌ ${err.message}`, true);
    updateEconomyUI();
  }
}

// ============================================================================
// 2. RENDU DYNAMIQUE DES CARTES
// ============================================================================
function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function extractAbilities(card) {
  const list = [];
  const pushAb = (raw, type) => {
    const text = String(raw || '').trim();
    if (!text) return;
    let cost = null;
    let body = text;
    if (type === 'active') {
      const m = ACTIVE_COST_RE.exec(text);
      if (m) {
        cost = m[1];
        body = text.slice(m[0].length).replace(/^\+\s*/, '').trim();
      }
    }
    list.push({ type, cost, text: body });
  };
  if (card.passif1) pushAb(card.passif1, 'passive');
  if (card.passif2) pushAb(card.passif2, 'passive');
  if (card.actif1)  pushAb(card.actif1, 'active');
  if (card.actif2)  pushAb(card.actif2, 'active');
  return list;
}

function wrapCanvasLines(ctx, text, maxWidth) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let currentLine = '';
  for (const word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    if (ctx.measureText(testLine).width > maxWidth && currentLine) {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = testLine;
    }
  }
  if (currentLine) lines.push(currentLine);
  return lines;
}

function computeDynamicCardTypography(card, abilities) {
  const REF_W = 750;
  const REF_H = 1004;
  const SCALE_X = REF_W / 1792;
  const SCALE_Y = REF_H / 2400;

  const textMaxW = (1595 - 195) * SCALE_X;
  const boxTopY = 1565 * SCALE_Y;
  const boxBottomY = 2150 * SCALE_Y;

  const abFontSizePx = abilities.length >= 3 ? 16 : 18;
  const abLineHeightPx = abFontSizePx + 9;
  let cursorY = boxTopY;

  if (abilities.length > 0 && measureCtx) {
    for (const ab of abilities) {
      const indentPx = ab.cost !== null ? 45 : 0;
      measureCtx.font = `${abFontSizePx}px sans-serif`;
      const lines = wrapCanvasLines(measureCtx, ab.text, (textMaxW - indentPx) * 0.96);
      const blockH = Math.max(abLineHeightPx, lines.length * abLineHeightPx);
      cursorY += blockH + 6;
    }
    cursorY += 4;
  }

  const abFontCqw = `${((abFontSizePx / REF_W) * 100).toFixed(2)}cqw`;

  if (!card.explanation || !measureCtx) {
    return { abFontCqw, flavorFontCqw: '2.40cqw', flavorLineHeight: '1.2' };
  }

  const flavorText = `« ${card.explanation} »`;
  const availableHeight = boxBottomY - Math.max(cursorY, boxTopY) - 8;
  const flavorMaxW = textMaxW * 0.95;

  const FLAVOR_FONT_MAX = 24;
  const FLAVOR_FONT_MIN = 9;
  let chosenSizePx = null;
  let lineGapPx = 4;

  for (let size = FLAVOR_FONT_MAX; size >= FLAVOR_FONT_MIN; size--) {
    measureCtx.font = `italic ${size}px Georgia, serif`;
    const lines = wrapCanvasLines(measureCtx, flavorText, flavorMaxW);
    if (lines.length * (size + 4) <= availableHeight) {
      chosenSizePx = size;
      break;
    }
  }

  if (chosenSizePx === null) {
    chosenSizePx = FLAVOR_FONT_MIN;
    lineGapPx = 2;
  }

  const flavorFontCqw = `${((chosenSizePx / REF_W) * 100).toFixed(2)}cqw`;
  const flavorLineHeight = ((chosenSizePx + lineGapPx) / chosenSizePx).toFixed(2);

  return { abFontCqw, flavorFontCqw, flavorLineHeight };
}

function adjustHoverTransformOrigin(wrapperEl) {
  if (state.isMobile) return;
  const rect = wrapperEl.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let originX = 'center';
  let originY = 'center';

  if (rect.left < 180) originX = 'left';
  else if (vw - rect.right < 180) originX = 'right';

  if (rect.top < 190) originY = 'top';
  else if (vh - rect.bottom < 190) originY = 'bottom';

  wrapperEl.style.transformOrigin = `${originX} ${originY}`;
}

function createCardElement(card, {
  showOwnedBadge = true,
  isSelectedInDeck = false,
  showMobileInspectBtn = false,
  onClick = null
} = {}) {
  const wrapper = document.createElement('div');
  const isOwned = (card.owned_quantity || 0) > 0;
  wrapper.className = `tcg-card-wrapper ${(!isOwned && showOwnedBadge) ? 'unowned' : ''}`;

  const templateUrl = RARITY_TEMPLATES[card.rarity] || RARITY_TEMPLATES['Commune'];
  const abilities = card.silenced ? [] : extractAbilities(card);
  const { abFontCqw, flavorFontCqw, flavorLineHeight } = computeDynamicCardTypography(card, abilities);

  const abilitiesHtml = abilities.map(ab => {
    const bubble = ab.cost !== null
      ? `<span class="tcg-mana-bubble">${escapeHtml(ab.cost)}</span>`
      : '';
    return `<div class="tcg-ability-line ${ab.type}" style="font-size:${abFontCqw}">${bubble}<span>${escapeHtml(ab.text)}</span></div>`;
  }).join('');

  const flavorHtml = card.explanation
    ? `<div class="tcg-card-flavor" style="font-size:${flavorFontCqw};line-height:${flavorLineHeight}">« ${escapeHtml(card.explanation)} »</div>`
    : '';

  let badgeHtml = '';
  if (showOwnedBadge) {
    badgeHtml = isOwned
      ? `<div class="owned-badge">x${card.owned_quantity}</div>`
      : `<div class="owned-badge locked">🔒 0</div>`;
  }

  const checkBadgeHtml = isSelectedInDeck ? `<div class="deck-check-badge"></div>` : '';

  wrapper.innerHTML = `
    ${badgeHtml}
    ${checkBadgeHtml}
    <div class="tcg-card rarity-${escapeHtml(card.rarity)}">
      <img class="tcg-card-template" src="${templateUrl}" alt="${escapeHtml(card.rarity)}" loading="lazy" draggable="false" />
      <div class="tcg-card-art-box">
        <img class="tcg-card-avatar" src="${escapeHtml(card.avatar_url)}" alt="${escapeHtml(card.display_name)}" loading="lazy" draggable="false" />
        <div class="tcg-card-art-vignette"></div>
      </div>
      <div class="tcg-card-title">${escapeHtml(card.display_name || card.username)}</div>
      <div class="tcg-card-cost">${card.cout ?? 0}</div>
      <div class="tcg-card-type-bar">
        <span class="tcg-card-creature">${escapeHtml(card.creature || 'Entité Mystérieuse')}</span>
        <span class="tcg-card-alignment">${escapeHtml(card.alignment || '')}</span>
      </div>
      <div class="tcg-card-textbox">
        <div class="tcg-card-abilities">${abilitiesHtml}</div>
        ${flavorHtml}
      </div>
      <div class="tcg-card-stats">${card.attaque ?? 0} / ${card.vie ?? 0}</div>
    </div>
  `;

  if (showMobileInspectBtn) {
    const inspectBtn = document.createElement('button');
    inspectBtn.type = 'button';
    inspectBtn.className = 'mobile-inspect-btn';
    inspectBtn.title = 'Inspecter la carte en grand';
    inspectBtn.textContent = '🔍';
    inspectBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openCardModal(card);
    });
    wrapper.appendChild(inspectBtn);
  }

  wrapper.addEventListener('mouseenter', () => adjustHoverTransformOrigin(wrapper));

  if (onClick) {
    wrapper.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick(card);
    });
  }
  return wrapper;
}

// ============================================================================
// 3. ONGLET COLLECTION & GRANDE MODALE D'INSPECTION (TAP COURT = FERMER, SWIPE = LIRE)
// ============================================================================
function renderCollectionGrid() {
  const grid = document.getElementById('collectionGrid');
  if (!grid) return;
  const query = document.getElementById('searchInput').value.toLowerCase().trim();
  const rarity = document.getElementById('rarityFilter').value;
  const alignment = document.getElementById('alignmentFilter').value;
  const ownership = document.getElementById('ownershipFilter').value;
  const sortBy = document.getElementById('sortFilter').value;

  const filtered = state.cards.filter(c => {
    if (rarity !== 'ALL' && c.rarity !== rarity) return false;
    if (alignment !== 'ALL') {
      const cardAlign = (c.alignment || '').toLowerCase();
      if (alignment === 'Neutre Strict') {
        if (!cardAlign.includes('neutre strict') && !cardAlign.includes('neutre neutre')) return false;
      } else if (cardAlign !== alignment.toLowerCase()) {
        return false;
      }
    }
    if (ownership === 'OWNED' && (c.owned_quantity || 0) <= 0) return false;
    if (ownership === 'DUPLICATES' && (c.owned_quantity || 0) <= 1) return false;
    if (ownership === 'MISSING' && (c.owned_quantity || 0) > 0) return false;

    if (query) {
      const haystack = `${c.display_name} ${c.username} ${c.creature} ${c.alignment} ${c.passif1} ${c.passif2} ${c.actif1} ${c.actif2} ${c.explanation}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });

  filtered.sort((a, b) => {
    if (sortBy === 'COST_ASC') return a.cout - b.cout;
    if (sortBy === 'COST_DESC') return b.cout - a.cout;
    if (sortBy === 'ATK_DESC') return b.attaque - a.attaque;
    if (sortBy === 'HP_DESC') return b.vie - a.vie;
    if (sortBy === 'NAME_ASC') return (a.display_name || '').localeCompare(b.display_name || '');
    return (RARITY_ORDER[a.rarity] || 9) - (RARITY_ORDER[b.rarity] || 9);
  });

  grid.innerHTML = '';
  const fragment = document.createDocumentFragment();
  for (const card of filtered) {
    fragment.appendChild(createCardElement(card, {
      showOwnedBadge: true,
      onClick: openCardModal
    }));
  }
  grid.appendChild(fragment);
}

function openCardModal(card, { allowSummonFromModal = false, onSummonFromModal = null } = {}) {
  const modal = document.getElementById('cardModal');
  const preview = document.getElementById('modalCardContainer');
  const details = document.getElementById('modalCardDetails');

  preview.innerHTML = '';
  preview.appendChild(createCardElement(card, { showOwnedBadge: false }));

  const abilities = extractAbilities(card);
  const abilitiesListHtml = abilities.length > 0
    ? abilities.map(a => `<p><strong>${a.type === 'passive' ? '🛡️ Passif' : `⚔️ Actif (${a.cost || 0} mana)`} :</strong> ${escapeHtml(a.text)}</p>`).join('')
    : '<p><em>Aucune capacité spéciale.</em></p>';

  const explanations = getNonExplicitExplanations(card);
  const glossaryHtml = explanations.length > 0
    ? `
      <div class="glossary-box">
        <div class="glossary-box-title">📖 Explication des effets de la carte</div>
        ${explanations.map(item => `
          <div class="glossary-item">
            <strong>• ${escapeHtml(item.label)} :</strong> ${escapeHtml(item.desc)}
          </div>
        `).join('')}
      </div>
    `
    : '';

  const summonBtnHtml = allowSummonFromModal
    ? `<button type="button" id="modalSummonCardBtn" class="btn-primary" style="margin-top:8px;">🃏 Invoquer cette créature sur le terrain (${card.cout ?? 0} 💧)</button>`
    : '';

  const tapHintHtml = state.isMobile
    ? `<div class="modal-tap-hint">💡 Glisse pour lire • Touche brièvement l'écran pour refermer</div>`
    : '';

  details.innerHTML = `
    ${tapHintHtml}
    <h2>${escapeHtml(card.display_name)} <small style="color:#a1a1aa">(@${escapeHtml(card.username)})</small></h2>
    <p><strong>Rareté :</strong> ${escapeHtml(card.rarity)} ${card.owned_quantity !== undefined ? `&nbsp;|&nbsp; <strong>Exemplaires possédés :</strong> x${card.owned_quantity || 0}` : ''}</p>
    <p><strong>Créature :</strong> ${escapeHtml(card.creature || '—')} &nbsp;|&nbsp; <strong>Alignement :</strong> ${escapeHtml(card.alignment || '—')}</p>
    <p><strong>Coût :</strong> 💧 ${card.cout} Mana &nbsp;|&nbsp; <strong>Attaque :</strong> ⚔️ ${card.attaque} &nbsp;|&nbsp; <strong>Vie :</strong> ❤️ ${card.vie}</p>
    <hr style="border-color:rgba(255,255,255,0.1);margin:6px 0;" />
    ${abilitiesListHtml}
    ${card.explanation ? `<blockquote style="font-style:italic;color:#d4d4d8;margin-top:6px;">« ${escapeHtml(card.explanation)} »</blockquote>` : ''}
    ${glossaryHtml}
    ${summonBtnHtml}
  `;

  if (allowSummonFromModal && onSummonFromModal) {
    document.getElementById('modalSummonCardBtn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      modal.classList.add('hidden');
      onSummonFromModal(card);
    });
  }

  modal.classList.remove('hidden');
}

function setupModalShortTapToClose() {
  const modal = document.getElementById('cardModal');
  if (!modal) return;

  const modalContent = modal.querySelector('.modal-content');
  let startX = 0;
  let startY = 0;
  let startScrollTop = 0;
  let startTime = 0;
  let didMoveOrScroll = false;

  modal.addEventListener('touchstart', (e) => {
    if (!e.touches || e.touches.length !== 1) return;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    startScrollTop = (modalContent ? modalContent.scrollTop : 0) + modal.scrollTop;
    startTime = Date.now();
    didMoveOrScroll = false;
  }, { passive: true });

  modal.addEventListener('touchmove', (e) => {
    if (!e.touches || e.touches.length !== 1) return;
    const dx = Math.abs(e.touches[0].clientX - startX);
    const dy = Math.abs(e.touches[0].clientY - startY);
    const currentScroll = (modalContent ? modalContent.scrollTop : 0) + modal.scrollTop;
    if (dx > 12 || dy > 12 || Math.abs(currentScroll - startScrollTop) > 4) {
      didMoveOrScroll = true;
    }
  }, { passive: true });

  modal.addEventListener('touchend', (e) => {
    if (e.target.closest('#modalSummonCardBtn')) return;
    const dt = Date.now() - startTime;
    const currentScroll = (modalContent ? modalContent.scrollTop : 0) + modal.scrollTop;
    if (Math.abs(currentScroll - startScrollTop) > 4) {
      didMoveOrScroll = true;
    }
    if (!didMoveOrScroll && dt > 0 && dt < 420) {
      e.preventDefault();
      modal.classList.add('hidden');
    }
  });

  modal.addEventListener('click', (e) => {
    if (e.target.closest('#modalSummonCardBtn')) return;
    const selection = window.getSelection ? String(window.getSelection()) : '';
    if (selection.length > 0) return;
    modal.classList.add('hidden');
  });
}

// ============================================================================
// 4. ONGLET DECKBUILDER
// ============================================================================
function normalizeDeckUniqueCards(cardIds) {
  if (!Array.isArray(cardIds)) return [];
  const seenIds = new Set();
  const seenNames = new Set();
  const clean = [];

  for (const rawId of cardIds) {
    const id = String(rawId || '').trim();
    if (!id || seenIds.has(id)) continue;
    const cardObj = state.cardsById.get(id);
    if (!cardObj) continue;

    const nameKey = String(cardObj.display_name || id).toLowerCase().trim();
    if (seenNames.has(nameKey)) continue;

    seenIds.add(id);
    seenNames.add(nameKey);
    clean.push(id);
  }
  return clean;
}

function getActiveDeck() {
  return state.decks.find(d => d.slot_number === state.activeSlot);
}

function isCardInActiveDeck(cardId) {
  const deck = getActiveDeck();
  if (!deck) return false;
  const targetId = String(cardId || '').trim();
  return deck.cards.some(id => String(id).trim() === targetId);
}

function toggleCardInActiveDeck(card) {
  const deck = getActiveDeck();
  if (!deck) return;

  const targetId = String(card.card_id || '').trim();
  const statusEl = document.getElementById('deckStatusMsg');

  if (isCardInActiveDeck(targetId)) {
    removeCardFromActiveDeck(targetId);
    return;
  }

  const targetName = String(card.display_name || '').toLowerCase().trim();
  const sameNameExists = deck.cards.some(id => {
    const c = state.cardsById.get(String(id).trim());
    return c && String(c.display_name || '').toLowerCase().trim() === targetName;
  });
  if (sameNameExists) {
    statusEl.style.color = '#fbbf24';
    statusEl.textContent = `ℹ️ Un exemplaire de « ${card.display_name} » est déjà présent dans ce deck.`;
    return;
  }

  deck.cards = normalizeDeckUniqueCards(deck.cards);

  if (deck.cards.length >= state.rules.max_cards) {
    statusEl.style.color = '#f87171';
    statusEl.textContent = `⚠️ Maximum de ${state.rules.max_cards} cartes uniques atteint !`;
    return;
  }

  deck.cards.push(targetId);
  deck.cards = normalizeDeckUniqueCards(deck.cards);
  statusEl.textContent = '';
  renderDeckbuilder();
}

function removeCardFromActiveDeck(cardId) {
  const deck = getActiveDeck();
  if (!deck) return;
  const targetId = String(cardId || '').trim();
  deck.cards = deck.cards.filter(id => String(id).trim() !== targetId);
  document.getElementById('deckStatusMsg').textContent = '';
  renderDeckbuilder();
}

function openMobileDeckDrawer() {
  if (!state.isMobile) return;
  document.getElementById('mobileDeckBackdrop')?.classList.remove('hidden');
  document.getElementById('deckSidebarDrawer')?.classList.add('mobile-drawer-open');
}

function closeMobileDeckDrawer() {
  document.getElementById('mobileDeckBackdrop')?.classList.add('hidden');
  document.getElementById('deckSidebarDrawer')?.classList.remove('mobile-drawer-open');
}

function renderDeckbuilder() {
  const deck = getActiveDeck();
  if (!deck) return;

  deck.cards = normalizeDeckUniqueCards(deck.cards);

  document.querySelectorAll('.slot-btn').forEach(btn => {
    const s = Number(btn.dataset.slot);
    const d = state.decks.find(x => x.slot_number === s);
    btn.classList.toggle('active', s === state.activeSlot);
    btn.textContent = `${d ? d.name : `Deck #${s}`} (${d ? d.cards.length : 0})`;
  });

  document.querySelectorAll('.deck-view-opt').forEach(btn => {
    const mode = btn.getAttribute('data-deck-view');
    btn.classList.toggle('active', mode === state.deckViewFilter);
    if (mode === 'SELECTED') {
      btn.textContent = `Sélectionnées (${deck.cards.length})`;
    } else if (mode === 'AVAILABLE') {
      btn.textContent = 'Disponibles';
    } else if (mode === 'ALL') {
      btn.textContent = 'Toutes';
    }
  });

  const nameInput = document.getElementById('deckNameInput');
  if (document.activeElement !== nameInput) {
    nameInput.value = deck.name;
  }

  const count = deck.cards.length;
  const isValid = count >= state.rules.min_cards && count <= state.rules.max_cards;
  const countBadge = document.getElementById('deckCountBadge');
  countBadge.textContent = `${count} / ${state.rules.max_cards} uniques (min ${state.rules.min_cards})`;
  countBadge.classList.toggle('valid', isValid);

  const mobileBarTitle = document.getElementById('mobileDeckBarTitle');
  const mobileBarCount = document.getElementById('mobileDeckBarCount');
  if (mobileBarTitle) mobileBarTitle.textContent = deck.name || `Deck #${deck.slot_number}`;
  if (mobileBarCount) {
    mobileBarCount.textContent = `${count} / ${state.rules.max_cards} cartes (min ${state.rules.min_cards})`;
    mobileBarCount.classList.toggle('valid', isValid);
  }

  let totalCost = 0;
  const curveBins = [0, 0, 0, 0, 0, 0, 0, 0];
  for (const cid of deck.cards) {
    const c = state.cardsById.get(cid);
    if (!c) continue;
    totalCost += c.cout;
    const binIdx = Math.min(7, Math.max(0, (c.cout || 1) - 1));
    curveBins[binIdx]++;
  }
  const avg = count > 0 ? (totalCost / count).toFixed(1) : '0.0';
  document.getElementById('deckAvgCost').textContent = `Coût moyen : ${avg} 💧`;

  const maxBin = Math.max(1, ...curveBins);
  const labels = ['1', '2', '3', '4', '5', '6', '7', '8+'];
  document.getElementById('manaCurve').innerHTML = curveBins.map((val, i) => {
    const heightPct = Math.round((val / maxBin) * 42);
    return `
      <div class="mana-bar-col">
        <span>${val || ''}</span>
        <div class="mana-bar-fill" style="height:${heightPct}px"></div>
        <strong>${labels[i]}</strong>
      </div>
    `;
  }).join('');

  const sortedCardsInDeck = deck.cards
    .map(cid => state.cardsById.get(cid))
    .filter(Boolean)
    .sort((a, b) => a.cout - b.cout || a.display_name.localeCompare(b.display_name));

  const listEl = document.getElementById('deckCardList');
  listEl.innerHTML = '';
  if (sortedCardsInDeck.length === 0) {
    listEl.innerHTML = `<p style="color:#a1a1aa;text-align:center;padding:24px 8px;">Aucune carte dans ce deck.<br/>Touche tes cartes pour les ajouter !</p>`;
  } else {
    for (const card of sortedCardsInDeck) {
      const row = document.createElement('div');
      row.className = `deck-row-item rarity-${card.rarity}`;
      row.title = 'Cliquer pour retirer cette carte du deck';
      row.innerHTML = `
        <div class="deck-row-left">
          <span class="deck-row-cost">${card.cout}</span>
          <span class="deck-row-name">${escapeHtml(card.display_name)}</span>
        </div>
        <span class="deck-row-remove">✕</span>
      `;
      row.addEventListener('click', () => removeCardFromActiveDeck(card.card_id));
      listEl.appendChild(row);
    }
  }

  const poolGrid = document.getElementById('deckPoolGrid');
  const q = document.getElementById('deckSearchInput').value.toLowerCase().trim();
  const rFilter = document.getElementById('deckRarityFilter').value;
  const cFilter = document.getElementById('deckCostFilter').value;

  const ownedCards = state.cards.filter(c => {
    if ((c.owned_quantity || 0) <= 0) return false;
    const inDeck = isCardInActiveDeck(c.card_id);
    if (state.deckViewFilter === 'AVAILABLE' && inDeck) return false;
    if (state.deckViewFilter === 'SELECTED' && !inDeck) return false;

    if (rFilter !== 'ALL' && c.rarity !== rFilter) return false;
    if (cFilter !== 'ALL') {
      if (cFilter === '7+' && c.cout < 7) return false;
      if (cFilter !== '7+' && c.cout !== Number(cFilter)) return false;
    }
    if (q) {
      const hay = `${c.display_name} ${c.creature} ${c.passif1} ${c.passif2} ${c.actif1} ${c.actif2}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  poolGrid.innerHTML = '';
  if (ownedCards.length === 0) {
    let emptyMsg = 'Aucune carte possédée ne correspond à ce filtre.';
    if (state.deckViewFilter === 'SELECTED') {
      emptyMsg = 'Aucune carte sélectionnée dans ce deck ne correspond à ce filtre.';
    } else if (state.deckViewFilter === 'AVAILABLE') {
      emptyMsg = 'Aucune carte disponible (hors de ce deck) ne correspond à ce filtre.';
    }
    poolGrid.innerHTML = `<p style="grid-column:1/-1;color:#a1a1aa;padding:20px;">${emptyMsg}</p>`;
    return;
  }

  const frag = document.createDocumentFragment();
  for (const card of ownedCards) {
    const selected = isCardInActiveDeck(card.card_id);
    frag.appendChild(createCardElement(card, {
      showOwnedBadge: false,
      isSelectedInDeck: selected,
      showMobileInspectBtn: true,
      onClick: () => toggleCardInActiveDeck(card)
    }));
  }
  poolGrid.appendChild(frag);
}

async function saveCurrentDeck() {
  const deck = getActiveDeck();
  if (!deck) return;
  const statusEl = document.getElementById('deckStatusMsg');
  const quickSaveBtn = document.getElementById('mobileQuickSaveDeckBtn');
  deck.name = document.getElementById('deckNameInput').value.trim() || `Deck #${deck.slot_number}`;

  try {
    statusEl.style.color = '#6ee7b7';
    statusEl.textContent = '⏳ Sauvegarde en cours...';
    if (quickSaveBtn) quickSaveBtn.textContent = '⏳...';

    const res = await apiFetch(`/api/decks/${deck.slot_number}`, {
      method: 'POST',
      body: { name: deck.name, cards: deck.cards }
    });
    deck.is_valid = res.deck.is_valid;
    const validNotice = res.deck.is_valid
      ? '✅ Deck de cartes uniques complet et prêt pour les duels !'
      : `💾 Brouillon sauvegardé (${res.deck.cards.length}/${state.rules.min_cards} cartes uniques min pour duel).`;
    statusEl.style.color = '#34d399';
    statusEl.textContent = validNotice;
    if (quickSaveBtn) {
      quickSaveBtn.textContent = '✅ Sauvé !';
      setTimeout(() => { quickSaveBtn.textContent = '💾 Sauver'; }, 1800);
    }
    renderDeckbuilder();
  } catch (err) {
    statusEl.style.color = '#f87171';
    statusEl.textContent = `❌ ${err.message}`;
    if (quickSaveBtn) quickSaveBtn.textContent = '💾 Sauver';
  }
}

// ============================================================================
// 5. ONGLET ARÈNE DE DUEL
// ============================================================================
function startCustomDragGhost(cardData, e) {
  removeCustomDragGhost();
  if (e && e.dataTransfer && EMPTY_DRAG_IMG.complete) {
    try {
      e.dataTransfer.setDragImage(EMPTY_DRAG_IMG, 0, 0);
    } catch {
      // ignore
    }
  }

  const ghostWidth = state.isMobile ? 84 : 155;
  const ghost = document.createElement('div');
  ghost.id = 'customDragGhost';
  ghost.className = 'custom-drag-ghost';
  ghost.style.cssText = [
    'position: fixed',
    'top: 0',
    'left: 0',
    `width: ${ghostWidth}px`,
    'pointer-events: none',
    'z-index: 99999',
    'opacity: 0.96',
    'transform: translate(-50%, -50%) scale(1.06)',
    'filter: drop-shadow(0 16px 28px rgba(0, 0, 0, 0.92))',
    'transition: none'
  ].join(';');

  const cardEl = createCardElement(cardData, { showOwnedBadge: false, showMobileInspectBtn: false });
  cardEl.style.maxWidth = `${ghostWidth}px`;
  cardEl.style.transform = 'none';
  cardEl.style.pointerEvents = 'none';
  ghost.appendChild(cardEl);

  document.body.appendChild(ghost);
  const cx = e?.clientX ?? e?.touches?.[0]?.clientX ?? 0;
  const cy = e?.clientY ?? e?.touches?.[0]?.clientY ?? 0;
  if (cx || cy) {
    moveCustomDragGhost(cx, cy);
  }
}

function moveCustomDragGhost(x, y) {
  const ghost = document.getElementById('customDragGhost');
  if (ghost && typeof x === 'number' && typeof y === 'number' && (x > 0 || y > 0)) {
    ghost.style.left = `${x}px`;
    ghost.style.top = `${y}px`;
  }
}

function removeCustomDragGhost() {
  document.getElementById('customDragGhost')?.remove();
}

// Fenêtre d'abandon 100% interne au DOM (remplace window.confirm() qui fait réapparaître la barre d'URL)
function askForfeitConfirmation(matchId) {
  document.getElementById('forfeitConfirmOverlay')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'forfeitConfirmOverlay';
  overlay.className = 'forfeit-confirm-overlay';
  overlay.innerHTML = `
    <div class="forfeit-confirm-box">
      <h3>🏳️ Abandonner le duel ?</h3>
      <p>Es-tu sûr de vouloir déclarer forfait pour cette partie ?</p>
      <div class="forfeit-confirm-actions">
        <button type="button" id="cancelForfeitModalBtn" class="btn-secondary">Annuler</button>
        <button type="button" id="confirmForfeitModalBtn" class="btn-danger-cancel">🏳️ Abandonner</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  document.getElementById('cancelForfeitModalBtn')?.addEventListener('click', () => {
    overlay.remove();
  });

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });

  document.getElementById('confirmForfeitModalBtn')?.addEventListener('click', () => {
    overlay.remove();
    sendDuelAction('/api/duel/forfeit', { matchId });
  });
}

function applyIncomingDuelState(duelState) {
  const wasActiveBefore = state.duel && state.duel.status === 'active';
  state.duel = duelState;
  state.pendingAction = null;
  state.draggedHandCard = null;
  state.draggedAttackUnit = null;
  removeCustomDragGhost();
  document.body.classList.remove('is-dragging-hand-card', 'is-dragging-attack-unit');
  state.duelBannerMsg = '';

  if (duelState && duelState.status === 'finished' && duelState.rewardPackGranted && duelState.viewerRole === duelState.winnerKey) {
    if (state.player) {
      state.player.packs = (Number(state.player.packs) || 0) + 1;
      updateEconomyUI();
    }
  }

  if (state.isMobile && state.activeTab === 'duel') {
    if (duelState && duelState.status === 'active' && !wasActiveBefore) {
      lockMobileLandscapeMode(true);
    } else if (!duelState || duelState.status === 'deck_select') {
      unlockMobileLandscapeMode();
    }
  }

  syncMobileDuelBoardClass();
  renderDuelArena();
}

function initDuelSocket(matchIdToJoin) {
  if (window.io) {
    if (!state.socket) {
      state.socket = window.io();

      state.socket.on('duel_state', (duelState) => {
        applyIncomingDuelState(duelState);
      });

      state.socket.on('duel_action_error', ({ message }) => {
        state.duelBannerMsg = `❌ ${message}`;
        state.pendingAction = null;
        removeCustomDragGhost();
        clearAttackHighlightsInDom();
        renderDuelArena();
      });
    }

    state.socket.emit('join_duel', {
      matchId: matchIdToJoin || null,
      token: state.token || null
    });
  }
}

async function fetchCurrentDuelStateHttp() {
  try {
    const res = await apiFetch('/api/duel/state');
    if (res.duel) {
      applyIncomingDuelState(res.duel);
    } else {
      syncMobileDuelBoardClass();
      renderDuelArena();
    }
  } catch {
    syncMobileDuelBoardClass();
    renderDuelArena();
  }
}

async function startBotTrainingMatch() {
  const btn = document.getElementById('startBotDuelBtn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳ Préparation de [NOM DU BOT]...';
  }
  state.duelBannerMsg = '';

  try {
    const res = await apiFetch('/api/duel/start-bot', { method: 'POST', body: {} });
    if (res.decks) {
      state.decks = res.decks;
      renderDeckbuilder();
    }
    applyIncomingDuelState(res.duel);
    initDuelSocket(res.duel?.matchId);
  } catch (err) {
    state.duelBannerMsg = `❌ ${err.message}`;
    renderDuelArena();
  }
}

async function sendDuelAction(endpoint, payload = {}) {
  try {
    state.duelBannerMsg = '';
    const res = await apiFetch(endpoint, { method: 'POST', body: payload });
    applyIncomingDuelState(res.duel);
  } catch (err) {
    state.duelBannerMsg = `❌ ${err.message}`;
    state.pendingAction = null;
    removeCustomDragGhost();
    clearAttackHighlightsInDom();
    renderDuelArena();
  }
}

function isPointInElementRect(x, y, el) {
  if (!el || typeof x !== 'number' || typeof y !== 'number') return false;
  const rect = el.getBoundingClientRect();
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function highlightValidTargetsForAttackerInDom(attackerUnit, topKey) {
  clearAttackHighlightsInDom();
  if (!attackerUnit) return;

  const validTargets = Array.isArray(attackerUnit.validAttackTargets) ? attackerUnit.validAttackTargets : [];
  document.getElementById('arenaBoardMain')?.classList.add('targeting-active');

  const attackerSlot = document.querySelector(`.arena-unit-slot[data-unit-uid="${attackerUnit.uid}"]`);
  if (attackerSlot) attackerSlot.classList.add('selected-unit');

  document.querySelectorAll('#topBoardRow .arena-unit-slot').forEach(slot => {
    const uid = slot.getAttribute('data-unit-uid');
    if (uid && validTargets.includes(uid)) {
      slot.classList.add('targetable-unit');
    }
  });

  if (validTargets.includes(`hero_${topKey}`)) {
    document.getElementById('topHeroSphere')?.classList.add('targetable-sphere');
  }
}

function clearAttackHighlightsInDom() {
  document.getElementById('arenaBoardMain')?.classList.remove('targeting-active');
  document.querySelectorAll('.arena-unit-slot.targetable-unit').forEach(el => el.classList.remove('targetable-unit'));
  document.querySelectorAll('.arena-unit-slot.selected-unit').forEach(el => el.classList.remove('selected-unit'));
  document.getElementById('topHeroSphere')?.classList.remove('targetable-sphere', 'drop-target-hover');
  document.getElementById('bottomHeroSphere')?.classList.remove('targetable-sphere', 'drop-target-hover');
}

function renderPoeGlobeHtml(type, currentVal, maxVal, labelTitle) {
  const safeMax = Math.max(1, Number(maxVal) || 1);
  const safeCur = Math.max(0, Number(currentVal) || 0);
  const pct = Math.max(0, Math.min(100, Math.round((safeCur / safeMax) * 100)));
  const globeClass = type === 'hp' ? 'hp-globe' : 'mana-globe';

  return `
    <div class="poe-globe ${globeClass}" title="${escapeHtml(labelTitle)} : ${safeCur} / ${safeMax}">
      <div class="poe-globe-liquid" style="height:${pct}%"></div>
      <div class="poe-globe-gloss"></div>
      <span class="poe-globe-value">${safeCur}/${safeMax}</span>
    </div>
  `;
}

function triggerPlayHandCard(card, isMyTurn, bottomPlayer) {
  if (!isMyTurn) {
    state.duelBannerMsg = "⏳ Ce n'est pas encore ton tour !";
    renderDuelArena();
    return;
  }
  if (bottomPlayer.mana < card.cout) {
    state.duelBannerMsg = `⚠️ Mana insuffisant (${bottomPlayer.mana}/${card.cout} mana requis).`;
    renderDuelArena();
    return;
  }
  if (bottomPlayer.board.length >= 7) {
    state.duelBannerMsg = `⚠️ Ton terrain est plein (7 créatures maximum).`;
    renderDuelArena();
    return;
  }

  state.duelBannerMsg = '';
  if (card.battlecryTargetType) {
    state.pendingAction = {
      mode: 'play_card',
      sourceUid: card.uid,
      targetType: card.battlecryTargetType,
      cardName: `Cri de guerre de ${card.display_name}`
    };
    renderDuelArena();
  } else {
    sendDuelAction('/api/duel/play-card', {
      cardUid: card.uid,
      targetId: null
    });
  }
}

function renderDuelArena() {
  const container = document.getElementById('duelContainer');
  if (!container) return;

  syncMobileDuelBoardClass();

  const duel = state.duel;
  if (!duel) {
    container.innerHTML = `
      <div class="duel-empty-box">
        <h2>⚔️ Arène de Duel Chaomon</h2>
        <p style="color:#a1a1aa;margin-top:10px;line-height:1.5;">
          Défie un autre membre sur le serveur Discord avec la commande <code>/duel @membre</code> (le vainqueur remporte <strong>1 Pack de 5 cartes</strong> !),<br/>
          ou lance immédiatement une partie d'entraînement contre le Bot pour tester tes decks :
        </p>
        ${state.duelBannerMsg ? `<p style="color:#fca5a5;background:rgba(239,68,68,0.14);border:1px solid rgba(239,68,68,0.4);padding:10px 14px;border-radius:10px;margin-top:14px;font-weight:bold;">${escapeHtml(state.duelBannerMsg)}</p>` : ''}
        <div style="margin-top:22px;">
          <button type="button" id="startBotDuelBtn" class="btn-primary" style="padding:13px 26px;font-size:15px;">
            ⚔️ Lancer un duel d'entraînement contre [NOM DU BOT]
          </button>
        </div>
      </div>
    `;
    document.getElementById('startBotDuelBtn')?.addEventListener('click', startBotTrainingMatch);
    return;
  }

  if (duel.status === 'deck_select') {
    const isParticipant = (duel.viewerRole === 'p1' || duel.viewerRole === 'p2');
    const myPlayer = isParticipant ? duel.players[duel.viewerRole] : null;
    const oppPlayer = isParticipant ? duel.players[duel.viewerRole === 'p1' ? 'p2' : 'p1'] : null;

    if (!isParticipant) {
      container.innerHTML = `
        <div class="duel-deck-select-box">
          <h2>👁️ Mode Spectateur — Préparation du Duel</h2>
          <p style="margin-top:10px;">
            <strong>${escapeHtml(duel.players.p1.username)}</strong> 🆚 <strong>${escapeHtml(duel.players.p2.username)}</strong>
          </p>
          <p style="color:#a1a1aa;margin-top:12px;">Les deux joueurs choisissent actuellement leur deck...</p>
        </div>
      `;
      return;
    }

    if (myPlayer.selectedDeckSlot) {
      container.innerHTML = `
        <div class="duel-deck-select-box">
          <h2>✅ Deck « ${escapeHtml(myPlayer.deckName)} » verrouillé !</h2>
          <p style="margin-top:12px;">
            ⏳ En attente du choix de deck de <strong>${escapeHtml(oppPlayer.username)}</strong>...
          </p>
        </div>
      `;
      return;
    }

    const deckCardsHtml = state.decks.map(d => {
      const valid = d.cards.length >= state.rules.min_cards && d.cards.length <= state.rules.max_cards;
      return `
        <div class="duel-deck-card ${valid ? '' : 'disabled'}" data-slot="${d.slot_number}">
          <h3>${escapeHtml(d.name)}</h3>
          <p style="color:${valid ? '#34d399' : '#f87171'};margin:8px 0;font-weight:bold;">
            ${d.cards.length} / ${state.rules.max_cards} cartes
          </p>
          <span class="btn-primary" style="display:inline-block;margin-top:6px;padding:7px 16px;font-size:13px;">
            ${valid ? 'Choisir ce Deck ⚔️' : 'Incomplet (min 20)'}
          </span>
        </div>
      `;
    }).join('');

    container.innerHTML = `
      <div class="duel-deck-select-box">
        <h2>⚔️ Duel contre <span class="emerald-gradient-text">${escapeHtml(oppPlayer.username)}</span></h2>
        <p style="color:#a1a1aa;margin-top:8px;">Sélectionne lequel de tes 3 decks tu souhaites utiliser pour ce combat :</p>
        ${state.duelBannerMsg ? `<p style="color:#f87171;margin-top:10px;">${escapeHtml(state.duelBannerMsg)}</p>` : ''}
        <div class="duel-deck-choices">${deckCardsHtml}</div>
      </div>
    `;

    container.querySelectorAll('.duel-deck-card:not(.disabled)').forEach(el => {
      el.addEventListener('click', () => {
        if (state.isMobile && (duel.isBotMatch || oppPlayer?.selectedDeckSlot)) {
          lockMobileLandscapeMode(true);
        }
        sendDuelAction('/api/duel/select-deck', {
          matchId: duel.matchId,
          slotNumber: Number(el.dataset.slot)
        });
      });
    });
    return;
  }

  const bottomKey = duel.viewerRole === 'p2' ? 'p2' : 'p1';
  const topKey = bottomKey === 'p1' ? 'p2' : 'p1';
  const bottomPlayer = duel.players[bottomKey];
  const topPlayer = duel.players[topKey];
  const isMyTurn = (duel.status === 'active' && duel.viewerRole === duel.activePlayerKey);
  const pending = state.pendingAction;

  const canTargetTopHero = pending && (
    (pending.mode === 'attack' && Array.isArray(pending.validTargets) && pending.validTargets.includes(`hero_${topKey}`)) ||
    (pending.targetType === 'any')
  );
  const canTargetBottomHero = pending && (pending.targetType === 'any');

  let promptHtml = '';
  if (duel.status === 'finished') {
    const winPlayer = duel.players[duel.winnerKey];
    const packTxt = duel.rewardPackGranted ? ' (+1 Pack remporté !)' : '';
    promptHtml = `🏆 Victoire de ${escapeHtml(winPlayer ? winPlayer.username : '')} (${escapeHtml(duel.winReason)})${packTxt} !`;
  } else if (pending) {
    promptHtml = `🎯 Visée (${escapeHtml(pending.cardName)}) : touche/clique une cible en surbrillance.`;
  } else if (isMyTurn) {
    promptHtml = state.isMobile
      ? `🟢 À toi ! Glisse ou touche tes cartes pour jouer/attaquer.`
      : `🟢 C'est ton tour ! Glisse une carte de ta main sur le terrain pour l'invoquer, ou glisse une créature en jeu vers sa cible pour attaquer (clique sur une carte pour lire ses détails).`;
  } else {
    promptHtml = `⏳ Tour de ${escapeHtml(duel.players[duel.activePlayerKey].username)}...`;
  }

  if (state.duelBannerMsg) {
    promptHtml = `${escapeHtml(state.duelBannerMsg)}`;
  }

  const topGraveTooltip = topPlayer.graveyardCount > 0 && Array.isArray(topPlayer.graveyardNames) && topPlayer.graveyardNames.length > 0
    ? `Cimetière adverse (${topPlayer.graveyardCount}) : ${topPlayer.graveyardNames.join(', ')}`
    : `Cimetière adverse : aucune créature détruite (0)`;

  const bottomGraveTooltip = bottomPlayer.graveyardCount > 0 && Array.isArray(bottomPlayer.graveyardNames) && bottomPlayer.graveyardNames.length > 0
    ? `Ton cimetière (${bottomPlayer.graveyardCount}) : ${bottomPlayer.graveyardNames.join(', ')}`
    : `Ton cimetière : aucune créature détruite (0)`;

  const dockStyle = state.isMobile ? '' : 'display:contents;';

  container.innerHTML = `
    <div class="mobile-portrait-landscape-banner">
      <span>📱 Tourne ton téléphone en <strong>Mode Paysage</strong> pour afficher toute l'arène</span>
      <button type="button" id="forceLandscapeBtn" class="btn-force-landscape">🔄 Plein Écran Paysage</button>
    </div>

    <div class="arena-layout">
      <div class="arena-board-main ${pending ? 'targeting-active' : ''}" id="arenaBoardMain">
        <!-- 1. BANDEAU ADVERSAIRE (HAUT) -->
        <div class="arena-hero-bar ${duel.activePlayerKey === topKey ? 'active-turn' : ''}" id="topHeroBar">
          <div class="arena-hero-left-globes">
            ${renderPoeGlobeHtml('hp', topPlayer.hp, topPlayer.maxHp, `Points de vie de ${topPlayer.username}`)}
            ${renderPoeGlobeHtml('mana', topPlayer.mana, topPlayer.maxMana, `Mana de ${topPlayer.username}`)}
          </div>

          <div class="hero-avatar-sphere ${canTargetTopHero ? 'targetable-sphere' : ''}" id="topHeroSphere" title="Sphère de ${escapeHtml(topPlayer.username)} (${escapeHtml(topPlayer.deckName)})">
            <img src="${escapeHtml(topPlayer.avatar_url)}" alt="${escapeHtml(topPlayer.username)}" />
            <span class="hero-sphere-name">${escapeHtml(topPlayer.username)}</span>
          </div>

          <div class="arena-hero-badges">
            <span class="hero-stat-pill">
              ✋ ${topPlayer.handCount}/10
              <span class="stat-tooltip">✋ Main adverse : ${topPlayer.handCount} carte(s) en main (max 10)</span>
            </span>
            <span class="hero-stat-pill">
              📚 ${topPlayer.deckCount}
              <span class="stat-tooltip">📚 Pioche adverse : ${topPlayer.deckCount} carte(s) restante(s) dans le deck</span>
            </span>
            <span class="hero-stat-pill">
              🪦 ${topPlayer.graveyardCount}
              <span class="stat-tooltip">🪦 ${escapeHtml(topGraveTooltip)}</span>
            </span>
            <div class="mobile-arena-util-btns">
              <button type="button" id="mobileToggleLogBtn" class="mobile-arena-mini-btn" title="Ouvrir/Fermer le journal">📜 Journal</button>
              ${(duel.status === 'active' && (duel.viewerRole === 'p1' || duel.viewerRole === 'p2'))
                ? `<button type="button" id="mobileForfeitQuickBtn" class="mobile-forfeit-red-btn" title="Abandonner le duel">🏳️ Abandonner</button>`
                : ''}
            </div>
          </div>
        </div>

        <!-- 2. TERRAIN ADVERSE -->
        <div class="arena-field-row" id="topBoardRow"></div>

        <!-- 3. CONSOLE CENTRALE -->
        <div class="arena-center-divider">
          <div class="arena-console-left">
            <span class="console-monitor-icon" title="Console tactique du duel">🖥️</span>
            <span class="console-turn-tag">Tour #${duel.turnNumber}</span>
            <span class="arena-action-prompt">${promptHtml}</span>
          </div>
          <div style="display:flex;gap:8px;align-items:center;">
            ${pending ? `<button type="button" id="cancelPendingBtn" class="btn-danger-cancel">✕ Annuler visée</button>` : ''}
            ${isMyTurn ? `<button type="button" id="endTurnBtn" class="btn-primary" style="padding:9px 20px;font-size:13.5px;">⏭️ Fin du tour</button>` : ''}
            ${duel.status === 'finished' ? `<button type="button" id="leaveFinishedDuelBtn" class="btn-primary" style="padding:9px 20px;font-size:13.5px;">🔄 Nouveau Duel</button>` : ''}
          </div>
        </div>

        <!-- 4. TERRAIN ALLIÉ -->
        <div class="arena-field-row" id="bottomBoardRow">
          ${bottomPlayer.board.length === 0 && isMyTurn
            ? `<span class="drop-zone-hint">📥 Glisse ou dépose une carte de ta main ici pour la mettre en jeu</span>`
            : ''}
        </div>

        <!-- 5. DOCK INFÉRIEUR (SUR PC : BANDEAU + MAIN EMPILÉS ; SUR MOBILE PAYSAGE : FUSIONNÉS SUR 1 SEULE LIGNE PLEINE LARGEUR) -->
        <div class="mobile-bottom-dock ${duel.activePlayerKey === bottomKey ? 'active-turn' : ''}" style="${dockStyle}">
          <div class="arena-hero-bar ${duel.activePlayerKey === bottomKey ? 'active-turn' : ''}" id="bottomHeroBar">
            <div class="arena-hero-left-globes">
              ${renderPoeGlobeHtml('hp', bottomPlayer.hp, bottomPlayer.maxHp, `Tes Points de Vie`)}
              ${renderPoeGlobeHtml('mana', bottomPlayer.mana, bottomPlayer.maxMana, `Ton Mana disponible`)}
            </div>

            <div class="hero-avatar-sphere ${canTargetBottomHero ? 'targetable-sphere' : ''}" id="bottomHeroSphere" title="Sphère de ${escapeHtml(bottomPlayer.username)} (${escapeHtml(bottomPlayer.deckName)})">
              <img src="${escapeHtml(bottomPlayer.avatar_url)}" alt="${escapeHtml(bottomPlayer.username)}" />
              <span class="hero-sphere-name">${escapeHtml(bottomPlayer.username)}</span>
            </div>

            ${!state.isMobile ? `
              <div class="arena-hero-badges">
                <span class="hero-stat-pill">
                  📚 ${bottomPlayer.deckCount}
                  <span class="stat-tooltip">📚 Ta pioche : ${bottomPlayer.deckCount} carte(s) restante(s) dans ton deck</span>
                </span>
                <span class="hero-stat-pill">
                  🪦 ${bottomPlayer.graveyardCount}
                  <span class="stat-tooltip">🪦 ${escapeHtml(bottomGraveTooltip)}</span>
                </span>
              </div>
            ` : ''}
          </div>

          <div class="arena-hand-row ${isMyTurn ? 'my-turn-hand' : ''}" id="bottomHandRow"></div>

          ${state.isMobile ? `
            <div class="arena-hero-badges">
              <span class="hero-stat-pill" title="Cartes restantes dans ton deck">📚 ${bottomPlayer.deckCount}</span>
              <span class="hero-stat-pill" title="${escapeHtml(bottomGraveTooltip)}">🪦 ${bottomPlayer.graveyardCount}</span>
            </div>
          ` : ''}
        </div>
      </div>

      <aside class="arena-log-sidebar ${state.mobileLogOpen ? 'mobile-log-open' : ''}" id="arenaLogSidebar">
        <div style="display:flex;align-items:center;justify-content:space-between;">
          <h3 style="font-size:15px;">📜 Journal du Duel</h3>
          ${state.isMobile ? `<button type="button" id="closeMobileLogBtn" class="mobile-arena-mini-btn">✕</button>` : ''}
        </div>
        <div class="arena-log-list" id="arenaLogList">
          ${duel.logs.map(l => `<div class="arena-log-entry">${escapeHtml(l)}</div>`).join('')}
        </div>
        ${(duel.status === 'active' && (duel.viewerRole === 'p1' || duel.viewerRole === 'p2'))
          ? `<button type="button" id="forfeitDuelBtn" class="btn-secondary" style="color:#f87171;border-color:rgba(239,68,68,0.4);">🏳️ Abandonner le duel</button>`
          : ''}
      </aside>
    </div>
  `;

  const logList = document.getElementById('arenaLogList');
  if (logList) logList.scrollTop = logList.scrollHeight;

  const arenaBoardMainEl = document.getElementById('arenaBoardMain');
  const bottomBoardEl = document.getElementById('bottomBoardRow');

  if (state.isMobile && duel.status === 'active' && arenaBoardMainEl) {
    arenaBoardMainEl.addEventListener('touchstart', () => {
      if (!document.fullscreenElement && !document.webkitFullscreenElement) {
        lockMobileLandscapeMode(true);
      }
    }, { passive: true });
  }

  document.getElementById('forceLandscapeBtn')?.addEventListener('click', () => {
    lockMobileLandscapeMode(true);
  });

  document.getElementById('mobileToggleLogBtn')?.addEventListener('click', () => {
    state.mobileLogOpen = !state.mobileLogOpen;
    document.getElementById('arenaLogSidebar')?.classList.toggle('mobile-log-open', state.mobileLogOpen);
  });

  document.getElementById('closeMobileLogBtn')?.addEventListener('click', () => {
    state.mobileLogOpen = false;
    document.getElementById('arenaLogSidebar')?.classList.remove('mobile-log-open');
  });

  document.getElementById('mobileForfeitQuickBtn')?.addEventListener('click', () => {
    askForfeitConfirmation(duel.matchId);
  });

  const topHeroSphereEl = document.getElementById('topHeroSphere');
  const bottomHeroSphereEl = document.getElementById('bottomHeroSphere');

  if (topHeroSphereEl) {
    topHeroSphereEl.addEventListener('click', () => {
      if (canTargetTopHero) resolveTargetClick(`hero_${topKey}`);
    });

    topHeroSphereEl.addEventListener('dragover', (e) => {
      moveCustomDragGhost(e.clientX, e.clientY);
      const atkUnit = state.draggedAttackUnit;
      if (!atkUnit) return;
      const valid = Array.isArray(atkUnit.validAttackTargets) ? atkUnit.validAttackTargets : [];
      if (valid.includes(`hero_${topKey}`)) {
        e.preventDefault();
        topHeroSphereEl.classList.add('drop-target-hover');
      }
    });

    topHeroSphereEl.addEventListener('dragleave', () => {
      topHeroSphereEl.classList.remove('drop-target-hover');
    });

    topHeroSphereEl.addEventListener('drop', (e) => {
      removeCustomDragGhost();
      const atkUnit = state.draggedAttackUnit;
      if (!atkUnit) return;
      const valid = Array.isArray(atkUnit.validAttackTargets) ? atkUnit.validAttackTargets : [];
      if (!valid.includes(`hero_${topKey}`)) return;

      e.preventDefault();
      e.stopPropagation();
      state.draggedAttackUnit = null;
      document.body.classList.remove('is-dragging-attack-unit');
      clearAttackHighlightsInDom();
      sendDuelAction('/api/duel/attack', {
        attackerUid: atkUnit.uid,
        targetId: `hero_${topKey}`
      });
    });
  }

  if (canTargetBottomHero && bottomHeroSphereEl) {
    bottomHeroSphereEl.addEventListener('click', () => resolveTargetClick(`hero_${bottomKey}`));
  }

  // Rendu des créatures adverses (Haut)
  const topBoardEl = document.getElementById('topBoardRow');
  for (const unit of topPlayer.board) {
    const isTargetable = pending && (
      (pending.mode === 'attack' && Array.isArray(pending.validTargets) && pending.validTargets.includes(unit.uid)) ||
      pending.targetType === 'any' ||
      pending.targetType === 'enemy_creature' ||
      pending.targetType === 'any_creature'
    );

    const unitEl = createBoardUnitElement(unit, {
      isOwnUnit: false,
      isMyTurn: false,
      isTargetable,
      onClickUnit: () => {
        if (isTargetable) resolveTargetClick(unit.uid);
        else openCardModal(unit);
      }
    });

    unitEl.addEventListener('dragover', (e) => {
      moveCustomDragGhost(e.clientX, e.clientY);
      const atkUnit = state.draggedAttackUnit;
      if (!atkUnit) return;
      const valid = Array.isArray(atkUnit.validAttackTargets) ? atkUnit.validAttackTargets : [];
      if (valid.includes(unit.uid)) {
        e.preventDefault();
      }
    });

    unitEl.addEventListener('drop', (e) => {
      removeCustomDragGhost();
      const atkUnit = state.draggedAttackUnit;
      if (!atkUnit) return;
      const valid = Array.isArray(atkUnit.validAttackTargets) ? atkUnit.validAttackTargets : [];
      if (!valid.includes(unit.uid)) return;

      e.preventDefault();
      e.stopPropagation();
      state.draggedAttackUnit = null;
      document.body.classList.remove('is-dragging-attack-unit');
      clearAttackHighlightsInDom();
      sendDuelAction('/api/duel/attack', {
        attackerUid: atkUnit.uid,
        targetId: unit.uid
      });
    });

    topBoardEl.appendChild(unitEl);
  }

  arenaBoardMainEl.addEventListener('dragover', (e) => {
    moveCustomDragGhost(e.clientX, e.clientY);
    if (state.draggedAttackUnit) {
      state.lastDragPos = { x: e.clientX, y: e.clientY };
      return;
    }
    if (!state.draggedHandCard) return;
    state.lastDragPos = { x: e.clientX, y: e.clientY };
    const insideBoard = isPointInElementRect(e.clientX, e.clientY, bottomBoardEl);
    if (insideBoard) {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      bottomBoardEl.classList.add('drop-zone-active');
    } else {
      bottomBoardEl.classList.remove('drop-zone-active');
    }
  });

  arenaBoardMainEl.addEventListener('drop', (e) => {
    removeCustomDragGhost();
    if (!state.draggedHandCard) return;
    const insideBoard = isPointInElementRect(e.clientX, e.clientY, bottomBoardEl);
    if (!insideBoard) return;

    e.preventDefault();
    bottomBoardEl.classList.remove('drop-zone-active');
    bottomBoardEl.classList.remove('drop-zone-ready');
    document.body.classList.remove('is-dragging-hand-card');

    const draggedCard = state.draggedHandCard;
    state.draggedHandCard = null;
    triggerPlayHandCard(draggedCard, isMyTurn, bottomPlayer);
  });

  // Rendu des créatures alliées (Bas)
  for (const unit of bottomPlayer.board) {
    const isTargetable = pending && (
      pending.targetType === 'any' ||
      pending.targetType === 'ally_creature' ||
      pending.targetType === 'any_creature'
    );
    const validTargets = Array.isArray(unit.validAttackTargets) ? unit.validAttackTargets : [];
    const canAttack = isMyTurn && validTargets.length > 0;
    const isSummoningSick = Boolean(unit.summonedThisTurn && !unit.hasHaste && !unit.tapped && !canAttack);

    const unitEl = createBoardUnitElement(unit, {
      isOwnUnit: true,
      isMyTurn,
      canAttack,
      isSummoningSick,
      isSelected: pending && pending.sourceUid === unit.uid,
      isTargetable,
      onClickUnit: () => {
        if (isTargetable) {
          resolveTargetClick(unit.uid);
          return;
        }
        if (state.isMobile && canAttack) {
          state.duelBannerMsg = '';
          state.pendingAction = {
            mode: 'attack',
            sourceUid: unit.uid,
            validTargets,
            cardName: `Attaque avec ${unit.display_name}`
          };
          renderDuelArena();
          return;
        }
        openCardModal(unit);
      },
      onClickAbility: (abIdx, parsedAb) => {
        if (!isMyTurn) return;
        state.duelBannerMsg = '';
        if (parsedAb.targetType) {
          state.pendingAction = {
            mode: 'ability',
            sourceUid: unit.uid,
            abilityIndex: abIdx,
            targetType: parsedAb.targetType,
            cardName: `${unit.display_name} — Actif ${abIdx}`
          };
          renderDuelArena();
        } else {
          sendDuelAction('/api/duel/use-ability', {
            unitUid: unit.uid,
            abilityIndex: abIdx,
            targetId: null
          });
        }
      }
    });

    if (canAttack) {
      unitEl.draggable = true;

      const finishUnitAttackDropAt = (dropX, dropY) => {
        const valid = Array.isArray(unit.validAttackTargets) ? unit.validAttackTargets : [];
        if (valid.includes(`hero_${topKey}`) && isPointInElementRect(dropX, dropY, topHeroSphereEl)) {
          clearAttackHighlightsInDom();
          sendDuelAction('/api/duel/attack', {
            attackerUid: unit.uid,
            targetId: `hero_${topKey}`
          });
          return true;
        }

        for (const enemySlot of document.querySelectorAll('#topBoardRow .arena-unit-slot')) {
          const enemyUid = enemySlot.getAttribute('data-unit-uid');
          if (enemyUid && valid.includes(enemyUid) && isPointInElementRect(dropX, dropY, enemySlot)) {
            clearAttackHighlightsInDom();
            sendDuelAction('/api/duel/attack', {
              attackerUid: unit.uid,
              targetId: enemyUid
            });
            return true;
          }
        }
        return false;
      };

      unitEl.addEventListener('dragstart', (e) => {
        state.draggedAttackUnit = unit;
        state.lastDragPos = { x: e.clientX || 0, y: e.clientY || 0 };
        document.body.classList.add('is-dragging-attack-unit');
        startCustomDragGhost(unit, e);
        highlightValidTargetsForAttackerInDom(unit, topKey);
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', unit.uid);
        }
      });

      unitEl.addEventListener('dragend', (e) => {
        removeCustomDragGhost();
        document.body.classList.remove('is-dragging-attack-unit');
        const atkUnit = state.draggedAttackUnit;
        state.draggedAttackUnit = null;

        if (atkUnit) {
          const dropX = e.clientX || state.lastDragPos.x;
          const dropY = e.clientY || state.lastDragPos.y;
          if (finishUnitAttackDropAt(dropX, dropY)) return;
        }

        if (!state.pendingAction) {
          clearAttackHighlightsInDom();
        }
      });

      let touchDraggingAtk = false;
      let tStartX = 0;
      let tStartY = 0;
      unitEl.addEventListener('touchstart', (e) => {
        if (!e.touches || e.touches.length !== 1) return;
        tStartX = e.touches[0].clientX;
        tStartY = e.touches[0].clientY;
        touchDraggingAtk = false;
      }, { passive: true });

      unitEl.addEventListener('touchmove', (e) => {
        if (!e.touches || e.touches.length !== 1) return;
        const tx = e.touches[0].clientX;
        const ty = e.touches[0].clientY;
        if (!touchDraggingAtk && (Math.abs(tx - tStartX) > 10 || Math.abs(ty - tStartY) > 10)) {
          touchDraggingAtk = true;
          state.draggedAttackUnit = unit;
          document.body.classList.add('is-dragging-attack-unit');
          startCustomDragGhost(unit, e);
          highlightValidTargetsForAttackerInDom(unit, topKey);
        }
        if (touchDraggingAtk) {
          e.preventDefault();
          state.lastDragPos = { x: tx, y: ty };
          moveCustomDragGhost(tx, ty);
        }
      }, { passive: false });

      unitEl.addEventListener('touchend', (e) => {
        if (!touchDraggingAtk) return;
        touchDraggingAtk = false;
        removeCustomDragGhost();
        document.body.classList.remove('is-dragging-attack-unit');
        state.draggedAttackUnit = null;
        const dropX = e.changedTouches?.[0]?.clientX || state.lastDragPos.x;
        const dropY = e.changedTouches?.[0]?.clientY || state.lastDragPos.y;
        if (!finishUnitAttackDropAt(dropX, dropY) && !state.pendingAction) {
          clearAttackHighlightsInDom();
        }
      });
    }

    bottomBoardEl.appendChild(unitEl);
  }

  // Rendu de la main du joueur
  const handRowEl = document.getElementById('bottomHandRow');
  for (const card of bottomPlayer.hand) {
    const canPlay = isMyTurn && bottomPlayer.mana >= card.cout && bottomPlayer.board.length < 7;
    const handSlot = document.createElement('div');
    handSlot.className = `arena-hand-card ${canPlay ? 'playable' : ''}`;
    handSlot.draggable = true;

    handSlot.addEventListener('dragstart', (e) => {
      state.draggedHandCard = card;
      state.lastDragPos = { x: e.clientX || 0, y: e.clientY || 0 };
      document.body.classList.add('is-dragging-hand-card');
      handSlot.classList.add('dragging');
      bottomBoardEl.classList.add('drop-zone-ready');
      startCustomDragGhost(card, e);
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', card.uid);
      }
    });

    handSlot.addEventListener('dragend', (e) => {
      removeCustomDragGhost();
      handSlot.classList.remove('dragging');
      bottomBoardEl.classList.remove('drop-zone-ready');
      bottomBoardEl.classList.remove('drop-zone-active');
      document.body.classList.remove('is-dragging-hand-card');

      const pendingCard = state.draggedHandCard;
      state.draggedHandCard = null;
      if (pendingCard) {
        const dropX = e.clientX || state.lastDragPos.x;
        const dropY = e.clientY || state.lastDragPos.y;
        if (isPointInElementRect(dropX, dropY, bottomBoardEl)) {
          triggerPlayHandCard(pendingCard, isMyTurn, bottomPlayer);
        }
      }
    });

    let touchDraggingHand = false;
    let hStartX = 0;
    let hStartY = 0;
    handSlot.addEventListener('touchstart', (e) => {
      if (!e.touches || e.touches.length !== 1) return;
      hStartX = e.touches[0].clientX;
      hStartY = e.touches[0].clientY;
      touchDraggingHand = false;
    }, { passive: true });

    handSlot.addEventListener('touchmove', (e) => {
      if (!e.touches || e.touches.length !== 1) return;
      const tx = e.touches[0].clientX;
      const ty = e.touches[0].clientY;
      if (!touchDraggingHand && (hStartY - ty) > 14 && Math.abs(ty - hStartY) > Math.abs(tx - hStartX)) {
        touchDraggingHand = true;
        state.draggedHandCard = card;
        document.body.classList.add('is-dragging-hand-card');
        handSlot.classList.add('dragging');
        bottomBoardEl.classList.add('drop-zone-ready');
        startCustomDragGhost(card, e);
      }
      if (touchDraggingHand) {
        e.preventDefault();
        state.lastDragPos = { x: tx, y: ty };
        moveCustomDragGhost(tx, ty);
        bottomBoardEl.classList.toggle('drop-zone-active', isPointInElementRect(tx, ty, bottomBoardEl));
      }
    }, { passive: false });

    handSlot.addEventListener('touchend', (e) => {
      if (!touchDraggingHand) return;
      touchDraggingHand = false;
      removeCustomDragGhost();
      handSlot.classList.remove('dragging');
      bottomBoardEl.classList.remove('drop-zone-ready', 'drop-zone-active');
      document.body.classList.remove('is-dragging-hand-card');
      state.draggedHandCard = null;
      const dropX = e.changedTouches?.[0]?.clientX || state.lastDragPos.x;
      const dropY = e.changedTouches?.[0]?.clientY || state.lastDragPos.y;
      if (isPointInElementRect(dropX, dropY, bottomBoardEl)) {
        triggerPlayHandCard(card, isMyTurn, bottomPlayer);
      }
    });

    handSlot.appendChild(createCardElement(card, {
      showOwnedBadge: false,
      showMobileInspectBtn: false,
      onClick: () => {
        openCardModal(card, {
          allowSummonFromModal: canPlay,
          onSummonFromModal: (chosenCard) => triggerPlayHandCard(chosenCard, isMyTurn, bottomPlayer)
        });
      }
    }));
    handRowEl.appendChild(handSlot);
  }

  document.getElementById('cancelPendingBtn')?.addEventListener('click', () => {
    state.pendingAction = null;
    state.duelBannerMsg = '';
    clearAttackHighlightsInDom();
    renderDuelArena();
  });

  document.getElementById('endTurnBtn')?.addEventListener('click', () => {
    state.pendingAction = null;
    clearAttackHighlightsInDom();
    sendDuelAction('/api/duel/end-turn');
  });

  document.getElementById('leaveFinishedDuelBtn')?.addEventListener('click', () => {
    state.duel = null;
    state.pendingAction = null;
    state.duelBannerMsg = '';
    unlockMobileLandscapeMode();
    syncMobileDuelBoardClass();
    renderDuelArena();
  });

  document.getElementById('forfeitDuelBtn')?.addEventListener('click', () => {
    askForfeitConfirmation(duel.matchId);
  });
}

function createBoardUnitElement(unit, {
  isOwnUnit,
  isMyTurn,
  canAttack = false,
  isSummoningSick = false,
  isSelected = false,
  isTargetable = false,
  onClickUnit,
  onClickAbility
}) {
  const slot = document.createElement('div');
  slot.setAttribute('data-unit-uid', unit.uid);
  slot.className = [
    'arena-unit-slot',
    unit.tapped ? 'tapped' : '',
    canAttack ? 'can-act' : '',
    isSummoningSick ? 'summoning-sick' : '',
    isSelected ? 'selected-unit' : '',
    isTargetable ? 'targetable-unit' : ''
  ].filter(Boolean).join(' ');

  const tags = [];
  if (unit.hasTaunt) tags.push(`<span class="unit-status-tag taunt">🛡️ Provoc</span>`);
  if (unit.divineShield) tags.push(`<span class="unit-status-tag shield">✨ Bouclier</span>`);
  if (unit.frozen) tags.push(`<span class="unit-status-tag frozen">❄️ Gelé</span>`);
  if (unit.stealth) tags.push(`<span class="unit-status-tag stealth">👤 Camouflé</span>`);
  if (unit.hasFlying) tags.push(`<span class="unit-status-tag flying">🪽 Vol</span>`);
  if (unit.hasReach) tags.push(`<span class="unit-status-tag flying">🏹 Portée</span>`);
  if (unit.hasImmune) tags.push(`<span class="unit-status-tag shield">🌟 Immunité</span>`);
  if (unit.hasIndestructible) tags.push(`<span class="unit-status-tag shield">💎 Indestr.</span>`);
  if (unit.silenced) tags.push(`<span class="unit-status-tag stealth">🤫 Silence</span>`);

  if (tags.length > 0) {
    const strip = document.createElement('div');
    strip.className = 'unit-status-strip';
    strip.innerHTML = tags.join('');
    slot.appendChild(strip);
  }

  slot.appendChild(createCardElement(unit, {
    showOwnedBadge: false,
    showMobileInspectBtn: true,
    onClick: onClickUnit
  }));

  if (isOwnUnit && isMyTurn && !unit.silenced && (unit.parsedActif1 || unit.parsedActif2)) {
    const btnRow = document.createElement('div');
    btnRow.className = 'unit-abilities-btns';

    [1, 2].forEach(idx => {
      const parsed = idx === 1 ? unit.parsedActif1 : unit.parsedActif2;
      if (!parsed) return;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'unit-ab-btn';
      b.textContent = state.isMobile
        ? `⚡${idx}(${parsed.effectiveManaCost}💧)`
        : `⚡ Actif ${idx} (${parsed.effectiveManaCost}💧${parsed.requiresTap ? '+↻' : ''})`;
      b.title = parsed.raw;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        if (onClickAbility) onClickAbility(idx, parsed);
      });
      btnRow.appendChild(b);
    });

    slot.appendChild(btnRow);
  }

  return slot;
}

function resolveTargetClick(targetId) {
  const pending = state.pendingAction;
  if (!pending) return;

  state.pendingAction = null;
  clearAttackHighlightsInDom();

  if (pending.mode === 'attack') {
    sendDuelAction('/api/duel/attack', {
      attackerUid: pending.sourceUid,
      targetId
    });
  } else if (pending.mode === 'play_card') {
    sendDuelAction('/api/duel/play-card', {
      cardUid: pending.sourceUid,
      targetId
    });
  } else if (pending.mode === 'ability') {
    sendDuelAction('/api/duel/use-ability', {
      unitUid: pending.sourceUid,
      abilityIndex: pending.abilityIndex,
      targetId
    });
  }
}

// ============================================================================
// 6. ONGLET CLASSEMENT
// ============================================================================
async function loadLeaderboard() {
  try {
    const { leaderboard } = await apiFetch('/api/leaderboard');
    const tbody = document.getElementById('leaderboardBody');
    tbody.innerHTML = leaderboard.map(row => `
      <tr>
        <td><strong>#${row.rank}</strong></td>
        <td>
          <div class="leaderboard-user">
            <img src="${escapeHtml(row.avatar_url)}" alt="" />
            <strong>${escapeHtml(row.username)}</strong>
          </div>
        </td>
        <td><strong style="color:#34d399">${row.elo}</strong></td>
        <td>${row.wins} V / ${row.losses} D</td>
        <td>${row.unique_cards} / ${state.cards.length}</td>
        <td>${row.total_cards}</td>
      </tr>
    `).join('');
  } catch (err) {
    console.error('Erreur chargement classement :', err);
  }
}

// ============================================================================
// 7. INITIALISATION GLOBALE (+ SUPPORT DISCORD ACTIVITY NATIF)
// ============================================================================
function showAuthError(reason) {
  const warnBox = document.getElementById('authWarning');
  warnBox.classList.remove('hidden');
  const card = warnBox.querySelector('.auth-card');
  if (card && reason) {
    card.innerHTML = `
      <h2>🔒 Accès par Lien Magique requis</h2>
      <p>Pour accéder à ta collection et gérer tes decks, tape la commande <code>/commencer</code> ou <code>/deck</code> sur le serveur Discord.</p>
      <p style="margin-top:12px;padding:10px;background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.4);border-radius:8px;color:#fca5a5;font-size:13px;">
        <strong>Diagnostic :</strong> ${escapeHtml(reason)}
      </p>
    `;
  }
}

// S'exécute UNIQUEMENT si le jeu est ouvert comme Activité native à l'intérieur de Discord (?frame_id=...)
async function initDiscordActivityIfNeeded() {
  const params = new URLSearchParams(window.location.search);
  const frameId = params.get('frame_id');
  if (!frameId) return; // Navigateur normal : on ne change rien au fonctionnement habituel

  if (params.get('platform') === 'mobile') {
    state.manualDeviceOverride = 'mobile';
    applyDeviceMode();
  }

  try {
    const cfgRes = await fetch('/api/discord-activity/config');
    const cfg = await cfgRes.json().catch(() => ({}));
    if (!cfg.clientId) {
      throw new Error('DISCORD_CLIENT_ID non configuré dans le fichier .env du serveur.');
    }

    const { DiscordSDK } = await import('/vendor/discord-sdk/index.mjs');
    const discordSdk = new DiscordSDK(cfg.clientId);
    await discordSdk.ready();

    const { code } = await discordSdk.commands.authorize({
      client_id: cfg.clientId,
      response_type: 'code',
      state: '',
      prompt: 'none',
      scope: ['identify']
    });

    const authRes = await fetch('/api/discord-activity/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code })
    });
    const authData = await authRes.json().catch(() => ({}));
    if (!authRes.ok || !authData.token) {
      throw new Error(authData.error || 'Échec de connexion automatique à Discord Activity.');
    }

    state.token = authData.token;
    try {
      localStorage.setItem('chaomon_token', authData.token);
    } catch {
      // ignore
    }
  } catch (err) {
    console.error('❌ Erreur initialisation Discord Activity :', err);
    showAuthError(err.message);
  }
}

async function bootstrap() {
  applyDeviceMode();
  initAuthToken();
  await initDiscordActivityIfNeeded();

  if (!state.token && state.spectateIdFromUrl) {
    document.getElementById('authWarning').classList.add('hidden');
    document.getElementById('mainApp').classList.remove('hidden');
    document.getElementById('economyBar')?.classList.add('hidden');
    document.getElementById('playerName').textContent = 'Mode Spectateur';
    document.getElementById('playerStats').textContent = '👁️ Spectateur en direct';
    switchTab('duel');
    initDuelSocket(state.spectateIdFromUrl);
    await fetchCurrentDuelStateHttp();
    return;
  }

  if (!state.token) {
    showAuthError("Aucun paramètre ?token=... détecté dans l'adresse de la page.");
    return;
  }

  try {
    const [meData, colData] = await Promise.all([
      apiFetch('/api/me'),
      apiFetch('/api/collection')
    ]);

    state.player = meData.player;
    state.economy = meData.economy || { chaor_per_duplicate: 10, pack_cost_chaor: 100 };
    state.decks = meData.decks;
    state.rules = meData.deck_rules || { min_cards: 20, max_cards: 30 };
    state.cards = colData.cards;
    state.cardsById = new Map(state.cards.map(c => [c.card_id, c]));

    document.getElementById('playerName').textContent = state.player.username;
    document.getElementById('playerAvatar').src = state.player.avatar_url;

    document.getElementById('authWarning').classList.add('hidden');
    document.getElementById('mainApp').classList.remove('hidden');

    updateEconomyUI();
    renderCollectionGrid();
    renderDeckbuilder();
    loadLeaderboard();

    const targetMatchId = state.matchIdFromUrl || state.spectateIdFromUrl || meData.active_match_id;
    initDuelSocket(targetMatchId);
    await fetchCurrentDuelStateHttp();

    if (state.matchIdFromUrl || state.spectateIdFromUrl) {
      switchTab('duel');
    } else {
      renderDuelArena();
    }
  } catch (err) {
    console.error('Erreur lors du chargement initial :', err);
    showAuthError(err.message);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  window.addEventListener('resize', () => applyDeviceMode());

  document.addEventListener('dragover', (e) => {
    if (state.draggedHandCard || state.draggedAttackUnit) {
      moveCustomDragGhost(e.clientX, e.clientY);
    }
  });

  document.getElementById('toggleDeviceModeBtn')?.addEventListener('click', () => {
    state.manualDeviceOverride = state.isMobile ? 'pc' : 'mobile';
    applyDeviceMode();
  });

  document.getElementById('recycleDuplicatesBtn')?.addEventListener('click', handleRecycleDuplicates);
  document.getElementById('buyPackBtn')?.addEventListener('click', handleBuyPack);

  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      switchTab(btn.dataset.tab);
      if (btn.dataset.tab === 'duel') {
        initDuelSocket(state.matchIdFromUrl || state.spectateIdFromUrl);
        fetchCurrentDuelStateHttp();
      }
    });
  });

  const searchInput = document.getElementById('searchInput');
  const mobileSearchMirror = document.getElementById('mobileSearchMirror');
  if (searchInput && mobileSearchMirror) {
    mobileSearchMirror.addEventListener('input', () => {
      searchInput.value = mobileSearchMirror.value;
      renderCollectionGrid();
    });
    searchInput.addEventListener('input', () => {
      mobileSearchMirror.value = searchInput.value;
      renderCollectionGrid();
    });
  }

  const deckSearchInput = document.getElementById('deckSearchInput');
  const mobileDeckSearchMirror = document.getElementById('mobileDeckSearchMirror');
  if (deckSearchInput && mobileDeckSearchMirror) {
    mobileDeckSearchMirror.addEventListener('input', () => {
      deckSearchInput.value = mobileDeckSearchMirror.value;
      renderDeckbuilder();
    });
    deckSearchInput.addEventListener('input', () => {
      mobileDeckSearchMirror.value = deckSearchInput.value;
      renderDeckbuilder();
    });
  }

  const toggleColFiltersBtn = document.getElementById('toggleCollectionFiltersBtn');
  if (toggleColFiltersBtn) {
    toggleColFiltersBtn.addEventListener('click', () => {
      const bar = document.getElementById('collectionFiltersBar');
      const isOpen = bar.classList.toggle('mobile-open');
      toggleColFiltersBtn.classList.toggle('active', isOpen);
    });
  }

  const toggleDeckFiltersBtn = document.getElementById('toggleDeckFiltersBtn');
  if (toggleDeckFiltersBtn) {
    toggleDeckFiltersBtn.addEventListener('click', () => {
      const bar = document.getElementById('deckFiltersBar');
      const isOpen = bar.classList.toggle('mobile-open');
      toggleDeckFiltersBtn.classList.toggle('active', isOpen);
    });
  }

  ['rarityFilter', 'alignmentFilter', 'ownershipFilter', 'sortFilter'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', renderCollectionGrid);
  });

  ['deckRarityFilter', 'deckCostFilter'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', renderDeckbuilder);
  });

  document.querySelectorAll('.deck-view-opt').forEach(btn => {
    btn.addEventListener('click', () => {
      state.deckViewFilter = btn.getAttribute('data-deck-view') || 'ALL';
      renderDeckbuilder();
    });
  });

  document.querySelectorAll('.slot-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state.activeSlot = Number(btn.dataset.slot);
      document.getElementById('deckStatusMsg').textContent = '';
      renderDeckbuilder();
    });
  });

  document.getElementById('deckNameInput')?.addEventListener('input', (e) => {
    const deck = getActiveDeck();
    if (deck) {
      deck.name = e.target.value;
      const mobileBarTitle = document.getElementById('mobileDeckBarTitle');
      if (mobileBarTitle) mobileBarTitle.textContent = deck.name || `Deck #${deck.slot_number}`;
    }
  });

  document.getElementById('clearDeckBtn')?.addEventListener('click', () => {
    const deck = getActiveDeck();
    if (deck) {
      deck.cards = [];
      renderDeckbuilder();
    }
  });

  document.getElementById('saveDeckBtn')?.addEventListener('click', saveCurrentDeck);
  document.getElementById('mobileQuickSaveDeckBtn')?.addEventListener('click', saveCurrentDeck);

  document.getElementById('openMobileDeckDrawerBtn')?.addEventListener('click', openMobileDeckDrawer);
  document.getElementById('mobileOpenListBtn')?.addEventListener('click', openMobileDeckDrawer);
  document.getElementById('closeMobileDeckDrawerBtn')?.addEventListener('click', closeMobileDeckDrawer);
  document.getElementById('mobileDeckBackdrop')?.addEventListener('click', closeMobileDeckDrawer);

  setupModalShortTapToClose();

  bootstrap();
});