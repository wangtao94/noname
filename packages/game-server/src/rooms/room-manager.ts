// Rooms live on the server; the owner only holds management permissions.
import { randomInt } from "node:crypto";
import type { ServerConfig } from "../config.ts";
import type { BanCandidate, PackDetails, PackCatalog, MemberView, ModeInfo, RoomView, RoomSummary } from "../protocol.ts";
import type { RecordSink, UserRecord } from "../store.ts";
import { GameSession } from "./game-session.ts";
import { beginnerPreset } from "./presets.ts";
import { WorkerPool } from "./worker-pool.ts";

export class RoomError extends Error {
	constructor(
		readonly code: string,
		message: string
	) {
		super(message);
	}
}

interface Member {
	uid: string;
	nickname: string;
	avatar: string;
	/** control connections currently open for this user */
	connections: number;
	offlineSince?: number;
}

export interface Room {
	code: string;
	ownerId: string;
	mode: string;
	config: Record<string, unknown>;
	members: Member[];
	status: "lobby" | "playing" | "ended";
	game?: GameSession;
	/** previous game kept alive briefly so its result screen stays usable while the next one starts */
	retiring: GameSession[];
	emptySince?: number;
	createdAt: number;
}

export type RoomListener = (room: Room) => void;

const OWNER_HANDOVER_MS = 30_000;

export class RoomManager {
	readonly rooms = new Map<string, Room>();
	/** uid -> room code */
	readonly #userRoom = new Map<string, string>();
	readonly #listeners = new Set<RoomListener>();
	readonly pool: WorkerPool;
	modes: ModeInfo[] = [];
	packs: PackCatalog = { characterPacks: [], cardPacks: [], defaultCharacterPacks: [], defaultCardPacks: [] };
	characters: BanCandidate[] = [];
	cards: BanCandidate[] = [];
	packDetails: PackDetails = { character: {}, card: {} };
	#sweepTimer: NodeJS.Timeout;

	constructor(
		private readonly config: ServerConfig,
		private readonly records: RecordSink,
		private readonly log: { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void }
	) {
		this.pool = new WorkerPool({
			size: 1,
			capacity: () => this.config.maxRooms - this.liveGames(),
			preset: { game_speed: config.gameSpeed, extensions: config.extensions, extension_auto_import: false, ...Object.fromEntries(config.extensions.map(n => [`extension_${n}_enable`, true])) },
			log: msg => this.log.warn({ engine: msg.slice(0, 2000) }, "engine"),
		});
		this.#sweepTimer = setInterval(() => this.#sweep(), 5_000);
		this.#sweepTimer.unref();
	}

	get extensions() {
		return this.config.extensions;
	}

	async init() {
		this.pool.start();
		// learn the mode catalog from a booted engine
		const w = await this.pool.take();
		this.modes = (w.catalog as ModeInfo[]).filter(m => m.options.length);
		const { characters = [], cards = [], details, ...packs } = this.pool.assets!;
		this.packs = packs;
		this.packDetails = details;
		this.characters = characters;
		this.cards = cards;
		await w.terminate();
	}

	onChange(fn: RoomListener) {
		this.#listeners.add(fn);
		return () => this.#listeners.delete(fn);
	}

	#emit(room: Room) {
		for (const fn of this.#listeners) fn(room);
	}

	summaries(): RoomSummary[] {
		return (
			[...this.rooms.values()]
				// rooms whose members all closed the page wait for the idle sweep; do not advertise them
				.filter(r => r.config.public === true && r.members.some(m => m.connections > 0))
				.map(r => ({
					code: r.code,
					mode: r.mode,
					modeName: this.modes.find(m => m.id === r.mode)?.name ?? r.mode,
					ownerName: r.members.find(m => m.uid === r.ownerId)?.nickname ?? "无名玩家",
					players: r.members.length,
					maxPlayers: this.#maxPlayers(r),
					status: r.status,
				}))
		);
	}

	liveGames() {
		let n = 0;
		for (const r of this.rooms.values()) n += (r.game && r.game.status !== "closed" ? 1 : 0) + r.retiring.length;
		return n;
	}

	roomOf(uid: string): Room | undefined {
		const code = this.#userRoom.get(uid);
		return code ? this.rooms.get(code) : undefined;
	}

	view(room: Room): RoomView {
		const members: MemberView[] = room.members.map(m => ({ uid: m.uid, nickname: m.nickname, avatar: m.avatar, online: m.connections > 0 }));
		return {
			code: room.code,
			ownerId: room.ownerId,
			mode: room.mode,
			config: room.config,
			members,
			status: room.status,
			game: room.game ? { id: room.game.gameId, startedAt: room.game.startedAt, endedAt: room.game.endedAt } : undefined,
			maxPlayers: this.#maxPlayers(room),
		};
	}

	#maxPlayers(room: Room) {
		const n = Number.parseInt(String(room.config.player_number ?? ""), 10);
		if (Number.isFinite(n) && n > 0) return n;
		return { doudizhu: 3, versus: 4, single: 2 }[room.mode] ?? 8;
	}

	#newCode() {
		for (;;) {
			const code = String(randomInt(100000, 1000000));
			if (!this.rooms.has(code)) return code;
		}
	}

	#defaultConfig(mode: string) {
		const info = this.modes.find(m => m.id === mode);
		if (!info) throw new RoomError("bad_mode", `不支持的模式：${mode}`);
		const defaults = { ...Object.fromEntries(info.options.map(o => [o.key, o.init])), preset: "custom", public: true, characterPack: [...this.packs.defaultCharacterPacks], cardPack: [...this.packs.defaultCardPacks], banned: [], bannedcards: [] };
		return mode === "identity" ? beginnerPreset(defaults) : defaults;
	}

	#sanitizeConfig(mode: string, patch: Record<string, unknown> = {}) {
		const info = this.modes.find(m => m.id === mode);
		if (!info) throw new RoomError("bad_mode", `不支持的模式：${mode}`);
		const out: Record<string, unknown> = {};
		if (!patch || typeof patch !== "object" || Array.isArray(patch)) return out;
		if (typeof patch.public === "boolean") out.public = patch.public;
		for (const [key, entries, cap] of [
			["characterPack", this.packs.characterPacks, 256],
			["cardPack", this.packs.cardPacks, 256],
			["banned", this.characters, 10000],
			["bannedcards", this.cards, 2000],
		] as const) {
			const value = patch[key];
			if (!Array.isArray(value)) continue;
			const valid = new Set(entries.map(e => e.id));
			out[key] = [...new Set(value.filter(id => typeof id === "string" && valid.has(id)))].slice(0, cap);
		}
		for (const opt of info.options) {
			if (!(opt.key in patch)) continue;
			const v = patch[opt.key];
			if (opt.item && !(String(v) in opt.item)) continue;
			if (typeof opt.init === "boolean" && typeof v !== "boolean") continue;
			if (typeof v === "object" && v !== null) continue;
			out[opt.key] = v;
		}
		return out;
	}

	create(user: UserRecord, mode = "identity", config?: Record<string, unknown>): Room {
		this.leave(user.uid);
		const room: Room = {
			code: this.#newCode(),
			ownerId: user.uid,
			mode,
			config: { ...this.#defaultConfig(mode), ...this.#sanitizeConfig(mode, config), ...(config && (config.preset === "custom" || Object.keys(config).some(k => !["public", "player_number", "preset"].includes(k))) ? { preset: "custom" } : {}) },
			members: [],
			status: "lobby",
			retiring: [],
			createdAt: Date.now(),
		};
		this.rooms.set(room.code, room);
		this.join(user, room.code);
		this.log.info({ room: room.code, owner: user.uid, mode }, "room created");
		return room;
	}

	join(user: UserRecord, code: string): Room {
		const room = this.rooms.get(code);
		if (!room) throw new RoomError("no_room", "房间不存在");
		const existing = room.members.find(m => m.uid === user.uid);
		if (!existing) {
			if (room.status === "playing" && !room.game?.players.includes(user.uid)) {
				throw new RoomError("playing", "对局进行中，请等待本局结束");
			}
			if (room.members.length >= this.#maxPlayers(room)) throw new RoomError("full", "房间已满");
			const prev = this.roomOf(user.uid);
			if (prev && prev !== room) this.leave(user.uid);
			room.members.push({ uid: user.uid, nickname: user.nickname, avatar: user.avatar, connections: 0 });
			this.#userRoom.set(user.uid, room.code);
		}
		delete room.emptySince;
		this.#emit(room);
		return room;
	}

	leave(uid: string) {
		const room = this.roomOf(uid);
		if (!room) return;
		this.#userRoom.delete(uid);
		room.members = room.members.filter(m => m.uid !== uid);
		if (!room.members.length) return this.#remove(room, "empty");
		if (room.ownerId === uid) this.#handOver(room);
		this.#emit(room);
	}

	#handOver(room: Room) {
		const next = room.members.find(m => m.connections > 0) ?? room.members[0];
		if (next) {
			room.ownerId = next.uid;
			this.log.info({ room: room.code, owner: next.uid }, "owner handed over");
		}
	}

	/** control connection presence (drives owner handover and the online dots in the lobby) */
	setPresence(uid: string, connections: number) {
		const room = this.roomOf(uid);
		const m = room?.members.find(x => x.uid === uid);
		if (!room || !m) return;
		if (m.connections === connections) return;
		m.connections = connections;
		if (m.connections === 0) m.offlineSince = Date.now();
		else delete m.offlineSince;
		this.#emit(room);
	}

	updateProfile(user: UserRecord) {
		const room = this.roomOf(user.uid);
		const m = room?.members.find(x => x.uid === user.uid);
		if (!room || !m) return;
		m.nickname = user.nickname;
		m.avatar = user.avatar;
		this.#emit(room);
	}

	#requireOwner(uid: string): Room {
		const room = this.roomOf(uid);
		if (!room) throw new RoomError("no_room", "你不在房间中");
		if (room.ownerId !== uid) throw new RoomError("not_owner", "只有房主可以执行此操作");
		return room;
	}

	configure(uid: string, mode: string | undefined, patch: Record<string, unknown> | undefined) {
		const room = this.#requireOwner(uid);
		if (room.status === "playing") throw new RoomError("playing", "对局进行中不能修改设置");
		const reset = patch?.preset === "beginner";
		const nextMode = reset ? "identity" : mode || room.mode;
		const nextConfig = reset ? { ...this.#defaultConfig("identity"), ...this.#sanitizeConfig("identity", { player_number: room.config.player_number, public: room.config.public }) } : { ...(nextMode === room.mode ? room.config : { ...this.#defaultConfig(nextMode), public: room.config.public }), ...this.#sanitizeConfig(nextMode, patch) };
		if (!reset && (mode !== undefined || Object.keys(patch ?? {}).some(k => !["player_number", "public"].includes(k)))) nextConfig.preset = "custom";
		if (room.members.length > this.#maxPlayers({ ...room, mode: nextMode, config: nextConfig })) {
			throw new RoomError("too_many", `当前房间有 ${room.members.length} 人，超过所选人数`);
		}
		room.mode = nextMode;
		room.config = nextConfig;
		this.#emit(room);
	}

	/** Owner closes the room for everyone (not during a game). Returns the uids that were in it. */
	dissolve(uid: string): string[] {
		const room = this.#requireOwner(uid);
		if (room.status === "playing") throw new RoomError("playing", "对局进行中，结束后才能解散房间");
		const members = room.members.map(m => m.uid);
		this.#remove(room, "dissolved");
		return members;
	}

	#remove(room: Room, reason: string) {
		this.log.info({ room: room.code, reason }, "room closed");
		this.rooms.delete(room.code);
		for (const m of room.members) this.#userRoom.delete(m.uid);
		room.members = [];
		this.#emit(room);
		void room.game?.close();
		for (const g of room.retiring) void g.close();
	}

	kick(uid: string, target: string) {
		const room = this.#requireOwner(uid);
		if (target === uid) return;
		this.leave(target);
		this.#emit(room);
	}

	transfer(uid: string, target: string) {
		const room = this.#requireOwner(uid);
		if (!room.members.some(m => m.uid === target)) throw new RoomError("no_member", "该玩家不在房间中");
		room.ownerId = target;
		this.#emit(room);
	}

	async start(uid: string) {
		const room = this.#requireOwner(uid);
		if (room.status === "playing") throw new RoomError("playing", "对局已经开始");
		if (this.liveGames() >= this.config.maxRooms) throw new RoomError("busy", "服务器对局数已满，请稍后再试");
		const previous = room.game;
		room.status = "playing";
		this.#emit(room);
		let engine;
		try {
			engine = await this.pool.take();
		} catch (e) {
			room.status = previous ? "ended" : "lobby";
			this.#emit(room);
			throw new RoomError("engine", `引擎启动失败：${(e as Error).message}`);
		}
		const { public: _public, preset: _preset, ...engineConfig } = room.config;
		const game = new GameSession(
			engine,
			room.mode,
			engineConfig,
			room.members.map(m => m.uid),
			{
				joinTimeoutMs: 60_000,
				graceMs: this.config.reconnectGraceMs,
				log: msg => this.log.info({ room: room.code, game: game.gameId.slice(0, 8), msg }, "game"),
			}
		);
		game.on("status", s => {
			if (room.game !== game) return;
			if (s === "over" || s === "closed") {
				room.status = "ended";
				void this.records.save({
					gameId: game.gameId,
					roomCode: room.code,
					mode: game.mode,
					config: game.config,
					players: game.players.map((p, seat) => ({ uid: p, nickname: room.members.find(m => m.uid === p)?.nickname ?? "", seat })),
					startedAt: game.startedAt,
					endedAt: Date.now(),
				});
			}
			this.#emit(room);
		});
		if (previous) {
			room.retiring.push(previous);
			setTimeout(() => this.#retire(room, previous), 60_000).unref();
		}
		room.game = game;
		this.log.info({ room: room.code, game: game.gameId, players: game.players.length }, "game started");
		this.#emit(room);
	}

	async #retire(room: Room, game: GameSession) {
		room.retiring = room.retiring.filter(g => g !== game);
		await game.close();
	}

	/** Return everyone to the room lobby after a game (owner). */
	async back(uid: string) {
		const room = this.#requireOwner(uid);
		if (room.status === "playing") throw new RoomError("playing", "对局进行中");
		const game = room.game;
		room.game = undefined;
		room.status = "lobby";
		this.#emit(room);
		if (game) await game.close();
	}

	findGame(code: string, gameIdOrCurrent?: string): GameSession | undefined {
		const room = this.rooms.get(code);
		if (!room) return undefined;
		if (!gameIdOrCurrent || room.game?.gameId === gameIdOrCurrent) return room.game;
		return room.retiring.find(g => g.gameId === gameIdOrCurrent);
	}

	#sweep() {
		const now = Date.now();
		for (const room of this.rooms.values()) {
			// lobby: hand the owner role over when the owner has been offline for a while
			const owner = room.members.find(m => m.uid === room.ownerId);
			if (room.status !== "playing" && owner && owner.connections === 0 && owner.offlineSince && now - owner.offlineSince > OWNER_HANDOVER_MS) {
				const next = room.members.find(m => m.connections > 0);
				if (next) {
					room.ownerId = next.uid;
					this.#emit(room);
				}
			}
			// members who closed the page and never came back (not during a game: in-game seats stay)
			if (room.status !== "playing") {
				for (const m of [...room.members]) {
					if (m.connections === 0 && m.offlineSince && now - m.offlineSince > this.config.reconnectGraceMs) this.leave(m.uid);
				}
			}
			const nobodyOnline = room.members.every(m => m.connections === 0);
			if (nobodyOnline && !room.emptySince) room.emptySince = now;
			if (!nobodyOnline) delete room.emptySince;
			if (room.emptySince && now - room.emptySince > this.config.roomIdleTtlMs) this.#remove(room, "idle");
		}
	}

	async close() {
		clearInterval(this.#sweepTimer);
		await this.pool.close();
		await Promise.all([...this.rooms.values()].flatMap(r => [r.game?.close(), ...r.retiring.map(g => g.close())]));
	}
}
