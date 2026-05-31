/**
 * pokemonHelper.js
 * Spawn logic, embed builder, and Pokemon lookup.
 * Uses PokeAPI cache for base Pokemon, DB for custom Pokemon.
 */

const db = require('./db');
const pokeCache = require('./pokeCache');

// ─── Spawn ────────────────────────────────────────────────────────────────────

/**
 * Pick a random Pokemon to spawn, respecting per-guild rarity weights.
 * Returns { pokemon, isCustom, isShiny }
 */
async function pickRandomPokemon(guildId) {
  const settings = db.getGuildSettings(guildId);
  const allPokemon = await pokeCache.getPokemonList();
  const customPokemon = db.getAllCustomPokemon();

  const weights = {
    common:    settings.weight_common,
    uncommon:  settings.weight_uncommon,
    rare:      settings.weight_rare,
    epic:      settings.weight_epic,
    legendary: settings.weight_legendary,
    custom:    settings.weight_custom,
  };

  // Build pool
  const pool = [];
  for (const p of allPokemon) {
    pool.push({ pokemon: normalizeBase(p), isCustom: false, weight: weights[p.rarity] ?? weights.common });
  }
  for (const p of customPokemon) {
    pool.push({ pokemon: normalizeCustom(p), isCustom: true, weight: weights.custom });
  }

  // Weighted random pick
  const totalWeight = pool.reduce((s, e) => s + e.weight, 0);
  let roll = Math.random() * totalWeight;
  for (const entry of pool) {
    roll -= entry.weight;
    if (roll <= 0) {
      const shinyRoll = Math.random() * 1_000_000;
      const isShiny = shinyRoll < settings.shiny_rate_ppm;
      return { ...entry, isShiny };
    }
  }

  // Fallback (shouldn't happen)
  return { ...pool[0], isShiny: false };
}

// ─── Lookup ───────────────────────────────────────────────────────────────────

async function getPokemonById(pokemonId, customPokemonId) {
  if (customPokemonId) {
    const cp = db.getCustomPokemon(customPokemonId);
    return cp ? normalizeCustom(cp) : null;
  }
  const p = await pokeCache.getPokemonById(pokemonId);
  return p ? normalizeBase(p) : null;
}

async function findPokemonByName(name) {
  // Check custom first
  const custom = db.getCustomPokemonByName(name);
  if (custom) return normalizeCustom(custom);

  // Then base
  const base = await pokeCache.findPokemonByName(name);
  return base ? normalizeBase(base) : null;
}

// ─── Normalizers — unified shape for embeds ───────────────────────────────────

function normalizeBase(p) {
  return {
    id: p.id,
    name: p.displayName || p.name,
    type: p.types || [],
    rarity: p.rarity,
    baseStats: p.baseStats,
    emoji: p.emoji || '❓',
    description: null,
    sprite: p.sprite || null,
    spriteShiny: p.spriteShiny || null,
    spriteOfficial: p.spriteOfficial || null,
    imageUrl: null,
    isCustom: false,
    isLegendary: p.isLegendary || false,
    isMythical: p.isMythical || false,
    bst: p.bst || 0,
  };
}

function normalizeCustom(p) {
  return {
    id: p.id,
    name: p.name,
    type: [p.type1, p.type2].filter(Boolean),
    rarity: p.rarity,
    baseStats: { hp: p.hp, atk: p.atk, def: p.def, spd: p.spd, spatk: null, spdef: null },
    emoji: p.emoji || '✨',
    description: p.description || null,
    sprite: p.image_url || null,
    spriteShiny: p.image_url || null,
    spriteOfficial: p.image_url || null,
    imageUrl: p.image_url || null,
    isCustom: true,
    isLegendary: false,
    isMythical: false,
    bst: p.hp + p.atk + p.def + p.spd,
  };
}

// ─── Embed Builder ────────────────────────────────────────────────────────────

const RARITY_COLORS = {
  common:    0x95a5a6,
  uncommon:  0x2ecc71,
  rare:      0x3498db,
  epic:      0x9b59b6,
  legendary: 0xf1c40f,
  custom:    0xe74c3c,
};

function buildPokemonEmbed(pokemon, isShiny = false, extraFields = []) {
  const shinyPrefix = isShiny ? '✨ **SHINY** ' : '';
  const idStr = pokemon.isCustom
    ? `Custom #${pokemon.id}`
    : `#${String(pokemon.id).padStart(4, '0')}`;

  const color = isShiny ? 0xFFD700 : (RARITY_COLORS[pokemon.rarity] ?? 0x95a5a6);

  // Sprite: prefer shiny variant when shiny, fall back through options
  const thumbnail = isShiny
    ? (pokemon.spriteShiny || pokemon.sprite || pokemon.imageUrl)
    : (pokemon.sprite || pokemon.imageUrl);

  const statsLines = [
    `❤️ HP:    **${pokemon.baseStats.hp}**`,
    `⚔️ ATK:   **${pokemon.baseStats.atk}**`,
    `🛡️ DEF:   **${pokemon.baseStats.def}**`,
    `💨 SPD:   **${pokemon.baseStats.spd}**`,
  ];
  if (pokemon.baseStats.spatk != null) {
    statsLines.push(`✨ Sp.Atk: **${pokemon.baseStats.spatk}**`);
    statsLines.push(`🔮 Sp.Def: **${pokemon.baseStats.spdef}**`);
  }
  if (pokemon.bst) statsLines.push(`📊 BST:   **${pokemon.bst}**`);

  const typeStr = pokemon.type.map(t => capitalize(t)).join(' / ');

  const tags = [];
  if (pokemon.isLegendary) tags.push('⚔️ Legendary');
  if (pokemon.isMythical) tags.push('🌟 Mythical');
  if (pokemon.isCustom) tags.push('🔧 Custom');

  const embed = {
    color,
    title: `${shinyPrefix}${pokemon.emoji} ${pokemon.name}`,
    description: [
      pokemon.description,
      tags.length ? tags.join(' • ') : null,
    ].filter(Boolean).join('\n') || null,
    fields: [
      { name: 'Pokédex', value: idStr, inline: true },
      { name: 'Type', value: typeStr || '—', inline: true },
      { name: 'Rarity', value: capitalize(pokemon.rarity), inline: true },
      { name: 'Base Stats', value: statsLines.join('\n'), inline: false },
      ...extraFields,
    ],
    footer: { text: isShiny ? '✨ A shiny Pokémon appeared!' : '' },
    timestamp: new Date().toISOString(),
  };

  if (thumbnail) embed.thumbnail = { url: thumbnail };

  return embed;
}

function capitalize(str) {
  return str ? str.charAt(0).toUpperCase() + str.slice(1) : '';
}

module.exports = {
  pickRandomPokemon,
  getPokemonById,
  findPokemonByName,
  buildPokemonEmbed,
  normalizeBase,
  normalizeCustom,
};
