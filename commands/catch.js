const { SlashCommandBuilder } = require('discord.js');
const db = require('../utils/db');
const { getPokemonById, buildPokemonEmbed } = require('../utils/pokemonHelper');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('catch')
    .setDescription('Throw a Pokéball at the wild Pokémon in this channel!'),

  async execute(interaction) {
    const { user, channelId, guildId } = interaction;

    const spawn = db.getSpawn(channelId);
    if (!spawn) {
      return interaction.reply({
        content: '🚫 There\'s no wild Pokémon here right now! Use `/spawn` to summon one.',
        ephemeral: true,
      });
    }

    const player = db.getPlayer(user.id, guildId);
    if (player.pokeballs <= 0) {
      return interaction.reply({
        content: '😔 You\'re out of Pokéballs! Use `/profile daily` to get more.',
        ephemeral: true,
      });
    }

    await interaction.deferReply();

    db.updatePlayer(user.id, guildId, { pokeballs: player.pokeballs - 1 });

    const pokemon = await getPokemonById(spawn.pokemon_id, spawn.custom_pokemon_id);
    if (!pokemon) {
      db.clearSpawn(channelId);
      return interaction.editReply('❌ Something went wrong — the Pokémon vanished!');
    }

    const catchRates = {
      common: 0.90, uncommon: 0.75, rare: 0.55,
      epic: 0.35, legendary: 0.15, custom: 0.45,
    };
    const caught = Math.random() < (catchRates[pokemon.rarity] ?? 0.5);

    if (caught) {
      db.addCatch(user.id, guildId, spawn.pokemon_id, spawn.custom_pokemon_id, spawn.is_shiny === 1);
      db.clearSpawn(channelId);

      const updatedPlayer = db.getPlayer(user.id, guildId);
      const isNew = !db.hasCaught(user.id, guildId, spawn.pokemon_id, spawn.custom_pokemon_id);

      const embed = buildPokemonEmbed(pokemon, spawn.is_shiny === 1, [
        { name: '🎉 Caught by', value: `<@${user.id}>`, inline: true },
        { name: '🎒 Pokéballs Left', value: `${updatedPlayer.pokeballs}`, inline: true },
      ]);

      const shinyMsg = spawn.is_shiny ? '✨ **SHINY** ' : '';
      return interaction.editReply({
        content: `🎉 <@${user.id}> caught a ${shinyMsg}**${pokemon.name}**!${isNew ? ' *(New in Pokédex!)*' : ''}`,
        embeds: [embed],
      });
    } else {
      const updatedPlayer = db.getPlayer(user.id, guildId);
      const escapes = [
        `Oh no! **${pokemon.name}** broke free!`,
        `Aww! So close... **${pokemon.name}** escaped!`,
        `The Pokéball wobbled... and **${pokemon.name}** got away!`,
        `Almost! **${pokemon.name}** broke the Pokéball!`,
      ];
      return interaction.editReply({
        content: `😮 ${escapes[Math.floor(Math.random() * escapes.length)]}\n🎒 Pokéballs remaining: **${updatedPlayer.pokeballs}**`,
      });
    }
  },
};
