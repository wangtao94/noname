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
	$("startBtn").hidden = !isOwner || room.status !== "lobby";
	$("roomHint").textContent = playing ? "对局进行中" : isOwner ? `${room.members.length}/${room.maxPlayers} 人，空位由 AI 补上` : "等待房主开始游戏";
	$("serverExtensions").textContent = `服务器扩展：${state.extensions.join("、") || "无"}`;
	$("settingsNote").textContent = isOwner ? "" : "（仅房主可修改）";
	fillModeSelect($("roomMode"), room.mode);
	$("roomMode").disabled = !isOwner || playing;
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

const explanations = {
	choose_timeout: "每次出牌或操作的等待时限，超时后由系统处理。",
	observe: "允许其他玩家旁观本局游戏。",
	observe_handcard: "允许旁观者查看手牌，开启前请与玩家确认。",
	mount_combine: "合并坐骑装备栏，使进攻与防御坐骑共用一个栏位。",
	public: "公开房间会出现在大厅房间列表中；关闭后仍可通过房间号或邀请链接加入。",
	plugin_opening_hand_pick_enable: "开局时发出多组候选手牌，每位玩家选择其中一组，其余洗回牌堆。",
	plugin_opening_hand_pick_timeout: "开局选择手牌的时限，超时由 AI 选择。",
	characterPack: "选择本局可用的武将包，数字表示包内武将数量。",
	cardPack: "选择加入牌堆的卡牌包，数字表示该包加入牌堆的张数。",
	banned: "搜索武将名称或编号并添加禁用；禁用武将不会进入选将候选。",
	bannedcards: "搜索卡牌名称或编号并添加禁用；禁用卡牌不会进入本局牌堆。",
};
for (const id of ["zhu", "zhong", "fan", "nei"]) explanations[`plugin_opening_hand_pick_n_${id}`] = "该身份的候选手牌组数；自动以基础 2 组、内奸 3 组计算，总用牌量超过牌堆 60% 时逐步减少。";

function helpText(opt) {
	return opt.intro || explanations[opt.key] || `设置本局的「${opt.name}」，由当前模式规则生效。`;
}

function addHelp(parent, text) {
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
	parent.append(button, explanation);
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
	el.textContent = text;
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
		addHelp(block, explanations[key]);
		const chips = document.createElement("div");
		chips.className = "chips";
		const selected = room.config[key] ?? [];
		for (const p of packs) {
			if (!editable && !selected.includes(p.id)) continue;
			chips.append(chip(`${p.name} · ${p.count}`, selected.includes(p.id), editable, () => patchConfig({ [key]: selected.includes(p.id) ? selected.filter(id => id !== p.id) : [...selected, p.id] })));
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
		addHelp(block, explanations[key]);
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
