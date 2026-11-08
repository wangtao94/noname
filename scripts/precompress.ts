import fs from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createBrotliCompress, createGzip, constants } from "node:zlib";
import { pathToFileURL } from "node:url";

export async function precompress(root = "dist") {
	let count = 0;
	async function walk(dir: string) {
		for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
			const file = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (!["audio", "image"].includes(entry.name)) await walk(file);
			} else if (
				entry.isFile() &&
				/\.(js|mjs|css|json|html|svg|txt|wasm)$/.test(file) &&
				((await fs.stat(file)).size > 1024 || entry.name === "noname.js")
			) {
				await Promise.all([
					pipeline(
						createReadStream(file),
						createBrotliCompress({ params: { [constants.BROTLI_PARAM_QUALITY]: 5 } }),
						createWriteStream(file + ".br")
					),
					pipeline(createReadStream(file), createGzip(), createWriteStream(file + ".gz")),
				]);
				count++;
			}
		}
	}
	await walk(root);
	console.log(`Precompressed ${count} files`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
	await precompress(process.argv[2]);
