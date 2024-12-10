#!/usr/bin/with-contenv bashio
set +u

export BOT_TOKEN=$(bashio::config 'bot_token')
bashio::log.info "Bot token configured to ${BOT_TOKEN}."

bashio::log.info "Starting ban service."
npm run start