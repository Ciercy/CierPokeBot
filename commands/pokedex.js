const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const db = require('../utils/db');
const { findPokemonByName, getPokemonById, buildPokemonEmbed } = require('../utils/pokemonHelper');
const pokeCache = require('../utils/pokeCache');

const RARITY_EMOJI = {
  common: '⚪', uncommon: '🟢', rare: '🔵',
  epic: '🟣', legendary: '🟡', custom: '🔴',
};

module.exports = {
  data: new SlashCommandBuilder()
    .setName('pokedex')
    .setDescription('Look up Pokémon or browse your collection')
    .addSubcommand(sub =>
      sub.setName('lookup')
        .setDescription('Look up a Pokémon by name')
        .addStringOption(opt =>
          opt.setName('name').setDescription('Name of the Pokémon').setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub.setName('collection')
        .setDescription("View your or someone else's caught Pokémon")
        .addUserOption(opt => opt.setName('user').setDescription('User to view (default: yourself)'))
        .addIntegerOption(opt => opt.setName('page').setDescription('Page number').setMinValue(1))
    )
    .addSubcommand(sub =>
      sub.setName('list')
        .setDescription('Browse all available Pokémon by rarity')
        .addStringOption(opt =>
          opt.setName('rarity').setDescription('Filter by rarity')
            .addChoices(
              { name: 'Common',    value: 'common' },
              { name: 'Uncommon',  value: 'uncommon' },
              { name: 'Rare',      value: 'rare' },
              { name: 'Epic',      value: 'epic' },
              { name: 'Legendary', value: 'legendary' },
              { name: 'Custom',    value: 'custom' },
            )
        )
        .addIntegerOption(opt => opt.setName('page').setDescription('Page number').setMinValue(1))
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    // ── lookup ──────────────────────────────────────────────────────────────
    if (sub === 'lookup') {
      await interaction.deferReply();
      const name = interaction.options.getString('name');
      const pokemon = await findPokemonByName(name);

      if (!pokemon) {
        return interaction.editReply(`❌ No Pokémon found named **${name}**. Try \`/pokedex list\` to browse.`);
      }

      const embed = buildPokemonEmbed(pokemon);
      return interaction.editReply({ embeds: [embed] });
    }

    // ── collection ──────────────────────────────────────────────────────────
    if (sub === 'collection') {
      await interaction.deferReply();
      const targetUser = interaction.options.getUser('user') || interaction.user;
      const page = (interaction.options.getInteger('page') || 1) - 1;
      const PAGE_SIZE = 10;

      const total = db.getCollectionCount(targetUser.id, interaction.guildId);
      if (total === 0) {
        const isSelf = targetUser.id === interaction.user.id;
        return interaction.editReply(
          `📭 ${isSelf ? 'You haven\'t' : `<@${targetUser.id}> hasn't`} caught any Pokémon yet!`
        );
      }

      const catches = db.getCollection(targetUser.id, interaction.guildId, page, PAGE_SIZE);
      const totalPages = Math.ceil(total / PAGE_SIZE);

      // Resolve pokemon names/emoji for each catch
      const lines = await Promise.all(catches.map(async (c, i) => {
        const pokemon = await getPokemonById(c.pokemon_id, c.custom_pokemon_id);
        if (!pokemon) return `${i + 1 + page * PAGE_SIZE}. *(Unknown)*`;
        const shiny    = c.is_shiny ? '✨ ' : '';
        const nickname = c.nickname ? ` "*${c.nickname}*"` : '';
        const date     = new Date(c.caught_at).toLocaleDateString();
        const idStr    = c.pokemon_id ? `#${String(c.pokemon_id).padStart(4, '0')}` : `Custom`;
        return `${shiny}${pokemon.emoji} **${pokemon.name}**${nickname} \`${idStr}\` — *${date}*`;
      }));

      const embed = new EmbedBuilder()
        .setTitle(`📚 ${targetUser.username}'s Pokédex`)
        .setColor(0x3498db)
        .setDescription(lines.join('\n'))
        .setFooter({ text: `Page ${page + 1}/${totalPages} • ${total} Pokémon caught` })
        .setThumbnail(targetUser.displayAvatarURL());

      return interaction.editReply({ embeds: [embed] });
    }

    // ── list ────────────────────────────────────────────────────────────────
    if (sub === 'list') {
      await interaction.deferReply();

      const filter  = interaction.options.getString('rarity');
      const page    = (interaction.options.getInteger('page') || 1) - 1;
      const PAGE_SIZE = 30;

      const allBase   = await pokeCache.getPokemonList();
      const allCustom = db.getAllCustomPokemon();

      let combined = [
        ...allBase.map(p => ({ name: p.displayName, emoji: p.emoji, rarity: p.rarity, isCustom: false })),
        ...allCustom.map(p => ({ name: p.name, emoji: p.emoji || '✨', rarity: p.rarity, isCustom: true })),
      ];

      if (filter) combined = combined.filter(p => p.rarity === filter);

      const total = combined.length;
      const totalPages = Math.ceil(total / PAGE_SIZE);
      const slice = combined.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

      if (slice.length === 0) {
        return interaction.editReply(`❌ No Pokémon found${filter ? ` with rarity **${filter}**` : ''}.`);
      }

      const lines = slice.map(p => {
        const customTag = p.isCustom ? ' *(custom)*' : '';
        return `${RARITY_EMOJI[p.rarity] || '⚪'} ${p.emoji} ${p.name}${customTag}`;
      });

      // Split into two columns
      const half = Math.ceil(lines.length / 2);
      const col1 = lines.slice(0, half).join('\n');
      const col2 = lines.slice(half).join('\n');

      const title = filter
        ? `${RARITY_EMOJI[filter]} ${filter.charAt(0).toUpperCase() + filter.slice(1)} Pokémon`
        : '📖 All Pokémon';

      const embed = new EmbedBuilder()
        .setTitle(title)
        .setColor(0xe74c3c)
        .addFields(
          { name: '\u200B', value: col1, inline: true },
          { name: '\u200B', value: col2 || '\u200B', inline: true },
        )
        .setFooter({ text: `Page ${page + 1}/${totalPages} • ${total} total` });

      return interaction.editReply({ embeds: [embed] });
    }
  },
};
