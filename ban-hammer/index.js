console.log('Initializing BanHammer');

const crypto = require('crypto');
const CAS_URL = "https://api.cas.chat/check?user_id=";
const TelegramBot = require('node-telegram-bot-api');
const BOT_TOKEN = process.env.BOT_TOKEN;
const BOT_LINKS_BLACKLIST = process.env.BOT_LINKS_BLACKLIST; // some_site.com/fake
const BOT_CHAT_LIST = process.env.BOT_CHAT_LIST;
const BOT_BAN_TIME = 0; //Math.round(Date.now() / 1000) + (60 * 10);
// A message with at least this many different emoji (custom emoji told apart by their id)
// is deleted and its author muted forever; 0 switches the check off.
const BOT_EMOJI_LIMIT = parseEnvInt(process.env.BOT_EMOJI_LIMIT, 15);
// Extra words of advert names (space separated, matched like the built-in ones: see spamNameReason())
const BOT_NAME_BLACKLIST = (process.env.BOT_NAME_BLACKLIST || "").split(/\s+/).filter((w) => w && w !== "null");
const CAPTCHA_TIMEOUT_S = 90;
const CAPTCHA_OPTIONS = 6;
const NOTICE_TTL_MS = 60000;
const CAS_TIMEOUT_MS = 10000;
const bot = new TelegramBot(BOT_TOKEN, {
	// No timeout by default: a getUpdates request on a connection that died while the
	// network came up waits forever and polling never resumes. Long polling holds a
	// request up to params.timeout (10 s), so this must be longer than that.
	request: { timeout: 30000 },
	polling: {
		params: {
			"allowed_updates": JSON.stringify(["message", "edited_message", "callback_query", "chat_member"])
		}
	}
});

let ignoreAtStartup = true;

// Captchas waiting for an answer: token (in the buttons' callback_data) -> entry
const pendingCaptchas = new Map();

if ((BOT_CHAT_LIST === undefined) || BOT_CHAT_LIST === null) {
	console.log("You must set a bot chat list in the addon config!");
	process.exit(22);
}

if ((BOT_TOKEN === undefined) || BOT_TOKEN === null) {
	console.log("You must set a bot token in the addon config!");
	process.exit(22);

} else {
	setTimeout(() => {
		ignoreAtStartup = false;
	}, 5000);

	bot.on('message', async (message) => {
		const chat_username = message.chat.username;

		if (!checkCat(chat_username)) return;
		if (await checkNameSpam(message)) return;
		if (await checkEmojiSpam(message)) return;

		if (BOT_LINKS_BLACKLIST) {
			const msgText = message.text;

			if (msgText) {
				const chat_id = message.chat.id;
				const messageId = message.message_id;
				const username = message.from.username ? message.from.username : message.from.first_name;
				const badLinksArr = BOT_LINKS_BLACKLIST.split(" ");

				for (const link of badLinksArr) {
					if (msgText.indexOf(link) !== -1) {
						console.log(`message from: ${username} contains a blacklisted link: ${link}`);

						setTimeout(() => {
							bot.deleteMessage(chat_id, messageId).then(() => {
								console.log("message deleted!");

							}).catch((e) => console.log(e));

						}, 2000, chat_id, messageId);
						break;
					}
				}
			} else {
				console.log("message: ", message);
			}
		}
	});

	// Spammers post something harmless and edit it into an advert later
	bot.on('edited_message', (message) => {
		if (checkCat(message.chat.username)) checkEmojiSpam(message);
	});

	bot.on('chat_member', async (message) => {
		if (ignoreAtStartup) return;

		const chat_id = message.chat.id;
		const chat_username = message.chat.username;

		if (checkCat(chat_username)) {
			const newUserStatus = message.new_chat_member.status;
			const newMember = message.new_chat_member.user;
			const newMemberId = newMember.id;
			const newMemberIsBot = newMember.is_bot;
			const newMemberUsername = newMember.username ? newMember.username : newMember.first_name;
			const permissions = new BuildPermissions(false);

			if (newUserStatus === "member" && message.old_chat_member && !("can_send_messages" in message.old_chat_member)) {
				console.log(`new member joined: ${newMemberUsername} newMemberIsBot: ${newMemberIsBot}`);

				// An advert in the name: out at once, no captcha that would show the name for 90 s
				const nameReason = spamNameReason(newMember);
				if (nameReason) {
					banSpamName(chat_id, newMember, nameReason);
					return;
				}

				bot.restrictChatMember(chat_id, newMemberId, {
					until_date: BOT_BAN_TIME,
					...permissions

				}).then(() => {
					let isCanBanned = false;

					console.log(`restricted: ${newMemberUsername}`);

					fetch(CAS_URL + newMemberId, { signal: AbortSignal.timeout(CAS_TIMEOUT_MS) })
						.then((resp) => resp.json())
						.then((casJson) => {
							if (casJson.ok && casJson.result) {
								console.log(`User ${newMemberUsername}(${newMemberId}) have CAS BAN!`);
								isCanBanned = true;
							}
						})
						.catch((e) => console.log(`CAS check of ${newMemberUsername} failed:`, e.message))
						.finally(() => {
							if (isCanBanned || isFemaleName(newMemberUsername)) {
								postNotice(chat_id, `${mention(newMemberId, newMemberUsername)} отримав(ла) перманентний мут!\nЯкщо це помилка, напишіть одному з адміністраторів чату.\n<a href="https://cas.chat/query?u=${newMemberId}">Дізнатись причину блокування</a>`);

							} else {
								startCaptcha(chat_id, newMemberId, newMemberUsername).catch((e) => {
									console.log(`captcha for ${newMemberUsername} not sent:`, e.message);
								});
							}
						});
				}).catch((e) => {
					console.log(e);
				});
			} else {
				console.log(`${newMemberUsername} status: ${newUserStatus}`);
			}
		}
	});

	bot.on("callback_query", (query) => {
		const match = /^cap:([0-9a-f]+):(\d+)$/.exec(query.data || "");
		if (!match) return;

		const token = match[1];
		const entry = pendingCaptchas.get(token);
		if (!entry) {
			answerQuery(query, "Ця перевірка вже завершилась.");
			return;
		}
		if (query.from.id !== entry.userId) {
			answerQuery(query, "Це перевірка для іншого учасника.", true);
			return;
		}

		dropCaptcha(token, entry);

		if (Number(match[2]) === entry.correct) {
			answerQuery(query, "Дякуємо! Ласкаво просимо.");
			bot.restrictChatMember(entry.chatId, entry.userId, {
				until_date: BOT_BAN_TIME,
				...new BuildPermissions(true)

			}).then(() => {
				console.log(`captcha passed, unrestricted: ${entry.name}`);
			}).catch((e) => {
				console.log(`unrestrict of ${entry.name} failed:`, e.message);
			});
		} else {
			answerQuery(query, "Неправильна відповідь.");
			kickUser(entry.chatId, entry.userId).then((ok) => {
				if (ok) console.log(`wrong captcha answer, kicked: ${entry.name}`);
			});
		}
	});

	console.log(`BanHammer started!`);
}

function checkCat(name) {
	const chatList = BOT_CHAT_LIST.split(" ");
	for (const chat of chatList) {
		if (chat === name) return true;
	}

	return false;
}

function parseEnvInt(value, fallback) {
	const n = parseInt(value, 10);
	return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function escapeHtml(text) {
	return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function mention(userId, name) {
	return `<a href="tg://user?id=${userId}">${escapeHtml(name)}</a>`;
}

// A message that deletes itself after NOTICE_TTL_MS
function postNotice(chatId, html) {
	bot.sendMessage(chatId, html, { parse_mode: "HTML", disable_notification: true })
		.then((resp) => {
			setTimeout(() => deleteMsg(resp.chat.id, resp.message_id), NOTICE_TTL_MS);
		})
		.catch((e) => console.log(e));
}

function deleteMsg(chatId, messageId) {
	bot.deleteMessage(chatId, messageId).catch((e) => console.log(`delete of message ${messageId} failed:`, e.message));
}

function answerQuery(query, text, alert = false) {
	bot.answerCallbackQuery(query.id, { text, show_alert: alert }).catch((e) => console.log(e.message));
}

// Kick = ban + unban: the user is removed and may join again later
function kickUser(chatId, userId) {
	const until_date = Math.round(Date.now() / 1000) + (60 * 10);

	return bot.banChatMember(chatId, userId, {
		until_date: until_date,
		revoke_messages: false,
	})
		.then(() => bot.unbanChatMember(chatId, userId, { only_if_banned: true }))
		.then(() => true)
		.catch((e) => {
			console.log(`kick of ${userId} failed:`, e.message);
			return false;
		});
}

function BuildPermissions(state) {
	this.can_send_messages = state;
	this.can_send_audios = state;
	this.can_send_documents = state;
	this.can_send_photos = state;
	this.can_send_videos = state;
	this.can_send_video_notes = state;
	this.can_send_voice_notes = state;
	this.can_send_polls = state;
	this.can_send_other_messages = state;
	this.can_add_web_page_previews = state;
	this.can_change_info = state;
	this.can_invite_users = state;
	this.can_pin_messages = state;
	this.can_manage_topics = state;
}

/* ---------- Captcha: inline buttons, one try, only the new member's press counts ---------- */

// Accusative case: "Натисніть на ..."
const CAPTCHA_PICTURES = [
	["🍎", "ЯБЛУКО"], ["🍌", "БАНАН"], ["🍋", "ЛИМОН"], ["🍇", "ВИНОГРАД"], ["🍓", "ПОЛУНИЦЮ"],
	["🍒", "ВИШНЮ"], ["🥕", "МОРКВУ"], ["🐱", "КОТА"], ["🐶", "СОБАКУ"], ["🐟", "РИБУ"],
	["🐸", "ЖАБУ"], ["🐝", "БДЖОЛУ"], ["🚗", "АВТОМОБІЛЬ"], ["🚲", "ВЕЛОСИПЕД"], ["✈️", "ЛІТАК"],
	["🏠", "БУДИНОК"], ["💡", "ЛАМПОЧКУ"], ["🔑", "КЛЮЧ"], ["⚽", "М'ЯЧ"], ["⏰", "БУДИЛЬНИК"],
];

const NUMBER_WORDS = ["НУЛЬ", "ОДИН", "ДВА", "ТРИ", "ЧОТИРИ", "П'ЯТЬ", "ШІСТЬ", "СІМ", "ВІСІМ", "ДЕВ'ЯТЬ",
	"ДЕСЯТЬ", "ОДИНАДЦЯТЬ", "ДВАНАДЦЯТЬ", "ТРИНАДЦЯТЬ", "ЧОТИРНАДЦЯТЬ", "П'ЯТНАДЦЯТЬ", "ШІСТНАДЦЯТЬ",
	"СІМНАДЦЯТЬ", "ВІСІМНАДЦЯТЬ"];

function randInt(n) {
	return crypto.randomInt(n);
}

function shuffle(arr) {
	for (let i = arr.length - 1; i > 0; i--) {
		const j = randInt(i + 1);
		[arr[i], arr[j]] = [arr[j], arr[i]];
	}
	return arr;
}

// { question (HTML), options (button texts), correct (index into options) }
function makeCaptcha() {
	switch (randInt(3)) {
		case 0: { // arithmetic, answer 1..18
			const a = 1 + randInt(9);
			const b = 1 + randInt(9);
			const plus = a === b || randInt(2) === 0;
			const x = plus ? a : Math.max(a, b);
			const y = plus ? b : Math.min(a, b);
			return numberCaptcha(`Скільки буде <b>${x} ${plus ? "+" : "−"} ${y}</b>?`, plus ? x + y : x - y);
		}
		case 1: { // a number written as a word
			const answer = 1 + randInt(NUMBER_WORDS.length - 1);
			return numberCaptcha(`Натисніть на число <b>${NUMBER_WORDS[answer]}</b>`, answer);
		}
		default: { // a picture named in words
			const picks = shuffle(CAPTCHA_PICTURES.slice()).slice(0, CAPTCHA_OPTIONS);
			const correct = randInt(picks.length);
			return { question: `Натисніть на <b>${picks[correct][1]}</b>`, options: picks.map((p) => p[0]), correct };
		}
	}
}

function numberCaptcha(question, answer) {
	const values = new Set([answer]);
	while (values.size < CAPTCHA_OPTIONS) values.add(1 + randInt(NUMBER_WORDS.length - 1));
	const options = shuffle([...values]);
	return { question, options: options.map(String), correct: options.indexOf(answer) };
}

async function startCaptcha(chatId, userId, name) {
	// Joined again while the old captcha still runs: only the new one counts
	for (const [token, entry] of pendingCaptchas) {
		if (entry.chatId === chatId && entry.userId === userId) dropCaptcha(token, entry);
	}

	const captcha = makeCaptcha();
	const token = crypto.randomBytes(6).toString("hex");
	const buttons = captcha.options.map((text, i) => ({ text, callback_data: `cap:${token}:${i}` }));
	const keyboard = [];
	for (let i = 0; i < buttons.length; i += 3) keyboard.push(buttons.slice(i, i + 3));

	const msg = await bot.sendMessage(chatId,
		`${mention(userId, name)}, підтвердіть, що ви не бот.\n${captcha.question}\nУ вас ${CAPTCHA_TIMEOUT_S} секунд і одна спроба.`,
		{ parse_mode: "HTML", disable_notification: true, reply_markup: { inline_keyboard: keyboard } });

	const entry = { chatId, userId, name, correct: captcha.correct, messageId: msg.message_id };
	entry.timer = setTimeout(() => {
		if (pendingCaptchas.get(token) !== entry) return;
		dropCaptcha(token, entry);
		kickUser(chatId, userId).then((ok) => {
			if (ok) console.log(`captcha timeout, kicked: ${name}`);
		});
	}, CAPTCHA_TIMEOUT_S * 1000);
	pendingCaptchas.set(token, entry);
	console.log(`captcha sent to ${name}, answer: ${captcha.options[captcha.correct]}`);
}

function dropCaptcha(token, entry) {
	pendingCaptchas.delete(token);
	clearTimeout(entry.timer);
	deleteMsg(entry.chatId, entry.messageId);
}

/* ---------- Emoji spam: adverts drawn with (custom) emoji letters ---------- */

const PICTOGRAPH_RE = /\p{Extended_Pictographic}/gu;

// Number of different emoji in a text. A custom emoji counts by its id; its text is a
// stand-in emoji, so its range is left out of the plain emoji count.
function countDistinctEmoji(text, entities) {
	if (!text) return 0;

	const seen = new Set();
	let plain = "";
	let pos = 0;
	const custom = (entities || []).filter((e) => e.type === "custom_emoji").sort((a, b) => a.offset - b.offset);
	for (const e of custom) {
		seen.add("custom:" + e.custom_emoji_id);
		if (e.offset > pos) plain += text.slice(pos, e.offset);
		pos = Math.max(pos, e.offset + e.length);
	}
	plain += text.slice(pos);

	for (const ch of plain.match(PICTOGRAPH_RE) || []) seen.add(ch);
	return seen.size;
}

// true when the message was emoji spam (deleted, author muted forever)
async function checkEmojiSpam(message) {
	try {
		if (!BOT_EMOJI_LIMIT || message.is_automatic_forward) return false;

		const count = message.text !== undefined
			? countDistinctEmoji(message.text, message.entities)
			: countDistinctEmoji(message.caption, message.caption_entities);
		if (count < BOT_EMOJI_LIMIT) return false;

		const chatId = message.chat.id;
		const sender = message.sender_chat; // posted as a channel or as the anonymous admin
		if (sender && sender.id === chatId) return false;
		if (!sender) {
			const member = await bot.getChatMember(chatId, message.from.id).catch(() => null);
			if (member && (member.status === "creator" || member.status === "administrator")) return false;
		}

		const name = sender
			? (sender.title || sender.username)
			: (message.from.username ? message.from.username : message.from.first_name);
		console.log(`emoji spam from ${name}: ${count} different emoji, message deleted`);
		deleteMsg(chatId, message.message_id);

		if (sender) {
			// A channel cannot be restricted: banning it stops everyone posting as it here
			await bot.banChatSenderChat(chatId, sender.id);
			postNotice(chatId, `Канал <b>${escapeHtml(name)}</b> заблоковано за спам.`);
		} else {
			await bot.restrictChatMember(chatId, message.from.id, {
				until_date: 0, // forever
				...new BuildPermissions(false)
			});
			postNotice(chatId, `${mention(message.from.id, name)} отримав(ла) перманентний мут за спам.\nЯкщо це помилка, напишіть одному з адміністраторів чату.`);
		}
		console.log(`muted forever: ${name}`);
		return true;

	} catch (e) {
		console.log("emoji spam check failed:", e.message);
		return false;
	}
}

/* ---------- Adverts in the name: "💋💛ДЕ!ЦК.ОЕ ПОР!Н.О В ПР.ОФ!ИЛЕ💋💛" ---------- */

// Matched at the start of a word of the name (a phrase: of its first word) after punctuation inside
// words is dropped ("ПОР!Н.О В ПР.ОФ!ИЛЕ" -> "порно в профиле"), emoji, spaces and "_" separate words;
// also with look-alike Latin and Cyrillic letters swapped either way ("пoрнo" with Latin "o")
const NAME_WORDS = [
	"порн", "porn", "профил", "профіл", "в био", "в біо", "in bio", "секс", "sex", "интим", "інтим",
	"эскорт", "ескорт", "escort", "знакомств", "знайомств", "заработ", "заробіт", "заробит",
	"onlyfans", "nude", "хентай", "шлюх", "казино", "casino", "18+",
	...BOT_NAME_BLACKLIST.map((w) => w.toLowerCase()),
];
const NAME_LINK_RE = /t\.me\/|https?:\/\/|www\.|\.(?:com|net|org|ru|me|io|xyz|top|site|online|link|shop|club)\b/i;
// A letter, punctuation, a letter: "ДЕ!ЦК.ОЕ" (names with initials have two at most: "J.R.R.")
const NAME_SPLIT_WORD_RE = /\p{L}[!.*_|•·,:;]+(?=\p{L})/gu;
const NAME_BOT_RE = /(?:bot|бот)(?:$|[^\p{L}])/iu; // a word ending in "bot": "LoveBot", "LAD 76 BOT"
const LAT_TO_CYR = { a: "а", c: "с", e: "е", h: "н", i: "і", k: "к", m: "м", o: "о", p: "р", t: "т", x: "х", y: "у" };
const CYR_TO_LAT = { а: "a", в: "b", е: "e", і: "i", к: "k", м: "m", н: "h", о: "o", р: "p", с: "c", т: "t", у: "y", х: "x" };

function swapLetters(text, map) {
	return text.replace(/./gu, (ch) => map[ch] || ch);
}

// Why the user's name is an advert, or null when it is not
function spamNameReason(user) {
	const name = [user.first_name, user.last_name].filter(Boolean).join(" ");
	const all = [name, user.username].filter(Boolean).join(" ");
	if (!all) return null;

	if (NAME_LINK_RE.test(all)) return "link in the name";

	const words = " " + all.toLowerCase().replace(/ё/g, "е")
		.replace(/[\s_]+|\p{Extended_Pictographic}|️|‍/gu, " ")
		.replace(/[^\p{L}\p{N}+ ]/gu, "")
		.replace(/ +/g, " ").trim();
	const variants = [words, swapLetters(words, LAT_TO_CYR), swapLetters(words, CYR_TO_LAT)];
	for (const word of NAME_WORDS) {
		if (variants.some((v) => v.includes(" " + word))) return `word "${word}" in the name`;
	}

	const splitWords = (name.match(NAME_SPLIT_WORD_RE) || []).length;
	if (splitWords >= 3) return `${splitWords} words split by punctuation`;

	// Each of these alone is a normal name ("Олена 💙💛", a long double surname)
	const weak = [];
	if ((name.match(PICTOGRAPH_RE) || []).length >= 4) weak.push("many emoji");
	if (name.length >= 40) weak.push("long name");
	if (splitWords > 0) weak.push("split words");
	if (NAME_BOT_RE.test(name)) weak.push("\"bot\" in the name");
	return weak.length >= 2 ? weak.join(", ") : null;
}

function banSpamName(chatId, user, reason) {
	console.log(`advert in the name of ${user.id} (${reason}): banned`);
	bot.banChatMember(chatId, user.id, { until_date: 0, revoke_messages: true })
		.catch((e) => console.log(`ban of ${user.id} failed:`, e.message));
}

// Removes what shows an advert name: the "joined" / "removed" service messages, and a message
// of a member who renamed himself into an advert after joining (banned as well).
// true when the message was dealt with.
async function checkNameSpam(message) {
	try {
		const chatId = message.chat.id;
		const service = (message.new_chat_members || []).concat(message.left_chat_member || []);
		if (service.length) {
			if (!service.some((u) => spamNameReason(u))) return false;
			deleteMsg(chatId, message.message_id);
			return true;
		}

		const user = message.from;
		if (!user || message.sender_chat) return false;
		const reason = spamNameReason(user);
		if (!reason) return false;

		const member = await bot.getChatMember(chatId, user.id).catch(() => null);
		if (member && (member.status === "creator" || member.status === "administrator")) return false;

		deleteMsg(chatId, message.message_id);
		banSpamName(chatId, user, reason);
		return true;

	} catch (e) {
		console.log("name spam check failed:", e.message);
		return false;
	}
}

/**
 * Перевіряє, чи є ім'я (українське або російське) жіночим.
 *
 * Логіка:
 * 1. Ім'я нормалізується (обрізаються пробіли, приводиться до нижнього регістру,
 *    перша літера — до верхнього для порівняння зі списками винятків).
 * 2. Спочатку перевіряється точний збіг зі списками відомих чоловічих
 *    і жіночих імен-винятків (бо є чоловічі імена на "а"/"я": Микита, Ілля,
 *    Микола, Данила, Кузьма тощо; і теоретично жіночі, що на "а"/"я" не закінчуються).
 * 3. Якщо точного збігу нема — застосовується загальне правило:
 *    ім'я вважається жіночим, якщо закінчується на "а" або "я".
 *
 * @param {string} name - ім'я для перевірки
 * @returns {boolean|null} true — жіноче, false — чоловіче, null — не вдалось визначити (порожній рядок)
 */
function isFemaleName(name) {
	if (!name || typeof name !== 'string') return null;

	const trimmed = name.trim();
	if (trimmed.length === 0) return null;

	// Беремо лише перше слово (якщо ввели "Ім'я По батькові" чи "Ім'я Прізвище")
	const firstWord = trimmed.split(/\s+/)[0];

	// Нормалізація для порівняння (нижній регістр, ё -> е для рос. варіанту)
	const normalized = firstWord
		.toLowerCase()
		.replace(/ё/g, 'е');

	// Список чоловічих імен, що закінчуються на "а"/"я" (виняток із загального правила)
	const maleExceptions = new Set([
		// Українські
		'микита', 'ілля', 'кузьма', 'данила', 'сава', 'хома', 'лука',
		'микола', 'йона', 'варфоломія', 'вітя', // зменш. форми теж трапляються
		// Російські
		'никита', 'илья', 'кузьма', 'данила', 'савва', 'фома', 'лука',
		'гаврила', 'богдана' // "Богдана" тут як приклад — за потреби прибрати/додати
	]);

	// Список жіночих імен, що НЕ закінчуються на "а"/"я" (виняток із загального правила)
	const femaleExceptions = new Set([
		'любов', 'нінель', 'рахіль', 'есфір', 'юдіф', 'юдифь',
		'любовь', // рос. варіант
	]);

	if (maleExceptions.has(normalized)) return false;
	if (femaleExceptions.has(normalized)) return true;

	// Загальне правило: закінчення на "а" або "я"
	const lastChar = normalized.charAt(normalized.length - 1);
	return lastChar === 'а' || lastChar === 'я';
}
