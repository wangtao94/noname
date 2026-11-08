// Runtime configuration from environment variables. Every option has a working default.
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function str(name: string, def: string): string {
	const v = process.env[name];
	return v === undefined || v === "" ? def : v;
}

function bool(name: string, def: boolean): boolean {
	const v = process.env[name];
	if (v === undefined || v === "") return def;
	return /^(1|true|yes|on)$/i.test(v);
}

function int(name: string, def: number): number {
	const v = process.env[name];
	if (v === undefined || v === "") return def;
	const n = Number.parseInt(v, 10);
	if (!Number.isFinite(n)) throw new Error(`${name} must be an integer, got "${v}"`);
	return n;
}

/** Durations: "60s", "10m", "2h", "500ms" or a bare number of seconds. */
export function parseDuration(v: string): number {
	const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(v.trim());
	if (!m) throw new Error(`invalid duration "${v}"`);
	const n = Number(m[1]);
	const unit = m[2] ?? "s";
	return Math.round(n * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[unit]!);
}

function duration(name: string, def: string): number {
	try {
		return parseDuration(str(name, def));
	} catch (e) {
		throw new Error(`${name}: ${(e as Error).message}`);
	}
}

export interface ServerConfig {
	port: number;
	host: string;
	serveWeb: boolean;
	/** built web client (pnpm build output) */
	webRoot: string;
	/** extra roots searched for static assets (audio/image/...) when not present in webRoot */
	assetRoots: string[];
	dataDir: string;
	/** Server-admin selected extensions, shared by workers and browser clients. */
	extensions: string[];
	reconnectGraceMs: number;
	roomIdleTtlMs: number;
	/** 0 = derive from available memory */
	maxRooms: number;
	trustProxy: boolean;
	logLevel: string;
	/** default game speed for server-hosted games */
	gameSpeed: string;
}

export function loadConfig(): ServerConfig {
	const maxRoomsEnv = int("NONAME_MAX_ROOMS", 0);
	return {
		port: int("PORT", 8080),
		host: str("HOST", "0.0.0.0"),
		serveWeb: bool("NONAME_SERVE_WEB", true),
		webRoot: path.resolve(str("NONAME_WEB_ROOT", path.join(repoRoot, "dist"))),
		assetRoots: str("NONAME_ASSET_ROOTS", path.join(repoRoot, "apps/core"))
			.split(path.delimiter)
			.filter(Boolean)
			.map(p => path.resolve(p)),
		dataDir: path.resolve(str("NONAME_DATA_DIR", path.join(repoRoot, ".data"))),
		extensions: [...new Set(str("NONAME_EXTENSIONS", "").split(",").map(n => n.trim()).filter(Boolean))].map(n => {
			if (n === "." || n === ".." || /[\\/\0]/.test(n)) throw new Error(`invalid NONAME_EXTENSIONS name "${n}"`);
			return n;
		}),
		reconnectGraceMs: duration("NONAME_RECONNECT_GRACE", "60s"),
		roomIdleTtlMs: duration("NONAME_ROOM_IDLE_TTL", "10m"),
		maxRooms: maxRoomsEnv > 0 ? maxRoomsEnv : autoMaxRooms(),
		trustProxy: bool("NONAME_TRUST_PROXY", false),
		logLevel: str("NONAME_LOG_LEVEL", "info"),
		gameSpeed: str("NONAME_GAME_SPEED", "mid"),
	};
}

/** ~700 MB per running game (measured in P0), keep 1 GB for the process itself. */
function autoMaxRooms(): number {
	const perGame = 700 * 1024 * 1024;
	return Math.max(1, Math.floor((os.totalmem() - 1024 * 1024 * 1024) / perGame));
}
