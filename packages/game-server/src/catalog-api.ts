import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { RoomManager } from "./rooms/room-manager.ts";

export function registerCatalogApi(app: FastifyInstance, rooms: RoomManager) {
	for (const kind of ["characters", "cards"] as const) {
		let cached: unknown;
		let body = "";
		let etag = "";
		app.get(`/api/catalog/${kind}`, (req, reply) => {
			if (cached !== rooms[kind]) {
				cached = rooms[kind];
				body = JSON.stringify(cached);
				etag = `"${createHash("sha256").update(body).digest("hex")}"`;
			}
			reply.header("Cache-Control", "no-cache").header("ETag", etag);
			if (req.headers["if-none-match"] === etag) return reply.code(304).send();
			return reply.type("application/json; charset=utf-8").send(body);
		});
	}
}
