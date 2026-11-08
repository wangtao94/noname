// noname game server entry.
import Fastify from "fastify";
import { loadConfig } from "./config.ts";
import { registerStatic } from "./static/index.ts";

const config = loadConfig();
const app = Fastify({ logger: { level: config.logLevel }, trustProxy: config.trustProxy });

app.get("/healthz", async () => ({ ok: true }));

if (config.serveWeb) {
	await registerStatic(app, { webRoot: config.webRoot, assetRoots: config.assetRoots });
}

const stop = async () => {
	await app.close();
	process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

await app.listen({ port: config.port, host: config.host });
app.log.info({ maxRooms: config.maxRooms, serveWeb: config.serveWeb, webRoot: config.webRoot }, "noname game server started");
