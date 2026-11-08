import type { FastifyInstance } from "fastify";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";

export interface StaticOptions {
	webRoot: string;
	assetRoots: string[];
}
const types: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".wasm": "application/wasm",
	".txt": "text/plain; charset=utf-8",
	".svg": "image/svg+xml",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".png": "image/png",
	".gif": "image/gif",
	".webp": "image/webp",
	".avif": "image/avif",
	".ico": "image/x-icon",
	".mp3": "audio/mpeg",
	".ogg": "audio/ogg",
	".wav": "audio/wav",
	".m4a": "audio/mp4",
	".mp4": "video/mp4",
	".webm": "video/webm",
	".woff2": "font/woff2",
	".woff": "font/woff",
	".ttf": "font/ttf",
	".otf": "font/otf",
	".pdf": "application/pdf",
};
function inside(root: string, file: string) {
	const relative = path.relative(root, file);
	return (
		relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative))
	);
}
async function resolveFile(root: string, name: string) {
	try {
		const base = await realpath(root);
		let file = path.resolve(base, name);
		if (!inside(base, file)) return;
		file = await realpath(file);
		if (!inside(base, file)) return;
		if ((await stat(file)).isDirectory()) file = await realpath(path.join(file, "index.html"));
		if (!inside(base, file)) return;
		const info = await stat(file);
		if (info.isFile()) return { file, info, base };
	} catch (error) {
		if (!["ENOENT", "ENOTDIR", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
	}
}
function encodings(header: string) {
	const values = new Map<string, number>();
	for (const part of header.toLowerCase().split(",")) {
		const [name, ...params] = part.trim().split(";");
		const q = params.find(p => p.trim().startsWith("q="));
		const quality = q ? Number(q.trim().slice(2)) : 1;
		values.set(name, Number.isFinite(quality) && quality >= 0 && quality <= 1 ? quality : 0);
	}
	return ["br", "gzip"]
		.map(name => ({ name, q: values.get(name) ?? values.get("*") ?? 0 }))
		.filter(e => e.q > 0)
		.sort((a, b) => b.q - a.q);
}

export async function registerStatic(app: FastifyInstance, opts: StaticOptions): Promise<void> {
	app.route({
		method: ["GET", "HEAD"],
		url: "/*",
		handler: async (request, reply) => {
			let name: string;
			try {
				name = decodeURIComponent((request.raw.url ?? "/").split("?")[0]).replace(/^\//, "");
			} catch {
				return reply.code(400).send();
			}
			if (name.includes("\0") || name.includes("\\") || name.split("/").some(p => p === ".."))
				return reply.code(403).send();
			let found: Awaited<ReturnType<typeof resolveFile>>;
			for (const root of [opts.webRoot, ...opts.assetRoots]) {
				found = await resolveFile(root, name);
				if (found) break;
			}
			if (!found) return reply.code(404).send();
			const original = found.file;
			reply.header("Vary", "Accept-Encoding");
			// Ranges use the identity representation, so offsets always refer to the original media.
			if (!request.headers.range) {
				for (const encoding of encodings(request.headers["accept-encoding"] ?? "")) {
					const compressed = await resolveFile(
						found.base,
						path.relative(found.base, original) + (encoding.name === "br" ? ".br" : ".gz")
					);
					if (compressed) {
						found = compressed;
						reply.header("Content-Encoding", encoding.name);
						break;
					}
				}
			}
			const { file, info } = found;
			const etag = `"${info.size.toString(16)}-${info.mtimeMs.toString(16)}-${file === original ? "id" : path.extname(file).slice(1)}"`;
			const noCache = /\.(html|js|mjs|css|json|ts|wasm|map|txt)$/i.test(original);
			reply.headers({
				"Cache-Control": noCache ? "no-cache" : "public, max-age=3600, stale-while-revalidate=86400",
				ETag: etag,
				"Last-Modified": info.mtime.toUTCString(),
				"Accept-Ranges": "bytes",
				"Content-Type": types[path.extname(original).toLowerCase()] ?? "application/octet-stream",
			});
			const inm = request.headers["if-none-match"];
			const ims = request.headers["if-modified-since"];
			if (
				inm
					? inm.split(",").some(tag => tag.trim() === "*" || tag.trim().replace(/^W\//, "") === etag)
					: ims && Math.floor(info.mtimeMs / 1000) * 1000 <= Date.parse(ims)
			)
				return reply.code(304).send();
			let start = 0,
				end = info.size - 1;
			const range = request.headers.range;
			const ifRange = request.headers["if-range"];
			if (
				range &&
				(!ifRange ||
					(typeof ifRange === "string" &&
						(ifRange === etag || Date.parse(ifRange) >= Math.floor(info.mtimeMs / 1000) * 1000)))
			) {
				const match = /^bytes=(\d*)-(\d*)$/.exec(range);
				if (match && (match[1] || match[2])) {
					start = match[1] ? Number(match[1]) : Math.max(0, info.size - Number(match[2]));
					end = match[1] && match[2] ? Math.min(end, Number(match[2])) : end;
					if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= info.size)
						return reply.header("Content-Range", `bytes */${info.size}`).code(416).send();
					reply.code(206).header("Content-Range", `bytes ${start}-${end}/${info.size}`);
				}
			}
			reply.header("Content-Length", Math.max(0, end - start + 1));
			if (request.method === "HEAD" || info.size === 0) return reply.send();
			return reply.send(createReadStream(file, { start, end }));
		},
	});
}
