require('dotenv').config();
const { Client, GatewayIntentBits, Collection, REST, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');
const db = require('./utils/db');
const pokeCache = require('./utils/pokeCache');
const { pickRandomPokemon, buildPokemonEmbed } = require('./utils/pokemonHelper');

// ─── Client ───────────────────────────────────────────────────────────────────

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

client.commands = new Collection();

// ─── Load Commands ─────────────────────────────────────────────────────────────

const commandFiles = fs.readdirSync(path.join(__dirname, 'commands')).filter(f => f.endsWith('.js'));
for (const file of commandFiles) {
  const command = require(`./commands/${file}`);
  client.commands.set(command.data.name, command);
  console.log(`✅ Loaded: /${command.data.name}`);
}

// ─── Register Slash Commands ───────────────────────────────────────────────────

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  const commands = [...client.commands.values()].map(c => c.data.toJSON());

  try {
    if (process.env.GUILD_ID) {
      await rest.put(
        Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
        { body: commands }
      );
      console.log(`✅ Registered ${commands.length} guild commands`);
    } else {
      await rest.put(
        Routes.applicationCommands(process.env.CLIENT_ID),
        { body: commands }
      );
      console.log(`✅ Registered ${commands.length} global commands`);
    }
  } catch (err) {
    console.error('❌ Command registration failed:', err);
  }
}

// ─── Auto Spawn ────────────────────────────────────────────────────────────────

const AUTO_SPAWN_INTERVAL_MS = 5 * 60 * 1000;

async function autoSpawn() {
  for (const [guildId, guild] of client.guilds.cache) {
    try {
      const settings = db.getGuildSettings(guildId);
      if (!settings.spawn_channel_id) continue;

      const channel = guild.channels.cache.get(settings.spawn_channel_id);
      if (!channel?.isTextBased()) continue;

      if (db.getSpawn(settings.spawn_channel_id)) continue;

      const { pokemon, isCustom, isShiny } = await pickRandomPokemon(guildId);
      const pokemonId = isCustom ? null : pokemon.id;
      const customId  = isCustom ? pokemon.id : null;

      db.setSpawn(settings.spawn_channel_id, guildId, pokemonId, customId, isShiny, 120000);

      const shinyStr = isShiny ? '✨ A **SHINY** ' : 'A wild ';
      const embed = buildPokemonEmbed(pokemon, isShiny, [
        { name: '⏰ Time Limit', value: '2 minutes', inline: true },
        { name: '🎯 How to Catch', value: 'Use `/catch`', inline: true },
      ]);

      await channel.send({
        content: `🌿 ${shinyStr}**${pokemon.name}** appeared!`,
        embeds: [embed],
      });
    } catch (err) {
      console.error(`Auto-spawn error in guild ${guildId}:`, err.message);
    }
  }
}

// ─── Ready ────────────────────────────────────────────────────────────────────

client.once('ready', async () => {
  console.log(`\n🤖 Logged in as ${client.user.tag}`);
  console.log(`📡 Serving ${client.guilds.cache.size} guild(s)\n`);

  await registerCommands();

  // Load or fetch Pokemon cache
  const status = pokeCache.cacheStatus();
  if (status.exists && status.fresh) {
    console.log(`✅ Using cached Pokédex (${status.count} Pokémon, ${status.ageHours}h old)`);
    await pokeCache.getPokemonList(); // warm memory cache
  } else {
    console.log(status.exists ? '⚠️  Cache is stale, refreshing...' : '⚠️  No cache found, fetching from PokeAPI...');
    await pokeCache.buildCache((current, total) => {
      if (current % 100 === 0 || current === total) {
        process.stdout.write(`\r🔄 Fetching Pokémon: ${current}/${total} (${Math.round(current/total*100)}%)`);
      }
    });
    console.log('\n');
  }

  // Start auto-spawn loop
  setInterval(autoSpawn, AUTO_SPAWN_INTERVAL_MS);
  console.log(`⏱️  Auto-spawn every ${AUTO_SPAWN_INTERVAL_MS / 60000} min`);

  client.user.setActivity('Pokémon | /spawn', { type: 0 });
});

// ─── Interactions ──────────────────────────────────────────────────────────────

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const command = client.commands.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction);
  } catch (err) {
    console.error(`Error in /${interaction.commandName}:`, err);
    const reply = { content: '❌ Something went wrong. Please try again.', ephemeral: true };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(reply).catch(() => {});
    } else {
      await interaction.reply(reply).catch(() => {});
    }
  }
});

// ─── Start ─────────────────────────────────────────────────────────────────────

client.login(process.env.DISCORD_TOKEN);
