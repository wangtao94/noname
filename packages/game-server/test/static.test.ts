import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { brotliCompressSync, gzipSync, brotliDecompressSync, gunzipSync } from "node:zlib";
import Fastify from "fastify";
import { registerStatic } from "../src/static/index.ts";

test("static serving", async t => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "noname-static-"));
	const webRoot = path.join(dir, "web"),
		assets = path.join(dir, "assets");
	await fs.mkdir(path.join(webRoot, "nested"), { recursive: true });
	await fs.mkdir(path.join(webRoot, "empty"));
	await fs.mkdir(assets);
	const js = "export const value = 42;\n".repeat(100);
	const codeExtensions = ["html", "js", "mjs", "css", "json", "ts", "wasm", "map", "txt"];
	const mediaExtensions = ["mp3", "ogg", "webp", "woff2", "bin"];
	await Promise.all(
		[...codeExtensions, ...mediaExtensions].map(ext => fs.writeFile(path.join(webRoot, `policy.${ext}`), "fixture"))
	);
	await Promise.all(
		Object.entries({
			"index.html": "home",
			"nested/index.html": "nested",
			"service-worker.js": "sw",
			"asset-manifest.json": "{}",
			"noname.js": js,
			"noname.js.br": brotliCompressSync(js),
			"noname.js.gz": gzipSync(js),
			"same.txt": "web",
		}).map(([name, data]) => fs.writeFile(path.join(webRoot, name), data))
	);
	await Promise.all([
		fs.writeFile(path.join(assets, "song.mp3"), "0123456789"),
		fs.writeFile(path.join(assets, "same.txt"), "asset"),
		fs.writeFile(path.join(assets, "photo.webp"), "image"),
		fs.writeFile(path.join(dir, "secret.txt"), "secret"),
		fs.symlink(path.join(dir, "secret.txt"), path.join(webRoot, "escape.txt")),
	]);
	const app = Fastify();
	await registerStatic(app, { webRoot, assetRoots: [assets] });
	t.after(async () => {
		await app.close();
		await fs.rm(dir, { recursive: true, force: true });
	});
	await t.test("cache headers and directory handling", async () => {
		for (const url of ["/", "/index.html", "/service-worker.js", "/asset-manifest.json", "/nested/"]) {
			const r = await app.inject(url);
			assert.equal(r.statusCode, 200);
			assert.equal(r.headers["cache-control"], "no-cache");
		}
		for (const ext of codeExtensions) {
			const response = await app.inject(`/policy.${ext}`);
			assert.equal(response.statusCode, 200);
			assert.equal(response.headers["cache-control"], "no-cache", ext);
			const conditional = await app.inject({
				url: `/policy.${ext}`,
				headers: { "if-none-match": String(response.headers.etag) },
			});
			assert.equal(conditional.statusCode, 304, ext);
		}
		for (const ext of mediaExtensions) {
			const response = await app.inject(`/policy.${ext}`);
			assert.equal(response.statusCode, 200);
			assert.equal(response.headers["cache-control"], "public, max-age=3600, stale-while-revalidate=86400", ext);
		}
		const r = await app.inject("/noname.js?v=1");
		assert.equal(r.headers["cache-control"], "no-cache");
		assert.match(String(r.headers.etag), /^".+"$/);
		assert.ok(r.headers["last-modified"]);
		for (const url of ["/empty/", "/unknown"]) assert.equal((await app.inject(url)).statusCode, 404);
	});
	await t.test("conditional GET and HEAD", async () => {
		const r = await app.inject("/noname.js");
		for (const headers of [
			{ "if-none-match": String(r.headers.etag) },
			{ "if-none-match": `W/${r.headers.etag}, "other"` },
			{ "if-modified-since": String(r.headers["last-modified"]) },
		])
			assert.equal((await app.inject({ url: "/noname.js", headers })).statusCode, 304);
		assert.equal(
			(
				await app.inject({
					url: "/noname.js",
					headers: {
						"if-none-match": '"different"',
						"if-modified-since": String(r.headers["last-modified"]),
					},
				})
			).statusCode,
			200
		);
		const head = await app.inject({ method: "HEAD", url: "/noname.js" });
		assert.equal(head.body, "");
		assert.equal(Number(head.headers["content-length"]), Buffer.byteLength(js));
	});
	await t.test("range media and invalid ranges", async () => {
		for (const [range, body, contentRange] of [
			["bytes=2-5", "2345", "bytes 2-5/10"],
			["bytes=-3", "789", "bytes 7-9/10"],
			["bytes=8-", "89", "bytes 8-9/10"],
		]) {
			const r = await app.inject({ url: "/song.mp3", headers: { range } });
			assert.equal(r.statusCode, 206);
			assert.equal(r.body, body);
			assert.equal(r.headers["content-range"], contentRange);
			assert.equal(r.headers["content-type"], "audio/mpeg");
		}
		assert.equal((await app.inject({ url: "/song.mp3", headers: { range: "bytes=20-" } })).statusCode, 416);
		assert.equal(
			(await app.inject({ url: "/song.mp3", headers: { range: "bytes=1-2", "if-range": '"old"' } })).statusCode,
			200
		);
	});
	await t.test("br/gzip negotiation and representation validators", async () => {
		for (const [accept, encoding] of [
			["gzip, br", "br"],
			["br;q=0,gzip", "gzip"],
			["br;q=0.3,gzip;q=0.9", "gzip"],
			["*", "br"],
		]) {
			const r = await app.inject({ url: "/noname.js", headers: { "accept-encoding": accept } });
			assert.equal(r.headers["content-encoding"], encoding);
			assert.equal(r.headers.vary, "Accept-Encoding");
			assert.equal(r.headers["cache-control"], "no-cache");
			assert.equal(
				(encoding === "br" ? brotliDecompressSync(r.rawPayload) : gunzipSync(r.rawPayload)).toString(),
				js
			);
			assert.match(String(r.headers["content-type"]), /javascript/);
			assert.equal(
				(await app.inject({ url: "/noname.js", headers: { "if-none-match": String(r.headers.etag) } }))
					.statusCode,
				200
			);
		}
		assert.equal(
			(await app.inject({ url: "/noname.js", headers: { "accept-encoding": "br;q=0,gzip;q=0" } })).headers[
				"content-encoding"
			],
			undefined
		);
	});
	await t.test("fallback, precedence, MIME and traversal", async () => {
		assert.equal((await app.inject("/same.txt")).body, "web");
		assert.equal((await app.inject("/photo.webp")).headers["content-type"], "image/webp");
		for (const url of ["/%2e%2e/secret.txt", "/%2e%2e%2fsecret.txt", "/escape.txt", "/..%5csecret.txt"])
			assert.ok([400, 403, 404].includes((await app.inject(url)).statusCode), url);
	});
});
