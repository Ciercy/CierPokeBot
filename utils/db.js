const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'pokemon_bot.db');

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    initTables();
  }
  return db;
}

function initTables() {
  const database = getDb();

  // Custom pokemon definitions (admin-created)
  database.exec(`
    CREATE TABLE IF NOT EXISTS custom_pokemon (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      type1 TEXT NOT NULL,
      type2 TEXT,
      rarity TEXT NOT NULL DEFAULT 'custom',
      hp INTEGER NOT NULL DEFAULT 50,
      atk INTEGER NOT NULL DEFAULT 50,
      def INTEGER NOT NULL DEFAULT 50,
      spd INTEGER NOT NULL DEFAULT 50,
      emoji TEXT DEFAULT '✨',
      description TEXT,
      image_url TEXT,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);

  // Migration: add image_url if missing (older installs)
  const cols = database.prepare('PRAGMA table_info(custom_pokemon)').all();
  if (!cols.find(c => c.name === 'image_url')) {
    database.exec('ALTER TABLE custom_pokemon ADD COLUMN image_url TEXT');
  }

  // Player caught pokemon collections
  database.exec(`
    CREATE TABLE IF NOT EXISTS caught_pokemon (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      pokemon_id INTEGER,
      custom_pokemon_id INTEGER,
      nickname TEXT,
      caught_at INTEGER NOT NULL,
      is_shiny INTEGER DEFAULT 0
    );
  `);

  // Player profiles
  database.exec(`
    CREATE TABLE IF NOT EXISTS players (
      user_id TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      pokeballs INTEGER DEFAULT 5,
      total_caught INTEGER DEFAULT 0,
      last_daily INTEGER DEFAULT 0,
      last_spawn_attempt INTEGER DEFAULT 0,
      PRIMARY KEY (user_id, guild_id)
    );
  `);

  // Active spawns per channel
  database.exec(`
    CREATE TABLE IF NOT EXISTS active_spawns (
      channel_id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      pokemon_id INTEGER,
      custom_pokemon_id INTEGER,
      is_shiny INTEGER DEFAULT 0,
      spawned_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `);

  // Guild settings — includes per-server rates
  database.exec(`
    CREATE TABLE IF NOT EXISTS guild_settings (
      guild_id TEXT PRIMARY KEY,
      spawn_channel_id TEXT,
      admin_role_id TEXT,

      -- Shiny rate stored as integer parts-per-million for precision
      -- Default: 4096 ppm = 0.4096% = classic 1/244 rate
      shiny_rate_ppm INTEGER DEFAULT 4096,

      -- Spawn weight for each rarity tier (out of total)
      weight_common    INTEGER DEFAULT 500,
      weight_uncommon  INTEGER DEFAULT 280,
      weight_rare      INTEGER DEFAULT 130,
      weight_epic      INTEGER DEFAULT 60,
      weight_legendary INTEGER DEFAULT 20,
      weight_custom    INTEGER DEFAULT 10
    );
  `);

  // Migrations for guild_settings rate columns (older installs)
  const gscols = database.prepare('PRAGMA table_info(guild_settings)').all().map(c => c.name);
  const newCols = [
    ['shiny_rate_ppm',    'INTEGER DEFAULT 4096'],
    ['weight_common',     'INTEGER DEFAULT 500'],
    ['weight_uncommon',   'INTEGER DEFAULT 280'],
    ['weight_rare',       'INTEGER DEFAULT 130'],
    ['weight_epic',       'INTEGER DEFAULT 60'],
    ['weight_legendary',  'INTEGER DEFAULT 20'],
    ['weight_custom',     'INTEGER DEFAULT 10'],
  ];
  for (const [col, def] of newCols) {
    if (!gscols.includes(col)) {
      database.exec(`ALTER TABLE guild_settings ADD COLUMN ${col} ${def}`);
    }
  }
}

// ─── Player ───────────────────────────────────────────────────────────────────

function getPlayer(userId, guildId) {
  const database = getDb();
  let player = database.prepare(
    'SELECT * FROM players WHERE user_id = ? AND guild_id = ?'
  ).get(userId, guildId);

  if (!player) {
    database.prepare('INSERT INTO players (user_id, guild_id) VALUES (?, ?)').run(userId, guildId);
    player = database.prepare(
      'SELECT * FROM players WHERE user_id = ? AND guild_id = ?'
    ).get(userId, guildId);
  }
  return player;
}

function updatePlayer(userId, guildId, fields) {
  const database = getDb();
  const sets = Object.keys(fields).map(k => `${k} = ?`).join(', ');
  database.prepare(
    `UPDATE players SET ${sets} WHERE user_id = ? AND guild_id = ?`
  ).run(...Object.values(fields), userId, guildId);
}

// ─── Catches ──────────────────────────────────────────────────────────────────

function addCatch(userId, guildId, pokemonId, customPokemonId, isShiny = false) {
  const database = getDb();
  database.prepare(`
    INSERT INTO caught_pokemon (user_id, guild_id, pokemon_id, custom_pokemon_id, caught_at, is_shiny)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(userId, guildId, pokemonId || null, customPokemonId || null, Date.now(), isShiny ? 1 : 0);
  database.prepare(
    'UPDATE players SET total_caught = total_caught + 1 WHERE user_id = ? AND guild_id = ?'
  ).run(userId, guildId);
}

function getCollection(userId, guildId, page = 0, pageSize = 10) {
  const database = getDb();
  return database.prepare(`
    SELECT * FROM caught_pokemon
    WHERE user_id = ? AND guild_id = ?
    ORDER BY caught_at DESC
    LIMIT ? OFFSET ?
  `).all(userId, guildId, pageSize, page * pageSize);
}

function getCollectionCount(userId, guildId) {
  const database = getDb();
  return database.prepare(
    'SELECT COUNT(*) as count FROM caught_pokemon WHERE user_id = ? AND guild_id = ?'
  ).get(userId, guildId).count;
}

function hasCaught(userId, guildId, pokemonId, customPokemonId) {
  const database = getDb();
  if (pokemonId) {
    return !!database.prepare(
      'SELECT 1 FROM caught_pokemon WHERE user_id = ? AND guild_id = ? AND pokemon_id = ?'
    ).get(userId, guildId, pokemonId);
  }
  return !!database.prepare(
    'SELECT 1 FROM caught_pokemon WHERE user_id = ? AND guild_id = ? AND custom_pokemon_id = ?'
  ).get(userId, guildId, customPokemonId);
}

// ─── Spawns ───────────────────────────────────────────────────────────────────

function setSpawn(channelId, guildId, pokemonId, customPokemonId, isShiny, durationMs = 120000) {
  const database = getDb();
  const now = Date.now();
  database.prepare(`
    INSERT OR REPLACE INTO active_spawns
    (channel_id, guild_id, pokemon_id, custom_pokemon_id, is_shiny, spawned_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(channelId, guildId, pokemonId || null, customPokemonId || null, isShiny ? 1 : 0, now, now + durationMs);
}

function getSpawn(channelId) {
  const database = getDb();
  return database.prepare(
    'SELECT * FROM active_spawns WHERE channel_id = ? AND expires_at > ?'
  ).get(channelId, Date.now());
}

function clearSpawn(channelId) {
  const database = getDb();
  database.prepare('DELETE FROM active_spawns WHERE channel_id = ?').run(channelId);
}

// ─── Custom Pokemon ───────────────────────────────────────────────────────────

function addCustomPokemon(data) {
  const database = getDb();
  return database.prepare(`
    INSERT INTO custom_pokemon
      (name, type1, type2, rarity, hp, atk, def, spd, emoji, description, image_url, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.name, data.type1, data.type2 || null, data.rarity || 'custom',
    data.hp || 50, data.atk || 50, data.def || 50, data.spd || 50,
    data.emoji || '✨', data.description || null, data.imageUrl || null,
    data.createdBy, Date.now()
  );
}

function getCustomPokemon(id) {
  return getDb().prepare('SELECT * FROM custom_pokemon WHERE id = ?').get(id);
}

function getAllCustomPokemon() {
  return getDb().prepare('SELECT * FROM custom_pokemon ORDER BY id').all();
}

function getCustomPokemonByName(name) {
  return getDb().prepare('SELECT * FROM custom_pokemon WHERE LOWER(name) = LOWER(?)').get(name);
}

function deleteCustomPokemon(id) {
  getDb().prepare('DELETE FROM custom_pokemon WHERE id = ?').run(id);
}

// ─── Guild Settings ───────────────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
  shiny_rate_ppm:   4096,
  weight_common:    500,
  weight_uncommon:  280,
  weight_rare:      130,
  weight_epic:      60,
  weight_legendary: 20,
  weight_custom:    10,
};

function getGuildSettings(guildId) {
  const database = getDb();
  let settings = database.prepare('SELECT * FROM guild_settings WHERE guild_id = ?').get(guildId);
  if (!settings) {
    database.prepare('INSERT INTO guild_settings (guild_id) VALUES (?)').run(guildId);
    settings = database.prepare('SELECT * FROM guild_settings WHERE guild_id = ?').get(guildId);
  }
  // Fill in any nulls with defaults (handles older rows missing new columns)
  return { ...DEFAULT_SETTINGS, ...settings };
}

function updateGuildSettings(guildId, fields) {
  const database = getDb();
  // Ensure row exists
  getGuildSettings(guildId);
  const sets = Object.keys(fields).map(k => `${k} = ?`).join(', ');
  database.prepare(
    `UPDATE guild_settings SET ${sets} WHERE guild_id = ?`
  ).run(...Object.values(fields), guildId);
}

module.exports = {
  getPlayer, updatePlayer,
  addCatch, getCollection, getCollectionCount, hasCaught,
  setSpawn, getSpawn, clearSpawn,
  addCustomPokemon, getCustomPokemon, getAllCustomPokemon, getCustomPokemonByName, deleteCustomPokemon,
  getGuildSettings, updateGuildSettings,
  DEFAULT_SETTINGS,
};
