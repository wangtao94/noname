// Server-side replacement for noname's platform preload (init/browser.js etc.).
// Read-only file access to apps/core; writes are kept in memory and discarded.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { assetPath, rootedPath } from "./hooks.js";
import { fileURLToPath } from "node:url";

export async function serverPreload({ lib, game, coreRoot, log }) {
	const { FileSystem, installLegacyFileSystemAPI } = await import("@/library/fs/index.js");
	const abs = p => assetPath(coreRoot, p);
	const overlay = new Map();
	const adapter = {
		async open() {
			throw new Error("open not supported on server");
		},
		async read(p) {
			if (overlay.has(p)) return overlay.get(p);
			return new Uint8Array(await fs.promises.readFile(abs(p)));
		},
		async write(p, data) {
			overlay.set(p, data);
		},
		async stat(p) {
			if (overlay.has(p)) return { type: "file" };
			try {
				const s = await fs.promises.stat(abs(p));
				return { type: s.isFile() ? "file" : s.isDirectory() ? "directory" : "other", size: s.size };
			} catch {
				return null;
			}
		},
		async list(p) {
			const ents = await fs.promises.readdir(abs(p), { withFileTypes: true });
			return ents.map(e => ({ name: e.name, type: e.isDirectory() ? "directory" : "file" }));
		},
		async createDir() {},
		async remove(p) {
			overlay.delete(p);
		},
	};
	const preset = { debug: true, show_splash: "off", mode: "identity", video: "0", ...(globalThis.__NONAME_PRESET__ || {}) };
	// Mode option defaults normally get written when the start menu UI is built; do it here instead.
	for (const [mode, info] of Object.entries(lib.mode)) {
		for (const group of [info.config, info.connect]) {
			if (!group || typeof group !== "object") continue;
			for (const [key, cfg] of Object.entries(group)) {
				if (!cfg || typeof cfg !== "object" || !("init" in cfg) || typeof cfg.init === "function") continue;
				const k = `${key}_mode_config_${mode}`;
				if (!(k in preset)) preset[k] = cfg.init;
			}
		}
	}
	overlay.set("noname.config.txt", new TextEncoder().encode(lib.init.encode(JSON.stringify({ config: preset, data: {} }))));
	const fsys = new FileSystem(adapter);
	lib.path = path.posix;
	lib.fs = fsys;
	installLegacyFileSystemAPI(game, fsys);
	game.export = () => {};
	game.exit = () => log("game.exit called");
	game.open = () => {};
	game.reload = () => log("game.reload called");
	game.showChangeLog = () => {};
	// lib.onfree holds deferred UI builders (config menu etc.); the server never shows them.
	lib.init.onfree = function () {
		if (lib.onfree) {
			clearTimeout(window.resetGameTimeout);
			delete window.resetGameTimeout;
			delete lib.onfree;
		}
	};

	const toFile = url => {
		let s = String(url);
		if (s.startsWith("file://")) {
			const file = fileURLToPath(s);
			const dataRoot = process.env.NONAME_DATA_DIR;
			if (dataRoot && file.startsWith(path.resolve(dataRoot) + path.sep)) return rootedPath(dataRoot, path.relative(path.resolve(dataRoot), file));
			return abs(path.relative(coreRoot, file));
		}
		if (s.startsWith("http://localhost/")) s = s.slice("http://localhost/".length);
		s = s.split("?")[0];
		return abs(s);
	};
	// classic <script> loading -> vm in global context
	lib.init.js = function (p, file, onLoad, onError) {
		if (p[p.length - 1] == "/") p = p.slice(0, -1);
		if (p == `${lib.assetURL}mode` && lib.config.all.stockmode.indexOf(file) == -1) {
			Promise.resolve(lib.init[`setMode_${file}`]()).then(onLoad);
			return;
		}
		if (Array.isArray(file)) {
			file.forEach(v => lib.init.js(p, v, onLoad, onError));
			return;
		}
		const src = file ? `${p}/${file}.js` : p;
		const f = toFile(src);
		const script = document.createElement("script");
		queueMicrotask(() => {
			try {
				const code = fs.readFileSync(f, "utf8");
				vm.runInThisContext(code, { filename: f });
				onLoad?.(new Event("load"));
			} catch (e) {
				log("lib.init.js failed", src, e.message);
				onError?.(e);
			}
		});
		return script;
	};
	lib.init.json = function (url, onload, onerror) {
		fs.promises
			.readFile(toFile(url), "utf8")
			.then(t => onload?.(JSON.parse(t)))
			.catch(e => onerror?.(e));
	};
	lib.init.req = function (str, onload, onerror) {
		const s = str.startsWith("local:") ? str.slice(6) : str;
		fs.promises
			.readFile(toFile(s), "utf8")
			.then(t => onload?.(t))
			.catch(e => onerror?.(e));
	};
	lib.init.css = function () {
		const style = document.createElement("link");
		queueMicrotask(() => style.dispatchEvent(new Event("load")));
		return style;
	};
}
