console.log('Initializing BanHammer');

const CAS_URL = "https://api.cas.chat/check?user_id=";
const TelegramBot = require('node-telegram-bot-api');
const BOT_TOKEN = "8100710657:AAGyrpzN-2TPWXg5dCp6ezcsMAJsquFQrCw";
const BOT_LINKS_BLACKLIST = process.env.BOT_LINKS_BLACKLIST; // some_site.com/fake
const BOT_CHAT_LIST = "ua_test_bans" // process.env.BOT_CHAT_LIST; // ua_test_bans uasmarthome uasmartmarket
const BOT_BAN_TIME = 0; //Math.round(Date.now() / 1000) + (60 * 10);
const bot = new TelegramBot(BOT_TOKEN, {
	polling: {
		params: {
			"allowed_updates": JSON.stringify(["update_id", "message", "inline_query", "chosen_inline_result", "callback_query", "poll", "poll_answer", "my_chat_member", "chat_member"])
		}
	}
});

let ignoreAtStartup = true;

const pollArray = [];

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

		if (BOT_LINKS_BLACKLIST && checkCat(chat_username)) {
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
					}
				}
			} else {
				console.log("message: ", message);
			}
		}
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

				bot.restrictChatMember(chat_id, newMemberId, {
					until_date: BOT_BAN_TIME,
					...permissions

				}).then(() => {
					let isCanBanned = false;

					console.log(`restricted: ${newMemberUsername}`);

					fetch(CAS_URL + newMemberId)
						.then((resp) => resp.json())
						.then((casJson) => {
							if (casJson.ok && casJson.result) {
								console.log(`User ${newMemberUsername}(${newMemberId}) have CAS BAN!`);
								isCanBanned = true;
							}
						})
						.finally(() => {
							if (isCanBanned || isFemaleName(newMemberUsername)) {
								bot.sendMessage(chat_id, `<a href="tg://user?id=${newMemberId}">@${newMemberUsername}</a> отримав(ла) перманентний мут!\nЯкщо це помилка, напишіть одному з адміністраторів чату.\n<a href="https://cas.chat/query?u=${newMemberId}">Дізнатись причину блокування</a>`, { parse_mode: "HTML", disable_notification: true })
									.then((resp) => {
										setTimeout(() => {
											bot.deleteMessage(resp.chat.id, resp.message_id).catch(e => console.log(e));
										}, 60000, resp);
									})
									.catch((e) => console.log(e));

							} else {
								const answer = getRandCap();
								const pollOptions = {
									is_anonymous: false,
									"type": "quiz",
									allows_multiple_answers: false,
									correct_option_id: answer.num - 1,
									explanation: "Вітаю, ви бот!",
									open_period: 20,
									disable_notification: true,
									question_parse_mode: "HTML",
								}

								bot.sendPoll(chat_id, `<a href="tg://user?id=${newMemberId}">@${newMemberUsername}</a>\nБудь ласка, виберіть число <b>${answer.res}</b> нижче щоб підтвердити, що ви не бот:)`, ["1", "2", "3", "4", "5"], pollOptions).then((resp) => {
									const pollId = resp.poll.id;
									const pollMsgId = resp.message_id;
									const messageId = resp.message_id;

									const poolTmrId = setTimeout(() => {
										const elem = pollArray.find((o) => o.pollId === pollId);
										if (elem) {
											kickUser(elem.chatId, elem.newMemberId).finally(() => {
												console.log(`answer timeout! user: ${elem.newMemberUsername} deleted!`);
												deletePool(elem);
											});
										}

									}, 21 * 1000, chat_id, pollMsgId, pollId);

									pollArray.push(new PollObject(poolTmrId, pollOptions.correct_option_id, pollId, newMemberId, newMemberUsername, messageId, chat_id));

								}).catch((e) => {
									console.log(e);
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

	bot.on("poll_answer", (answer) => {
		const poolId = answer.poll_id;
		const userId = answer.user.id;
		const answerId = answer.option_ids[0];

		const isFromNewMember = pollArray.find((elem) => (elem.newMemberId === userId) && (elem.pollId === poolId));
		if (isFromNewMember) {
			console.log("answer: ", answerId + 1);

			deletePool(isFromNewMember).then(() => {
				clearTimeout(isFromNewMember.timeoutTimer);

				if (answerId === isFromNewMember.correctAnswer) {
					const permissions = new BuildPermissions(true);

					bot.restrictChatMember(isFromNewMember.chatId, isFromNewMember.newMemberId, {
						until_date: BOT_BAN_TIME,
						...permissions

					}).then(() => {
						console.log(`unrestricted: ${isFromNewMember.newMemberUsername}`);
					});
				} else {
					kickUser(isFromNewMember.chatId, isFromNewMember.newMemberId).then(() => {
						console.log(`wrong answer: ${answerId}! user: ${isFromNewMember.newMemberUsername} deleted!`);
					});
				}

			}).catch((e) => {
				console.log(e);
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

async function kickUser(chatId, userId) {
	const until_date = Math.round(Date.now() / 1000) + (60 * 10);

	bot.banChatMember(chatId, userId, {
		until_date: until_date,
		revoke_messages: false,
	}).then(() => {
		bot.unbanChatMember(chatId, userId).then(() => { return true; }).catch((e) => {
			console.log(e);
			return false;
		});
	}).catch((e) => {
		console.log(e);
		return false;
	});
}

function deletePool(pool) {
	const index = pollArray.indexOf(pool);
	if (index > -1) {
		pollArray.splice(index, 1);
	}

	return bot.deleteMessage(pool.chatId, pool.messageId);
}

function PollObject(timeoutTimer, correctAnswer, pollId, newMemberId, newMemberUsername, messageId, chatId) {
	this.timeoutTimer = timeoutTimer;
	this.correctAnswer = correctAnswer;
	this.newMemberId = newMemberId;
	this.newMemberUsername = newMemberUsername;
	this.pollId = pollId;
	this.messageId = messageId;
	this.chatId = chatId;
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

function getRandCap() {
	let result;
	const randNumber = Math.floor(Math.random() * 5) + 1;
	const randMethod = Math.floor(Math.random() * 3) + 1;

	console.log(`randNumber: ${randNumber} randMethod: ${randMethod}`);

	switch (randMethod) {
		case 1:
			result = NumberEncoderNumber(randNumber);
			break;

		case 2:
			result = NumberEncoderString(randNumber);
			break;

		case 3:
			result = NumberEncoderEmoji(randNumber);
			break;

		default:
			result = NumberEncoderString(randNumber);
			break;
	}

	return { num: randNumber, res: result };
}

function NumberEncoderNumber(number) {
	return `${number}`;
}

function NumberEncoderString(number) {
	let result = "";

	switch (number) {
		case 1:
			result = "ОДИН"
			break;

		case 2:
			result = "ДВА"
			break;

		case 3:
			result = "ТРИ"
			break;

		case 4:
			result = "ЧОТИРИ"
			break;

		case 5:
			result = "П'ЯТЬ"
			break;

		default:
			result = "ОДИН"
			break;
	}

	return result;
}

function NumberEncoderEmoji(number) {
	let result = "";

	switch (number) {
		case 1:
			result = "1️⃣"
			break;

		case 2:
			result = "2️⃣"
			break;

		case 3:
			result = "3️⃣"
			break;

		case 4:
			result = "4️⃣"
			break;

		case 5:
			result = "5️⃣"
			break;

		default:
			result = "1️⃣"
			break;
	}

	return result;
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