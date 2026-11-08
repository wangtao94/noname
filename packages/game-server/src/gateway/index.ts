// WebSocket endpoints on the same HTTP port:
//   /ws       control plane (lobby shell): JSON ClientMsg / ServerMsg
//   /ws/game  game plane (game page iframe): the engine's own messages, routed to the room's game worker
import type { Server, IncomingMessage } from "node:http";
import { createHash } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import type { FastifyBaseLogger } from "fastify";
import { PROTOCOL_VERSION, type ClientMsg, type ServerMsg } from "../protocol.ts";
import type { UserRecord, UserStore } from "../store.ts";
import { RoomError, type Room, type RoomManager } from "../rooms/room-manager.ts";

const HEARTBEAT_MS = 25_000;

export function uidFromToken(token: string) {
	return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

function nickname(v: unknown) {
	return typeof v === "string" && v.trim() ? v.trim().slice(0, 12) : "无名玩家";
}

function avatar(v: unknown) {
	return typeof v === "string" && /^[\w:-]{1,64}$/.test(v) ? v : "";
}

export function attachGateway(opts: { server: Server; rooms: RoomManager; users: UserStore; log: FastifyBaseLogger; serverVersion: string }) {
	const { server, rooms, users, log } = opts;
	const control = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
	const game = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
	/** uid -> open control sockets */
	const controlSockets = new Map<string, Set<WebSocket>>();

	server.on("upgrade", (req, socket, head) => {
		const url = new URL(req.url ?? "/", "http://x");
		if (url.pathname === "/ws") control.handleUpgrade(req, socket, head, ws => control.emit("connection", ws, req));
		else if (url.pathname === "/ws/game") game.handleUpgrade(req, socket, head, ws => game.emit("connection", ws, req));
		else socket.destroy();
	});

	const send = (ws: WebSocket, msg: ServerMsg) => {
		if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
	};

	const presence = (uid: string) => rooms.setPresence(uid, controlSockets.get(uid)?.size ?? 0);

	const pushRoom = (room: Room) => {
		const view = rooms.view(room);
		const memberIds = new Set(room.members.map(m => m.uid));
		for (const uid of memberIds) for (const ws of controlSockets.get(uid) ?? []) send(ws, { t: "room", room: view });
	};
	rooms.onChange(pushRoom);

	const heartbeat = (ws: WebSocket) => {
		let alive = true;
		ws.on("pong", () => (alive = true));
		const timer = setInterval(() => {
			if (!alive) return ws.terminate();
			alive = false;
			ws.ping();
		}, HEARTBEAT_MS);
		ws.on("close", () => clearInterval(timer));
	};

	// ---- control plane ----
	control.on("connection", (ws: WebSocket) => {
		heartbeat(ws);
		let user: UserRecord | undefined;

		ws.on("message", async raw => {
			let msg: ClientMsg;
			try {
				msg = JSON.parse(String(raw));
				if (!msg || typeof msg.t !== "string") throw new Error();
			} catch {
				return send(ws, { t: "error", code: "bad_message", message: "无法解析的消息" });
			}
			try {
				if (msg.t === "ping") return send(ws, { t: "pong" });
				if (msg.t === "hello") {
					if (typeof msg.token !== "string" || msg.token.length < 16 || msg.token.length > 128) throw new RoomError("bad_token", "无效的身份令牌");
					const uid = uidFromToken(msg.token);
					const now = Date.now();
					user = (await users.get(uid)) ?? { uid, token: msg.token, nickname: nickname(msg.nickname), avatar: avatar(msg.avatar), createdAt: now, lastSeenAt: now };
					if (msg.nickname) user.nickname = nickname(msg.nickname);
					if (msg.avatar) user.avatar = avatar(msg.avatar);
					user.lastSeenAt = now;
					await users.put(user);
					let set = controlSockets.get(uid);
					if (!set) controlSockets.set(uid, (set = new Set()));
					set.add(ws);
					send(ws, { t: "welcome", uid, nickname: user.nickname, avatar: user.avatar, version: PROTOCOL_VERSION, serverVersion: opts.serverVersion, modes: rooms.modes });
					presence(uid);
					rooms.updateProfile(user);
					const room = rooms.roomOf(uid);
					send(ws, { t: "room", room: room ? rooms.view(room) : null });
					return;
				}
				if (!user) throw new RoomError("no_hello", "请先发送 hello");
				const u = user;
				switch (msg.t) {
					case "profile":
						if (msg.nickname !== undefined) u.nickname = nickname(msg.nickname);
						if (msg.avatar !== undefined) u.avatar = avatar(msg.avatar);
						await users.put(u);
						rooms.updateProfile(u);
						break;
					case "room.create": {
						const before = rooms.roomOf(u.uid);
						const room = rooms.create(u, typeof msg.mode === "string" ? msg.mode : undefined, msg.config);
						presence(u.uid);
						if (before && before !== room) pushRoom(before);
						break;
					}
					case "room.join": {
						const before = rooms.roomOf(u.uid);
						rooms.join(u, String(msg.code ?? ""));
						presence(u.uid);
						void before;
						break;
					}
					case "room.leave":
						rooms.leave(u.uid);
						send(ws, { t: "room", room: null });
						break;
					case "room.config":
						rooms.configure(u.uid, msg.mode, msg.config);
						break;
					case "room.kick": {
						const room = rooms.roomOf(u.uid);
						rooms.kick(u.uid, msg.uid);
						for (const s of controlSockets.get(msg.uid) ?? []) send(s, { t: "room", room: null });
						if (room) pushRoom(room);
						break;
					}
					case "room.transfer":
						rooms.transfer(u.uid, msg.uid);
						break;
					case "room.start":
					case "room.restart":
						await rooms.start(u.uid);
						break;
					case "room.back":
						await rooms.back(u.uid);
						break;
					default:
						throw new RoomError("bad_message", "未知的消息类型");
				}
			} catch (e) {
				if (e instanceof RoomError) send(ws, { t: "error", code: e.code, message: e.message });
				else {
					log.error(e, "control message failed");
					send(ws, { t: "error", code: "internal", message: "服务器内部错误" });
				}
			}
		});

		ws.on("close", () => {
			if (!user) return;
			controlSockets.get(user.uid)?.delete(ws);
			presence(user.uid);
		});
	});

	// ---- game plane ----
	game.on("connection", async (ws: WebSocket, req: IncomingMessage) => {
		heartbeat(ws);
		const url = new URL(req.url ?? "/", "http://x");
		const token = url.searchParams.get("token") ?? "";
		const code = url.searchParams.get("room") ?? "";
		const user = token ? await users.getByToken(token) : undefined;
		if (!user) return ws.close(4401, "unauthorized");
		const room = rooms.rooms.get(code);
		if (!room || !room.members.some(m => m.uid === user.uid)) return ws.close(4404, "not in room");
		const session = rooms.findGame(code, url.searchParams.get("game") ?? undefined);
		if (!session || session.status === "closed") return ws.close(4410, "no game");
		const sock = { send: (d: string) => ws.readyState === ws.OPEN && ws.send(d), close: (c?: number, r?: string) => ws.close(c, r) };
		const resumeSeq = url.searchParams.get("resume");
		const resume = resumeSeq !== null ? { serverSeq: Number(resumeSeq) || 0, clientSeq: Number(url.searchParams.get("cseq")) || 0 } : undefined;
		session.attach(user.uid, sock, resume);
		ws.on("message", raw => session.message(user.uid, sock, String(raw)));
		ws.on("close", () => session.detach(user.uid, sock));
	});

	return {
		close() {
			for (const ws of control.clients) ws.close(1001, "server shutdown");
			for (const ws of game.clients) ws.close(1001, "server shutdown");
		},
	};
}
