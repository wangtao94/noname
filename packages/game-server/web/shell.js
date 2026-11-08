// Lobby shell: owns the control connection, renders home/room, and hosts the game iframe.
const $ = id => document.getElementById(id);
const TOKEN_KEY = "noname-sa-token";
const NICK_KEY = "noname-sa-nickname";

function storage(fn, fallback) {
	try {
		return fn(localStorage);
	} catch {
		return fallback;
	}
}

function newToken() {
	const bytes = new Uint8Array(24);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

let token = storage(s => s.getItem(TOKEN_KEY), null);
if (!token) {
	token = newToken();
	storage(s => s.setItem(TOKEN_KEY, token));
}

const state = {
	ws: null,
	connected: false,
	me: null,
	modes: [],
	packs: { characterPacks: [], cardPacks: [] },
	rooms: [],
	watching: null,
	candidates: {},
	extensions: [],
	room: null,
	retry: 0,
	/** gameId -> iframe */
	frames: new Map(),
	/** next game page, booted and waiting for a game id */
	preload: null,
	/** game frame whose connection was closed for good (shown with a take-over prompt) */
	elsewhere: null,
	showingMenu: false,
};

function toast(text, ms = 3000) {
	const el = $("toast");
	el.textContent = text;
	el.hidden = false;
	clearTimeout(toast.t);
	toast.t = setTimeout(() => (el.hidden = true), ms);
}

function send(msg) {
	if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(msg));
	else toast("正在连接服务器…");
}

function connect() {
	const proto = location.protocol === "https:" ? "wss" : "ws";
	const ws = new WebSocket(`${proto}://${location.host}/ws`);
	state.ws = ws;
	ws.onopen = () => {
		state.connected = true;
		state.retry = 0;
		ws.send(JSON.stringify({ t: "hello", token, nickname: storage(s => s.getItem(NICK_KEY), "") || undefined }));
		render();
	};
	ws.onmessage = e => {
		let msg;
		try {
			msg = JSON.parse(e.data);
		} catch {
			return;
		}
		onMessage(msg);
	};
	ws.onclose = () => {
		state.connected = false;
		state.ws = null;
		render();
		const delay = Math.min(10000, 500 * 2 ** state.retry++);
		setTimeout(connect, delay);
	};
}

function onMessage(msg) {
	switch (msg.t) {
		case "welcome":
			state.me = { uid: msg.uid, nickname: msg.nickname, avatar: msg.avatar };
			state.modes = msg.modes ?? [];
			state.extensions = msg.extensions ?? [];
			state.packs = msg.packs ?? state.packs;
			state.watching = null;
			$("nickname").value = msg.nickname;
			fillModeSelect($("createMode"), "identity");
			// deep link /room/<code>
			{
				const m = /^\/room\/(\d{6})$/.exec(location.pathname);
				if (m && !state.room) send({ t: "room.join", code: m[1] });
			}
			break;
		case "rooms":
			state.rooms = msg.rooms;
			break;
		case "room":
			state.room = msg.room;
			syncUrl();
			syncFrames();
			break;
		case "error":
			toast(msg.message);
			if (msg.code === "no_room" && /^\/room\//.test(location.pathname)) history.replaceState(null, "", "/");
			break;
	}
	render();
}

function syncUrl() {
	const want = state.room ? `/room/${state.room.code}` : "/";
	if (location.pathname !== want) history.replaceState(null, "", want);
}

function modeName(id) {
	return state.modes.find(m => m.id === id)?.name ?? id;
}

function fillModeSelect(sel, value) {
	const html = state.modes.map(m => `<option value="${m.id}">${escapeHtml(m.name)}</option>`).join("");
	if (sel.dataset.html !== html) {
		sel.innerHTML = html;
		sel.dataset.html = html;
	}
	if (value) sel.value = value;
}

function escapeHtml(s) {
	return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// ---------- game frames ----------
// One iframe per game. While a game's result screen is shown, the next game page is preloaded
// (booted, waiting for a game id), so "play again" swaps instantly without any page refresh.

function gameUrl(gameId, defer = false) {
	const p = new URLSearchParams({ "sa-room": state.room.code, "sa-uid": state.me.uid, "sa-token": token });
	p.set("sa-ext", state.extensions.join(","));
	if (gameId) p.set("sa-game", gameId);
	if (defer) p.set("sa-defer", "1");
	return `/index.html?${p}`;
}

function newFrame(src) {
	const frame = document.createElement("iframe");
	frame.className = "pending";
	frame.allow = "autoplay; fullscreen";
	frame.src = src;
	$("frames").appendChild(frame);
	return frame;
}

function frameOf(source) {
	for (const f of $("frames").querySelectorAll("iframe")) if (f.contentWindow === source) return f;
	return null;
}

function reveal(gameId) {
	const frame = state.frames.get(gameId);
	if (!frame || !frame.classList.contains("pending")) return;
	frame.classList.remove("pending");
	clearTimeout(frame._revealTimer);
	// drop older games once the new one is visible
	setTimeout(() => {
		for (const [id, f] of state.frames) {
			if (id !== gameId) {
				f.remove();
				state.frames.delete(id);
			}
		}
	}, 400);
}

function dropPreload() {
	state.preload?.remove();
	state.preload = null;
}

function syncFrames() {
	const room = state.room;
	const seated = room && room.members.some(m => m.uid === state.me?.uid);
	const gameId = seated && room.status !== "lobby" && room.game ? room.game.id : null;
	if (!gameId) {
		for (const f of state.frames.values()) f.remove();
		state.frames.clear();
		dropPreload();
		return;
	}
	if (!state.frames.has(gameId)) {
		let frame;
		if (state.preload) {
			frame = state.preload;
			state.preload = null;
			frame.dataset.game = gameId;
			if (frame._preloaded) frame.contentWindow.postMessage({ type: "noname:attach", game: gameId }, location.origin);
		} else {
			frame = newFrame(gameUrl(gameId));
			frame.dataset.game = gameId;
		}
		state.frames.set(gameId, frame);
		const first = state.frames.size === 1;
		// fallback in case the page never reports back
		frame._revealTimer = setTimeout(() => reveal(gameId), first ? 4000 : 20000);
	}
	// preload the next game page while this one shows its result
	if (room.status === "ended" && !state.preload) {
		state.preload = newFrame(gameUrl(null, true));
	}
}

window.addEventListener("message", e => {
	if (e.origin !== location.origin) return;
	const frame = frameOf(e.source);
	switch (e.data?.type) {
		case "noname:game-preloaded":
			if (!frame) break;
			frame._preloaded = true;
			// already assigned (it may also have reloaded itself): hand it the game id
			if (frame.dataset.game) frame.contentWindow.postMessage({ type: "noname:attach", game: frame.dataset.game }, location.origin);
			break;
		case "noname:game-connected":
			if (frame?.dataset.game) setTimeout(() => reveal(frame.dataset.game), 600);
			break;
		case "noname:game-connect-failed":
			toast("连接对局失败，请稍后重试");
			break;
		case "noname:game-closed":
			onGameClosed(frame, e.data.code);
			break;
		case "noname:game-error":
			toast("游戏出现一个错误（已记录到控制台），可继续游戏", 4000);
			break;
		case "noname:game-reconnecting":
			if (frame && !frame.classList.contains("pending") && e.data.attempt === 1) toast("网络波动，正在重连…", 2000);
			break;
		case "noname:game-reconnected":
			break;
	}
});

/** a game page lost its connection for good; never auto-reload (that can loop between tabs) */
function onGameClosed(frame, code) {
	if (!frame || frame.classList.contains("pending")) return;
	if (code === 4001) {
		// another window of this browser (same identity) took over this game
		state.elsewhere = frame;
		$("elsewhereTitle").textContent = "本局已在另一个窗口打开";
		$("elsewhereText").textContent = "同一浏览器只能在一个窗口中进行对局。";
		$("elsewhere").hidden = false;
		return;
	}
	if (code === 4401) {
		toast("身份校验失败，请刷新页面", 6000);
		return;
	}
	// 4000 kicked / 4002 game closed / 4404 not in room / 4410 game gone: the room state decides what to show
	if (state.frames.get(frame.dataset.game) === frame && state.room?.game?.id === frame.dataset.game && state.room.status === "playing") {
		state.elsewhere = frame;
		$("elsewhereTitle").textContent = "与对局的连接已断开";
		$("elsewhereText").textContent = "可以尝试重新连接这局游戏。";
		$("elsewhere").hidden = false;
	}
}

$("takeOverBtn").onclick = () => {
	const frame = state.elsewhere;
	state.elsewhere = null;
	$("elsewhere").hidden = true;
	if (frame?.isConnected) frame.contentWindow.location.reload();
};
$("elsewhereLobbyBtn").onclick = () => {
	state.elsewhere = null;
	$("elsewhere").hidden = true;
	state.showingMenu = true;
	render();
};

// ---------- rendering ----------

function render() {
	$("conn").classList.toggle("on", state.connected);
	const room = state.room;
	const inGame = !!(room && room.status !== "lobby" && state.frames.size);
	$("stage").hidden = !inGame;
	$("app").classList.toggle("overlay", inGame && state.showingMenu);
	$("app").hidden = inGame && !state.showingMenu;
	$("returnGame").hidden = !inGame;
	$("menuBtn").textContent = inGame && state.showingMenu ? "返回对局" : "房间";
	$("home").hidden = !!room || !state.me;
	$("room").hidden = !room;
	if (state.me && state.connected && state.watching !== !room) {
		state.watching = !room;
		send({ t: "rooms.watch", on: !room });
	}
	if (!room) renderRoomList();
	if (room) renderRoom(room);
	const ended = room?.status === "ended";
	$("endbar").hidden = !(inGame && ended);
	if (ended) {
		const owner = room.ownerId === state.me?.uid;
		$("againBtn").hidden = !owner;
		$("backBtn").hidden = !owner;
		$("endText").textContent = owner ? "本局结束" : "本局结束，等待房主开始下一局";
	}
}

function renderRoom(room) {
	const me = state.me?.uid;
	const isOwner = room.ownerId === me;
	$("roomCode").textContent = room.code;
	const members = room.members
		.map(m => {
			const tags = [m.uid === room.ownerId ? "房主" : "", m.uid === me ? "我" : ""].filter(Boolean).join(" · ");
			const ops = isOwner && m.uid !== me ? `<button data-op="transfer" data-uid="${m.uid}">设为房主</button><button data-op="kick" data-uid="${m.uid}">移出</button>` : "";
			return `<li><span class="dot ${m.online ? "on" : ""}"></span><span class="name">${escapeHtml(m.nickname)}</span><span class="tag">${tags}</span>${ops}</li>`;
		})
		.join("");
	const empty = Math.max(0, room.maxPlayers - room.members.length);
	$("members").innerHTML = members + Array.from({ length: empty }, () => `<li class="empty">空位（开局时由 AI 补位）</li>`).join("");
	const playing = room.status === "playing";
	// "ended" also needs a start button: after a reload the game frame is gone, so the in-game 再来一局 bar is not shown
	$("startBtn").hidden = !isOwner || playing;
	$("startBtn").textContent = room.status === "ended" ? "开始下一局" : "开始游戏";
	$("dissolveBtn").hidden = !isOwner || playing;
	$("roomHint").textContent = playing ? "对局进行中" : isOwner ? `${room.members.length}/${room.maxPlayers} 人，空位由 AI 补上` : "等待房主开始游戏";
	$("serverExtensions").textContent = `服务器扩展：${state.extensions.join("、") || "无"}`;
	$("settingsNote").textContent = playing ? "对局进行中，本局结束后可修改设置" : isOwner ? "" : "（仅房主可修改）";
	fillModeSelect($("roomMode"), room.mode);
	$("roomMode").disabled = !isOwner || playing;
	const beginner = room.config.preset === "beginner";
	$("customMode").hidden = beginner;
	$("serverExtensions").hidden = beginner;
	$("modeExplanation").textContent = modeExplanations[room.mode] || "";
	for (const [id, active] of [
		["beginnerPreset", beginner],
		["customPreset", !beginner],
	]) {
		$(id).classList.toggle("selected", active);
		$(id).setAttribute("aria-pressed", String(active));
		$(id).disabled = !isOwner || playing;
	}
	if (beginner || !isOwner || playing) $("presetConfirm").hidden = true;
	renderOptions(room, isOwner && !playing);
}

// Keep grouping precedence here: specific room/plugin/basic keys precede character rules.
function optionSection(key) {
	if (key.startsWith("plugin_")) return "插件";
	if (["observe", "observe_handcard", "mount_combine", "public"].includes(key)) return "房间";
	if (["player_number", "choose_timeout"].includes(key) || key.endsWith("_mode")) return "基本";
	if (key.startsWith("choice_") || ["limit_zhu", "double_character", "change_identity", "change_choice"].includes(key) || key.includes("character")) return "选将";
	return "规则";
}

const modeExplanations = {
	identity: "身份局：主公与忠臣合作，反贼要击败主公，内奸要留到最后单独获胜；除主公外，身份起初保密。",
	guozhan: "国战：每人使用主副两名武将，逐步亮出身份，同势力玩家合作击败其他势力。",
	versus: "对决：双方阵营公开对抗，可选单人接力或多人组队，适合想直接与队友配合的玩家。",
	doudizhu: "斗地主：三人对局，一名强化的地主对抗两名合作的农民，击败对方阵营获胜。",
	single: "单挑：两人正面对抗，可按规则轮换武将，适合想专心练习操作和武将配合的玩家。",
};
const sectionExplanations = {
	基本: "决定这局怎么玩、多少人参加以及每次操作可以思考多久。第一次玩可以保留默认设置。",
	选将: "决定开局能从多少武将中挑选、是否同时使用两名武将。候选越少越容易上手。",
	规则: "这些开关会改变身份、奖励或胜负规则。熟悉标准玩法后，再与同伴商量尝试。",
	武将与卡牌: "武将包决定可选角色和技能；卡牌包决定牌堆的内容。点「查看」可先读规则，禁用可排除不想遇到的内容。",
	房间: "设置房间是否出现在大厅，以及旁观和装备栏规则。邀请熟人时可以关闭公开房间。",
	插件: "服务端提供的额外玩法。开局手牌多组选一让每人挑一手更合意的牌，自动值会照顾人数和牌堆大小。",
	游戏人数: "选择总座位数，包括真人与 AI。朋友不足时，开始游戏后空位自动由 AI 补齐。",
	这局怎么玩: "推荐配置使用基础武将和常用卡牌，减少需要学习的技能。熟悉后可切换自定义，尝试更多内容。",
};

const explanations = {
	choose_timeout: "每次需要你操作时最多等待多少秒，超时后系统代为处理。刚上手可选60或90秒，熟悉后用30秒让节奏更快。",
	observe: "允许引擎旁观者观看本局。想让朋友观战时开启；大厅目前只提供玩家加入入口。",
	observe_handcard: "旁观者可看到玩家手牌，适合教学讲解；认真对抗时建议关闭，避免未公开信息外传。",
	mount_combine: "把进攻坐骑与防御坐骑合成一个装备栏，不能像通常规则那样各装一匹。想尝试简化坐骑栏的变体规则时开启。",
	public: "公开房间会出现在大厅房间列表中；关闭后仍可通过房间号或邀请链接加入。",
	plugin_opening_hand_pick_enable: "开局时发出多组候选手牌，每位玩家选择其中一组，其余洗回牌堆。",
	plugin_opening_hand_pick_timeout: "开局选择手牌的时限，超时或交给 AI 时按牌的价值自动选组。新手可延长时限，留出读牌时间。",
	characterPack: "选择本局可用的武将包，数字表示包内武将数量。",
	cardPack: "选择加入牌堆的卡牌包，数字表示该包加入牌堆的张数。",
	banned: "搜索武将名称或编号并添加禁用；禁用武将不会进入选将候选。",
	bannedcards: "搜索卡牌名称或编号并添加禁用；禁用卡牌不会进入本局牌堆。",
	player_number: "本局总座位数，包含真人和 AI；人没到齐也可以开始，空位由 AI 补齐。想缩短等待时可选较少人数。",
	identity_mode: "标准是隐藏身份的基础玩法；明忠先公开一名忠臣；谋攻加入怒气和身份信息规则；3v3v2分成两队与两名内奸。新手先选标准，熟悉后再换规则。",
	guozhan_mode: "选择国战使用的规则与专用牌堆：势备、应变、九变或怀旧。不同牌堆有不同卡牌效果；按大家熟悉的线下版本选择，新手保留势备。",
	versus_mode: "选择双方人数和组队规则：1v1为单人接力，2v2、3v3、4v4为组队，官渡使用专门的阵营规则。按朋友人数和熟悉程度选择。",
	doudizhu_mode: "选择地主对抗农民的规则版本：休闲、开黑、欢乐、兵临或智斗。各版本的选将、地主能力和牌堆可能不同；初次玩从休闲开始。",
	single_mode: "新1v1使用专用武将和牌堆并轮换出场；点将单挑可选角色；血战长坂坡与无限火力使用特殊规则。先用新1v1，熟悉后再尝试其他玩法。",
	choice_zhu: "主公额外随机候选武将的数量，常备主公还会另行加入候选。想增加选择余地时调高；武将包很小时保持较少数量。",
	choice_zhong: "忠臣开局可挑选的武将数，实际还受剩余武将数量限制。想多一些选择时调高；小武将包建议设为3。",
	choice_fan: "反贼开局可挑选的武将数，实际还受剩余武将数量限制。想减少选不到喜欢角色的情况时调高，小武将包保持较少数量。",
	choice_nei: "内奸开局可挑选的武将数，实际还受剩余武将数量限制。内奸单独作战时可适当增加选择；新手推荐3。",
	choice_commoner: "平民开局可挑选的武将数，仅启用平民身份时使用。想给平民更多生存选择时调高。",
	"doudizhu.choice_zhu": "地主开局可挑选的武将数，在使用此选将规则的斗地主版本中生效。想让地主有更多选择时调高。",
	"doudizhu.choice_fan": "每名农民开局可挑选的武将数，在使用此选将规则的斗地主版本中生效。想增加农民配合空间时调高。",
	limit_zhu: "控制额外加入的常备主公候选：不限制会全部加入，按势力筛选会每个势力抽一名，自选数值按数量抽取。想缩短主公选将列表时开启限制。",
	zhong_card: "明忠玩法中把部分普通卡牌替换成该玩法的专用牌。想体验完整明忠规则时开启；标准身份局不受影响。",
	double_nei: "把一个原有身份改成第二名内奸；每名内奸仍需独自达到胜利条件。想增加隐藏身份的博弈时开启，新手建议关闭。",
	enable_commoner: "把一个原有身份换成平民。平民只要活到其他阵营获胜也算赢；适合想尝试以生存为目标的身份局。",
	double_character: "每名玩家同时使用两名武将，组合双方技能，体力按引擎双将规则计算。想研究技能配合时开启，新手建议关闭。",
	"single.double_character": "单挑可选只用一名武将、强制双将或允许单双任选。双将可组合技能但学习量更大；初次玩选择不启用。",
	double_hp: "双将时如何合成体力上限：两者相加减3、平均值、取最大、取最小或相加。想控制双将的生存能力时调整；只用单将时无效。",
	change_card: "开局发完手牌后，玩家可选择弃掉整手牌并重新摸相同张数，一人一次；联机版没有次数设置，AI不主动换牌。觉得起手太差时可用，想减少起手运气影响时开启。",
	special_identity: "八人身份局额外指定军师、大将与贼首：军师让主公整理牌顶，大将增加主公手牌上限，贼首减少它。想增加身份间配合时开启。",
	enable_year_limit: "每次牌堆洗牌就进入下一年；当前年份达到开局人数时，主公与忠臣直接获胜，存活平民也获胜。想避免对局无限拖延时开启。",
	round_one_use_fury: "谋攻玩法通常从第二轮才能用怒气强化卡牌；开启后第一轮就能强化。想加快开局交锋时开启，其他玩法不使用此规则。",
	enhance_zhu: "给主公额外能力，可选一次性的四象标记或专属技能；专属技能要求至少三名反贼，反贼减少后会失去。觉得主公压力过大时开启。",
	enable_mingcha: "主公开局获得明察，可查看一人是否为反贼，结果公开。想让主公在隐藏身份局中多一点信息时开启。",
	aozhan: "国战残局满足条件后进入鏖战，桃不再回血：原鏖战改当杀或闪，九变鏖战改当酒并加入每轮场景效果。想减少残局互相回血拖延时开启。",
	qunlangCharacters: "把部分旧国战武将替换为群狼环鼎修订版，并隐藏对应九变独立角色。大家熟悉修订技能时开启，想用旧技能则关闭。",
	separatism: "国战允许把不同势力的两名武将组合，按优先亮出的武将决定势力。想尝试跨势力技能组合时开启；新手建议关闭。",
	shenInGuozhan: "神武将亮出时按国战无双规则决定或自选势力，与确定势力武将一起亮出时跟随该势力。想把神武将融入国战阵营时开启。",
	initshow_draw: "第一个亮出武将的玩家获得奖励，可选立即摸牌、奖励标记或关闭。想鼓励大家早点表明阵营时启用。",
	viewnext: "选完武将、发起手牌前，每人能偷看下一座位的副将。想在国战开局多一点判断阵营的信息时开启。",
	zhulian: "指定的主副将组合全部亮出后获得珠联璧合标记，可按规则用于摸牌或回复。想奖励经典武将组合时开启。",
	junzhu: "国战首回合，符合条件的主将可换成对应君主，调整体力上限；上限增加时回复相应体力。想体验君主武将能力时开启。",
	jinEx: "决定晋势力使用文德武备修订版还是紫气东来、受命于天的线下版技能。熟悉OL版本时开启，熟悉线下版本时关闭。",
	replace_handcard: "对决中最后行动的四号位多获得一张起手牌，补偿后手劣势。玩对应四人对决时建议保留。",
	olfeiyang_four: "对决四号位额外获得一次飞扬：准备阶段可弃两张牌，移除判定区一张牌。想保护后手玩家免受延时锦囊压制时开启。",
	choice_num: "1v1接力选将时提供的公共候选武将总数。想有更大的选将空间时调高；想快速开局时调低。",
	replace_number: "1v1接力中每人可选的替补武将数，当前武将阵亡后由替补继续。想打更长的接力赛时调高，想快速结束则减少。",
	enhance_dizhu: "给地主增加所选的殷富、强易或恃强技能，用来加强单人对抗两人的能力；不同选项强度不同。地主经常落败时可尝试，禁用则不加此额外技能。",
	enhance_nongmin: "一名农民阵亡后，另一名农民得到的补偿：OL摸一张，手杀摸两张或回复一点体力，十周年不提供此补偿。觉得农民独自作战太难时选有补偿的版本。",
	feiyang_version: "地主飞扬用于清除自己的判定牌：OL弃两张牌清空判定区，手杀弃两张手牌清一张，十周年弃两张手牌清空。按大家熟悉的版本选择。",
	enable_jin: "把晋势力武将加入新1v1的专用候选池。熟悉基础单挑武将后，想增加新的技能与变化时开启。",
};
for (const id of ["zhu", "zhong", "fan", "nei"]) explanations[`plugin_opening_hand_pick_n_${id}`] = "该身份的候选手牌组数；自动以基础 2 组、内奸 3 组计算，总用牌量超过牌堆 60% 时逐步减少。";

function helpText(opt) {
	const text = explanations[`${state.room?.mode}.${opt.key}`] || explanations[opt.key];
	return text ? `${text}${opt.intro ? ` 原版说明：${opt.intro}` : ""}` : opt.intro || "原版未提供此选项的说明。";
}

function addHelp(parent, text, anchor = parent) {
	parent.title = text;
	const button = document.createElement("button");
	button.type = "button";
	button.className = "help";
	button.textContent = "?";
	button.setAttribute("aria-label", "查看说明");
	button.setAttribute("aria-expanded", "false");
	const explanation = document.createElement("p");
	explanation.className = "explanation";
	explanation.textContent = text;
	explanation.hidden = true;
	button.onclick = () => {
		explanation.hidden = !explanation.hidden;
		button.setAttribute("aria-expanded", String(!explanation.hidden));
	};
	if (anchor === parent) parent.append(button, explanation);
	else {
		anchor.append(button);
		anchor.after(explanation);
	}
}

const patchConfig = config => send({ t: "room.config", config });
const pileSize = room => state.packs.cardPacks.filter(p => room.config.cardPack?.includes(p.id)).reduce((n, p) => n + p.count, 0);

function automaticGroups(room, info) {
	// Source of truth: engine-host/src/plugins/opening-hand-pick.js defaultGroups().
	const identities = ["zhu", "zhong", "fan", "nei"];
	const seats = info?.identityTable?.[Number(room.config.player_number) - 2] ?? [];
	const groups = { zhu: 2, zhong: 2, fan: 2, nei: 3 };
	const counts = Object.fromEntries(identities.map(id => [id, seats.filter(seat => (identities.includes(seat) ? seat : "fan") === id).length]));
	const cost = () => identities.reduce((sum, id) => sum + counts[id] * groups[id] * 4, 0);
	while (cost() > Math.floor(pileSize(room) * 0.6)) {
		const candidates = ["nei", "fan", "zhong", "zhu"].filter(id => counts[id] && groups[id] > 1).sort((a, b) => groups[b] - groups[a]);
		if (!candidates.length) break;
		groups[candidates[0]]--;
	}
	return groups;
}

function optionRow(opt, room, editable, groups) {
	const row = document.createElement("div");
	row.className = "option-row";
	const label = document.createElement("label");
	label.textContent = opt.name;
	const value = room.config[opt.key] ?? opt.init;
	let input;
	if (typeof opt.init === "boolean") {
		label.className = "check";
		input = document.createElement("input");
		input.type = "checkbox";
		input.checked = !!value;
	} else if (opt.item) {
		input = document.createElement("select");
		for (const [v, name] of Object.entries(opt.item)) {
			const id = opt.key.match(/^plugin_opening_hand_pick_n_(zhu|zhong|fan|nei)$/)?.[1];
			input.add(new Option(v === "auto" && id ? `自动（${groups[id]}）` : name, v));
		}
		input.value = String(value);
	} else {
		input = document.createElement("input");
		input.value = value ?? "";
	}
	input.dataset.key = opt.key;
	input.disabled = !editable;
	input.onchange = () => patchConfig({ [opt.key]: input.type === "checkbox" ? input.checked : typeof opt.init === "number" ? Number(input.value) : input.value });
	label.append(input);
	row.append(label);
	addHelp(row, helpText(opt));
	return row;
}

function section(title) {
	const el = document.createElement("section");
	el.className = "settings-section";
	const heading = document.createElement("h3");
	heading.textContent = title;
	el.append(heading);
	addHelp(el, sectionExplanations[title], heading);
	return el;
}

function renderOptions(room, editable) {
	const info = state.modes.find(m => m.id === room.mode);
	const box = $("options");
	const key = JSON.stringify([room.mode, room.config, editable, Object.keys(state.candidates)]);
	if (box.dataset.key === key) return;
	const open = new Set([...box.querySelectorAll("details[open]")].map(d => d.dataset.section));
	box.dataset.key = key;
	box.replaceChildren();
	if (room.config.preset === "beginner") {
		const picker = section("游戏人数");
		const buttons = document.createElement("div");
		buttons.className = "player-picker";
		for (const [value, name] of Object.entries(info?.options.find(o => o.key === "player_number")?.item ?? {})) {
			const button = chip(name, String(room.config.player_number) === value, editable, () => patchConfig({ player_number: value }));
			button.dataset.players = value;
			buttons.append(button);
		}
		picker.append(buttons);
		const summary = section("这局怎么玩");
		const count = state.packs.characterPacks.find(p => p.id === "standard")?.count ?? "";
		const text = document.createElement("p");
		text.textContent = `身份局 · 标准武将 ${count} 名 · 标准+军争牌堆 ${pileSize(room)} 张 · 出牌限时 ${room.config.choose_timeout} 秒 · 开局手牌多组选 1`;
		const intro = document.createElement("p");
		intro.className = "muted";
		intro.textContent = modeExplanations.identity;
		summary.append(text, intro);
		box.append(picker, summary);
		return;
	}
	const groups = automaticGroups(room, info);
	const options = [...(info?.options ?? []), { key: "public", name: "公开房间", init: true }];
	for (const name of ["基本", "选将", "规则", "武将与卡牌", "房间", "插件"]) {
		const opts = options.filter(opt => optionSection(opt.key) === name);
		if (!opts.length && name !== "武将与卡牌") continue;
		const card = section(name);
		box.append(card);
		if (name === "武将与卡牌") {
			renderPacks(card, room, editable);
			continue;
		}
		if (name === "插件") {
			for (const enable of opts.filter(o => o.key.endsWith("_enable"))) {
				const prefix = enable.key.slice(0, -6);
				const plugin = document.createElement("div");
				plugin.className = "plugin";
				plugin.append(optionRow(enable, room, editable, groups));
				if (prefix === "plugin_opening_hand_pick_") {
					const summary = document.createElement("p");
					summary.className = "muted small";
					summary.textContent = `当前人数下：主公 ${groups.zhu} · 忠臣 ${groups.zhong} · 反贼 ${groups.fan} · 内奸 ${groups.nei}`;
					plugin.append(summary);
				}
				const enabled = room.config[enable.key] ?? enable.init;
				const body = document.createElement("div");
				body.className = `option-grid ${enabled ? "" : "plugin-disabled"}`;
				for (const opt of opts.filter(o => o !== enable && o.key.startsWith(prefix))) body.append(optionRow(opt, room, editable && enabled, groups));
				plugin.append(body);
				card.append(plugin);
			}
			continue;
		}
		const grid = document.createElement("div");
		grid.className = "option-grid";
		const more = document.createElement("details");
		more.dataset.section = name;
		more.open = open.has(name);
		more.innerHTML = '<summary>更多设置</summary><div class="option-grid"></div>';
		for (const opt of opts) (name === "房间" || opt.frequent ? grid : more.lastElementChild).append(optionRow(opt, room, editable, groups));
		card.append(grid);
		if (more.lastElementChild.childElementCount) card.append(more);
	}
}

function chip(text, active, editable, action) {
	const el = document.createElement(editable ? "button" : "span");
	el.className = `chip ${active ? "selected" : ""}`;
	el.textContent = `${active ? "✓ " : ""}${text}`;
	if (editable) {
		el.type = "button";
		el.setAttribute("aria-pressed", String(active));
		el.onclick = action;
	}
	return el;
}

function renderPacks(card, room, editable) {
	for (const [key, title, packs] of [
		["characterPack", "武将包", state.packs.characterPacks],
		["cardPack", "卡牌包", state.packs.cardPacks],
	]) {
		const block = document.createElement("div");
		block.className = "pack-block";
		block.innerHTML = `<h4>${title}</h4>`;
		addHelp(block, explanations[key], block.firstElementChild);
		const chips = document.createElement("div");
		chips.className = "chips";
		const selected = room.config[key] ?? [];
		const summary = document.createElement("p");
		summary.className = "muted small";
		summary.textContent = `已选 ${packs.filter(p => selected.includes(p.id)).length}/${packs.length} 个${title} · 共 ${packs.filter(p => selected.includes(p.id)).reduce((n, p) => n + p.count, 0)} ${key === "characterPack" ? "名武将" : "张牌"}`;
		block.append(summary);
		if (editable) {
			const actions = document.createElement("div");
			actions.className = "actions pack-actions";
			for (const [text, values] of [
				["全选", packs.map(p => p.id)],
				["清空", []],
				["恢复默认", state.packs[key === "characterPack" ? "defaultCharacterPacks" : "defaultCardPacks"]],
			]) {
				const button = document.createElement("button");
				button.textContent = text;
				button.onclick = () => patchConfig({ [key]: values });
				actions.append(button);
			}
			block.append(actions);
		}
		for (const p of packs) {
			const group = document.createElement("span");
			group.className = "pack-chip";
			group.append(chip(`${p.name} · ${p.count}`, selected.includes(p.id), editable, () => patchConfig({ [key]: selected.includes(p.id) ? selected.filter(id => id !== p.id) : [...selected, p.id] })));
			const preview = document.createElement("button");
			preview.className = "preview-button";
			preview.textContent = "查看";
			preview.setAttribute("aria-label", `查看${p.name}${title}`);
			preview.onclick = () => openPackPreview(key === "characterPack" ? "character" : "card", p);
			group.append(preview);
			chips.append(group);
		}
		block.append(chips);
		card.append(block);
	}
	const count = document.createElement("p");
	count.textContent = `牌堆：${pileSize(room)} 张`;
	count.className = "pile-count";
	card.append(count);
	for (const [key, title, kind] of [
		["banned", "禁用武将", "characters"],
		["bannedcards", "禁用卡牌", "cards"],
	]) {
		const block = document.createElement("div");
		block.className = "ban-picker";
		block.innerHTML = `<h4>${title}</h4>`;
		addHelp(block, explanations[key], block.firstElementChild);
		const selected = room.config[key] ?? [];
		const candidates = state.candidates[kind];
		const names = new Map(candidates?.map(c => [c.id, c.name]));
		const chips = document.createElement("div");
		chips.className = "chips";
		for (const id of selected) chips.append(chip(`${names.get(id) || id}${editable ? " ×" : ""}`, true, editable, () => patchConfig({ [key]: selected.filter(v => v !== id) })));
		if (!selected.length) chips.textContent = "暂无禁用";
		block.append(chips);
		if (!candidates && !state.candidates[`${kind}Loading`]) {
			state.candidates[`${kind}Loading`] = true;
			fetch(`/api/catalog/${kind}`)
				.then(r => {
					if (!r.ok) throw new Error();
					return r.json();
				})
				.then(list => {
					state.candidates[kind] = list;
					render();
				})
				.catch(() => {
					delete state.candidates[`${kind}Loading`];
					toast("禁用目录加载失败，请重新进入房间重试");
				});
		}
		if (editable) {
			const input = document.createElement("input");
			input.type = "search";
			input.placeholder = candidates ? "搜索名称或编号" : "正在加载目录…";
			input.setAttribute("aria-label", `搜索${title}`);
			input.disabled = !candidates;
			const results = document.createElement("div");
			results.className = "ban-results";
			input.oninput = () => {
				results.replaceChildren();
				const query = input.value.trim().toLowerCase();
				if (!query) return;
				const matches = candidates.filter(c => !selected.includes(c.id) && `${c.id} ${c.name}`.toLowerCase().includes(query));
				const unique = [...new Map(matches.map(c => [c.id, c])).values()];
				for (const c of unique.slice(0, 40)) {
					const button = document.createElement("button");
					button.type = "button";
					button.textContent = `${c.name} (${c.id}) · ${c.pack} ＋`;
					button.onclick = () => patchConfig({ [key]: [...selected, c.id] });
					results.append(button);
				}
				if (!unique.length) results.textContent = "无匹配结果";
				else if (unique.length > 40) results.append(document.createTextNode("仅显示前 40 项，请继续输入缩小范围。"));
			};
			block.append(input, results);
		}
		card.append(block);
	}
}

function renderRoomList() {
	const box = $("roomList");
	box.replaceChildren();
	if (!state.rooms.length) {
		box.textContent = "暂无公开房间，创建一个邀请大家加入吧。";
		return;
	}
	for (const room of state.rooms) {
		const row = document.createElement("div");
		row.className = "room-list-row";
		const text = document.createElement("div");
		text.innerHTML = `<strong>${escapeHtml(room.modeName)}</strong> <span class="code">${escapeHtml(room.code)}</span><div class="muted small">${escapeHtml(room.ownerName)} · ${room.players}/${room.maxPlayers} 人 · ${room.status === "playing" ? "对局中" : "等待中"}</div>`;
		const join = document.createElement("button");
		join.textContent = "加入";
		join.disabled = room.players >= room.maxPlayers || room.status === "playing";
		join.onclick = () => send({ t: "room.join", code: room.code });
		row.append(text, join);
		box.append(row);
	}
}

// ---------- events ----------

$("nickname").addEventListener("change", e => {
	const v = e.target.value.trim();
	storage(s => s.setItem(NICK_KEY, v));
	send({ t: "profile", nickname: v });
});
$("createBtn").onclick = () => send({ t: "room.create", mode: $("createMode").value });
$("joinBtn").onclick = () => {
	const code = $("joinCode").value.trim();
	if (!/^\d{6}$/.test(code)) return toast("请输入 6 位房间号");
	send({ t: "room.join", code });
};
$("joinCode").addEventListener("keydown", e => e.key === "Enter" && $("joinBtn").click());
$("leaveBtn").onclick = () => send({ t: "room.leave" });
// two-step confirm inside the page (confirm() dialogs are not used in the lobby)
let dissolveArmed;
$("dissolveBtn").onclick = () => {
	const btn = $("dissolveBtn");
	if (!dissolveArmed) {
		btn.textContent = "确认解散？";
		dissolveArmed = setTimeout(() => {
			dissolveArmed = undefined;
			btn.textContent = "解散房间";
		}, 4000);
		return;
	}
	clearTimeout(dissolveArmed);
	dissolveArmed = undefined;
	btn.textContent = "解散房间";
	state.showingMenu = false;
	send({ t: "room.dissolve" });
};
$("startBtn").onclick = () => send({ t: "room.start" });
$("roomMode").onchange = e => send({ t: "room.config", mode: e.target.value });
$("members").addEventListener("click", e => {
	const btn = e.target.closest("button[data-op]");
	if (!btn) return;
	send({ t: btn.dataset.op === "kick" ? "room.kick" : "room.transfer", uid: btn.dataset.uid });
});
$("copyLink").onclick = async () => {
	const link = `${location.origin}/room/${state.room.code}`;
	try {
		await navigator.clipboard.writeText(link);
		toast("邀请链接已复制");
	} catch {
		toast(link, 6000);
	}
};
$("againBtn").onclick = () => send({ t: "room.restart" });
$("backBtn").onclick = () => send({ t: "room.back" });
$("exitBtn").onclick = () => {
	state.showingMenu = false;
	send({ t: "room.leave" });
};
$("menuBtn").onclick = () => {
	state.showingMenu = !state.showingMenu;
	render();
};

// The game page asks for GPL consent with a blocking confirm() on first run; ask here instead
// (same origin, same flag) so the embedded game never stops on a dialog.
const GPL_KEY = "gplv3_noname_alerted";
if (!storage(s => s.getItem(GPL_KEY), "true")) {
	$("gpl").hidden = false;
	$("gplAccept").onclick = () => {
		storage(s => s.setItem(GPL_KEY, String(true)));
		$("gpl").hidden = true;
	};
}

connect();
render();

// Preset changes are explicit, with an inline confirmation before discarding custom settings.
$("beginnerPreset").onclick = () => {
	if (state.room.config.preset !== "beginner") $("presetConfirm").hidden = false;
};
$("customPreset").onclick = () => patchConfig({ preset: "custom" });
$("confirmPreset").onclick = () => {
	$("presetConfirm").hidden = true;
	patchConfig({ preset: "beginner" });
};
$("cancelPreset").onclick = () => {
	$("presetConfirm").hidden = true;
};
function returnToGame() {
	state.showingMenu = false;
	render();
}
$("returnGame").onclick = returnToGame;
$("app").addEventListener("click", e => {
	if (e.target === $("app") && $("app").classList.contains("overlay")) returnToGame();
});
document.addEventListener("keydown", e => {
	if (e.key !== "Escape") return;
	if (!$("packPreview").hidden) closePackPreview();
	else if (state.showingMenu) returnToGame();
});
let previewRequest = 0;
let previewReturnFocus;
function closePackPreview() {
	previewRequest++;
	$("packPreview").hidden = true;
	previewReturnFocus?.focus();
}
$("closePreview").onclick = closePackPreview;
$("packPreview").onclick = e => {
	if (e.target === $("packPreview")) closePackPreview();
};
$("packPreview").addEventListener("keydown", e => {
	if (e.key !== "Tab") return;
	const targets = [...$("packPreview").querySelectorAll("button, input, summary")];
	const first = targets[0],
		last = targets.at(-1);
	if (e.shiftKey && document.activeElement === first) {
		e.preventDefault();
		last.focus();
	}
	if (!e.shiftKey && document.activeElement === last) {
		e.preventDefault();
		first.focus();
	}
});
async function openPackPreview(kind, pack) {
	const request = ++previewRequest;
	previewReturnFocus = document.activeElement;
	$("previewTitle").textContent = `${pack.name} · ${kind === "character" ? "武将" : "卡牌"}`;
	$("previewSearch").value = "";
	$("previewContent").textContent = "正在加载…";
	$("packPreview").hidden = false;
	$("closePreview").focus();
	try {
		const response = await fetch(`/api/catalog/pack/${kind}/${encodeURIComponent(pack.id)}`);
		if (!response.ok) throw new Error();
		const entries = await response.json();
		if (request !== previewRequest) return;
		const draw = () => {
			const query = $("previewSearch").value.trim().toLowerCase();
			const filtered = entries.filter(entry => JSON.stringify(entry).toLowerCase().includes(query));
			const content = $("previewContent");
			content.replaceChildren();
			content.className = kind === "character" ? "character-grid" : "card-list";
			if (!filtered.length) content.textContent = "无匹配结果";
			if (kind === "character") {
				for (const c of filtered) {
					const item = document.createElement("details");
					item.className = "character-detail";
					item.innerHTML = `<summary><div class="portrait"><img loading="lazy" src="${escapeHtml(c.image)}" alt="${escapeHtml(c.name)}" /><span hidden>暂无画像</span></div><strong>${escapeHtml(c.name)}</strong><div>${escapeHtml(c.group)} · 体力 ${escapeHtml(c.hp)}</div><div class="muted small">${c.skills.map(s => escapeHtml(s.name)).join(" · ")}</div><span class="small">展开技能说明</span></summary>`;
					const img = item.querySelector("img");
					img.onerror = () => {
						img.hidden = true;
						img.nextElementSibling.hidden = false;
					};
					for (const skill of c.skills) {
						const p = document.createElement("p");
						p.textContent = `${skill.name}：${skill.description}`;
						item.append(p);
					}
					content.append(item);
				}
			} else {
				for (const type of new Set(filtered.map(c => c.type))) {
					const group = document.createElement("section");
					const heading = document.createElement("h3");
					heading.textContent = type;
					group.append(heading);
					for (const c of filtered.filter(c => c.type === type)) {
						const row = document.createElement("article");
						row.innerHTML = `<h4>${escapeHtml(c.name)} · ${c.count} 张</h4><p>${escapeHtml(c.description)}</p>`;
						group.append(row);
					}
					content.append(group);
				}
			}
		};
		$("previewSearch").oninput = draw;
		draw();
	} catch {
		if (request === previewRequest) $("previewContent").textContent = "加载失败，请关闭后重新查看。";
	}
}
