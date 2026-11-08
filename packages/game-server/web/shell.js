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
	room: null,
	retry: 0,
	/** gameId -> iframe */
	frames: new Map(),
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

function gameUrl(gameId) {
	const p = new URLSearchParams({ "sa-room": state.room.code, "sa-uid": state.me.uid, "sa-token": token, "sa-game": gameId });
	return `/index.html?${p}`;
}

function syncFrames() {
	const room = state.room;
	const gameId = room && room.status !== "lobby" && room.game && room.members.some(m => m.uid === state.me?.uid) ? room.game.id : null;
	if (!gameId) {
		for (const f of state.frames.values()) f.remove();
		state.frames.clear();
		return;
	}
	if (state.frames.has(gameId)) return;
	const frame = document.createElement("iframe");
	frame.className = "pending";
	frame.allow = "autoplay; fullscreen";
	frame.src = gameUrl(gameId);
	frame.dataset.game = gameId;
	$("frames").appendChild(frame);
	state.frames.set(gameId, frame);
	const reveal = () => {
		frame.classList.remove("pending");
		// drop older games once the new one is visible
		setTimeout(() => {
			for (const [id, f] of state.frames) {
				if (id !== gameId) {
					f.remove();
					state.frames.delete(id);
				}
			}
		}, 400);
	};
	// the engine needs a moment after "load" to build the arena; keep the previous game on screen meanwhile
	frame.addEventListener("load", () => setTimeout(reveal, state.frames.size > 1 ? 1500 : 0), { once: true });
}

window.addEventListener("message", e => {
	if (e.origin !== location.origin) return;
	if (e.data?.type === "noname:game-connect-failed") toast("连接对局失败，正在重试…");
});

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

connect();
render();
