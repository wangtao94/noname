// Read-only implementation of the file API the browser client expects (same contract as packages/fs):
// GET /checkFile /checkDir /readFile /readFileAsText /getFileList -> { success, code, data | errorMsg }
// Write endpoints answer with a failure: the hosted web client is read-only.
import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";

const ok = (data?: unknown) => ({ success: true, code: 200, data });
const failed = (code: number, errorMsg: string) => ({ success: false, code, errorMsg });

export function registerFsApi(app: FastifyInstance, roots: string[]) {
	const resolved = roots.map(r => path.resolve(r));

	/** first existing path under any root; throws on traversal */
	async function locate(rel: unknown): Promise<{ full: string; stat: import("node:fs").Stats } | null> {
		if (typeof rel !== "string") throw new Error("缺少路径参数");
		const clean = rel.replace(/^\/+/, "");
		for (const root of resolved) {
			const full = path.resolve(root, clean);
			if (full !== root && !full.startsWith(root + path.sep)) throw new Error("只能访问游戏目录下的资源");
			try {
				return { full, stat: await fs.stat(full) };
			} catch {
				/* try next root */
			}
		}
		return null;
	}

	const handle =
		(fn: (q: Record<string, unknown>) => Promise<unknown>) =>
		async (req: { query: unknown }, reply: { header: (k: string, v: string) => unknown }) => {
			reply.header("Cache-Control", "no-cache");
			try {
				return ok(await fn((req.query ?? {}) as Record<string, unknown>));
			} catch (e) {
				return failed(400, String((e as Error).message ?? e));
			}
		};

	const kind = async (q: unknown) => {
		const found = await locate(q);
		if (!found) return {};
		return found.stat.isFile() ? "file" : "directory";
	};

	app.get("/checkFile", handle(q => kind(q.fileName)));
	app.get("/checkDir", handle(q => kind(q.dir)));
	app.get(
		"/readFile",
		handle(async q => {
			const found = await locate(q.fileName);
			if (!found?.stat.isFile()) throw new Error("文件不存在");
			return [...new Uint8Array(await fs.readFile(found.full))];
		})
	);
	app.get(
		"/readFileAsText",
		handle(async q => {
			const found = await locate(q.fileName);
			if (!found?.stat.isFile()) throw new Error("文件不存在");
			return fs.readFile(found.full, "utf8");
		})
	);
	app.get(
		"/getFileList",
		handle(async q => {
			if (typeof q.dir !== "string") throw new Error("缺少路径参数");
			const files = new Set<string>();
			const folders = new Set<string>();
			let any = false;
			for (const root of resolved) {
				const full = path.resolve(root, q.dir.replace(/^\/+/, ""));
				if (full !== root && !full.startsWith(root + path.sep)) throw new Error("只能访问游戏目录下的资源");
				let entries;
				try {
					entries = await fs.readdir(full, { withFileTypes: true });
				} catch {
					continue;
				}
				any = true;
				for (const e of entries) {
					if (e.name.startsWith(".") || e.name.startsWith("_")) continue;
					(e.isDirectory() ? folders : files).add(e.name);
				}
			}
			if (!any) throw new Error("路径不是文件夹");
			return { folders: [...folders], files: [...files] };
		})
	);
	const readOnly = async () => failed(403, "服务器上的游戏文件为只读");
	for (const p of ["/writeFile", "/removeFile", "/createDir", "/removeDir"]) {
		app.get(p, readOnly);
		app.post(p, readOnly);
	}
}
