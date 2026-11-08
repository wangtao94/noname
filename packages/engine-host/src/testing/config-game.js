import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";

import { beginnerPreset } from "../../../game-server/src/rooms/presets.ts";

async function run(beginner) {
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
	let resolveDone, rejectDone;
	const completed = new Promise((resolve, reject) => {
		resolveDone = resolve;
		rejectDone = reject;
	});
	async function finish(error) {
		if (done) return;
		done = true;
		clearTimeout(timer);
		await worker.terminate();
		if (error) {
			console.error(error);
			rejectDone(error);
		} else {
			console.log(beginner ? "PASS: beginner eight-seat candidates and replacements are standard-only; full game finished" : "PASS: packs and 20 character bans reached engine; excluded pack adds no cards; full game finished");
			resolveDone();
		}
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
				assert.equal(assets.details.character.standard.length, 33);
				assert.ok(assets.details.character.standard.every(c => c.image.startsWith("/") && c.skills.every(s => !/<[^>]*>/.test(s.description))));
				for (const pack of assets.cardPacks)
					assert.equal(
						assets.details.card[pack.id].reduce((n, c) => n + c.count, 0),
						pack.count
					);
				assert.equal(message.catalog.find(m => m.id === "identity").identityTable[2].length, 4);
				assert.ok(message.catalog.every(m => m.options.every(o => typeof o.frequent === "boolean")));
				banned = [...new Set(assets.characters.filter(c => c.pack === "standard").map(c => c.id))].slice(0, 20);
				assert.equal(banned.length, 20);
				excluded = assets.cardPacks.find(p => p.id !== "standard" && p.count > 0).id;
				const { preset: _preset, ...beginnerConfig } = beginnerPreset({ player_number: "8" });
				worker.postMessage({ t: "configure", mode: "identity", config: beginner ? beginnerConfig : { player_number: "4", characterPack: ["standard"], cardPack: ["standard"], banned, bannedcards: ["shandian"] } });
			} else if (message.t === "ready") worker.postMessage({ t: "begin" });
			else if (message.t === "log" && message.args[0] === "config-selftest") {
				const result = JSON.parse(message.args[1]);
				if (beginner) {
					const standard = new Set(result.standard);
					assert.equal(standard.size, 33);
					assert.equal(result.pile.length, 161);
					assert.equal(result.config.plugin_opening_hand_pick_enable, true);
					for (const role of ["zhu", "zhong", "fan", "nei"]) assert.equal(result.config[`plugin_opening_hand_pick_n_${role}`], "auto");
					assert.equal(result.chosen.length, 8);
					assert.ok(
						result.chosen.every(id => standard.has(id)),
						"chosen character leaked outside standard"
					);
					assert.ok(
						result.characterlist.every(id => standard.has(id)),
						"character pool leaked outside standard"
					);
					for (const seat of result.seats) {
						const lists = result.offered.filter(o => o.seat === seat);
						assert.ok(lists.length > 0 && lists.every(o => o.candidates.length > 0), `empty candidates for ${seat}`);
					}
					for (const offer of result.offered)
						for (const [id, alternatives] of Object.entries(offer.alternatives)) {
							assert.ok(alternatives.length > 0, `empty replacement for ${id}`);
							assert.ok(
								alternatives.every(id => standard.has(id)),
								`replacement leak for ${id}`
							);
						}
					console.log("beginner offered candidate lists", JSON.stringify(result.offered));
					console.log("beginner pool", result.characterlist.length, "chosen", result.chosen);
					inspected = true;
					return;
				}
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

	await completed;
}
await run(false);
await run(true);
