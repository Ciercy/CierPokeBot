const { SlashCommandBuilder } = require('discord.js');
const db = require('../utils/db');
const { pickRandomPokemon, buildPokemonEmbed } = require('../utils/pokemonHelper');

const SPAWN_COOLDOWN_MS = 60 * 1000;

module.exports = {
  data: new SlashCommandBuilder()
    .setName('spawn')
    .setDescription('Rustle the grass to summon a wild Pokémon! (1 minute cooldown)'),

  async execute(interaction) {
    const { user, channelId, guildId } = interaction;

    const existing = db.getSpawn(channelId);
    if (existing) {
      return interaction.reply({
        content: '⚠️ A wild Pokémon is already here! Use `/catch` to try to catch it.',
        ephemeral: true,
      });
    }

    const player = db.getPlayer(user.id, guildId);
    const now = Date.now();
    const timeSince = now - (player.last_spawn_attempt || 0);
    if (timeSince < SPAWN_COOLDOWN_MS) {
      const remaining = Math.ceil((SPAWN_COOLDOWN_MS - timeSince) / 1000);
      return interaction.reply({
        content: `⏳ You need to wait **${remaining}s** before rustling the grass again!`,
        ephemeral: true,
      });
    }

    await interaction.deferReply();

    db.updatePlayer(user.id, guildId, { last_spawn_attempt: now });

    const { pokemon, isCustom, isShiny } = await pickRandomPokemon(guildId);
    const pokemonId = isCustom ? null : pokemon.id;
    const customId  = isCustom ? pokemon.id : null;

    db.setSpawn(channelId, guildId, pokemonId, customId, isShiny, 120000);

    const shinyStr = isShiny ? '✨ A **SHINY** ' : 'A wild ';
    const embed = buildPokemonEmbed(pokemon, isShiny, [
      { name: '⏰ Time Limit', value: '2 minutes', inline: true },
      { name: '🎯 How to Catch', value: 'Use `/catch`', inline: true },
    ]);

    return interaction.editReply({
      content: `🌿 ${shinyStr}**${pokemon.name}** appeared!`,
      embeds: [embed],
    });
  },
};
