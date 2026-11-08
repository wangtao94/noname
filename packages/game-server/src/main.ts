// noname game server entry.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { loadConfig } from "./config.ts";
import { registerStatic } from "./static/index.ts";
import { registerFsApi } from "./fs-api.ts";
import { attachGateway } from "./gateway/index.ts";
import { RoomManager } from "./rooms/room-manager.ts";
import { MemoryRecordSink, MemoryUserStore } from "./store.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const shellDir = path.resolve(here, "../web");
const serverVersion = JSON.parse(await fs.readFile(path.resolve(here, "../package.json"), "utf8")).version as string;

const config = loadConfig();
const app = Fastify({ logger: { level: config.logLevel }, trustProxy: config.trustProxy });

const users = new MemoryUserStore();
const records = new MemoryRecordSink();
const rooms = new RoomManager(config, records, app.log);

app.get("/healthz", async () => ({ ok: true, rooms: rooms.rooms.size, games: rooms.liveGames(), idleWorkers: rooms.pool.idle }));

// lobby shell: "/" and "/room/<code>" render the shell page; its assets live under /shell/
const SHELL_TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };
async function sendShell(file: string, reply: import("fastify").FastifyReply) {
	const full = path.join(shellDir, file);
	if (!full.startsWith(shellDir + path.sep)) return reply.code(404).send();
	try {
		const body = await fs.readFile(full);
		return reply
			.header("Content-Type", SHELL_TYPES[path.extname(full)] ?? "application/octet-stream")
			.header("Cache-Control", "no-cache")
			.send(body);
	} catch {
		return reply.code(404).send();
	}
}
app.get("/", (_req, reply) => sendShell("index.html", reply));
app.get("/room/:code", (_req, reply) => sendShell("index.html", reply));
app.get<{ Params: { "*": string } }>("/shell/*", (req, reply) => sendShell(req.params["*"], reply));

if (config.serveWeb) {
	registerFsApi(app, [config.webRoot, ...config.assetRoots]);
	await registerStatic(app, { webRoot: config.webRoot, assetRoots: config.assetRoots });
}

const gateway = attachGateway({ server: app.server, rooms, users, log: app.log, serverVersion });

const stop = async () => {
	gateway.close();
	await rooms.close();
	await app.close();
	process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

await rooms.init();
await app.listen({ port: config.port, host: config.host });
app.log.info({ maxRooms: config.maxRooms, serveWeb: config.serveWeb, webRoot: config.webRoot, modes: rooms.modes.map(m => m.id) }, "noname game server started");
