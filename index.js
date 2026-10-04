// Bot Discord — FIM INTERSITE
// Fonctions : anti-raid, anti-spam, modération (kick/ban/mute), logs,
// MP de bienvenue, et une petite API HTTP privée utilisée par le site
// (via une fonction Netlify) pour attribuer un rôle et envoyer un MP
// quand une candidature est acceptée/refusée.

const express = require("express");
const {
  Client, GatewayIntentBits, Partials, PermissionFlagsBits,
  EmbedBuilder, REST, Routes, SlashCommandBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  StringSelectMenuBuilder,
} = require("discord.js");

// ---- Config (variables d'environnement) ----
const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID || "1556332580650098738";
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID || null; // optionnel
const NOTIFY_CHANNEL_ID = process.env.NOTIFY_CHANNEL_ID || null; // salon dédié aux notifications du site
const CADET_ROLE_ID = process.env.CADET_ROLE_ID || "1556333597131145367"; // optionnel : sinon le bot cherche le rôle nommé « Cadet »
const API_SECRET = process.env.API_SECRET;
const PORT = process.env.PORT || 3000;

if (!TOKEN || !GUILD_ID || !API_SECRET) {
  console.error("Il manque DISCORD_TOKEN, GUILD_ID ou API_SECRET dans les variables d'environnement.");
  process.exit(1);
}

// ---- Réglages anti-raid / anti-spam (ajuste si besoin) ----
const RAID_JOIN_COUNT = 15;      // nb d'arrivées...
const RAID_JOIN_WINDOW_MS = 15000; // ...en moins de 15s = alerte raid
const RAID_MIN_ACCOUNT_AGE_MS = 1000 * 60 * 60 * 24 * 3; // 3 jours

const SPAM_MSG_COUNT = 5;        // nb de messages...
const SPAM_WINDOW_MS = 6000;     // ...en moins de 6s = spam
const SPAM_TIMEOUT_MS = 1000 * 60 * 10; // mute 10 min

// ---- Rôles ciblés par le panel d'appel ----
const ROLE_E11_ID = "1556333639183245372"; // Opérateur E-11
const ROLE_NU7_ID = "1556333675153461248"; // Opérateur Nu-7
const APPEL_ROLES = {
  E11: { id: ROLE_E11_ID, label: "Opérateur E-11" },
  NU7: { id: ROLE_NU7_ID, label: "Opérateur Nu-7" },
};

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
    // Anti-raid : tout bot qui rejoint pendant une vague suspecte est exclu direct
    if (member.user.bot) {
      try {
        await member.kick("Anti-raid : bot exclu automatiquement pendant une vague d'arrivées suspecte");
        logEvent("🤖 Anti-raid — bot exclu", `${member.user.tag} (bot) a été exclu automatiquement.`);
      } catch (e) {
        console.error("anti-raid bot kick error:", e.message);
      }
      return;
    }
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
      `👋 Bienvenue sur **FIM Intersite** !\n\nConsulte les postes disponibles sur le site pour candidater. Si tu as une question, un membre du staff pourra t'aider directement sur le serveur.`
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
    // Hors mode raid : supprime le lien si l'auteur n'a pas Gérer le serveur.
    // En mode raid : supprime même si l'auteur a Gérer le serveur (seuls les admins sont épargnés).
    try {
      const member = await message.guild.members.fetch(message.author.id);
      const isAdmin = member.permissions.has(PermissionFlagsBits.Administrator);
      const isExempt = isAdmin || (!raidMode && member.permissions.has(PermissionFlagsBits.ManageGuild));
      if (!isExempt) {
        await message.delete().catch(() => {});
        logEvent("🔗 Lien supprimé", `Invitation Discord postée par ${message.author.tag} supprimée automatiquement${raidMode ? " (mode raid)" : ""}.`);
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
  new SlashCommandBuilder().setName("appel-setup").setDescription("Poste le panel d'appel E-11 / Nu-7 dans ce salon")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
].map(c => c.toJSON());

client.on("interactionCreate", async (interaction) => {
  // ---- Panel d'appel : clic sur le bouton -> demande la catégorie (E-11 ou Nu-7) ----
  if (interaction.isButton() && interaction.customId === "appel_open") {
    const select = new StringSelectMenuBuilder()
      .setCustomId("appel_role_select")
      .setPlaceholder("Choisis la catégorie à appeler")
      .addOptions(
        { label: "Opérateur E-11", value: "E11" },
        { label: "Opérateur Nu-7", value: "NU7" },
      );
    const row = new ActionRowBuilder().addComponents(select);
    await interaction.reply({ content: "Quelle catégorie veux-tu appeler ?", components: [row], ephemeral: true });
    return;
  }

  // ---- Panel d'appel : catégorie choisie -> ouvre la fenêtre pour la raison ----
  if (interaction.isStringSelectMenu() && interaction.customId === "appel_role_select") {
    const roleKey = interaction.values[0]; // "E11" ou "NU7"
    const role = APPEL_ROLES[roleKey];
    if (!role) return;
    const modal = new ModalBuilder()
      .setCustomId(`appel_modal_${roleKey}`)
      .setTitle(`Appel ${role.label}`);
    const raisonInput = new TextInputBuilder()
      .setCustomId("appel_raison")
      .setLabel("Raison de l'appel")
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMaxLength(500);
    modal.addComponents(new ActionRowBuilder().addComponents(raisonInput));
    await interaction.showModal(modal);
    return;
  }

  // ---- Panel d'appel : envoi de la fenêtre -> ping le rôle choisi avec la raison ----
  if (interaction.isModalSubmit() && interaction.customId.startsWith("appel_modal_")) {
    const roleKey = interaction.customId.replace("appel_modal_", "");
    const role = APPEL_ROLES[roleKey];
    if (!role) return;
    const raison = interaction.fields.getTextInputValue("appel_raison");
    const embed = new EmbedBuilder()
      .setTitle(`📢 Appel — ${role.label}`)
      .setDescription(`**Raison :** ${raison}`)
      .setColor(0xE74C3C)
      .setFooter({ text: `Appel lancé par ${interaction.user.tag}` })
      .setTimestamp();
    await interaction.reply({
      content: `<@&${role.id}>`,
      embeds: [embed],
      allowedMentions: { roles: [role.id] },
    });
    logEvent("📢 Appel", `Appel ${role.label} lancé par ${interaction.user.tag}. Raison : ${raison}`);
    return;
  }

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
      try { await targetUser.send(`⚠️ Tu as reçu un avertissement sur FIM Intersite.\nRaison : ${reason}`); } catch (e) {}
      logEvent("⚠️ Avertissement", `${targetUser.tag} averti par ${interaction.user.tag}. Raison : ${reason}`);
      await interaction.reply({ content: `${targetUser.tag} a été averti.`, ephemeral: true });
    } else if (commandName === "appel-setup") {
      const embed = new EmbedBuilder()
        .setTitle("📢 Appel général — E-11 / Nu-7")
        .setDescription("Clique sur le bouton ci-dessous, choisis la catégorie (Opérateur E-11 ou Opérateur Nu-7), puis indique la raison dans la fenêtre.")
        .setColor(0xE74C3C);
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("appel_open").setLabel("Lancer un appel").setStyle(ButtonStyle.Danger).setEmoji("📢")
      );
      await interaction.channel.send({ embeds: [embed], components: [row] });
      await interaction.reply({ content: "Panel d'appel posté dans ce salon.", ephemeral: true });
    }
  } catch (e) {
    console.error(e);
    await interaction.reply({ content: `Erreur : ${e.message}`, ephemeral: true }).catch(() => {});
  }
});

// ---------------- VÉRIFICATION DU COMPTE DISCORD (OAuth) ----------------
// Discord renvoie parfois 429 aux requêtes venant d'hébergeurs partagés (Render) quand
// elles n'ont pas de User-Agent propre. On en met un, on réessaie une fois, et on garde
// le résultat 5 minutes en mémoire pour ne pas rappeler Discord à chaque clic.
const tokenCache = new Map(); // token -> { user, exp }
async function getDiscordUser(token) {
  const cached = tokenCache.get(token);
  if (cached && cached.exp > Date.now()) return { ok: true, user: cached.user };

  let lastStatus = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetch("https://discord.com/api/v10/users/@me", {
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "DiscordBot (https://intersite-fim.netlify.app, 1.0.0)",
      },
    });
    if (r.ok) {
      const user = await r.json();
      if (tokenCache.size > 200) tokenCache.clear();
      tokenCache.set(token, { user, exp: Date.now() + 5 * 60 * 1000 });
      return { ok: true, user };
    }
    lastStatus = r.status;
    const body = await r.text().catch(() => "");
    console.error("Discord /users/@me a répondu", r.status, body.slice(0, 200));
    if (r.status === 429 && attempt === 0) {
      const wait = Math.min(Number(r.headers.get("retry-after")) || 2, 5);
      await new Promise(resolve => setTimeout(resolve, wait * 1000));
      continue;
    }
    break;
  }
  return { ok: false, status: lastStatus };
}

function sessionErrorMessage(status) {
  return status === 429
    ? "Discord limite temporairement les requêtes du serveur (HTTP 429). Attends 30 secondes puis réessaie."
    : `Discord a refusé la session (HTTP ${status}). Déconnecte-toi puis reconnecte-toi sur le site.`;
}

// ---------------- RÔLES CHOISIS DEPUIS LE SITE ----------------
// Sécurité : le bot refuse d'attribuer un rôle qui donne des permissions d'administration.
const FORBIDDEN_ROLE_PERMS = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageRoles,
];

// Renvoie un tableau d'ID valides, ou null si le site n'a envoyé aucune liste.
function parseRoleIds(value) {
  if (!Array.isArray(value)) return null;
  return [...new Set(value.map(v => String(v).trim()).filter(v => /^\d{15,25}$/.test(v)))].slice(0, 10);
}

// Vérifie TOUS les rôles d'abord, puis les attribue. Lance une Error lisible en cas de souci.
async function assignRoles(guild, member, roleIds, reason) {
  const roles = [];
  for (const rid of roleIds) {
    const role = await guild.roles.fetch(rid).catch(() => null);
    if (!role) throw new Error(`Rôle introuvable (ID ${rid}). Vérifie l'ID.`);
    if (role.managed) throw new Error(`Le rôle « ${role.name} » est géré par une intégration, le bot ne peut pas l'attribuer.`);
    if (FORBIDDEN_ROLE_PERMS.some(perm => role.permissions.has(perm))) throw new Error(`Le rôle « ${role.name} » a des permissions d'administration : attribution refusée.`);
    if (!role.editable) throw new Error(`Le bot ne peut pas attribuer « ${role.name} ». Place le rôle du bot au-dessus de celui-ci dans les paramètres du serveur.`);
    roles.push(role);
  }
  for (const role of roles) await member.roles.add(role, reason);
  return roles.map(r => ({ id: r.id, name: r.name }));
}

// ---------------- API HTTP (utilisée par le site via Netlify) ----------------
const app = express();

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "https://intersite-fim.netlify.app");
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

  let assignedRoles = [];
  try {
    // Vérifie le compte Discord connecté au site
    const meCheck = await getDiscordUser(oauthToken);
    if (!meCheck.ok) {
      return res.status(401).json({ error: sessionErrorMessage(meCheck.status) });
    }
    const me = meCheck.user;

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

    // Rôles choisis sur le site (optionnel)
    const roleIds = parseRoleIds(req.body.roleIds) || [];
    if (roleIds.length) {
      const target = await guild.members.fetch(discordId).catch(() => null);
      if (!target) {
        return res.status(404).json({ error: "Ce candidat n'est pas sur le serveur Discord : impossible de lui attribuer des rôles." });
      }
      try {
        assignedRoles = await assignRoles(guild, target, roleIds, "Attribution depuis le site — MP");
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
      logEvent(
        "🎖️ Rôles attribués",
        `${assignedRoles.map(r => `<@&${r.id}>`).join(", ")} → ${target.user.tag} (depuis le site, via MP).`
      );
    }

    // Envoi du MP par le bot
    const user = await client.users.fetch(discordId);
    await user.send(message);

    res.json({ ok: true, assignedRoles: assignedRoles.map(r => r.name) });
  } catch (e) {
    console.error("dm-oauth error:", e.message);
    res.status(500).json({
      error: "Impossible d'envoyer le MP (DMs peut-être fermés).",
      assignedRoles: assignedRoles.map(r => r.name)
    });
  }
});
// Notification dans un salon dédié (bouton "Notifier Discord" du site)
app.post("/api/notify", async (req, res) => {
  const { message, discordId: suppliedDiscordId, discordUsername, discordDisplayName, status, roleIds: rawRoleIds } = req.body || {};
  if (!message) return res.status(400).json({ error: "message requis" });

  // Le fonctionnement principal utilise l'ID Discord exact.
  // Le nom reste uniquement un secours pour les très anciennes candidatures.
  let discordId = suppliedDiscordId || null;
  if (!NOTIFY_CHANNEL_ID) return res.status(500).json({ error: "NOTIFY_CHANNEL_ID non configuré sur le serveur" });

  try {
    // Autorisé si : secret API valide OU compte Discord staff connecté au site
    let allowed = !!API_SECRET && req.header("x-api-secret") === API_SECRET;
    if (!allowed) {
      const auth = req.header("authorization") || "";
      const oauthToken = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
      if (oauthToken) {
        const meCheck = await getDiscordUser(oauthToken);
        if (meCheck.ok) {
          const me = meCheck.user;
          const guild = await client.guilds.fetch(GUILD_ID);
          const staffMember = await guild.members.fetch(me.id);
          allowed =
            staffMember.permissions.has(PermissionFlagsBits.ManageGuild) ||
            staffMember.permissions.has(PermissionFlagsBits.Administrator);
          if (!allowed) console.error("notify : le compte", me.id, "n'a pas Gérer le serveur / Administrateur sur le serveur.");
        } else {
          return res.status(401).json({ error: sessionErrorMessage(meCheck.status) });
        }
      }
    }
    if (!allowed) return res.status(401).json({ error: "Accès refusé : ton compte Discord doit avoir « Gérer le serveur » ou « Administrateur » sur le serveur." });

    const guild = await client.guilds.fetch(GUILD_ID);

    let candidate = null;
    if (discordId) {
      try {
        candidate = await guild.members.fetch(discordId);
      } catch (e) {
        candidate = null;
      }
    }

    if (!candidate && (discordUsername || discordDisplayName)) {
      const wantedNames = [discordUsername, discordDisplayName]
        .filter(Boolean)
        .map(v => String(v).trim().toLowerCase().replace(/^@/, ""));
      try {
        for (const wanted of wantedNames) {
          if (candidate) break;
          const found = await guild.members.fetch({ query: wanted, limit: 50 });
          candidate = found.find(m => {
            const u = m.user;
            return String(u.username || "").toLowerCase() === wanted
              || String(u.globalName || "").toLowerCase() === wanted
              || String(m.displayName || "").toLowerCase() === wanted;
          }) || null;
        }
      } catch (e) {
        console.warn("Recherche du candidat par nom impossible:", e.message);
      }
    }

    if (!candidate) {
      return res.status(404).json({
        error: "Candidat Discord introuvable. Cette candidature ne contient pas de Discord ID valide et le nom Discord n'a pas permis de retrouver le membre."
      });
    }

    discordId = candidate.id;

    // Rôles à attribuer : liste choisie sur le site (roleIds).
    // Si le site n'envoie aucune liste (ancienne version), une candidature acceptée donne le rôle Cadet.
    let roleIds = parseRoleIds(rawRoleIds);
    if (roleIds === null) roleIds = (status === "admis" && CADET_ROLE_ID) ? [CADET_ROLE_ID] : [];

    let assignedRoles = [];
    if (roleIds.length) {
      try {
        assignedRoles = await assignRoles(guild, candidate, roleIds, "Attribution depuis le site — candidature");
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
      logEvent(
        "🎖️ Rôles attribués",
        `${assignedRoles.map(r => `<@&${r.id}>`).join(", ")} → ${candidate.user.tag} (depuis le site).`
      );
    }

    // Notification dans le salon : le candidat est réellement mentionné.
    const channel = await client.channels.fetch(NOTIFY_CHANNEL_ID);
    const channelMessage = `${String(message).slice(0, 1850)}\n\n<@${discordId}>`;
    await channel.send({
      content: channelMessage,
      allowedMentions: { users: [discordId], parse: [] }
    });

    // MP au candidat. Les DMs peuvent être fermés : dans ce cas, la notification
    // du salon et l'attribution du rôle restent réussies.
    let dmSent = false;
    let dmError = null;
    try {
      const rolesText = assignedRoles.length
        ? `\n🎖️ Rôle(s) attribué(s) : **${assignedRoles.map(r => r.name).join(", ")}**`
        : "";
      const dmMessage = status === "admis"
        ? `🎉 **Félicitations !**\n\nTa candidature **FIM Intersite** a été approuvée.${rolesText}\n\n${String(message).slice(0, 1200)}`
        : `${String(message).slice(0, 1700)}${rolesText}`;
      await candidate.send(dmMessage);
      dmSent = true;
    } catch (e) {
      dmError = "Impossible d'envoyer le MP (DMs fermés ou non disponibles).";
      console.warn("notify DM error:", e.message);
    }

    res.json({ ok: true, roleAssigned: assignedRoles.length > 0, assignedRoles: assignedRoles.map(r => r.name), dmSent, dmError });
  } catch (e) {
    console.error("notify error:", e.message);
    res.status(500).json({ error: e.message || "Impossible d'envoyer la notification." });
  }
});

app.get("/", (req, res) => res.send("BOT FIM INTERSITE actif."));

// Le port HTTP s'ouvre TOUT DE SUITE (Render exige un port ouvert), sans attendre Discord.
app.listen(PORT, "0.0.0.0", () => console.log(`API HTTP prête sur le port ${PORT}`));

let started = false;
async function onReady() {
  if (started) return;
  started = true;
  console.log(`Connecté en tant que ${client.user.tag}`);
  try {
    const rest = new REST({ version: "10" }).setToken(TOKEN);
    await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: commands });
    console.log("Commandes slash enregistrées.");
  } catch (e) {
    console.error("Erreur enregistrement commandes:", e);
  }
}
// "clientReady" (discord.js ≥ 14.22) ou "ready" (versions plus anciennes)
client.once("clientReady", onReady);
client.once("ready", onReady);

client.on("error", (e) => console.error("Erreur client Discord:", e));
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));

console.log("Connexion à Discord…");
client.login(TOKEN).catch((e) => {
  console.error("❌ Connexion Discord impossible :", e.message);
});
