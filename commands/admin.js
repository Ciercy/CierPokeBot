const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const db = require('../utils/db');
const { buildPokemonEmbed } = require('../utils/pokemonHelper');
const pokeCache = require('../utils/pokeCache');

const VALID_TYPES = [
  'Normal','Fire','Water','Grass','Electric','Ice','Fighting','Poison',
  'Ground','Flying','Psychic','Bug','Rock','Ghost','Dragon','Dark','Steel','Fairy',
];

// Limits to prevent abuse
const LIMITS = {
  shiny_rate_ppm: { min: 100, max: 500_000 },   // 0.01% – 50%
  weight:         { min: 0,   max: 10_000 },
};

module.exports = {
  data: new SlashCommandBuilder()
    .setName('admin')
    .setDescription('Admin commands for managing the Pokémon bot')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)

    // ── Custom Pokemon ──────────────────────────────────────────────────────
    .addSubcommand(sub =>
      sub.setName('addpokemon')
        .setDescription('Add a custom Pokémon to this server')
        .addStringOption(opt => opt.setName('name').setDescription('Pokémon name').setRequired(true))
        .addStringOption(opt =>
          opt.setName('type1').setDescription('Primary type').setRequired(true)
            .addChoices(...VALID_TYPES.map(t => ({ name: t, value: t })))
        )
        .addStringOption(opt =>
          opt.setName('rarity').setDescription('Rarity tier').setRequired(true)
            .addChoices(
              { name: 'Common',    value: 'common' },
              { name: 'Uncommon',  value: 'uncommon' },
              { name: 'Rare',      value: 'rare' },
              { name: 'Epic',      value: 'epic' },
              { name: 'Legendary', value: 'legendary' },
              { name: 'Custom',    value: 'custom' },
            )
        )
        .addStringOption(opt =>
          opt.setName('type2').setDescription('Secondary type (optional)').setRequired(false)
            .addChoices(...VALID_TYPES.map(t => ({ name: t, value: t })))
        )
        .addIntegerOption(opt => opt.setName('hp').setDescription('HP stat (default 50)').setMinValue(1).setMaxValue(300))
        .addIntegerOption(opt => opt.setName('atk').setDescription('Attack stat (default 50)').setMinValue(1).setMaxValue(250))
        .addIntegerOption(opt => opt.setName('def').setDescription('Defense stat (default 50)').setMinValue(1).setMaxValue(250))
        .addIntegerOption(opt => opt.setName('spd').setDescription('Speed stat (default 50)').setMinValue(1).setMaxValue(200))
        .addStringOption(opt => opt.setName('emoji').setDescription('Emoji to represent it (default ✨)'))
        .addStringOption(opt => opt.setName('description').setDescription('Flavor text'))
        .addStringOption(opt => opt.setName('image').setDescription('Direct image URL (Imgur, Discord CDN, etc.)'))
    )
    .addSubcommand(sub =>
      sub.setName('removepokemon')
        .setDescription('Remove a custom Pokémon')
        .addStringOption(opt => opt.setName('name').setDescription('Name of the custom Pokémon to remove').setRequired(true))
    )
    .addSubcommand(sub =>
      sub.setName('listcustom')
        .setDescription('List all custom Pokémon')
    )

    // ── Rates ───────────────────────────────────────────────────────────────
    .addSubcommand(sub =>
      sub.setName('rates')
        .setDescription('View current spawn weights and shiny rate for this server')
    )
    .addSubcommand(sub =>
      sub.setName('setshinyrate')
        .setDescription('Set the shiny encounter rate for this server')
        .addNumberOption(opt =>
          opt.setName('percent')
            .setDescription('Shiny chance as a percentage, e.g. 0.4 = 0.4% (default: 0.4096%)')
            .setRequired(true)
            .setMinValue(0.01)
            .setMaxValue(50)
        )
    )
    .addSubcommand(sub =>
      sub.setName('setspawnweight')
        .setDescription('Set the spawn weight for a rarity tier (higher = more frequent)')
        .addStringOption(opt =>
          opt.setName('rarity').setDescription('Rarity tier to adjust').setRequired(true)
            .addChoices(
              { name: 'Common',    value: 'weight_common' },
              { name: 'Uncommon',  value: 'weight_uncommon' },
              { name: 'Rare',      value: 'weight_rare' },
              { name: 'Epic',      value: 'weight_epic' },
              { name: 'Legendary', value: 'weight_legendary' },
              { name: 'Custom',    value: 'weight_custom' },
            )
        )
        .addIntegerOption(opt =>
          opt.setName('weight')
            .setDescription('New weight value (0 = never spawns, default common=500)')
            .setRequired(true)
            .setMinValue(0)
            .setMaxValue(10_000)
        )
    )
    .addSubcommand(sub =>
      sub.setName('resetrates')
        .setDescription('Reset all spawn weights and shiny rate back to defaults')
    )

    // ── Utilities ───────────────────────────────────────────────────────────
    .addSubcommand(sub =>
      sub.setName('giveballs')
        .setDescription('Give Pokéballs to a player')
        .addUserOption(opt => opt.setName('user').setDescription('Player to give balls to').setRequired(true))
        .addIntegerOption(opt => opt.setName('amount').setDescription('Number of balls').setRequired(true).setMinValue(1).setMaxValue(999))
    )
    .addSubcommand(sub =>
      sub.setName('setspawnchannel')
        .setDescription('Set the channel for automatic Pokémon spawns')
        .addChannelOption(opt => opt.setName('channel').setDescription('Channel to spawn in').setRequired(true))
    )
    .addSubcommand(sub =>
      sub.setName('refreshdex')
        .setDescription('Force a refresh of the Pokémon data from PokeAPI (takes a few minutes)')
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const { guildId } = interaction;

    // ── addpokemon ────────────────────────────────────────────────────────────
    if (sub === 'addpokemon') {
      const name = interaction.options.getString('name');

      const existing = db.getCustomPokemonByName(name);
      if (existing) {
        return interaction.reply({ content: `❌ A custom Pokémon named **${name}** already exists!`, ephemeral: true });
      }

      const imageUrl = interaction.options.getString('image') || null;
      if (imageUrl) {
        try {
          const parsed = new URL(imageUrl);
          if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
        } catch {
          return interaction.reply({ content: '❌ That doesn\'t look like a valid URL. Provide a direct `https://` image link.', ephemeral: true });
        }
      }

      const result = db.addCustomPokemon({
        name,
        type1: interaction.options.getString('type1'),
        type2: interaction.options.getString('type2'),
        rarity: interaction.options.getString('rarity'),
        hp:    interaction.options.getInteger('hp')  || 50,
        atk:   interaction.options.getInteger('atk') || 50,
        def:   interaction.options.getInteger('def') || 50,
        spd:   interaction.options.getInteger('spd') || 50,
        emoji: interaction.options.getString('emoji') || '✨',
        description: interaction.options.getString('description'),
        imageUrl,
        createdBy: interaction.user.id,
      });

      const created = db.getCustomPokemon(result.lastInsertRowid);
      const pokemon = {
        id: created.id, name: created.name,
        type: [created.type1, created.type2].filter(Boolean),
        rarity: created.rarity,
        baseStats: { hp: created.hp, atk: created.atk, def: created.def, spd: created.spd, spatk: null, spdef: null },
        emoji: created.emoji, description: created.description,
        sprite: created.image_url || null, spriteShiny: created.image_url || null,
        spriteOfficial: created.image_url || null, imageUrl: created.image_url || null,
        isCustom: true, isLegendary: false, isMythical: false,
        bst: created.hp + created.atk + created.def + created.spd,
      };

      const embed = buildPokemonEmbed(pokemon, false, [
        { name: '✅ Added by', value: `<@${interaction.user.id}>`, inline: true },
      ]);

      return interaction.reply({
        content: `✅ Custom Pokémon **${name}** added!${!imageUrl ? '\n💡 Tip: add a sprite with the `image` option next time.' : ''}`,
        embeds: [embed],
      });
    }

    // ── removepokemon ─────────────────────────────────────────────────────────
    if (sub === 'removepokemon') {
      const name = interaction.options.getString('name');
      const pokemon = db.getCustomPokemonByName(name);
      if (!pokemon) {
        return interaction.reply({ content: `❌ No custom Pokémon named **${name}** found.`, ephemeral: true });
      }
      db.deleteCustomPokemon(pokemon.id);
      return interaction.reply({ content: `🗑️ **${name}** has been removed.` });
    }

    // ── listcustom ────────────────────────────────────────────────────────────
    if (sub === 'listcustom') {
      const list = db.getAllCustomPokemon();
      if (list.length === 0) {
        return interaction.reply({ content: '📭 No custom Pokémon yet. Use `/admin addpokemon` to create one!', ephemeral: true });
      }

      const lines = list.map(p => {
        const types = [p.type1, p.type2].filter(Boolean).join('/');
        const img = p.image_url ? ' 🖼️' : '';
        return `${p.emoji} **${p.name}**${img} — ${types} | ${p.rarity} | HP:${p.hp} ATK:${p.atk} DEF:${p.def} SPD:${p.spd}`;
      });

      const embed = new EmbedBuilder()
        .setTitle('🔧 Custom Pokémon')
        .setColor(0xe74c3c)
        .setDescription(lines.join('\n'))
        .setFooter({ text: `${list.length} custom Pokémon` });

      return interaction.reply({ embeds: [embed] });
    }

    // ── rates ─────────────────────────────────────────────────────────────────
    if (sub === 'rates') {
      const s = db.getGuildSettings(guildId);
      const def = db.DEFAULT_SETTINGS;
      const shinyPct = (s.shiny_rate_ppm / 10_000).toFixed(4);
      const defShinyPct = (def.shiny_rate_ppm / 10_000).toFixed(4);

      const totalWeight = s.weight_common + s.weight_uncommon + s.weight_rare +
                          s.weight_epic + s.weight_legendary + s.weight_custom;

      const pct = w => totalWeight > 0 ? ((w / totalWeight) * 100).toFixed(1) : '0.0';
      const changed = v => v !== undefined;

      const rarityLines = [
        ['⚪ Common',    s.weight_common,    def.weight_common],
        ['🟢 Uncommon',  s.weight_uncommon,  def.weight_uncommon],
        ['🔵 Rare',      s.weight_rare,      def.weight_rare],
        ['🟣 Epic',      s.weight_epic,      def.weight_epic],
        ['🟡 Legendary', s.weight_legendary, def.weight_legendary],
        ['🔴 Custom',    s.weight_custom,    def.weight_custom],
      ].map(([label, w, d]) => {
        const star = w !== d ? ' ✏️' : '';
        return `${label}${star}: **${w}** (${pct(w)}%)`;
      }).join('\n');

      const shinyChanged = s.shiny_rate_ppm !== def.shiny_rate_ppm ? ' ✏️' : '';

      const embed = new EmbedBuilder()
        .setTitle('⚙️ Server Spawn Rates')
        .setColor(0x3498db)
        .addFields(
          {
            name: `✨ Shiny Rate${shinyChanged}`,
            value: `**${shinyPct}%** (1 in ${Math.round(1_000_000 / s.shiny_rate_ppm).toLocaleString()})\nDefault: ${defShinyPct}%`,
            inline: false,
          },
          {
            name: '🎲 Spawn Weights',
            value: rarityLines + `\n\n*Total weight: ${totalWeight}*`,
            inline: false,
          }
        )
        .setFooter({ text: '✏️ = modified from default • Use /admin setshinyrate and /admin setspawnweight to adjust' });

      return interaction.reply({ embeds: [embed] });
    }

    // ── setshinyrate ──────────────────────────────────────────────────────────
    if (sub === 'setshinyrate') {
      const pct = interaction.options.getNumber('percent');
      const ppm = Math.round(pct * 10_000);

      db.updateGuildSettings(guildId, { shiny_rate_ppm: ppm });

      const odds = Math.round(1_000_000 / ppm);
      return interaction.reply({
        content: `✅ Shiny rate set to **${pct}%** (1 in ${odds.toLocaleString()}).\nDefault is 0.4096% (1 in 244).`,
      });
    }

    // ── setspawnweight ────────────────────────────────────────────────────────
    if (sub === 'setspawnweight') {
      const col    = interaction.options.getString('rarity');   // e.g. 'weight_common'
      const weight = interaction.options.getInteger('weight');
      const label  = col.replace('weight_', '');

      db.updateGuildSettings(guildId, { [col]: weight });

      const msg = weight === 0
        ? `⚠️ **${label}** Pokémon will no longer spawn (weight set to 0).`
        : `✅ **${label}** spawn weight set to **${weight}**.`;

      return interaction.reply({ content: msg + '\nUse `/admin rates` to see the full breakdown.' });
    }

    // ── resetrates ────────────────────────────────────────────────────────────
    if (sub === 'resetrates') {
      db.updateGuildSettings(guildId, db.DEFAULT_SETTINGS);
      return interaction.reply({ content: '✅ All spawn weights and shiny rate have been reset to defaults.' });
    }

    // ── giveballs ─────────────────────────────────────────────────────────────
    if (sub === 'giveballs') {
      const targetUser = interaction.options.getUser('user');
      const amount     = interaction.options.getInteger('amount');
      const player     = db.getPlayer(targetUser.id, guildId);
      db.updatePlayer(targetUser.id, guildId, { pokeballs: player.pokeballs + amount });
      return interaction.reply({
        content: `✅ Gave **${amount}** Pokéball(s) to <@${targetUser.id}>. They now have **${player.pokeballs + amount}**.`,
      });
    }

    // ── setspawnchannel ───────────────────────────────────────────────────────
    if (sub === 'setspawnchannel') {
      const channel = interaction.options.getChannel('channel');
      db.updateGuildSettings(guildId, { spawn_channel_id: channel.id });
      return interaction.reply({
        content: `✅ Auto-spawn channel set to <#${channel.id}>. Wild Pokémon will appear there every 5 minutes!`,
      });
    }

    // ── refreshdex ────────────────────────────────────────────────────────────
    if (sub === 'refreshdex') {
      await interaction.deferReply();

      let lastUpdate = 0;
      const startTime = Date.now();

      await pokeCache.refreshCache((current, total) => {
        // Throttle edits to avoid rate limits (every 50 pokemon)
        const now = Date.now();
        if (now - lastUpdate > 3000) {
          lastUpdate = now;
          interaction.editReply(`🔄 Fetching Pokémon data... **${current}/${total}** (${Math.round(current/total*100)}%)`).catch(() => {});
        }
      });

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const status = pokeCache.cacheStatus();
      return interaction.editReply(
        `✅ Pokédex refreshed! **${status.count}** Pokémon loaded in ${elapsed}s.`
      );
    }
  },
};
