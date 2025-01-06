#!/usr/bin/with-contenv bashio
set +u

export BOT_TOKEN=$(bashio::config 'bot_token')
export BOT_CHAT_LIST=$(bashio::config 'bot_chat_list')
export BOT_LINKS_BLACKLIST=$(bashio::config 'bot_links_blacklist')
bashio::log.info "BOT_TOKEN configured to ${BOT_TOKEN}"
bashio::log.info "BOT_CHAT_LIST configured to ${BOT_CHAT_LIST}"
bashio::log.info "BOT_LINKS_BLACKLIST configured to ${BOT_LINKS_BLACKLIST}"

bashio::log.info "Starting ban service."
npm run start