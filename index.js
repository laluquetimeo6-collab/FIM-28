// Bot Discord — FIM SITE 28
// Fonctions : anti-raid, anti-spam, modération (kick/ban/mute), logs,
// MP de bienvenue, et une petite API HTTP privée utilisée par le site
// (via une fonction Netlify) pour attribuer un rôle et envoyer un MP
// quand une candidature est acceptée/refusée.

const express = require("express");
const {
  Client, GatewayIntentBits, Partials, PermissionFlagsBits,
  EmbedBuilder, REST, Routes, SlashCommandBuilder,
} = require("discord.js");

// ---- Config (variables d'environnement) ----
const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID || null; // optionnel
const API_SECRET = process.env.API_SECRET;
const PORT = process.env.PORT || 3000;

if (!TOKEN || !GUILD_ID || !API_SECRET) {
  console.error("Il manque DISCORD_TOKEN, GUILD_ID ou API_SECRET dans les variables d'environnement.");
  process.exit(1);
}

// ---- Réglages anti-raid / anti-spam (ajuste si besoin) ----
const RAID_JOIN_COUNT = 6;       // nb d'arrivées...
const RAID_JOIN_WINDOW_MS = 15000; // ...en moins de 15s = alerte raid
const RAID_MIN_ACCOUNT_AGE_MS = 1000 * 60 * 60 * 24 * 3; // 3 jours

const SPAM_MSG_COUNT = 5;        // nb de messages...
const SPAM_WINDOW_MS = 6000;     // ...en moins de 6s = spam
const SPAM_TIMEOUT_MS = 1000 * 60 * 10; // mute 10 min

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildModeration,
  ],
  partials: [Partials.GuildMember, Partials.Channel],
});

async function logEvent(title, description, color = 0xd9a768) {
  if (!LOG_CHANNEL_ID) return;
  try {
    const channel = await client.channels.fetch(LOG_CHANNEL_ID);
    if (!channel) return;
    const embed = new EmbedBuilder().setTitle(title).setDescription(description).setColor(color).setTimestamp();
    channel.send({ embeds: [embed] });
  } catch (e) {
    console.error("logEvent error:", e.message);
  }
}

// ---------------- ANTI-RAID ----------------
const recentJoins = [];
let raidMode = false;
let raidModeTimer = null;

client.on("guildMemberAdd", async (member) => {
  if (member.guild.id !== GUILD_ID) return;
  const now = Date.now();
  recentJoins.push(now);
  while (recentJoins.length && now - recentJoins[0] > RAID_JOIN_WINDOW_MS) recentJoins.shift();

  if (!raidMode && recentJoins.length >= RAID_JOIN_COUNT) {
    raidMode = true;
    logEvent("🚨 Raid détecté", `${recentJoins.length} arrivées en moins de ${RAID_JOIN_WINDOW_MS / 1000}s. Mode raid activé pendant 5 minutes : les nouveaux comptes trop récents seront exclus automatiquement.`, 0xff5555);
    clearTimeout(raidModeTimer);
    raidModeTimer = setTimeout(() => { raidMode = false; logEvent("✅ Fin du mode raid", "Retour à la normale."); }, 1000 * 60 * 5);
  }

  if (raidMode) {
    const accountAge = now - member.user.createdTimestamp;
    if (accountAge < RAID_MIN_ACCOUNT_AGE_MS) {
      try {
        await member.kick("Anti-raid : compte trop récent pendant une vague d'arrivées suspecte");
        logEvent("👢 Anti-raid — exclusion", `${member.user.tag} (compte créé il y a ${(accountAge / 3600000).toFixed(1)}h) a été exclu automatiquement.`);
      } catch (e) {
        console.error("anti-raid kick error:", e.message);
      }
      return;
    }
  }

  // Message de bienvenue en MP
  try {
    await member.send(
      `👋 Bienvenue sur **FIM Site 28** !\n\nConsulte les postes disponibles sur le site pour candidater. Si tu as une question, un membre du staff pourra t'aider directement sur le serveur.`
    );
  } catch (e) {
    // DMs fermés côté utilisateur, on ignore
  }
});

client.on("guildMemberRemove", (member) => {
  if (member.guild.id !== GUILD_ID) return;
  logEvent("📤 Départ", `${member.user?.tag || member.id} a quitté le serveur.`);
});

client.on("guildBanAdd", (ban) => {
  logEvent("🔨 Bannissement", `${ban.user.tag} a été banni.`);
});

client.on("messageDelete", (message) => {
  if (!message.guild || message.guild.id !== GUILD_ID) return;
  if (message.author?.bot) return;
  logEvent("🗑️ Message supprimé", `Auteur : ${message.author?.tag || "?"}\nSalon : <#${message.channelId}>\nContenu : ${message.content ? message.content.slice(0, 500) : "(vide / embed / pièce jointe)"}`);
});

// ---------------- ANTI-SPAM ----------------
const messageLog = new Map(); // userId -> [timestamps]

client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.guild || message.guild.id !== GUILD_ID) return;

  const now = Date.now();
  const arr = messageLog.get(message.author.id) || [];
  arr.push(now);
  while (arr.length && now - arr[0] > SPAM_WINDOW_MS) arr.shift();
  messageLog.set(message.author.id, arr);

  const isSuspiciousInvite = /discord\.gg\/|discord(?:app)?\.com\/invite\//i.test(message.content);
  const massMention = (message.mentions.users.size + message.mentions.roles.size) >= 6;

  if (arr.length > SPAM_MSG_COUNT || massMention) {
    try {
      const member = await message.guild.members.fetch(message.author.id);
      if (member.moderatable) {
        await member.timeout(SPAM_TIMEOUT_MS, "Anti-spam automatique");
        logEvent("🔇 Anti-spam", `${message.author.tag} a été mis en sourdine 10 min (flood/mentions massives).`);
      }
      // Supprime les derniers messages de cet utilisateur dans ce salon
      const recent = await message.channel.messages.fetch({ limit: 20 });
      const toDelete = recent.filter(m => m.author.id === message.author.id);
      if (toDelete.size) await message.channel.bulkDelete(toDelete, true).catch(() => {});
    } catch (e) {
      console.error("anti-spam error:", e.message);
    }
    return;
  }

  if (isSuspiciousInvite) {
    // Supprime juste le lien d'invitation si envoyé par un membre sans droit de gestion
    try {
      const member = await message.guild.members.fetch(message.author.id);
      if (!member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        await message.delete().catch(() => {});
        logEvent("🔗 Lien supprimé", `Invitation Discord postée par ${message.author.tag} supprimée automatiquement.`);
      }
    } catch (e) { /* ignore */ }
  }
});

// ---------------- COMMANDES DE MODÉRATION ----------------
const commands = [
  new SlashCommandBuilder().setName("kick").setDescription("Exclure un membre")
    .addUserOption(o => o.setName("membre").setDescription("Membre à exclure").setRequired(true))
    .addStringOption(o => o.setName("raison").setDescription("Raison"))
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers),
  new SlashCommandBuilder().setName("ban").setDescription("Bannir un membre")
    .addUserOption(o => o.setName("membre").setDescription("Membre à bannir").setRequired(true))
    .addStringOption(o => o.setName("raison").setDescription("Raison"))
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),
  new SlashCommandBuilder().setName("mute").setDescription("Mettre un membre en sourdine (timeout)")
    .addUserOption(o => o.setName("membre").setDescription("Membre").setRequired(true))
    .addIntegerOption(o => o.setName("minutes").setDescription("Durée en minutes").setRequired(true))
    .addStringOption(o => o.setName("raison").setDescription("Raison"))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
  new SlashCommandBuilder().setName("unmute").setDescription("Retirer la sourdine d'un membre")
    .addUserOption(o => o.setName("membre").setDescription("Membre").setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
  new SlashCommandBuilder().setName("warn").setDescription("Avertir un membre (MP + log)")
    .addUserOption(o => o.setName("membre").setDescription("Membre").setRequired(true))
    .addStringOption(o => o.setName("raison").setDescription("Raison").setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
].map(c => c.toJSON());

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName } = interaction;
  const targetUser = interaction.options.getUser("membre");
  const reason = interaction.options.getString("raison") || "Non précisée";

  try {
    if (commandName === "kick") {
      const member = await interaction.guild.members.fetch(targetUser.id);
      await member.kick(reason);
      logEvent("👢 Kick", `${targetUser.tag} exclu par ${interaction.user.tag}. Raison : ${reason}`);
      await interaction.reply({ content: `${targetUser.tag} a été exclu.`, ephemeral: true });
    } else if (commandName === "ban") {
      await interaction.guild.members.ban(targetUser.id, { reason });
      logEvent("🔨 Ban", `${targetUser.tag} banni par ${interaction.user.tag}. Raison : ${reason}`);
      await interaction.reply({ content: `${targetUser.tag} a été banni.`, ephemeral: true });
    } else if (commandName === "mute") {
      const minutes = interaction.options.getInteger("minutes");
      const member = await interaction.guild.members.fetch(targetUser.id);
      await member.timeout(minutes * 60 * 1000, reason);
      logEvent("🔇 Mute", `${targetUser.tag} mis en sourdine ${minutes} min par ${interaction.user.tag}. Raison : ${reason}`);
      await interaction.reply({ content: `${targetUser.tag} est en sourdine pour ${minutes} min.`, ephemeral: true });
    } else if (commandName === "unmute") {
      const member = await interaction.guild.members.fetch(targetUser.id);
      await member.timeout(null);
      logEvent("🔊 Unmute", `${targetUser.tag} retiré de la sourdine par ${interaction.user.tag}.`);
      await interaction.reply({ content: `${targetUser.tag} n'est plus en sourdine.`, ephemeral: true });
    } else if (commandName === "warn") {
      try { await targetUser.send(`⚠️ Tu as reçu un avertissement sur FIM Site 28.\nRaison : ${reason}`); } catch (e) {}
      logEvent("⚠️ Avertissement", `${targetUser.tag} averti par ${interaction.user.tag}. Raison : ${reason}`);
      await interaction.reply({ content: `${targetUser.tag} a été averti.`, ephemeral: true });
    }
  } catch (e) {
    console.error(e);
    await interaction.reply({ content: `Erreur : ${e.message}`, ephemeral: true }).catch(() => {});
  }
});

// ---------------- API HTTP (utilisée par le site via Netlify) ----------------
const app = express();

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "https://site-fim-28.netlify.app");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization, x-api-secret");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

app.use(express.json());

function checkSecret(req, res, next) {
  if (req.header("x-api-secret") !== API_SECRET) return res.status(401).json({ error: "unauthorized" });
  next();
}

app.post("/api/assign-role", checkSecret, async (req, res) => {
  const { discordId, roleId } = req.body || {};
  if (!discordId || !roleId) return res.status(400).json({ error: "discordId et roleId requis" });
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const member = await guild.members.fetch(discordId);
    await member.roles.add(roleId, "Attribution automatique — candidature acceptée");
    logEvent("🎖️ Rôle attribué", `Rôle <@&${roleId}> attribué à ${member.user.tag} suite à l'acceptation de sa candidature.`);
    res.json({ ok: true });
  } catch (e) {
    console.error("assign-role error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/dm", checkSecret, async (req, res) => {
  const { discordId, message } = req.body || {};
  if (!discordId || !message) return res.status(400).json({ error: "discordId et message requis" });
  try {
    const user = await client.users.fetch(discordId);
    await user.send(message);
    res.json({ ok: true });
  } catch (e) {
    console.error("dm error:", e.message);
    res.status(500).json({ error: "Impossible d'envoyer le MP (DMs peut-être fermés)." });
  }
});
// MP depuis le site avec le compte Discord connecté
app.post("/api/dm-oauth", async (req, res) => {
  const auth = req.header("authorization") || "";
  const oauthToken = auth.startsWith("Bearer ")
    ? auth.slice(7).trim()
    : "";

  const { discordId, message } = req.body || {};

  if (!oauthToken || !discordId || !message) {
    return res.status(400).json({
      error: "Authentification Discord, discordId et message requis"
    });
  }

  try {
    // Vérifie le compte Discord connecté au site
    const meRes = await fetch("https://discord.com/api/users/@me", {
      headers: {
        Authorization: `Bearer ${oauthToken}`
      }
    });

    if (!meRes.ok) {
      return res.status(401).json({
        error: "Session Discord invalide ou expirée"
      });
    }

    const me = await meRes.json();

    // Vérifie que la personne est membre du serveur
    const guild = await client.guilds.fetch(GUILD_ID);
    const staffMember = await guild.members.fetch(me.id);

    // Seuls les membres avec Gestion du serveur ou Administrateur peuvent envoyer
    const allowed =
      staffMember.permissions.has(PermissionFlagsBits.ManageGuild) ||
      staffMember.permissions.has(PermissionFlagsBits.Administrator);

    if (!allowed) {
      return res.status(403).json({
        error: "Tu n'as pas les permissions staff requises pour envoyer un MP."
      });
    }

    // Envoi du MP par le bot
    const user = await client.users.fetch(discordId);
    await user.send(message);

    res.json({ ok: true });
  } catch (e) {
    console.error("dm-oauth error:", e.message);
    res.status(500).json({
      error: "Impossible d'envoyer le MP (DMs peut-être fermés)."
    });
  }
});
app.get("/", (req, res) => res.send("BOT FIM SITE 28 actif."));

client.once("ready", async () => {
  console.log(`Connecté en tant que ${client.user.tag}`);
  try {
    const rest = new REST({ version: "10" }).setToken(TOKEN);
    await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: commands });
    console.log("Commandes slash enregistrées.");
  } catch (e) {
    console.error("Erreur enregistrement commandes:", e);
  }
  app.listen(PORT, () => console.log(`API HTTP interne prête sur le port ${PORT}`));
});

client.login(TOKEN);
