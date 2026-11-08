// Game Worker entry: one authoritative engine instance per game.
//
// Main thread -> worker:
//   { t: "open", id }              a client connected (id is stable per user, reused on reconnect)
//   { t: "msg", id, data }         raw message string from that client
//   { t: "close", id }             client disconnected
//   { t: "begin" }                 start the game (leave the waiting state)
// Worker -> main thread:
//   { t: "ready" }                 engine booted and waiting for players
//   { t: "send", id, data }        raw message string for a client
//   { t: "kick", id }              host asked to close a client
//   { t: "config", config }        room config (lib.configOL) changed
//   { t: "over" }                  game finished
//   { t: "log", args }             diagnostics
import { parentPort, workerData } from "node:worker_threads";
import { bootEngine } from "../runtime/boot.js";
import { installHostOverrides, defaultConfigOL } from "./overrides.js";

const { roomId = "room", mode = "identity", config: configPatch = {}, preset = {} } = workerData ?? {};
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

engine = await bootEngine({
	log,
	preset: { new_tutorial: true, mode: "connect", directstartmode: mode, ...preset },
	beforeBoot: ({ lib, game, get, _status, ui }) => {
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
		game.switchMode = function (name, configx) {
			// configx path of switchMode copies every key into lib.configOL (instead of reading local menu config)
			return switchMode.call(this, name, configx ?? { ...defaultConfigOL(lib, name), ...configPatch, mode: name });
		};
		installHostOverrides({ lib, game, get, _status, ui });
		lib.onover.push(() => post({ t: "over" }));
	},
});

const { lib, game, _status } = engine;

// wait until the mode reached waitForPlayer
const readyTimer = setInterval(() => {
	if (_status.waitingForPlayer && game.connectPlayers) {
		clearInterval(readyTimer);
		post({ t: "ready" });
		for (const m of pending.splice(0)) handle(m);
	}
}, 20);

function handle(m) {
	const c = lib.message.client;
	switch (m.t) {
		case "open":
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
	if (!_status.waitingForPlayer && !game.players?.length && m.t !== "close") {
		pending.push(m);
		return;
	}
	handle(m);
});
