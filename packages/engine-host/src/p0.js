// P0: run one 8-player AI identity game headless and report time/memory.
import { bootEngine } from "./runtime/boot.js";
const log = (...a) => console.log("[p0]", ...a);
const t0 = Date.now();
setTimeout(() => (log("TIMEOUT exit"), process.exit(2)), Number(process.env.P0_TIMEOUT || 120000));
process.on("unhandledRejection", e => log("unhandledRejection", e?.stack ?? e));
const { game, _status, ui } = await bootEngine({ preset: { game_speed: process.env.P0_SPEED || "vvfast", new_tutorial: true }, log });
log("boot done", Date.now() - t0, "ms");
setInterval(() => {
	if (!_status.auto && ui.auto) ui.click.auto("forced");
	if (_status.over) {
		global.gc?.();
		const m = process.memoryUsage();
		log("GAME OVER at", ((Date.now() - t0) / 1000).toFixed(1), "s rounds", game.roundNumber, "heapMB", (m.heapUsed / 1048576) | 0, "rssMB", (m.rss / 1048576) | 0);
		process.exit(0);
	}
}, 500);
