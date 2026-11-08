import { GlobalRegistrator } from "@happy-dom/global-registrator";
import path from "node:path";
import { fileURLToPath } from "node:url";
const coreRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../apps/core");
GlobalRegistrator.register({ url: "http://localhost/", width: 1280, height: 720, settings: { disableJavaScriptFileLoading: true, disableCSSFileLoading: true, disableIframePageLoading: true, navigator: { userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0 Safari/537.36 noname-server" } } });
const log = (...a) => console.log("[p0]", ...a);
globalThis.__NONAME_PRESET__ = { game_speed: process.env.P0_SPEED || "vvfast", new_tutorial: true };
const { installShims } = await import("./shims.js");
installShims(log);
await import("fake-indexeddb/auto");
const t0 = Date.now();
const { lib, game, get, _status, ui, ai } = await import("noname");
const { serverPreload } = await import("./preload.js");
await serverPreload({ lib, game, coreRoot, log });
localStorage.setItem("noname_0.9_directstart", "true");
localStorage.setItem("gplv3_noname_alerted", "true");
const { boot } = await import("@/init/index.js");
log("imported", Date.now() - t0, "ms");
setTimeout(() => { if (globalThis.__report) for (const [k, v] of globalThis.__report()) log("LIVE x10", v, k); log("TIMEOUT exit"); process.exit(2); }, Number(process.env.P0_TIMEOUT || 60000));
process.on("unhandledRejection", e => log("unhandledRejection", e?.stack ?? e));
const report = process.env.P0_TRACK ? (await import("./track.js")).installTracker(log) : null;
globalThis.__report = report;
await boot();
log("boot done", Date.now() - t0, "ms", "mode=", lib.config.mode, "players=", game.players?.length);
if (process.env.P0_SNAP) setTimeout(async () => { const v8 = await import("node:v8"); global.gc?.(); log("snapshot", v8.writeHeapSnapshot(process.env.P0_SNAP)); process.exit(0); }, Number(process.env.P0_SNAP_AT || 30000));
let namesLogged = false;
const autoTimer = setInterval(async () => {
	if (!namesLogged && game.phaseNumber > 0) {
		namesLogged = true;
		log("SEATS", game.players.map(p => `${p.name}|${p.name1}|${p.name2}|${p.identity}|cls=${p.classList.contains("unseen")}`).join("  "));
	}
	if (!_status.auto && ui.auto) ui.click.auto("forced");
	if (_status.over) {
		log("GAME OVER at", ((Date.now() - t0) / 1000).toFixed(1), "s", "rounds", game.roundNumber, "winner?", game.players.map(p => p.name + ":" + p.identity).join(","));
		if (global.gc) global.gc();
		if (report) for (const [k, v] of report()) log("LIVE x10", v, k);
		if (process.env.P0_SNAP_END) { const v8 = await import("node:v8"); log("snapshot", v8.writeHeapSnapshot(process.env.P0_SNAP_END)); }
		log("heapMB after gc", (process.memoryUsage().heapUsed / 1048576) | 0, "rssMB", (process.memoryUsage().rss / 1048576) | 0, "cpu", JSON.stringify(process.cpuUsage()));
		process.exit(0);
	}
}, 500);
setInterval(() => {
	const ev = _status.event;
	log("event", ev?.name, "step", ev?.step, "paused", _status.paused, "imchoosing", _status.imchoosing, "auto", _status.auto, "uiauto", !!ui.auto, "parent", ev?.parent?.name, ev?.parent?.parent?.name);
	log("dom nodes", document.getElementsByTagName("*").length, "timers?", process.getActiveResourcesInfo().length, "history", _status.globalHistory?.length, "log", ui.sidebar?.childElementCount);
	log("t+", ((Date.now() - t0) / 1000).toFixed(0), "s", "round", game.roundNumber, "alive", game.players?.length, "over", !!_status.over, "heapMB", (process.memoryUsage().heapUsed / 1048576) | 0);
}, 5000);
