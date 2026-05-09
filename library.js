"use strict";

const plugin = {};

let User;
let db;
try {
  User = require.main.require("./src/user");
} catch (err) {
  User = null;
}
try {
  db = require.main.require("./src/database");
} catch (err) {
  db = null;
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

async function loadUserRawFields(uid) {
  uid = parseInteger(uid, 0);
  if (!uid) return null;

  let out = null;

  if (User && typeof User.getUserFields === "function") {
    try {
      out = await User.getUserFields(uid, USER_PROFILE_FIELDS);
    } catch (err) {
      out = null;
    }
  }

  // Some custom profile fields can be present directly in user:<uid> even when
  // they are not exposed by normal user helpers. Read only the small public
  // whitelist above; never return private fields such as email/location/birthday.
  if (db && typeof db.getObjectFields === "function") {
    try {
      const direct = await db.getObjectFields(`user:${uid}`, USER_PROFILE_FIELDS);
      out = Object.assign({}, out || {}, direct || {});
    } catch (err) {}
  }

  if (!out) return null;
  out.uid = out.uid || uid;
  return out;
}

async function getUsersPublicProfiles(uids) {
  const uniqueUids = normalizeUidList(uids && uids.join ? uids.join(",") : uids);
  if (!uniqueUids.length) return [];

  const resultByUid = new Map();
  const missing = [];

  uniqueUids.forEach((uid) => {
    const hit = cacheGet(uid);
    if (hit) resultByUid.set(String(uid), hit);
    else missing.push(uid);
  });

  let loaded = [];

  if (missing.length) {
    // Prefer the bulk helper when it exists, then merge with direct db reads so
    // custom fields like language_flag are not silently dropped.
    if (User && typeof User.getUsersFields === "function") {
      try {
        const bulk = await User.getUsersFields(missing, USER_PROFILE_FIELDS);
        if (Array.isArray(bulk)) loaded = bulk;
      } catch (err) {
        loaded = [];
      }
    }

    const loadedByUid = new Map();
    loaded.forEach((u) => {
      if (u && u.uid) loadedByUid.set(String(u.uid), u);
    });

    await Promise.all(missing.map(async (uid) => {
      const direct = await loadUserRawFields(uid);
      const merged = Object.assign({}, loadedByUid.get(String(uid)) || {}, direct || {}, { uid });
      const publicUser = pickPublicUserFields(merged);
      if (publicUser && publicUser.uid) {
        cacheSet(publicUser.uid, publicUser);
        resultByUid.set(String(publicUser.uid), publicUser);
      }
    }));
  }

  return uniqueUids.map((uid) => resultByUid.get(String(uid))).filter(Boolean);
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

  const handleUsersBatch = async (req, res) => {
    try {
      const uids = normalizeUidList(req.query && req.query.uids);
      if (!uids.length) return res.json({ users: [], cacheTtlMs: cacheTtlMs() });
      const users = await getUsersPublicProfiles(uids);
      res.json({ users, cacheTtlMs: cacheTtlMs() });
    } catch (err) {
      res.status(500).json({ error: "nodebb_users_failed", message: String((err && err.message) || err) });
    }
  };

  const handleSingleUser = async (req, res) => {
    try {
      const uid = parseInteger(req.params && req.params.uid, 0);
      if (!uid) return res.status(400).json({ error: "invalid_uid" });
      const users = await getUsersPublicProfiles([uid]);
      res.json(users[0] || { uid });
    } catch (err) {
      res.status(500).json({ error: "nodebb_user_failed", message: String((err && err.message) || err) });
    }
  };

  // Main bridge routes used by the chat frontend.
  router.get("/bridge/nodebb-users", handleUsersBatch);
  router.get("/bridge/nodebb-user/:uid", handleSingleUser);

  // Alias routes for quick browser testing. These also prevent confusion when
  // opening /nodebb-users?uids=14 directly.
  router.get("/nodebb-users", handleUsersBatch);
  router.get("/nodebb-user/:uid", handleSingleUser);
};

plugin.getConfig = async function getConfig(config) {
  config.cpWukongTopicChat = {
    enabled: parseBoolean(process.env.CP_WK_TOPIC_CHAT_ENABLED, true),
    categoryId: parseInteger(process.env.CP_WK_CATEGORY_ID || process.env.CP_WK_BOARD_ID, 7),
    localeFallback: process.env.CP_WK_LOCALE_FALLBACK || "en-GB",
    pluginId: "nodebb-plugin-cp-wukong-topic-chat",
    userBatchUrl: "/nodebb-users",
    userCacheTtlMs: cacheTtlMs()
  };

  return config;
};

module.exports = plugin;
