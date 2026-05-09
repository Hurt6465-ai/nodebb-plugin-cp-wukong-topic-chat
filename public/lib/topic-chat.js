/*
 * CP NodeBB Topic WuKong Chat - CID 7 - UI v22
 * 目标：帖子详情页 = 悟空话题聊天室；UI 贴近一对一聊天壳，带本地缓存、去重、AI/Google 翻译、译发。
 * 安装：NodeBB ACP -> Appearance -> Custom Content -> Custom Javascript，替换旧 cp-topic-wukong-cid7.js / v3。
 */
(function () {
  "use strict";

  var GLOBAL_KEY = "__cpTopicWukongCid7V22Inited";
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
    sdkUrl: "https://cdn.jsdelivr.net/npm/wukongimjssdk@latest/lib/wukongimjssdk.umd.js",
    historyLimit: 30,
    aiProxyUrl: "/bridge/ai/chat",
    googleProxyUrl: "/bridge/translate/google",
    uploadUrl: "/bridge/upload",
    // v12: 默认先走 NodeBB 原生上传，减少 bridge 流量；失败再走 bridge 兜底。
    uploadDirectFirst: true,
    activityTouchUrl: "/bridge/topic-activity/touch",
    presencePingUrl: "/bridge/topic-presence/ping",
    presenceUrl: "/bridge/topic-presence",
    notifyUrl: "/bridge/topic-notify",
    notifyListUrl: "/bridge/topic-notify/list",
    notifyDoneUrl: "/bridge/topic-notify/done",
    usersBatchUrl: "/bridge/nodebb-users",
    userCacheTtlMs: 30 * 24 * 3600 * 1000,
    debug: false
  };

  var ROOT_ID = "cp-topic-chat-root";
  var STYLE_ID = "cp-topic-chat-style-v22";
  var BODY_CLASS = "cp-topic-chat-on-v20";
  var DB_NAME = "CP_TOPIC_WUKONG_CACHE_V20";
  var STORE = "topics";
  var LS_PREFIX = "cp_topic_wk_cache_v20_";
  var MAX_CACHE = 220;
  var MAX_RENDER = 700;
  var BOTTOM_THRESHOLD = 120;
  var PENDING_TTL = 60000;
  var MEDIA_CACHE_MAX_BLOB_BYTES = 5 * 1024 * 1024;
  var MEDIA_CACHE_MAX_TOTAL_BYTES = 40 * 1024 * 1024;
  var MEDIA_CACHE_MAX_ITEMS = 240;
  var MEDIA_CACHE_EXPIRE_MS = 7 * 24 * 3600 * 1000;

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

  var VOICE_CONFIG = {
    fallbackMimeTypes: ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/ogg"],
    audioBitsPerSecond: 16000
  };
  var cacheTimer = null;
  var footerTimer = null;
  var dbPromise = null;


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
    "日本語": "ja", "한국어": "ko", "ภาษาไทย": "th", "Tiếng Việt": "vi", "Français":"fr", "Deutsch":"de", "Español":"es", "हिन्दी":"hi", "Русский": "ru"
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
    // 每条消息 payload 携带的轻量国旗标识，不查 IP，不增加服务器压力。
    ai: {
      endpoint: "https://api.openai.com/v1",
      apiKey: "",
      model: "gpt-4o-mini",
      temperature: 0.2,
      translatePrompt: DEFAULT_TRANSLATE_PROMPT
    }
  };

  var KEY_CFG = "cp_topic_wk_cfg_v20";
  var KEY_BG = "cp_topic_wk_bg_v20";
  var DEFAULT_BG = { dataUrl: "", opacity: 0.08, blur: 0 };
  var KEY_PENDING_NOTICE = "cp_topic_pending_notice_v25";
  var KEY_USER_CACHE = "cp_topic_wk_user_cache_v30";
  var USER_CACHE_TTL = CONFIG.userCacheTtlMs || (30 * 24 * 3600 * 1000);
  var USER_CACHE_MAX = 500;
  var USER_BATCH_MAX = 50;
  var userCacheTimer = null;

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
    connected: false,
    joinOk: false,
    connectStarted: false,
    loadingHistory: false,
    hasNoMore: false,
    messages: [],
    msgMap: {},
    newestSeq: 0,
    oldestSeq: 0,
    pendingMine: {},
    unread: 0,
    renderPending: false,
    stickToBottom: true,
    sendLock: false,
    statusText: "准备中",
    lastHistoryAt: 0,
    observerBound: false,
    cfg: null,
    bg: null,
    aiCache: {},
    aiCacheKeys: [],
    translateInflight: {},
    playedVoice: {},
    pendingMentionUids: [],
    pendingMentionMap: {},
    mentionNotices: [],
    lastMentionNoticeId: "",
    notifyVersion: 0,
    notifyPollTimer: null,
    globalNotifyPollTimer: null,
    remoteNoticeIds: {},
    replyNoticeIndex: {},
    replyNoticeQueue: [],
    audio: new Audio(),
    currentAudioEl: null,
    contextMsg: null,
    quoteTarget: null,
    userCache: {},
    userBatchPending: {},
    userBatchTimer: null,
    blobUrlCache: {},
    blobKeys: [],
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
    try { console.warn("[cp-topic-wukong-v9][" + scope + "]", err); } catch (_) {}
  }

  function log() {
    if (!CONFIG.debug) return;
    try {
      var args = Array.prototype.slice.call(arguments);
      args.unshift("[cp-topic-wukong-v9]");
      console.log.apply(console, args);
    } catch (_) {}
  }

  function byId(id) { return document.getElementById(id); }

  function esc(str) {
    return String(str == null ? "" : str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function escAttr(str) {
    return esc(str).replace(/"/g, "&quot;");
  }

  function normalizeText(str) {
    return String(str == null ? "" : str).replace(/\s+/g, " ").trim().slice(0, 800);
  }

  function loadJSON(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return cloneJSON(fallback);
      return mergeDeep(cloneJSON(fallback), JSON.parse(raw));
    } catch (e) { warn("load-json", e); return cloneJSON(fallback); }
  }

  function saveJSON(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { warn("save-json", e); }
  }

  function cloneJSON(obj) {
    return JSON.parse(JSON.stringify(obj || {}));
  }

  function mergeDeep(base, extra) {
    extra = extra || {};
    Object.keys(extra).forEach(function (k) {
      if (extra[k] && typeof extra[k] === "object" && !Array.isArray(extra[k]) && base[k] && typeof base[k] === "object") {
        mergeDeep(base[k], extra[k]);
      } else {
        base[k] = extra[k];
      }
    });
    return base;
  }

  function normalizeConfig(cfg) {
    cfg = mergeDeep(cloneJSON(DEFAULT_CFG), cfg || {});
    if (cfg.translateProvider !== "ai" && cfg.translateProvider !== "google") cfg.translateProvider = "google";
    if (!cfg.sourceLang) cfg.sourceLang = DEFAULT_CFG.sourceLang;
    if (!cfg.targetLang) cfg.targetLang = DEFAULT_CFG.targetLang;
    cfg.ai = mergeDeep(cloneJSON(DEFAULT_CFG.ai), cfg.ai || {});
    if (!cfg.ai.translatePrompt) cfg.ai.translatePrompt = DEFAULT_TRANSLATE_PROMPT;
    if (!Number.isFinite(Number(cfg.ai.temperature))) cfg.ai.temperature = 0.2;
    return cfg;
  }

  function getLangCode(lang, fallback) {
    if (!lang) return fallback || "auto";
    return LANG_CODE_MAP[lang] || lang || fallback || "auto";
  }

  function getFlag(lang) {
    for (var i = 0; i < LANG_LIST.length; i++) if (LANG_LIST[i].n === lang) return LANG_LIST[i].f;
    return "🌐";
  }

  function normalizeCountryFlag(v) {
    v = String(v || "").trim();
    // 只保存 1-4 个 emoji/字符，避免用户塞长文本进用户名位置。
    return v ? v.slice(0, 8) : "";
  }

  function flagForMessage(msg) {
    // v12：按你的要求不再在昵称旁显示“个人标识/国旗”。
    return "";
  }

  function fillTemplate(tpl, vars) {
    return String(tpl || "").replace(/{{\s*(\w+)\s*}}/g, function (_, k) {
      return vars && vars[k] != null ? String(vars[k]) : "";
    });
  }


  function now() { return Date.now(); }

  function formatTime(ms) {
    var d = new Date(ms || Date.now());
    var h = d.getHours();
    var suffix = h >= 12 ? "PM" : "AM";
    var hour12 = h % 12 || 12;
    return String(hour12) + ":" + String(d.getMinutes()).padStart(2, "0") + " " + suffix;
  }

  function formatDayLabel(ms) {
    var d = new Date(ms || Date.now());
    var nowDate = new Date();
    var today = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate()).getTime();
    var day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    var diff = Math.floor((today - day) / 86400000);
    if (diff === 0) return "今天";
    if (diff === 1) return "昨天";
    if (diff === 2) return "前天";
    if (d.getFullYear() === nowDate.getFullYear()) return (d.getMonth() + 1) + "月" + d.getDate() + "日";
    return d.getFullYear() + "年" + (d.getMonth() + 1) + "月" + d.getDate() + "日";
  }

  function formatTimeDivider(ms) {
    return formatDayLabel(ms) + " " + formatTime(ms);
  }

  function playedVoiceKey() {
    return "cp_topic_voice_played_v18_" + String(state.channelId || "");
  }

  function loadPlayedVoiceMap() {
    try {
      var raw = localStorage.getItem(playedVoiceKey());
      return raw ? JSON.parse(raw) || {} : {};
    } catch (_) { return {}; }
  }

  function savePlayedVoiceMap() {
    try { localStorage.setItem(playedVoiceKey(), JSON.stringify(state.playedVoice || {})); } catch (_) {}
  }
  function progressKey() { return "cp_topic_progress_v18"; }

  function loadProgressMap() {
    try { return JSON.parse(localStorage.getItem(progressKey()) || "{}") || {}; } catch (_) { return {}; }
  }

  function saveProgressMap() {
    try { localStorage.setItem(progressKey(), JSON.stringify(state.scrollProgress || {})); } catch (_) {}
  }

  function saveCurrentProgress() {
    if (!state.channelId) return;
    var main = byId("cp-topic-main");
    state.scrollProgress = state.scrollProgress || loadProgressMap();
    state.scrollProgress[state.channelId] = {
      scrollTop: main ? main.scrollTop : 0,
      newestSeq: state.newestSeq || 0,
      ts: Date.now()
    };
    saveProgressMap();
  }

  function restoreCurrentProgress() {
    var main = byId("cp-topic-main");
    if (!main || !state.channelId) return false;
    state.scrollProgress = state.scrollProgress || loadProgressMap();
    var p = state.scrollProgress[state.channelId];
    if (!p || !p.ts || Date.now() - p.ts > 7 * 24 * 3600 * 1000) return false;
    main.scrollTop = Math.max(0, Number(p.scrollTop || 0));
    return true;
  }


  function normalizeVoicePlayedKey(url) {
    url = toPlayableUrl(url || "");
    if (!url) return "";
    try {
      var u = new URL(url, location.origin);
      if (u.origin === location.origin) return u.pathname + u.search;
      return u.href;
    } catch (_) { return String(url || ""); }
  }

  function stableVoiceKeys(msg) {
    if (!msg) return [];
    var out = [];
    function add(v) { v = normalizeVoicePlayedKey(v || ""); if (v && out.indexOf(v) < 0) out.push(v); }
    add(msg.audioUrl || msg.mediaUrl || "");
    add(msg.serverText || "");
    add(msg.text || "");
    if (msg.seq) add("seq:" + msg.seq);
    if (msg.id) add("id:" + msg.id);
    return out;
  }

  function markVoicePlayed(msg) {
    if (!msg) return;
    state.playedVoice = state.playedVoice || {};
    stableVoiceKeys(msg).forEach(function (k) { state.playedVoice[k] = 1; });
    savePlayedVoiceMap();
  }

  function isVoicePlayed(msg) { return true; }

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
    return {
      tid: String(tid || ""),
      cid: Number(getCurrentCid() || 0),
      title: String(title || "话题聊天室"),
      url: location.pathname + location.search
    };
  }

  function isTargetTopic() {
    return document.body && document.body.classList.contains("page-topic") && getCurrentCid() === CONFIG.targetCid && !!getTopicInfo().tid;
  }

  function channelIdOf(topic) {
    return CONFIG.channelPrefix + String(topic.tid);
  }

  function getMyName() {
    try { return (window.app && app.user && (app.user.displayname || app.user.fullname || app.user.username)) || state.username || "我"; } catch (_) { return state.username || "我"; }
  }

  function getConfigUserCacheTtl() {
    try {
      var cfg = window.config && window.config.cpWukongTopicChat;
      var ttl = Number((cfg && cfg.userCacheTtlMs) || USER_CACHE_TTL || 0);
      return ttl > 60000 ? ttl : (30 * 24 * 3600 * 1000);
    } catch (_) {
      return 30 * 24 * 3600 * 1000;
    }
  }

  function pruneUserCache() {
    var nowTs = Date.now();
    var keys = Object.keys(state.userCache || {});
    keys.forEach(function (uid) {
      var u = state.userCache[uid];
      if (!u || (u.cacheExpiresAt && Number(u.cacheExpiresAt) < nowTs)) delete state.userCache[uid];
    });
    keys = Object.keys(state.userCache || {});
    if (keys.length <= USER_CACHE_MAX) return;
    keys.sort(function (a, b) {
      return Number((state.userCache[a] && state.userCache[a].cacheAt) || 0) - Number((state.userCache[b] && state.userCache[b].cacheAt) || 0);
    });
    keys.slice(0, keys.length - USER_CACHE_MAX).forEach(function (uid) { delete state.userCache[uid]; });
  }

  function loadUserCacheLocal() {
    try {
      var raw = localStorage.getItem(KEY_USER_CACHE);
      if (!raw) return;
      var data = JSON.parse(raw);
      if (!data || !data.users) return;
      var nowTs = Date.now();
      Object.keys(data.users).forEach(function (uid) {
        var u = data.users[uid];
        if (!u || (u.cacheExpiresAt && Number(u.cacheExpiresAt) < nowTs)) return;
        state.userCache[String(uid)] = u;
      });
      pruneUserCache();
    } catch (e) { warn("load-user-cache", e); }
  }

  function saveUserCacheLocalSoon() {
    clearTimeout(userCacheTimer);
    userCacheTimer = setTimeout(function () {
      try {
        pruneUserCache();
        localStorage.setItem(KEY_USER_CACHE, JSON.stringify({ version: 30, ts: Date.now(), users: state.userCache || {} }));
      } catch (e) { warn("save-user-cache", e); }
    }, 600);
  }

  function collectMessageUids(list) {
    var out = [];
    var seen = {};
    (list || []).forEach(function (m) {
      var uid = String(m && m.uid || "").trim();
      if (uid && !m.mine && !seen[uid]) { seen[uid] = true; out.push(uid); }
      var qUid = String(m && m.quoteUid || "").trim();
      if (qUid && !seen[qUid]) { seen[qUid] = true; out.push(qUid); }
    });
    return out;
  }

  function normalizeUserField(u, keys) {
    u = u || {};
    for (var i = 0; i < keys.length; i++) {
      if (u[keys[i]] !== undefined && u[keys[i]] !== null && u[keys[i]] !== "") return u[keys[i]];
    }
    return "";
  }

  function isEmojiFlag(v) {
    return /^[\u{1F1E6}-\u{1F1FF}]{2}$/u.test(String(v || "").trim());
  }

  function flagEmojiFromUser(u) {
    var raw = String(normalizeUserField(u, [
      "language_flag", "languageFlag", "countryFlag", "country_flag",
      "flag", "nationality", "country", "localeCountry"
    ]) || "").trim();
    if (!raw) return "";
    if (isEmojiFlag(raw)) return raw;
    var normalized = raw.toLowerCase().replace(/[\s_-]+/g, "");
    var map = {
      "缅甸": "🇲🇲", "缅甸语": "🇲🇲", "缅甸文": "🇲🇲", "မြန်မာ": "🇲🇲", "မြန်မာစာ": "🇲🇲", "myanmar": "🇲🇲", "burma": "🇲🇲", "burmese": "🇲🇲", "mm": "🇲🇲", "my": "🇲🇲",
      "中国": "🇨🇳", "中文": "🇨🇳", "中国大陆": "🇨🇳", "china": "🇨🇳", "chinese": "🇨🇳", "cn": "🇨🇳", "zhcn": "🇨🇳",
      "台湾": "🇹🇼", "繁体中文": "🇹🇼", "taiwan": "🇹🇼", "tw": "🇹🇼", "zhtw": "🇹🇼",
      "香港": "🇭🇰", "hongkong": "🇭🇰", "hk": "🇭🇰",
      "澳门": "🇲🇴", "macau": "🇲🇴", "mo": "🇲🇴",
      "美国": "🇺🇸", "英语": "🇺🇸", "english": "🇺🇸", "usa": "🇺🇸", "us": "🇺🇸", "america": "🇺🇸", "unitedstates": "🇺🇸", "en": "🇺🇸",
      "日本": "🇯🇵", "日语": "🇯🇵", "日本語": "🇯🇵", "japan": "🇯🇵", "japanese": "🇯🇵", "jp": "🇯🇵", "ja": "🇯🇵",
      "韩国": "🇰🇷", "韩语": "🇰🇷", "한국어": "🇰🇷", "korea": "🇰🇷", "southkorea": "🇰🇷", "kr": "🇰🇷", "ko": "🇰🇷",
      "泰国": "🇹🇭", "泰语": "🇹🇭", "ภาษาไทย": "🇹🇭", "thailand": "🇹🇭", "thai": "🇹🇭", "th": "🇹🇭",
      "越南": "🇻🇳", "越南语": "🇻🇳", "tiếngviệt": "🇻🇳", "vietnam": "🇻🇳", "vietnamese": "🇻🇳", "vn": "🇻🇳", "vi": "🇻🇳",
      "印度": "🇮🇳", "印地语": "🇮🇳", "हिन्दी": "🇮🇳", "india": "🇮🇳", "hindi": "🇮🇳", "in": "🇮🇳", "hi": "🇮🇳",
      "俄罗斯": "🇷🇺", "俄语": "🇷🇺", "русский": "🇷🇺", "russia": "🇷🇺", "russian": "🇷🇺", "ru": "🇷🇺",
      "法国": "🇫🇷", "法语": "🇫🇷", "français": "🇫🇷", "france": "🇫🇷", "french": "🇫🇷", "fr": "🇫🇷",
      "德国": "🇩🇪", "德语": "🇩🇪", "deutsch": "🇩🇪", "germany": "🇩🇪", "german": "🇩🇪", "de": "🇩🇪",
      "西班牙": "🇪🇸", "西语": "🇪🇸", "西班牙语": "🇪🇸", "español": "🇪🇸", "spain": "🇪🇸", "spanish": "🇪🇸", "es": "🇪🇸",
      "马来西亚": "🇲🇾", "马来语": "🇲🇾", "malaysia": "🇲🇾", "malay": "🇲🇾", "ms": "🇲🇾", "myr": "🇲🇾",
      "新加坡": "🇸🇬", "singapore": "🇸🇬", "sg": "🇸🇬",
      "柬埔寨": "🇰🇭", "高棉语": "🇰🇭", "cambodia": "🇰🇭", "khmer": "🇰🇭", "kh": "🇰🇭",
      "老挝": "🇱🇦", "老挝语": "🇱🇦", "laos": "🇱🇦", "lao": "🇱🇦", "lo": "🇱🇦",
      "菲律宾": "🇵🇭", "菲律宾语": "🇵🇭", "philippines": "🇵🇭", "filipino": "🇵🇭", "tagalog": "🇵🇭", "ph": "🇵🇭",
      "印尼": "🇮🇩", "印度尼西亚": "🇮🇩", "印尼语": "🇮🇩", "indonesia": "🇮🇩", "indonesian": "🇮🇩", "id": "🇮🇩"
    };
    return map[raw] || map[normalized] || "";
  }

  function userIsOnline(u) {
    if (!u) return false;
    var status = String(normalizeUserField(u, ["status", "userStatus", "presence", "onlineStatus"]) || "").toLowerCase();
    if (status === "online") return true;
    if (status === "offline" || status === "invisible") return false;
    if (u.online === true || u.isOnline === true) return true;
    return false;
  }

  function buildUserCacheEntry(uid, u) {
    u = u || {};
    var nowTs = Date.now();
    var id = String(uid || u.uid || "");
    return {
      loaded: true,
      uid: id,
      username: u.username || displayNameFromUser(u, id ? "用户" + id : "用户"),
      displayname: displayNameFromUser(u, id ? "用户" + id : "用户"),
      picture: u.picture || u.uploadedpicture || "",
      icontext: u.icontext || u["icon:text"] || "",
      iconbgColor: u.iconbgColor || u["icon:bgColor"] || "#72a5f2",
      userslug: u.userslug || u.slug || u.username || "",
      status: normalizeUserField(u, ["status", "userStatus", "presence", "onlineStatus"]),
      online: userIsOnline(u),
      language_flag: normalizeUserField(u, ["language_flag", "languageFlag", "countryFlag", "country_flag", "flag", "nationality", "country", "localeCountry"]),
      cacheAt: nowTs,
      cacheExpiresAt: nowTs + getConfigUserCacheTtl()
    };
  }

  function getAjaxUserByUid(uid) {
    uid = String(uid || "");
    try {
      if (window.ajaxify && ajaxify.data) {
        var pools = [];
        if (ajaxify.data.loggedInUser) pools.push(ajaxify.data.loggedInUser);
        if (ajaxify.data.author) pools.push(ajaxify.data.author);
        if (ajaxify.data.mainPost && ajaxify.data.mainPost.user) pools.push(ajaxify.data.mainPost.user);
        if (Array.isArray(ajaxify.data.users)) pools = pools.concat(ajaxify.data.users);
        if (ajaxify.data.postData && Array.isArray(ajaxify.data.postData.users)) pools = pools.concat(ajaxify.data.postData.users);
        if (ajaxify.data.posts && Array.isArray(ajaxify.data.posts)) {
          ajaxify.data.posts.forEach(function (p) { if (p && p.user) pools.push(p.user); });
        }
        for (var i = 0; i < pools.length; i++) {
          var u = pools[i];
          if (u && String(u.uid) === uid) return u;
        }
      }
      if (String(uid) === String(state.uid) && window.app && app.user) {
        return app.user;
      }
    } catch (_) {}
    return null;
  }

  function displayNameFromUser(u, fallback) {
    if (!u) return fallback || "用户";
    return u.displayname || u.fullname || u.name || u.username || fallback || (u.uid ? "用户" + u.uid : "用户");
  }

  function resolveUserMeta(uid) {
    uid = String(uid || "");
    if (!uid) return Promise.resolve(null);
    var local = getAjaxUserByUid(uid);
    if (local) {
      state.userCache[uid] = mergeDeep(state.userCache[uid] || {}, buildUserCacheEntry(uid, local));
      saveUserCacheLocalSoon();
      return Promise.resolve(state.userCache[uid]);
    }
    if (state.userCache[uid] && state.userCache[uid].loaded && (!state.userCache[uid].cacheExpiresAt || Number(state.userCache[uid].cacheExpiresAt) > Date.now())) {
      return Promise.resolve(state.userCache[uid]);
    }
    queueResolveUsers([uid]);
    return Promise.resolve(state.userCache[uid] || { uid: uid, username: "用户" + uid, loaded: false, loading: true });
  }

  function applyResolvedUser(uid, user) {
    uid = String(uid || (user && user.uid) || "");
    if (!uid || !user) return;
    state.userCache[uid] = mergeDeep(state.userCache[uid] || {}, buildUserCacheEntry(uid, user));
    state.messages.forEach(function (m) {
      if (String(m.uid || "") === uid && !m.mine) {
        m.username = state.userCache[uid].displayname || state.userCache[uid].username || m.username;
        m.avatarHtml = getAvatarHtml(uid, m.username);
      }
    });
  }

  function queueResolveUsers(uids) {
    uids = Array.isArray(uids) ? uids : [uids];
    var added = false;
    uids.forEach(function (uid) {
      uid = String(uid || "").trim();
      if (!uid) return;
      var local = getAjaxUserByUid(uid);
      if (local) {
        applyResolvedUser(uid, local);
        added = true;
        return;
      }
      var cached = state.userCache[uid];
      if (cached && cached.loaded && (!cached.cacheExpiresAt || Number(cached.cacheExpiresAt) > Date.now())) return;
      state.userBatchPending[uid] = true;
      added = true;
    });
    if (!added) return;
    clearTimeout(state.userBatchTimer);
    state.userBatchTimer = setTimeout(fetchPendingUsersBatch, 180);
  }

  function queueResolveUsersFromMessages(list) {
    queueResolveUsers(collectMessageUids(list || state.messages || []));
  }

  async function fetchPendingUsersBatch() {
    var pending = Object.keys(state.userBatchPending || {}).slice(0, USER_BATCH_MAX);
    pending.forEach(function (uid) { delete state.userBatchPending[uid]; });
    if (!pending.length) return;
    var cfg = (window.config && window.config.cpWukongTopicChat) || {};
    var batchUrl = String(cfg.userBatchUrl || CONFIG.usersBatchUrl || "/bridge/nodebb-users");
    try {
      var res = await fetch(batchUrl + "?uids=" + encodeURIComponent(pending.join(",")), { credentials: "include", cache: "no-store" });
      if (!res.ok && batchUrl.indexOf("/bridge/") === 0) {
        res = await fetch(batchUrl.replace(/^\/bridge/, "") + "?uids=" + encodeURIComponent(pending.join(",")), { credentials: "include", cache: "no-store" });
      }
      if (!res.ok) throw new Error("batch user profile " + res.status);
      var data = await res.json();
      var users = Array.isArray(data && data.users) ? data.users : [];
      users.forEach(function (u) { applyResolvedUser(u && u.uid, u); });
      saveUserCacheLocalSoon();
      queueRender("keep");
    } catch (e) {
      warn("resolve-users-batch", e);
      // 批量接口不可用时，只兜底请求少量单用户接口，避免一次性打爆服务器。
      pending.slice(0, 5).forEach(function (uid) {
        fetch("/bridge/nodebb-user/" + encodeURIComponent(uid), { credentials: "include" })
          .then(function (r) { if (!r.ok) throw new Error("user profile " + r.status); return r.json(); })
          .then(function (u) { applyResolvedUser(uid, u); saveUserCacheLocalSoon(); queueRender("keep"); })
          .catch(function (err) { warn("resolve-user-fallback", err); });
      });
    }
    if (Object.keys(state.userBatchPending || {}).length) {
      clearTimeout(state.userBatchTimer);
      state.userBatchTimer = setTimeout(fetchPendingUsersBatch, 350);
    }
  }

  function getAvatarHtml(uid, username) {
    uid = String(uid || "");
    var u = getAjaxUserByUid(uid) || state.userCache[uid] || null;
    if (u) username = displayNameFromUser(u, username || (uid ? "用户" + uid : "用户"));
    var pic = (u && u.picture) || "";
    var text = (u && (u.icontext || u["icon:text"])) || String(username || uid || "?").charAt(0).toUpperCase();
    var bg = (u && (u.iconbgColor || u["icon:bgColor"])) || "#72a5f2";
    try {
      if (String(uid) === String(state.uid)) {
        var me = getAjaxUserByUid(uid) || (window.app && app.user) || null;
        if (me) {
          pic = me.picture || pic;
          text = me.icontext || me["icon:text"] || text;
          bg = me.iconbgColor || me["icon:bgColor"] || bg;
          u = mergeDeep(mergeDeep({}, u || {}), me);
        }
      }
    } catch (_) {}
    var core = pic ? '<img class="avatar" src="' + escAttr(pic) + '" />' : '<div class="avatar cp-avatar-fallback" style="background:' + escAttr(bg) + '">' + esc(text) + '</div>';
    var flag = flagEmojiFromUser(u);
    var flagHtml = flag ? '<span class="cp-avatar-flag" aria-hidden="true">' + esc(flag) + '</span>' : '';
    var onlineHtml = userIsOnline(u) ? '<span class="cp-avatar-online" aria-label="在线"></span>' : '';
    return '<span class="cp-avatar-stack">' + core + flagHtml + onlineHtml + '</span>';
  }

  function getUserProfileHref(uid, username) {
    uid = String(uid || "");
    var u = getAjaxUserByUid(uid) || state.userCache[uid] || null;
    var slug = (u && (u.userslug || u.slug || u.username)) || username || (u && u.displayname) || "";
    if (!slug && String(uid) === String(state.uid) && window.app && app.user) slug = app.user.userslug || app.user.username || "";
    if (!slug) return "#";
    return "/user/" + encodeURIComponent(String(slug)) + "/topics";
  }

  function normalizeMessageMedia(msg) {
    if (!msg) return msg;
    var payload = {
      cpType: msg.type,
      mediaUrl: msg.mediaUrl,
      audioUrl: msg.audioUrl,
      duration: msg.durationStr
    };
    var candidates = [msg.serverText, msg.text, msg.originalText];
    for (var i = 0; i < candidates.length; i++) {
      var parsed = detectMessageKind(candidates[i] || "", payload);
      if (parsed.kind && parsed.kind !== "text") {
        msg.type = parsed.kind;
        msg.text = parsed.text || msg.text;
        if (parsed.mediaUrl) msg.mediaUrl = parsed.mediaUrl;
        if (parsed.audioUrl) msg.audioUrl = parsed.audioUrl;
        if (parsed.duration && !msg.durationStr) msg.durationStr = formatDuration(parsed.duration);
        break;
      }
    }
    if (msg.type === "voice" && msg.audioUrl && (!msg.durationStr || msg.durationStr === "--:--")) {
      getAudioDuration(msg.audioUrl, function (sec) {
        if (sec) { msg.durationStr = formatDuration(sec); queueRender("keep"); saveCacheSoon(); }
      });
    }
    return msg;
  }

  function displayNameForMessage(msg) {
    if (!msg) return "用户";
    var u = getAjaxUserByUid(msg.uid) || state.userCache[String(msg.uid || "")];
    return displayNameFromUser(u, msg.username || (msg.uid ? "用户" + msg.uid : "用户"));
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
      var decoded = decodeURIComponent(atob(raw).split("").map(function (c) {
        return "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2);
      }).join(""));
      return JSON.parse(decoded);
    } catch (_) {}
    return { text: raw, content: raw };
  }

  function getMsgChannelId(m) {
    if (!m) return "";
    return String(m.channelID || m.channelId || m.channel_id || (m.channel && (m.channel.channelID || m.channel.channelId || m.channel.channel_id)) || "");
  }

  function getMsgChannelType(m) {
    if (!m) return 0;
    return Number(m.channelType || m.channel_type || (m.channel && (m.channel.channelType || m.channel.channel_type)) || 0);
  }

  function sameTopicChannel(m) {
    var id = getMsgChannelId(m);
    if (!id) return false;
    var type = getMsgChannelType(m);
    return id === state.channelId && (!type || type === CONFIG.channelType);
  }

  function extractMsgId(m, payload) {
    return String(
      m.message_id || m.messageID || m.messageId ||
      m.client_msg_no || m.clientMsgNo || m.client_msgNo ||
      (payload && (payload.client_msg_no || payload.clientMsgNo || payload.message_id)) ||
      ""
    );
  }


  function detectMessageKind(text, payload) {
    text = String(text || "").trim();
    payload = payload || {};
    var kind = payload.cpType || payload.msgType || payload.type || "text";
    var mediaUrl = payload.mediaUrl || payload.url || payload.src || payload.href || "";
    var audioUrl = payload.audioUrl || payload.voiceUrl || "";
    var duration = payload.duration || payload.time || "";
    var match;

    // 兼容一对一聊天的三种格式：![](url)、[图片](url)、[语音消息](url)。
    if ((match = text.match(/^!\[[^\]]*\]\(([^)]+)\)$/)) || (match = text.match(/^\[图片\]\(([^)]+)\)$/))) {
      kind = "image";
      mediaUrl = match[1];
      text = "[图片]";
    } else if ((match = text.match(/^\[视频\]\(([^)]+)\)$/))) {
      kind = "video";
      mediaUrl = match[1];
      text = "[视频]";
    } else if ((match = text.match(/^\[语音消息\]\(([^)]+)\)$/)) || (match = text.match(/^\[语音\]\(([^)]+)\)$/))) {
      kind = "voice";
      audioUrl = match[1];
      text = "[语音]";
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
    if ((kind === "image" || kind === "video") && !mediaUrl && audioUrl) mediaUrl = audioUrl;

    return {
      kind: String(kind || "text"),
      text: text,
      mediaUrl: mediaUrl,
      audioUrl: audioUrl,
      duration: duration
    };
  }

  function formatDuration(sec) {
    sec = Math.max(0, Math.round(Number(sec || 0)));
    var m = Math.floor(sec / 60);
    var s = sec % 60;
    return m + ":" + String(s).padStart(2, "0");
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

  function getAudioDuration(url, cb) {
    if (!url) return cb(0);
    var temp = new Audio();
    var done = false;
    var finish = function (v) { if (done) return; done = true; cb(v || 0); };
    var timer = setTimeout(function () { finish(0); }, 5000);
    temp.preload = "metadata";
    temp.onloadedmetadata = function () {
      clearTimeout(timer);
      if (temp.duration === Infinity) {
        temp.currentTime = 1e101;
        temp.ontimeupdate = function () { temp.ontimeupdate = null; temp.currentTime = 0; finish(temp.duration || 0); };
      } else finish(temp.duration || 0);
    };
    temp.onerror = function () { clearTimeout(timer); finish(0); };
    temp.src = url;
  }


  function normalizeMentionList(payload) {
    payload = payload || {};
    var raw = payload.mention_uids || payload.mentionUids || payload.at_uids || payload.atUsers || payload.at || payload.mentions || payload.reminders || [];
    if (typeof raw === "string") raw = raw.split(/[,\s]+/);
    if (!Array.isArray(raw)) raw = [];
    var out = [];
    raw.forEach(function (x) {
      var uid = "";
      if (x && typeof x === "object") uid = x.uid || x.userId || x.user_id || x.id || x.value || "";
      else uid = x;
      uid = String(uid || "").trim();
      if (uid && out.indexOf(uid) < 0) out.push(uid);
    });
    return out;
  }

  function getQuotePreviewText(msg) {
    if (!msg) return "";
    if (msg.type === "image") return "[图片]";
    if (msg.type === "video") return "[视频]";
    if (msg.type === "voice") return "[语音]";
    return String(msg.text || msg.serverText || "").slice(0, 220);
  }

  function getQuoteKindLabel(type) {
    type = String(type || "text");
    if (type === "image") return "图片";
    if (type === "video") return "视频";
    if (type === "voice") return "语音";
    return "";
  }

  function isFakeQuoteText(text) {
    text = String(text || "").trim();
    return !text || text === "[被引用的消息]" || text === "被引用的消息" || text === "[引用消息]" || text === "引用消息";
  }

  function sanitizeQuoteFields(msg) {
    if (!msg) return msg;
    msg.quote = String(msg.quote || "").trim();
    msg.quoteMsgId = String(msg.quoteMsgId || "").trim();
    msg.quoteMediaUrl = String(msg.quoteMediaUrl || "").trim();
    msg.quoteAudioUrl = String(msg.quoteAudioUrl || "").trim();
    msg.quoteUid = String(msg.quoteUid || "").trim();
    msg.quoteUser = String(msg.quoteUser || "").trim();
    msg.quoteType = String(msg.quoteType || "").trim();
    if (isFakeQuoteText(msg.quote)) msg.quote = "";

    // v25: 如果 payload 只有 quote_msg_id，优先从本地已加载消息补回引用内容；
    // 但不要因为没有 quote_text 就显示假引用卡片。
    if (!msg.quote && !msg.quoteMediaUrl && !msg.quoteAudioUrl && msg.quoteMsgId) {
      var ref = getMsgByIdLocal(msg.quoteMsgId);
      if (ref) {
        msg.quote = getQuotePreviewText(ref) || "";
        msg.quoteUser = msg.quoteUser || displayNameForMessage(ref) || ref.username || "引用";
        msg.quoteUid = msg.quoteUid || String(ref.uid || "");
        msg.quoteType = msg.quoteType || ref.type || "text";
        msg.quoteMediaUrl = msg.quoteMediaUrl || ref.mediaUrl || "";
        msg.quoteAudioUrl = msg.quoteAudioUrl || ref.audioUrl || "";
      }
    }

    var hasRealText = !!String(msg.quote || "").trim() && !isFakeQuoteText(msg.quote);
    var hasRealMedia = !!(msg.quoteMediaUrl || msg.quoteAudioUrl);
    if (!hasRealText && !hasRealMedia) {
      // 保留 quoteUid/quoteMsgId 用于“某某回复了你”的判断和稍后补全，
      // 只清掉会造成 UI 假引用的展示字段。
      msg.quote = "";
      msg.quoteUser = msg.quoteUser || "";
      msg.quoteType = "";
      msg.quoteMediaUrl = "";
      msg.quoteAudioUrl = "";
    }
    return msg;
  }

  function getMsgByIdLocal(id) {
    if (!id) return null;
    return state.msgMap[String(id)] || (state.messages || []).find(function (m) { return String(m.id) === String(id); }) || null;
  }

  function getMentionNoticeType(msg) {
    if (!msg || msg.mine) return "";
    var qUid = String(msg.quoteUid || msg.replyToUid || "");
    if (qUid && qUid === String(state.uid)) return "reply";
    var qMsg = getMsgByIdLocal(msg.quoteMsgId || "");
    if (qMsg && qMsg.mine) return "reply";
    var arr = (msg.mentionUids || []).map(function (x) { return String(x); });
    if (arr.indexOf(String(state.uid)) >= 0) return "mention";
    var myName = String(state.username || getMyName() || "").replace(/\s+/g, "");
    if (myName && String(msg.text || "").replace(/\s+/g, "").indexOf("@" + myName) >= 0) return "mention";
    return "";
  }

  function triggerNoticeVibration() {
    try {
      if (navigator.vibrate) navigator.vibrate([35, 45, 35]);
    } catch (_) {}
  }

  function normalizeRemoteNotice(n) {
    n = n || {};
    var fromUid = String(n.from_uid || n.fromUid || "");
    var fromName = String(n.from_name || n.fromName || n.from_username || "有人");
    var type = String(n.type || n.notice_type || "mention");
    var messageId = String(n.message_id || n.msg_id || n.client_msg_no || n.clientMsgNo || "");
    var messageSeq = Number(n.message_seq || n.messageSeq || 0) || 0;
    var messageText = String(n.message_text || n.text_body || n.messageText || n.body || "");
    var quoteText = String(n.quote_text || n.quoteText || n.quote || "");
    var quoteUser = String(n.quote_user || n.quoteUser || n.reply_user || n.replyUser || "");
    var quoteUid = String(n.quote_uid || n.quoteUid || n.reply_to_uid || n.replyToUid || "");
    var quoteMsgId = String(n.quote_msg_id || n.quoteMsgId || n.reply_to_msg_id || n.replyToMsgId || "");
    var quoteType = String(n.quote_type || n.quoteType || "");
    var quoteMediaUrl = String(n.quote_media_url || n.quoteMediaUrl || "");
    var quoteAudioUrl = String(n.quote_audio_url || n.quoteAudioUrl || "");
    return {
      raw: n,
      id: String(n.id || n.notice_id || n.version || n.ts || Math.random()),
      version: Number(n.version || 0) || 0,
      tid: String(n.tid || ""),
      cid: String(n.cid || ""),
      type: type,
      fromUid: fromUid,
      fromName: fromName,
      text: n.text || (fromName + (type === "reply" ? " 回复了你" : " @了你")),
      messageId: messageId,
      messageSeq: messageSeq,
      messageText: messageText,
      quoteText: isFakeQuoteText(quoteText) ? "" : quoteText,
      quoteUser: quoteUser,
      quoteUid: quoteUid,
      quoteMsgId: quoteMsgId,
      quoteType: quoteType,
      quoteMediaUrl: quoteMediaUrl,
      quoteAudioUrl: quoteAudioUrl,
      ts: Number(n.ts || Date.now())
    };
  }

  function noticeMatchesMessage(n, msg) {
    if (!n || !msg) return false;
    if (n.messageId && String(msg.id || "") === String(n.messageId)) return true;
    if (n.messageSeq && Number(msg.seq || 0) === Number(n.messageSeq)) return true;
    var txt = normalizeText(n.messageText || "");
    if (txt) {
      var mt = normalizeText(msg.serverText || msg.text || "");
      var fromOk = !n.fromUid || String(msg.uid || "") === String(n.fromUid || "");
      if (fromOk && (mt === txt || (txt.length > 8 && mt.indexOf(txt) >= 0) || (mt.length > 8 && txt.indexOf(mt) >= 0))) return true;
    }
    return false;
  }

  function enrichMessageWithNotice(msg, notice) {
    if (!msg || !notice) return false;
    var n = notice.raw ? notice : normalizeRemoteNotice(notice);
    if (!noticeMatchesMessage(n, msg)) return false;
    var changed = false;
    if (n.type === "reply") {
      if (n.quoteText && !msg.quote) { msg.quote = n.quoteText; changed = true; }
      if (n.quoteUser && !msg.quoteUser) { msg.quoteUser = n.quoteUser; changed = true; }
      if (n.quoteUid && !msg.quoteUid) { msg.quoteUid = n.quoteUid; changed = true; }
      if (n.quoteMsgId && !msg.quoteMsgId) { msg.quoteMsgId = n.quoteMsgId; changed = true; }
      if (n.quoteType && !msg.quoteType) { msg.quoteType = n.quoteType; changed = true; }
      if (n.quoteMediaUrl && !msg.quoteMediaUrl) { msg.quoteMediaUrl = n.quoteMediaUrl; changed = true; }
      if (n.quoteAudioUrl && !msg.quoteAudioUrl) { msg.quoteAudioUrl = n.quoteAudioUrl; changed = true; }
      // 如果通知只有 quote_msg_id，尝试从本地消息补全真正的引用内容。
      sanitizeQuoteFields(msg);
    }
    if (n.type === "mention") {
      msg.mentionMe = true;
    }
    return changed;
  }

  function indexRemoteNotice(n) {
    var notice = normalizeRemoteNotice(n);
    state.replyNoticeIndex = state.replyNoticeIndex || {};
    state.replyNoticeQueue = state.replyNoticeQueue || [];
    function put(k) { if (k) state.replyNoticeIndex[String(k)] = notice; }
    put(notice.messageId);
    if (notice.messageSeq) put("seq:" + notice.messageSeq);
    if (notice.fromUid && notice.messageText) put("txt:" + notice.fromUid + ":" + normalizeText(notice.messageText));
    state.replyNoticeQueue.unshift(notice);
    if (state.replyNoticeQueue.length > 80) state.replyNoticeQueue.length = 80;
    var changed = false;
    (state.messages || []).forEach(function (m) { if (enrichMessageWithNotice(m, notice)) changed = true; });
    if (changed) { saveCacheSoon(); queueRender("keep"); }
    return notice;
  }

  function applyIndexedNoticePatch(msg) {
    if (!msg || !state.replyNoticeIndex) return msg;
    var candidates = [];
    if (msg.id) candidates.push(String(msg.id));
    if (msg.seq) candidates.push("seq:" + msg.seq);
    if (msg.uid && (msg.serverText || msg.text)) candidates.push("txt:" + String(msg.uid) + ":" + normalizeText(msg.serverText || msg.text || ""));
    for (var i = 0; i < candidates.length; i++) {
      var n = state.replyNoticeIndex[candidates[i]];
      if (n && enrichMessageWithNotice(msg, n)) break;
    }
    return msg;
  }

  function pushMentionNotice(msg) {
    var type = getMentionNoticeType(msg);
    if (!type || !msg || !msg.id) return;
    var id = String(msg.id);
    if ((state.mentionNotices || []).some(function (n) { return String(n.id) === id; })) return;
    var who = displayNameForMessage(msg) || msg.username || "有人";
    var text = type === "reply" ? (who + " 回复了你") : (who + " @了你");
    state.mentionNotices = [{ id: id, type: type, text: text, ts: Date.now(), fromUid: msg.uid || "", messageText: msg.serverText || msg.text || "" }].concat(state.mentionNotices || []).slice(0, 30);
    toast(text);
    updateMentionBanner();
    triggerNoticeVibration();
  }

  function updateMentionBanner() {
    var banner = byId("cp-topic-at-banner");
    var txt = byId("cp-topic-at-banner-text");
    if (!banner || !txt) return;
    var list = state.mentionNotices || [];
    var notice = list[0];
    if (!notice) { banner.hidden = true; return; }
    banner.setAttribute("data-mid", notice.id);
    txt.textContent = (list.length > 1 ? (list.length + "条提醒 · ") : "") + notice.text;
    banner.hidden = false;
  }

  function findNoticeTarget(notice) {
    if (!notice) return null;
    var mid = String(notice.id || notice.message_id || notice.msg_id || notice.client_msg_no || "");
    if (mid && !/^remote_/.test(mid)) {
      var direct = getMsgByIdLocal(mid);
      if (direct) { enrichMessageWithNotice(direct, notice); sanitizeQuoteFields(direct); return direct; }
    }
    var seq = Number(notice.message_seq || notice.messageSeq || 0);
    if (seq) {
      for (var si = state.messages.length - 1; si >= 0; si--) {
        if (Number(state.messages[si].seq || 0) === seq) { enrichMessageWithNotice(state.messages[si], notice); sanitizeQuoteFields(state.messages[si]); return state.messages[si]; }
      }
    }
    var txt = normalizeText(notice.messageText || notice.message_text || notice.findText || notice.text_body || "");
    var fromUid = String(notice.fromUid || notice.from_uid || "");
    for (var i = state.messages.length - 1; i >= 0; i--) {
      var m = state.messages[i];
      if (fromUid && String(m.uid || "") !== fromUid) continue;
      if (txt) {
        var mt = normalizeText(m.serverText || m.text || "");
        // 远端提醒有时只有 message_text，没有 mention/quote payload；只要发信人和文本匹配就算命中。
        if (mt === txt || (txt.length > 8 && mt.indexOf(txt) >= 0) || (mt.length > 8 && txt.indexOf(mt) >= 0)) { enrichMessageWithNotice(m, notice); sanitizeQuoteFields(m); return m; }
        continue;
      }
      if (notice.type === "reply" && getMentionNoticeType(m) !== "reply") continue;
      if (notice.type === "mention" && getMentionNoticeType(m) !== "mention") continue;
      enrichMessageWithNotice(m, notice); sanitizeQuoteFields(m); return m;
    }
    return null;
  }

  function highlightMessageRow(mid) {
    var row = document.querySelector('#cp-topic-msg-list .cp-row[data-mid="' + String(mid).replace(/"/g, '\"') + '"]');
    if (!row) return false;
    row.scrollIntoView({ behavior: "smooth", block: "center" });
    var bubble = row.querySelector(".cp-bubble");
    if (bubble) {
      bubble.classList.add("cp-mention-me");
      setTimeout(function () { bubble.classList.remove("cp-mention-me"); }, 1600);
    }
    return true;
  }

  async function scrollToNotice(notice) {
    if (!notice) return;
    var target = findNoticeTarget(notice);
    if (!target) {
      toast("正在加载这条提醒消息...");
      // 先拉最新离线/历史；远端通知常常先到，悟空历史稍后才可同步。
      try { await fetchOffline(); } catch (_) {}
      try { await fetchHistory(false); } catch (_) {}
      target = findNoticeTarget(notice);
    }
    var tries = 0;
    var oldHasNoMore = state.hasNoMore;
    while (!target && tries < 10) {
      tries++;
      // 点击提醒时强制多拉几页，避免之前缓存把 hasNoMore 置 true 后无法继续加载。
      if (tries === 1) state.hasNoMore = false;
      try { await fetchHistory(true); } catch (_) { break; }
      target = findNoticeTarget(notice);
      if (state.hasNoMore && tries > 2) break;
    }
    if (!target) {
      state.hasNoMore = oldHasNoMore && state.hasNoMore;
      return toast("这条提醒消息还没同步完成，稍后再点一次");
    }
    highlightMessageRow(target.id);
    var removeId = notice.id || notice.remoteId || target.id;
    state.mentionNotices = (state.mentionNotices || []).filter(function (n) { return n !== notice && String(n.id) !== String(removeId) && String(n.remoteId || "") !== String(removeId); });
    updateMentionBanner();
    if (notice.remoteId && CONFIG.notifyDoneUrl) markRemoteNoticeDone(notice.remoteId);
  }

  function scrollToMessageId(mid) {
    var notice = (state.mentionNotices || []).find(function (n) { return String(n.id) === String(mid) || String(n.remoteId || "") === String(mid); });
    if (notice) return scrollToNotice(notice);
    var msg = getMsgByIdLocal(mid);
    if (msg) return highlightMessageRow(msg.id);
    toast("正在加载这条消息...");
    scrollToNotice({ id: mid });
  }

  function msgFromWk(m, forceMine) {
    var payload = decodePayload(m);
    var fromUid = String(m.from_uid || m.fromUID || m.fromUid || payload.from_uid || payload.fromUID || "");
    var mine = forceMine != null ? !!forceMine : (fromUid && String(fromUid) === String(state.uid));
    var serverText = payload.text || payload.content || payload.message || "";
    if (!serverText && typeof payload === "string") serverText = payload;
    if (!serverText) serverText = "[暂不支持的消息]";
    var parsedServer = detectMessageKind(serverText, payload);
    var displayText = mine && payload.originalText ? payload.originalText : parsedServer.text;
    var parsedDisplay = detectMessageKind(displayText, payload);

    var id = extractMsgId(m, payload);
    var seq = Number(m.message_seq || m.messageSeq || m.message_seq_no || 0);
    var ts = Number(m.timestamp || m.clientTimestamp || payload.timestamp || 0);
    if (ts && ts < 1000000000000) ts = ts * 1000;
    if (!ts) ts = now();
    if (!id) id = "wk_" + (seq || Date.now()) + "_" + Math.floor(Math.random() * 10000);

    return {
      id: id,
      seq: seq,
      uid: fromUid || (mine ? state.uid : ""),
      username: mine ? getMyName() : (payload.username || payload.name || (state.userCache[fromUid] && state.userCache[fromUid].username) || (fromUid ? "用户" + fromUid : "用户")),
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
      countryFlag: normalizeCountryFlag(payload.countryFlag || payload.flag || ""),
      mentionMe: getMentionNoticeType({ mine: !!mine, quoteUid: payload.quote_uid || payload.quoteUid || payload.reply_to_uid || payload.replyToUid || "", mentionUids: normalizeMentionList(payload), text: parsedDisplay.text }) !== ""
    };
  }

  function mediaKeyOf(msg) {
    if (!msg) return "";
    return String(msg.audioUrl || msg.mediaUrl || "").trim();
  }

  function textDedupKey(msg, bucketMs) {
    bucketMs = bucketMs || 10000;
    var mediaKey = mediaKeyOf(msg);
    var bodyKey = mediaKey || normalizeText(msg.serverText || msg.text || "");
    return [msg.mine ? "me" : String(msg.uid || ""), msg.type || "text", bodyKey, Math.floor((msg.ts || 0) / bucketMs)].join("|");
  }

  function findPendingMine(serverMsg) {
    if (!serverMsg || !serverMsg.mine) return null;
    var key = normalizeText(serverMsg.text);
    var mediaKey = mediaKeyOf(serverMsg);
    if (!key && !mediaKey) return null;
    var best = null;
    var bestDiff = Infinity;
    for (var i = state.messages.length - 1; i >= 0; i--) {
      var m = state.messages[i];
      if (!m || !m.mine) continue;
      var isLocal = m.local || m.sending || String(m.id || "").indexOf("local_") === 0 || !m.seq;
      if (!isLocal) continue;
      var sameMedia = mediaKey && mediaKeyOf(m) === mediaKey;
      var sameText = !mediaKey && normalizeText(m.text) === key;
      if (!sameMedia && !sameText) continue;
      var diff = Math.abs((serverMsg.ts || now()) - (m.ts || now()));
      if (diff < PENDING_TTL && diff < bestDiff) {
        best = m;
        bestDiff = diff;
      }
    }
    return best;
  }

  function mergeServerIntoLocal(local, server) {
    if (!local || !server) return;
    delete state.msgMap[local.id];
    local.id = server.id || local.id;
    local.seq = server.seq || local.seq || 0;
    local.uid = server.uid || local.uid;
    local.username = server.username || local.username;
    local.ts = server.ts || local.ts;
    local.type = server.type || local.type || "text";
    local.text = local.text || server.text;
    local.serverText = server.serverText || local.serverText || server.text;
    local.mediaUrl = server.mediaUrl || local.mediaUrl || "";
    local.audioUrl = server.audioUrl || local.audioUrl || "";
    local.durationStr = server.durationStr || local.durationStr || "";
    local.originalText = local.originalText || server.originalText || "";
    if (server.translation && !local.translation) { local.translation = server.translation; local.translationOpen = true; }
    local.sending = false;
    local.failed = false;
    local.local = false;
    local.wkMsg = server.wkMsg || local.wkMsg;
    state.msgMap[local.id] = local;
    if (local.seq) {
      if (!state.oldestSeq || local.seq < state.oldestSeq) state.oldestSeq = local.seq;
      if (local.seq > state.newestSeq) state.newestSeq = local.seq;
    }
  }

  function addMessages(list, opts) {
    opts = opts || {};
    var changed = false;
    var seenSoft = {};

    state.messages.forEach(function (m) { seenSoft[textDedupKey(m, 10000)] = true; });

    list.forEach(function (msg) {
      if (!msg || !msg.id) return;
      sanitizeQuoteFields(msg);

      if (msg.mine) {
        var pending = findPendingMine(msg);
        if (pending && pending.id !== msg.id) {
          mergeServerIntoLocal(pending, msg);
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
        old.local = false;
        old.serverText = msg.serverText || old.serverText || msg.text;
        old.originalText = old.originalText || msg.originalText || "";
        if (msg.translation && !old.translation) { old.translation = msg.translation; old.translationOpen = true; }
        sanitizeQuoteFields(msg);
        applyIndexedNoticePatch(msg);
        sanitizeQuoteFields(msg);
        if (msg.quote || msg.quoteMsgId || msg.quoteMediaUrl || msg.quoteAudioUrl) {
          if (msg.quote && !old.quote) old.quote = msg.quote;
          if (msg.quoteUser && !old.quoteUser) old.quoteUser = msg.quoteUser;
          if (msg.quoteUid && !old.quoteUid) old.quoteUid = msg.quoteUid;
          if (msg.quoteMsgId && !old.quoteMsgId) old.quoteMsgId = msg.quoteMsgId;
          if (msg.quoteType && !old.quoteType) old.quoteType = msg.quoteType;
          if (msg.quoteMediaUrl && !old.quoteMediaUrl) old.quoteMediaUrl = msg.quoteMediaUrl;
          if (msg.quoteAudioUrl && !old.quoteAudioUrl) old.quoteAudioUrl = msg.quoteAudioUrl;
          sanitizeQuoteFields(old);
        }
        if (msg.mentionUids && msg.mentionUids.length) old.mentionUids = msg.mentionUids;
        old.mentionMe = old.mentionMe || msg.mentionMe || getMentionNoticeType(old) !== "";
        changed = true;
        return;
      }

      var sk = textDedupKey(msg, 10000);
      if (seenSoft[sk]) return;
      seenSoft[sk] = true;

      state.messages.push(msg);
      state.msgMap[msg.id] = msg;
      if (opts.notify !== false && !msg.mine && getMentionNoticeType(msg)) {
        setTimeout(function (m) { return function () { pushMentionNotice(m); }; }(msg), 0);
      }
      if (msg.seq) {
        if (!state.oldestSeq || msg.seq < state.oldestSeq) state.oldestSeq = msg.seq;
        if (msg.seq > state.newestSeq) state.newestSeq = msg.seq;
      }
      changed = true;
    });

    if (!changed) return;
    state.messages.sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); });
    queueResolveUsersFromMessages(state.messages);
    if (state.messages.length > MAX_RENDER) {
      var removed = state.messages.splice(0, state.messages.length - MAX_RENDER);
      removed.forEach(function (m) { delete state.msgMap[m.id]; });
    }
    saveCacheSoon();
    queueRender(opts.scroll || "keep");
  }

  function cacheKey() { return LS_PREFIX + state.channelId; }

  function saveCacheLocalSync() {
    if (!state.channelId) return;
    try {
      var data = {
        channelId: state.channelId,
        messages: state.messages.slice(-MAX_CACHE),
        oldestSeq: state.oldestSeq,
        newestSeq: state.newestSeq,
        ts: Date.now()
      };
      localStorage.setItem(cacheKey(), JSON.stringify(data));
    } catch (e) { warn("save-local-cache", e); }
  }

  function loadCacheLocalSync() {
    if (!state.channelId) return;
    try {
      var raw = localStorage.getItem(cacheKey());
      if (!raw) return;
      var data = JSON.parse(raw);
      if (!data || !Array.isArray(data.messages)) return;
      state.messages = data.messages.slice(-MAX_CACHE);
      state.msgMap = {};
      state.messages.forEach(function (m) {
        m.sending = false;
        m.failed = false;
        m.local = false;
        sanitizeQuoteFields(m);
        state.msgMap[m.id] = m;
      });
      state.oldestSeq = Number(data.oldestSeq || 0);
      state.newestSeq = Number(data.newestSeq || 0);
    } catch (e) { warn("load-local-cache", e); }
  }

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve) {
      if (!window.indexedDB) return resolve(null);
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "channelId" });
      };
      req.onsuccess = function (e) { resolve(e.target.result); };
      req.onerror = function () { resolve(null); };
    });
    return dbPromise;
  }

  async function saveCacheDb() {
    try {
      var db = await openDB();
      if (!db || !state.channelId) return;
      db.transaction(STORE, "readwrite").objectStore(STORE).put({
        channelId: state.channelId,
        messages: state.messages.slice(-MAX_CACHE),
        oldestSeq: state.oldestSeq,
        newestSeq: state.newestSeq,
        ts: Date.now()
      });
    } catch (e) { warn("save-db-cache", e); }
  }

  async function loadCacheDbAndMerge() {
    try {
      var db = await openDB();
      if (!db || !state.channelId) return;
      await new Promise(function (resolve) {
        var req = db.transaction(STORE, "readonly").objectStore(STORE).get(state.channelId);
        req.onsuccess = function (e) {
          var data = e.target.result;
          if (data && Array.isArray(data.messages) && data.messages.length) {
            addMessages(data.messages.map(function (m) {
              m.sending = false; m.failed = false; m.local = false;
              sanitizeQuoteFields(m);
              return m;
            }), { scroll: "bottom", notify: false });
            state.oldestSeq = state.oldestSeq || Number(data.oldestSeq || 0);
            state.newestSeq = Math.max(state.newestSeq || 0, Number(data.newestSeq || 0));
          }
          resolve();
        };
        req.onerror = function () { resolve(); };
      });
    } catch (e) { warn("load-db-cache", e); }
  }

  function saveCacheSoon() {
    clearTimeout(cacheTimer);
    cacheTimer = setTimeout(function () {
      saveCacheLocalSync();
      saveCacheDb();
    }, 350);
  }


  function fetchWithTimeout(url, opts, ms) {
    opts = opts || {};
    ms = ms || 12000;
    var ctrl = window.AbortController ? new AbortController() : null;
    if (ctrl) opts.signal = ctrl.signal;
    var timer = setTimeout(function () { try { if (ctrl) ctrl.abort(); } catch (_) {} }, ms);
    return fetch(url, opts).finally(function () { clearTimeout(timer); });
  }

  async function withRetry(fn, times, scope) {
    var last;
    for (var i = 0; i <= (times || 0); i++) {
      try { return await fn(); } catch (e) { last = e; warn(scope || "retry", e); if (i < times) await new Promise(function (r) { setTimeout(r, 350 + i * 450); }); }
    }
    throw last;
  }

  function parseJsonLoose(text) {
    text = String(text || "").trim();
    if (!text) return null;
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
      if (c.delta && c.delta.content) return c.delta.content;
      if (c.text) return c.text;
    }
    if (data.data && typeof data.data === "string") return data.data;
    return "";
  }

  async function rawAIRequest(messages, ai, timeout) {
    ai = ai || (state.cfg && state.cfg.ai) || {};
    var endpoint = String(ai.endpoint || "").replace(/\/+$/, "");
    var apiKey = String(ai.apiKey || "");
    var model = String(ai.model || "gpt-4o-mini");
    if (!endpoint) throw new Error("请先在设置里填写 AI 接口 URL");
    if (!apiKey) throw new Error("请先在设置里填写 API Key，或切换为机翻");

    return await withRetry(async function () {
      var res;
      if (!CONFIG.aiProxyUrl) throw new Error("AI 需要 bridge 代理接口 /bridge/ai/chat");
      res = await fetchWithTimeout(CONFIG.aiProxyUrl, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: endpoint, apiKey: apiKey, model: model, temperature: Number(ai.temperature || 0.2), messages: messages })
      }, timeout || 12000);
      if (!res.ok) {
        var detail = await res.text().catch(function () { return ""; });
        throw new Error(detail || "AI接口错误: " + res.status);
      }
      var data = await res.json();
      var out = extractAIText(data);
      if (!out) throw new Error("AI返回为空");
      return out;
    }, 1, "ai-request");
  }

  async function translateViaGoogle(text, from, to) {
    var sl = getLangCode(from, "auto");
    var tl = getLangCode(to, "en");
    if (sl !== "auto" && sl.indexOf("-") > -1) sl = sl.split("-")[0];
    if (tl.indexOf("-") > -1) tl = tl.split("-")[0];
    var customEndpoint = String((state.cfg && state.cfg.googleEndpoint) || DEFAULT_CFG.googleEndpoint || "").trim();
    return await withRetry(async function () {
      var res;
      var q = "client=gtx&sl=" + encodeURIComponent(sl || "auto") + "&tl=" + encodeURIComponent(tl || "en") + "&dt=t&q=" + encodeURIComponent(text);
      if (customEndpoint) {
        var joiner = customEndpoint.indexOf("?") > -1 ? "&" : "?";
        res = await fetchWithTimeout(customEndpoint + joiner + q, { cache: "force-cache" }, 7000);
      } else if (CONFIG.googleProxyUrl) {
        res = await fetchWithTimeout(CONFIG.googleProxyUrl + "?sl=" + encodeURIComponent(sl || "auto") + "&tl=" + encodeURIComponent(tl || "en") + "&q=" + encodeURIComponent(text), { credentials: "include", cache: "force-cache" }, 7000);
      }
      if (!res || !res.ok) {
        if (res && customEndpoint && CONFIG.googleProxyUrl) {
          res = await fetchWithTimeout(CONFIG.googleProxyUrl + "?sl=" + encodeURIComponent(sl || "auto") + "&tl=" + encodeURIComponent(tl || "en") + "&q=" + encodeURIComponent(text), { credentials: "include", cache: "force-cache" }, 7000);
        }
      }
      if (!res || !res.ok) {
        var detail = res ? await res.text().catch(function () { return ""; }) : "";
        throw new Error("机翻失败" + (res ? " " + res.status : "") + (detail ? ": " + detail.slice(0, 80) : ""));
      }
      var data = await res.json();
      if (data && typeof data.translation === "string") return data.translation.trim();
      var parts = Array.isArray(data && data[0]) ? data[0] : [];
      return parts.map(function (item) { return item && item[0] ? item[0] : ""; }).join("").trim();
    }, 1, "google-translate");
  }

  async function translateViaAI(text, from, to) {
    var ai = state.cfg.ai || {};
    var prompt = fillTemplate(ai.translatePrompt || DEFAULT_TRANSLATE_PROMPT, {
      text: text,
      peerMessage: text,
      sourceLang: from || "自动检测",
      targetLang: to || state.cfg.targetLang || "中文",
      myLang: to || state.cfg.targetLang || "中文"
    });
    var raw = await rawAIRequest([
      { role: "system", content: "你是极速聊天翻译器。必须只输出可解析 JSON。" },
      { role: "user", content: prompt }
    ], ai, 12000);
    var json = parseJsonLoose(raw);
    return (json && typeof json.translation === "string" ? json.translation : raw).trim();
  }

  async function translateByProvider(text, from, to, provider) {
    provider = provider || state.cfg.translateProvider || "google";
    if (provider === "ai") return await translateViaAI(text, from, to);
    return await translateViaGoogle(text, from, to);
  }

  function getAiCache(key) {
    var c = state.aiCache[key];
    if (c && c.expiresAt > Date.now()) return c.value;
    return null;
  }

  function addAiCache(key, val, ttl) {
    state.aiCache[key] = { value: val, expiresAt: Date.now() + (ttl || 3600000) };
    state.aiCacheKeys.push(key);
    if (state.aiCacheKeys.length > 180) {
      var old = state.aiCacheKeys.shift();
      delete state.aiCache[old];
    }
  }

  async function translateMessage(msg, force) {
    if (!msg || !msg.text || msg.sending) return;
    var fromLang = msg.mine ? state.cfg.sourceLang : state.cfg.targetLang;
    var toLang = msg.mine ? state.cfg.targetLang : state.cfg.sourceLang;
    var cacheKey2 = ["msg", state.cfg.translateProvider, fromLang, toLang, normalizeText(msg.serverText || msg.text)].join("|");
    if (!force) {
      var cached = getAiCache(cacheKey2);
      if (cached) {
        msg.translation = cached;
        msg.translationOpen = true;
        msg.translationError = false;
        queueRender("keep");
        saveCacheSoon();
        return;
      }
    }
    if (state.translateInflight[msg.id]) return;
    state.translateInflight[msg.id] = true;
    msg.translation = "翻译中...";
    msg.translationOpen = true;
    msg.translationError = false;
    queueRender("keep");
    try {
      var out = await translateByProvider(msg.serverText || msg.text, fromLang, toLang);
      msg.translation = out || "";
      msg.translationError = false;
      addAiCache(cacheKey2, msg.translation);
      saveCacheSoon();
    } catch (e) {
      warn("translate-message", e);
      msg.translation = "翻译失败：" + String(e.message || e).slice(0, 120);
      msg.translationError = true;
    } finally {
      delete state.translateInflight[msg.id];
      queueRender("keep");
    }
  }

  async function maybeAutoTranslateLatest(msg) {
    if (!state.cfg || !state.cfg.autoTranslateLastMsg) return;
    if (!msg || msg.mine || msg.sending || msg.failed) return;
    setTimeout(function () { translateMessage(msg, false); }, 50);
  }

  function getProvider() {
    return state.cfg && state.cfg.translateProvider === "ai" ? "ai" : "google";
  }

  function buildLangOptions(selected) {
    return LANG_LIST.map(function (x) {
      return '<option value="' + escAttr(x.n) + '"' + (x.n === selected ? ' selected' : '') + '>' + esc(x.f + ' ' + x.n) + '</option>';
    }).join("");
  }

  function openLangPanel(which) {
    state.pickingLangFor = which;
    var mask = byId("cp-topic-lang-mask");
    var grid = byId("cp-topic-lang-grid");
    var title = byId("cp-topic-lang-title");
    if (!mask || !grid) return;
    var current = which === "source" ? state.cfg.sourceLang : state.cfg.targetLang;
    if (title) title.textContent = which === "source" ? "选择我的语言" : "选择对方语言";
    grid.innerHTML = LANG_LIST.map(function (x) {
      return '<button type="button" class="cp-lang-item2' + (x.n === current ? ' active' : '') + '" data-lang="' + escAttr(x.n) + '">' + esc(x.f + ' ' + x.n) + '</button>';
    }).join("");
    mask.hidden = false;
  }

  function closeLangPanel() {
    var mask = byId("cp-topic-lang-mask");
    if (mask) mask.hidden = true;
    state.pickingLangFor = "";
  }

  function syncTranslateUI() {
    if (!state.cfg) return;
    var src = byId("cp-topic-src-lang");
    var tgt = byId("cp-topic-tgt-lang");
    var srcSet = byId("cp-topic-src-lang-setting");
    var tgtSet = byId("cp-topic-tgt-lang-setting");
    var sendToggle = byId("cp-topic-send-translate-toggle");
    if (src) src.value = state.cfg.sourceLang;
    if (tgt) tgt.value = state.cfg.targetLang;
    var srcBtn = byId("cp-topic-src-lang-btn");
    var tgtBtn = byId("cp-topic-tgt-lang-btn");
    if (srcBtn) srcBtn.textContent = getFlag(state.cfg.sourceLang) + " " + state.cfg.sourceLang;
    if (tgtBtn) tgtBtn.textContent = getFlag(state.cfg.targetLang) + " " + state.cfg.targetLang;
    if (srcSet) srcSet.value = state.cfg.sourceLang;
    if (tgtSet) tgtSet.value = state.cfg.targetLang;
    if (sendToggle) sendToggle.classList.toggle("active", !!state.cfg.sendTranslateEnabled);
    var transBar = byId("cp-topic-translate-bar");
    if (transBar) transBar.classList.toggle("is-on", !!state.cfg.sendTranslateEnabled);
    var auto = byId("cp-topic-auto-translate");
    if (auto) auto.checked = !!state.cfg.autoTranslateLastMsg;
    var quick = byId("cp-topic-quick-translate");
    if (quick) quick.checked = !!state.cfg.showQuickTranslate;
    var providerGoogle = byId("cp-topic-provider-google");
    var providerAi = byId("cp-topic-provider-ai");
    var provider = getProvider();
    if (providerGoogle) providerGoogle.classList.toggle("active", provider === "google");
    if (providerAi) providerAi.classList.toggle("active", provider === "ai");
    var settingsMask = byId("cp-topic-settings-mask");
    if (settingsMask) { settingsMask.classList.toggle("provider-ai", provider === "ai"); settingsMask.classList.toggle("provider-google", provider === "google"); }
    var aiPane = byId("cp-topic-ai-pane");
    if (aiPane) aiPane.classList.toggle("show", provider === "ai");
    var googleEp = byId("cp-topic-google-endpoint");
    var ep = byId("cp-topic-ai-endpoint");
    var key = byId("cp-topic-ai-key");
    var model = byId("cp-topic-ai-model");
    var bgOp = byId("cp-topic-bg-opacity");
    var bgOpVal = byId("cp-topic-bg-op-val");
    var bgBlur = byId("cp-topic-bg-blur");
    var bgBlurVal = byId("cp-topic-bg-blur-val");
    var bgDim = state.bg && state.bg.opacity != null ? Number(state.bg.opacity) : DEFAULT_BG.opacity;
    if (bgDim > 0.45) bgDim = DEFAULT_BG.opacity;
    var blurPx = state.bg && state.bg.blur != null ? Number(state.bg.blur) : DEFAULT_BG.blur;
    if (bgOp) bgOp.value = String(bgDim);
    if (bgOpVal) bgOpVal.textContent = Math.round(bgDim * 100) + "%";
    if (bgBlur) bgBlur.value = String(blurPx || 0);
    if (bgBlurVal) bgBlurVal.textContent = String(Math.round(blurPx || 0)) + "px";
    if (googleEp) googleEp.value = state.cfg.googleEndpoint || DEFAULT_CFG.googleEndpoint || "";
    if (ep) ep.value = state.cfg.ai.endpoint || "";
    if (key) key.value = state.cfg.ai.apiKey || "";
    if (model) model.value = state.cfg.ai.model || "gpt-4o-mini";
  }

  function saveTranslateSettingsFromUI() {
    try {
      if (!state.cfg) state.cfg = normalizeConfig({});
      if (!state.cfg.ai) state.cfg.ai = cloneJSON(DEFAULT_CFG.ai);
      var srcEl = byId("cp-topic-src-lang");
      var tgtEl = byId("cp-topic-tgt-lang");
      if (srcEl && srcEl.value) state.cfg.sourceLang = srcEl.value;
      if (tgtEl && tgtEl.value) state.cfg.targetLang = tgtEl.value;
      var autoEl = byId("cp-topic-auto-translate");
      if (autoEl) state.cfg.autoTranslateLastMsg = !!autoEl.checked;
      state.cfg.showQuickTranslate = true;
      var gEp = byId("cp-topic-google-endpoint");
      if (gEp) state.cfg.googleEndpoint = (gEp.value || "").trim() || DEFAULT_CFG.googleEndpoint;
      var endpointEl = byId("cp-topic-ai-endpoint");
      var keyEl = byId("cp-topic-ai-key");
      var modelEl = byId("cp-topic-ai-model");
      if (endpointEl) state.cfg.ai.endpoint = (endpointEl.value || "").trim() || DEFAULT_CFG.ai.endpoint;
      if (keyEl) state.cfg.ai.apiKey = (keyEl.value || "").trim();
      if (modelEl) state.cfg.ai.model = (modelEl.value || "").trim() || "gpt-4o-mini";
      if (!state.bg) state.bg = cloneJSON(DEFAULT_BG);
      var bgOpEl = byId("cp-topic-bg-opacity");
      var bgBlurEl = byId("cp-topic-bg-blur");
      if (bgOpEl) state.bg.opacity = Number(bgOpEl.value || DEFAULT_BG.opacity);
      if (bgBlurEl) state.bg.blur = Number(bgBlurEl.value || DEFAULT_BG.blur);
      saveJSON(KEY_CFG, state.cfg);
      saveJSON(KEY_BG, state.bg);
      applyBackground();
      syncTranslateUI();
      return true;
    } catch (e) {
      warn("save-settings", e);
      toast("保存失败：" + String(e.message || e).slice(0, 80));
      return false;
    }
  }

  function openSettings() {
    var mask = byId("cp-topic-settings-mask");
    if (mask) { syncTranslateUI(); mask.hidden = false; }
  }

  function closeSettings() {
    var mask = byId("cp-topic-settings-mask");
    if (mask) mask.hidden = true;
  }


  function injectStyle() {
    // CSS is registered from plugin.json -> scss/topic-chat-ui.scss.
    // Keep this no-op so older calls do not break.
  }

  function injectRoot() {
    if (byId(ROOT_ID)) return;
    var html = `
      <div id="${ROOT_ID}">
        <div class="cp-bg" id="cp-topic-bg"></div>
        <div class="cp-bg-mask"></div>
        <header class="cp-header">
          <button type="button" class="cp-header-back" id="cp-topic-back" aria-label="返回">‹</button>
          <div class="cp-header-peer">
            <div class="cp-peer-avatar" id="cp-topic-avatar"></div>
            <div class="cp-header-center">
              <div class="cp-topic-title" id="cp-topic-title">加载中...</div>
              <div class="cp-topic-sub" id="cp-topic-sub"></div>
            </div>
          </div>
          <div class="cp-header-actions"><button id="cp-topic-settings" type="button" aria-label="设置"><i class="fa fa-ellipsis-v"></i></button></div>
        </header>
        <main class="cp-main" id="cp-topic-main">
          <div class="cp-top-spinner" id="cp-topic-load-more"><button type="button">加载更早消息</button></div>
          <div id="cp-topic-msg-list"></div>
          <div id="cp-topic-empty" class="cp-empty" hidden>还没有消息，发第一句吧。</div>
          <div id="cp-topic-bottom-anchor"></div>
        </main>
        <button id="cp-topic-fab" class="cp-fab-bottom" type="button">⌄<span id="cp-topic-badge" class="cp-fab-badge" hidden>0</span></button>
        <button id="cp-topic-at-banner" class="cp-at-banner" type="button" hidden><i class="fa fa-at"></i><span id="cp-topic-at-banner-text"></span><em>点击查看</em></button>
        <footer class="cp-footer" id="cp-topic-footer">
          <div class="cp-translate-shell">
            <div class="cp-translate-bar" id="cp-topic-translate-bar">
              <button class="cp-lang-chip" id="cp-topic-src-lang-btn" type="button"></button><select class="cp-lang-select" id="cp-topic-src-lang"></select>
              <button class="cp-swap-btn" id="cp-topic-lang-swap" type="button">⇄</button>
              <button class="cp-lang-chip" id="cp-topic-tgt-lang-btn" type="button"></button><select class="cp-lang-select" id="cp-topic-tgt-lang"></select>
              <button class="cp-translate-toggle" id="cp-topic-send-translate-toggle" type="button" title="开启后：输入框内容会先翻译再发送">译</button>
            </div>
          </div>
          <div class="cp-status-line" id="cp-topic-status-line"></div>
          <div id="cp-topic-quote-preview" class="cp-quote-preview" hidden><div class="cp-quote-preview-bar"></div><div class="cp-quote-preview-body"><b id="cp-topic-quote-name"></b><span id="cp-topic-quote-text"></span></div><button id="cp-topic-quote-close" type="button">×</button></div>
          <div class="cp-toolbar" id="cp-topic-toolbar">
            <div id="cp-topic-upload-progress-wrap" class="cp-progress-wrap" hidden><div id="cp-topic-upload-progress-bar" class="cp-progress-bar"></div></div>
            <div id="cp-topic-toolbar-inputs" style="display:flex;width:100%;align-items:flex-end;">
              <button id="cp-topic-plus" class="cp-tool-btn" type="button" aria-label="更多">＋</button>
              <div class="cp-input-box"><textarea id="cp-topic-input" rows="1" placeholder="发送消息..." autocomplete="off"></textarea></div>
              <button id="cp-topic-send" class="cp-primary-btn" type="button"><span id="cp-topic-primary-icon"><i class="fa fa-microphone"></i></span></button>
            </div>
            <div id="cp-topic-rec-inline" class="cp-rec-inline" hidden>
              <button id="cp-topic-rec-cancel" class="cp-rec-btn-icon" type="button"><i class="fa fa-trash-o" style="font-size:20px;"></i></button>
              <div class="cp-rec-vis"><span class="cp-rec-dot"></span><div class="cp-rec-dash"></div><div class="cp-rec-bars" id="cp-topic-rec-bars"></div></div>
              <button id="cp-topic-rec-pause" class="cp-rec-btn-icon" type="button"><i class="fa fa-pause-circle" style="font-size:22px;color:#0ea5e9;"></i></button>
              <span id="cp-topic-rec-time" style="font-size:16px;color:#4b5563;font-family:sans-serif;font-weight:500;width:42px;text-align:center;">0:00</span>
              <button id="cp-topic-rec-send" class="cp-rec-btn-icon" type="button"><i class="fa fa-paper-plane" style="font-size:20px;color:#0ea5e9;"></i></button>
            </div>
          </div>
          <div class="cp-media-pop" id="cp-topic-media-pop" hidden>
            <button id="cp-topic-pick-camera" type="button"><i class="fa fa-camera"></i><span>拍照</span></button>
            <button id="cp-topic-pick-album" type="button"><i class="fa fa-picture-o"></i><span>相册图片/视频</span></button>
          </div>
        </footer>
        <div id="cp-topic-media-confirm" class="cp-media-confirm" hidden><div class="cp-media-confirm-card"><div class="cp-media-confirm-head">预览后发送</div><div id="cp-topic-media-confirm-list" class="cp-media-confirm-list"></div><div class="cp-media-confirm-actions"><button id="cp-topic-media-confirm-cancel" type="button">取消</button><button id="cp-topic-media-confirm-send" type="button">发送</button></div></div></div>
        <input id="cp-topic-media-file" type="file" accept="image/*,video/*" multiple hidden />
        <input id="cp-topic-camera-file" type="file" accept="image/*,video/*" capture="environment" hidden />
        <input id="cp-topic-bg-file" type="file" accept="image/*" hidden />
        <div class="cp-toast" id="cp-topic-toast"></div>
        <div class="cp-preview-mask" id="cp-topic-preview-mask" hidden><div id="cp-topic-preview-body" class="cp-preview-body"></div></div>
        <div id="cp-topic-context-overlay" class="cp-context-overlay" hidden><div id="cp-topic-context-menu" class="cp-context-menu"></div></div>
        <div id="cp-topic-lang-mask" class="cp-lang-mask" hidden><div class="cp-lang-panel"><div class="cp-lang-title" id="cp-topic-lang-title">选择语言</div><div class="cp-lang-grid2" id="cp-topic-lang-grid"></div></div></div>

        <div class="cp-modal-mask" id="cp-topic-settings-mask" hidden>
          <div class="cp-modal">
            <div class="cp-modal-head" style="display:none">
              <button class="cp-modal-close" id="cp-topic-settings-close" type="button" aria-label="关闭">×</button>
            </div>
            <div class="cp-modal-body">
              <div class="cp-section cp-section-flat">
                <div class="cp-section-title"><span>自动翻译</span></div>
                <label class="cp-toggle-row"><span>自动翻译对方消息</span><input id="cp-topic-auto-translate" type="checkbox" /></label>
                <div class="cp-section-title cp-subtitle"><span>翻译接口</span></div>
                <div class="cp-provider-tabs">
                  <button class="cp-provider-tab" id="cp-topic-provider-google" type="button">机翻</button>
                  <button class="cp-provider-tab" id="cp-topic-provider-ai" type="button">AI 翻译</button>
                </div>
                <label class="cp-field cp-google-field"><span>翻译地址</span><input id="cp-topic-google-endpoint" type="text" placeholder="https://translate.googleapis.com/translate_a/single" /></label>
                <div id="cp-topic-ai-pane" class="cp-ai-pane">
                  <label class="cp-field"><span>AI 接口 URL</span><input id="cp-topic-ai-endpoint" type="text" placeholder="https://api.openai.com/v1" /></label>
                  <label class="cp-field"><span>API Key</span><input id="cp-topic-ai-key" type="password" placeholder="填你的 AI Key，仅保存在当前浏览器" /></label>
                  <label class="cp-field"><span>模型</span><input id="cp-topic-ai-model" type="text" placeholder="gpt-4o-mini / qwen / deepseek" /></label>
                </div>
              </div>

              <div class="cp-section cp-section-flat">
                <div class="cp-section-title"><span>聊天背景</span></div>
                <div class="cp-bg-actions">
                  <button class="cp-bg-btn" id="cp-topic-bg-upload" type="button">选择本地背景</button>
                  <button class="cp-bg-btn" id="cp-topic-bg-clear" type="button">清除背景</button>
                </div>
                <label class="cp-field"><span>背景暗度 <em id="cp-topic-bg-op-val">8%</em></span><input id="cp-topic-bg-opacity" type="range" min="0" max="0.45" step="0.01" /></label>
                <label class="cp-field"><span>毛玻璃模糊 <em id="cp-topic-bg-blur-val">0px</em></span><input id="cp-topic-bg-blur" type="range" min="0" max="18" step="1" /></label>
              </div>

              <div class="cp-modal-actions">
                <button class="cp-btn-secondary" id="cp-topic-settings-cancel" type="button">关闭</button>
                <button class="cp-btn-primary" id="cp-topic-settings-save" type="button">保存</button>
              </div>
            </div>
          </div>
        </div>
      </div>`;
    document.body.insertAdjacentHTML("beforeend", html);
    ["cp-topic-src-lang", "cp-topic-tgt-lang"].forEach(function (id) {
      var el = byId(id);
      if (el) el.innerHTML = buildLangOptions(id.indexOf("tgt") > -1 ? state.cfg.targetLang : state.cfg.sourceLang);
    });
    syncTranslateUI();
  }

  function bindUI() {
    byId("cp-topic-back").onclick = function () {
      if (history.length > 1) history.back();
      else location.href = "/category/" + CONFIG.targetCid;
    };
    var atBanner = byId("cp-topic-at-banner");
    if (atBanner) atBanner.onclick = function () { var mid=this.getAttribute("data-mid"); var n=(state.mentionNotices||[]).find(function(x){return String(x.id)===String(mid)||String(x.remoteId||"")===String(mid);}); scrollToNotice(n || {id:mid}); };
    byId("cp-topic-settings").onclick = openSettings;
    byId("cp-topic-settings-close").onclick = closeSettings;
    byId("cp-topic-settings-cancel").onclick = closeSettings;
    byId("cp-topic-settings-save").onclick = function () { if (saveTranslateSettingsFromUI()) { closeSettings(); toast("设置已保存"); } };
    byId("cp-topic-settings-mask").addEventListener("click", function (e) { if (e.target === this) closeSettings(); });
    var qClose = byId("cp-topic-quote-close");
    if (qClose) qClose.onclick = hideQuoteBar;
    var ctxOverlay = byId("cp-topic-context-overlay");
    if (ctxOverlay) ctxOverlay.addEventListener("click", function (e) { if (e.target === ctxOverlay) hideContextMenu(); });
    var ctxMenu = byId("cp-topic-context-menu");
    if (ctxMenu) ctxMenu.addEventListener("click", function (e) {
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
    });

    var srcBtn = byId("cp-topic-src-lang-btn");
    var tgtBtn = byId("cp-topic-tgt-lang-btn");
    if (srcBtn) srcBtn.onclick = function () { openLangPanel("source"); };
    if (tgtBtn) tgtBtn.onclick = function () { openLangPanel("target"); };
    var langMask = byId("cp-topic-lang-mask");
    if (langMask) langMask.addEventListener("click", function (e) {
      if (e.target === langMask) return closeLangPanel();
      var item = e.target.closest(".cp-lang-item2");
      if (!item) return;
      var lang = item.getAttribute("data-lang");
      if (state.pickingLangFor === "source") state.cfg.sourceLang = lang;
      else state.cfg.targetLang = lang;
      saveJSON(KEY_CFG, state.cfg);
      ["cp-topic-src-lang", "cp-topic-tgt-lang"].forEach(function (id) { var el = byId(id); if (el) el.innerHTML = buildLangOptions(id.indexOf("tgt") > -1 ? state.cfg.targetLang : state.cfg.sourceLang); });
      syncTranslateUI();
      closeLangPanel();
    });

    byId("cp-topic-provider-google").onclick = function () { state.cfg.translateProvider = "google"; saveJSON(KEY_CFG, state.cfg); syncTranslateUI(); };
    byId("cp-topic-provider-ai").onclick = function () { state.cfg.translateProvider = "ai"; saveJSON(KEY_CFG, state.cfg); syncTranslateUI(); };
    byId("cp-topic-lang-swap").onclick = function () {
      var a = state.cfg.sourceLang;
      state.cfg.sourceLang = state.cfg.targetLang;
      state.cfg.targetLang = a;
      saveJSON(KEY_CFG, state.cfg);
      ["cp-topic-src-lang", "cp-topic-tgt-lang"].forEach(function (id) { var el = byId(id); if (el) el.innerHTML = buildLangOptions(id.indexOf("tgt") > -1 ? state.cfg.targetLang : state.cfg.sourceLang); });
      syncTranslateUI();
    };
    byId("cp-topic-send-translate-toggle").onclick = function () {
      state.cfg.sendTranslateEnabled = !state.cfg.sendTranslateEnabled;
      saveJSON(KEY_CFG, state.cfg);
      syncTranslateUI();
      toast(state.cfg.sendTranslateEnabled ? "译发已开启：发译文给对方，你这边保留原文" : "译发已关闭");
    };
    byId("cp-topic-src-lang").addEventListener("change", function () { state.cfg.sourceLang = this.value; saveJSON(KEY_CFG, state.cfg); syncTranslateUI(); });
    byId("cp-topic-tgt-lang").addEventListener("change", function () { state.cfg.targetLang = this.value; saveJSON(KEY_CFG, state.cfg); syncTranslateUI(); });

    byId("cp-topic-fab").onclick = function () { state.unread = 0; updateFab(); forceBottom(); };
    byId("cp-topic-load-more").onclick = function () { fetchHistory(true); };
    byId("cp-topic-send").onclick = handlePrimaryAction;
    byId("cp-topic-plus").onclick = function (e) { e.stopPropagation(); var pop = byId("cp-topic-media-pop"); if (pop) pop.hidden = !pop.hidden; };
    byId("cp-topic-pick-camera").onclick = function () { byId("cp-topic-media-pop").hidden = true; byId("cp-topic-camera-file").click(); };
    byId("cp-topic-pick-album").onclick = function () { byId("cp-topic-media-pop").hidden = true; byId("cp-topic-media-file").click(); };
    byId("cp-topic-media-file").addEventListener("change", onPickMedia);
    byId("cp-topic-camera-file").addEventListener("change", onPickMedia);
    var bgInput = byId("cp-topic-bg-file");
    if (bgInput) bgInput.addEventListener("change", handleBackgroundUpload);
    var bgUpload = byId("cp-topic-bg-upload");
    if (bgUpload) bgUpload.onclick = function () { var f = byId("cp-topic-bg-file"); if (f) f.click(); };
    var bgClear = byId("cp-topic-bg-clear");
    if (bgClear) bgClear.onclick = function () { state.bg = cloneJSON(DEFAULT_BG); saveJSON(KEY_BG, state.bg); applyBackground(); syncTranslateUI(); toast("背景已清除"); };
    var bgOp = byId("cp-topic-bg-opacity");
    if (bgOp) bgOp.addEventListener("input", function () { state.bg.opacity = Number(this.value); saveJSON(KEY_BG, state.bg); applyBackground(); syncTranslateUI(); });
    var bgBlur = byId("cp-topic-bg-blur");
    if (bgBlur) bgBlur.addEventListener("input", function () { state.bg.blur = Number(this.value); saveJSON(KEY_BG, state.bg); applyBackground(); syncTranslateUI(); });
    byId("cp-topic-rec-cancel").onclick = function () { stopRecording(false); };
    byId("cp-topic-rec-send").onclick = function () { stopRecording(true); };
    byId("cp-topic-rec-pause").onclick = togglePauseRecording;
    state.audio.addEventListener("ended", onAudioEnded);
    document.addEventListener("click", function (e) { var pop = byId("cp-topic-media-pop"); if (pop && !pop.hidden && !e.target.closest("#cp-topic-media-pop") && !e.target.closest("#cp-topic-plus")) pop.hidden = true; });
    var pMask = byId("cp-topic-preview-mask");
    if (pMask) {
      var previewStartX = 0;
      pMask.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        var y = e.clientY || 0;
        if (e.target.closest("[data-act='close-preview']") || !e.target.closest("video") || y > window.innerHeight * 0.66) closePreview();
      }, true);
      pMask.addEventListener("touchstart", function (e) { previewStartX = e.touches && e.touches[0] ? e.touches[0].clientX : 0; }, { passive:true });
      pMask.addEventListener("touchend", function (e) {
        if (!previewStartX || !e.changedTouches || !e.changedTouches[0]) return;
        var dx = e.changedTouches[0].clientX - previewStartX;
        if (Math.abs(dx) > 46) {
          e.preventDefault && e.preventDefault();
          e.stopPropagation && e.stopPropagation();
          closePreview();
        }
        previewStartX = 0;
      }, { passive:false });
    }

    var input = byId("cp-topic-input");
    input.addEventListener("input", function () { autoGrow(input); updateSendButton(); updateFooterHeight(); });
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey && !/Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)) {
        e.preventDefault();
        handlePrimaryAction();
      }
    });

    var main = byId("cp-topic-main");
    main.addEventListener("scroll", function () {
      state.stickToBottom = isAtBottom();
      if (state.stickToBottom) state.unread = 0;
      updateFab();
      clearTimeout(state.progressSaveTimer);
      state.progressSaveTimer = setTimeout(saveCurrentProgress, 300);
      if (main.scrollTop < 90 && !state.loadingHistory && !state.hasNoMore) fetchHistory(true);
    }, { passive: true });


    byId("cp-topic-msg-list").addEventListener("click", function (e) {
      var avatarLink = e.target.closest(".cp-avatar-wrap");
      if (avatarLink) {
        e.preventDefault();
        var uid = avatarLink.getAttribute("data-uid") || "";
        var href = avatarLink.getAttribute("href") || "#";
        if (href && href !== "#") { location.href = href; return; }
        if (uid) resolveUserMeta(uid).then(function (u) {
          var url = getUserProfileHref(uid, u && (u.username || u.userslug || u.displayname));
          if (url && url !== "#") location.href = url;
        });
        return;
      }
      var quoteCard = e.target.closest(".cp-quote-card");
      if (quoteCard) {
        var qid = quoteCard.getAttribute("data-quote-mid") || "";
        if (qid) scrollToMessageId(qid);
        return;
      }
      var act = e.target.getAttribute("data-act") || (e.target.closest("[data-act]") && e.target.closest("[data-act]").getAttribute("data-act"));
      if (!act) return;
      var row = e.target.closest(".cp-row");
      var mid = row && row.getAttribute("data-mid");
      var msg = mid ? state.msgMap[mid] : null;
      if (!msg) return;
      if (act === "translate") translateMessage(msg, false);
      if (act === "retry-translate") translateMessage(msg, true);
      if (act === "toggle-translation") { msg.translationOpen = false; queueRender("keep"); saveCacheSoon(); }
      if (act === "preview-media") openPreview(msg);
      if (act === "play-voice") playVoice(msg, e.target.closest(".cp-voice"));
    });

    (function () {
      var list = byId("cp-topic-msg-list");
      var timer = null;
      var start = null;
      function clearLong() { if (timer) { clearTimeout(timer); timer = null; } }
      var moved = false;
      var scrollEl = byId("cp-topic-main");
      if (scrollEl) scrollEl.addEventListener("scroll", clearLong, { passive:true });
      list.addEventListener("touchstart", function (e) {
        var bubble = e.target.closest(".cp-bubble");
        if (!bubble) return;
        var row = bubble.closest(".cp-row");
        if (!row) return;
        var mid = row.getAttribute("data-mid");
        var msg = mid ? state.msgMap[mid] : null;
        if (!msg) return;
        moved = false;
        start = e.touches && e.touches[0] ? { x:e.touches[0].clientX, y:e.touches[0].clientY } : null;
        timer = setTimeout(function () { if (moved) return; timer = null; showContextMenu(msg); }, 520);
      }, { passive:true });
      list.addEventListener("touchmove", function (e) {
        if (!timer || !start || !e.touches || !e.touches[0]) return;
        var dx = Math.abs(e.touches[0].clientX - start.x);
        var dy = Math.abs(e.touches[0].clientY - start.y);
        if (dx > 6 || dy > 6) { moved = true; clearLong(); }
      }, { passive:true });
      list.addEventListener("touchend", clearLong, { passive:true });
      list.addEventListener("touchcancel", clearLong, { passive:true });
      list.addEventListener("contextmenu", function (e) {
        var bubble = e.target.closest(".cp-bubble");
        if (!bubble) return;
        var row = bubble.closest(".cp-row");
        if (!row) return;
        var msg = state.msgMap[row.getAttribute("data-mid")];
        if (!msg) return;
        e.preventDefault();
        showContextMenu(msg);
      });
    })();

    if (window.visualViewport && !state.observerBound) {
      state.observerBound = true;
      var handler = function () { updateViewport(); updateFooterHeight(); };
      window.visualViewport.addEventListener("resize", handler, { passive: true });
      window.visualViewport.addEventListener("scroll", handler, { passive: true });
    }
  }

  function updateHeader() {
    var title = byId("cp-topic-title");
    var sub = byId("cp-topic-sub");
    var avatar = byId("cp-topic-avatar");
    if (title) title.textContent = state.topic ? state.topic.title : "话题聊天室";
    if (sub) sub.textContent = state.onlineCount > 0 ? ("在线 " + state.onlineCount + " 人") : "";
    if (avatar) {
      avatar.innerHTML = '<span class="cp-topic-hash-avatar" aria-hidden="true">#</span>';
      avatar.classList.add("cp-peer-avatar-hash");
      avatar.removeAttribute("href");
    }
  }

  function setStatus(text, lineText) {
    state.statusText = text || state.statusText;
    updateHeader();
    var line = byId("cp-topic-status-line");
    if (!line) return;
    if (lineText) {
      line.textContent = lineText;
      line.classList.add("show");
    } else {
      line.classList.remove("show");
    }
    updateFooterHeight();
  }

  function updateViewport() {
    var vv = window.visualViewport;
    var offset = 0;
    if (vv) offset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    var footer = byId("cp-topic-footer");
    if (footer) footer.style.bottom = offset + "px";
  }

  function updateFooterHeight() {
    clearTimeout(footerTimer);
    footerTimer = setTimeout(function () {
      var footer = byId("cp-topic-footer");
      var root = byId(ROOT_ID);
      if (!footer || !root) return;
      var h = Math.max(78, Math.ceil(footer.offsetHeight || 78));
      root.style.setProperty("--cp-footer-h", h + "px");
      if (state.stickToBottom) requestAnimationFrame(forceBottom);
    }, 0);
  }

  function autoGrow(input) {
    input.style.height = "36px";
    input.style.height = Math.min(input.scrollHeight, 120) + "px";
  }

  function updateSendButton() {
    var text = (byId("cp-topic-input").value || "").trim();
    var btn = byId("cp-topic-send");
    var icon = byId("cp-topic-primary-icon");
    if (!btn) return;
    btn.classList.toggle("send", !!text);
    if (icon) icon.innerHTML = text ? "↑" : "<i class=\"fa fa-microphone\"></i>";
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
    var fab = byId("cp-topic-fab");
    var badge = byId("cp-topic-badge");
    if (!fab || !badge) return;
    fab.classList.toggle("show", !state.stickToBottom);
    if (state.unread > 0) {
      badge.hidden = false;
      badge.textContent = state.unread > 99 ? "99+" : String(state.unread);
    } else {
      badge.hidden = true;
    }
  }

  function queueRender(mode) {
    if (state.renderPending) return;
    state.renderPending = true;
    requestAnimationFrame(function () {
      state.renderPending = false;
      render(mode || "keep");
    });
  }

  function shouldShowTimeSep(prev, cur) {
    if (!cur) return false;
    if (!prev) return true;
    if (formatDayLabel(prev.ts) !== formatDayLabel(cur.ts)) return true;
    return Math.abs((cur.ts || 0) - (prev.ts || 0)) > 5 * 60 * 1000;
  }

  function isTail(prev, cur, next) {
    if (!cur) return false;
    if (!next) return true;
    if (next.mine !== cur.mine) return true;
    if (String(next.uid || "") !== String(cur.uid || "")) return true;
    return Math.abs((next.ts || 0) - (cur.ts || 0)) > 2 * 60 * 1000;
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
    // 微信式 @ 样式，只改显示，不靠文本识别 uid。真实 uid 仍来自长按 @TA / mention_uids。
    return safe.replace(/(^|[\s>])@([^\s<@]{1,24})/g, function (_, prefix, name) {
      return prefix + '<span class="cp-at-pill">@' + esc(name) + '</span>';
    });
  }

  function showQuoteBar(msg) {
    state.quoteTarget = msg || null;
    var bar = byId("cp-topic-quote-preview");
    if (!bar || !msg) return;
    var n = byId("cp-topic-quote-name");
    var t = byId("cp-topic-quote-text");
    if (n) n.textContent = displayNameForMessage(msg) || msg.username || "引用";
    if (t) t.textContent = getQuotePreviewText(msg) || "[引用消息]";
    bar.hidden = false;
    var input = byId("cp-topic-input");
    if (input) input.focus();
    updateFooterHeight();
  }

  function hideQuoteBar() {
    state.quoteTarget = null;
    var bar = byId("cp-topic-quote-preview");
    if (bar) bar.hidden = true;
    updateFooterHeight();
  }

  function insertMention(msg) {
    if (!msg) return;
    var input = byId("cp-topic-input");
    if (!input) return;
    var name = displayNameForMessage(msg).replace(/\s+/g, "");
    var mention = "@" + name + " ";
    if (msg.uid) {
      state.pendingMentionUids = state.pendingMentionUids || [];
      state.pendingMentionMap = state.pendingMentionMap || {};
      var muid = String(msg.uid);
      if (state.pendingMentionUids.indexOf(muid) < 0) state.pendingMentionUids.push(muid);
      var display = displayNameForMessage(msg) || msg.username || name;
      state.pendingMentionMap[muid] = { uid: muid, username: msg.username || display || name, displayname: display || name, userslug: msg.userslug || "" };
      if (!state.userCache[muid]) resolveUserMeta(muid);
      toast("已 @" + name);
    }
    var cur = String(input.value || "");
    input.value = cur ? (cur + (cur.endsWith(" ") ? "" : " ") + mention) : mention;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();
  }

  function deleteLocalMessage(id) {
    if (!id) return;
    state.messages = state.messages.filter(function (m) { return String(m.id) !== String(id); });
    delete state.msgMap[id];
    saveCacheSoon();
    queueRender("keep");
  }


  function saveMediaMessage(msg) {
    if (!msg) return;
    var url = toPlayableUrl(msg.mediaUrl || msg.audioUrl || "");
    if (!url) return toast("没有可保存的媒体");
    try {
      var a = document.createElement("a");
      a.href = url;
      a.download = (msg.type || "media") + "-" + Date.now();
      a.target = "_blank";
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { try { a.remove(); } catch (_) {} }, 300);
    } catch (_) { window.open(url, "_blank"); }
  }

  function showContextMenu(msg) {
    if (!msg) return;
    state.contextMsg = msg;
    var overlay = byId("cp-topic-context-overlay");
    var menu = byId("cp-topic-context-menu");
    if (!overlay || !menu) return;
    var saveBtn = (msg.type === "image" || msg.type === "video") ? '<button class="cp-menu-item" data-menu-act="save" type="button"><i class="fa fa-download"></i><span>保存</span></button>' : '';
    menu.innerHTML =
      '<button class="cp-menu-item" data-menu-act="reply" type="button"><i class="fa fa-reply"></i><span>回复</span></button>' +
      '<button class="cp-menu-item" data-menu-act="mention" type="button"><i class="fa fa-at"></i><span>@TA</span></button>' +
      '<button class="cp-menu-item" data-menu-act="translate" type="button"><i class="fa fa-language"></i><span>翻译</span></button>' +
      saveBtn +
      '<button class="cp-menu-item danger" data-menu-act="delete" type="button"><i class="fa fa-trash"></i><span>删除</span></button>';
    overlay.hidden = false;
  }

  function hideContextMenu() {
    var overlay = byId("cp-topic-context-overlay");
    if (overlay) overlay.hidden = true;
    state.contextMsg = null;
  }

  function render(mode) {
    var list = byId("cp-topic-msg-list");
    var empty = byId("cp-topic-empty");
    var main = byId("cp-topic-main");
    if (!list) return;

    var oldHeight = main ? main.scrollHeight : 0;
    var oldTop = main ? main.scrollTop : 0;
    var html = "";
    var msgs = state.messages;
    var waveHeights = [5, 8, 12, 16, 10, 7, 14, 9, 13, 6, 11, 15];
    var lastPeerTextMsgId = "";
    for (var lp = msgs.length - 1; lp >= 0; lp--) {
      if (!msgs[lp].mine && msgs[lp].type === "text" && !msgs[lp].translationOpen) { lastPeerTextMsgId = msgs[lp].id; break; }
    }

    for (var i = 0; i < msgs.length; i++) {
      var m = normalizeMessageMedia(msgs[i]);
      var prev = msgs[i - 1];
      var next = msgs[i + 1];
      if (!m.mine && (!m.username || /^用户\d+$/.test(m.username))) resolveUserMeta(m.uid);
      if (shouldShowTimeSep(prev, m)) html += '<div class="cp-time-sep"><span>' + formatTimeDivider(m.ts) + '</span></div>';
      var samePrev = !!(prev && prev.mine === m.mine && String(prev.uid || "") === String(m.uid || "") && Math.abs((m.ts || 0) - (prev.ts || 0)) < 2 * 60 * 1000 && formatDayLabel(prev.ts) === formatDayLabel(m.ts));
      var sameNext = !!(next && next.mine === m.mine && String(next.uid || "") === String(m.uid || "") && Math.abs((next.ts || 0) - (m.ts || 0)) < 2 * 60 * 1000 && formatDayLabel(next.ts) === formatDayLabel(m.ts));
      var showIdentity = !m.mine && !samePrev;
      var cls = (m.mine ? "mine" : "other") + (showIdentity ? " show-name" : " grouped");
      var profileHref = getUserProfileHref(m.uid, m.username);
      var avatar = m.mine ? "" : (showIdentity ? '<a class="cp-avatar-wrap" href="' + escAttr(profileHref) + '" data-ajaxify="false" data-uid="' + escAttr(m.uid || "") + '" title="查看主页">' + getAvatarHtml(m.uid, m.username) + '</a>' : '<div class="cp-avatar-spacer"></div>');
      var nameText = (!m.mine ? displayNameForMessage(m) : "");
      var nameFlag = flagForMessage(m);
      var name = showIdentity ? '<div class="cp-name">' + (nameFlag ? '<span class="cp-name-flag">' + esc(nameFlag) + '</span> ' : '') + esc(nameText) + '</div>' : "";
      var status = m.failed ? '<span class="cp-status-failed"> 失败</span>' : (m.sending ? '<span class="cp-status-sending"> 发送中</span>' : "");
      var trans = "";
      if (m.translationOpen && m.translation) {
        trans = '<div class="cp-translation-wrap"><div class="cp-translation-text' + (m.translationError ? ' is-error' : '') + '" data-act="' + (m.translationError ? 'retry-translate' : 'toggle-translation') + '">' + (m.translation === "翻译中..." ? "⏳ " : "✨ ") + esc(m.translation) + (m.translationError ? "（点此重试）" : "") + '</div></div>';
      }
      var quick = (!m.mine && m.id === lastPeerTextMsgId && m.type === "text" && !m.translationOpen) ? '<button type="button" class="cp-quick-trans" data-act="translate" title="翻译">译</button>' : "";
      var sentTrans = "";
      var noticeType = getMentionNoticeType(m);
      var senderName = displayNameForMessage(m) || m.username || "有人";
      var replyHint = (!m.mine && noticeType === "reply") ? '<div class="cp-reply-me-hint"><strong>' + esc(senderName) + '</strong> 回复了你</div>' : ((!m.mine && noticeType === "mention") ? '<div class="cp-reply-me-hint"><strong>' + esc(senderName) + '</strong> @了你</div>' : '');
      sanitizeQuoteFields(m);
      var qText = String(m.quote || "").trim();
      var hasRealQuote = !!(qText || m.quoteMediaUrl || m.quoteAudioUrl);
      var qKind = getQuoteKindLabel(hasRealQuote ? (m.quoteType || "text") : "");
      if (hasRealQuote && !qText) qText = qKind ? ("[" + qKind + "]") : "";
      var qName = m.quoteUser || (m.quoteUid && state.userCache[m.quoteUid] ? (state.userCache[m.quoteUid].displayname || state.userCache[m.quoteUid].username) : "引用");
      var quoteHtml = hasRealQuote ? replyHint + '<div class="cp-quote-card' + (m.quoteUid && String(m.quoteUid) === String(state.uid) ? ' is-mine-ref' : '') + '" data-quote-mid="' + escAttr(m.quoteMsgId || '') + '"><div><b>' + esc(qName) + (qKind ? '<em class="cp-quote-kind">' + esc(qKind) + '</em>' : '') + '</b><span>' + esc(qText) + '</span></div></div>' : replyHint;
      var body = "";
      var bubbleExtra = "";

      if (m.type === "image") {
        bubbleExtra = " media-shell";
        body = quoteHtml + '<button class="cp-media-thumb" data-act="preview-media"><img src="' + escAttr(toPlayableUrl(m.mediaUrl || "")) + '" loading="lazy" /><span class="cp-media-time">' + formatTime(m.ts) + status + '</span></button>';
      } else if (m.type === "video") {
        bubbleExtra = " media-shell";
        body = quoteHtml + '<button class="cp-media-thumb cp-video-wrap" data-act="preview-media"><video src="' + escAttr(toPlayableUrl(m.mediaUrl || "")) + '" preload="metadata" muted playsinline></video><span class="cp-video-mark">视频</span><span class="cp-media-time">' + formatTime(m.ts) + status + '</span></button>';
      } else if (m.type === "voice") {
        var audioSrc = toPlayableUrl(m.audioUrl || m.mediaUrl || "");
        var unreadDot = "";
        body = quoteHtml + '<button class="cp-voice" data-act="play-voice" data-audio-src="' + escAttr(audioSrc) + '">' + unreadDot +
          '<span class="cp-play-circle"><i class="fa fa-play"></i></span>' +
          '<span class="cp-wave">' + waveHeights.map(function (h) { return '<i style="height:' + h + 'px"></i>'; }).join("") + '</span>' +
          '<div class="cp-voice-info-col"><span class="cp-voice-dur">' + esc(m.durationStr || "--:--") + '</span><span class="cp-voice-time">' + formatTime(m.ts) + status + '</span></div>' +
          '</button><audio class="cp-voice-native" src="' + escAttr(audioSrc) + '" preload="metadata" controls></audio>' + trans + quick;
      } else {
        body = quoteHtml + '<span class="cp-text">' + renderMessageText(m.text) + '</span><span class="cp-inline-time">' + formatTime(m.ts) + status + '</span>' + trans + sentTrans + quick;
      }

      var mentionCls = (!m.mine && (m.mentionMe || (m.text && state.username && m.text.indexOf("@" + state.username) >= 0))) ? " cp-mention-me" : "";
      html += '<div class="cp-row ' + cls + (sameNext ? ' has-next' : ' group-last') + '" data-mid="' + escAttr(m.id) + '">' + avatar + '<div class="cp-bubble-wrap">' + name + '<div class="cp-bubble' + bubbleExtra + mentionCls + '">' + body + '</div></div></div>';
    }

    list.innerHTML = html;
    if (empty) empty.hidden = msgs.length > 0;
    if (mode === "bottom") { requestAnimationFrame(forceBottom); setTimeout(forceBottom, 120); }
    else if (mode === "prepend" && main) {
      var newHeight = main.scrollHeight;
      main.scrollTop = oldTop + (newHeight - oldHeight);
    }
    updateFab();
  }

  function toast(text) {
    var el = byId("cp-topic-toast");
    if (!el) return;
    el.textContent = text;
    el.classList.add("show");
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.classList.remove("show"); }, 1800);
  }

  async function getToken() {
    var res = await fetch(CONFIG.tokenUrl, { credentials: "include" });
    if (!res.ok) throw new Error("token http " + res.status);
    var json = await res.json();
    if (!json || !json.uid || !json.token) throw new Error("token missing uid/token");
    state.uid = String(json.uid);
    state.token = String(json.token);
    state.username = json.username || getMyName();
    state.tokenData = json;
    return json;
  }

  async function ensureTopicChannel() {
    var res = await fetch(CONFIG.ensureUrl, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tid: state.topic.tid,
        cid: state.topic.cid,
        title: state.topic.title,
        channel_id: state.channelId,
        channel_type: CONFIG.channelType,
        temp_subscriber: 1
      })
    });
    if (!res.ok) {
      var txt = "";
      try { txt = await res.text(); } catch (_) {}
      throw new Error("ensure http " + res.status + " " + txt.slice(0, 300));
    }
    state.joinOk = true;
    return res.json().catch(function () { return {}; });
  }

  function ensureSdk() {
    return new Promise(function (resolve, reject) {
      if (window.wk && window.wk.WKSDK) return resolve();
      var old = document.querySelector('script[src*="wukongimjssdk"]');
      if (old) {
        old.addEventListener("load", function () { resolve(); });
        old.addEventListener("error", reject);
        setTimeout(function () { if (window.wk && window.wk.WKSDK) resolve(); }, 600);
        return;
      }
      var s = document.createElement("script");
      s.src = CONFIG.sdkUrl;
      s.onload = function () { resolve(); };
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  async function connectWk() {
    if (state.connectStarted) return;
    state.connectStarted = true;
    await ensureSdk();
    if (!window.wk || !window.wk.WKSDK) throw new Error("WKSDK missing");
    var shared = window.wk.WKSDK.shared();
    shared.config.uid = state.uid;
    shared.config.token = state.token;
    shared.config.addr = (state.tokenData && state.tokenData.addr) || ((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/wkws/");

    if (!shared.__cpTopicV22Listener) {
      shared.chatManager.addMessageListener(function (m) {
        try {
          if (!state.mounted || !sameTopicChannel(m)) return;
          var wasBottom = isAtBottom();
          var msg = msgFromWk(m);
          addMessages([msg], { scroll: wasBottom ? "bottom" : "keep" });
          var storedMsg = state.msgMap[msg.id] || msg;
          maybeAutoTranslateLatest(storedMsg);
          if (!storedMsg.mine && getMentionNoticeType(storedMsg)) pushMentionNotice(storedMsg);
          if (!wasBottom && !msg.mine) {
            state.unread++;
            updateFab();
          }
        } catch (e) { warn("message-listener", e); }
      });
      shared.__cpTopicV22Listener = true;
    }

    if (shared.connectManager && !shared.connectManager.__cpTopicV22StatusListener) {
      shared.connectManager.addConnectStatusListener(function (status) {
        var ok = status === 1 || status === "connected" || status === "connect";
        state.connected = !!ok;
        setStatus(ok ? "已连接" : "连接中");
        if (ok && state.newestSeq) fetchOffline();
      });
      shared.connectManager.__cpTopicV22StatusListener = true;
    }

    shared.connectManager.connect();
    state.wkReady = true;
    setStatus("连接中");
  }

  function normalizeHistory(json) {
    if (Array.isArray(json)) return json;
    if (json && Array.isArray(json.data)) return json.data;
    if (json && json.data && Array.isArray(json.data.messages)) return json.data.messages;
    if (json && Array.isArray(json.messages)) return json.messages;
    return [];
  }

  async function fetchJson(url) {
    var res = await fetch(url, { credentials: "include" });
    if (!res.ok) throw new Error("http " + res.status);
    return res.json();
  }

  async function fetchHistory(loadMore) {
    if (state.loadingHistory || state.hasNoMore && loadMore) return;
    state.loadingHistory = true;
    var btn = byId("cp-topic-load-more");
    if (btn) btn.innerHTML = "加载中...";
    var startSeq = loadMore && state.oldestSeq ? Math.max(0, state.oldestSeq - 1) : 0;
    var query = "?channel_id=" + encodeURIComponent(state.channelId) +
      "&channel_type=" + encodeURIComponent(CONFIG.channelType) +
      "&tid=" + encodeURIComponent(state.topic.tid) +
      "&limit=" + encodeURIComponent(CONFIG.historyLimit) +
      "&pull_mode=" + (loadMore ? "0" : "1") +
      "&load_more=" + (loadMore ? "1" : "0");
    if (startSeq) query += "&start_message_seq=" + encodeURIComponent(startSeq);

    try {
      var json;
      try { json = await fetchJson(CONFIG.historyUrl + query); }
      catch (e1) { json = await fetchJson(CONFIG.legacyHistoryUrl + query); }
      var raw = normalizeHistory(json);
      if (!raw.length || raw.length < CONFIG.historyLimit) state.hasNoMore = true;
      var msgs = raw.map(function (m) { return msgFromWk(m); });
      addMessages(msgs, { scroll: loadMore ? "prepend" : (state.stickToBottom ? "bottom" : "keep"), notify: false });
      state.lastHistoryAt = Date.now();
    } catch (e) {
      warn("history", e);
      if (!state.messages.length) setStatus("已连接", "历史消息接口暂时没返回，只显示实时新消息。");
    } finally {
      state.loadingHistory = false;
      if (btn) btn.innerHTML = state.hasNoMore ? "没有更早消息了" : '<button type="button">加载更早消息</button>';
    }
  }

  async function fetchOffline() {
    if (!state.newestSeq || Date.now() - state.lastHistoryAt < 1500) return;
    var query = "?channel_id=" + encodeURIComponent(state.channelId) +
      "&channel_type=" + encodeURIComponent(CONFIG.channelType) +
      "&tid=" + encodeURIComponent(state.topic.tid) +
      "&limit=50&start_message_seq=" + encodeURIComponent(state.newestSeq + 1);
    try {
      var json = await fetchJson(CONFIG.historyUrl + query);
      var msgs = normalizeHistory(json).map(function (m) { return msgFromWk(m); });
      if (msgs.length) addMessages(msgs, { scroll: isAtBottom() ? "bottom" : "keep" });
    } catch (_) {}
  }

  function rememberPending(localMsg, clientNo) {
    var key = normalizeText(localMsg.text);
    if (!key) return;
    state.pendingMine[key] = { id: localMsg.id, clientNo: clientNo || "", ts: Date.now() };
    setTimeout(function () {
      if (state.pendingMine[key] && Date.now() - state.pendingMine[key].ts > PENDING_TTL) delete state.pendingMine[key];
    }, PENDING_TTL + 1000);
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
    canvas.width = 1;
    canvas.height = 1;
    if (!canvas.toBlob) { state.encodeSupport[type] = false; return false; }
    var ok = await new Promise(function (resolve) {
      canvas.toBlob(function (blob) { resolve(!!blob && blob.type === type); }, type, 0.8);
    });
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
    canvas.width = w;
    canvas.height = h;
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
        if (blob && blob.size > 0 && blob.size < file.size * 0.95) {
          return new File([blob], baseName + extForMime(targetType), { type: targetType, lastModified: Date.now() });
        }
      }
    } catch (err) { warn("lib-image-compress", err); }

    try {
      var blob2 = await compressWithCanvas(file, targetType);
      if (!blob2 || blob2.size >= file.size * 0.95) return file;
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
      video.src = inputUrl;
      video.muted = true;
      video.playsInline = true;
      await new Promise(function (resolve, reject) { video.onloadedmetadata = resolve; video.onerror = reject; });
      if (video.duration > maxDuration) { var tooLong = new Error("视频过长，最多 " + maxDuration + " 秒"); tooLong.code = "VIDEO_TOO_LONG"; throw tooLong; }
      if (file.size <= maxSizeThreshold) return file;
      if (video.videoWidth === 0 || video.videoHeight === 0) throw new Error("视频无效");
      var scale = Math.min(1, VIDEO_CONFIG.maxWidth / Math.max(1, video.videoWidth));
      var width = Math.max(2, Math.round(video.videoWidth * scale));
      var height = Math.max(2, Math.round(video.videoHeight * scale));
      var canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
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
    canvas.width = w;
    canvas.height = h;
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
    var bg = byId("cp-topic-bg");
    var root = byId(ROOT_ID);
    if (!state.bg) state.bg = cloneJSON(DEFAULT_BG);
    if (state.bg.opacity != null && Number(state.bg.opacity) > 0.45) state.bg.opacity = DEFAULT_BG.opacity;
    if (state.bg.blur == null) state.bg.blur = DEFAULT_BG.blur;
    if (bg) bg.style.backgroundImage = state.bg.dataUrl ? "url(" + state.bg.dataUrl + ")" : "";
    if (root) {
      root.style.setProperty("--cp-bg-dim", String(state.bg.opacity == null ? DEFAULT_BG.opacity : state.bg.opacity));
      root.style.setProperty("--cp-bg-blur", String(state.bg.blur == null ? DEFAULT_BG.blur : state.bg.blur) + "px");
    }
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

  function normalizeUploadUrl(url) {
    url = String(url || "").trim();
    if (!url) return "";
    // 上传后的聊天媒体必须是可访问 URL。data: 只适合本地背景/临时预览，不适合作为 IM 消息保存。
    if (/^data:/i.test(url)) return "";
    if (/^\/\//.test(url)) url = location.protocol + url;
    if (!/^https?:\/\//i.test(url) && url.charAt(0) !== "/") url = "/" + url;
    return url;
  }

  function parseUploadUrl(rawText) {
    state.lastUploadRaw = rawText;
    var raw = typeof rawText === "string" ? rawText : JSON.stringify(rawText || "");
    var json = null;
    try { json = typeof rawText === "string" ? JSON.parse(rawText) : rawText; } catch (_) { json = null; }

    var candidates = [];
    function looksLikeUploadUrl(v) {
      v = String(v || "").trim();
      if (!v || /^data:/i.test(v)) return false;
      if (/^(?:https?:)?\/\//i.test(v)) return true;
      if (/^\/(?:assets\/uploads|uploads)\//i.test(v)) return true;
      if (/^(?:assets\/uploads|uploads)\//i.test(v)) return true;
      return false;
    }
    function add(v) {
      if (typeof v !== "string") return;
      v = v.trim();
      if (!looksLikeUploadUrl(v)) return;
      candidates.push(v);
    }
    function scan(obj) {
      if (!obj) return;
      if (typeof obj === "string") { add(obj); return; }
      if (Array.isArray(obj)) { obj.forEach(scan); return; }
      if (typeof obj === "object") {
        add(obj.url); add(obj.path); add(obj.src); add(obj.href); add(obj.thumbnail); add(obj.location);
        add(obj.file); add(obj.filename); add(obj.image); add(obj.video); add(obj.voice);
        Object.keys(obj).forEach(function (k) { if (k !== "raw" && k !== "base64") scan(obj[k]); });
      }
    }
    scan(json);

    // 兼容 NodeBB/插件直接返回 Markdown 或纯 URL 的情况。
    var m;
    if ((m = raw.match(/!\[[^\]]*\]\(([^)]+)\)/))) add(m[1]);
    if ((m = raw.match(/\[(?:图片|视频|语音消息|语音)\]\(([^)]+)\)/))) add(m[1]);
    var urlMatches = raw.match(/(?:https?:)?\/\/[^\s"'<>]+|\/assets\/uploads\/[^\s"'<>]+|\/uploads\/[^\s"'<>]+/g);
    if (urlMatches) urlMatches.forEach(add);

    for (var i = 0; i < candidates.length; i++) {
      var u = normalizeUploadUrl(candidates[i]);
      if (u && !/\/api\/post\/upload(?:\?|$)/.test(u)) return u;
    }
    return "";
  }

  function xhrUpload(url, file, onProgress) {
    return new Promise(function (resolve, reject) {
      var fd = new FormData();
      fd.append("files[]", file, file.name || "cp_" + Date.now());
      var xhr = new XMLHttpRequest();
      xhr.open("POST", url);
      xhr.withCredentials = true;
      if (window.config) xhr.setRequestHeader("x-csrf-token", config.csrf_token || config.csrfToken || "");
      xhr.upload.onprogress = function (e) { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
      xhr.onload = function () {
        if (xhr.status >= 200 && xhr.status < 300) {
          var parsed = parseUploadUrl(xhr.responseText);
          if (!parsed) return reject(new Error("upload url empty: " + String(xhr.responseText || "").slice(0, 160)));
          resolve(parsed);
        } else reject(new Error("upload failed " + xhr.status + ": " + String(xhr.responseText || "").slice(0, 120)));
      };
      xhr.onerror = function () { reject(new Error("network error")); };
      xhr.send(fd);
    });
  }

  async function uploadToNodeBB(file, onProgress) {
    var direct = (window.config && config.relative_path ? config.relative_path : "") + "/api/post/upload";
    var bridge = CONFIG.uploadUrl || "/bridge/upload";
    var first = CONFIG.uploadDirectFirst ? direct : bridge;
    var second = CONFIG.uploadDirectFirst ? bridge : direct;
    try {
      return await xhrUpload(first, file, onProgress);
    } catch (e) {
      warn(CONFIG.uploadDirectFirst ? "direct-upload" : "bridge-upload", e);
      return await xhrUpload(second, file, onProgress);
    }
  }


  function confirmMediaFiles(files) {
    files = Array.prototype.slice.call(files || []);
    if (!files.length) return Promise.resolve(false);
    var mask = byId("cp-topic-media-confirm");
    var list = byId("cp-topic-media-confirm-list");
    var btnSend = byId("cp-topic-media-confirm-send");
    var btnCancel = byId("cp-topic-media-confirm-cancel");
    if (!mask || !list || !btnSend || !btnCancel) return Promise.resolve(true);
    var urls = [];
    list.innerHTML = files.map(function (f) {
      var u = URL.createObjectURL(f); urls.push(u);
      if (/^image\//i.test(f.type || "")) return '<div class="cp-media-confirm-item"><img src="' + escAttr(u) + '"><span>' + esc(f.name || "图片") + '</span></div>';
      if (/^video\//i.test(f.type || "")) return '<div class="cp-media-confirm-item"><video src="' + escAttr(u) + '" muted playsinline></video><span>' + esc(f.name || "视频") + '</span></div>';
      return '<div class="cp-media-confirm-item"><i class="fa fa-file"></i><span>' + esc(f.name || "文件") + '</span></div>';
    }).join("");
    mask.hidden = false;
    return new Promise(function (resolve) {
      function done(ok) {
        mask.hidden = true;
        btnSend.onclick = btnCancel.onclick = null;
        urls.forEach(function (u) { try { URL.revokeObjectURL(u); } catch (_) {} });
        resolve(!!ok);
      }
      btnSend.onclick = function () { done(true); };
      btnCancel.onclick = function () { done(false); };
      mask.onclick = function (e) { if (e.target === mask) done(false); };
    });
  }

  async function onPickMedia(e) {
    var files = Array.prototype.slice.call(e.target.files || []);
    if (!files.length) return;
    var images = files.filter(function (f) { return /^image\//i.test(f.type || ""); });
    var videos = files.filter(function (f) { return /^video\//i.test(f.type || ""); });
    if (images.length > 4) { toast("一次最多发送 4 张图片"); files = images.slice(0, 4); }
    if (videos.length > 1) { toast("一次最多发送 1 个视频"); e.target.value = ""; return; }
    if (videos.length && images.length) { toast("图片和视频请分开发送"); e.target.value = ""; return; }
    if (videos.length && videos[0].size > 30 * 1024 * 1024) { toast("视频不能超过 30MB"); e.target.value = ""; return; }
    if (!(await confirmMediaFiles(files))) { e.target.value = ""; return; }
    var pWrap = byId("cp-topic-upload-progress-wrap");
    var pBar = byId("cp-topic-upload-progress-bar");
    try {
      for (var i = 0; i < files.length; i++) {
        if (pWrap) pWrap.hidden = false;
        if (pBar) pBar.style.width = "0%";
        var rawFile = files[i];
        var uploadFile = rawFile;
        try {
          if ((rawFile.type || "").indexOf("image/") === 0) { toast("正在压缩图片..."); uploadFile = await compressImage(rawFile); }
          else if ((rawFile.type || "").indexOf("video/") === 0) { toast("正在检查视频..."); uploadFile = await compressVideo(rawFile); }
        } catch (mediaErr) { warn("media-prepare", mediaErr); toast(mediaErr && mediaErr.message ? mediaErr.message : "文件不可用"); continue; }
        var url = await uploadToNodeBB(uploadFile, function (pct) { if (pBar) pBar.style.width = pct * 100 + "%"; });
        if (!url) continue;
        if ((uploadFile.type || rawFile.type || "").indexOf("image/") === 0) await sendTopicText("![](" + url + ")", { allowTranslate: false });
        else if ((uploadFile.type || rawFile.type || "").indexOf("video/") === 0) await sendTopicText("[视频](" + url + ")", { allowTranslate: false });
        else await sendTopicText("[文件](" + url + ")", { allowTranslate: false });
      }
    } catch (err) { warn("pick-media", err); toast("上传失败：" + String(err.message || err).slice(0, 60)); }
    finally { if (pWrap) pWrap.hidden = true; if (pBar) pBar.style.width = "0%"; e.target.value = ""; }
  }

  function toggleUIForRecording(isRec) {
    var inputs = byId("cp-topic-toolbar-inputs");
    var rec = byId("cp-topic-rec-inline");
    if (inputs) inputs.hidden = isRec;
    if (rec) rec.hidden = !isRec;
    updateFooterHeight();
  }

  function getSupportedMimeType() {
    if (!window.MediaRecorder || typeof MediaRecorder.isTypeSupported !== "function") return "";
    for (var i = 0; i < VOICE_CONFIG.fallbackMimeTypes.length; i++) if (MediaRecorder.isTypeSupported(VOICE_CONFIG.fallbackMimeTypes[i])) return VOICE_CONFIG.fallbackMimeTypes[i];
    return "";
  }

  function createAudioRecorder(stream) {
    var mimeType = getSupportedMimeType();
    var options = { audioBitsPerSecond: VOICE_CONFIG.audioBitsPerSecond };
    if (mimeType) options.mimeType = mimeType;
    try { return new MediaRecorder(stream, options); }
    catch (err) { warn("audio-recorder-bitrate", err); return mimeType ? new MediaRecorder(stream, { mimeType: mimeType }) : new MediaRecorder(stream); }
  }

  function renderRecBars() {
    var el = byId("cp-topic-rec-bars");
    if (!el) return;
    var hs = [5, 8, 12, 16, 10, 7, 14, 9];
    el.innerHTML = hs.map(function (h, i) { return '<i style="height:' + h + 'px;animation-delay:' + (i * 0.04) + 's"></i>'; }).join("");
  }

  async function startRecording() {
    if (!navigator.mediaDevices || !window.MediaRecorder) { toast("当前浏览器不支持录音"); return; }
    try {
      var stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      state.rec.stream = stream;
      state.rec.chunks = [];
      state.rec.sec = 0;
      state.rec.paused = false;
      state.rec.shouldSend = false;
      state.rec.mimeType = getSupportedMimeType();
      state.rec.mediaRecorder = createAudioRecorder(stream);
      state.rec.mimeType = state.rec.mediaRecorder.mimeType || state.rec.mimeType || "audio/webm";
      var timeEl = byId("cp-topic-rec-time");
      if (timeEl) timeEl.textContent = "0:00";
      state.rec.mediaRecorder.ondataavailable = function (ev) { if (ev.data && ev.data.size > 0) state.rec.chunks.push(ev.data); };
      state.rec.mediaRecorder.onstop = async function () {
        try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (_) {}
        clearInterval(state.rec.timer);
        state.rec.timer = null;
        toggleUIForRecording(false);
        updateSendButton();
        if (state.rec.shouldSend && state.rec.chunks.length) {
          var pWrap = byId("cp-topic-upload-progress-wrap");
          var pBar = byId("cp-topic-upload-progress-bar");
          try {
            var actualMime = state.rec.mediaRecorder.mimeType || state.rec.mimeType || "audio/webm";
            var ext = actualMime.indexOf("ogg") > -1 ? "ogg" : actualMime.indexOf("mp4") > -1 ? "m4a" : "webm";
            var blob = new Blob(state.rec.chunks, { type: actualMime });
            var file = new File([blob], "voice_" + Date.now() + "." + ext, { type: actualMime });
            if (pWrap) pWrap.hidden = false;
            if (pBar) pBar.style.width = "0%";
            var url = await uploadToNodeBB(file, function (pct) { if (pBar) pBar.style.width = pct * 100 + "%"; });
            await sendTopicText("[语音消息](" + url + ")", { allowTranslate: false, duration: state.rec.sec });
          } catch (e) { warn("record-upload", e); toast("语音发送失败：" + String(e.message || e).slice(0, 60)); }
          finally { if (pWrap) pWrap.hidden = true; if (pBar) pBar.style.width = "0%"; }
        }
      };
      renderRecBars();
      toggleUIForRecording(true);
      var icon = byId("cp-topic-rec-pause") && byId("cp-topic-rec-pause").querySelector("i");
      if (icon) icon.className = "fa fa-pause-circle";
      state.rec.mediaRecorder.start(250);
      state.rec.timer = setInterval(function () {
        if (state.rec.paused) return;
        state.rec.sec += 1;
        var timeEl2 = byId("cp-topic-rec-time");
        if (timeEl2) timeEl2.textContent = formatDuration(state.rec.sec);
        if (state.rec.sec >= (state.cfg.voiceMaxDuration || 60)) stopRecording(true);
      }, 1000);
    } catch (e) { warn("start-recording", e); toast("录音不可用或被拒绝"); }
  }

  function stopRecording(shouldSend) {
    if (!state.rec.mediaRecorder || state.rec.mediaRecorder.state === "inactive") return;
    state.rec.shouldSend = !!shouldSend;
    state.rec.mediaRecorder.stop();
  }

  function togglePauseRecording() {
    var mr = state.rec.mediaRecorder;
    if (!mr) return;
    if (typeof mr.pause !== "function" || typeof mr.resume !== "function") { toast("当前浏览器不支持暂停录音"); return; }
    var icon = byId("cp-topic-rec-pause") && byId("cp-topic-rec-pause").querySelector("i");
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
    var src = (el && el.getAttribute("data-audio-src")) || (msg && (msg.audioUrl || msg.mediaUrl)) || "";
    src = toPlayableUrl(src);
    if (!src) { toast("语音地址为空"); return; }
    if (state.currentAudioEl && state.currentAudioEl !== el) onAudioEnded();
    if (state.currentAudioEl === el && !state.audio.paused) { state.audio.pause(); onAudioEnded(); return; }
    state.audio.src = src;
    markVoicePlayed(msg);
    if (el) { var dot = el.querySelector(".cp-voice-unread-dot"); if (dot) dot.remove(); }
    state.audio.play().then(function () {
      state.currentAudioEl = el;
      if (el) {
        el.classList.add("playing");
        var icon = el.querySelector(".cp-play-circle");
        if (icon) icon.innerHTML = '<i class="fa fa-pause"></i>';
      }
    }).catch(function (e) {
      warn("play-voice", e);
      var nativeAudio = el && el.parentNode ? el.parentNode.querySelector(".cp-voice-native") : null;
      if (nativeAudio) { nativeAudio.classList.add("show"); try { nativeAudio.play(); return; } catch (_) {} }
      toast("语音播放失败，请点系统播放器重试");
    });
  }

  function getPreviewItems() {
    return state.messages.filter(function (m) { return m && (m.type === "image" || m.type === "video") && (m.mediaUrl || m.audioUrl); });
  }

  function renderPreviewAt(index) {
    var body = byId("cp-topic-preview-body");
    if (!body) return;
    var items = getPreviewItems();
    if (!items.length) return;
    index = Math.max(0, Math.min(index, items.length - 1));
    state.previewIndex = index;
    var m = items[index];
    if (m.type === "image") body.innerHTML = '<img src="' + escAttr(toPlayableUrl(m.mediaUrl)) + '" />';
    else {
      // v25: 不调用浏览器原生 fullscreen，避免退出时触发页面后退/重载。
      // 预览层本身就是全屏，底部热区点击即可退出浏览模式。
      body.innerHTML = '<video src="' + escAttr(toPlayableUrl(m.mediaUrl)) + '" controls autoplay playsinline></video><div class="cp-preview-exit-zone" data-act="close-preview"><span>点击底部退出播放</span></div>';
      setTimeout(function(){
        var v=body.querySelector('video');
        if (!v) return;
        v.addEventListener('click', function(ev){
          var y = ev.clientY || 0;
          if (y > window.innerHeight * 0.66) { ev.preventDefault(); ev.stopPropagation(); closePreview(); }
        }, true);
      },80);
    }
  }

  async function openPreview(msg) {
    var mask = byId("cp-topic-preview-mask");
    if (!mask || !msg) return;
    var items = getPreviewItems();
    var idx = 0;
    for (var i = 0; i < items.length; i++) if (items[i].id === msg.id) { idx = i; break; }
    renderPreviewAt(idx);
    mask.hidden = false;
    state.previewOpen = true;
  }

  function closePreview() {
    try { if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(function(){}); } catch (_) {}
    var body = byId("cp-topic-preview-body");
    var mask = byId("cp-topic-preview-mask");
    if (body) body.innerHTML = "";
    if (mask) mask.hidden = true;
    state.previewOpen = false;
  }

  function extractMentionUids(text) {
    text = String(text || "").replace(/\s+/g, "");
    var out = (state.pendingMentionUids || []).map(function (x) { return String(x); });
    var add = function (uid) { uid = String(uid || "").trim(); if (uid && out.indexOf(uid) < 0) out.push(uid); };
    Object.keys(state.pendingMentionMap || {}).forEach(add);
    Object.keys(state.userCache || {}).forEach(function (uid) {
      var u = state.userCache[uid];
      var names = [];
      if (u && u.username) names.push(String(u.username).replace(/\s+/g, ""));
      if (u && u.displayname) names.push(String(u.displayname).replace(/\s+/g, ""));
      if (u && u.userslug) names.push(String(u.userslug).replace(/\s+/g, ""));
      for (var i = 0; i < names.length; i++) { if (names[i] && text.indexOf("@" + names[i]) >= 0) add(uid); }
    });
    return out.filter(function (v, i, arr) { return v && arr.indexOf(v) === i; });
  }

  function pushRemoteNotice(n) {
    if (!n) return;
    var notice = indexRemoteNotice(n);
    var id = "remote_" + String(notice.id || Math.random());
    if (state.remoteNoticeIds[id]) return;
    state.remoteNoticeIds[id] = true;
    state.mentionNotices = [{
      id: notice.messageId || id,
      message_id: notice.messageId || "",
      remoteId: id,
      type: notice.type || "mention",
      text: notice.text,
      ts: notice.ts || Date.now(),
      fromUid: notice.fromUid || "",
      messageText: notice.messageText || "",
      messageSeq: notice.messageSeq || 0,
      quoteMsgId: notice.quoteMsgId || "",
      quote_msg_id: notice.quoteMsgId || "",
      quoteText: notice.quoteText || "",
      quoteUser: notice.quoteUser || "",
      quoteUid: notice.quoteUid || "",
      quoteType: notice.quoteType || "",
      quoteMediaUrl: notice.quoteMediaUrl || "",
      quoteAudioUrl: notice.quoteAudioUrl || ""
    }].concat(state.mentionNotices || []).slice(0, 30);
    updateMentionBanner();
    toast(notice.text);
    triggerNoticeVibration();
  }

  function markRemoteNoticeDone(remoteId) {
    if (!remoteId || !CONFIG.notifyDoneUrl) return;
    var realId = String(remoteId).replace(/^remote_/, "");
    try {
      fetch(CONFIG.notifyDoneUrl, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [realId] })
      }).catch(function () {});
    } catch (_) {}
  }

  function fetchRemoteNotices() {
    if (!CONFIG.notifyListUrl || !state.topic || !state.uid) return;
    var url = CONFIG.notifyListUrl + "?tid=" + encodeURIComponent(state.topic.tid) + "&after=" + encodeURIComponent(state.notifyVersion || 0) + "&_=" + Date.now();
    fetch(url, { credentials: "include", cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j) return;
        if (j.version != null) state.notifyVersion = Math.max(Number(state.notifyVersion || 0), Number(j.version || 0));
        var list = Array.isArray(j.list) ? j.list : [];
        list.forEach(function (n) { if (n && n.version != null) state.notifyVersion = Math.max(Number(state.notifyVersion || 0), Number(n.version || 0)); pushRemoteNotice(n); });
      }).catch(function (e) { warn("remote-notices", e); });
  }

  function startNotifyPolling() {
    stopNotifyPolling();
    fetchRemoteNotices();
    state.notifyPollTimer = setInterval(fetchRemoteNotices, 8000);
  }

  function stopNotifyPolling() {
    if (state.notifyPollTimer) clearInterval(state.notifyPollTimer);
    state.notifyPollTimer = null;
  }

  function savePendingNoticeForTopic(n) {
    try { sessionStorage.setItem(KEY_PENDING_NOTICE, JSON.stringify(n || {})); } catch (_) {}
  }

  function consumePendingNoticeForCurrentTopic() {
    try {
      var raw = sessionStorage.getItem(KEY_PENDING_NOTICE);
      if (!raw || !state.topic) return;
      var n = JSON.parse(raw);
      if (!n || String(n.tid || "") !== String(state.topic.tid || "")) return;
      sessionStorage.removeItem(KEY_PENDING_NOTICE);
      // 进入话题页后先放入提醒队列，再等历史消息加载完成后定位。
      pushRemoteNotice(n);
      setTimeout(function () {
        var notice = (state.mentionNotices || [])[0];
        if (notice) scrollToNotice(notice);
      }, 900);
    } catch (e) { warn("consume-pending-notice", e); }
  }

  function showGlobalNotice(n) {
    if (!n || isTargetTopic()) return;
    var old = byId("cp-topic-global-notify");
    if (old) old.remove();
    var text = n.text || ((n.from_name || "有人") + (n.type === "reply" ? " 回复了你" : " @了你"));
    var tid = String(n.tid || "");
    var el = document.createElement("div");
    el.id = "cp-topic-global-notify";
    el.className = "cp-global-notify";
    el.style.cssText = "position:fixed;left:12px;right:12px;top:calc(12px + env(safe-area-inset-top));z-index:2147483300;display:flex;align-items:center;justify-content:space-between;gap:10px;min-height:42px;padding:10px 12px;border:1px solid rgba(255,255,255,.55);border-radius:18px;background:rgba(255,255,255,.88);backdrop-filter:blur(18px);box-shadow:0 12px 30px rgba(15,23,42,.18);color:#111827;font-size:14px;font-weight:800;";
    el.innerHTML = '<span style="min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(text) + '</span><button style="border:0;background:transparent;color:#94a3b8;font-size:18px;padding:2px 4px;" type="button">×</button>';
    el.addEventListener("click", function (e) {
      if (e.target && e.target.tagName === "BUTTON") { el.remove(); return; }
      if (tid) { savePendingNoticeForTopic(n); location.href = "/topic/" + encodeURIComponent(tid); }
    });
    document.body.appendChild(el);
    setTimeout(function(){ try { el.remove(); } catch(_){} }, 10000);
  }

  async function globalNotifyPollOnce() {
    if (!CONFIG.notifyListUrl || isTargetTopic()) return;
    try {
      var url = CONFIG.notifyListUrl + "?after=" + encodeURIComponent(state.notifyVersion || 0) + "&_=" + Date.now();
      var r = await fetch(url, { credentials:"include", cache:"no-store" });
      if (!r.ok) return;
      var j = await r.json();
      if (j.version != null) state.notifyVersion = Math.max(Number(state.notifyVersion || 0), Number(j.version || 0));
      var list = Array.isArray(j.list) ? j.list : [];
      if (list.length) showGlobalNotice(list[list.length - 1]);
    } catch (e) { warn("global-notify", e); }
  }

  function startGlobalNotifyPolling() {
    if (state.globalNotifyPollTimer) return;
    globalNotifyPollOnce();
    state.globalNotifyPollTimer = setInterval(globalNotifyPollOnce, 12000);
  }

  function pingTopicPresence() {
    if (!CONFIG.presencePingUrl || !state.topic || !state.uid) return;
    try {
      fetch(CONFIG.presencePingUrl, {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tid: state.topic.tid, cid: state.topic.cid, channel_id: state.channelId })
      }).catch(function () {});
    } catch (_) {}
  }

  function fetchTopicPresence() {
    if (!CONFIG.presenceUrl || !state.topic) return;
    fetch(CONFIG.presenceUrl + "?tid=" + encodeURIComponent(state.topic.tid) + "&_=" + Date.now(), { credentials: "include", cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j) return;
        state.onlineCount = Number(j.count || 0);
        updateHeader();
      }).catch(function () {});
  }

  function startPresence() {
    stopPresence();
    stopNotifyPolling();
    pingTopicPresence();
    fetchTopicPresence();
    state.presenceTimer = setInterval(pingTopicPresence, 25000);
    state.presencePollTimer = setInterval(fetchTopicPresence, 12000);
  }

  function stopPresence() {
    if (state.presenceTimer) clearInterval(state.presenceTimer);
    if (state.presencePollTimer) clearInterval(state.presencePollTimer);
    state.presenceTimer = null;
    state.presencePollTimer = null;
  }

  function touchTopicActivity(msg) {
    if (!CONFIG.activityTouchUrl || !state.topic) return;
    try {
      fetch(CONFIG.activityTouchUrl, {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tid: state.topic.tid, cid: state.topic.cid, title: state.topic.title, channel_id: state.channelId, text: msg && (msg.serverText || msg.text || "") })
      }).catch(function () {});
    } catch (_) {}
  }

  async function sendTopicText(originalText, opts) {
    opts = opts || {};
    originalText = String(originalText || "").trim();
    if (!originalText) return;
    var fp = normalizeText(originalText) + "|" + Math.floor(Date.now() / 800);
    if (state.lastSendFingerprint === fp) return;
    state.lastSendFingerprint = fp;
    while (state.sendLock) await new Promise(function (r) { setTimeout(r, 70); });
    var parsedLocal = detectMessageKind(originalText, { duration: opts.duration || 0 });
    state.sendLock = true;
    var textToSend = originalText;
    var localMsg = {
      id: "local_" + Date.now() + "_" + Math.floor(Math.random() * 10000),
      seq: 0,
      uid: state.uid || "me",
      username: getMyName(),
      mine: true,
      type: parsedLocal.kind,
      text: parsedLocal.text,
      serverText: originalText,
      mediaUrl: parsedLocal.mediaUrl,
      audioUrl: parsedLocal.audioUrl,
      durationStr: opts.duration ? formatDuration(opts.duration) : "",
      originalText: "",
      translation: "",
      translationOpen: false,
      translationError: false,
      ts: Date.now(),
      sending: true,
      failed: false,
      local: true,
      quote: state.quoteTarget ? getQuotePreviewText(state.quoteTarget) : "",
      quoteUser: state.quoteTarget ? (displayNameForMessage(state.quoteTarget) || state.quoteTarget.username || "") : "",
      quoteUid: state.quoteTarget && state.quoteTarget.uid ? String(state.quoteTarget.uid) : "",
      quoteMsgId: state.quoteTarget && state.quoteTarget.id ? String(state.quoteTarget.id) : "",
      quoteType: state.quoteTarget ? (state.quoteTarget.type || "text") : "",
      quoteMediaUrl: state.quoteTarget ? (state.quoteTarget.mediaUrl || "") : "",
      quoteAudioUrl: state.quoteTarget ? (state.quoteTarget.audioUrl || "") : "",
      mentionUids: (function(){ var a = extractMentionUids(originalText); if (state.quoteTarget && state.quoteTarget.uid && a.indexOf(String(state.quoteTarget.uid)) < 0) a.push(String(state.quoteTarget.uid)); return a; })(),
      countryFlag: ""
    };
    sanitizeQuoteFields(localMsg);
    addMessages([localMsg], { scroll: "bottom" });
    rememberPending(localMsg, "");
    if (state.quoteTarget) hideQuoteBar();
    try {
      if (state.cfg && state.cfg.sendTranslateEnabled && opts.allowTranslate !== false && parsedLocal.kind === "text") {
        // v12 对齐一对一聊天：自己这边保留原文显示，对方和服务端收到译文。
        localMsg.translation = "翻译发送中...";
        localMsg.translationOpen = true;
        queueRender("bottom");
        textToSend = await translateByProvider(originalText, state.cfg.sourceLang, state.cfg.targetLang);
        if (!textToSend) textToSend = originalText;
        localMsg.text = originalText;
        localMsg.type = "text";
        localMsg.mediaUrl = "";
        localMsg.audioUrl = "";
        localMsg.serverText = textToSend;
        localMsg.originalText = originalText;
        localMsg.translation = "";
        localMsg.translationOpen = false;
      }
      if (!state.wkReady || !window.wk || !window.wk.WKSDK) throw new Error("WK not ready");
      var channel = new window.wk.Channel(state.channelId, CONFIG.channelType);
      var sendMentionUids = extractMentionUids(originalText);
      if (localMsg.quoteUid && sendMentionUids.indexOf(String(localMsg.quoteUid)) < 0) sendMentionUids.push(String(localMsg.quoteUid));
      var content = new window.wk.MessageText(textToSend);
      var rawEncode = content.encode && content.encode.bind(content);
      if (rawEncode) {
        content.encode = function () {
          var p = rawEncode();
          try {
            var obj = typeof p === "string" ? JSON.parse(p) : (p || {});
            obj.username = getMyName();
            obj.countryFlag = "";
            if (textToSend !== originalText) obj.originalText = originalText;
            if (parsedLocal.kind && parsedLocal.kind !== "text") obj.cpType = parsedLocal.kind;
            if (parsedLocal.mediaUrl) obj.mediaUrl = parsedLocal.mediaUrl;
            if (parsedLocal.audioUrl) obj.audioUrl = parsedLocal.audioUrl;
            if (opts.duration) obj.duration = opts.duration;
            obj.topic_tid = state.topic && state.topic.tid ? String(state.topic.tid) : "";
            obj.topic_title = state.topic && state.topic.title ? String(state.topic.title) : "";
            obj.from_username = getMyName();
            if (localMsg.quote) {
              obj.quote = localMsg.quote;
              obj.quote_text = localMsg.quote;
              obj.quoteText = localMsg.quote;
              obj.quoteUser = localMsg.quoteUser || "";
              obj.replyUser = localMsg.quoteUser || "";
              obj.quote_uid = localMsg.quoteUid || "";
              obj.quoteUid = localMsg.quoteUid || "";
              obj.reply_to_uid = localMsg.quoteUid || "";
              obj.replyToUid = localMsg.quoteUid || "";
              obj.quote_from_uid = localMsg.quoteUid || "";
              obj.quoteFromUid = localMsg.quoteUid || "";
              obj.quote_msg_id = localMsg.quoteMsgId || "";
              obj.quoteMsgId = localMsg.quoteMsgId || "";
              obj.reply_to_msg_id = localMsg.quoteMsgId || "";
              obj.replyToMsgId = localMsg.quoteMsgId || "";
              obj.quote_type = localMsg.quoteType || "text";
              obj.quoteType = localMsg.quoteType || "text";
              obj.quote_media_url = localMsg.quoteMediaUrl || "";
              obj.quoteMediaUrl = localMsg.quoteMediaUrl || "";
              obj.quote_audio_url = localMsg.quoteAudioUrl || "";
              obj.quoteAudioUrl = localMsg.quoteAudioUrl || "";
            }
            var mentionUids = sendMentionUids.slice();
            if (mentionUids.length) {
              obj.mention_uids = mentionUids;
              obj.mentionUids = mentionUids;
              obj.at_uids = mentionUids;
              obj.atUsers = mentionUids;
              obj.at = mentionUids;
              obj.is_at = 1;
              obj.mention_type = "users";
              obj.mentions = mentionUids.map(function (uid) {
                var u = (state.pendingMentionMap && state.pendingMentionMap[uid]) || state.userCache[uid] || {};
                return { uid: String(uid), username: u.username || u.displayname || ("用户" + uid), displayname: u.displayname || u.username || "" };
              });
            }
            return typeof p === "string" ? JSON.stringify(obj) : obj;
          } catch (_) { return p; }
        };
      }
      var sent = window.wk.WKSDK.shared().chatManager.send(content, channel);
      localMsg.sending = false;
      if (sent) {
        localMsg.wkMsg = sent;
        var clientNo = sent.clientMsgNo || sent.client_msg_no || "";
        if (clientNo) {
          delete state.msgMap[localMsg.id];
          localMsg.id = String(clientNo);
          state.msgMap[localMsg.id] = localMsg;
          rememberPending(localMsg, clientNo);
        }
      }
      try { if (navigator.vibrate) navigator.vibrate(18); } catch (_) {}
      var notifyUidsForBridge = sendMentionUids.slice();
      if (CONFIG.notifyUrl && notifyUidsForBridge.length) {
        try {
          fetch(CONFIG.notifyUrl, {
            method:"POST",
            credentials:"include",
            headers:{"Content-Type":"application/json"},
            body:JSON.stringify({
              tid: state.topic && state.topic.tid,
              cid: state.topic && state.topic.cid,
              channel_id: state.channelId,
              quote_uid: localMsg.quoteUid || "",
              quote_msg_id: localMsg.quoteMsgId || "",
              quote_text: localMsg.quote || "",
              quote_user: localMsg.quoteUser || "",
              quote_type: localMsg.quoteType || "",
              quote_media_url: localMsg.quoteMediaUrl || "",
              quote_audio_url: localMsg.quoteAudioUrl || "",
              message_id: localMsg.id || "",
              client_msg_no: localMsg.id || "",
              message_seq: localMsg.seq || (localMsg.wkMsg && (localMsg.wkMsg.messageSeq || localMsg.wkMsg.message_seq)) || 0,
              message_text: originalText,
              mention_uids: notifyUidsForBridge,
              mentions: notifyUidsForBridge.map(function (uid) { return (state.pendingMentionMap && state.pendingMentionMap[uid]) || state.userCache[uid] || { uid: uid }; }),
              text: originalText
            })
          }).catch(function(){});
        } catch (_) {}
      }
      state.pendingMentionUids = [];
      state.pendingMentionMap = {};
      touchTopicActivity(localMsg);
      queueRender("bottom");
      saveCacheSoon();
    } catch (e) {
      localMsg.sending = false;
      localMsg.failed = true;
      warn("send-topic-text", e);
      toast(String(e.message || e).indexOf("API") > -1 || String(e.message || e).indexOf("翻译") > -1 ? "翻译/发送失败：" + String(e.message || e).slice(0, 80) : "发送失败：悟空还没连接好");
      queueRender("keep");
    } finally { state.sendLock = false; }
  }

  async function sendCurrent() {
    var input = byId("cp-topic-input");
    var originalText = (input.value || "").trim();
    if (!originalText) return;
    input.value = "";
    autoGrow(input);
    updateSendButton();
    updateFooterHeight();
    await sendTopicText(originalText, { allowTranslate: true });
    state.pendingMentionUids = [];
    hideQuoteBar();
  }

  async function mount() {
    if (state.mounted || !isTargetTopic()) return;
    state.topic = getTopicInfo();
    state.channelId = channelIdOf(state.topic);
    state.uid = "";
    state.messages = [];
    state.msgMap = {};
    state.newestSeq = 0;
    state.oldestSeq = 0;
    state.hasNoMore = false;
    state.loadingHistory = false;
    state.unread = 0;
    state.joinOk = false;
    state.connected = false;
    state.wkReady = false;
    state.connectStarted = false;
    state.statusText = "准备中";
    state.cfg = normalizeConfig(loadJSON(KEY_CFG, DEFAULT_CFG));
    state.bg = loadJSON(KEY_BG, DEFAULT_BG);
    state.scrollProgress = loadProgressMap();
    state.onlineCount = 0;
    loadUserCacheLocal();

    injectStyle();
    injectRoot();
    bindUI();
    applyBackground();
    renderRecBars();
    document.body.classList.add(BODY_CLASS);
    state.mounted = true;
    updateViewport();
    updateFooterHeight();
    updateHeader();

    loadCacheLocalSync();
    queueResolveUsersFromMessages(state.messages);
    queueRender("bottom");
    setTimeout(function () { if (!restoreCurrentProgress()) forceBottom(); }, 60);
    loadCacheDbAndMerge();

    try {
      setStatus("连接中");
      var tokenPromise = getToken();
      var ensurePromise = ensureTopicChannel();
      await Promise.all([tokenPromise, ensurePromise]);
      setStatus("连接中");
      connectWk().catch(function (e) { warn("connect", e); setStatus("离线", "悟空 WebSocket 未连接，只能看缓存/历史。检查 /wkws/。"); });
      startPresence();
    startNotifyPolling();
      fetchHistory(false).then(function () { setTimeout(consumePendingNoticeForCurrentTopic, 350); }).catch(function (e) { warn("first-history", e); setTimeout(consumePendingNoticeForCurrentTopic, 900); });
    } catch (e) {
      warn("mount", e);
      setStatus("离线", "后端频道订阅或 token 未成功：" + String(e.message || e).slice(0, 120));
    }
  }

  function unmount() {
    if (!state.mounted) return;
    saveCurrentProgress();
    saveCacheLocalSync();
    saveCacheDb();
    stopPresence();
    stopNotifyPolling();
    clearTimeout(state.userBatchTimer);
    state.userBatchPending = {};
    var root = byId(ROOT_ID);
    if (root) root.remove();
    var st = byId(STYLE_ID);
    if (st) st.remove();
    document.body.classList.remove(BODY_CLASS, "cp-topic-chat-on-v13", "cp-topic-chat-on-v14", "cp-topic-chat-on-v18", "cp-topic-chat-on-v20", "cp-topic-has-bg");
    state.mounted = false;
  }

  function boot() {
    clearTimeout(state.bootTimer);
    state.bootTimer = setTimeout(function () {
      if (isTargetTopic()) mount();
      else { unmount(); startGlobalNotifyPolling(); }
    }, 80);
  }

  if (window.jQuery) {
    $(boot);
    $(window).on("action:ajaxify.end action:topic.loaded", function () {
      setTimeout(boot, 80);
      setTimeout(boot, 300);
      setTimeout(boot, 650);
    });
    window.addEventListener("pageshow", boot);
    window.addEventListener("popstate", function () { setTimeout(boot, 120); });
  } else {
    document.addEventListener("DOMContentLoaded", boot);
    window.addEventListener("load", boot);
  }

  window.cpTopicChatDebug = {
    state: state,
    parseUploadUrl: parseUploadUrl,
    getLastUploadRaw: function () { return state.lastUploadRaw || ""; },
    testUpload: function (file) { return uploadToNodeBB(file, function (p) { console.log("upload", Math.round(p * 100) + "%"); }); },
    version: "v25"
  };

})();

/* ============================================================
 * Embedded category activity sorter.
 * 现在主题聊天室和板块 7 视觉排序合并在同一个前端文件里。
 * 仍然是前端视觉排序；NodeBB 原生回复数/最后回复时间要插件才能改数据库。
 * ============================================================ */
/* CP Category 7 visual sort by WuKong chat activity - v20 (embedded)
 * Front-end visual sort only. True NodeBB latest-reply sort/count needs a NodeBB plugin.
 */
(function () {
  'use strict';
  if (window.__cpCategory7ActivitySortV20) return;
  window.__cpCategory7ActivitySortV20 = true;

  var CID = 7;
  var POLL_MS = 3000;
  var timer = null;
  var lastHash = '';

  function isCat7() {
    return document.body && document.body.classList.contains('page-category') && /\/category\/7(\/|$)/.test(location.pathname);
  }

  function tidFromHref(href) {
    var m = String(href || '').match(/\/topic\/(\d+)/);
    return m ? m[1] : '';
  }

  function getListParent() {
    return document.querySelector('[component="category/topic-list"], [component="category/topics"], ul[component="category"], .category > ul, .topics-list, .topic-list, .category-list') || null;
  }

  function findTopicRows() {
    var parent = getListParent();
    var anchors = Array.prototype.slice.call((parent || document).querySelectorAll('a[href*="/topic/"]'));
    var rows = [];
    var seen = {};
    anchors.forEach(function (a) {
      var tid = tidFromHref(a.getAttribute('href'));
      if (!tid || seen[tid]) return;
      var row = a.closest('[component="category/topic"], [data-tid], li, .card, .topic-row');
      if (!row || !row.parentNode) return;
      // Avoid selecting a huge container that contains other topic rows.
      if (row.querySelectorAll && row.querySelectorAll('a[href*="/topic/"]').length > 3) return;
      seen[tid] = true;
      rows.push({ tid: tid, row: row, parent: row.parentNode });
    });
    return rows;
  }

  function injectStyle() {
    // Category sorter CSS is loaded from scss/topic-chat-ui.scss.
  }

  function hideReplyCount(row) {
    var nodes = Array.prototype.slice.call(row.querySelectorAll('[component="topic/post-count"], [component="topic/reply-count"], .post-count, .replies-count'));
    nodes.forEach(function (n) {
      var box = n.closest('.stats, .badge, .topic-stats') || n;
      if (box) box.classList.add('cp-cat7-hide-replies');
    });
    Array.prototype.slice.call(row.querySelectorAll('.badge, .stats')).forEach(function (n) {
      var txt = (n.textContent || '').trim();
      if (/帖子|回复|reply|post/i.test(txt) && !/浏览|查看|eye|view/i.test(txt)) n.classList.add('cp-cat7-hide-replies');
    });
  }

  async function refresh(force) {
    if (!isCat7()) return;
    injectStyle();
    var rows = findTopicRows();
    if (!rows.length) return;
    var res = await fetch('/bridge/topic-activity?cid=' + CID + '&_=' + Date.now(), { credentials: 'include', cache: 'no-store' }).catch(function () { return null; });
    if (!res || !res.ok) return;
    var json = await res.json().catch(function () { return null; });
    var list = (json && json.list) || [];
    var map = {};
    list.forEach(function (x) { map[String(x.tid)] = x; });
    var hash = rows.map(function (x) { var a = map[x.tid] || {}; return x.tid + ':' + (a.last_chat_at || 0) + ':' + (a.chat_count || 0); }).join('|');

    rows.forEach(function (x) {
      x.row.setAttribute('data-cp-cat7-row', '1');
      hideReplyCount(x.row);
    });

    if (!force && hash === lastHash) return;
    lastHash = hash;
    rows.sort(function (a, b) { return Number((map[b.tid] && map[b.tid].last_chat_at) || 0) - Number((map[a.tid] && map[a.tid].last_chat_at) || 0); });
    rows.forEach(function (x) { if (x.parent && x.row) x.parent.appendChild(x.row); });
  }

  function stop() { if (timer) clearInterval(timer); timer = null; }

  function boot() {
    stop();
    if (!isCat7()) return;
    setTimeout(function(){ refresh(true); }, 250);
    setTimeout(function(){ refresh(true); }, 900);
    timer = setInterval(refresh, POLL_MS);
  }

  if (window.jQuery) {
    $(window).on('action:ajaxify.end action:topics.loaded', function(){ setTimeout(boot, 80); });
  }
  window.addEventListener('pageshow', boot);
  window.addEventListener('popstate', function(){ setTimeout(boot, 120); });
  document.addEventListener('visibilitychange', function(){ if (!document.hidden) refresh(true); });
  document.addEventListener('DOMContentLoaded', boot);
  boot();
})();
