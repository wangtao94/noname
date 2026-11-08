// Real authoritative worker, no clients: all seats (including game.me) must use AI.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

// The fixture lives outside apps/core, so both module and JSON loads must use the data fallback.
const worker = new Worker(new URL("../host/worker.js", import.meta.url), {
	workerData: { mode: "identity", config: { player_number: "4", plugin_opening_hand_pick_enable: true, plugin_opening_hand_pick_n_fan: "3" }, preset: { game_speed: "vvfast", extensions: ["e2etest"], extension_e2etest_enable: true, extension_auto_import: false } },
	env: { ...process.env, NONAME_EXTENSION_SELFTEST: "1", NONAME_DATA_DIR: fileURLToPath(new URL("../../test/fixtures/", import.meta.url)) },
});
let selftests = 0;
let finished = false;
let failed = false;
const timer = setTimeout(() => fail(new Error("Extension game timed out after 180s")), 180000);
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
		if (message.t === "log" && message.args[0] === "extension-selftest") {
			const result = JSON.parse(message.args[1]);
			assert.equal(result.character, "e2etest_hero");
			assert.deepEqual(result.extensions, ["e2etest"]);
			selftests++;
			console.log("extension-selftest", result);
		} else if (message.t === "log" && /uncaughtException|unhandledRejection/.test(message.args[0])) {
			throw new Error(message.args.join(" "));
		} else if (message.t === "over") {
			assert.equal(selftests, 1, "extension inspected exactly once");
			finished = true;
			clearTimeout(timer);
			await worker.terminate();
			console.log("PASS: authoritative extension game finished");
		}
	} catch (error) { await fail(error); }
});
