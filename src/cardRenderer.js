// src/cardRenderer.js
const { GlobalFonts, createCanvas, loadImage } = require('@napi-rs/canvas');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'DATA');
const AVATARS_DIR = path.join(DATA_DIR, 'useravatar');
const TEMPLATES_DIR = path.join(DATA_DIR, 'templates');
const FONTS_DIR = path.join(DATA_DIR, 'fonts');

const templateCache = new Map();

// Dimensions proportionnelles à ton template 1792 x 2400
const CARD_WIDTH = 750;
const CARD_HEIGHT = 1004;
const SCALE_X = CARD_WIDTH / 1792;
const SCALE_Y = CARD_HEIGHT / 2400;

// ─────────────────────────────────────────────────────────────────────────────
// POLICE DU NOM DE CARTE (style Magic: The Gathering)
//
// La police officielle des noms de cartes MTG est « Beleren » (Delve Fonts,
// commanditée par Wizards of the Coast) — elle n'est pas libre de droits.
// On enregistre donc le PREMIER fichier présent dans DATA/fonts/ parmi :
//   1. Beleren-Bold.ttf     (la vraie Beleren, si tu en possèdes un exemplaire)
//   2. MagicMedieval.ttf    (reconstitution communautaire de l'ancienne police MTG)
//   3. Cinzel-SemiBold.ttf  (Google Fonts, alternative libre la plus proche)
//   4. Cinzel.ttf
// Si aucun fichier n'est trouvé → repli sur Georgia (comportement actuel).
// ─────────────────────────────────────────────────────────────────────────────
const NAME_FONT_ALIAS = 'MTGNameFont';
const NAME_FONT_FILES = [
    'Beleren-Bold.ttf',
    'MagicMedieval.ttf',
    'Cinzel-SemiBold.ttf',
    'Cinzel.ttf'
];
let NAME_FONT_FAMILY = null;
(function registerNameFont() {
    for (const file of NAME_FONT_FILES) {
        const fullPath = path.join(FONTS_DIR, file);
        if (fs.existsSync(fullPath)) {
            try {
                GlobalFonts.registerFromPath(fullPath, NAME_FONT_ALIAS);
                NAME_FONT_FAMILY = NAME_FONT_ALIAS;
                return;
            } catch (err) {
                console.warn(`⚠️ Impossible d'enregistrer la police ${file} :`, err.message);
            }
        }
    }
    console.warn(`⚠️ Aucune police MTG trouvée dans ${FONTS_DIR} — repli sur Georgia pour les noms.`);
})();

const RARITY_FILES = {
    'Commune':    ['Template_Common.jpg'],
    'Rare':       ['Template_Rare.jpg'],
    'Épique':     ['Template_Epic.jpg'],
    'Légendaire': ['Template_Legend.jpg'],
    'Mythique':   ['Template_Mythique.jpg']
};

// Modèles d'avatar par défaut (stockés dans DATA/useravatar) selon l'alignement de la carte
const DEFAULT_AVATAR_FILES = {
    'loyal bon':        'dlb.png',
    'neutre bon':       'dnb.png',
    'chaotique bon':    'dcb.png',
    'loyal neutre':     'dln.png',
    'neutre strict':    'dnn.png',
    'chaotique neutre': 'dcn.png',
    'loyal mauvais':    'dlm.png',
    'neutre mauvais':   'dnm.png',
    'chaotique mauvais':'dcm.png'
};

// Normalise un alignement ("Chaotique Bon", "neutre strict ", etc.) vers une clé de DEFAULT_AVATAR_FILES
function normalizeAlignment(alignment) {
    return String(alignment || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '') // retire les accents
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Retourne le fichier modèle par défaut correspondant à l'alignement de la carte.
 * Si l'alignement est inconnu ou vide, on retombe sur le neutre strict (dnn.png).
 * @param {string} alignment - Alignement de la carte (ex: "Chaotique Bon")
 * @returns {string} Nom du fichier image par défaut
 */
function getDefaultAvatarFile(alignment) {
    const key = normalizeAlignment(alignment);
    return DEFAULT_AVATAR_FILES[key] || 'dnn.png';
}

async function getTemplateImage(rarity) {
    const key = RARITY_FILES[rarity] ? rarity : 'Commune';
    if (templateCache.has(key)) return templateCache.get(key);

    const candidates = RARITY_FILES[key];
    for (const filename of candidates) {
        const fullPath = path.join(TEMPLATES_DIR, filename);
        if (fs.existsSync(fullPath)) {
            const img = await loadImage(fullPath);
            templateCache.set(key, img);
            return img;
        }
    }
    throw new Error(`Template introuvable dans ${TEMPLATES_DIR} pour la rareté "${rarity}"`);
}

function wrapText(ctx, text, maxWidth) {
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

// ─────────────────────────────────────────────────────────────────────────────
// COORDONNÉES DE MISE EN PAGE PAR RARETÉ (référentiel 1792 x 2400)
// Astuce : +/- 2.4 unités ici = +/- 1 pixel sur l'image finale (750 x 1004)
// ─────────────────────────────────────────────────────────────────────────────
const LAYOUTS = {
    DEFAULT: {
        artLeft: 180, artTop: 308, artRight: 1614, artBottom: 1368,
        orbX: 1572, orbY: 214, orbClipY: 212, orbRadius: 155,
        voluteX: 215, voluteY: 345, voluteRadius: 68,
        crystalPolygon: [
            [727, 1385],
            [896, 1260],
            [1065, 1385]
        ],
        nameX: 175, nameCenterY: 204, nameRightMax: 1390,
        typeLeft: 195, typeRight: 1595, typeCenterY: 1447,
        textLeft: 195, textRight: 1595, boxTopY: 1565, boxBottomY: 2150,
        statsX: 1518, statsY: 2251
    },
    Mythique: {
        // Cadre de l'illustration élargi pour masquer les liserés d'éclairs verts sur les bords
        artLeft: 155, artTop: 290, artRight: 1637, artBottom: 1368,
        // Orbe de coût en haut à droite (recentré horizontalement à 1596)
        orbX: 1588, orbY: 210, orbClipY: 210, orbRadius: 156,
        // Volute en haut à gauche de l'illustration
        voluteX: 192, voluteY: 324, voluteRadius: 64,
        // Polygone épousant la pointe haute du cristal (1260) et ses ailettes
        crystalPolygon: [
            [727, 1385],
            [727, 1368],
            [842, 1335],
            [896, 1260],
            [950, 1335],
            [1065, 1368],
            [1065, 1385]
        ],
        // Bandeau supérieur (Nom)
        nameX: 175, nameCenterY: 200, nameRightMax: 1390,
        // Bandeau central (Type & Alignement)
        typeLeft: 190, typeRight: 1600, typeCenterY: 1464,
        // Boîte de texte inférieure (Capacités & Lore)
        textLeft: 195, textRight: 1595, boxTopY: 1565, boxBottomY: 2150,
        // Cartouche Attaque / Vie en bas à droite (recentré horizontalement à 1535)
        statsX: 1523, statsY: 2278
    }
};

/**
 * Génère un Buffer PNG de la carte assemblée dynamiquement
 * @param {Object} card - Objet carte issu de src/db.js
 * @returns {Promise<Buffer>}
 */
async function renderCardBuffer(card) {
    const LAYOUT = LAYOUTS[card.rarity] || LAYOUTS.DEFAULT;

    const canvas = createCanvas(CARD_WIDTH, CARD_HEIGHT);
    const ctx = canvas.getContext('2d');

    // 1. Dessiner le Template de Rareté
    const templateImg = await getTemplateImage(card.rarity);
    ctx.drawImage(templateImg, 0, 0, CARD_WIDTH, CARD_HEIGHT);

    // 2. Dessiner l'Avatar Discord depuis DATA/useravatar/[ID].png
    //    Si l'image utilisateur n'existe pas, utiliser l'un des 9 modèles
    //    par défaut en fonction de l'alignement de la carte.
    const artX = LAYOUT.artLeft * SCALE_X;
    const artY = LAYOUT.artTop * SCALE_Y;
    const artW = (LAYOUT.artRight - LAYOUT.artLeft) * SCALE_X;
    const artH = (LAYOUT.artBottom - LAYOUT.artTop) * SCALE_Y;

    const userAvatarPath = path.join(AVATARS_DIR, `${card.card_id}.png`);
    const defaultAvatarPath = path.join(AVATARS_DIR, getDefaultAvatarFile(card.alignment));
    const avatarPath = fs.existsSync(userAvatarPath) ? userAvatarPath : defaultAvatarPath;
    if (fs.existsSync(avatarPath)) {
        try {
            const avatarImg = await loadImage(avatarPath);
            ctx.save();
            ctx.beginPath();
            ctx.roundRect(artX, artY, artW, artH, 14);
            ctx.clip();

            const imgRatio = avatarImg.width / avatarImg.height;
            const boxRatio = artW / artH;
            let drawW, drawH, drawX, drawY;

            if (imgRatio > boxRatio) {
                drawH = artH;
                drawW = artH * imgRatio;
                drawX = artX - (drawW - artW) / 2;
                drawY = artY;
            } else {
                drawW = artW;
                drawH = artW / imgRatio;
                drawX = artX;
                drawY = artY - (drawH - artH) / 2;
            }

            ctx.drawImage(avatarImg, drawX, drawY, drawW, drawH);

            // Vignette sombre subtile sur les bords de l'illustration
            const grad = ctx.createRadialGradient(
                artX + artW / 2, artY + artH / 2, artH * 0.35,
                artX + artW / 2, artY + artH / 2, artW * 0.65
            );
            grad.addColorStop(0, 'rgba(0,0,0,0)');
            grad.addColorStop(1, 'rgba(5,12,28,0.55)');
            ctx.fillStyle = grad;
            ctx.fillRect(artX, artY, artW, artH);
            ctx.restore();

            // Redessiner par-dessus le médaillon de coût (haut-droite), la volute (haut-gauche) et le cristal (bas-centre)
            ctx.save();
            ctx.beginPath();
            ctx.arc(LAYOUT.orbX * SCALE_X, LAYOUT.orbClipY * SCALE_Y, LAYOUT.orbRadius * SCALE_X, 0, Math.PI * 2);
            ctx.clip();
            ctx.drawImage(templateImg, 0, 0, CARD_WIDTH, CARD_HEIGHT);
            ctx.restore();

            ctx.save();
            ctx.beginPath();
            ctx.arc(LAYOUT.voluteX * SCALE_X, LAYOUT.voluteY * SCALE_Y, LAYOUT.voluteRadius * SCALE_X, 0, Math.PI * 2);
            ctx.clip();
            ctx.drawImage(templateImg, 0, 0, CARD_WIDTH, CARD_HEIGHT);
            ctx.restore();

            ctx.save();
            ctx.beginPath();
            const [firstPt, ...restPts] = LAYOUT.crystalPolygon;
            ctx.moveTo(firstPt[0] * SCALE_X, firstPt[1] * SCALE_Y);
            for (const [px, py] of restPts) {
                ctx.lineTo(px * SCALE_X, py * SCALE_Y);
            }
            ctx.closePath();
            ctx.clip();
            ctx.drawImage(templateImg, 0, 0, CARD_WIDTH, CARD_HEIGHT);
            ctx.restore();
        } catch (err) {
            console.warn(`⚠️ Impossible de charger l'avatar ${avatarPath}:`, err.message);
        }
    }

    // 3. NOM DE LA CARTE (Barre supérieure)
    // ─────────────────────────────────────────────────────────────────────────
    const NAME_CENTER_Y = LAYOUT.nameCenterY;
    const NAME_X = LAYOUT.nameX;

    const titleMaxX = (LAYOUT.nameRightMax - LAYOUT.nameX) * SCALE_X;
    let titleFontSize = 28;
    const nameFont = (px) => NAME_FONT_FAMILY
        ? `${px}px ${NAME_FONT_FAMILY}`
        : `bold ${px}px Georgia, serif`;

    ctx.font = nameFont(titleFontSize);
    const displayName = card.display_name || card.username || 'Chaomon Inconnu';
    while (ctx.measureText(displayName).width > titleMaxX && titleFontSize > 14) {
        titleFontSize--;
        ctx.font = nameFont(titleFontSize);
    }

    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';

    const nameMetrics = ctx.measureText(displayName);
    const inkAscent = nameMetrics.actualBoundingBoxAscent ?? titleFontSize * 0.7;
    const inkDescent = nameMetrics.actualBoundingBoxDescent ?? titleFontSize * 0.1;
    const baselineY = NAME_CENTER_Y * SCALE_Y + (inkAscent - inkDescent) / 2;

    ctx.shadowColor = 'rgba(0, 0, 0, 0.85)';
    ctx.shadowBlur = 4;
    ctx.shadowOffsetX = 1;
    ctx.shadowOffsetY = 2;
    ctx.fillStyle = '#FFFDF5';
    ctx.fillText(displayName, NAME_X * SCALE_X, baselineY);

    // 4. COÛT (Colonne "cout" -> Orbe supérieur droit)
    ctx.font = `bold 38px Georgia, serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#FFFFFF';
    ctx.shadowColor = 'rgba(0, 40, 100, 0.95)';
    ctx.shadowBlur = 6;
    ctx.fillText(String(card.cout ?? 0), LAYOUT.orbX * SCALE_X, LAYOUT.orbY * SCALE_Y);

    // 5. BANDEAU DE TYPE : CRÉATURE (gauche) & ALIGNEMENT (droite, italique)
    const creatureText = card.creature || 'Entité Mystérieuse';
    const alignText = card.alignment || '';

    const typeLeft = LAYOUT.typeLeft * SCALE_X;
    const typeRight = LAYOUT.typeRight * SCALE_X;
    const typeMaxW = typeRight - typeLeft;

    let typeFontSize = 22;
    ctx.font = `bold ${typeFontSize}px Georgia, serif`;
    while (ctx.measureText(creatureText).width > typeMaxW * 0.65 && typeFontSize > 14) {
        typeFontSize--;
        ctx.font = `bold ${typeFontSize}px Georgia, serif`;
    }

    ctx.fillStyle = '#FFF8E7';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.9)';
    ctx.shadowBlur = 4;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(creatureText, typeLeft, LAYOUT.typeCenterY * SCALE_Y);

    if (alignText) {
        ctx.font = `italic ${typeFontSize}px Georgia, serif`;
        ctx.textAlign = 'right';
        ctx.fillText(alignText, typeRight, LAYOUT.typeCenterY * SCALE_Y);
    }

    // 6. BOÎTE DE TEXTE INFÉRIEURE : CAPACITÉS (haut) + FLAVOR TEXT (bas, taille adaptive)
    // ─────────────────────────────────────────────────────────────────────────
    // ▼▼▼ RÉGLAGES DES POLICES — C'EST ICI QUE TU CHANGES LES TAILLES ▼▼▼
    const ABILITY_FONT_SIZE_FEW  = 18;  // Taille de police des capacités (passifs ET actifs) si ≤ 2 capacités
    const ABILITY_FONT_SIZE_MANY = 16;  // Taille de police des capacités si ≥ 3 capacités
    const FLAVOR_FONT_MIN        = 9;   // Taille MINIMALE du flavor text (garantit que tout tienne)
    const FLAVOR_FONT_MAX        = 24;  // Taille MAXIMALE du flavor text (utilisée s'il reste de la place)
    // ▲▲▲ RÉGLAGES DES POLICES ▲▲▲

    const PASSIVE_COLOR = '#70D6FF';  // capacités passives : bleu
    const ACTIVE_COLOR  = '#FFD166';  // capacités actives : jaune
    const BUBBLE_FILL   = '#FFFFFF';  // bulle de coût : fond blanc
    const BUBBLE_TEXT   = '#000000';  // bulle de coût : coût en noir

    const textLeft = LAYOUT.textLeft * SCALE_X;
    const textMaxW = (LAYOUT.textRight - LAYOUT.textLeft) * SCALE_X;
    const boxTopY = LAYOUT.boxTopY * SCALE_Y;
    const boxBottomY = LAYOUT.boxBottomY * SCALE_Y;
    let cursorY = boxTopY;

    // Extraction des capacités SANS préfixe "Passif :" / "Actif :" répété.
    // Le coût des actifs ("10 mana : …") est extrait du texte pour être
    // dessiné dans une bulle blanche (chiffre noir) devant la capacité.
    const ACTIVE_COST_RE = /^\s*(\d+)\s*mana\s*[:\-–—]?\s*/i;
    const abilities = [];
    const pushAbility = (raw, type) => {
        const text = String(raw || '').trim();
        if (!text) return;
        let cost = null;
        let body = text;
        if (type === 'active') {
            const m = ACTIVE_COST_RE.exec(text);
            if (m) {
                cost = m[1];
                body = text.slice(m[0].length).trim();
            }
        }
        abilities.push({ type, cost, text: body });
    };
    if (card.passif1) pushAbility(card.passif1, 'passive');
    if (card.passif2) pushAbility(card.passif2, 'passive');
    if (card.actif1)  pushAbility(card.actif1, 'active');
    if (card.actif2)  pushAbility(card.actif2, 'active');

    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.shadowBlur = 2;

    // Capacités : pouvoirs directement, colorés selon leur type.
    if (abilities.length > 0) {
        const abFontSize = abilities.length >= 3 ? ABILITY_FONT_SIZE_MANY : ABILITY_FONT_SIZE_FEW;
        const lineHeight = abFontSize + 10;

        for (const ab of abilities) {
            if (cursorY + lineHeight > boxBottomY) break;

            let textX = textLeft;
            if (ab.cost !== null) {
                // Bulle de coût : cercle blanc, coût en noir au centre —
                // bulle agrandie pour que le chiffre soit bien lisible
                const r = abFontSize * 0.95;
                const cx = textLeft + r;
                const cy = cursorY + abFontSize * 0.5;
                ctx.save();
                ctx.shadowBlur = 0;
                ctx.beginPath();
                ctx.arc(cx, cy, r, 0, Math.PI * 2);
                ctx.fillStyle = BUBBLE_FILL;
                ctx.fill();
                ctx.lineWidth = 1.5;
                ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
                ctx.stroke();
                ctx.font = `bold ${Math.round(abFontSize * 1.05)}px Georgia, serif`;
                ctx.fillStyle = BUBBLE_TEXT;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(ab.cost, cx, cy + 1);
                ctx.restore();
                ctx.textAlign = 'left';
                ctx.textBaseline = 'top';
                textX = textLeft + 2 * r + 8;
            }

            ctx.font = `${abFontSize}px sans-serif`;
            ctx.fillStyle = ab.type === 'passive' ? PASSIVE_COLOR : ACTIVE_COLOR;
            const lines = wrapText(ctx, ab.text, textMaxW - (textX - textLeft));
            for (let i = 0; i < lines.length; i++) {
                if (cursorY + lineHeight > boxBottomY) break;
                ctx.fillText(lines[i], textX, cursorY);
                cursorY += lineHeight;
            }
            cursorY += 6; // petit espace entre deux capacités
        }
        cursorY += 4; // petit espace entre capacités et flavor
    }

    // Flavor text (lore) : la taille s'adapte à la place RESTANTE du bloc —
    // elle peut DONC GRANDIR (ex: Kitazato, une seule capacité → beaucoup de
    // place → jusqu'à FLAVOR_FONT_MAX) comme réduire (jusqu'à FLAVOR_FONT_MIN).
    // Garantie : le texte intégral est toujours dessiné, jamais tronqué.
    if (card.explanation) {
        const flavorText = `« ${card.explanation} »`;
        const availableHeight = boxBottomY - Math.max(cursorY, boxTopY) - 8;

        let loreFontSize = null;
        let loreLineGap = 4; // interligne normal
        let loreLines = null;
        for (let size = FLAVOR_FONT_MAX; size >= FLAVOR_FONT_MIN; size--) {
            ctx.font = `italic ${size}px Georgia, serif`;
            const lines = wrapText(ctx, flavorText, textMaxW);
            if (lines.length * (size + 4) <= availableHeight) {
                loreFontSize = size;
                loreLines = lines;
                break;
            }
        }
        if (loreFontSize === null) {
            // Dernier recours : taille minimale + interligne resserré
            // pour que TOUT le texte tienne malgré le manque de place.
            loreFontSize = FLAVOR_FONT_MIN;
            loreLineGap = 2;
            ctx.font = `italic ${loreFontSize}px Georgia, serif`;
            loreLines = wrapText(ctx, flavorText, textMaxW);
        }

        // Aligner en bas : partir du bas et remonter, sans chevaucher les capacités
        const lineH = loreFontSize + loreLineGap;
        let loreY = boxBottomY - loreLines.length * lineH - 6;
        if (loreY < cursorY) {
            loreY = cursorY;
        }

        ctx.fillStyle = '#CFC8B8';
        ctx.textAlign = 'center';
        // Toutes les lignes sont dessinées : pas de troncature du flavor
        for (const line of loreLines) {
            ctx.fillText(line, 896 * SCALE_X, loreY);
            loreY += lineH;
        }
    }

    // 7. CARTOUCHE DE STATS : "attaque / vie" style Magic (Bas droite, centré)
    ctx.font = `bold 26px Georgia, serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#FFFFFF';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.95)';
    ctx.shadowBlur = 5;
    const statsText = `${card.attaque ?? 0} / ${card.vie ?? 0}`;
    ctx.fillText(statsText, LAYOUT.statsX * SCALE_X, LAYOUT.statsY * SCALE_Y);

    return canvas.toBuffer('image/png');
}

module.exports = {
    renderCardBuffer
};