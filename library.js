'use strict';

const winston = require.main.require('winston');

const settings = require('./lib/settings');
const prehide = require('./lib/prehide');
const routes = require('./lib/routes');

const plugin = {};

plugin.init = async function init(params) {
  const { router, middleware } = params;

  const getConfig = async () => settings.get();
  const cfg = await getConfig();

  if (!cfg.enabled) {
    winston.info('[cp-wukong-topic-chat] plugin loaded but disabled by CP_WK_ENABLED=0');
    return;
  }

  prehide.install(router, getConfig, winston);
  routes.install(router, middleware, getConfig, winston);

  winston.info(`[cp-wukong-topic-chat] ready: targetCid=${cfg.targetCid}, channelType=${cfg.channelType}, prehide=${cfg.enablePrehide}`);
};

module.exports = plugin;
