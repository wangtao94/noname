import { EventEmitter } from "node:events";
import type { EngineWorker } from "../src/rooms/game-session.ts";
import { beginnerPreset } from "../src/rooms/presets.ts";
import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { RoomManager } from "../src/rooms/room-manager.ts";
import { loadConfig } from "../src/config.ts";
import { MemoryRecordSink } from "../src/store.ts";
import { registerCatalogApi } from "../src/catalog-api.ts";

const user = (uid: string) => ({ uid, token: uid, nickname: uid, avatar: "", createdAt: 0, lastSeenAt: 0 });
function fixture() {
	const rooms = new RoomManager(loadConfig(), new MemoryRecordSink(), { info() {}, warn() {} });
	rooms.modes = [{ id: "identity", name: "身份", options: [{ key: "player_number", name: "人数", init: "4", item: { 2: "2", 4: "4" } }] }];
	rooms.packs = { characterPacks: [{ id: "standard", name: "标准", count: 20 }], cardPacks: [{ id: "standard", name: "标准", count: 100 }], defaultCharacterPacks: ["standard"], defaultCardPacks: ["standard"] };
	rooms.characters = Array.from({ length: 10010 }, (_, i) => ({ id: `c${i}`, name: `武将${i}`, pack: "standard" }));
	rooms.cards = [{ id: "sha", name: "杀", pack: "standard" }];
	return rooms;
}

test("room pack/ban defaults, validated arrays, caps and public boolean", async () => {
	const rooms = fixture();
	try {
		const room = rooms.create(user("owner"));
		assert.deepEqual(room.config, beginnerPreset({ player_number: "4", public: true }));
		rooms.configure("owner", undefined, { characterPack: ["bad", "standard", 1, "standard"], cardPack: [], banned: ["c0", "bad", "c0"], bannedcards: ["sha", "bad"], public: false, unknown: [] });
		assert.deepEqual(room.config.characterPack, ["standard"]);
		assert.deepEqual(room.config.cardPack, []);
		assert.deepEqual(room.config.banned, ["c0"]);
		assert.deepEqual(room.config.bannedcards, ["sha"]);
		assert.equal(room.config.public, false);
		assert.equal(Reflect.get(room.config, "unknown"), undefined);
		rooms.configure("owner", undefined, { public: "true", cardPack: "standard", banned: rooms.characters.map(c => c.id) });
		assert.equal(room.config.public, false);
		assert.deepEqual(room.config.cardPack, []);
		assert.equal((room.config.banned as string[]).length, 10000);
		rooms.join(user("guest"), room.code);
		assert.throws(() => rooms.configure("guest", undefined, { public: true }), /房主/);
		rooms.join(user("third"), room.code);
		assert.throws(() => rooms.configure("owner", undefined, { player_number: "2" }), /超过/);
		assert.equal(room.config.player_number, "4", "failed edit must not mutate room");
	} finally {
		await rooms.close();
	}
});

test("public room summaries reflect owner, seats, status and visibility", async () => {
	const rooms = fixture();
	try {
		const publicRoom = rooms.create(user("owner"));
		rooms.setPresence("owner", 1);
		rooms.create(user("private"), "identity", { public: false });
		rooms.setPresence("private", 1);
		assert.deepEqual(rooms.summaries(), [{ code: publicRoom.code, mode: "identity", modeName: "身份", ownerName: "owner", players: 1, maxPlayers: 4, status: "lobby" }]);
		rooms.join(user("guest"), publicRoom.code);
		rooms.transfer("owner", "guest");
		publicRoom.status = "playing";
		assert.equal(rooms.summaries()[0].ownerName, "guest");
		assert.equal(rooms.summaries()[0].players, 2);
		assert.equal(rooms.summaries()[0].status, "playing");
		publicRoom.status = "lobby";
		rooms.configure("guest", undefined, { public: false });
		assert.deepEqual(rooms.summaries(), []);
	} finally {
		await rooms.close();
	}
});

test("ban catalogs have no-cache, ETag and conditional responses", async () => {
	const rooms = fixture();
	const app = Fastify();
	registerCatalogApi(app, rooms);
	try {
		for (const kind of ["characters", "cards"] as const) {
			const response = await app.inject(`/api/catalog/${kind}`);
			assert.deepEqual(response.json(), rooms[kind]);
			assert.equal(response.headers["cache-control"], "no-cache");
			assert.ok(response.headers.etag);
			const cached = await app.inject({ url: `/api/catalog/${kind}`, headers: { "if-none-match": response.headers.etag! } });
			assert.equal(cached.statusCode, 304);
		}
	} finally {
		await app.close();
		await rooms.close();
	}
});

test("rooms.watch pushes immediately, coalesces changes to one per second, and stops", async () => {
	const { attachGateway } = await import("../src/gateway/index.ts");
	const { MemoryUserStore } = await import("../src/store.ts");
	const { WebSocket } = await import("ws");
	const rooms = fixture();
	const app = Fastify();
	const gateway = attachGateway({ server: app.server, rooms, users: new MemoryUserStore(), log: app.log, serverVersion: "test" });
	await app.listen({ port: 0, host: "127.0.0.1" });
	const address = app.server.address() as { port: number };
	const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
	const messages: { t: string; rooms?: unknown[]; at: number }[] = [];
	ws.on("message", raw => messages.push({ ...JSON.parse(String(raw)), at: Date.now() }));
	const wait = async (condition: () => boolean) => {
		const end = Date.now() + 3000;
		while (!condition()) {
			assert.ok(Date.now() < end, "expected control message");
			await new Promise(resolve => setTimeout(resolve, 10));
		}
	};
	const lists = () => messages.filter(m => m.t === "rooms");
	try {
		await new Promise(resolve => ws.once("open", resolve));
		ws.send(JSON.stringify({ t: "hello", token: "test-watch-token-1234" }));
		await wait(() => messages.some(m => m.t === "welcome"));
		ws.send(JSON.stringify({ t: "rooms.watch", on: true }));
		await wait(() => lists().length === 1);
		const room = rooms.create(user("owner"));
		rooms.setPresence("owner", 1);
		for (let i = 0; i < 10; i++) rooms.updateProfile({ ...user("owner"), nickname: `房主${i}` });
		await new Promise(resolve => setTimeout(resolve, 150));
		assert.equal(lists().length, 1);
		await wait(() => lists().length === 2);
		assert.ok(lists()[1].at - lists()[0].at >= 990);
		assert.equal((lists()[1].rooms![0] as { ownerName: string }).ownerName, "房主9");
		ws.send(JSON.stringify({ t: "rooms.watch", on: false }));
		ws.send(JSON.stringify({ t: "ping" }));
		await wait(() => messages.some(m => m.t === "pong"));
		rooms.configure("owner", undefined, { public: false });
		await new Promise(resolve => setTimeout(resolve, 1100));
		assert.equal(lists().length, 2);
		assert.equal(rooms.rooms.has(room.code), true);
	} finally {
		ws.terminate();
		gateway.close();
		await app.close();
		await rooms.close();
	}
});

test("beginner reset preserves valid seats and public, other changes select custom", async () => {
	const rooms = fixture();
	rooms.modes.push({ id: "single", name: "单挑", options: [{ key: "player_number", name: "人数", init: "2", item: { 2: "2", 12: "12" } }] });
	try {
		const room = rooms.create(user("owner"));
		assert.equal(room.config.preset, "beginner");
		rooms.configure("owner", undefined, { player_number: "2", public: false });
		assert.equal(room.config.preset, "beginner");
		rooms.configure("owner", undefined, { banned: ["c0"] });
		assert.equal(room.config.preset, "custom");
		rooms.configure("owner", undefined, { preset: "beginner" });
		assert.deepEqual(room.config, beginnerPreset({ player_number: "2", public: false }));
		rooms.configure("owner", undefined, { preset: "custom" });
		assert.equal(room.config.preset, "custom");
		rooms.configure("owner", "single", { player_number: "12" });
		assert.equal(room.config.preset, "custom");
		rooms.configure("owner", undefined, { preset: "beginner", banned: ["c0"] });
		assert.equal(room.mode, "identity");
		assert.equal(room.config.player_number, "4", "invalid identity count resets to default");
		assert.equal(room.config.public, false);
		assert.deepEqual(room.config.banned, []);
		assert.equal(rooms.create(user("other"), "single").config.preset, "custom");
	} finally {
		await rooms.close();
	}
});

test("start strips lobby keys and restart uses newly selected packs", async () => {
	const rooms = fixture();
	rooms.packs.characterPacks.push({ id: "other", name: "其他包", count: 10 });
	const sent: { t: string; config: Record<string, unknown> }[] = [];
	const engines: EventEmitter[] = [];
	rooms.pool.take = async () => {
		const events = new EventEmitter();
		engines.push(events);
		return { events, post: (m: { t: string; config: Record<string, unknown> }) => sent.push(m), terminate: async () => {} } as unknown as EngineWorker;
	};
	try {
		const room = rooms.create(user("owner"));
		await rooms.start("owner");
		assert.equal(sent[0].config.preset, undefined);
		assert.equal(sent[0].config.public, undefined);
		assert.deepEqual(sent[0].config.cardPack, ["standard", "extra"]);
		engines[0].emit("message", { t: "over" });
		assert.equal(room.status, "ended");
		rooms.configure("owner", undefined, { cardPack: ["standard"], characterPack: ["other"] });
		await rooms.start("owner");
		assert.equal(engines.length, 2);
		assert.deepEqual(sent[1].config.cardPack, ["standard"]);
		assert.deepEqual(sent[1].config.characterPack, ["other"]);
		assert.equal(sent[1].config.preset, undefined);
	} finally {
		await rooms.close();
	}
});

test("pack details are fetched separately with 200/404 and ETag", async () => {
	const rooms = fixture();
	rooms.packDetails = { character: { standard: [{ id: "caocao", name: "曹操", image: "/image/character/caocao.jpg", group: "魏", hp: "4/4", skills: [{ name: "奸雄", description: "获得伤害牌" }] }] }, card: { standard: [{ id: "sha", name: "杀", type: "基本", count: 30, description: "造成伤害" }] } };
	const app = Fastify();
	registerCatalogApi(app, rooms);
	try {
		for (const kind of ["character", "card"] as const) {
			const url = `/api/catalog/pack/${kind}/standard`;
			const response = await app.inject(url);
			assert.equal(response.statusCode, 200);
			assert.deepEqual(response.json(), rooms.packDetails[kind].standard);
			assert.equal(response.headers["cache-control"], "no-cache");
			assert.ok(response.headers.etag);
			assert.equal((await app.inject({ url, headers: { "if-none-match": response.headers.etag! } })).statusCode, 304);
			assert.equal((await app.inject(`/api/catalog/pack/${kind}/missing`)).statusCode, 404);
			assert.equal((await app.inject(`/api/catalog/pack/${kind}/toString`)).statusCode, 404);
		}
	} finally {
		await app.close();
		await rooms.close();
	}
});

test("owner can dissolve a room outside a game; empty and abandoned rooms disappear", async () => {
	const rooms = fixture();
	try {
		const room = rooms.create(user("owner"));
		rooms.join(user("guest"), room.code);
		rooms.setPresence("owner", 1);
		rooms.setPresence("guest", 1);
		assert.throws(() => rooms.dissolve("guest"), /只有房主/);
		room.status = "playing";
		assert.throws(() => rooms.dissolve("owner"), /对局进行中/);
		room.status = "ended";
		assert.deepEqual(rooms.dissolve("owner").sort(), ["guest", "owner"]);
		assert.equal(rooms.rooms.has(room.code), false);
		assert.equal(rooms.roomOf("guest"), undefined);
		assert.deepEqual(rooms.summaries(), []);

		// last member leaving removes the room at once
		const solo = rooms.create(user("solo"));
		rooms.leave("solo");
		assert.equal(rooms.rooms.has(solo.code), false);

		// a room whose members all closed the page is hidden from the list
		const stale = rooms.create(user("afk"));
		rooms.setPresence("afk", 1);
		assert.equal(rooms.summaries().length, 1);
		rooms.setPresence("afk", 0);
		assert.deepEqual(rooms.summaries(), []);
		assert.equal(rooms.rooms.has(stale.code), true);
	} finally {
		await rooms.close();
	}
});
