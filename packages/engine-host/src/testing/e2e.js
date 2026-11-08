// End-to-end harness: one host worker + N headless bot clients, routed through an in-process relay.
// Usage: node --import ./src/runtime/register.js ./src/testing/e2e.js
//   E2E_BOTS=3 E2E_SEATS=4 E2E_TIMEOUT=300000 E2E_DROP=1 (drop+reconnect bot #1 mid-game)
import { Worker } from "node:worker_threads";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const register = path.join(here, "../runtime/register.js");
const BOTS = Number(process.env.E2E_BOTS || 3);
const SEATS = Number(process.env.E2E_SEATS || 4);
const TIMEOUT = Number(process.env.E2E_TIMEOUT || 300000);
const DROP = process.env.E2E_DROP === "1";
const speed = process.env.E2E_SPEED || "vvfast";
const t0 = Date.now();
const ts = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6);
const say = (...a) => console.log(ts(), ...a);
const verbose = process.env.E2E_VERBOSE === "1";

const spawn = (file, workerData) => new Worker(path.join(here, file), { execArgv: ["--import", register], workerData });

const host = spawn("../host/worker.js", { roomId: "test", mode: "identity", config: { player_number: String(SEATS), choose_timeout: "30" }, preset: { game_speed: speed } });
const bots = new Map();
let hostReady = false;
let hostOver = false;
const stats = { toClient: 0, toHost: 0, bytesToClient: 0 };

host.on("message", m => {
	if (m.t === "log") {
		if (verbose || /Error|unhandled|uncaught/.test(m.args.join(" "))) say("[host]", m.args.join(" ").slice(0, 600));
	} else if (m.t === "ready") {
		hostReady = true;
		say("host ready");
		for (const b of bots.values()) if (b.booted && !b.opened) openBot(b);
	} else if (m.t === "send") {
		stats.toClient++;
		stats.bytesToClient += m.data.length;
		const b = bots.get(m.id);
		if (b && !b.dropped) b.worker.postMessage({ t: "msg", data: m.data });
	} else if (m.t === "over") {
		hostOver = true;
		say("host: game over");
	} else if (m.t === "config") {
		if (verbose) say("host config", JSON.stringify(m.config).slice(0, 200));
	} else if (m.t === "kick") {
		say("host kicked", m.id);
	}
});
host.on("error", e => say("[host] worker error", e));

function openBot(b) {
	b.opened = true;
	host.postMessage({ t: "open", id: b.id });
}

function startBot(i, onlineID = null) {
	const id = `u${i}`;
	const worker = spawn("bot-client.js", { name: `bot${i}`, onlineID, preset: { game_speed: speed } });
	const b = { id, i, worker, booted: false, opened: false, dropped: false, state: null };
	bots.set(id, b);
	worker.on("message", m => {
		if (m.t === "booted") {
			b.booted = true;
			if (hostReady) openBot(b);
		} else if (m.t === "up") {
			stats.toHost++;
			if (!b.dropped) host.postMessage({ t: "msg", id, data: m.data });
		} else if (m.t === "state") {
			b.state = m;
		} else if (m.t === "log") {
			if (verbose || /Error|unhandled|uncaught/.test(m.args.join(" "))) say(`[bot${i}]`, m.args.join(" ").slice(0, 600));
		}
	});
	worker.on("error", e => say(`[bot${i}] worker error`, e));
	return b;
}

for (let i = 1; i <= BOTS; i++) startBot(i);

// begin once every bot finished the handshake (state reports an onlineID)
const beginTimer = setInterval(() => {
	const all = [...bots.values()];
	if (hostReady && all.every(b => b.state?.id)) {
		clearInterval(beginTimer);
		say("all bots joined:", all.map(b => b.state.id).join(","), "-> begin");
		host.postMessage({ t: "begin" });
	}
}, 200);

let dropDone = false;
const statusTimer = setInterval(async () => {
	const all = [...bots.values()];
	const line = all.map(b => `${b.id}:${b.state?.me ?? "-"}/${b.state?.identity ?? "-"} r${b.state?.round ?? 0}${b.state?.over ? " OVER" : ""}${b.dropped ? " DROPPED" : ""}`).join("  ");
	say("status", line, `msgs h->c ${stats.toClient} (${(stats.bytesToClient / 1024) | 0}KB) c->h ${stats.toHost}`);
	if (DROP && !dropDone && all[0]?.state?.round >= 2) {
		dropDone = true;
		const b = all[0];
		say(`DROP ${b.id}`);
		b.dropped = true;
		b.worker.postMessage({ t: "drop" });
		host.postMessage({ t: "close", id: b.id });
		const savedId = b.state.id;
		setTimeout(async () => {
			await b.worker.terminate();
			say(`RECONNECT ${b.id} as fresh client with onlineID ${savedId}`);
			const nb = startBot(b.i, savedId);
			nb.reconnect = true;
		}, 3000);
	}
	const over = hostOver && all.every(b => b.state?.over);
	if (over) {
		clearInterval(statusTimer);
		say("E2E PASS: game finished on host and all clients");
		process.exit(0);
	}
}, 3000);

setTimeout(() => {
	say("E2E FAIL: timeout");
	process.exit(1);
}, TIMEOUT);
