// Run N engine instances concurrently, each in its own worker thread.
import { Worker } from "node:worker_threads";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const N = Number(process.env.P0_N || 3);
const t0 = Date.now();
let done = 0;
let peakRss = 0;
const iv = setInterval(() => {
	peakRss = Math.max(peakRss, process.memoryUsage().rss);
}, 500);
for (let i = 0; i < N; i++) {
	const w = new Worker(path.join(here, "p0.js"), { execArgv: ["--import", path.join(here, "runtime/register.js")], stdout: true, env: { ...process.env } });
	w.stdout.on("data", d => {
		for (const line of String(d).split("\n")) if (/GAME OVER|after gc|boot done|TIMEOUT/.test(line)) console.log(`[w${i}]`, line.slice(0, 140));
	});
	w.on("error", e => console.log(`[w${i}] error`, e));
	w.on("exit", code => {
		console.log(`[w${i}] exit`, code, ((Date.now() - t0) / 1000).toFixed(1), "s");
		if (++done === N) {
			clearInterval(iv);
			console.log("ALL DONE peak process RSS MB", (peakRss / 1048576) | 0);
			process.exit(0);
		}
	});
}
