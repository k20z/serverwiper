const {
  Client,
  GatewayIntentBits,
  PermissionsBitField,
  ChannelType,
  ActivityType,
  REST,
  Routes,
  SlashCommandBuilder,
} = require("discord.js");

const TOKEN = process.env.DISCORD_BOT_TOKEN || "TOKEN";
const CLIENT_ID = process.env.DISCORD_CLIENT_ID || "CLIENTID";
const WATCH_IMAGE = "https://i.imgur.com/K9aTCnX.png";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const commands = [
  new SlashCommandBuilder()
    .setName("nuke")
    .setDescription("Nukes one channel of choice.")
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
    .addChannelOption((opt) =>
      opt.setName("channel").setDescription("Channel to nuke").setRequired(true)
    )
    .addIntegerOption((opt) =>
      opt
        .setName("interval")
        .setDescription("Seconds to wait before each nuke")
        .setRequired(false)
    )
    .addBooleanOption((opt) =>
      opt
        .setName("repeat")
        .setDescription("Keep nuking on the interval forever")
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName("nukeall")
    .setDescription("Nukes every channel. ⚠️⚠️⚠️")
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
    .addIntegerOption((opt) =>
      opt
        .setName("interval")
        .setDescription("Seconds to wait before each nuke")
        .setRequired(false)
    )
    .addBooleanOption((opt) =>
      opt
        .setName("repeat")
        .setDescription("Keep nuking on the interval forever")
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName("stoprepeatnuke")
    .setDescription("Stops nuking a channel on repeat.")
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
  new SlashCommandBuilder()
    .setName("wipe")
    .setDescription("Deletes every message in a channel.")
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
    .addChannelOption((opt) =>
      opt.setName("channel").setDescription("Channel to wipe").setRequired(true)
    ),
].map((c) => c.toJSON());

const repeatState = new Map();

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
}

async function recreateChannel(channel, parentId = channel.parentId) {
  const guild = channel.guild;
  const name = channel.name;
  const position = channel.rawPosition;
  const permissionOverwrites = channel.permissionOverwrites.cache.map((ow) => ({
    id: ow.id,
    type: ow.type,
    allow: ow.allow.bitfield,
    deny: ow.deny.bitfield,
  }));
  const reason = "Channel nuke/recreate";

  const base = {
    type: channel.type,
    parent: parentId ?? undefined,
    position,
    permissionOverwrites,
    reason,
  };

  let extra = {};
  switch (channel.type) {
    case ChannelType.GuildText:
      extra = {
        topic: channel.topic ?? undefined,
        nsfw: channel.nsfw,
        rateLimitPerUser: channel.rateLimitPerUser,
      };
      break;
    case ChannelType.GuildVoice:
      extra = {
        bitrate: channel.bitrate,
        userLimit: channel.userLimit,
      };
      break;
    case ChannelType.GuildForum:
      extra = { topic: channel.topic ?? undefined };
      break;
    case ChannelType.GuildStageVoice:
    case ChannelType.GuildCategory:
      extra = {};
      break;
    default:
      return null;
  }

  await channel.delete(reason);
  const created = await guild.channels.create({ name, ...base, ...extra });
  return created;
}

function findChannelByName(guild, name) {
  return guild.channels.cache.find((c) => c.name === name);
}

async function nukeAllOnce(guild) {
  const channels = [...guild.channels.cache.values()].filter(
    (c) => c.type !== ChannelType.GuildCategory
  );

  let done = 0;
  for (const ch of channels) {
    try {
      await recreateChannel(ch);
      done++;
    } catch (err) {
      console.error(`Failed to recreate ${ch.name}:`, err.message);
    }
  }
  return done;
}

async function wipeChannel(channel) {
  let deleted = 0;
  while (true) {
    const messages = await channel.messages.fetch({ limit: 100 });
    if (messages.size === 0) break;

    const twoWeeksAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
    const bulkable = messages.filter((m) => m.createdTimestamp > twoWeeksAgo);
    const old = messages.filter((m) => m.createdTimestamp <= twoWeeksAgo);

    if (bulkable.size > 0) {
      await channel.bulkDelete(bulkable, true);
      deleted += bulkable.size;
    }

    for (const msg of old.values()) {
      try {
        await msg.delete();
        deleted++;
      } catch {}
    }

    if (messages.size < 100) break;
  }
  return deleted;
}

async function awaitYesNo(channel, userId) {
  const filter = (m) =>
    m.author.id === userId &&
    ["yes", "no"].includes(m.content.trim().toLowerCase());

  const collected = await channel.awaitMessages({
    filter,
    max: 1,
    time: 15000,
    errors: ["time"],
  });

  return collected.first().content.trim().toLowerCase() === "yes";
}

client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
  client.user.setPresence({
    status: "online",
    activities: [
      {
        name: "We are watching.",
        type: ActivityType.Watching,
        assets: { largeImageURL: WATCH_IMAGE },
      },
    ],
  });
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (!interaction.guild) return;

  const isAdmin = interaction.member.permissions.has(
    PermissionsBitField.Flags.Administrator
  );
  if (!isAdmin) {
    return interaction.reply({
      content: "You need Administrator permission to use this command.",
      ephemeral: true,
    });
  }

  if (interaction.commandName === "nuke") {
    const target = interaction.options.getChannel("channel");
    const interval = interaction.options.getInteger("interval");
    const repeat = interaction.options.getBoolean("repeat") || false;
    const guild = interaction.guild;
    const originalName = target.name;

    const runNuke = async () => {
      const current = findChannelByName(guild, originalName);
      if (!current) return;
      try {
        await recreateChannel(current);
      } catch (err) {
        const fallback =
          guild.systemChannel ||
          guild.channels.cache.find((c) => c.isTextBased());
        if (fallback) fallback.send(`Failed to nuke that channel: ${err.message}`);
      }
    };

    if (!interval) {
      await interaction.reply(`Nuking \`#${originalName}\`...`);
      await runNuke();
      return;
    }

    await interaction.reply(
      `Will nuke \`#${originalName}\` every ${interval}s${repeat ? " forever" : " (once)"}.`
    );

    if (!repeat) {
      setTimeout(runNuke, interval * 1000);
    } else {
      const key = `${guild.id}:nuke:${originalName}`;
      const state = { active: true };
      repeatState.set(key, state);

      const loop = async () => {
        await new Promise((r) => setTimeout(r, interval * 1000));
        if (!state.active) return;
        await runNuke();
        if (!state.active) return;
        loop();
      };
      loop();
    }
    return;
  }

  if (interaction.commandName === "nukeall") {
    const interval = interaction.options.getInteger("interval");
    const repeat = interaction.options.getBoolean("repeat") || false;

    await interaction.reply(
      "Are you sure you want to nuke all channels? Yes or No?"
    );
    let confirmed;
    try {
      confirmed = await awaitYesNo(interaction.channel, interaction.user.id);
    } catch {
      return interaction.followUp("No response, cancelled.");
    }
    if (!confirmed) return interaction.followUp("Cancelled.");

    const guild = interaction.guild;

    if (!interval) {
      await interaction.followUp("Nuking all channels...");
      const done = await nukeAllOnce(guild);
      const target =
        guild.systemChannel ||
        guild.channels.cache.find((c) => c.type === ChannelType.GuildText);
      if (target) target.send(`Nuke complete. Recreated ${done} channels.`);
      return;
    }

    await interaction.followUp(
      `Will nuke all channels every ${interval}s${repeat ? " forever" : " (once)"}.`
    );

    const runNuke = async () => {
      const done = await nukeAllOnce(guild);
      const target =
        guild.systemChannel ||
        guild.channels.cache.find((c) => c.type === ChannelType.GuildText);
      if (target) target.send(`Nuke complete. Recreated ${done} channels.`);
    };

    if (!repeat) {
      setTimeout(runNuke, interval * 1000);
    } else {
      const key = `${guild.id}:nukeall`;
      const state = { active: true };
      repeatState.set(key, state);

      const loop = async () => {
        await new Promise((r) => setTimeout(r, interval * 1000));
        if (!state.active) return;
        await runNuke();
        if (!state.active) return;
        loop();
      };
      loop();
    }
    return;
  }

  if (interaction.commandName === "stoprepeatnuke") {
    const guild = interaction.guild;
    const prefix = `${guild.id}:`;
    let stopped = 0;
    for (const [key, state] of repeatState.entries()) {
      if (key.startsWith(prefix) && state.active) {
        state.active = false;
        repeatState.delete(key);
        stopped++;
      }
    }
    if (stopped === 0) {
      return interaction.reply("No repeat nuke is currently running.");
    }
    return interaction.reply("Repeat nuke stopped.");
  }

  if (interaction.commandName === "wipe") {
    const target = interaction.options.getChannel("channel");
    await interaction.reply(`Wiping \`#${target.name}\`...`);
    const deleted = await wipeChannel(target);
    await interaction.followUp(`Deleted ${deleted} messages in \`#${target.name}\`.`);
    return;
  }
});

registerCommands()
  .then(() => client.login(TOKEN))
  .catch((err) => {
    console.error("Failed to register commands:", err);
    client.login(TOKEN);
  });
