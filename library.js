"use strict";

const plugin = {};

let User;
try {
  User = require.main.require("./src/user");
} catch (err) {
  User = null;
}

const USER_PROFILE_FIELDS = [
  "uid",
  "username",
  "userslug",
  "displayname",
  "fullname",
  "picture",
  "uploadedpicture",
  "icon:text",
  "icon:bgColor",
  "icontext",
  "iconbgColor",
  "status",
  "language_flag",
  "languageFlag",
  "countryFlag",
  "country_flag",
  "flag",
  "nationality",
  "country",
  "localeCountry"
];

const userProfileCache = new Map();
const DEFAULT_SERVER_USER_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_BATCH_USERS = 50;

function parseBoolean(value, defaultValue) {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on", "enabled"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off", "disabled"].includes(normalized)) {
    return false;
  }
  return defaultValue;
}

function parseInteger(value, defaultValue) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function cacheTtlMs() {
  return Math.max(60 * 1000, parseInteger(process.env.CP_WK_USER_CACHE_TTL_MS, DEFAULT_SERVER_USER_CACHE_TTL_MS));
}

function normalizeUidList(input) {
  return String(input || "")
    .split(/[\s,]+/)
    .map((uid) => parseInteger(uid, 0))
    .filter((uid, index, arr) => uid > 0 && arr.indexOf(uid) === index)
    .slice(0, MAX_BATCH_USERS);
}

function pickPublicUserFields(u) {
  u = u || {};
  return {
    uid: Number(u.uid || 0),
    username: u.username || "",
    userslug: u.userslug || u.slug || u.username || "",
    displayname: u.displayname || u.fullname || u.username || "",
    fullname: u.fullname || "",
    picture: u.picture || u.uploadedpicture || "",
    icontext: u.icontext || u["icon:text"] || "",
    iconbgColor: u.iconbgColor || u["icon:bgColor"] || "#72a5f2",
    status: u.status || "",
    language_flag: u.language_flag || u.languageFlag || u.countryFlag || u.country_flag || u.flag || u.nationality || u.country || u.localeCountry || ""
  };
}

function cacheGet(uid) {
  const hit = userProfileCache.get(String(uid));
  if (!hit || hit.expiresAt < Date.now()) {
    userProfileCache.delete(String(uid));
    return null;
  }
  return hit.user;
}

function cacheSet(uid, user) {
  if (!uid || !user) return;
  userProfileCache.set(String(uid), {
    user,
    expiresAt: Date.now() + cacheTtlMs()
  });
}

async function getUsersPublicProfiles(uids) {
  const uniqueUids = normalizeUidList(uids.join ? uids.join(",") : uids);
  if (!uniqueUids.length) return [];

  const cached = [];
  const missing = [];
  uniqueUids.forEach((uid) => {
    const hit = cacheGet(uid);
    if (hit) cached.push(hit);
    else missing.push(uid);
  });

  let loaded = [];
  if (missing.length && User) {
    if (typeof User.getUsersFields === "function") {
      const users = await User.getUsersFields(missing, USER_PROFILE_FIELDS);
      loaded = Array.isArray(users) ? users.map(pickPublicUserFields) : [];
    } else if (typeof User.getUserFields === "function") {
      loaded = await Promise.all(missing.map(async (uid) => pickPublicUserFields(await User.getUserFields(uid, USER_PROFILE_FIELDS))));
    }
    loaded.forEach((u) => cacheSet(u.uid, u));
  }

  const byUid = new Map();
  cached.concat(loaded).forEach((u) => {
    if (u && u.uid) byUid.set(String(u.uid), u);
  });

  return uniqueUids.map((uid) => byUid.get(String(uid))).filter(Boolean);
}

plugin.init = async function init(params) {
  const router = params.router;
  const middleware = params.middleware;

  router.get("/cp-wukong-topic-chat/health", middleware.applyCSRF, async (req, res) => {
    res.json({
      ok: true,
      plugin: "nodebb-plugin-cp-wukong-topic-chat",
      version: "0.3.0",
      enabled: parseBoolean(process.env.CP_WK_TOPIC_CHAT_ENABLED, true),
      categoryId: parseInteger(process.env.CP_WK_CATEGORY_ID || process.env.CP_WK_BOARD_ID, 7),
      jsRegistered: true,
      cssRegistered: true,
      userBatchApi: true,
      userCacheTtlMs: cacheTtlMs()
    });
  });

  router.get("/bridge/nodebb-users", async (req, res) => {
    try {
      const uids = normalizeUidList(req.query && req.query.uids);
      if (!uids.length) return res.json({ users: [] });
      const users = await getUsersPublicProfiles(uids);
      res.json({ users, cacheTtlMs: cacheTtlMs() });
    } catch (err) {
      res.status(500).json({ error: "nodebb_users_failed", message: String((err && err.message) || err) });
    }
  });

  router.get("/bridge/nodebb-user/:uid", async (req, res) => {
    try {
      const uid = parseInteger(req.params && req.params.uid, 0);
      if (!uid) return res.status(400).json({ error: "invalid_uid" });
      const users = await getUsersPublicProfiles([uid]);
      res.json(users[0] || { uid });
    } catch (err) {
      res.status(500).json({ error: "nodebb_user_failed", message: String((err && err.message) || err) });
    }
  });
};

plugin.getConfig = async function getConfig(config) {
  config.cpWukongTopicChat = {
    enabled: parseBoolean(process.env.CP_WK_TOPIC_CHAT_ENABLED, true),
    categoryId: parseInteger(process.env.CP_WK_CATEGORY_ID || process.env.CP_WK_BOARD_ID, 7),
    localeFallback: process.env.CP_WK_LOCALE_FALLBACK || "en-GB",
    pluginId: "nodebb-plugin-cp-wukong-topic-chat",
    userBatchUrl: "/bridge/nodebb-users",
    userCacheTtlMs: cacheTtlMs()
  };

  return config;
};

module.exports = plugin;
