// Headless test client: a real noname client engine (connect mode) that answers every request with
// its local AI, without telling the host it is in auto mode (so the host's remote code path is exercised).
//
// Main thread -> bot: { t: "msg", data }   raw message string from the host
//                     { t: "drop" }        simulate a network drop (bot stops sending/receiving)
// Bot -> main thread: { t: "up", data }    raw message string for the host
//                     { t: "state", ... }  periodic status
//                     { t: "log", args }
import { parentPort, workerData } from "node:worker_threads";
import { bootEngine } from "../runtime/boot.js";

const { name = "bot", onlineID = null, preset = {} } = workerData ?? {};
const post = msg => parentPort.postMessage(msg);
const log = (...args) => post({ t: "log", args: args.map(a => (a instanceof Error ? a.stack : typeof a === "string" ? a : String(a))) });
process.on("unhandledRejection", e => log("unhandledRejection", e));
process.on("uncaughtException", e => log("uncaughtException", e));

let dropped = false;
const { lib, game, get, _status, ui } = await bootEngine({
	log,
	preset: { new_tutorial: true, mode: "connect", connect_nickname: name, ...preset },
	beforeBoot: ({ lib, game, ui }) => {
		ui.create.menu = () => {};
		game.reload = () => log("client reload requested");
	},
});

game.onlineID = onlineID;
game.ws = {
	send(str) {
		if (!dropped) post({ t: "up", data: str });
	},
	close() {},
};
game.ws.onmessage = lib.element.ws.onmessage;
_status.connectMode = true;

parentPort.on("message", m => {
	if (m.t === "msg" && !dropped) game.ws.onmessage({ data: m.data });
	else if (m.t === "drop") dropped = true;
});

// answer everything locally with AI, but never send "auto" to the host
setInterval(() => {
	_status.auto = true;
	post({
		t: "state",
		name,
		id: game.onlineID,
		phase: game.phaseNumber,
		round: game.roundNumber,
		over: !!_status.over,
		me: game.me?.name,
		identity: game.me?.identity,
		players: game.players?.length,
	});
}, 1000);
post({ t: "booted" });
