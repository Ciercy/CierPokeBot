const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const db = require('../utils/db');

const DAILY_BALLS = 5;
const DAILY_COOLDOWN_MS = 24 * 60 * 60 * 1000;

module.exports = {
  data: new SlashCommandBuilder()
    .setName('profile')
    .setDescription('View your trainer profile and claim your daily Pokéballs')
    .addSubcommand(sub =>
      sub.setName('view')
        .setDescription('View your trainer card')
        .addUserOption(opt => opt.setName('user').setDescription('Player to view').setRequired(false))
    )
    .addSubcommand(sub =>
      sub.setName('daily')
        .setDescription(`Claim your daily ${DAILY_BALLS} Pokéballs!`)
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'view') {
      const targetUser = interaction.options.getUser('user') || interaction.user;
      const player = db.getPlayer(targetUser.id, interaction.guildId);
      const total = db.getCollectionCount(targetUser.id, interaction.guildId);

      const nextDaily = player.last_daily + DAILY_COOLDOWN_MS;
      const canDaily = Date.now() >= nextDaily;
      const dailyStr = canDaily
        ? '✅ Ready to claim!'
        : `⏳ <t:${Math.floor(nextDaily / 1000)}:R>`;

      const embed = new EmbedBuilder()
        .setTitle(`🎴 ${targetUser.username}'s Trainer Card`)
        .setColor(0xff6b35)
        .setThumbnail(targetUser.displayAvatarURL())
        .addFields(
          { name: '🎒 Pokéballs', value: `${player.pokeballs}`, inline: true },
          { name: '📚 Total Caught', value: `${total}`, inline: true },
          { name: '📅 Daily Reward', value: dailyStr, inline: true },
        )
        .setFooter({ text: 'Use /spawn to find wild Pokémon!' });

      return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'daily') {
      const player = db.getPlayer(interaction.user.id, interaction.guildId);
      const now = Date.now();
      const nextDaily = player.last_daily + DAILY_COOLDOWN_MS;

      if (now < nextDaily) {
        return interaction.reply({
          content: `⏳ You already claimed your daily reward! Come back <t:${Math.floor(nextDaily / 1000)}:R>.`,
          ephemeral: true,
        });
      }

      const newBalls = player.pokeballs + DAILY_BALLS;
      db.updatePlayer(interaction.user.id, interaction.guildId, {
        pokeballs: newBalls,
        last_daily: now,
      });

      return interaction.reply({
        content: `🎁 <@${interaction.user.id}> claimed their daily **${DAILY_BALLS} Pokéballs**!\n🎒 You now have **${newBalls}** Pokéballs. Good luck!`,
      });
    }
  },
};
