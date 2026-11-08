// Static web serving. (Placeholder — to be replaced by the cache-aware implementation.)
import type { FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";

export interface StaticOptions {
	webRoot: string;
	assetRoots: string[];
}

export async function registerStatic(app: FastifyInstance, opts: StaticOptions): Promise<void> {
	await app.register(fastifyStatic, { root: [opts.webRoot, ...opts.assetRoots], prefix: "/", wildcard: true });
}
