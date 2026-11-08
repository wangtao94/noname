// Game Worker entry: one authoritative engine instance per game.
//
// Main thread -> worker:
//   { t: "open", id }              a client connected (id is stable per user, reused on reconnect)
//   { t: "msg", id, data }         raw message string from that client
//   { t: "close", id }             client disconnected
//   { t: "configure", mode, config } (pooled workers only) choose mode + room config, then boot into waiting
//   { t: "begin" }                 start the game (leave the waiting state)
// Worker -> main thread:
//   { t: "booted" }                engine booted (pooled workers: waiting for "configure")
//   { t: "ready" }                 mode loaded and waiting for players
//   { t: "joined", id }            a client finished the handshake (inited)
//   { t: "send", id, data }        raw message string for a client
//   { t: "kick", id }              host asked to close a client
//   { t: "config", config }        room config (lib.configOL) changed
//   { t: "over" }                  game finished
//   { t: "log", args }             diagnostics
import { parentPort, workerData } from "node:worker_threads";
import { injectPluginOptions, installPluginActivation } from "../plugins/index.js";
import { bootEngine } from "../runtime/boot.js";
import { installHostOverrides, defaultConfigOL, ensureCommonConnectOptions } from "./overrides.js";

const { roomId = "room", preset = {} } = workerData ?? {};
let { mode, config: configPatch = {} } = workerData ?? {};
/** pooled worker: mode/config arrive later via "configure" */
let resolveConfigure;
const configured = mode ? Promise.resolve() : new Promise(resolve => (resolveConfigure = resolve));
const post = msg => parentPort.postMessage(msg);
const log = (...args) => post({ t: "log", args: args.map(a => (typeof a === "string" ? a : a instanceof Error ? a.stack : safe(a))) });
function safe(v) {
	try {
		return JSON.stringify(v)?.slice(0, 500);
	} catch {
		return String(v);
	}
}
process.on("unhandledRejection", e => log("unhandledRejection", e));
process.on("uncaughtException", e => log("uncaughtException", e));

let engine;
const pending = [];
/** uid -> lobby profile ({ nickname, avatar }); overrides what the client reports */
const profiles = new Map();

engine = await bootEngine({
	log,
	preset: { new_tutorial: true, mode: "connect", directstartmode: "identity", ...preset },
	beforeBoot: engine => {
		const { lib, game, get, _status, ui } = engine;
		lib.node = {};
		game.onlineroom = true;
		game.roomId = roomId;
		game.ws = {
			send(str) {
				let msg;
				try {
					msg = JSON.parse(str);
				} catch {
					return;
				}
				if (msg[0] !== "server") return;
				const [, type, ...args] = msg;
				if (type === "send") post({ t: "send", id: args[0], data: args[1] });
				else if (type === "close") post({ t: "kick", id: args[0] });
				else if (type === "config") post({ t: "config", config: args[0] });
			},
			close() {},
		};
		// connect mode builds the whole connect menu UI before switching modes; the server never shows it.
		ui.create.menu = () => {};
		const switchMode = game.switchMode;
		game.switchMode = function (_name, configx) {
			// configx path of switchMode copies every key into lib.configOL (instead of reading local menu config)
			configured.then(() => {
				// Server plugins: activate after configOL is filled, before mode start content.
				installPluginActivation(engine, mode);
				return switchMode.call(this, mode, configx ?? { ...defaultConfigOL(lib, mode), ...configPatch, mode });
			});
		};
		installHostOverrides({ lib, game, get, _status, ui, profiles });
		ensureCommonConnectOptions(lib);
		// Server plugins: expose options through the existing connect catalog.
		injectPluginOptions(lib);
		const inited = lib.message.server.inited;
		lib.message.server.inited = function () {
			inited.call(this);
			post({ t: "joined", id: this.id });
		};
		const reinited = lib.message.server.reinited;
		lib.message.server.reinited = function () {
			reinited.call(this);
			post({ t: "joined", id: this.id, reconnect: true });
		};
		lib.onover.push(() => post({ t: "over" }));
	},
});

const { lib, game, _status } = engine;
post({ t: "booted", catalog: modeCatalog(lib) });

/** Connect-mode options of every mode that supports online play (drives the lobby's settings UI). */
function modeCatalog(lib) {
	const modes = [];
	for (const [id, info] of Object.entries(lib.mode)) {
		if (!info?.connect) continue;
		const options = [];
		for (const [key, cfg] of Object.entries(info.connect)) {
			if (key === "update" || !key.startsWith("connect_") || !cfg || typeof cfg !== "object" || !("init" in cfg)) continue;
			if (cfg.frequent === false && cfg.clear) continue;
			let item = cfg.item;
			if (typeof item === "function") {
				try {
					item = item();
				} catch {
					item = undefined;
				}
			}
			const plain = v => (typeof v === "string" ? v.replace(/<[^>]+>/g, "") : String(v));
			options.push({
				key: key.slice(8),
				name: plain(cfg.name ?? key),
				init: cfg.init,
				item: item && typeof item === "object" ? Object.fromEntries(Object.entries(item).map(([k, v]) => [k, plain(v)])) : undefined,
				input: cfg.input ? true : undefined,
				intro: typeof cfg.intro === "string" ? plain(cfg.intro) : undefined,
			});
		}
		modes.push({ id, name: lib.translate[id] || info.name || id, options });
	}
	return modes;
}

// wait until the mode reached waitForPlayer
const readyTimer = setInterval(() => {
	if (_status.waitingForPlayer && game.connectPlayers) {
		clearInterval(readyTimer);
		if (process.env.NONAME_EXTENSION_SELFTEST === "1") {
			if (!lib.character.e2etest_hero || !lib.skill.e2etest_vigor) throw new Error("fixture extension character/skill missing");
			log("extension-selftest", { character: "e2etest_hero", extensions: lib.config.extensions });
		}
		post({ t: "ready" });
		for (const m of pending.splice(0)) handle(m);
	}
}, 20);

function handle(m) {
	const c = lib.message.client;
	switch (m.t) {
		case "open":
			if (m.profile) profiles.set(m.id, m.profile);
			c.onconnection(m.id);
			break;
		case "msg":
			c.onmessage(m.id, m.data);
			break;
		case "close":
			c.onclose(m.id);
			break;
		case "begin":
			if (_status.waitingForPlayer) game.resume();
			break;
	}
}

parentPort.on("message", m => {
	if (m.t === "configure") {
		mode = m.mode;
		configPatch = m.config ?? {};
		resolveConfigure?.();
		return;
	}
	if (!_status.waitingForPlayer && !game.players?.length && m.t !== "close") {
		pending.push(m);
		return;
	}
	handle(m);
});
