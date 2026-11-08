// Node ESM loader hooks: resolve noname's browser-style specifiers to apps/core files.
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";

let CORE = "";
export async function initialize(data) {
	CORE = data.coreRoot;
}

function tryFile(p) {
	if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
	if (p.endsWith(".js") && fs.existsSync(p.slice(0, -3) + ".ts")) return p.slice(0, -3) + ".ts";
	if (p.endsWith(".js")) {
		const base = p.slice(0, -3);
		for (const ext of ["/index.js", "/index.ts"]) if (fs.existsSync(base + ext)) return base + ext;
	}
	for (const ext of [".js", ".ts", "/index.js", "/index.ts"]) {
		if (fs.existsSync(p + ext)) return p + ext;
	}
	return null;
}

// Resolve only inside the supplied root, including symlink targets.
export function rootedPath(root, name) {
	const base = path.resolve(root);
	const target = path.resolve(base, name.replace(/^\/+/, ""));
	const inside = (r, f) => f === r || f.startsWith(r + path.sep);
	if (!inside(base, target)) throw new Error(`Path escapes asset root: ${name}`);
	// Check the closest existing ancestor as well (missing files beneath symlinks).
	let ancestor = target;
	while (!fs.existsSync(ancestor) && ancestor !== base) ancestor = path.dirname(ancestor);
	if (fs.existsSync(base) && !inside(fs.realpathSync(base), fs.realpathSync(ancestor))) throw new Error(`Path escapes asset root: ${name}`);
	return target;
}

export function assetPath(coreRoot, name) {
	const relative = String(name).replace(/^\/+/, "").replace(/^\.\//, "");
	const core = rootedPath(coreRoot, relative);
	if (!fs.existsSync(core) && relative.startsWith("extension/") && process.env.NONAME_DATA_DIR) {
		return rootedPath(process.env.NONAME_DATA_DIR, relative);
	}
	return core;
}

export async function resolve(specifier, context, next) {
	if (process.env.HOOK_DEBUG) fs.appendFileSync("/tmp/claude-1000/hook.log", specifier + " " + CORE + "\n");
	const dataRoot = process.env.NONAME_DATA_DIR;
	if (dataRoot && specifier.startsWith(".") && context.parentURL?.startsWith("file:") && fileURLToPath(context.parentURL).startsWith(path.resolve(dataRoot) + path.sep)) {
		const target = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier);
		rootedPath(dataRoot, path.relative(path.resolve(dataRoot), target));
	}
	let target = null;
	if (specifier === "noname") target = path.join(CORE, "noname.js");
	else if (specifier.startsWith("@/")) target = rootedPath(CORE, "noname/" + specifier.slice(2));
	else if (specifier.startsWith("/extension/")) {
		const core = rootedPath(CORE, specifier);
		const f = tryFile(core);
		if (f) return { url: pathToFileURL(rootedPath(CORE, path.relative(CORE, f))).href, shortCircuit: true };
		target = assetPath(CORE, specifier);
	} else if (specifier.startsWith("/") && !specifier.startsWith(CORE) && !fs.existsSync(specifier)) target = rootedPath(CORE, specifier);
	else if (specifier === "vue/dist/vue.esm-browser.js") specifier = "vue";
	else if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL?.startsWith("file:")) {
		const abs = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier);
		if (!fs.existsSync(abs)) target = abs;
	}
	if (target) {
		const f = tryFile(target);
		if (f) {
			const root = process.env.NONAME_DATA_DIR && target.startsWith(path.resolve(process.env.NONAME_DATA_DIR) + path.sep) ? process.env.NONAME_DATA_DIR : CORE;
			rootedPath(root, path.relative(path.resolve(root), f));
			return { url: pathToFileURL(f).href, shortCircuit: true };
		}
	}
	if (context.parentURL?.startsWith("file:") && fileURLToPath(context.parentURL).startsWith(CORE) && !specifier.startsWith(".") && !specifier.startsWith("file:") && !specifier.startsWith("node:") && !specifier.startsWith("/")) {
		// bare imports from core: resolve relative to apps/core
		const r = await next(specifier, { ...context, parentURL: pathToFileURL(path.join(CORE, "noname.js")).href });
		if (r.format === "commonjs" || (r.url.endsWith(".js") && isCjs(fileURLToPath(r.url)))) {
			return { url: r.url + "?cjswrap", shortCircuit: true, format: "module" };
		}
		return r;
	}
	return next(specifier, context);
}

const ENV = JSON.stringify({ DEV: false, PROD: true, MODE: "production", SSR: true, BASE_URL: "/" });
function isCjs(file) {
	let dir = path.dirname(file);
	while (dir !== path.dirname(dir)) {
		const pj = path.join(dir, "package.json");
		if (fs.existsSync(pj)) {
			try {
				return JSON.parse(fs.readFileSync(pj, "utf8")).type !== "module";
			} catch {
				return true;
			}
		}
		dir = path.dirname(dir);
	}
	return true;
}

export async function load(url, context, next) {
	if (url.endsWith("?cjswrap")) {
		const file = fileURLToPath(url.slice(0, -"?cjswrap".length));
		const req = createRequire(file);
		const mod = req(file);
		const keys = mod && typeof mod === "object" || typeof mod === "function" ? Object.keys(mod).filter(k => /^[A-Za-z_$][\w$]*$/.test(k) && k !== "default") : [];
		const src = `import { createRequire } from "node:module"; const m = createRequire(${JSON.stringify(file)})(${JSON.stringify(file)}); export default m; ${keys.map(k => `export const ${k} = m[${JSON.stringify(k)}];`).join(" ")}`;
		return { format: "module", source: src, shortCircuit: true };
	}
	if (/\.(vue|css|less|scss)(\?.*)?$/.test(url)) {
		return { format: "module", source: "export default {};", shortCircuit: true };
	}
	const r = await next(url, context);
	if (url.startsWith("file:") && fileURLToPath(url).startsWith(CORE) && r.source) {
		let src = r.source.toString();
		let changed = false;
		if (src.includes("import.meta.env")) {
			src = src.replaceAll("import.meta.env", `(${ENV})`);
			changed = true;
		}
		if (src.includes("import.meta.glob")) {
			src = transformGlob(src, path.dirname(fileURLToPath(url)));
			changed = true;
		}
		if (changed) return { ...r, source: src };
	}
	return r;
}

// Minimal import.meta.glob(["./*.js", "!./x.js"], { eager: true }) support (single-dir patterns only).
function transformGlob(src, dir) {
	let n = 0;
	const imports = [];
	src = src.replace(/import\.meta\.glob\(\s*(\[[^\]]*\]|"[^"]*"|'[^']*')\s*(?:,\s*(\{[^}]*\}))?\s*\)/g, (_m, pats) => {
		const list = JSON.parse(pats.replaceAll("'", '"'));
		const arr = Array.isArray(list) ? list : [list];
		const pos = arr.filter(p => !p.startsWith("!"));
		const neg = arr.filter(p => p.startsWith("!")).map(p => p.slice(1));
		const files = new Set();
		for (const pat of pos) {
			const m = /^\.\/\*(\.\w+)$/.exec(pat);
			if (!m) throw new Error("unsupported glob " + pat);
			for (const f of fs.readdirSync(dir)) if (f.endsWith(m[1])) files.add("./" + f);
		}
		for (const ng of neg) files.delete(ng);
		const entries = [...files].sort().map(f => {
			const id = `__glob_${n++}`;
			imports.push(`import * as ${id} from ${JSON.stringify(f)};`);
			return `${JSON.stringify(f)}: ${id}`;
		});
		return `({${entries.join(",")}})`;
	});
	return imports.join("\n") + "\n" + src;
}
