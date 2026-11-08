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
			$("nickname").value = msg.nickname;
			fillModeSelect($("createMode"), "identity");
			// deep link /room/<code>
			{
				const m = /^\/room\/(\d{6})$/.exec(location.pathname);
				if (m && !state.room) send({ t: "room.join", code: m[1] });
			}
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
			const ops =
				isOwner && m.uid !== me
					? `<button data-op="transfer" data-uid="${m.uid}">设为房主</button><button data-op="kick" data-uid="${m.uid}">移出</button>`
					: "";
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

function renderOptions(room, editable) {
	const info = state.modes.find(m => m.id === room.mode);
	const box = $("options");
	const key = JSON.stringify([room.mode, room.config, editable]);
	if (box.dataset.key === key) return;
	box.dataset.key = key;
	box.innerHTML = "";
	for (const opt of info?.options ?? []) {
		const value = room.config[opt.key] ?? opt.init;
		let el;
		if (typeof opt.init === "boolean") {
			el = document.createElement("label");
			el.className = "check";
			el.innerHTML = `<input type="checkbox" ${value ? "checked" : ""} ${editable ? "" : "disabled"} /> ${escapeHtml(opt.name)}`;
			el.querySelector("input").onchange = e => send({ t: "room.config", config: { [opt.key]: e.target.checked } });
		} else if (opt.item) {
			el = document.createElement("label");
			el.innerHTML = `${escapeHtml(opt.name)}<select ${editable ? "" : "disabled"}>${Object.entries(opt.item)
				.map(([v, l]) => `<option value="${escapeHtml(v)}" ${String(value) === v ? "selected" : ""}>${escapeHtml(l)}</option>`)
				.join("")}</select>`;
			el.querySelector("select").onchange = e => send({ t: "room.config", config: { [opt.key]: e.target.value } });
		} else {
			el = document.createElement("label");
			el.innerHTML = `${escapeHtml(opt.name)}<input value="${escapeHtml(value)}" ${editable ? "" : "disabled"} />`;
			el.querySelector("input").onchange = e => {
				const v = e.target.value;
				send({ t: "room.config", config: { [opt.key]: typeof opt.init === "number" ? Number(v) : v } });
			};
		}
		if (opt.intro) el.title = opt.intro;
		box.appendChild(el);
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
