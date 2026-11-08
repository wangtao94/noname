// Server-authoritative room client ("server room" mode).
//
// The game page is opened by the lobby shell as
//   /index.html?sa-room=<code>&sa-uid=<uid>&sa-token=<token>&sa-game=<gameId>
// In this mode the page skips the splash/IP screen and connects straight to the game server's
// /ws/game endpoint; the engine then runs its normal online-client code path.
//
// The connection is a ResumableSocket: short network drops are invisible to the engine. Frames carry
// sequence numbers and are replayed after reconnecting; only when resuming is impossible does the
// engine see a close (and the page reloads into the engine's snapshot reconnect).

/**
 * @returns {{ room: string, uid: string, token: string, game: string | null, defer: boolean } | null}
 */
export function getServerRoomParams() {
	if (typeof location === "undefined") return null;
	const params = new URLSearchParams(location.search);
	const room = params.get("sa-room");
	const uid = params.get("sa-uid");
	const token = params.get("sa-token");
	if (!room || !uid || !token) return null;
	return { room, uid, token, game: params.get("sa-game"), defer: params.get("sa-defer") === "1" };
}

/**
 * Apply in-memory (not saved) config overrides right after the local config is loaded.
 * @param {import("noname").Library} lib
 * @param {typeof import("noname")._status} _status
 */
export function applyServerRoomConfig(lib, _status) {
	const params = getServerRoomParams();
	if (!params) return false;
	_status.serverRoom = params;
	lib.config.mode = "connect";
	lib.config.show_splash = "off";
	lib.config.new_tutorial = true;
	return true;
}

/** captured before connectServerRoom() temporarily swaps window.WebSocket */
const NativeWebSocket = typeof WebSocket === "undefined" ? undefined : WebSocket;

function notifyShell(type, detail = {}) {
	try {
		window.parent?.postMessage({ type: `noname:${type}`, ...detail }, location.origin);
	} catch {
		/* not embedded */
	}
}

/**
 * Wire format (both directions): "<seq>\n<payload>". Control frames start with "\u0006":
 *   server -> client  "\u0006resume:<lastClientSeqReceived>"  (first frame after a resumed connect)
 *                     "\u0006fresh"                           (resume impossible: state was reset)
 *   client -> server  "\u0006ack:<lastServerSeq>"
 */
export class ResumableSocket {
	/** @param {string} url */
	constructor(url) {
		this.url = url;
		this.onopen = null;
		this.onmessage = null;
		this.onerror = null;
		this.onclose = null;
		this._nocallback = false;
		this.readyState = 0;
		this.serverSeq = 0;
		this.clientSeq = 0;
		/** @type {[number, string][]} unacknowledged outbound frames */
		this.outbox = [];
		this.attempt = 0;
		this.everOpened = false;
		this.closedByUser = false;
		this.ackTimer = setInterval(() => this.#ack(), 2000);
		this.#open();
	}

	#open() {
		const url = new URL(this.url);
		if (this.everOpened) {
			url.searchParams.set("resume", String(this.serverSeq));
			url.searchParams.set("cseq", String(this.clientSeq));
		}
		const ws = new NativeWebSocket(url.href);
		this.ws = ws;
		let opened = false;
		ws.onopen = () => {
			opened = true;
			this.attempt = 0;
			this.readyState = 1;
			if (!this.everOpened) {
				this.everOpened = true;
				this.onopen?.({ target: this });
			} else {
				notifyShell("game-reconnected");
			}
		};
		ws.onmessage = e => this.#receive(String(e.data));
		ws.onclose = e => {
			if (this.ws !== ws) return;
			this.readyState = 0;
			if (this.closedByUser) return;
			// permanent: 4000 kicked, 4001 replaced by another tab, 4002 game closed, 4401 bad token, 4404 not in room, 4410 no game
			if ([4000, 4001, 4002, 4401, 4404, 4410].includes(e.code)) return this.#giveUp(e.code);
			if (!this.everOpened && !opened && this.attempt >= 3) {
				this.onerror?.({ target: this });
				return this.#giveUp(e.code);
			}
			notifyShell("game-reconnecting", { attempt: this.attempt });
			const delay = Math.min(5000, 300 * 2 ** this.attempt++);
			setTimeout(() => this.#open(), delay);
		};
	}

	#receive(frame) {
		if (frame.charCodeAt(0) === 6) {
			if (frame === "\u0006fresh") {
				// the server could not resume this stream; reload into the engine's snapshot reconnect
				this.closedByUser = true;
				notifyShell("game-reload");
				location.reload();
				return;
			}
			if (frame.startsWith("\u0006resume:")) {
				const got = Number(frame.slice(8));
				this.outbox = this.outbox.filter(([seq]) => seq > got);
				for (const [seq, data] of this.outbox) this.ws.send(`${seq}\n${data}`);
			}
			return;
		}
		const nl = frame.indexOf("\n");
		const seq = Number(frame.slice(0, nl));
		if (seq <= this.serverSeq) return; // duplicate from replay
		if (this.serverSeq === 0) notifyShell("game-connected");
		this.serverSeq = seq;
		this.onmessage?.({ data: frame.slice(nl + 1), target: this });
	}

	#ack() {
		if (this.readyState === 1 && this.ws.readyState === NativeWebSocket.OPEN) this.ws.send(`\u0006ack:${this.serverSeq}`);
	}

	/** @param {string} data */
	send(data) {
		const seq = ++this.clientSeq;
		this.outbox.push([seq, data]);
		if (this.outbox.length > 2000) this.outbox.shift();
		if (this.readyState === 1 && this.ws.readyState === NativeWebSocket.OPEN) this.ws.send(`${seq}\n${data}`);
	}

	#giveUp(code) {
		clearInterval(this.ackTimer);
		this.readyState = 3;
		notifyShell("game-closed", { code });
		this.onclose?.({ target: this, code });
	}

	close() {
		this.closedByUser = true;
		clearInterval(this.ackTimer);
		this.readyState = 3;
		this.ws?.close(1000);
		if (!this._nocallback) this.onclose?.({ target: this, code: 1000 });
	}
}

/**
 * Connect to the room's game socket (called from the connect mode's start instead of the IP screen).
 * @param {typeof import("noname").game} game
 * @param {typeof import("noname")._status} _status
 */
export function connectServerRoom(game, _status) {
	const params = _status.serverRoom;
	if (params.defer && !params.game) {
		// preloaded by the lobby while the previous game is still on screen: wait for the next game's id
		const onMessage = e => {
			if (e.origin !== location.origin || e.data?.type !== "noname:attach" || !e.data.game) return;
			window.removeEventListener("message", onMessage);
			params.game = e.data.game;
			connectServerRoom(game, _status);
		};
		window.addEventListener("message", onMessage);
		notifyShell("game-preloaded");
		return;
	}
	const { room, uid, token, game: gameId } = params;
	game.onlineID = uid;
	const proto = location.protocol === "https:" ? "wss" : "ws";
	const url = `${proto}://${location.host}/ws/game?room=${encodeURIComponent(room)}&token=${encodeURIComponent(token)}${gameId ? `&game=${encodeURIComponent(gameId)}` : ""}`;
	// game.connect() constructs `new WebSocket(url)`; hand it the resumable socket instead.
	const previous = window.WebSocket;
	window.WebSocket = ResumableSocket;
	try {
		game.connect(url, success => {
			if (!success) notifyShell("game-connect-failed", { room });
		});
	} finally {
		window.WebSocket = previous;
	}
}
