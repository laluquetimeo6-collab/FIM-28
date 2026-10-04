// Fonction Netlify — remplace l'API du bot sur Render.
// Elle vérifie que la personne connectée est staff (Gérer le serveur / Administrateur),
// puis attribue les rôles, envoie le message dans le salon et le MP, en utilisant le token du bot.
// Variables à créer sur Netlify : DISCORD_TOKEN, GUILD_ID, NOTIFY_CHANNEL_ID
// (optionnel : LOG_CHANNEL_ID, CADET_ROLE_ID)

const API = "https://discord.com/api/v10";
const UA = "DiscordBot (https://intersite-fim.netlify.app, 1.0.0)";
const BOT_TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID || "1556332580650098738";
const NOTIFY_CHANNEL_ID = process.env.NOTIFY_CHANNEL_ID;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID || null;
const CADET_ROLE_ID = process.env.CADET_ROLE_ID || "1556333597131145367";

const PERM_ADMIN = 0x8n;
const PERM_MANAGE_GUILD = 0x20n;
const PERM_MANAGE_ROLES = 0x10000000n;

function json(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

async function discord(method, path, opts = {}) {
  const headers = {
    Authorization: opts.bearer ? `Bearer ${opts.bearer}` : `Bot ${BOT_TOKEN}`,
    "User-Agent": UA,
  };
  if (opts.body) headers["Content-Type"] = "application/json";
  if (opts.reason) headers["X-Audit-Log-Reason"] = encodeURIComponent(opts.reason);
  const res = await fetch(API + path, {
    method,
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text.slice(0, 200) }; }
  return { ok: res.ok, status: res.status, data };
}

function parseRoleIds(value) {
  if (!Array.isArray(value)) return null;
  return [...new Set(value.map(v => String(v).trim()).filter(v => /^\d{15,25}$/.test(v)))].slice(0, 10);
}

async function logEvent(title, text) {
  if (!LOG_CHANNEL_ID) return;
  await discord("POST", `/channels/${LOG_CHANNEL_ID}/messages`, {
    body: { embeds: [{ title, description: String(text).slice(0, 4000), color: 0xd4af37, timestamp: new Date().toISOString() }] },
  }).catch(() => {});
}

// Vérifie que la personne a « Gérer le serveur » ou « Administrateur » sur le serveur.
async function checkStaff(userId) {
  const [member, roles, guild] = await Promise.all([
    discord("GET", `/guilds/${GUILD_ID}/members/${userId}`),
    discord("GET", `/guilds/${GUILD_ID}/roles`),
    discord("GET", `/guilds/${GUILD_ID}`),
  ]);
  if (!roles.ok || !guild.ok) {
    return { allowed: false, status: 500, error: "Le bot n'est pas sur le serveur Discord, ou le GUILD_ID / DISCORD_TOKEN est faux sur Netlify." };
  }
  if (!member.ok) {
    return { allowed: false, status: 403, error: "Ton compte Discord n'est pas membre du serveur." };
  }
  if (guild.data.owner_id === userId) return { allowed: true, roles: roles.data };
  const ids = new Set([GUILD_ID, ...(member.data.roles || [])]);
  let perms = 0n;
  for (const r of roles.data) if (ids.has(r.id)) perms |= BigInt(r.permissions);
  if (perms & (PERM_ADMIN | PERM_MANAGE_GUILD)) return { allowed: true, roles: roles.data };
  return { allowed: false, status: 401, error: "Accès refusé : ton compte Discord doit avoir « Gérer le serveur » ou « Administrateur » sur le serveur." };
}

// Vérifie TOUS les rôles d'abord, puis les attribue. Lance une Error lisible en cas de souci.
async function assignRoles(userId, roleIds, rolesList, reason) {
  const byId = new Map(rolesList.map(r => [r.id, r]));
  const picked = [];
  for (const rid of roleIds) {
    const role = byId.get(rid);
    if (!role) throw new Error(`Rôle introuvable (ID ${rid}). Vérifie l'ID.`);
    if (role.managed) throw new Error(`Le rôle « ${role.name} » est géré par une intégration, il ne peut pas être attribué.`);
    if (BigInt(role.permissions) & (PERM_ADMIN | PERM_MANAGE_GUILD | PERM_MANAGE_ROLES)) {
      throw new Error(`Le rôle « ${role.name} » a des permissions d'administration : attribution refusée.`);
    }
    picked.push(role);
  }
  for (const role of picked) {
    const r = await discord("PUT", `/guilds/${GUILD_ID}/members/${userId}/roles/${role.id}`, { reason });
    if (!r.ok) {
      if (r.status === 403) throw new Error(`Le bot ne peut pas attribuer « ${role.name} ». Place le rôle du bot au-dessus de celui-ci dans les paramètres du serveur.`);
      if (r.status === 404) throw new Error("Ce candidat n'est pas sur le serveur Discord : impossible de lui attribuer des rôles.");
      throw new Error(`Discord a refusé l'attribution de « ${role.name} » (HTTP ${r.status}).`);
    }
  }
  return picked.map(r => ({ id: r.id, name: r.name }));
}

async function sendDM(userId, content) {
  const ch = await discord("POST", "/users/@me/channels", { body: { recipient_id: userId } });
  if (!ch.ok) return { ok: false, error: (ch.data && ch.data.message) || `HTTP ${ch.status}` };
  const m = await discord("POST", `/channels/${ch.data.id}/messages`, { body: { content: String(content).slice(0, 2000) } });
  if (!m.ok) return { ok: false, error: (m.data && m.data.message) || `HTTP ${m.status}` };
  return { ok: true };
}

async function findMember(discordId, names) {
  if (discordId) {
    const m = await discord("GET", `/guilds/${GUILD_ID}/members/${discordId}`);
    if (m.ok) return m.data;
  }
  for (const raw of names.filter(Boolean)) {
    const wanted = String(raw).trim().toLowerCase().replace(/^@/, "");
    if (!wanted) continue;
    const found = await discord("GET", `/guilds/${GUILD_ID}/members/search?query=${encodeURIComponent(wanted)}&limit=50`);
    if (!found.ok) continue;
    const hit = found.data.find(m => {
      const u = m.user || {};
      return String(u.username || "").toLowerCase() === wanted
        || String(u.global_name || "").toLowerCase() === wanted
        || String(m.nick || "").toLowerCase() === wanted;
    });
    if (hit) return hit;
  }
  return null;
}

async function actionDM(me, body, rolesList) {
  const { discordId, message } = body;
  if (!discordId || !message) return json(400, { error: "discordId et message requis" });

  let assigned = [];
  const roleIds = parseRoleIds(body.roleIds) || [];
  if (roleIds.length) {
    try {
      assigned = await assignRoles(discordId, roleIds, rolesList, "Attribution depuis le site — MP");
    } catch (e) {
      return json(500, { error: e.message });
    }
    await logEvent("🎖️ Rôles attribués", `${assigned.map(r => `<@&${r.id}>`).join(", ")} → <@${discordId}> (depuis le site, via MP, par <@${me.id}>).`);
  }

  const dm = await sendDM(discordId, message);
  if (!dm.ok) {
    return json(500, { error: "Impossible d'envoyer le MP (DMs peut-être fermés).", assignedRoles: assigned.map(r => r.name) });
  }
  return json(200, { ok: true, assignedRoles: assigned.map(r => r.name) });
}

async function actionNotify(me, body, rolesList) {
  const { message, discordId: suppliedId, discordUsername, discordDisplayName, status } = body;
  if (!message) return json(400, { error: "message requis" });
  if (!NOTIFY_CHANNEL_ID) return json(500, { error: "NOTIFY_CHANNEL_ID non configuré sur Netlify" });

  const candidate = await findMember(suppliedId, [discordUsername, discordDisplayName]);
  if (!candidate) {
    return json(404, { error: "Candidat Discord introuvable. Vérifie l'ID Discord du candidat (et qu'il est bien sur le serveur)." });
  }
  const discordId = candidate.user.id;

  let roleIds = parseRoleIds(body.roleIds);
  if (roleIds === null) roleIds = (status === "admis" && CADET_ROLE_ID) ? [CADET_ROLE_ID] : [];

  let assigned = [];
  if (roleIds.length) {
    try {
      assigned = await assignRoles(discordId, roleIds, rolesList, "Attribution depuis le site — candidature");
    } catch (e) {
      return json(500, { error: e.message });
    }
    await logEvent("🎖️ Rôles attribués", `${assigned.map(r => `<@&${r.id}>`).join(", ")} → <@${discordId}> (depuis le site, par <@${me.id}>).`);
  }

  const posted = await discord("POST", `/channels/${NOTIFY_CHANNEL_ID}/messages`, {
    body: {
      content: `${String(message).slice(0, 1850)}\n\n<@${discordId}>`,
      allowed_mentions: { users: [discordId], parse: [] },
    },
  });
  if (!posted.ok) {
    return json(500, { error: `Impossible d'écrire dans le salon de notification (HTTP ${posted.status}). Vérifie NOTIFY_CHANNEL_ID et les permissions du bot dans ce salon.` });
  }

  const rolesText = assigned.length ? `\n🎖️ Rôle(s) attribué(s) : **${assigned.map(r => r.name).join(", ")}**` : "";
  const dmMessage = status === "admis"
    ? `🎉 **Félicitations !**\n\nTa candidature **FIM Intersite** a été approuvée.${rolesText}\n\n${String(message).slice(0, 1200)}`
    : `${String(message).slice(0, 1700)}${rolesText}`;
  const dm = await sendDM(discordId, dmMessage);

  return json(200, {
    ok: true,
    roleAssigned: assigned.length > 0,
    assignedRoles: assigned.map(r => r.name),
    dmSent: dm.ok,
    dmError: dm.ok ? null : dm.error,
  });
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "POST requis" });
  if (!BOT_TOKEN) return json(500, { error: "DISCORD_TOKEN non configuré sur Netlify" });

  const action = (event.queryStringParameters || {}).action;
  const auth = (event.headers && (event.headers.authorization || event.headers.Authorization)) || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token) return json(401, { error: "Authentification Discord requise. Reconnecte-toi sur le site." });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { error: "JSON invalide" }); }

  try {
    const me = await discord("GET", "/users/@me", { bearer: token });
    if (!me.ok) {
      return json(401, { error: `Discord a refusé la session (HTTP ${me.status}). Déconnecte-toi puis reconnecte-toi sur le site.` });
    }
    const staff = await checkStaff(me.data.id);
    if (!staff.allowed) return json(staff.status || 401, { error: staff.error });

    if (action === "dm") return await actionDM(me.data, body, staff.roles);
    if (action === "notify") return await actionNotify(me.data, body, staff.roles);
    return json(400, { error: "Action inconnue" });
  } catch (e) {
    console.error("bot-api error:", e);
    return json(500, { error: "Erreur serveur : " + e.message });
  }
};
