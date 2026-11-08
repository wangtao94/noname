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

// Validate against the engine source and admin directory before any workers boot.
const coreRoot = path.resolve(here, "../../../apps/core");
const installed = [];
for (const name of config.extensions) {
	let found = false;
	for (const root of [coreRoot, config.dataDir]) {
		for (const suffix of ["js", "ts"]) {
			try {
				const base = await fs.realpath(root);
				const file = await fs.realpath(path.join(base, "extension", name, `extension.${suffix}`));
				if (file.startsWith(base + path.sep) && (await fs.stat(file)).isFile()) found = true;
			} catch { /* absent extension */ }
		}
	}
	if (found) installed.push(name);
	else app.log.warn({ extension: name }, "configured extension not found; disabled");
}
config.extensions = installed;
// Loader hooks and file adapters in workers read this variable.
process.env.NONAME_DATA_DIR = config.dataDir;

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
	registerFsApi(app, [config.webRoot, config.dataDir, ...config.assetRoots]);
	await registerStatic(app, { webRoot: config.webRoot, assetRoots: [config.dataDir, ...config.assetRoots] });
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
