/**
 * pokeCache.js
 * Fetches all Pokemon from PokeAPI and caches them to disk.
 * Assigns rarity based on base stat total + legendary/mythical flags.
 * Cache refreshes every 24 hours, or on demand via refreshCache().
 */

const fs = require('fs');
const path = require('path');

const CACHE_PATH = path.join(__dirname, '..', 'data', 'pokeapi_cache.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const POKEAPI_BASE = 'https://pokeapi.co/api/v2';
const TOTAL_POKEMON = 1025; // Gen 1-9 (PokeAPI national dex count as of 2024)
const CONCURRENCY = 20; // parallel requests per batch

// In-memory store after load
let _cache = null;

// ─── Rarity from BST ──────────────────────────────────────────────────────────

function assignRarity(bst, isLegendary, isMythical) {
  if (isLegendary || isMythical) return 'legendary';
  if (bst >= 550) return 'epic';
  if (bst >= 480) return 'rare';
  if (bst >= 380) return 'uncommon';
  return 'common';
}

// ─── Type → Emoji ─────────────────────────────────────────────────────────────

const TYPE_EMOJI = {
  normal: '⚪', fire: '🔥', water: '💧', grass: '🌿', electric: '⚡',
  ice: '❄️', fighting: '🥊', poison: '☠️', ground: '🏜️', flying: '🐦',
  psychic: '🔮', bug: '🐛', rock: '🪨', ghost: '👻', dragon: '🐲',
  dark: '🌑', steel: '⚙️', fairy: '🌸',
};

function typeEmoji(types) {
  return TYPE_EMOJI[types[0]] || '❓';
}

// ─── Fetch helpers ────────────────────────────────────────────────────────────

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function fetchPokemonDetail(nameOrId) {
  const data = await fetchJson(`${POKEAPI_BASE}/pokemon/${nameOrId}`);
  const speciesData = await fetchJson(data.species.url);

  const types = data.types.map(t => t.type.name);
  const stats = {};
  for (const s of data.stats) {
    stats[s.stat.name] = s.base_stat;
  }
  const bst = Object.values(stats).reduce((a, b) => a + b, 0);
  const isLegendary = speciesData.is_legendary;
  const isMythical = speciesData.is_mythical;

  return {
    id: data.id,
    name: data.name,
    displayName: data.name.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
    types,
    emoji: typeEmoji(types),
    rarity: assignRarity(bst, isLegendary, isMythical),
    isLegendary,
    isMythical,
    baseStats: {
      hp:  stats['hp']              || 1,
      atk: stats['attack']          || 1,
      def: stats['defense']         || 1,
      spd: stats['speed']           || 1,
      spatk: stats['special-attack']  || 1,
      spdef: stats['special-defense'] || 1,
    },
    bst,
    sprite: data.sprites?.front_default || null,
    spriteShiny: data.sprites?.front_shiny || null,
    spriteOfficial: data.sprites?.other?.['official-artwork']?.front_default || null,
  };
}

// Run promises in batches to avoid hammering PokeAPI
async function batchFetch(ids, concurrency, onProgress) {
  const results = [];
  for (let i = 0; i < ids.length; i += concurrency) {
    const batch = ids.slice(i, i + concurrency);
    const settled = await Promise.allSettled(batch.map(id => fetchPokemonDetail(id)));
    for (const result of settled) {
      if (result.status === 'fulfilled') results.push(result.value);
      // silently skip failed entries (alternate forms, etc.)
    }
    if (onProgress) onProgress(Math.min(i + concurrency, ids.length), ids.length);
  }
  return results;
}

// ─── Public API ───────────────────────────────────────────────────────────────

async function buildCache(onProgress) {
  console.log(`🔄 Fetching ${TOTAL_POKEMON} Pokémon from PokeAPI...`);
  const ids = Array.from({ length: TOTAL_POKEMON }, (_, i) => i + 1);
  const pokemon = await batchFetch(ids, CONCURRENCY, onProgress);

  // Sort by national dex id
  pokemon.sort((a, b) => a.id - b.id);

  const cacheData = {
    fetchedAt: Date.now(),
    count: pokemon.length,
    pokemon,
  };

  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cacheData, null, 2));
  _cache = cacheData;

  console.log(`✅ Cached ${pokemon.length} Pokémon to disk.`);
  return cacheData;
}

function loadCacheFromDisk() {
  if (!fs.existsSync(CACHE_PATH)) return null;
  try {
    const raw = fs.readFileSync(CACHE_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Get the full Pokemon list. Loads from memory → disk → PokeAPI.
 * Pass onProgress(current, total) to receive fetch progress updates.
 */
async function getPokemonList(onProgress) {
  if (_cache) return _cache.pokemon;

  const disk = loadCacheFromDisk();
  if (disk && (Date.now() - disk.fetchedAt) < CACHE_TTL_MS) {
    console.log(`✅ Loaded ${disk.count} Pokémon from disk cache.`);
    _cache = disk;
    return _cache.pokemon;
  }

  const fresh = await buildCache(onProgress);
  return fresh.pokemon;
}

/**
 * Force a cache refresh regardless of TTL.
 */
async function refreshCache(onProgress) {
  _cache = null;
  return buildCache(onProgress);
}

/**
 * Get a single Pokemon by national dex ID (1-based).
 */
async function getPokemonById(id) {
  const list = await getPokemonList();
  return list.find(p => p.id === id) || null;
}

/**
 * Find a Pokemon by name (case-insensitive, handles display names too).
 */
async function findPokemonByName(name) {
  const list = await getPokemonList();
  const lower = name.toLowerCase().replace(/\s+/g, '-');
  return list.find(p =>
    p.name === lower ||
    p.displayName.toLowerCase() === name.toLowerCase()
  ) || null;
}

/**
 * Check if the cache exists and is fresh.
 */
function cacheStatus() {
  const disk = loadCacheFromDisk();
  if (!disk) return { exists: false };
  const ageMs = Date.now() - disk.fetchedAt;
  return {
    exists: true,
    count: disk.count,
    fetchedAt: new Date(disk.fetchedAt).toISOString(),
    fresh: ageMs < CACHE_TTL_MS,
    ageHours: Math.floor(ageMs / 3600000),
  };
}

module.exports = { getPokemonList, getPokemonById, findPokemonByName, refreshCache, cacheStatus, buildCache };
