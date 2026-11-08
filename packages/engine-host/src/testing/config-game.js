import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";

const worker = new Worker(new URL("../host/worker.js", import.meta.url), {
	workerData: { preset: { game_speed: "vvfast" } },
	env: { ...process.env, NONAME_CONFIG_SELFTEST: "1" },
	stdout: true,
	stderr: true,
});
let banned;
let excluded;
let inspected = false;
const timer = setTimeout(() => finish(new Error("Config game timed out after 180s")), 180000);
let done = false;
async function finish(error) {
	if (done) return;
	done = true;
	clearTimeout(timer);
	await worker.terminate();
	if (error) {
		console.error(error);
		process.exitCode = 1;
	} else console.log("PASS: packs and 20 character bans reached engine; excluded pack adds no cards; full game finished");
}
worker.on("error", finish);
worker.on("exit", code => {
	if (!done) void finish(new Error(`Worker exited early: ${code}`));
});
worker.on("message", async message => {
	try {
		if (message.t === "booted") {
			const assets = message.assets;
			assert.ok(assets.characterPacks.length && assets.cardPacks.length);
			assert.equal(message.catalog.find(m => m.id === "identity").identityTable[2].length, 4);
			assert.ok(message.catalog.every(m => m.options.every(o => typeof o.frequent === "boolean")));
			banned = [...new Set(assets.characters.filter(c => c.pack === "standard").map(c => c.id))].slice(0, 20);
			assert.equal(banned.length, 20);
			excluded = assets.cardPacks.find(p => p.id !== "standard" && p.count > 0).id;
			worker.postMessage({ t: "configure", mode: "identity", config: { player_number: "4", characterPack: ["standard"], cardPack: ["standard"], banned, bannedcards: ["shandian"] } });
		} else if (message.t === "ready") worker.postMessage({ t: "begin" });
		else if (message.t === "log" && message.args[0] === "config-selftest") {
			const result = JSON.parse(message.args[1]);
			assert.deepEqual(result.config.banned, banned);
			assert.deepEqual(result.config.cardPack, ["standard"]);
			assert.deepEqual(result.config.characterPack, ["standard"]);
			assert.equal(result.chosen.length, 4);
			assert.ok(
				result.chosen.every(id => !banned.includes(id)),
				"banned character was chosen"
			);
			const expected = result.packCards.standard.filter(card => JSON.parse(card)[2] !== "shandian").sort();
			assert.deepEqual(result.pile.sort(), expected, "pile contains exactly the selected pack minus banned cards");
			const uniqueExcluded = result.packCards[excluded].filter(card => !result.packCards.standard.includes(card));
			assert.ok(uniqueExcluded.length > 0);
			assert.ok(
				uniqueExcluded.every(card => !result.pile.includes(card)),
				"excluded pack contributed cards"
			);
			inspected = true;
			console.log("config inspected", { banned: banned.length, excluded, pile: result.pile.length, chosen: result.chosen });
		} else if (message.t === "log" && /uncaughtException|unhandledRejection/.test(message.args[0])) throw new Error(message.args.join(" "));
		else if (message.t === "over") {
			assert.ok(inspected);
			await finish();
		}
	} catch (error) {
		await finish(error);
	}
});
