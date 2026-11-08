// Real authoritative worker, no clients: all seats (including game.me) must use AI.
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";

// Standard packs isolate plugin invariants from unrelated expansion skill/AI failures.
const worker = new Worker(new URL("../host/worker.js", import.meta.url), {
	workerData: { mode: "identity", config: { player_number: "4", plugin_opening_hand_pick_enable: true, plugin_opening_hand_pick_n_fan: "3" }, preset: { game_speed: "vvfast" } },
	env: { ...process.env, NONAME_PLUGIN_SELFTEST: "1" },
});
let selftests = 0;
let finished = false;
let failed = false;
const timer = setTimeout(() => fail(new Error("Plugin game timed out after 180s")), 180000);
async function fail(error) {
	if (failed || finished) return;
	failed = true;
	console.error(error);
	clearTimeout(timer);
	await worker.terminate();
	process.exitCode = 1;
}
worker.on("error", fail);
worker.on("exit", code => { if (!finished && !failed) void fail(new Error(`Worker exited before game over (${code})`)); });
worker.on("message", async message => {
	try {
		if (message.t === "ready") worker.postMessage({ t: "begin" });
		if (message.t === "log" && message.args[0] === "selftest") {
			const result = JSON.parse(message.args[1]);
			assert.equal(result.before, result.after, "total cards conserved");
			assert.equal(result.unique, result.after, "no duplicated card objects");
			assert.equal(result.conserved, true, "same cards before and after");
			assert.equal(result.hands.length, 4);
			for (const hand of result.hands) assert.equal(hand.actual, hand.expected, "normal opening hand count");
			assert.ok(result.groups.some(group => group.identity === "fan" && group.n === 3), "explicit fan option active");
			selftests++;
			console.log("selftest", result);
		} else if (message.t === "log" && /uncaughtException|unhandledRejection/.test(message.args[0])) {
			throw new Error(message.args.join(" "));
		} else if (message.t === "over") {
			assert.equal(selftests, 1, "opening deal inspected exactly once");
			finished = true;
			clearTimeout(timer);
			await worker.terminate();
			console.log("PASS: authoritative plugin game finished");
		}
	} catch (error) { await fail(error); }
});
