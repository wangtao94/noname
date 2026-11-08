import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export async function buildAssetManifest(root = "dist", extras: string[] = []) {
	const entries = new Map<string, string>();
	async function walk(dir: string, prefix = "") {
		for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
			const name = prefix + entry.name;
			if (name === "docs" || name.startsWith("docs/")) continue;
			if (entry.isDirectory()) await walk(path.join(dir, entry.name), name + "/");
			else if (
				entry.isFile() &&
				!["index.html", "service-worker.js", "asset-manifest.json"].includes(entry.name) &&
				!/\.(map|br|gz)$/.test(name) &&
				!entries.has(name)
			) {
				const hash = createHash("sha256");
				for await (const chunk of createReadStream(path.join(dir, entry.name))) hash.update(chunk);
				entries.set(name, hash.digest("hex").slice(0, 16));
			}
		}
	}
	await walk(root);
	for (const extra of extras) {
		const split = extra.lastIndexOf(":");
		if (split < 1) throw new Error("Expected --extra source:dir,dir");
		for (const dir of extra.slice(split + 1).split(",")) {
			if (!dir || dir.includes("..") || path.isAbsolute(dir)) throw new Error("Invalid extra directory");
			await walk(path.join(extra.slice(0, split), dir), dir + "/");
		}
	}
	const files = Object.fromEntries([...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
	const version = createHash("sha256").update(JSON.stringify(files)).digest("hex").slice(0, 16);
	await fs.writeFile(path.join(root, "asset-manifest.json"), JSON.stringify({ version, files }) + "\n");
	console.log(`Asset manifest: ${entries.size} files, version ${version}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	let root = "dist";
	const extras: string[] = [];
	for (let i = 2; i < process.argv.length; i++) {
		if (process.argv[i] === "--root") root = process.argv[++i];
		else if (process.argv[i] === "--extra") extras.push(process.argv[++i]);
		else throw new Error(`Unknown argument: ${process.argv[i]}`);
	}
	await buildAssetManifest(root, extras);
}
