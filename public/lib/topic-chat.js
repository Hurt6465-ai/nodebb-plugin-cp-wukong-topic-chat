/*
 * CP NodeBB Topic WuKong Chat - CID 7 - v31-log-fix
 * 重点改动：
 * - 去掉板块排序 IIFE，不再轮询 /bridge/topic-activity。
 * - 消息列表改为增量渲染，不再 list.innerHTML 重建整个屏幕。
 * - DOM 节点复用：data-key 定位节点，data-hash 判断是否需要更新。
 * - 默认只渲染最近 140 条；上滑逐步扩容到 260 条。
 * - 保留媒体压缩、背景压缩、活动触达、批量用户资料缓存。
 * - 国旗/在线状态稳定版：批量接口优先，合并本地资料，头像资料进入增量渲染 hash。
 * - v29：消息、用户、设置、背景持久化迁移到 IndexedDB。
 * - v30：修正 SDK 锁版本：WuKongIM 服务端 v2.2.5 不是 JS SDK 版本，改为 npm wukongimjssdk@1.2.10。
 * - v31：修复 log 未定义导致 WK 连接流程中断。
 */
(function () {
  "use strict";

  var GLOBAL_KEY = "__cpTopicWukongCid7V31LogFixInited";
  if (window[GLOBAL_KEY]) return;
  window[GLOBAL_KEY] = true;

  var CONFIG = {
    targetCid: 7,
    channelType: 2,
    channelPrefix: "nbb_topic_",
    tokenUrl: "/bridge/token",
    ensureUrl: "/bridge/topic-channel/ensure",
    historyUrl: "/bridge/topic-history",
    legacyHistoryUrl: "/bridge/get-history",
    sdkVersion: "1.2.10",
    sdkUrls: [
      "https://cdn.jsdelivr.net/npm/wukongimjssdk@1.2.10/lib/wukongimjssdk.umd.js"
    ],
    historyLimit: 30,
    aiProxyUrl: "/bridge/ai/chat",
    googleProxyUrl: "/bridge/translate/google",
    uploadUrl: "/bridge/upload",
    uploadDirectFirst: true,
    presencePingUrl: "/bridge/topic-presence/ping",
    presenceUrl: "/bridge/topic-presence",
    notifyUrl: "/bridge/topic-notify",
    notifyListUrl: "/bridge/topic-notify/list",
    activityTouchUrl: "/bridge/topic-activity/touch",
    usersBatchUrl: "/nodebb-users",
    debug: false
  };

  var ROOT_ID = "cp-topic-chat-root";
  var BODY_CLASS = "cp-topic-chat-on-v20";
  var DB_NAME = "CP_TOPIC_WUKONG_CACHE_V27_PERF_STABLE";
  var DB_VERSION = 2;
  var STORE = "topics";
  var KV_STORE = "kv";
  var LS_PREFIX = "cp_topic_wk_cache_v27_perf_stable_"; // legacy localStorage key prefix, read once for migration only
  var KEY_CFG = "cp_topic_wk_cfg_v27_perf_stable";
  var KEY_BG = "cp_topic_wk_bg_v27_perf_stable";
  var KEY_USER_CACHE = "cp_topic_wk_user_cache_v31_profile";

  var MAX_CACHE = 360;
  var MAX_MEMORY = 900;
  var INITIAL_RENDER_LIMIT = 140;
  var RENDER_STEP = 80;
  var MAX_RENDER_LIMIT = 260;
  var BOTTOM_THRESHOLD = 120;
  var PENDING_TTL = 60000;

  var IMAGE_CONFIG = {
    maxSide: 1440,
    maxSizeMB: 0.45,
    quality: 0.6,
    minCompressBytes: 120 * 1024,
    useWebp: true
  };

  var VIDEO_CONFIG = {
    maxSizeThreshold: 30 * 1024 * 1024,
    maxDuration: 60,
    maxWidth: 720,
    fps: 24,
    videoBitsPerSecond: 900000,
    audioBitsPerSecond: 64000
  };

  var USER_CACHE_TTL_MS = 30 * 24 * 3600 * 1000;
  var USER_CACHE_STALE_REFRESH_MS = 12 * 3600 * 1000;

  var LANG_LIST = [
    { n: "中文", code: "zh-CN", f: "🇨🇳" },
    { n: "English", code: "en", f: "🇺🇸" },
    { n: "မြန်မာစာ", code: "my", f: "🇲🇲" },
    { n: "日本語", code: "ja", f: "🇯🇵" },
    { n: "한국어", code: "ko", f: "🇰🇷" },
    { n: "ภาษาไทย", code: "th", f: "🇹🇭" },
    { n: "Tiếng Việt", code: "vi", f: "🇻🇳" },
    { n: "Français", code: "fr", f: "🇫🇷" },
    { n: "Deutsch", code: "de", f: "🇩🇪" },
    { n: "Español", code: "es", f: "🇪🇸" },
    { n: "हिन्दी", code: "hi", f: "🇮🇳" },
    { n: "Русский", code: "ru", f: "🇷🇺" }
  ];

  var LANG_CODE_MAP = {
    "自动检测": "auto", auto: "auto",
    "中文": "zh-CN", "English": "en", "မြန်မာစာ": "my", "缅甸语": "my",
    "日本語": "ja", "한국어": "ko", "ภาษาไทย": "th", "Tiếng Việt": "vi",
    "Français": "fr", "Deutsch": "de", "Español": "es", "हिन्दी": "hi", "Русский": "ru"
  };

  var DEFAULT_TRANSLATE_PROMPT =
    '将以下消息翻译成 {{targetLang}}。\n\n' +
    '要求：\n' +
    '- 自然直译，保留原文语气、表情、链接、用户名、Markdown、换行。\n' +
    '- 不要解释，不要添加多余文字。\n' +
    '- 只输出 JSON：{"translation":"译文"}\n\n' +
    '原文语言：{{sourceLang}}\n' +
    '目标语言：{{targetLang}}\n' +
    '待翻译消息：\n"{{text}}"';

  var DEFAULT_CFG = {
    sourceLang: "中文",
    targetLang: "မြန်မာစာ",
    translateProvider: "google",
    googleEndpoint: "https://translate.googleapis.com/translate_a/single",
    sendTranslateEnabled: false,
    autoTranslateLastMsg: false,
    showQuickTranslate: true,
    voiceMaxDuration: 60,
    ai: {
      endpoint: "https://api.openai.com/v1",
      apiKey: "",
      model: "gpt-4o-mini",
      temperature: 0.2,
      translatePrompt: DEFAULT_TRANSLATE_PROMPT
    }
  };

  var DEFAULT_BG = { dataUrl: "", opacity: 0.08, blur: 0 };
  var dbPromise = null;
  var cacheTimer = null;
  var footerTimer = null;

  var state = {
    mounted: false,
    bootTimer: null,
    topic: null,
    channelId: "",
    uid: "",
    username: "我",
    token: "",
    tokenData: null,
    wkReady: false,
    connectStarted: false,
    loadingHistory: false,
    hasNoMore: false,
    messages: [],
    msgMap: {},
    newestSeq: 0,
    oldestSeq: 0,
    renderPending: false,
    pendingRenderMode: "",
    renderLimit: INITIAL_RENDER_LIMIT,
    stickToBottom: true,
    unread: 0,
    sendLock: false,
    cfg: null,
    bg: null,
    aiCache: {},
    aiCacheKeys: [],
    translateInflight: {},
    pendingMentionUids: [],
    pendingMentionMap: {},
    mentionNotices: [],
    notifyVersion: 0,
    notifyPollTimer: null,
    presenceTimer: null,
    presencePollTimer: null,
    userCache: {},
    userBatchPending: {},
    userBatchTimer: null,
    userBatchInflight: {},
    mergedUserCache: {},
    avatarHashCache: {},
    uiAbort: null,
    offlineInflight: false,
    lastActivityTouch: {},
    contextMsg: null,
    quoteTarget: null,
    audio: new Audio(),
    currentAudioEl: null,
    lazyObserver: null,
    encodeSupport: {},
    previewOpen: false,
    rec: {
      mediaRecorder: null,
      stream: null,
      mimeType: "",
      chunks: [],
      timer: null,
      sec: 0,
      paused: false,
      shouldSend: false
    }
  };

  function warn(scope, err) {
    try { console.warn("[cp-topic-wukong-v31-log-fix][" + scope + "]", err); } catch (_) {}
  }

  function log(scope, data) {
    if (!CONFIG.debug) return;
    try { console.log("[cp-topic-wukong-v31-log-fix][" + scope + "]", data || ""); } catch (_) {}
  }

  function byId(id) { return document.getElementById(id); }
  function now() { return Date.now(); }
  function esc(str) {
    return String(str == null ? "" : str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }
  function escAttr(str) { return esc(str).replace(/"/g, "&quot;"); }
  function normalizeText(str) { return String(str == null ? "" : str).replace(/\s+/g, " ").trim().slice(0, 800); }
  function cloneJSON(obj) { return JSON.parse(JSON.stringify(obj || {})); }
  function mergeDeep(base, extra) {
    extra = extra || {};
    Object.keys(extra).forEach(function (k) {
      if (extra[k] && typeof extra[k] === "object" && !Array.isArray(extra[k]) && base[k] && typeof base[k] === "object") mergeDeep(base[k], extra[k]);
      else base[k] = extra[k];
    });
    return base;
  }
  async function loadJSON(key, fallback) {
    var base = cloneJSON(fallback);
    try {
      var stored = await idbGetKV(key);
      if (stored !== undefined && stored !== null) {
        return mergeDeep(base, typeof stored === "string" ? JSON.parse(stored) : cloneJSON(stored));
      }
      // One-time legacy migration from old localStorage builds. After migration, remove the key.
      var raw = null;
      try { raw = localStorage.getItem(key); } catch (_) {}
      if (raw) {
        var parsed = JSON.parse(raw);
        await idbSetKV(key, parsed);
        try { localStorage.removeItem(key); } catch (_) {}
        return mergeDeep(base, parsed);
      }
    } catch (e) {
      warn("load-json-idb", e);
    }
    return base;
  }
  function saveJSON(key, val) {
    idbSetKV(key, cloneJSON(val)).catch(function (e) { warn("save-json-idb", e); });
  }
  function safeCssColor(v) {
    v = String(v || "").trim();
    if (/^#[0-9a-f]{3,8}$/i.test(v)) return v;
    if (/^rgba?\(\s*[\d.\s,%]+\)$/i.test(v)) return v;
    if (/^hsla?\(\s*[\d.\s,%]+\)$/i.test(v)) return v;
    return "#72a5f2";
  }
  function csrfToken() {
    try { return (window.config && (config.csrf_token || config.csrfToken)) || ""; } catch (_) { return ""; }
  }
  function bridgePost(url, body, timeout) {
    return fetchWithTimeout(url, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken() },
      body: JSON.stringify(body || {})
    }, timeout || 12000);
  }
  function normalizeConfig(cfg) {
    cfg = mergeDeep(cloneJSON(DEFAULT_CFG), cfg || {});
    if (cfg.translateProvider !== "ai" && cfg.translateProvider !== "google") cfg.translateProvider = "google";
    cfg.ai = mergeDeep(cloneJSON(DEFAULT_CFG.ai), cfg.ai || {});
    if (!cfg.ai.translatePrompt) cfg.ai.translatePrompt = DEFAULT_TRANSLATE_PROMPT;
    return cfg;
  }
  function getLangCode(lang, fallback) {
    return LANG_CODE_MAP[String(lang || "").trim()] || fallback || "auto";
  }
  function getFlag(lang) {
    for (var i = 0; i < LANG_LIST.length; i++) if (LANG_LIST[i].n === lang) return LANG_LIST[i].f;
    return "🌐";
  }
  function fillTemplate(tpl, vars) {
    return String(tpl || "").replace(/{{\s*(\w+)\s*}}/g, function (_, k) {
      return vars && vars[k] != null ? String(vars[k]) : "";
    });
  }
  function formatTime(ms) {
    var d = new Date(ms || Date.now());
    var h = d.getHours();
    var suffix = h >= 12 ? "PM" : "AM";
    var hour12 = h % 12 || 12;
    return String(hour12) + ":" + String(d.getMinutes()).padStart(2, "0") + " " + suffix;
  }
  function formatDayLabel(ms) {
    var d = new Date(ms || Date.now());
    var n = new Date();
    var today = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
    var day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    var diff = Math.floor((today - day) / 86400000);
    if (diff === 0) return "今天";
    if (diff === 1) return "昨天";
    if (diff === 2) return "前天";
    if (d.getFullYear() === n.getFullYear()) return (d.getMonth() + 1) + "月" + d.getDate() + "日";
    return d.getFullYear() + "年" + (d.getMonth() + 1) + "月" + d.getDate() + "日";
  }
  function formatTimeDivider(ms) { return formatDayLabel(ms) + " " + formatTime(ms); }
  function formatDuration(sec) {
    sec = Math.max(0, Math.round(Number(sec || 0)));
    return Math.floor(sec / 60) + ":" + String(sec % 60).padStart(2, "0");
  }

  function getCurrentCid() {
    try {
      if (window.ajaxify && ajaxify.data) {
        if (ajaxify.data.cid != null) return Number(ajaxify.data.cid);
        if (ajaxify.data.category && ajaxify.data.category.cid != null) return Number(ajaxify.data.category.cid);
        if (ajaxify.data.topic && ajaxify.data.topic.cid != null) return Number(ajaxify.data.topic.cid);
      }
    } catch (_) {}
    var el = document.querySelector('.breadcrumb a[href*="/category/"], .breadcrumbs a[href*="/category/"], a[href*="/category/"]');
    if (el) {
      var m = String(el.getAttribute("href") || "").match(/\/category\/(\d+)/);
      if (m) return Number(m[1]);
    }
    return 0;
  }
  function getTopicInfo() {
    var data = (window.ajaxify && ajaxify.data) || {};
    var topic = data.topic || data || {};
    var tid = topic.tid || data.tid || "";
    if (!tid) {
      var mm = location.pathname.match(/\/topic\/(\d+)/);
      if (mm) tid = mm[1];
    }
    var title = topic.title || data.title || "";
    if (!title) {
      var te = document.querySelector('[component="topic/title"], h1, .topic-title');
      title = te ? te.textContent.trim() : "话题聊天室";
    }
    return { tid: String(tid || ""), cid: Number(getCurrentCid() || 0), title: String(title || "话题聊天室"), url: location.pathname + location.search };
  }
  function isTargetTopic() {
    return document.body && document.body.classList.contains("page-topic") && getCurrentCid() === CONFIG.targetCid && !!getTopicInfo().tid;
  }
  function channelIdOf(topic) { return CONFIG.channelPrefix + String(topic.tid); }
  function getMyName() {
    try { return (window.app && app.user && (app.user.displayname || app.user.fullname || app.user.username)) || state.username || "我"; }
    catch (_) { return state.username || "我"; }
  }

  function getAjaxUserByUid(uid) {
    uid = String(uid || "");
    try {
      var pools = [];
      if (window.ajaxify && ajaxify.data) {
        if (ajaxify.data.loggedInUser) pools.push(ajaxify.data.loggedInUser);
        if (ajaxify.data.author) pools.push(ajaxify.data.author);
        if (ajaxify.data.mainPost && ajaxify.data.mainPost.user) pools.push(ajaxify.data.mainPost.user);
        if (Array.isArray(ajaxify.data.users)) pools = pools.concat(ajaxify.data.users);
        if (ajaxify.data.posts && Array.isArray(ajaxify.data.posts)) ajaxify.data.posts.forEach(function (p) { if (p && p.user) pools.push(p.user); });
      }
      if (String(uid) === String(state.uid) && window.app && app.user) pools.push(app.user);
      for (var i = 0; i < pools.length; i++) if (pools[i] && String(pools[i].uid) === uid) return pools[i];
    } catch (_) {}
    return null;
  }
  function displayNameFromUser(u, fallback) {
    if (!u) return fallback || "用户";
    return u.displayname || u.fullname || u.name || u.username || fallback || (u.uid ? "用户" + u.uid : "用户");
  }
  function normalizeUserField(u, keys) {
    u = u || {};
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (u[k] !== undefined && u[k] !== null && String(u[k]).trim() !== "") return u[k];
    }
    return "";
  }
  function normalizeUserProfile(raw, uid) {
    raw = raw || {};
    uid = String(uid || raw.uid || "");
    return {
      loaded: true,
      uid: uid,
      username: normalizeUserField(raw, ["username", "userslug", "name"]) || (uid ? "用户" + uid : "用户"),
      displayname: displayNameFromUser(raw, uid ? "用户" + uid : "用户"),
      picture: normalizeUserField(raw, ["picture", "uploadedpicture", "uploadedPicture", "avatar"]),
      icontext: normalizeUserField(raw, ["icontext", "icon:text", "iconText"]),
      iconbgColor: normalizeUserField(raw, ["iconbgColor", "icon:bgColor", "iconBgColor"]) || "#72a5f2",
      userslug: normalizeUserField(raw, ["userslug", "slug", "username"]),
      status: normalizeUserField(raw, ["status", "userStatus", "presence", "onlineStatus"]),
      language_flag: normalizeUserField(raw, ["language_flag", "languageFlag", "countryFlag", "country_flag", "flag", "nationality", "country", "localeCountry"]),
      online: userIsOnline(raw),
      profileVersion: Number(raw.profileVersion || raw.version || 0) || 0,
      cacheAt: Number(raw.cacheAt || 0) || 0,
      cacheExpiresAt: Number(raw.cacheExpiresAt || 0) || 0,
      remoteResolved: !!raw.remoteResolved
    };
  }
  function userHasProfileBadges(u) {
    return !!(u && (u.language_flag || u.languageFlag || u.countryFlag || u.country_flag || u.flag || u.nationality || u.country || u.status || u.online === true || u.isOnline === true));
  }
  function mergeUserObjects(local, cached) {
    local = local || {};
    cached = cached || {};
    var out = mergeDeep(mergeDeep({}, local), cached);
    // 头像/昵称优先使用 NodeBB 当前页面最新值；国旗/在线状态优先使用批量接口/缓存，因为 topic 内嵌 user 经常缺自定义字段。
    if (local.picture || local.uploadedpicture) out.picture = local.picture || local.uploadedpicture;
    if (local.username) out.username = local.username;
    if (local.displayname || local.fullname || local.name) out.displayname = local.displayname || local.fullname || local.name;
    if (local.userslug) out.userslug = local.userslug;
    if (local.icontext || local["icon:text"]) out.icontext = local.icontext || local["icon:text"];
    if (local.iconbgColor || local["icon:bgColor"]) out.iconbgColor = local.iconbgColor || local["icon:bgColor"];
    if (!userHasProfileBadges(cached) && userHasProfileBadges(local)) {
      out.language_flag = normalizeUserField(local, ["language_flag", "languageFlag", "countryFlag", "country_flag", "flag", "nationality", "country", "localeCountry"]);
      out.status = normalizeUserField(local, ["status", "userStatus", "presence", "onlineStatus"]);
      out.online = userIsOnline(local);
    }
    return out;
  }
  function userProfileUiKey(u) {
    u = u || {};
    return [
      u.picture || u.uploadedpicture || "",
      u.userslug || u.slug || u.username || "",
      u.displayname || u.fullname || u.name || u.username || "",
      u.icontext || u["icon:text"] || "",
      u.iconbgColor || u["icon:bgColor"] || "",
      u.language_flag || u.languageFlag || u.countryFlag || u.country_flag || u.flag || u.nationality || u.country || "",
      u.status || u.userStatus || u.presence || u.onlineStatus || "",
      userIsOnline(u) ? 1 : 0
    ].join("|");
  }
  function invalidateUserProfile(uid) {
    uid = String(uid || "");
    if (!uid) return;
    if (state.mergedUserCache) delete state.mergedUserCache[uid];
    if (state.avatarHashCache) delete state.avatarHashCache[uid];
  }
  function getMergedUserByUid(uid) {
    uid = String(uid || "");
    var local = getAjaxUserByUid(uid) || {};
    var cached = state.userCache[uid] || {};
    var ver = userProfileUiKey(local) + "||" + userProfileUiKey(cached) + "||" + (cached.remoteResolved ? 1 : 0);
    var memo = state.mergedUserCache && state.mergedUserCache[uid];
    if (memo && memo.ver === ver) return memo.data;
    var data = mergeUserObjects(local, cached);
    state.mergedUserCache = state.mergedUserCache || {};
    state.mergedUserCache[uid] = { ver: ver, data: data };
    return data;
  }
  function displayNameForMessage(msg) {
    if (!msg) return "用户";
    var u = getMergedUserByUid(msg.uid);
    return displayNameFromUser(u, msg.username || (msg.uid ? "用户" + msg.uid : "用户"));
  }
  function userIsOnline(u) {
    if (!u) return false;
    var s = String(u.status || u.userStatus || u.presence || u.onlineStatus || "").toLowerCase();
    if (s === "online") return true;
    if (s === "offline" || s === "invisible" || s === "away") return false;
    return u.online === true || u.isOnline === true;
  }
  function flagEmojiFromLanguageFlag(v) {
    v = String(v || "").trim();
    if (!v) return "";
    var lower = v.toLowerCase();
    var map = {
      "缅甸": "🇲🇲", "缅甸语": "🇲🇲", "မြန်မာ": "🇲🇲", "မြန်မာစာ": "🇲🇲", "myanmar": "🇲🇲", "burma": "🇲🇲", "my": "🇲🇲", "my-mm": "🇲🇲",
      "中国": "🇨🇳", "中文": "🇨🇳", "汉语": "🇨🇳", "zh": "🇨🇳", "zh-cn": "🇨🇳", "china": "🇨🇳",
      "台湾": "🇹🇼", "繁体中文": "🇹🇼", "zh-tw": "🇹🇼", "taiwan": "🇹🇼",
      "美国": "🇺🇸", "英语": "🇺🇸", "english": "🇺🇸", "en": "🇺🇸", "en-us": "🇺🇸", "usa": "🇺🇸", "united states": "🇺🇸",
      "日本": "🇯🇵", "日语": "🇯🇵", "日本語": "🇯🇵", "ja": "🇯🇵", "japan": "🇯🇵",
      "韩国": "🇰🇷", "韩语": "🇰🇷", "한국어": "🇰🇷", "ko": "🇰🇷", "korea": "🇰🇷",
      "泰国": "🇹🇭", "泰语": "🇹🇭", "ภาษาไทย": "🇹🇭", "th": "🇹🇭", "thailand": "🇹🇭",
      "越南": "🇻🇳", "越南语": "🇻🇳", "tiếng việt": "🇻🇳", "vi": "🇻🇳", "vietnam": "🇻🇳",
      "印度": "🇮🇳", "印地语": "🇮🇳", "हिन्दी": "🇮🇳", "hi": "🇮🇳", "india": "🇮🇳",
      "俄罗斯": "🇷🇺", "俄语": "🇷🇺", "русский": "🇷🇺", "ru": "🇷🇺", "russia": "🇷🇺",
      "法国": "🇫🇷", "法语": "🇫🇷", "français": "🇫🇷", "fr": "🇫🇷", "france": "🇫🇷",
      "德国": "🇩🇪", "德语": "🇩🇪", "deutsch": "🇩🇪", "de": "🇩🇪", "germany": "🇩🇪",
      "西班牙": "🇪🇸", "西班牙语": "🇪🇸", "español": "🇪🇸", "es": "🇪🇸", "spain": "🇪🇸"
    };
    if (map[v]) return map[v];
    if (map[lower]) return map[lower];
    // 已经是 emoji 国旗时直接返回前两个区域指示符。
    if (/^[\uD83C][\uDDE6-\uDDFF]/.test(v)) return v.slice(0, 4);
    return "";
  }
  function avatarProfileHash(uid) {
    uid = String(uid || "");
    var u = getMergedUserByUid(uid);
    var hash = [
      u.picture || "",
      u.userslug || "",
      u.displayname || u.fullname || u.username || "",
      u.icontext || u["icon:text"] || "",
      u.iconbgColor || u["icon:bgColor"] || "",
      u.language_flag || u.languageFlag || u.countryFlag || u.country_flag || u.flag || u.nationality || u.country || "",
      u.status || u.userStatus || u.presence || u.onlineStatus || "",
      userIsOnline(u) ? 1 : 0
    ].join("|");
    state.avatarHashCache = state.avatarHashCache || {};
    state.avatarHashCache[uid] = hash;
    return hash;
  }
  function getAvatarHtml(uid, username) {
    uid = String(uid || "");
    var u = getMergedUserByUid(uid);
    if (u) username = displayNameFromUser(u, username || (uid ? "用户" + uid : "用户"));
    var pic = u.picture || "";
    var text = (u.icontext || u["icon:text"]) || String(username || uid || "?").charAt(0).toUpperCase();
    var bg = safeCssColor((u.iconbgColor || u["icon:bgColor"]) || "#72a5f2");
    var core = pic ? '<img class="avatar" src="' + escAttr(pic) + '" />' : '<div class="avatar cp-avatar-fallback" style="background:' + escAttr(bg) + '">' + esc(text) + '</div>';
    var flag = flagEmojiFromLanguageFlag(u.language_flag || u.languageFlag || u.countryFlag || u.country_flag || u.flag || u.nationality || u.country || "");
    var flagHtml = flag ? '<span class="cp-avatar-flag" aria-hidden="true">' + esc(flag) + '</span>' : '';
    var onlineHtml = userIsOnline(u) ? '<span class="cp-avatar-online" aria-label="在线"></span>' : '';
    return '<span class="cp-avatar-stack">' + core + flagHtml + onlineHtml + '</span>';
  }
  function getUserProfileHref(uid, username) {
    uid = String(uid || "");
    var u = getMergedUserByUid(uid);
    var slug = (u && (u.userslug || u.slug || u.username)) || username || (u && u.displayname) || "";
    if (!slug && String(uid) === String(state.uid) && window.app && app.user) slug = app.user.userslug || app.user.username || "";
    return slug ? ("/user/" + encodeURIComponent(String(slug)) + "/topics") : "#";
  }

  async function loadUserCacheLocal() {
    try {
      var data = await idbGetKV(KEY_USER_CACHE);
      if (!data) {
        // One-time legacy migration from old localStorage profile cache.
        var raw = null;
        try { raw = localStorage.getItem(KEY_USER_CACHE); } catch (_) {}
        if (raw) {
          data = JSON.parse(raw);
          await idbSetKV(KEY_USER_CACHE, data);
          try { localStorage.removeItem(KEY_USER_CACHE); } catch (_) {}
        }
      }
      if (!data || Number(data.version || 0) < 31) return;
      var users = data && data.users ? data.users : {};
      var n = Date.now();
      Object.keys(users).forEach(function (uid) {
        var u = users[uid];
        if (u && (!u.cacheExpiresAt || Number(u.cacheExpiresAt) > n)) state.userCache[String(uid)] = u;
      });
    } catch (e) { warn("load-user-cache-idb", e); }
  }
  function saveUserCacheLocalSoon() {
    clearTimeout(state.userCacheTimer);
    state.userCacheTimer = setTimeout(function () {
      idbSetKV(KEY_USER_CACHE, { version: 31, ts: Date.now(), users: state.userCache || {} }).catch(function (e) { warn("save-user-cache-idb", e); });
    }, 1000);
  }
  function applyResolvedUser(uid, user, opts) {
    opts = opts || {};
    uid = String(uid || (user && user.uid) || "");
    if (!uid || !user) return false;
    var before = avatarProfileHash(uid);
    var prev = state.userCache[uid] || {};
    var normalized = normalizeUserProfile(user, uid);
    var merged = mergeUserObjects(prev, normalized);
    merged.loaded = true;
    merged.uid = uid;
    merged.remoteResolved = !!(opts.remote || prev.remoteResolved || normalized.remoteResolved);
    if (opts.remote) {
      merged.cacheAt = Date.now();
      merged.cacheExpiresAt = Date.now() + USER_CACHE_TTL_MS;
    } else {
      merged.cacheAt = Number(prev.cacheAt || 0) || 0;
      merged.cacheExpiresAt = Number(prev.cacheExpiresAt || 0) || 0;
    }
    var stableVersion = userProfileUiKey(merged);
    merged.profileVersion = stableVersion;
    state.userCache[uid] = merged;
    invalidateUserProfile(uid);
    return before !== avatarProfileHash(uid);
  }
  function queueResolveUsers(uids, force) {
    uids = Array.isArray(uids) ? uids : [uids];
    var added = false;
    uids.forEach(function (uid) {
      uid = String(uid || "").trim();
      if (!uid) return;
      var local = getAjaxUserByUid(uid);
      var localChanged = false;
      if (local) localChanged = applyResolvedUser(uid, local, { remote: false });
      var cached = state.userCache[uid];
      var hasFreshRemote = cached && cached.loaded && cached.remoteResolved && cached.cacheAt && (Date.now() - Number(cached.cacheAt)) < USER_CACHE_STALE_REFRESH_MS;
      if (localChanged) queueRender("keep");
      if (!force && hasFreshRemote) return;
      state.userBatchPending[uid] = true;
      added = true;
    });
    if (!added) { saveUserCacheLocalSoon(); return; }
    clearTimeout(state.userBatchTimer);
    state.userBatchTimer = setTimeout(fetchPendingUsersBatch, 180);
  }
  function queueResolveUsersFromMessages(list) {
    var out = [], seen = {};
    (list || []).forEach(function (m) {
      var uid = String(m && m.uid || "").trim();
      if (uid && !m.mine && !seen[uid]) { seen[uid] = true; out.push(uid); }
      var qUid = String(m && m.quoteUid || "").trim();
      if (qUid && !seen[qUid]) { seen[qUid] = true; out.push(qUid); }
    });
    queueResolveUsers(out);
  }
  async function fetchPendingUsersBatch() {
    var pending = Object.keys(state.userBatchPending || {}).slice(0, 80);
    pending.forEach(function (uid) { delete state.userBatchPending[uid]; });
    if (!pending.length) return;
    pending = pending.sort();
    var inflightKey = pending.join(",");
    state.userBatchInflight = state.userBatchInflight || {};
    if (state.userBatchInflight[inflightKey]) return state.userBatchInflight[inflightKey];
    state.userBatchInflight[inflightKey] = (async function () {
      var baseUrl = String(((window.config && window.config.cpWukongTopicChat) || {}).userBatchUrl || CONFIG.usersBatchUrl || "/nodebb-users");
      var urls = [];
      function addUrl(u) { if (u && urls.indexOf(u) < 0) urls.push(u); }
      addUrl(baseUrl);
      addUrl("/nodebb-users");
      if (baseUrl.indexOf("/bridge/") !== 0) addUrl("/bridge" + baseUrl);
      addUrl("/bridge/nodebb-users");
      try {
        var data = null;
        var lastErr = null;
        for (var i = 0; i < urls.length; i++) {
          try {
            var res = await fetchWithTimeout(urls[i] + "?uids=" + encodeURIComponent(pending.join(",")), { credentials: "include", cache: "no-store" }, 12000);
            if (!res.ok) { lastErr = new Error("user batch " + res.status + " @ " + urls[i]); continue; }
            data = await res.json();
            break;
          } catch (e) { lastErr = e; }
        }
        if (!data) throw lastErr || new Error("user batch empty");
        var changed = false;
        var returned = {};
        (Array.isArray(data && data.users) ? data.users : []).forEach(function (u) {
          if (!u || !u.uid) return;
          returned[String(u.uid)] = true;
          if (applyResolvedUser(u.uid, u, { remote: true })) changed = true;
        });
        // 后端没有返回的 uid 也打上 remoteResolved，避免每次进房间都重复请求。
        pending.forEach(function (uid) {
          if (returned[uid]) return;
          if (!state.userCache[uid]) state.userCache[uid] = { loaded: false, uid: uid };
          state.userCache[uid].remoteResolved = true;
          state.userCache[uid].cacheAt = Date.now();
          state.userCache[uid].cacheExpiresAt = Date.now() + USER_CACHE_TTL_MS;
        });
        saveUserCacheLocalSoon();
        if (changed) queueRender("keep");
      } catch (e) {
        warn("resolve-users", e);
        pending.forEach(function (uid) {
          if (!state.userCache[uid]) state.userCache[uid] = { loaded: false, uid: uid };
          state.userCache[uid].remoteResolved = false;
          state.userCache[uid].cacheAt = Date.now() - USER_CACHE_STALE_REFRESH_MS + 30000;
        });
        saveUserCacheLocalSoon();
      } finally {
        delete state.userBatchInflight[inflightKey];
      }
    })();
    return state.userBatchInflight[inflightKey];
  }

  function decodePayload(m) {
    if (!m) return {};
    var raw = m.payload != null ? m.payload : (m.content != null ? m.content : m.messageContent);
    if (raw && typeof raw === "object") return raw;
    if (raw == null) return {};
    raw = String(raw || "");
    if (!raw) return {};
    try { return JSON.parse(raw); } catch (_) {}
    try {
      return JSON.parse(decodeURIComponent(atob(raw).split("").map(function (c) {
        return "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2);
      }).join("")));
    } catch (_) {}
    return { text: raw, content: raw };
  }
  function getMsgChannelId(m) {
    return String(m && (m.channelID || m.channelId || m.channel_id || (m.channel && (m.channel.channelID || m.channel.channelId || m.channel.channel_id))) || "");
  }
  function getMsgChannelType(m) {
    return Number(m && (m.channelType || m.channel_type || (m.channel && (m.channel.channelType || m.channel.channel_type))) || 0);
  }
  function sameTopicChannel(m) {
    var id = getMsgChannelId(m);
    var type = getMsgChannelType(m);
    return id === state.channelId && (!type || type === CONFIG.channelType);
  }
  function extractMsgId(m, payload) {
    return String(
      m.message_id || m.messageID || m.messageId ||
      m.client_msg_no || m.clientMsgNo || m.client_msgNo ||
      (payload && (payload.client_msg_no || payload.clientMsgNo || payload.message_id)) || ""
    );
  }
  function detectMessageKind(text, payload) {
    text = String(text || "").trim();
    payload = payload || {};
    var kind = payload.cpType || payload.msgType || payload.type || "text";
    var mediaUrl = payload.mediaUrl || payload.url || payload.src || payload.href || "";
    var audioUrl = payload.audioUrl || payload.voiceUrl || "";
    var duration = payload.duration || payload.time || "";
    var m;
    if ((m = text.match(/^!\[[^\]]*\]\(([^)]+)\)$/)) || (m = text.match(/^\[图片\]\(([^)]+)\)$/))) {
      kind = "image"; mediaUrl = m[1]; text = "[图片]";
    } else if ((m = text.match(/^\[视频\]\(([^)]+)\)$/))) {
      kind = "video"; mediaUrl = m[1]; text = "[视频]";
    } else if ((m = text.match(/^\[语音消息\]\(([^)]+)\)$/)) || (m = text.match(/^\[语音\]\(([^)]+)\)$/))) {
      kind = "voice"; audioUrl = m[1]; text = "[语音]";
    } else if (/\.(png|jpe?g|gif|webp|bmp)(?:\?|#|$)/i.test(text) && !/\s/.test(text)) {
      kind = "image"; mediaUrl = text; text = "[图片]";
    } else if (/\.(mp4|mov|m4v|webm)(?:\?|#|$)/i.test(text) && !/\s/.test(text)) {
      kind = "video"; mediaUrl = text; text = "[视频]";
    } else if (/\.(mp3|m4a|wav|webm|ogg)(?:\?|#|$)/i.test(text) && !/\s/.test(text)) {
      kind = "voice"; audioUrl = text; text = "[语音]";
    }
    if (kind === 1 || kind === "1") kind = "text";
    if (!mediaUrl && payload.image) { kind = "image"; mediaUrl = payload.image; text = "[图片]"; }
    if (!mediaUrl && payload.video) { kind = "video"; mediaUrl = payload.video; text = "[视频]"; }
    if (!audioUrl && payload.voice) { kind = "voice"; audioUrl = payload.voice; text = "[语音]"; }
    if (kind === "voice" && !audioUrl && mediaUrl) audioUrl = mediaUrl;
    return { kind: String(kind || "text"), text: text, mediaUrl: mediaUrl, audioUrl: audioUrl, duration: duration };
  }
  function normalizeMentionList(payload) {
    var raw = (payload || {}).mention_uids || payload.mentionUids || payload.at_uids || payload.atUsers || payload.at || payload.mentions || [];
    if (typeof raw === "string") raw = raw.split(/[,\s]+/);
    if (!Array.isArray(raw)) raw = [];
    var out = [];
    raw.forEach(function (x) {
      var uid = x && typeof x === "object" ? (x.uid || x.userId || x.user_id || x.id || x.value || "") : x;
      uid = String(uid || "").trim();
      if (uid && out.indexOf(uid) < 0) out.push(uid);
    });
    return out;
  }
  function toPlayableUrl(url) {
    url = String(url || "").trim();
    if (!url) return "";
    if (/^data:|^blob:/i.test(url)) return url;
    if (/^\/\//.test(url)) return location.protocol + url;
    if (/^https?:\/\//i.test(url)) return url;
    if (url.charAt(0) !== "/") url = "/" + url;
    return url;
  }
  function getQuotePreviewText(msg) {
    if (!msg) return "";
    if (msg.type === "image") return "[图片]";
    if (msg.type === "video") return "[视频]";
    if (msg.type === "voice") return "[语音]";
    return String(msg.text || msg.serverText || "").slice(0, 220);
  }
  function getMsgByIdLocal(id) {
    return state.msgMap[String(id || "")] || null;
  }
  function isFakeQuoteText(text) {
    text = String(text || "").trim();
    return !text || text === "[被引用的消息]" || text === "被引用的消息" || text === "[引用消息]" || text === "引用消息";
  }
  function sanitizeQuoteFields(msg) {
    if (!msg) return msg;
    msg.quote = String(msg.quote || "").trim();
    msg.quoteMsgId = String(msg.quoteMsgId || "").trim();
    msg.quoteUid = String(msg.quoteUid || "").trim();
    msg.quoteUser = String(msg.quoteUser || "").trim();
    msg.quoteType = String(msg.quoteType || "").trim();
    msg.quoteMediaUrl = String(msg.quoteMediaUrl || "").trim();
    msg.quoteAudioUrl = String(msg.quoteAudioUrl || "").trim();
    if (isFakeQuoteText(msg.quote)) msg.quote = "";
    if (!msg.quote && !msg.quoteMediaUrl && !msg.quoteAudioUrl && msg.quoteMsgId) {
      var ref = getMsgByIdLocal(msg.quoteMsgId);
      if (ref) {
        msg.quote = getQuotePreviewText(ref);
        msg.quoteUser = msg.quoteUser || displayNameForMessage(ref);
        msg.quoteUid = msg.quoteUid || String(ref.uid || "");
        msg.quoteType = msg.quoteType || ref.type || "text";
      }
    }
    if (!msg.quote && !msg.quoteMediaUrl && !msg.quoteAudioUrl) msg.quoteType = "";
    return msg;
  }
  function getMentionNoticeType(msg) {
    if (!msg || msg.mine) return "";
    if (String(msg.quoteUid || "") && String(msg.quoteUid || "") === String(state.uid)) return "reply";
    var qMsg = getMsgByIdLocal(msg.quoteMsgId || "");
    if (qMsg && qMsg.mine) return "reply";
    var arr = (msg.mentionUids || []).map(String);
    if (arr.indexOf(String(state.uid)) >= 0) return "mention";
    var myName = String(state.username || getMyName() || "").replace(/\s+/g, "");
    if (myName && String(msg.text || "").replace(/\s+/g, "").indexOf("@" + myName) >= 0) return "mention";
    return "";
  }
  function msgFromWk(m, forceMine) {
    var payload = decodePayload(m);
    var fromUid = String(m.from_uid || m.fromUID || m.fromUid || payload.from_uid || payload.fromUID || "");
    var mine = forceMine != null ? !!forceMine : (fromUid && String(fromUid) === String(state.uid));
    var serverText = payload.text || payload.content || payload.message || "[暂不支持的消息]";
    var parsedServer = detectMessageKind(serverText, payload);
    var displayText = mine && payload.originalText ? payload.originalText : parsedServer.text;
    var parsedDisplay = detectMessageKind(displayText, payload);
    var id = extractMsgId(m, payload);
    var seq = Number(m.message_seq || m.messageSeq || m.message_seq_no || 0);
    var ts = Number(m.timestamp || m.clientTimestamp || payload.timestamp || 0);
    if (ts && ts < 1000000000000) ts = ts * 1000;
    if (!ts) ts = now();
    if (!id) id = "wk_" + (seq || 0) + "_" + (fromUid || "x") + "_" + (ts || 0) + "_" + normalizeText(serverText).slice(0, 40);
    var msg = {
      id: id,
      seq: seq,
      uid: fromUid || (mine ? state.uid : ""),
      username: mine ? getMyName() : (payload.username || payload.name || (fromUid ? "用户" + fromUid : "用户")),
      mine: !!mine,
      type: parsedDisplay.kind,
      text: String(parsedDisplay.text),
      serverText: String(serverText),
      mediaUrl: parsedDisplay.mediaUrl || parsedServer.mediaUrl || "",
      audioUrl: parsedDisplay.audioUrl || parsedServer.audioUrl || "",
      durationStr: parsedDisplay.duration ? formatDuration(parsedDisplay.duration) : "",
      originalText: payload.originalText || "",
      translation: payload.translation || "",
      translationOpen: !!payload.translation,
      translationError: false,
      ts: ts,
      sending: false,
      failed: false,
      local: false,
      wkMsg: m || null,
      quote: payload.quote_text || payload.quoteText || payload.quote || payload.replyText || payload.replyPreview || "",
      quoteUser: payload.quoteUser || payload.replyUser || payload.quote_from_name || payload.quoteFromName || "",
      quoteUid: payload.quote_uid || payload.quoteUid || payload.reply_to_uid || payload.replyToUid || payload.quote_from_uid || payload.quoteFromUid || "",
      quoteMsgId: payload.quote_msg_id || payload.quoteMsgId || payload.reply_to_msg_id || payload.replyToMsgId || "",
      quoteType: payload.quote_type || payload.quoteType || payload.reply_type || payload.replyType || "",
      quoteMediaUrl: payload.quote_media_url || payload.quoteMediaUrl || "",
      quoteAudioUrl: payload.quote_audio_url || payload.quoteAudioUrl || "",
      mentionUids: normalizeMentionList(payload),
      mentionMe: false,
      _ver: 1
    };
    sanitizeQuoteFields(msg);
    msg.mentionMe = getMentionNoticeType(msg) !== "";
    return msg;
  }
  function mediaKeyOf(msg) { return msg ? String(msg.audioUrl || msg.mediaUrl || "").trim() : ""; }
  function textDedupKey(msg, bucketMs) {
    bucketMs = bucketMs || 10000;
    var body = mediaKeyOf(msg) || normalizeText(msg.serverText || msg.text || "");
    return [msg.mine ? "me" : String(msg.uid || ""), msg.type || "text", body, Math.floor((msg.ts || 0) / bucketMs)].join("|");
  }
  function touchMsg(m) { if (m) m._ver = (Number(m._ver) || 0) + 1; }
  function findPendingMine(serverMsg) {
    if (!serverMsg || !serverMsg.mine) return null;
    var key = normalizeText(serverMsg.text);
    var mk = mediaKeyOf(serverMsg);
    for (var i = state.messages.length - 1; i >= 0; i--) {
      var m = state.messages[i];
      if (!m || !m.mine) continue;
      if (!(m.local || m.sending || String(m.id || "").indexOf("local_") === 0 || !m.seq)) continue;
      var same = mk ? mediaKeyOf(m) === mk : normalizeText(m.text) === key;
      if (same && Math.abs((serverMsg.ts || now()) - (m.ts || now())) < PENDING_TTL) return m;
    }
    return null;
  }
  function mergeServerIntoLocal(local, server) {
    delete state.msgMap[local.id];
    local.id = server.id || local.id;
    local.seq = server.seq || local.seq || 0;
    local.uid = server.uid || local.uid;
    local.username = server.username || local.username;
    local.ts = server.ts || local.ts;
    local.type = server.type || local.type;
    local.serverText = server.serverText || local.serverText || server.text;
    local.mediaUrl = server.mediaUrl || local.mediaUrl || "";
    local.audioUrl = server.audioUrl || local.audioUrl || "";
    local.durationStr = server.durationStr || local.durationStr || "";
    local.sending = false;
    local.failed = false;
    local.local = false;
    local.wkMsg = server.wkMsg || local.wkMsg;
    touchMsg(local);
    state.msgMap[local.id] = local;
    updateSeq(local.seq);
  }
  function updateSeq(seq) {
    seq = Number(seq || 0);
    if (!seq) return;
    if (!state.oldestSeq || seq < state.oldestSeq) state.oldestSeq = seq;
    if (seq > state.newestSeq) state.newestSeq = seq;
  }
  function addMessages(list, opts) {
    opts = opts || {};
    var changed = false;
    var touchedMessages = [];
    var seenSoft = {};
    state.messages.forEach(function (m) { if (!m.seq && !m.id) seenSoft[textDedupKey(m, 10000)] = true; });
    (list || []).forEach(function (msg) {
      if (!msg || !msg.id) return;
      sanitizeQuoteFields(msg);
      if (msg.mine) {
        var p = findPendingMine(msg);
        if (p && p.id !== msg.id) {
          mergeServerIntoLocal(p, msg);
          changed = true;
          return;
        }
      }
      if (state.msgMap[msg.id]) {
        var old = state.msgMap[msg.id];
        old.sending = false;
        old.failed = false;
        old.seq = old.seq || msg.seq;
        old.ts = msg.ts || old.ts;
        old.serverText = msg.serverText || old.serverText || msg.text;
        if (msg.translation && !old.translation) { old.translation = msg.translation; old.translationOpen = true; }
        ["quote","quoteUser","quoteUid","quoteMsgId","quoteType","quoteMediaUrl","quoteAudioUrl"].forEach(function (k) { if (msg[k] && !old[k]) old[k] = msg[k]; });
        if (msg.mentionUids && msg.mentionUids.length) old.mentionUids = msg.mentionUids;
        old.mentionMe = old.mentionMe || msg.mentionMe || getMentionNoticeType(old) !== "";
        sanitizeQuoteFields(old);
        touchMsg(old);
        updateSeq(old.seq);
        touchedMessages.push(old);
        changed = true;
        return;
      }
      if (!msg.seq && !msg.id) {
        var sk = textDedupKey(msg, 10000);
        if (seenSoft[sk]) return;
        seenSoft[sk] = true;
      }
      state.messages.push(msg);
      touchedMessages.push(msg);
      state.msgMap[msg.id] = msg;
      updateSeq(msg.seq);
      if (opts.notify !== false && !msg.mine && getMentionNoticeType(msg)) setTimeout(function () { pushMentionNotice(msg); }, 0);
      changed = true;
    });
    if (!changed) return;
    state.messages.sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); });
    if (state.messages.length > MAX_MEMORY) {
      var removed = state.messages.splice(0, state.messages.length - MAX_MEMORY);
      removed.forEach(function (m) { delete state.msgMap[m.id]; });
    }
    queueResolveUsersFromMessages(touchedMessages);
    saveCacheSoon();
    queueRender(opts.scroll || "keep");
  }

  function cacheKey() { return LS_PREFIX + state.channelId; }
  function saveCacheLocalSync() {
    // v29: no localStorage writes. Message cache persistence is IndexedDB-only.
  }
  async function loadLegacyLocalTopicCache() {
    if (!state.channelId) return null;
    try {
      var raw = localStorage.getItem(cacheKey());
      if (!raw) return null;
      var data = JSON.parse(raw);
      try { localStorage.removeItem(cacheKey()); } catch (_) {}
      return data && Array.isArray(data.messages) ? data : null;
    } catch (e) { warn("migrate-legacy-topic-cache", e); return null; }
  }
  function loadCacheLocalSync() {
    // v29: no localStorage reads during normal startup. Use loadCacheDbAndMerge().
  }
  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve) {
      if (!window.indexedDB) return resolve(null);
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "channelId" });
        if (!db.objectStoreNames.contains(KV_STORE)) db.createObjectStore(KV_STORE, { keyPath: "key" });
      };
      req.onsuccess = function (e) { resolve(e.target.result); };
      req.onerror = function () { resolve(null); };
      req.onblocked = function () { resolve(null); };
    });
    return dbPromise;
  }
  async function idbGetKV(key) {
    try {
      var db = await openDB();
      if (!db || !db.objectStoreNames.contains(KV_STORE)) return null;
      return await new Promise(function (resolve) {
        var req = db.transaction(KV_STORE, "readonly").objectStore(KV_STORE).get(String(key));
        req.onsuccess = function (e) { resolve(e.target.result ? e.target.result.value : null); };
        req.onerror = function () { resolve(null); };
      });
    } catch (e) { warn("idb-get-kv", e); return null; }
  }
  async function idbSetKV(key, value) {
    try {
      var db = await openDB();
      if (!db || !db.objectStoreNames.contains(KV_STORE)) return false;
      return await new Promise(function (resolve) {
        var req = db.transaction(KV_STORE, "readwrite").objectStore(KV_STORE).put({ key: String(key), value: value, ts: Date.now() });
        req.onsuccess = function () { resolve(true); };
        req.onerror = function () { resolve(false); };
      });
    } catch (e) { warn("idb-set-kv", e); return false; }
  }
  async function saveCacheDb() {
    try {
      var db = await openDB();
      if (!db || !state.channelId) return;
      var lite = state.messages.slice(-MAX_CACHE).map(function (m) {
        var c = {};
        Object.keys(m || {}).forEach(function (k) { if (k !== "wkMsg" && k !== "_ver") c[k] = m[k]; });
        return c;
      });
      db.transaction(STORE, "readwrite").objectStore(STORE).put({ channelId: state.channelId, messages: lite, oldestSeq: state.oldestSeq, newestSeq: state.newestSeq, ts: Date.now() });
    } catch (e) { warn("save-cache-db", e); }
  }
  async function loadCacheDbAndMerge() {
    try {
      var db = await openDB();
      var loaded = false;
      if (db && state.channelId) {
        await new Promise(function (resolve) {
          var req = db.transaction(STORE, "readonly").objectStore(STORE).get(state.channelId);
          req.onsuccess = function (e) {
            var data = e.target.result;
            if (data && Array.isArray(data.messages) && data.messages.length) {
              addMessages(data.messages, { scroll: "bottom", notify: false });
              loaded = true;
            }
            resolve();
          };
          req.onerror = function () { resolve(); };
        });
      }
      // One-time migration of legacy localStorage message cache if IDB has no topic cache yet.
      if (!loaded) {
        var legacy = await loadLegacyLocalTopicCache();
        if (legacy && Array.isArray(legacy.messages) && legacy.messages.length) {
          addMessages(legacy.messages, { scroll: "bottom", notify: false });
          state.oldestSeq = state.oldestSeq || Number(legacy.oldestSeq || 0);
          state.newestSeq = Math.max(state.newestSeq || 0, Number(legacy.newestSeq || 0));
          saveCacheDb();
        }
      }
    } catch (e) { warn("load-cache-db", e); }
  }
  function saveCacheSoon() {
    clearTimeout(cacheTimer);
    cacheTimer = setTimeout(function () {
      var idle = window.requestIdleCallback || function (fn) { setTimeout(fn, 0); };
      idle(function () { saveCacheDb(); });
    }, 1500);
  }

  function fetchWithTimeout(url, opts, ms) {
    opts = opts || {};
    ms = ms || 12000;
    var ctrl = window.AbortController ? new AbortController() : null;
    if (ctrl) opts.signal = ctrl.signal;
    var t = setTimeout(function () { try { if (ctrl) ctrl.abort(); } catch (_) {} }, ms);
    return fetch(url, opts).finally(function () { clearTimeout(t); });
  }
  async function withRetry(fn, times, scope) {
    var last;
    for (var i = 0; i <= (times || 0); i++) {
      try { return await fn(); } catch (e) {
        last = e; warn(scope || "retry", e);
        if (i < times) await new Promise(function (r) { setTimeout(r, 350 + i * 450); });
      }
    }
    throw last;
  }
  function parseJsonLoose(text) {
    text = String(text || "").trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
    try { return JSON.parse(text); } catch (_) {}
    var m = text.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch (_) {} }
    return null;
  }
  function extractAIText(data) {
    if (!data) return "";
    if (typeof data === "string") return data;
    if (data.translation) return data.translation;
    if (data.choices && data.choices[0]) {
      var c = data.choices[0];
      if (c.message && c.message.content) return c.message.content;
      if (c.text) return c.text;
    }
    return data.output_text || (data.data && typeof data.data === "string" ? data.data : "");
  }
  async function rawAIRequest(messages, ai, timeout) {
    ai = ai || state.cfg.ai || {};
    var endpoint = String(ai.endpoint || "").replace(/\/+$/, "");
    var apiKey = String(ai.apiKey || "");
    var model = String(ai.model || "gpt-4o-mini");
    if (!endpoint) throw new Error("请先填写 AI 接口 URL");
    if (!apiKey) throw new Error("请先填写 API Key，或切换为机翻");
    return await withRetry(async function () {
      var res = await fetchWithTimeout(CONFIG.aiProxyUrl, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: endpoint, apiKey: apiKey, model: model, temperature: Number(ai.temperature || 0.2), messages: messages })
      }, timeout || 12000);
      if (!res.ok) throw new Error(await res.text().catch(function(){ return "AI接口错误"; }));
      var out = extractAIText(await res.json());
      if (!out) throw new Error("AI返回为空");
      return out;
    }, 1, "ai-request");
  }
  async function translateViaGoogle(text, from, to) {
    var sl = getLangCode(from, "auto");
    var tl = getLangCode(to, "en");
    if (sl !== "auto" && sl.indexOf("-") > -1) sl = sl.split("-")[0];
    if (tl.indexOf("-") > -1) tl = tl.split("-")[0];
    return await withRetry(async function () {
      var ep = String(state.cfg.googleEndpoint || DEFAULT_CFG.googleEndpoint || "");
      var q = "client=gtx&sl=" + encodeURIComponent(sl || "auto") + "&tl=" + encodeURIComponent(tl || "en") + "&dt=t&q=" + encodeURIComponent(text);
      var res = ep ? await fetchWithTimeout(ep + (ep.indexOf("?") > -1 ? "&" : "?") + q, { cache: "force-cache" }, 7000) : null;
      if ((!res || !res.ok) && CONFIG.googleProxyUrl) res = await fetchWithTimeout(CONFIG.googleProxyUrl + "?sl=" + encodeURIComponent(sl || "auto") + "&tl=" + encodeURIComponent(tl || "en") + "&q=" + encodeURIComponent(text), { credentials: "include", cache: "force-cache" }, 7000);
      if (!res || !res.ok) throw new Error("机翻失败");
      var data = await res.json();
      if (data && typeof data.translation === "string") return data.translation.trim();
      var parts = Array.isArray(data && data[0]) ? data[0] : [];
      return parts.map(function (item) { return item && item[0] ? item[0] : ""; }).join("").trim();
    }, 1, "google-translate");
  }
  async function translateViaAI(text, from, to) {
    var prompt = fillTemplate(state.cfg.ai.translatePrompt || DEFAULT_TRANSLATE_PROMPT, { text: text, peerMessage: text, sourceLang: from || "自动检测", targetLang: to || "中文", myLang: to || "中文" });
    var raw = await rawAIRequest([{ role: "system", content: "你是极速聊天翻译器。必须只输出可解析 JSON。" }, { role: "user", content: prompt }], state.cfg.ai, 12000);
    var json = parseJsonLoose(raw);
    return (json && typeof json.translation === "string" ? json.translation : raw).trim();
  }
  async function translateByProvider(text, from, to, provider) {
    provider = provider || state.cfg.translateProvider || "google";
    return provider === "ai" ? await translateViaAI(text, from, to) : await translateViaGoogle(text, from, to);
  }
  function cacheGet(k) {
    var c = state.aiCache[k];
    return c && c.expiresAt > Date.now() ? c.value : null;
  }
  function cacheSet(k, v, ttl) {
    state.aiCache[k] = { value: v, expiresAt: Date.now() + (ttl || 3600000) };
    state.aiCacheKeys.push(k);
    if (state.aiCacheKeys.length > 180) delete state.aiCache[state.aiCacheKeys.shift()];
  }
  async function translateMessage(msg, force) {
    if (!msg || msg.sending || msg.type !== "text") return;
    var fromLang = msg.mine ? state.cfg.sourceLang : state.cfg.targetLang;
    var toLang = msg.mine ? state.cfg.targetLang : state.cfg.sourceLang;
    var ck = ["msg", state.cfg.translateProvider, fromLang, toLang, normalizeText(msg.serverText || msg.text)].join("|");
    if (!force && cacheGet(ck)) {
      msg.translation = cacheGet(ck); msg.translationOpen = true; msg.translationError = false; touchMsg(msg); queueRender("keep"); return;
    }
    if (state.translateInflight[msg.id]) return;
    state.translateInflight[msg.id] = true;
    msg.translation = "翻译中..."; msg.translationOpen = true; msg.translationError = false; touchMsg(msg); queueRender("keep");
    try {
      msg.translation = await translateByProvider(msg.serverText || msg.text, fromLang, toLang);
      msg.translationError = false; cacheSet(ck, msg.translation);
    } catch (e) {
      msg.translation = "翻译失败：" + String(e.message || e).slice(0, 120); msg.translationError = true; warn("translate-message", e);
    } finally {
      delete state.translateInflight[msg.id]; touchMsg(msg); saveCacheSoon(); queueRender("keep");
    }
  }
  function maybeAutoTranslateLatest(msg) {
    if (state.cfg && state.cfg.autoTranslateLastMsg && msg && !msg.mine && !msg.sending && msg.type === "text") setTimeout(function () { translateMessage(msg, false); }, 50);
  }

  function buildLangOptions(selected) {
    return LANG_LIST.map(function (x) {
      return '<option value="' + escAttr(x.n) + '"' + (x.n === selected ? ' selected' : '') + '>' + esc(x.f + ' ' + x.n) + '</option>';
    }).join("");
  }
  function openLangPanel(which) {
    state.pickingLangFor = which;
    var mask = byId("cp-topic-lang-mask"), grid = byId("cp-topic-lang-grid"), title = byId("cp-topic-lang-title");
    if (!mask || !grid) return;
    var cur = which === "source" ? state.cfg.sourceLang : state.cfg.targetLang;
    if (title) title.textContent = which === "source" ? "选择我的语言" : "选择对方语言";
    grid.innerHTML = LANG_LIST.map(function (x) {
      return '<button type="button" class="cp-lang-item2' + (x.n === cur ? ' active' : '') + '" data-lang="' + escAttr(x.n) + '">' + esc(x.f + ' ' + x.n) + '</button>';
    }).join("");
    mask.hidden = false;
  }
  function closeLangPanel() {
    var mask = byId("cp-topic-lang-mask");
    if (mask) mask.hidden = true;
    state.pickingLangFor = "";
  }
  function getProvider() { return state.cfg && state.cfg.translateProvider === "ai" ? "ai" : "google"; }
  function syncTranslateUI() {
    if (!state.cfg) return;
    var src = byId("cp-topic-src-lang"), tgt = byId("cp-topic-tgt-lang");
    if (src) src.value = state.cfg.sourceLang;
    if (tgt) tgt.value = state.cfg.targetLang;
    var srcBtn = byId("cp-topic-src-lang-btn"), tgtBtn = byId("cp-topic-tgt-lang-btn");
    if (srcBtn) srcBtn.textContent = getFlag(state.cfg.sourceLang) + " " + state.cfg.sourceLang;
    if (tgtBtn) tgtBtn.textContent = getFlag(state.cfg.targetLang) + " " + state.cfg.targetLang;
    var toggle = byId("cp-topic-send-translate-toggle"), bar = byId("cp-topic-translate-bar");
    if (toggle) toggle.classList.toggle("active", !!state.cfg.sendTranslateEnabled);
    if (bar) bar.classList.toggle("is-on", !!state.cfg.sendTranslateEnabled);
    var auto = byId("cp-topic-auto-translate");
    if (auto) auto.checked = !!state.cfg.autoTranslateLastMsg;
    var g = byId("cp-topic-provider-google"), a = byId("cp-topic-provider-ai"), provider = getProvider();
    if (g) g.classList.toggle("active", provider === "google");
    if (a) a.classList.toggle("active", provider === "ai");
    var pane = byId("cp-topic-ai-pane");
    if (pane) pane.classList.toggle("show", provider === "ai");
    var ge = byId("cp-topic-google-endpoint"), ep = byId("cp-topic-ai-endpoint"), key = byId("cp-topic-ai-key"), model = byId("cp-topic-ai-model");
    if (ge) ge.value = state.cfg.googleEndpoint || DEFAULT_CFG.googleEndpoint || "";
    if (ep) ep.value = state.cfg.ai.endpoint || "";
    if (key) key.value = state.cfg.ai.apiKey || "";
    if (model) model.value = state.cfg.ai.model || "gpt-4o-mini";
    var bgOp = byId("cp-topic-bg-opacity"), bgOpVal = byId("cp-topic-bg-op-val"), bgBlur = byId("cp-topic-bg-blur"), bgBlurVal = byId("cp-topic-bg-blur-val");
    var dim = Math.min(Number((state.bg && state.bg.opacity) || DEFAULT_BG.opacity), 0.45);
    var blur = Number((state.bg && state.bg.blur) || 0);
    if (bgOp) bgOp.value = String(dim);
    if (bgOpVal) bgOpVal.textContent = Math.round(dim * 100) + "%";
    if (bgBlur) bgBlur.value = String(blur);
    if (bgBlurVal) bgBlurVal.textContent = Math.round(blur) + "px";
  }
  function saveSettingsFromUI() {
    try {
      var auto = byId("cp-topic-auto-translate");
      if (auto) state.cfg.autoTranslateLastMsg = !!auto.checked;
      var ge = byId("cp-topic-google-endpoint"), ep = byId("cp-topic-ai-endpoint"), key = byId("cp-topic-ai-key"), model = byId("cp-topic-ai-model");
      if (ge) state.cfg.googleEndpoint = ge.value.trim() || DEFAULT_CFG.googleEndpoint;
      if (ep) state.cfg.ai.endpoint = ep.value.trim() || DEFAULT_CFG.ai.endpoint;
      if (key) state.cfg.ai.apiKey = key.value.trim();
      if (model) state.cfg.ai.model = model.value.trim() || "gpt-4o-mini";
      var bgOp = byId("cp-topic-bg-opacity"), bgBlur = byId("cp-topic-bg-blur");
      if (bgOp) state.bg.opacity = Number(bgOp.value || DEFAULT_BG.opacity);
      if (bgBlur) state.bg.blur = Number(bgBlur.value || 0);
      saveJSON(KEY_CFG, state.cfg); saveJSON(KEY_BG, state.bg); applyBackground(); syncTranslateUI();
      return true;
    } catch (e) { warn("save-settings", e); toast("保存失败"); return false; }
  }
  function openSettings() { var m = byId("cp-topic-settings-mask"); if (m) { syncTranslateUI(); m.hidden = false; } }
  function closeSettings() { var m = byId("cp-topic-settings-mask"); if (m) m.hidden = true; }

  function injectStyle() {
    /* 原第二段 CSS 可以继续使用；这里不追加 CSS。 */
  }
  function injectRoot() {
    if (byId(ROOT_ID)) return;
    var html = `
      <div id="${ROOT_ID}">
        <div class="cp-bg" id="cp-topic-bg"></div><div class="cp-bg-mask"></div>
        <header class="cp-header">
          <button type="button" class="cp-header-back" id="cp-topic-back" aria-label="返回">‹</button>
          <div class="cp-header-peer"><div class="cp-peer-avatar" id="cp-topic-avatar"></div><div class="cp-header-center"><div class="cp-topic-title" id="cp-topic-title">加载中...</div><div class="cp-topic-sub" id="cp-topic-sub"></div></div></div>
          <div class="cp-header-actions"><button id="cp-topic-settings" type="button" aria-label="设置"><i class="fa fa-ellipsis-v"></i></button></div>
        </header>
        <main class="cp-main" id="cp-topic-main">
          <div class="cp-top-spinner" id="cp-topic-load-more"><button type="button">加载更早消息</button></div>
          <div id="cp-topic-msg-list"></div><div id="cp-topic-empty" class="cp-empty" hidden>还没有消息，发第一句吧。</div><div id="cp-topic-bottom-anchor"></div>
        </main>
        <button id="cp-topic-fab" class="cp-fab-bottom" type="button">⌄<span id="cp-topic-badge" class="cp-fab-badge" hidden>0</span></button>
        <button id="cp-topic-at-banner" class="cp-at-banner" type="button" hidden><i class="fa fa-at"></i><span id="cp-topic-at-banner-text"></span><em>点击查看</em></button>
        <footer class="cp-footer" id="cp-topic-footer">
          <div class="cp-translate-shell"><div class="cp-translate-bar" id="cp-topic-translate-bar">
            <button class="cp-lang-chip" id="cp-topic-src-lang-btn" type="button"></button><select class="cp-lang-select" id="cp-topic-src-lang"></select>
            <button class="cp-swap-btn" id="cp-topic-lang-swap" type="button">⇄</button>
            <button class="cp-lang-chip" id="cp-topic-tgt-lang-btn" type="button"></button><select class="cp-lang-select" id="cp-topic-tgt-lang"></select>
            <button class="cp-translate-toggle" id="cp-topic-send-translate-toggle" type="button">译</button>
          </div></div>
          <div class="cp-status-line" id="cp-topic-status-line"></div>
          <div id="cp-topic-quote-preview" class="cp-quote-preview" hidden><div class="cp-quote-preview-bar"></div><div class="cp-quote-preview-body"><b id="cp-topic-quote-name"></b><span id="cp-topic-quote-text"></span></div><button id="cp-topic-quote-close" type="button">×</button></div>
          <div class="cp-toolbar" id="cp-topic-toolbar">
            <div id="cp-topic-upload-progress-wrap" class="cp-progress-wrap" hidden><div id="cp-topic-upload-progress-bar" class="cp-progress-bar"></div></div>
            <div id="cp-topic-toolbar-inputs" style="display:flex;width:100%;align-items:flex-end;">
              <button id="cp-topic-plus" class="cp-tool-btn" type="button">＋</button><div class="cp-input-box"><textarea id="cp-topic-input" rows="1" placeholder="发送消息..." autocomplete="off"></textarea></div><button id="cp-topic-send" class="cp-primary-btn" type="button"><span id="cp-topic-primary-icon"><i class="fa fa-microphone"></i></span></button>
            </div>
            <div id="cp-topic-rec-inline" class="cp-rec-inline" hidden>
              <button id="cp-topic-rec-cancel" class="cp-rec-btn-icon" type="button"><i class="fa fa-trash-o" style="font-size:20px;"></i></button><div class="cp-rec-vis"><span class="cp-rec-dot"></span><div class="cp-rec-dash"></div><div class="cp-rec-bars" id="cp-topic-rec-bars"></div></div><button id="cp-topic-rec-pause" class="cp-rec-btn-icon" type="button"><i class="fa fa-pause-circle" style="font-size:22px;color:#0ea5e9;"></i></button><span id="cp-topic-rec-time" style="font-size:16px;color:#4b5563;font-family:sans-serif;font-weight:500;width:42px;text-align:center;">0:00</span><button id="cp-topic-rec-send" class="cp-rec-btn-icon" type="button"><i class="fa fa-paper-plane" style="font-size:20px;color:#0ea5e9;"></i></button>
            </div>
          </div>
          <div class="cp-media-pop" id="cp-topic-media-pop" hidden><button id="cp-topic-pick-camera" type="button"><i class="fa fa-camera"></i><span>拍照</span></button><button id="cp-topic-pick-album" type="button"><i class="fa fa-picture-o"></i><span>相册图片/视频</span></button></div>
        </footer>
        <input id="cp-topic-media-file" type="file" accept="image/*,video/*" multiple hidden><input id="cp-topic-camera-file" type="file" accept="image/*,video/*" capture="environment" hidden><input id="cp-topic-bg-file" type="file" accept="image/*" hidden>
        <div class="cp-toast" id="cp-topic-toast"></div>
        <div class="cp-preview-mask" id="cp-topic-preview-mask" hidden><div id="cp-topic-preview-body" class="cp-preview-body"></div></div>
        <div id="cp-topic-context-overlay" class="cp-context-overlay" hidden><div id="cp-topic-context-menu" class="cp-context-menu"></div></div>
        <div id="cp-topic-lang-mask" class="cp-lang-mask" hidden><div class="cp-lang-panel"><div class="cp-lang-title" id="cp-topic-lang-title">选择语言</div><div class="cp-lang-grid2" id="cp-topic-lang-grid"></div></div></div>
        <div class="cp-modal-mask" id="cp-topic-settings-mask" hidden><div class="cp-modal"><div class="cp-modal-head" style="display:none"><button class="cp-modal-close" id="cp-topic-settings-close" type="button">×</button></div><div class="cp-modal-body">
          <div class="cp-section cp-section-flat"><div class="cp-section-title"><span>自动翻译</span></div><label class="cp-toggle-row"><span>自动翻译对方消息</span><input id="cp-topic-auto-translate" type="checkbox"></label><div class="cp-section-title cp-subtitle"><span>翻译接口</span></div><div class="cp-provider-tabs"><button class="cp-provider-tab" id="cp-topic-provider-google" type="button">机翻</button><button class="cp-provider-tab" id="cp-topic-provider-ai" type="button">AI 翻译</button></div><label class="cp-field cp-google-field"><span>翻译地址</span><input id="cp-topic-google-endpoint" type="text"></label><div id="cp-topic-ai-pane" class="cp-ai-pane"><label class="cp-field"><span>AI 接口 URL</span><input id="cp-topic-ai-endpoint" type="text"></label><label class="cp-field"><span>API Key</span><input id="cp-topic-ai-key" type="password"></label><label class="cp-field"><span>模型</span><input id="cp-topic-ai-model" type="text"></label></div></div>
          <div class="cp-section cp-section-flat"><div class="cp-section-title"><span>聊天背景</span></div><div class="cp-bg-actions"><button class="cp-bg-btn" id="cp-topic-bg-upload" type="button">选择本地背景</button><button class="cp-bg-btn" id="cp-topic-bg-clear" type="button">清除背景</button></div><label class="cp-field"><span>背景暗度 <em id="cp-topic-bg-op-val">8%</em></span><input id="cp-topic-bg-opacity" type="range" min="0" max="0.45" step="0.01"></label><label class="cp-field"><span>毛玻璃模糊 <em id="cp-topic-bg-blur-val">0px</em></span><input id="cp-topic-bg-blur" type="range" min="0" max="18" step="1"></label></div>
          <div class="cp-modal-actions"><button class="cp-btn-secondary" id="cp-topic-settings-cancel" type="button">关闭</button><button class="cp-btn-primary" id="cp-topic-settings-save" type="button">保存</button></div>
        </div></div></div>
      </div>`;
    document.body.insertAdjacentHTML("beforeend", html);
    ["cp-topic-src-lang","cp-topic-tgt-lang"].forEach(function (id) {
      var el = byId(id);
      if (el) el.innerHTML = buildLangOptions(id.indexOf("tgt") > -1 ? state.cfg.targetLang : state.cfg.sourceLang);
    });
    syncTranslateUI();
  }

  function bindUI() {
    if (state.uiAbort) state.uiAbort.abort();
    state.uiAbort = window.AbortController ? new AbortController() : null;
    var uiSignal = state.uiAbort ? state.uiAbort.signal : undefined;
    byId("cp-topic-back").onclick = function () { if (history.length > 1) history.back(); else location.href = "/category/" + CONFIG.targetCid; };
    byId("cp-topic-settings").onclick = openSettings;
    byId("cp-topic-settings-close").onclick = closeSettings;
    byId("cp-topic-settings-cancel").onclick = closeSettings;
    byId("cp-topic-settings-save").onclick = function () { if (saveSettingsFromUI()) { closeSettings(); toast("设置已保存"); } };
    byId("cp-topic-settings-mask").addEventListener("click", function (e) { if (e.target === this) closeSettings(); });
    byId("cp-topic-quote-close").onclick = hideQuoteBar;
    byId("cp-topic-provider-google").onclick = function () { state.cfg.translateProvider = "google"; saveJSON(KEY_CFG, state.cfg); syncTranslateUI(); };
    byId("cp-topic-provider-ai").onclick = function () { state.cfg.translateProvider = "ai"; saveJSON(KEY_CFG, state.cfg); syncTranslateUI(); };
    byId("cp-topic-src-lang-btn").onclick = function () { openLangPanel("source"); };
    byId("cp-topic-tgt-lang-btn").onclick = function () { openLangPanel("target"); };
    byId("cp-topic-lang-swap").onclick = function () {
      var a = state.cfg.sourceLang; state.cfg.sourceLang = state.cfg.targetLang; state.cfg.targetLang = a;
      saveJSON(KEY_CFG, state.cfg); refreshLangSelects(); syncTranslateUI();
    };
    byId("cp-topic-send-translate-toggle").onclick = function () {
      state.cfg.sendTranslateEnabled = !state.cfg.sendTranslateEnabled; saveJSON(KEY_CFG, state.cfg); syncTranslateUI(); toast(state.cfg.sendTranslateEnabled ? "译发已开启" : "译发已关闭");
    };
    byId("cp-topic-src-lang").addEventListener("change", function () { state.cfg.sourceLang = this.value; saveJSON(KEY_CFG, state.cfg); syncTranslateUI(); });
    byId("cp-topic-tgt-lang").addEventListener("change", function () { state.cfg.targetLang = this.value; saveJSON(KEY_CFG, state.cfg); syncTranslateUI(); });
    byId("cp-topic-lang-mask").addEventListener("click", function (e) {
      if (e.target === this) return closeLangPanel();
      var item = e.target.closest(".cp-lang-item2");
      if (!item) return;
      var lang = item.getAttribute("data-lang");
      if (state.pickingLangFor === "source") state.cfg.sourceLang = lang; else state.cfg.targetLang = lang;
      saveJSON(KEY_CFG, state.cfg); refreshLangSelects(); syncTranslateUI(); closeLangPanel();
    });
    byId("cp-topic-fab").onclick = function () { state.unread = 0; updateFab(); forceBottom(); };
    byId("cp-topic-at-banner").onclick = function () { scrollToMessageId(this.getAttribute("data-mid")); };
    byId("cp-topic-load-more").onclick = function () { fetchHistory(true); };
    byId("cp-topic-send").onclick = handlePrimaryAction;
    byId("cp-topic-plus").onclick = function (e) { e.stopPropagation(); var pop = byId("cp-topic-media-pop"); if (pop) pop.hidden = !pop.hidden; };
    byId("cp-topic-pick-camera").onclick = function () { byId("cp-topic-media-pop").hidden = true; byId("cp-topic-camera-file").click(); };
    byId("cp-topic-pick-album").onclick = function () { byId("cp-topic-media-pop").hidden = true; byId("cp-topic-media-file").click(); };
    byId("cp-topic-media-file").addEventListener("change", onPickMedia);
    byId("cp-topic-camera-file").addEventListener("change", onPickMedia);
    byId("cp-topic-bg-file").addEventListener("change", handleBackgroundUpload);
    byId("cp-topic-bg-upload").onclick = function () { byId("cp-topic-bg-file").click(); };
    byId("cp-topic-bg-clear").onclick = function () { state.bg = cloneJSON(DEFAULT_BG); saveJSON(KEY_BG, state.bg); applyBackground(); syncTranslateUI(); };
    byId("cp-topic-bg-opacity").addEventListener("input", function () { state.bg.opacity = Number(this.value); saveJSON(KEY_BG, state.bg); applyBackground(); syncTranslateUI(); });
    byId("cp-topic-bg-blur").addEventListener("input", function () { state.bg.blur = Number(this.value); saveJSON(KEY_BG, state.bg); applyBackground(); syncTranslateUI(); });
    byId("cp-topic-rec-cancel").onclick = function () { stopRecording(false); };
    byId("cp-topic-rec-send").onclick = function () { stopRecording(true); };
    byId("cp-topic-rec-pause").onclick = togglePauseRecording;
    state.audio.addEventListener("ended", onAudioEnded, uiSignal ? { signal: uiSignal } : false);

    document.addEventListener("click", function (e) {
      var pop = byId("cp-topic-media-pop");
      if (pop && !pop.hidden && !e.target.closest("#cp-topic-media-pop") && !e.target.closest("#cp-topic-plus")) pop.hidden = true;
    }, uiSignal ? { signal: uiSignal } : false);
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible" && state.mounted) {
        pingTopicPresence(); fetchTopicPresence(); fetchRemoteNotices(); fetchOffline();
      }
    }, uiSignal ? { signal: uiSignal } : false);

    var input = byId("cp-topic-input");
    input.addEventListener("input", function () { autoGrow(input); updateSendButton(); updateFooterHeight(); });
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey && !/Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)) { e.preventDefault(); handlePrimaryAction(); }
    });

    var main = byId("cp-topic-main");
    var scrollRAF = null;
    main.addEventListener("scroll", function () {
      if (scrollRAF) return;
      scrollRAF = requestAnimationFrame(function () {
        scrollRAF = null;
        state.stickToBottom = isAtBottom();
        if (state.stickToBottom) state.unread = 0;
        updateFab();
        if (main.scrollTop < 90 && !state.loadingHistory && !state.hasNoMore) {
          if (state.renderLimit < Math.min(MAX_RENDER_LIMIT, state.messages.length)) {
            state.renderLimit = Math.min(MAX_RENDER_LIMIT, state.renderLimit + RENDER_STEP);
            queueRender("prepend");
          } else fetchHistory(true);
        }
      });
    }, { passive: true });

    byId("cp-topic-msg-list").addEventListener("click", onMsgListClick);
    bindLongPress(byId("cp-topic-msg-list"));
    byId("cp-topic-context-overlay").addEventListener("click", function (e) { if (e.target === this) hideContextMenu(); });
    byId("cp-topic-context-menu").addEventListener("click", onContextMenuClick);
    byId("cp-topic-preview-mask").addEventListener("click", function (e) { if (e.target === this || e.target.closest("[data-act='close-preview']")) closePreview(); });

    if (window.visualViewport) {
      var vh = function () { updateViewport(); updateFooterHeight(); };
      window.visualViewport.addEventListener("resize", vh, uiSignal ? { passive: true, signal: uiSignal } : { passive: true });
      window.visualViewport.addEventListener("scroll", vh, uiSignal ? { passive: true, signal: uiSignal } : { passive: true });
    }
  }
  function refreshLangSelects() {
    ["cp-topic-src-lang","cp-topic-tgt-lang"].forEach(function (id) {
      var el = byId(id); if (el) el.innerHTML = buildLangOptions(id.indexOf("tgt") > -1 ? state.cfg.targetLang : state.cfg.sourceLang);
    });
  }
  function onMsgListClick(e) {
    var avatarLink = e.target.closest(".cp-avatar-wrap");
    if (avatarLink) {
      e.preventDefault();
      var href = avatarLink.getAttribute("href") || "#";
      if (href && href !== "#") location.href = href;
      return;
    }
    var quoteCard = e.target.closest(".cp-quote-card");
    if (quoteCard) {
      var qid = quoteCard.getAttribute("data-quote-mid") || "";
      if (qid) scrollToMessageId(qid);
      return;
    }
    var actEl = e.target.closest("[data-act]");
    if (!actEl) return;
    var row = e.target.closest(".cp-row");
    var msg = row ? state.msgMap[row.getAttribute("data-mid")] : null;
    if (!msg) return;
    var act = actEl.getAttribute("data-act");
    if (act === "translate") translateMessage(msg, false);
    else if (act === "retry-translate") translateMessage(msg, true);
    else if (act === "toggle-translation") { msg.translationOpen = false; touchMsg(msg); queueRender("keep"); saveCacheSoon(); }
    else if (act === "preview-media") openPreview(msg);
    else if (act === "play-voice") playVoice(msg, actEl.closest(".cp-voice"));
  }
  function bindLongPress(list) {
    var timer = null, start = null;
    function clearLong() { if (timer) { clearTimeout(timer); timer = null; } }
    list.addEventListener("touchstart", function (e) {
      var bubble = e.target.closest(".cp-bubble"); if (!bubble) return;
      var row = bubble.closest(".cp-row"); if (!row) return;
      var msg = state.msgMap[row.getAttribute("data-mid")]; if (!msg) return;
      start = e.touches && e.touches[0] ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
      timer = setTimeout(function () { timer = null; showContextMenu(msg); }, 520);
    }, { passive: true });
    list.addEventListener("touchmove", function (e) {
      if (!timer || !start || !e.touches || !e.touches[0]) return;
      var dx = Math.abs(e.touches[0].clientX - start.x), dy = Math.abs(e.touches[0].clientY - start.y);
      if (dx > 8 || dy > 8) clearLong();
    }, { passive: true });
    list.addEventListener("touchend", clearLong, { passive: true });
    list.addEventListener("touchcancel", clearLong, { passive: true });
    list.addEventListener("contextmenu", function (e) {
      var bubble = e.target.closest(".cp-bubble"); if (!bubble) return;
      var row = bubble.closest(".cp-row"); if (!row) return;
      var msg = state.msgMap[row.getAttribute("data-mid")]; if (!msg) return;
      e.preventDefault(); showContextMenu(msg);
    });
  }
  function onContextMenuClick(e) {
    var btn = e.target.closest("[data-menu-act]");
    if (!btn || !state.contextMsg) return;
    var act = btn.getAttribute("data-menu-act");
    var msg = state.contextMsg;
    hideContextMenu();
    if (act === "reply") showQuoteBar(msg);
    else if (act === "mention") insertMention(msg);
    else if (act === "translate") translateMessage(msg, true);
    else if (act === "save") saveMediaMessage(msg);
    else if (act === "delete") deleteLocalMessage(msg.id);
  }

  function updateHeader() {
    var title = byId("cp-topic-title"), sub = byId("cp-topic-sub"), avatar = byId("cp-topic-avatar");
    if (title) title.textContent = state.topic ? state.topic.title : "话题聊天室";
    if (sub) sub.textContent = state.onlineCount > 0 ? ("在线 " + state.onlineCount + " 人") : "";
    if (avatar) { avatar.innerHTML = '<span class="cp-topic-hash-avatar" aria-hidden="true">#</span>'; avatar.classList.add("cp-peer-avatar-hash"); }
  }
  function setStatus(text, lineText) {
    state.statusText = text || state.statusText;
    updateHeader();
    var line = byId("cp-topic-status-line");
    if (!line) return;
    if (lineText) { line.textContent = lineText; line.classList.add("show"); }
    else line.classList.remove("show");
    updateFooterHeight();
  }
  function updateViewport() {
    var vv = window.visualViewport, offset = 0;
    if (vv) offset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    var footer = byId("cp-topic-footer");
    if (footer) footer.style.bottom = offset + "px";
  }
  function updateFooterHeight() {
    clearTimeout(footerTimer);
    footerTimer = setTimeout(function () {
      var footer = byId("cp-topic-footer"), root = byId(ROOT_ID);
      if (!footer || !root) return;
      root.style.setProperty("--cp-footer-h", Math.max(78, Math.ceil(footer.offsetHeight || 78)) + "px");
      if (state.stickToBottom) requestAnimationFrame(forceBottom);
    }, 0);
  }
  function autoGrow(input) { input.style.height = "36px"; input.style.height = Math.min(input.scrollHeight, 120) + "px"; }
  function updateSendButton() {
    var text = (byId("cp-topic-input").value || "").trim();
    var btn = byId("cp-topic-send"), icon = byId("cp-topic-primary-icon");
    if (!btn) return;
    btn.classList.toggle("send", !!text);
    if (icon) icon.innerHTML = text ? "↑" : '<i class="fa fa-microphone"></i>';
  }
  function handlePrimaryAction() {
    var text = String((byId("cp-topic-input") && byId("cp-topic-input").value) || "").trim();
    if (text) return sendCurrent();
    if (!state.rec.mediaRecorder || state.rec.mediaRecorder.state === "inactive") startRecording();
    else stopRecording(true);
  }
  function isAtBottom() {
    var main = byId("cp-topic-main");
    if (!main) return true;
    return main.scrollHeight - main.scrollTop - main.clientHeight < BOTTOM_THRESHOLD;
  }
  function forceBottom() {
    var main = byId("cp-topic-main");
    if (main) main.scrollTop = main.scrollHeight;
  }
  function updateFab() {
    var fab = byId("cp-topic-fab"), badge = byId("cp-topic-badge");
    if (!fab || !badge) return;
    fab.classList.toggle("show", !state.stickToBottom || state.unread > 0);
    if (state.unread > 0) { badge.hidden = false; badge.textContent = state.unread > 99 ? "99+" : String(state.unread); }
    else badge.hidden = true;
  }

  function mergeRenderMode(oldMode, newMode) {
    var rank = { keep: 1, prepend: 2, bottom: 3 };
    oldMode = oldMode || "keep";
    newMode = newMode || "keep";
    return (rank[newMode] || 1) > (rank[oldMode] || 1) ? newMode : oldMode;
  }
  function queueRender(mode) {
    state.pendingRenderMode = mergeRenderMode(state.pendingRenderMode || "keep", mode || "keep");
    if (state.renderPending) return;
    state.renderPending = true;
    requestAnimationFrame(function () {
      var finalMode = state.pendingRenderMode || "keep";
      state.pendingRenderMode = "";
      state.renderPending = false;
      renderIncremental(finalMode);
    });
  }
  function shouldShowTimeSep(prev, cur) {
    if (!cur) return false;
    if (!prev) return true;
    if (formatDayLabel(prev.ts) !== formatDayLabel(cur.ts)) return true;
    return Math.abs((cur.ts || 0) - (prev.ts || 0)) > 5 * 60 * 1000;
  }
  function linkify(html) {
    return String(html || "").replace(/(https?:\/\/[^\s<]+)/g, function (url) {
      try {
        var u = new URL(url);
        if (u.protocol !== "http:" && u.protocol !== "https:") return esc(url);
        return '<a href="' + escAttr(u.href) + '" target="_blank" rel="noopener noreferrer">' + esc(url) + '</a>';
      } catch (_) { return esc(url); }
    });
  }
  function renderMessageText(text) {
    var safe = linkify(esc(text));
    return safe.replace(/(^|[\s>])@([^\s<@]{1,24})/g, function (_, prefix, name) {
      return prefix + '<span class="cp-at-pill">@' + esc(name) + '</span>';
    });
  }
  function buildNodeHash(m, prev, next, lastPeerTextMsgId) {
    return [
      m.id, m._ver || 0, m.seq || 0, m.sending ? 1 : 0, m.failed ? 1 : 0,
      m.translationOpen ? 1 : 0, m.translation || "", m.translationError ? 1 : 0,
      m.text || "", m.serverText || "", m.type || "", m.mediaUrl || "", m.audioUrl || "",
      m.durationStr || "", m.quote || "", m.quoteMsgId || "", m.mentionMe ? 1 : 0,
      prev ? prev.id : "", next ? next.id : "", lastPeerTextMsgId === m.id ? 1 : 0,
      displayNameForMessage(m), avatarProfileHash(m.uid),
      m.quoteUid ? avatarProfileHash(m.quoteUid) : ""
    ].join("|");
  }
  function buildMessageInner(m, prev, next, lastPeerTextMsgId) {
    var samePrev = !!(prev && prev.mine === m.mine && String(prev.uid || "") === String(m.uid || "") && Math.abs((m.ts || 0) - (prev.ts || 0)) < 2 * 60 * 1000 && formatDayLabel(prev.ts) === formatDayLabel(m.ts));
    var sameNext = !!(next && next.mine === m.mine && String(next.uid || "") === String(m.uid || "") && Math.abs((next.ts || 0) - (m.ts || 0)) < 2 * 60 * 1000 && formatDayLabel(next.ts) === formatDayLabel(m.ts));
    var showIdentity = !m.mine && !samePrev;
    var rowClass = "cp-row " + (m.mine ? "mine" : "other") + (showIdentity ? " show-name" : " grouped") + (sameNext ? " has-next" : " group-last");
    var avatar = "";
    if (!m.mine) {
      var href = getUserProfileHref(m.uid, m.username);
      avatar = showIdentity ? '<a class="cp-avatar-wrap" href="' + escAttr(href) + '" data-ajaxify="false" data-uid="' + escAttr(m.uid || "") + '" title="查看主页">' + getAvatarHtml(m.uid, m.username) + '</a>' : '<div class="cp-avatar-spacer"></div>';
    }
    var name = showIdentity ? '<div class="cp-name">' + esc(displayNameForMessage(m)) + '</div>' : "";
    var status = m.failed ? '<span class="cp-status-failed"> 失败</span>' : (m.sending ? '<span class="cp-status-sending"> 发送中</span>' : "");
    var trans = "";
    if (m.translationOpen && m.translation) {
      trans = '<div class="cp-translation-wrap"><div class="cp-translation-text' + (m.translationError ? ' is-error' : '') + '" data-act="' + (m.translationError ? 'retry-translate' : 'toggle-translation') + '">' + (m.translation === "翻译中..." ? "⏳ " : "✨ ") + esc(m.translation) + (m.translationError ? "（点此重试）" : "") + '</div></div>';
    }
    var quick = (!m.mine && m.id === lastPeerTextMsgId && m.type === "text" && !m.translationOpen && state.cfg.showQuickTranslate !== false) ? '<button type="button" class="cp-quick-trans" data-act="translate" title="翻译">译</button>' : "";
    sanitizeQuoteFields(m);
    var noticeType = getMentionNoticeType(m);
    var senderName = displayNameForMessage(m) || m.username || "有人";
    var replyHint = (!m.mine && noticeType === "reply") ? '<div class="cp-reply-me-hint"><strong>' + esc(senderName) + '</strong> 回复了你</div>' : ((!m.mine && noticeType === "mention") ? '<div class="cp-reply-me-hint"><strong>' + esc(senderName) + '</strong> @了你</div>' : '');
    var qText = String(m.quote || "").trim();
    var hasQuote = !!(qText || m.quoteMediaUrl || m.quoteAudioUrl);
    if (hasQuote && !qText) qText = "[引用消息]";
    var qUser = m.quoteUid ? getMergedUserByUid(m.quoteUid) : null;
    var qName = m.quoteUser || (qUser ? (qUser.displayname || qUser.username) : "引用");
    var quoteHtml = hasQuote ? replyHint + '<div class="cp-quote-card' + (m.quoteUid && String(m.quoteUid) === String(state.uid) ? ' is-mine-ref' : '') + '" data-quote-mid="' + escAttr(m.quoteMsgId || '') + '"><div><b>' + esc(qName) + '</b><span>' + esc(qText) + '</span></div></div>' : replyHint;
    var body = "", bubbleExtra = "", time = formatTime(m.ts);
    if (m.type === "image") {
      bubbleExtra = " media-shell";
      body = quoteHtml + '<button class="cp-media-thumb" data-act="preview-media"><img class="cp-lazy-img" data-src="' + escAttr(toPlayableUrl(m.mediaUrl || "")) + '" alt="图片" loading="lazy"><span class="cp-media-time">' + time + status + '</span></button>';
    } else if (m.type === "video") {
      bubbleExtra = " media-shell";
      body = quoteHtml + '<button class="cp-media-thumb cp-video-wrap" data-act="preview-media"><video class="cp-lazy-video" data-src="' + escAttr(toPlayableUrl(m.mediaUrl || "")) + '" preload="none" muted playsinline></video><span class="cp-video-mark">视频</span><span class="cp-media-time">' + time + status + '</span></button>';
    } else if (m.type === "voice") {
      var audioSrc = toPlayableUrl(m.audioUrl || m.mediaUrl || "");
      var bars = [5,8,12,16,10,7,14,9,13,6,11,15].map(function (h) { return '<i style="height:' + h + 'px"></i>'; }).join("");
      body = quoteHtml + '<button class="cp-voice cp-lazy-audio" data-act="play-voice" data-audio-src="' + escAttr(audioSrc) + '"><span class="cp-play-circle"><i class="fa fa-play"></i></span><span class="cp-wave">' + bars + '</span><div class="cp-voice-info-col"><span class="cp-voice-dur">' + esc(m.durationStr || "--:--") + '</span><span class="cp-voice-time">' + time + status + '</span></div></button>' + trans + quick;
    } else {
      body = quoteHtml + '<span class="cp-text">' + renderMessageText(m.text) + '</span><span class="cp-inline-time">' + time + status + '</span>' + trans + quick;
    }
    var mentionCls = (!m.mine && (m.mentionMe || getMentionNoticeType(m))) ? " cp-mention-me" : "";
    return { rowClass: rowClass, html: avatar + '<div class="cp-bubble-wrap">' + name + '<div class="cp-bubble' + bubbleExtra + mentionCls + '">' + body + '</div></div>' };
  }
  function renderIncremental(mode) {
    var list = byId("cp-topic-msg-list"), empty = byId("cp-topic-empty"), main = byId("cp-topic-main");
    if (!list || !main) return;
    var oldHeight = main.scrollHeight, oldTop = main.scrollTop, wasBottom = isAtBottom();
    var msgs = state.messages.slice(-Math.min(state.renderLimit, state.messages.length));
    var lastPeerTextMsgId = "";
    for (var lp = msgs.length - 1; lp >= 0; lp--) if (!msgs[lp].mine && msgs[lp].type === "text" && !msgs[lp].translationOpen) { lastPeerTextMsgId = msgs[lp].id; break; }
    var existing = {};
    var child = list.firstElementChild;
    while (child) { var k = child.getAttribute("data-key"); if (k) existing[k] = child; child = child.nextElementSibling; }
    var keys = [], nodes = {}, prev = null;
    for (var i = 0; i < msgs.length; i++) {
      var m = msgs[i], next = msgs[i + 1] || null;
      if (!m.mine && (!m.username || /^用户\d+$/.test(m.username))) queueResolveUsers([m.uid]);
      if (shouldShowTimeSep(prev, m)) {
        var sepKey = "sep:" + formatTimeDivider(m.ts);
        var sep = existing[sepKey] || document.createElement("div");
        sep.className = "cp-time-sep"; sep.setAttribute("data-key", sepKey);
        if (sep.getAttribute("data-hash") !== sepKey) { sep.innerHTML = '<span>' + esc(formatTimeDivider(m.ts)) + '</span>'; sep.setAttribute("data-hash", sepKey); }
        keys.push(sepKey); nodes[sepKey] = sep;
      }
      var key = "msg:" + m.id;
      var node = existing[key] || document.createElement("div");
      var hash = buildNodeHash(m, prev, next, lastPeerTextMsgId);
      if (node.getAttribute("data-hash") !== hash) {
        var built = buildMessageInner(m, prev, next, lastPeerTextMsgId);
        node.className = built.rowClass; node.innerHTML = built.html; node.setAttribute("data-hash", hash);
      }
      node.setAttribute("data-key", key); node.setAttribute("data-mid", m.id);
      keys.push(key); nodes[key] = node; prev = m;
    }
    var targetSet = new Set(keys), remove = [];
    child = list.firstElementChild;
    while (child) { var ck = child.getAttribute("data-key"); if (!targetSet.has(ck)) remove.push(child); child = child.nextElementSibling; }
    remove.forEach(function (n) { if (n.parentNode) n.parentNode.removeChild(n); });
    var frag = document.createDocumentFragment();
    keys.forEach(function (k) { frag.appendChild(nodes[k]); });
    list.appendChild(frag);
    if (empty) empty.hidden = state.messages.length > 0;
    if (mode === "bottom") { requestAnimationFrame(forceBottom); setTimeout(forceBottom, 80); state.stickToBottom = true; }
    else if (mode === "prepend") main.scrollTop = oldTop + (main.scrollHeight - oldHeight);
    else if (mode === "keep") { if (wasBottom || state.stickToBottom) requestAnimationFrame(forceBottom); else main.scrollTop = oldTop; }
    observeLazyElements(); updateFab(); updateFooterHeight();
  }
  function initLazyObserver() {
    if (state.lazyObserver) state.lazyObserver.disconnect();
    if (!("IntersectionObserver" in window)) return;
    state.lazyObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        state.lazyObserver.unobserve(entry.target);
        loadLazyElement(entry.target);
      });
    }, { root: byId("cp-topic-main"), rootMargin: "300px 0px" });
  }
  function observeLazyElements() {
    var els = document.querySelectorAll("#cp-topic-msg-list .cp-lazy-img, #cp-topic-msg-list .cp-lazy-video, #cp-topic-msg-list .cp-lazy-audio");
    if (state.lazyObserver) els.forEach(function (el) { state.lazyObserver.observe(el); });
    else els.forEach(loadLazyElement);
  }
  function loadLazyElement(el) {
    if (!el || el.getAttribute("data-loaded") === "1") return;
    var src = el.getAttribute("data-src") || el.getAttribute("data-audio-src") || "";
    if (!src) return;
    var wasBottom = isAtBottom();
    if (el.tagName === "IMG" || el.tagName === "VIDEO") el.src = src;
    el.setAttribute("data-loaded", "1");
    el.classList.remove("cp-lazy-img", "cp-lazy-video", "cp-lazy-audio");
    if (wasBottom) requestAnimationFrame(forceBottom);
  }

  function toast(text) {
    var el = byId("cp-topic-toast");
    if (!el) return;
    el.textContent = text; el.classList.add("show");
    clearTimeout(el._t); el._t = setTimeout(function () { el.classList.remove("show"); }, 1800);
  }
  async function getToken() {
    var res = await fetch(CONFIG.tokenUrl, { credentials: "include" });
    if (!res.ok) throw new Error("token http " + res.status);
    var json = await res.json();
    if (!json || !json.uid || !json.token) throw new Error("token missing uid/token");
    state.uid = String(json.uid); state.token = String(json.token); state.username = json.username || getMyName(); state.tokenData = json;
  }
  async function ensureTopicChannel() {
    var res = await bridgePost(CONFIG.ensureUrl, { tid: state.topic.tid, cid: state.topic.cid, title: state.topic.title, channel_id: state.channelId, channel_type: CONFIG.channelType, temp_subscriber: 1 });
    if (!res.ok) throw new Error("ensure http " + res.status);
  }
  function ensureSdk() {
    return new Promise(function (resolve, reject) {
      if (window.wk && window.wk.WKSDK) return resolve();
      var urls = Array.isArray(CONFIG.sdkUrls) && CONFIG.sdkUrls.length ? CONFIG.sdkUrls.slice() : [];
      if (CONFIG.sdkUrl && urls.indexOf(CONFIG.sdkUrl) < 0) urls.push(CONFIG.sdkUrl);
      var existing = document.querySelector('script[data-cp-wk-sdk="1"], script[src*="wukongimjssdk@1.2.10"]');
      if (existing) {
        existing.addEventListener("load", function () { resolve(); }, { once: true });
        existing.addEventListener("error", function () { reject(new Error("WKSDK script error")); }, { once: true });
        setTimeout(function () { if (window.wk && window.wk.WKSDK) resolve(); }, 600);
        return;
      }
      var i = 0;
      function loadNext(lastErr) {
        if (window.wk && window.wk.WKSDK) return resolve();
        if (i >= urls.length) return reject(lastErr || new Error("WKSDK load failed"));
        var url = urls[i++];
        var s = document.createElement("script");
        s.src = url;
        s.async = true;
        s.dataset.cpWkSdk = "1";
        s.onload = function () {
          if (window.wk && window.wk.WKSDK) return resolve();
          try { s.remove(); } catch (_) {}
          loadNext(new Error("WKSDK loaded but global wk.WKSDK missing: " + url));
        };
        s.onerror = function () {
          try { s.remove(); } catch (_) {}
          loadNext(new Error("WKSDK load failed: " + url));
        };
        document.head.appendChild(s);
      }
      loadNext();
    });
  }
  function isWkConnectedStatus(status) {
    if (status === 1 || status === "connected" || status === "connect" || status === "success") return true;
    var text = "";
    try {
      if (status && typeof status === "object") text = String(status.status || status.type || status.name || status.value || status.code || "").toLowerCase();
      else text = String(status || "").toLowerCase();
    } catch (_) {}
    return text === "connected" || text === "connect" || text === "success" || text === "connected_success";
  }

  async function connectWk() {
    if (state.connectStarted) return;
    state.connectStarted = true;
    await ensureSdk();
    if (!window.wk || !window.wk.WKSDK) throw new Error("WKSDK missing");
    var shared = window.wk.WKSDK.shared();
    shared.config.uid = state.uid;
    shared.config.token = state.token;
    shared.config.addr = (state.tokenData && (state.tokenData.addr || state.tokenData.wsAddr || state.tokenData.wkws)) || ((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/wkws/");
    log("wk-connect", { addr: shared.config.addr, uid: state.uid, sdkVersion: CONFIG.sdkVersion });
    if (!shared.__cpTopicV29IdbSdkStableListener) {
      shared.chatManager.addMessageListener(function (m) {
        try {
          if (!state.mounted || !sameTopicChannel(m)) return;
          var wasBottom = isAtBottom();
          var msg = msgFromWk(m);
          addMessages([msg], { scroll: wasBottom ? "bottom" : "keep" });
          var stored = state.msgMap[msg.id] || msg;
          maybeAutoTranslateLatest(stored);
          if (!stored.mine && getMentionNoticeType(stored)) pushMentionNotice(stored);
          if (!wasBottom && !msg.mine) { state.unread++; updateFab(); }
        } catch (e) { warn("message-listener", e); }
      });
      shared.__cpTopicV29IdbSdkStableListener = true;
    }
    if (shared.connectManager && !shared.connectManager.__cpTopicV30SdkFixStatus) {
      shared.connectManager.addConnectStatusListener(function (status, reasonCode) {
        log("wk-status", { status: status, reasonCode: reasonCode, addr: shared.config.addr });
        var ok = isWkConnectedStatus(status);
        state.connected = !!ok;
        setStatus(ok ? "已连接" : "连接中");
        if (ok && state.newestSeq) fetchOffline();
      });
      shared.connectManager.__cpTopicV30SdkFixStatus = true;
    }
    shared.connectManager.connect();
    state.wkReady = true;
  }
  function normalizeHistory(json) {
    if (Array.isArray(json)) return json;
    if (json && Array.isArray(json.data)) return json.data;
    if (json && json.data && Array.isArray(json.data.messages)) return json.data.messages;
    if (json && Array.isArray(json.messages)) return json.messages;
    return [];
  }
  async function fetchJson(url, timeout) {
    var res = await fetchWithTimeout(url, { credentials: "include" }, timeout || 12000);
    if (!res.ok) throw new Error("http " + res.status);
    return res.json();
  }
  async function fetchHistory(loadMore) {
    if (state.loadingHistory || (state.hasNoMore && loadMore)) return;
    state.loadingHistory = true;
    var btn = byId("cp-topic-load-more");
    if (btn) btn.innerHTML = "加载中...";
    var startSeq = loadMore && state.oldestSeq ? Math.max(0, state.oldestSeq - 1) : 0;
    var q = "?channel_id=" + encodeURIComponent(state.channelId) + "&channel_type=" + encodeURIComponent(CONFIG.channelType) + "&tid=" + encodeURIComponent(state.topic.tid) + "&limit=" + encodeURIComponent(CONFIG.historyLimit) + "&pull_mode=" + (loadMore ? "0" : "1") + "&load_more=" + (loadMore ? "1" : "0");
    if (startSeq) q += "&start_message_seq=" + encodeURIComponent(startSeq);
    try {
      var json;
      try { json = await fetchJson(CONFIG.historyUrl + q); } catch (e1) { json = await fetchJson(CONFIG.legacyHistoryUrl + q); }
      var raw = normalizeHistory(json);
      if (!raw.length || raw.length < CONFIG.historyLimit) state.hasNoMore = true;
      if (loadMore) state.renderLimit = Math.min(MAX_RENDER_LIMIT, state.renderLimit + RENDER_STEP);
      addMessages(raw.map(function (m) { return msgFromWk(m); }), { scroll: loadMore ? "prepend" : (state.stickToBottom ? "bottom" : "keep"), notify: false });
      state.lastHistoryAt = Date.now();
    } catch (e) { warn("history", e); }
    finally {
      state.loadingHistory = false;
      if (btn) btn.innerHTML = state.hasNoMore ? "没有更早消息了" : '<button type="button">加载更早消息</button>';
    }
  }
  async function fetchOffline() {
    if (state.offlineInflight) return;
    if (!state.newestSeq || Date.now() - state.lastHistoryAt < 1500) return;
    state.offlineInflight = true;
    var q = "?channel_id=" + encodeURIComponent(state.channelId) + "&channel_type=" + encodeURIComponent(CONFIG.channelType) + "&tid=" + encodeURIComponent(state.topic.tid) + "&limit=50&start_message_seq=" + encodeURIComponent(state.newestSeq + 1);
    try {
      var msgs = normalizeHistory(await fetchJson(CONFIG.historyUrl + q)).map(function (m) { return msgFromWk(m); });
      if (msgs.length) addMessages(msgs, { scroll: isAtBottom() ? "bottom" : "keep" });
    } catch (_) {}
    finally { state.offlineInflight = false; }
  }

  async function sendCurrent() {
    var input = byId("cp-topic-input");
    var original = (input.value || "").trim();
    if (!original) return;
    input.value = ""; autoGrow(input); updateSendButton(); updateFooterHeight();
    await sendTopicText(original, { allowTranslate: true });
    state.pendingMentionUids = []; state.pendingMentionMap = {}; hideQuoteBar();
  }
  function extractMentionUids(text) {
    var out = (state.pendingMentionUids || []).map(String);
    Object.keys(state.pendingMentionMap || {}).forEach(function (uid) { if (out.indexOf(uid) < 0) out.push(uid); });
    if (state.quoteTarget && state.quoteTarget.uid && out.indexOf(String(state.quoteTarget.uid)) < 0) out.push(String(state.quoteTarget.uid));
    return out;
  }
  async function sendTopicText(originalText, opts) {
    opts = opts || {}; originalText = String(originalText || "").trim(); if (!originalText) return;
    while (state.sendLock) await new Promise(function (r) { setTimeout(r, 70); });
    state.sendLock = true;
    var parsed = detectMessageKind(originalText, { duration: opts.duration || 0 });
    var local = {
      id: "local_" + Date.now() + "_" + Math.floor(Math.random() * 10000),
      seq: 0, uid: state.uid || "me", username: getMyName(), mine: true,
      type: parsed.kind, text: parsed.text, serverText: originalText, mediaUrl: parsed.mediaUrl, audioUrl: parsed.audioUrl,
      durationStr: opts.duration ? formatDuration(opts.duration) : "", originalText: "", translation: "", translationOpen: false, translationError: false,
      ts: Date.now(), sending: true, failed: false, local: true,
      quote: state.quoteTarget ? getQuotePreviewText(state.quoteTarget) : "", quoteUser: state.quoteTarget ? displayNameForMessage(state.quoteTarget) : "",
      quoteUid: state.quoteTarget && state.quoteTarget.uid ? String(state.quoteTarget.uid) : "", quoteMsgId: state.quoteTarget && state.quoteTarget.id ? String(state.quoteTarget.id) : "",
      quoteType: state.quoteTarget ? (state.quoteTarget.type || "text") : "", quoteMediaUrl: state.quoteTarget ? (state.quoteTarget.mediaUrl || "") : "", quoteAudioUrl: state.quoteTarget ? (state.quoteTarget.audioUrl || "") : "",
      mentionUids: extractMentionUids(originalText), _ver: 1
    };
    sanitizeQuoteFields(local); addMessages([local], { scroll: "bottom" }); if (state.quoteTarget) hideQuoteBar();
    var textToSend = originalText;
    try {
      if (state.cfg.sendTranslateEnabled && opts.allowTranslate !== false && parsed.kind === "text") {
        local.translation = "翻译发送中..."; local.translationOpen = true; touchMsg(local); queueRender("bottom");
        textToSend = await translateByProvider(originalText, state.cfg.sourceLang, state.cfg.targetLang);
        local.text = originalText; local.serverText = textToSend; local.originalText = originalText; local.translation = ""; local.translationOpen = false; touchMsg(local);
      }
      if (!state.wkReady || !window.wk || !window.wk.WKSDK) throw new Error("WK not ready");
      var channel = new window.wk.Channel(state.channelId, CONFIG.channelType);
      var mentionUids = extractMentionUids(originalText);
      var content = new window.wk.MessageText(textToSend);
      var rawEncode = content.encode && content.encode.bind(content);
      if (rawEncode) {
        content.encode = function () {
          var p = rawEncode();
          try {
            var obj = typeof p === "string" ? JSON.parse(p) : (p || {});
            obj.username = getMyName();
            if (textToSend !== originalText) obj.originalText = originalText;
            if (parsed.kind !== "text") obj.cpType = parsed.kind;
            if (parsed.mediaUrl) obj.mediaUrl = parsed.mediaUrl;
            if (parsed.audioUrl) obj.audioUrl = parsed.audioUrl;
            if (opts.duration) obj.duration = opts.duration;
            obj.topic_tid = state.topic && state.topic.tid ? String(state.topic.tid) : "";
            obj.topic_title = state.topic && state.topic.title ? String(state.topic.title) : "";
            if (local.quote) {
              obj.quote = local.quote; obj.quote_text = local.quote; obj.quoteText = local.quote;
              obj.quoteUser = local.quoteUser || ""; obj.replyUser = local.quoteUser || "";
              obj.quote_uid = local.quoteUid || ""; obj.quoteUid = local.quoteUid || ""; obj.reply_to_uid = local.quoteUid || ""; obj.replyToUid = local.quoteUid || "";
              obj.quote_msg_id = local.quoteMsgId || ""; obj.quoteMsgId = local.quoteMsgId || ""; obj.reply_to_msg_id = local.quoteMsgId || ""; obj.replyToMsgId = local.quoteMsgId || "";
              obj.quote_type = local.quoteType || "text"; obj.quoteType = local.quoteType || "text";
              obj.quote_media_url = local.quoteMediaUrl || ""; obj.quoteMediaUrl = local.quoteMediaUrl || ""; obj.quote_audio_url = local.quoteAudioUrl || ""; obj.quoteAudioUrl = local.quoteAudioUrl || "";
            }
            if (mentionUids.length) {
              obj.mention_uids = mentionUids; obj.mentionUids = mentionUids; obj.at_uids = mentionUids; obj.atUsers = mentionUids; obj.at = mentionUids; obj.is_at = 1; obj.mention_type = "users";
            }
            return typeof p === "string" ? JSON.stringify(obj) : obj;
          } catch (_) { return p; }
        };
      }
      var sent = window.wk.WKSDK.shared().chatManager.send(content, channel);
      local.sending = false;
      if (sent) {
        local.wkMsg = sent;
        var clientNo = sent.clientMsgNo || sent.client_msg_no || "";
        if (clientNo) { delete state.msgMap[local.id]; local.id = String(clientNo); state.msgMap[local.id] = local; }
      }
      if (CONFIG.notifyUrl && mentionUids.length) {
        try {
          bridgePost(CONFIG.notifyUrl, { tid: state.topic.tid, cid: state.topic.cid, channel_id: state.channelId, quote_uid: local.quoteUid || "", quote_msg_id: local.quoteMsgId || "", quote_text: local.quote || "", quote_user: local.quoteUser || "", message_id: local.id || "", client_msg_no: local.id || "", message_text: originalText, mention_uids: mentionUids, text: originalText }).catch(function(){});
        } catch (_) {}
      }
      touchTopicActivity(local); touchMsg(local); queueRender("bottom"); saveCacheSoon();
    } catch (e) {
      local.sending = false; local.failed = true; touchMsg(local); warn("send", e); toast("发送失败：" + String(e.message || e).slice(0, 80)); queueRender("keep");
    } finally { state.sendLock = false; }
  }

  function readFile(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function (e) { resolve(e.target.result); };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }
  function loadImage(src) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = reject;
      img.src = src;
    });
  }
  function ensureImageCompressionLib() {
    if (window.imageCompression) return Promise.resolve(window.imageCompression);
    if (window.__cpImageCompressionLoading) return window.__cpImageCompressionLoading;
    window.__cpImageCompressionLoading = new Promise(function (resolve) {
      var s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/browser-image-compression@2.0.2/dist/browser-image-compression.js";
      s.async = true;
      s.onload = function () { resolve(window.imageCompression || null); };
      s.onerror = function () { resolve(null); };
      document.head.appendChild(s);
    });
    return window.__cpImageCompressionLoading;
  }
  async function canEncode(type) {
    if (state.encodeSupport[type] !== undefined) return state.encodeSupport[type];
    var canvas = document.createElement("canvas");
    canvas.width = 1; canvas.height = 1;
    if (!canvas.toBlob) { state.encodeSupport[type] = false; return false; }
    var ok = await new Promise(function (resolve) { canvas.toBlob(function (blob) { resolve(!!blob && blob.type === type); }, type, 0.8); });
    state.encodeSupport[type] = ok;
    return ok;
  }
  function extForMime(type) {
    if (type === "image/webp") return ".webp";
    if (type === "image/png") return ".png";
    if (type === "audio/ogg") return ".ogg";
    if (type === "audio/mp4") return ".m4a";
    return ".jpg";
  }
  async function compressWithCanvas(file, targetType) {
    var dataUrl = await readFile(file);
    var img = await loadImage(dataUrl);
    var w = img.naturalWidth || img.width;
    var h = img.naturalHeight || img.height;
    var scale = Math.min(1, IMAGE_CONFIG.maxSide / Math.max(w, h));
    w = Math.max(1, Math.round(w * scale));
    h = Math.max(1, Math.round(h * scale));
    var canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    var ctx = canvas.getContext("2d");
    if (!ctx || !canvas.toBlob) return null;
    ctx.drawImage(img, 0, 0, w, h);
    var targetBytes = IMAGE_CONFIG.maxSizeMB * 1024 * 1024;
    var qualities = [IMAGE_CONFIG.quality, 0.52, 0.45, 0.38];
    var best = null;
    for (var i = 0; i < qualities.length; i++) {
      var blob = await new Promise(function (resolve) { canvas.toBlob(resolve, targetType, qualities[i]); });
      if (!blob) continue;
      best = blob;
      if (blob.size <= targetBytes) break;
    }
    return best;
  }
  async function compressImage(file) {
    if (!file || !/^image\//i.test(file.type)) return file;
    if (/image\/(gif|svg\+xml)/i.test(file.type)) return file;
    if (file.size < IMAGE_CONFIG.minCompressBytes) return file;
    var targetType = IMAGE_CONFIG.useWebp && (await canEncode("image/webp")) ? "image/webp" : "image/jpeg";
    var baseName = String(file.name || ("image-" + Date.now())).replace(/\.[^.]+$/, "");
    try {
      var imageCompression = await ensureImageCompressionLib();
      if (imageCompression) {
        var blob = await imageCompression(file, {
          maxSizeMB: IMAGE_CONFIG.maxSizeMB,
          maxWidthOrHeight: IMAGE_CONFIG.maxSide,
          useWebWorker: true,
          fileType: targetType,
          initialQuality: IMAGE_CONFIG.quality,
          alwaysKeepResolution: false,
          preserveExif: false
        });
        if (blob && blob.size > 0 && blob.size < file.size * 0.98) {
          return new File([blob], baseName + extForMime(targetType), { type: targetType, lastModified: Date.now() });
        }
      }
    } catch (err) { warn("lib-image-compress", err); }
    try {
      var blob2 = await compressWithCanvas(file, targetType);
      if (!blob2 || blob2.size >= file.size * 0.98) return file;
      return new File([blob2], baseName + extForMime(targetType), { type: targetType, lastModified: Date.now() });
    } catch (err2) { warn("compress-image", err2); return file; }
  }
  async function compressVideo(file, maxSizeThreshold, maxDuration) {
    maxSizeThreshold = maxSizeThreshold || VIDEO_CONFIG.maxSizeThreshold;
    maxDuration = maxDuration || VIDEO_CONFIG.maxDuration;
    if (!file || !/^video\//i.test(file.type)) return file;
    if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) return file;
    var inputUrl = URL.createObjectURL(file);
    try {
      var video = document.createElement("video");
      video.src = inputUrl; video.muted = true; video.playsInline = true;
      await new Promise(function (resolve, reject) { video.onloadedmetadata = resolve; video.onerror = reject; });
      if (video.duration > maxDuration) { var tooLong = new Error("视频过长，最多 " + maxDuration + " 秒"); tooLong.code = "VIDEO_TOO_LONG"; throw tooLong; }
      if (file.size <= maxSizeThreshold) return file;
      if (video.videoWidth === 0 || video.videoHeight === 0) throw new Error("视频无效");
      var scale = Math.min(1, VIDEO_CONFIG.maxWidth / Math.max(1, video.videoWidth));
      var width = Math.max(2, Math.round(video.videoWidth * scale));
      var height = Math.max(2, Math.round(video.videoHeight * scale));
      var canvas = document.createElement("canvas");
      canvas.width = width; canvas.height = height;
      var ctx = canvas.getContext("2d");
      if (!ctx) return file;
      var canvasStream = canvas.captureStream(VIDEO_CONFIG.fps);
      var audioTracks = [];
      try { if (video.captureStream) audioTracks = Array.prototype.slice.call(video.captureStream().getAudioTracks()); } catch (_) {}
      var outputStream = new MediaStream(Array.prototype.slice.call(canvasStream.getVideoTracks()).concat(audioTracks));
      var mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp8,opus") ? "video/webm;codecs=vp8,opus" : "video/webm";
      var chunks = [];
      var recorder = new MediaRecorder(outputStream, { mimeType: mimeType, videoBitsPerSecond: VIDEO_CONFIG.videoBitsPerSecond, audioBitsPerSecond: VIDEO_CONFIG.audioBitsPerSecond });
      recorder.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
      var drawing = true;
      var draw = function () { if (!drawing) return; try { ctx.drawImage(video, 0, 0, width, height); } catch (_) {} if (!video.paused && !video.ended) requestAnimationFrame(draw); };
      var finished = new Promise(function (resolve) { recorder.onstop = resolve; });
      recorder.start(500);
      await video.play();
      draw();
      await new Promise(function (resolve) { video.onended = resolve; video.onerror = resolve; });
      drawing = false;
      recorder.stop();
      await finished;
      var blob = new Blob(chunks, { type: mimeType });
      if (!blob.size || blob.size >= file.size) return file;
      return new File([blob], String(file.name || "video-" + Date.now()).replace(/\.[^.]+$/, ".webm"), { type: blob.type || "video/webm", lastModified: Date.now() });
    } catch (err) {
      warn("compress-video", err);
      if (err && err.code === "VIDEO_TOO_LONG") throw err;
      return file;
    } finally { URL.revokeObjectURL(inputUrl); }
  }

  function parseUploadUrl(rawText) {
    var raw = typeof rawText === "string" ? rawText : JSON.stringify(rawText || "");
    var json = null;
    try { json = typeof rawText === "string" ? JSON.parse(rawText) : rawText; } catch (_) {}
    var candidates = [];
    function add(v) {
      v = String(v || "").trim();
      if (!v || /^data:/i.test(v)) return;
      if (/^(?:https?:)?\/\//i.test(v) || /^\/?(?:assets\/uploads|uploads)\//i.test(v)) candidates.push(v);
    }
    function scan(o) {
      if (!o) return;
      if (typeof o === "string") return add(o);
      if (Array.isArray(o)) return o.forEach(scan);
      if (typeof o === "object") {
        ["url","path","src","href","thumbnail","location","file","filename","image","video","voice"].forEach(function (k) { add(o[k]); });
        Object.keys(o).forEach(function (k) { if (k !== "raw" && k !== "base64") scan(o[k]); });
      }
    }
    scan(json);
    var m;
    if ((m = raw.match(/!\[[^\]]*\]\(([^)]+)\)/))) add(m[1]);
    if ((m = raw.match(/\[(?:图片|视频|语音消息|语音)\]\(([^)]+)\)/))) add(m[1]);
    var matches = raw.match(/(?:https?:)?\/\/[^\s"'<>]+|\/assets\/uploads\/[^\s"'<>]+|\/uploads\/[^\s"'<>]+/g);
    if (matches) matches.forEach(add);
    for (var i = 0; i < candidates.length; i++) {
      var u = candidates[i];
      if (/^\/\//.test(u)) u = location.protocol + u;
      if (!/^https?:\/\//i.test(u) && u.charAt(0) !== "/") u = "/" + u;
      if (u && !/\/api\/post\/upload(?:\?|$)/.test(u)) return u;
    }
    return "";
  }
  function xhrUpload(url, file, onProgress) {
    return new Promise(function (resolve, reject) {
      var fd = new FormData(); fd.append("files[]", file, file.name || "cp_" + Date.now());
      var xhr = new XMLHttpRequest(); xhr.open("POST", url); xhr.withCredentials = true;
      if (window.config) xhr.setRequestHeader("x-csrf-token", config.csrf_token || config.csrfToken || "");
      xhr.upload.onprogress = function (e) { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
      xhr.onload = function () {
        if (xhr.status >= 200 && xhr.status < 300) {
          var parsed = parseUploadUrl(xhr.responseText);
          if (!parsed) return reject(new Error("upload url empty"));
          resolve(parsed);
        } else reject(new Error("upload failed " + xhr.status));
      };
      xhr.onerror = function () { reject(new Error("network error")); };
      xhr.send(fd);
    });
  }
  async function uploadToNodeBB(file, onProgress) {
    var direct = (window.config && config.relative_path ? config.relative_path : "") + "/api/post/upload";
    var bridge = CONFIG.uploadUrl || "/bridge/upload";
    try { return await xhrUpload(CONFIG.uploadDirectFirst ? direct : bridge, file, onProgress); }
    catch (e) { warn("upload-first", e); return await xhrUpload(CONFIG.uploadDirectFirst ? bridge : direct, file, onProgress); }
  }
  async function onPickMedia(e) {
    var files = Array.prototype.slice.call(e.target.files || []);
    if (!files.length) return;
    var pWrap = byId("cp-topic-upload-progress-wrap"), pBar = byId("cp-topic-upload-progress-bar");
    try {
      for (var i = 0; i < files.length; i++) {
        if (pWrap) pWrap.hidden = false; if (pBar) pBar.style.width = "0%";
        var original = files[i];
        var f = original;
        if (/^image\//i.test(original.type || "")) {
          toast("正在压缩图片...");
          f = await compressImage(original);
        } else if (/^video\//i.test(original.type || "")) {
          toast("正在处理视频...");
          f = await compressVideo(original, VIDEO_CONFIG.maxSizeThreshold, VIDEO_CONFIG.maxDuration);
          if (f.size > VIDEO_CONFIG.maxSizeThreshold * 1.5) { toast("视频过大，建议压缩后再发"); }
        }
        toast(f !== original ? "压缩完成，正在上传..." : "正在上传...");
        var url = await uploadToNodeBB(f, function (pct) { if (pBar) pBar.style.width = pct * 100 + "%"; });
        if (/^image\//i.test(f.type || original.type || "")) await sendTopicText("![](" + url + ")", { allowTranslate: false });
        else if (/^video\//i.test(f.type || original.type || "")) await sendTopicText("[视频](" + url + ")", { allowTranslate: false });
        else await sendTopicText("[文件](" + url + ")", { allowTranslate: false });
      }
    } catch (err) { warn("pick-media", err); toast(String(err && err.code === "VIDEO_TOO_LONG" ? err.message : ("上传失败：" + String(err.message || err).slice(0, 60)))); }
    finally { if (pWrap) pWrap.hidden = true; if (pBar) pBar.style.width = "0%"; e.target.value = ""; }
  }

  function toggleUIForRecording(isRec) {
    byId("cp-topic-toolbar-inputs").hidden = isRec;
    byId("cp-topic-rec-inline").hidden = !isRec;
    updateFooterHeight();
  }
  function getSupportedMimeType() {
    if (!window.MediaRecorder || typeof MediaRecorder.isTypeSupported !== "function") return "";
    var types = ["audio/webm;codecs=opus","audio/webm","audio/ogg;codecs=opus","audio/ogg"];
    for (var i = 0; i < types.length; i++) if (MediaRecorder.isTypeSupported(types[i])) return types[i];
    return "";
  }
  function createAudioRecorder(stream) {
    var mime = getSupportedMimeType();
    try { return new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 16000 } : { audioBitsPerSecond: 16000 }); }
    catch (_) { return mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream); }
  }
  function renderRecBars() {
    var el = byId("cp-topic-rec-bars"); if (!el) return;
    el.innerHTML = [5,8,12,16,10,7,14,9].map(function (h, i) { return '<i style="height:' + h + 'px;animation-delay:' + (i * 0.04) + 's"></i>'; }).join("");
  }
  async function startRecording() {
    if (!navigator.mediaDevices || !window.MediaRecorder) { toast("当前浏览器不支持录音"); return; }
    try {
      var stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      state.rec.stream = stream; state.rec.chunks = []; state.rec.sec = 0; state.rec.paused = false; state.rec.shouldSend = false; state.rec.mediaRecorder = createAudioRecorder(stream);
      byId("cp-topic-rec-time").textContent = "0:00";
      state.rec.mediaRecorder.ondataavailable = function (ev) { if (ev.data && ev.data.size > 0) state.rec.chunks.push(ev.data); };
      state.rec.mediaRecorder.onstop = async function () {
        try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (_) {}
        clearInterval(state.rec.timer); state.rec.timer = null; toggleUIForRecording(false); updateSendButton();
        if (state.rec.shouldSend && state.rec.chunks.length) {
          var pWrap = byId("cp-topic-upload-progress-wrap"), pBar = byId("cp-topic-upload-progress-bar");
          try {
            var mime = state.rec.mediaRecorder.mimeType || "audio/webm";
            var ext = mime.indexOf("ogg") > -1 ? "ogg" : "webm";
            var file = new File([new Blob(state.rec.chunks, { type: mime })], "voice_" + Date.now() + "." + ext, { type: mime });
            if (pWrap) pWrap.hidden = false; if (pBar) pBar.style.width = "0%";
            var url = await uploadToNodeBB(file, function (pct) { if (pBar) pBar.style.width = pct * 100 + "%"; });
            await sendTopicText("[语音消息](" + url + ")", { allowTranslate: false, duration: state.rec.sec });
          } catch (e) { warn("record-upload", e); toast("语音发送失败"); }
          finally { if (pWrap) pWrap.hidden = true; if (pBar) pBar.style.width = "0%"; }
        }
      };
      renderRecBars(); toggleUIForRecording(true);
      state.rec.mediaRecorder.start(250);
      state.rec.timer = setInterval(function () {
        if (state.rec.paused) return;
        state.rec.sec++; byId("cp-topic-rec-time").textContent = formatDuration(state.rec.sec);
        if (state.rec.sec >= (state.cfg.voiceMaxDuration || 60)) stopRecording(true);
      }, 1000);
    } catch (e) { warn("record", e); toast("录音不可用或被拒绝"); }
  }
  function stopRecording(shouldSend) {
    if (!state.rec.mediaRecorder || state.rec.mediaRecorder.state === "inactive") return;
    state.rec.shouldSend = !!shouldSend; state.rec.mediaRecorder.stop();
  }
  function togglePauseRecording() {
    var mr = state.rec.mediaRecorder; if (!mr) return;
    var icon = byId("cp-topic-rec-pause").querySelector("i");
    if (mr.state === "recording") { mr.pause(); state.rec.paused = true; if (icon) icon.className = "fa fa-play-circle"; }
    else if (mr.state === "paused") { mr.resume(); state.rec.paused = false; if (icon) icon.className = "fa fa-pause-circle"; }
  }
  function onAudioEnded() {
    if (state.currentAudioEl) {
      state.currentAudioEl.classList.remove("playing");
      var icon = state.currentAudioEl.querySelector(".cp-play-circle");
      if (icon) icon.innerHTML = '<i class="fa fa-play"></i>';
    }
    state.currentAudioEl = null;
  }
  function playVoice(msg, el) {
    if (el && el.classList.contains("cp-lazy-audio")) loadLazyElement(el);
    var src = toPlayableUrl((el && el.getAttribute("data-audio-src")) || (msg && (msg.audioUrl || msg.mediaUrl)) || "");
    if (!src) return toast("语音地址为空");
    if (state.currentAudioEl && state.currentAudioEl !== el) onAudioEnded();
    if (state.currentAudioEl === el && !state.audio.paused) { state.audio.pause(); onAudioEnded(); return; }
    state.audio.src = src;
    state.audio.play().then(function () {
      state.currentAudioEl = el;
      if (el) { el.classList.add("playing"); var icon = el.querySelector(".cp-play-circle"); if (icon) icon.innerHTML = '<i class="fa fa-pause"></i>'; }
    }).catch(function (e) { warn("play-voice", e); toast("语音播放失败"); });
  }
  function openPreview(msg) {
    var mask = byId("cp-topic-preview-mask"), body = byId("cp-topic-preview-body");
    if (!mask || !body || !msg) return;
    if (msg.type === "image") body.innerHTML = '<img src="' + escAttr(toPlayableUrl(msg.mediaUrl)) + '">';
    else if (msg.type === "video") body.innerHTML = '<video src="' + escAttr(toPlayableUrl(msg.mediaUrl)) + '" controls autoplay playsinline></video><div class="cp-preview-exit-zone" data-act="close-preview"><span>点击底部退出播放</span></div>';
    mask.hidden = false; state.previewOpen = true;
  }
  function closePreview() {
    var body = byId("cp-topic-preview-body"), mask = byId("cp-topic-preview-mask");
    if (body) body.innerHTML = ""; if (mask) mask.hidden = true; state.previewOpen = false;
  }

  function showQuoteBar(msg) {
    state.quoteTarget = msg || null;
    var bar = byId("cp-topic-quote-preview");
    if (!bar || !msg) return;
    byId("cp-topic-quote-name").textContent = displayNameForMessage(msg) || msg.username || "引用";
    byId("cp-topic-quote-text").textContent = getQuotePreviewText(msg) || "[引用消息]";
    bar.hidden = false; byId("cp-topic-input").focus(); updateFooterHeight();
  }
  function hideQuoteBar() {
    state.quoteTarget = null;
    var bar = byId("cp-topic-quote-preview"); if (bar) bar.hidden = true;
    updateFooterHeight();
  }
  function insertMention(msg) {
    if (!msg) return;
    var input = byId("cp-topic-input"), name = displayNameForMessage(msg).replace(/\s+/g, "");
    if (msg.uid) {
      var uid = String(msg.uid);
      if (state.pendingMentionUids.indexOf(uid) < 0) state.pendingMentionUids.push(uid);
      state.pendingMentionMap[uid] = { uid: uid, username: msg.username || name, displayname: displayNameForMessage(msg) || name };
      toast("已 @" + name);
    }
    input.value = String(input.value || "") + (input.value ? " " : "") + "@" + name + " ";
    input.dispatchEvent(new Event("input", { bubbles: true })); input.focus();
  }
  function deleteLocalMessage(id) {
    if (!id) return;
    state.messages = state.messages.filter(function (m) { return String(m.id) !== String(id); });
    delete state.msgMap[id]; saveCacheSoon(); queueRender("keep");
  }
  function saveMediaMessage(msg) {
    var url = toPlayableUrl(msg && (msg.mediaUrl || msg.audioUrl || ""));
    if (!url) return toast("没有可保存的媒体");
    var a = document.createElement("a"); a.href = url; a.download = (msg.type || "media") + "-" + Date.now(); a.target = "_blank"; document.body.appendChild(a); a.click(); setTimeout(function(){ a.remove(); }, 300);
  }
  function showContextMenu(msg) {
    state.contextMsg = msg;
    var overlay = byId("cp-topic-context-overlay"), menu = byId("cp-topic-context-menu");
    var saveBtn = (msg.type === "image" || msg.type === "video") ? '<button class="cp-menu-item" data-menu-act="save" type="button"><i class="fa fa-download"></i><span>保存</span></button>' : "";
    menu.innerHTML =
      '<button class="cp-menu-item" data-menu-act="reply" type="button"><i class="fa fa-reply"></i><span>回复</span></button>' +
      '<button class="cp-menu-item" data-menu-act="mention" type="button"><i class="fa fa-at"></i><span>@TA</span></button>' +
      '<button class="cp-menu-item" data-menu-act="translate" type="button"><i class="fa fa-language"></i><span>翻译</span></button>' + saveBtn +
      '<button class="cp-menu-item danger" data-menu-act="delete" type="button"><i class="fa fa-trash"></i><span>删除</span></button>';
    overlay.hidden = false;
  }
  function hideContextMenu() { byId("cp-topic-context-overlay").hidden = true; state.contextMsg = null; }

  function pushMentionNotice(msg) {
    var type = getMentionNoticeType(msg);
    if (!type || !msg || !msg.id) return;
    var id = String(msg.id);
    if ((state.mentionNotices || []).some(function (n) { return String(n.id) === id; })) return;
    var who = displayNameForMessage(msg) || msg.username || "有人";
    state.mentionNotices = [{ id: id, type: type, text: type === "reply" ? (who + " 回复了你") : (who + " @了你"), ts: Date.now() }].concat(state.mentionNotices || []).slice(0, 30);
    toast(state.mentionNotices[0].text); updateMentionBanner();
    try { if (navigator.vibrate) navigator.vibrate([35, 45, 35]); } catch (_) {}
  }
  function updateMentionBanner() {
    var banner = byId("cp-topic-at-banner"), txt = byId("cp-topic-at-banner-text"), n = (state.mentionNotices || [])[0];
    if (!banner || !txt) return;
    if (!n) { banner.hidden = true; return; }
    banner.setAttribute("data-mid", n.id); txt.textContent = (state.mentionNotices.length > 1 ? (state.mentionNotices.length + "条提醒 · ") : "") + n.text; banner.hidden = false;
  }
  function scrollToMessageId(mid) {
    var safe = String(mid || "").replace(/"/g, '\\"');
    var row = document.querySelector('#cp-topic-msg-list .cp-row[data-mid="' + safe + '"]');
    if (!row) return toast("这条消息还没加载到屏幕");
    row.scrollIntoView({ behavior: "smooth", block: "center" });
    var bubble = row.querySelector(".cp-bubble");
    if (bubble) { bubble.classList.add("cp-mention-me"); setTimeout(function () { bubble.classList.remove("cp-mention-me"); }, 1600); }
    state.mentionNotices = (state.mentionNotices || []).filter(function (n) { return String(n.id) !== String(mid); }); updateMentionBanner();
  }
  function fetchRemoteNotices() {
    if (!CONFIG.notifyListUrl || !state.topic || !state.uid) return;
    fetchWithTimeout(CONFIG.notifyListUrl + "?tid=" + encodeURIComponent(state.topic.tid) + "&after=" + encodeURIComponent(state.notifyVersion || 0) + "&_=" + Date.now(), { credentials: "include", cache: "no-store" }, 12000)
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j) return;
        if (j.version != null) state.notifyVersion = Math.max(Number(state.notifyVersion || 0), Number(j.version || 0));
        (Array.isArray(j.list) ? j.list : []).forEach(function (n) {
          var id = String(n.message_id || n.msg_id || n.client_msg_no || n.id || Math.random());
          if ((state.mentionNotices || []).some(function (x) { return String(x.id) === id; })) return;
          state.mentionNotices = [{ id: id, type: n.type || "mention", text: n.text || ((n.from_name || "有人") + " @了你"), ts: Date.now() }].concat(state.mentionNotices || []).slice(0, 30);
          updateMentionBanner(); toast(state.mentionNotices[0].text);
        });
      }).catch(function (e) { warn("remote-notices", e); });
  }
  function startNotifyPolling() {
    stopNotifyPolling();
    fetchRemoteNotices();
    state.notifyPollTimer = setInterval(function () {
      if (document.visibilityState !== "visible") return;
      fetchRemoteNotices();
    }, 60000);
  }
  function stopNotifyPolling() { if (state.notifyPollTimer) clearInterval(state.notifyPollTimer); state.notifyPollTimer = null; }
  function pingTopicPresence() {
    if (!CONFIG.presencePingUrl || !state.topic || !state.uid) return;
    try {
      bridgePost(CONFIG.presencePingUrl, { tid: state.topic.tid, cid: state.topic.cid, channel_id: state.channelId }, 8000).catch(function(){});
    } catch (_) {}
  }
  function fetchTopicPresence() {
    if (!CONFIG.presenceUrl || !state.topic) return;
    fetchWithTimeout(CONFIG.presenceUrl + "?tid=" + encodeURIComponent(state.topic.tid) + "&_=" + Date.now(), { credentials: "include", cache: "no-store" }, 8000)
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { if (j) { state.onlineCount = Number(j.count || 0); updateHeader(); } }).catch(function(){});
  }
  function startPresence() {
    stopPresence();
    pingTopicPresence(); fetchTopicPresence();
    state.presenceTimer = setInterval(function () { if (document.visibilityState === "visible") pingTopicPresence(); }, 60000);
    state.presencePollTimer = setInterval(function () { if (document.visibilityState === "visible") fetchTopicPresence(); }, 45000);
  }
  function stopPresence() {
    if (state.presenceTimer) clearInterval(state.presenceTimer);
    if (state.presencePollTimer) clearInterval(state.presencePollTimer);
    state.presenceTimer = null; state.presencePollTimer = null;
  }
  function touchTopicActivity(msg) {
    if (!CONFIG.activityTouchUrl || !state.topic) return;
    var k = String(state.topic.tid || "");
    if (Date.now() - Number((state.lastActivityTouch || {})[k] || 0) < 5000) return;
    state.lastActivityTouch[k] = Date.now();
    try {
      bridgePost(CONFIG.activityTouchUrl, { tid: state.topic.tid, cid: state.topic.cid, title: state.topic.title, channel_id: state.channelId, text: msg && (msg.serverText || msg.text || "") }, 8000).catch(function(){});
    } catch (_) {}
  }
  async function compressBackgroundToDataUrl(file) {
    if (!file || !/^image\//i.test(file.type)) throw new Error("请选择图片文件");
    var dataUrl = await readFile(file);
    var img = await loadImage(dataUrl);
    var w = img.naturalWidth || img.width;
    var h = img.naturalHeight || img.height;
    var maxSide = 1600;
    var scale = Math.min(1, maxSide / Math.max(w, h));
    w = Math.max(1, Math.round(w * scale));
    h = Math.max(1, Math.round(h * scale));
    var canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    var ctx = canvas.getContext("2d");
    if (!ctx) return dataUrl;
    ctx.drawImage(img, 0, 0, w, h);
    var type = (await canEncode("image/webp")) ? "image/webp" : "image/jpeg";
    var qualityList = [0.82, 0.72, 0.62, 0.52];
    var best = "";
    for (var i = 0; i < qualityList.length; i++) {
      best = canvas.toDataURL(type, qualityList[i]);
      if (best.length < 1800 * 1024) break;
    }
    return best || dataUrl;
  }

  function applyBackground() {
    var bg = byId("cp-topic-bg"), root = byId(ROOT_ID);
    if (!state.bg) state.bg = cloneJSON(DEFAULT_BG);
    if (bg) bg.style.backgroundImage = state.bg.dataUrl ? "url(" + state.bg.dataUrl + ")" : "";
    if (root) { root.style.setProperty("--cp-bg-dim", String(Math.min(Number(state.bg.opacity || DEFAULT_BG.opacity), 0.45))); root.style.setProperty("--cp-bg-blur", String(Number(state.bg.blur || 0)) + "px"); }
    document.body.classList.toggle("cp-topic-has-bg", !!state.bg.dataUrl);
  }
  async function handleBackgroundUpload(e) {
    var file = e && e.target && e.target.files && e.target.files[0];
    if (!file) return;
    try {
      toast("正在处理背景图...");
      var dataUrl = await compressBackgroundToDataUrl(file);
      state.bg = { dataUrl: dataUrl, opacity: state.bg && state.bg.opacity != null ? Math.min(Number(state.bg.opacity), 0.45) : DEFAULT_BG.opacity, blur: state.bg && state.bg.blur != null ? Number(state.bg.blur) : DEFAULT_BG.blur };
      saveJSON(KEY_BG, state.bg);
      applyBackground();
      syncTranslateUI();
      toast("背景已保存到本机");
    } catch (err) {
      warn("background-upload", err);
      toast("背景设置失败：" + String(err.message || err).slice(0, 60));
    } finally {
      if (e && e.target) e.target.value = "";
    }
  }

  async function mount() {
    if (state.mounted || !isTargetTopic()) return;
    state.topic = getTopicInfo(); state.channelId = channelIdOf(state.topic);
    state.uid = ""; state.messages = []; state.msgMap = {}; state.newestSeq = 0; state.oldestSeq = 0; state.hasNoMore = false; state.loadingHistory = false; state.unread = 0; state.wkReady = false; state.connectStarted = false; state.renderLimit = INITIAL_RENDER_LIMIT; state.mentionNotices = []; state.pendingRenderMode = ""; state.userBatchInflight = {}; state.mergedUserCache = {}; state.avatarHashCache = {}; state.offlineInflight = false;
    state.cfg = normalizeConfig(await loadJSON(KEY_CFG, DEFAULT_CFG)); state.bg = await loadJSON(KEY_BG, DEFAULT_BG);
    await loadUserCacheLocal();
    injectStyle(); injectRoot(); bindUI(); applyBackground(); renderRecBars(); document.body.classList.add(BODY_CLASS);
    state.mounted = true; initLazyObserver(); updateViewport(); updateFooterHeight(); updateHeader();
    await loadCacheDbAndMerge(); queueResolveUsersFromMessages(state.messages); queueRender("bottom");
    try {
      setStatus("连接中");
      await getToken(); await ensureTopicChannel();
      connectWk().catch(function (e) { warn("connect", e); setStatus("离线", "悟空 WebSocket 未连接：" + String(e.message || e).slice(0, 120)); });
      startPresence(); startNotifyPolling(); fetchHistory(false).catch(function (e) { warn("first-history", e); });
    } catch (e) {
      warn("mount", e); setStatus("离线", "后端频道订阅或 token 未成功：" + String(e.message || e).slice(0, 120));
    }
  }
  function unmount() {
    if (!state.mounted) return;
    saveCacheDb(); stopPresence(); stopNotifyPolling();
    if (state.uiAbort) { try { state.uiAbort.abort(); } catch (_) {} state.uiAbort = null; }
    clearTimeout(state.userBatchTimer); if (state.lazyObserver) state.lazyObserver.disconnect(); state.lazyObserver = null;
    try { state.audio.pause(); } catch (_) {}
    try {
      if (state.rec.mediaRecorder && state.rec.mediaRecorder.state !== "inactive") { state.rec.shouldSend = false; state.rec.mediaRecorder.stop(); }
      if (state.rec.stream) state.rec.stream.getTracks().forEach(function (t) { t.stop(); });
    } catch (_) {}
    clearInterval(state.rec.timer); state.rec.timer = null;
    var root = byId(ROOT_ID); if (root) root.remove();
    document.body.classList.remove(BODY_CLASS, "cp-topic-chat-on-v13", "cp-topic-chat-on-v14", "cp-topic-chat-on-v18", "cp-topic-chat-on-v20", "cp-topic-has-bg");
    state.mounted = false;
  }
  function boot() {
    clearTimeout(state.bootTimer);
    state.bootTimer = setTimeout(function () { if (isTargetTopic()) mount(); else unmount(); }, 80);
  }

  if (window.jQuery) {
    $(boot);
    $(window).on("action:ajaxify.end action:topic.loaded", function () { setTimeout(boot, 80); setTimeout(boot, 300); setTimeout(boot, 650); });
    window.addEventListener("pageshow", boot);
    window.addEventListener("popstate", function () { setTimeout(boot, 120); });
  } else {
    document.addEventListener("DOMContentLoaded", boot);
    window.addEventListener("load", boot);
  }

  window.cpTopicChatDebug = {
    state: state,
    version: "v29-idb-sdk-stable",
    renderNow: function () { queueRender("keep"); },
    forceBottom: forceBottom,
    parseUploadUrl: parseUploadUrl
  };
})();


/* Optional category 7 visual sort by WuKong topic chat activity. No polling; runs after page load/ajaxify only. */
(function () {
  "use strict";
  if (window.__cpCategory7ActivitySortV28Stable) return;
  window.__cpCategory7ActivitySortV28Stable = true;
  var CID = 7;
  function isCat7() {
    return document.body && document.body.classList.contains("page-category") && /\/category\/7(?:\/|$)/.test(location.pathname);
  }
  function tidFromHref(href) {
    var m = String(href || "").match(/\/topic\/(\d+)/);
    return m ? m[1] : "";
  }
  function findTopicRows() {
    var anchors = Array.prototype.slice.call(document.querySelectorAll('a[href*="/topic/"]'));
    var rows = [], seen = {};
    anchors.forEach(function (a) {
      var tid = tidFromHref(a.getAttribute("href"));
      if (!tid || seen[tid]) return;
      var row = a.closest('[component="category/topic"], [component="topic"], li, .card, .category-item, .topic-row');
      if (!row || !row.parentNode) return;
      seen[tid] = true;
      rows.push({ tid: tid, row: row, parent: row.parentNode });
    });
    return rows;
  }
  var lastFetchAt = 0;
  async function sortByActivity() {
    if (!isCat7()) return;
    var n = Date.now();
    if (n - lastFetchAt < 8000) return;
    lastFetchAt = n;
    var rows = findTopicRows();
    if (!rows.length) return;
    var res = await fetch('/bridge/topic-activity?cid=' + CID, { credentials: 'include', cache: 'no-store' }).catch(function () { return null; });
    if (!res || !res.ok) return;
    var json = await res.json().catch(function () { return null; });
    var list = (json && json.list) || [];
    var map = {};
    list.forEach(function (x) { map[String(x.tid)] = Number(x.last_chat_at || 0); });
    rows.sort(function (a, b) { return (map[b.tid] || 0) - (map[a.tid] || 0); });
    rows.forEach(function (x) { if (x.parent && x.row) x.parent.appendChild(x.row); });
  }
  function boot() { setTimeout(sortByActivity, 450); }
  if (window.jQuery) $(window).on("action:ajaxify.end", boot);
  document.addEventListener("DOMContentLoaded", boot);
  window.addEventListener("load", boot);
  boot();
})();
