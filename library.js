'use strict';

const plugin = {};

function parseBoolean(value, defaultValue) {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }

  const normalized = String(value).trim().toLowerCase();

  if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) {
    return true;
  }

  if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) {
    return false;
  }

  return defaultValue;
}

function parseInteger(value, defaultValue) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

plugin.init = async function init(params) {
  const router = params.router;
  const middleware = params.middleware;

  router.get('/cp-wukong-topic-chat/health', middleware.applyCSRF, async (req, res) => {
    res.json({
      ok: true,
      plugin: 'nodebb-plugin-cp-wukong-topic-chat',
      enabled: parseBoolean(process.env.CP_WK_TOPIC_CHAT_ENABLED, true),
      prehide: parseBoolean(process.env.CP_WK_PREHIDE, false),
      categoryId: parseInteger(process.env.CP_WK_CATEGORY_ID || process.env.CP_WK_BOARD_ID, 7)
    });
  });
};

plugin.getConfig = async function getConfig(config) {
  config.cpWukongTopicChat = {
    enabled: parseBoolean(process.env.CP_WK_TOPIC_CHAT_ENABLED, true),
    prehide: parseBoolean(process.env.CP_WK_PREHIDE, false),
    categoryId: parseInteger(process.env.CP_WK_CATEGORY_ID || process.env.CP_WK_BOARD_ID, 7),
    localeFallback: process.env.CP_WK_LOCALE_FALLBACK || 'en-GB',
    pluginId: 'nodebb-plugin-cp-wukong-topic-chat'
  };

  return config;
};

module.exports = plugin;
