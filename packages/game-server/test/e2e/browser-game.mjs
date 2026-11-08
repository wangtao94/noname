// Browser end-to-end test: real Chromium pages play a full game through the lobby shell.
//
//   node test/e2e/browser-game.mjs            (expects `pnpm build` output in /dist)
//   E2E_PLAYERS=3 E2E_SEATS=4 E2E_RESTART=1 E2E_KILL_OWNER=1 E2E_TIMEOUT=600000
//
// Each page answers every prompt with the client-side AI (without telling the host it is in auto mode),
// so the host's remote-player code path is exercised.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(here, "../..");
const EXTENSIONS = process.env.E2E_EXTENSIONS?.split(",").filter(Boolean);
const PORT = Number(process.env.E2E_PORT || 18090);
const PLAYERS = Number(process.env.E2E_PLAYERS || 3);
const SEATS = String(process.env.E2E_SEATS || 4);
const RESTART = process.env.E2E_RESTART === "1";
const KILL_OWNER = process.env.E2E_KILL_OWNER === "1";
const DROP = process.env.E2E_DROP === "1";
let drops = 0;
const TIMEOUT = Number(process.env.E2E_TIMEOUT || 600000);
const base = `http://127.0.0.1:${PORT}`;
const t0 = Date.now();
const say = (...a) => console.log(((Date.now() - t0) / 1000).toFixed(1).padStart(6), ...a);

const server = spawn(process.execPath, ["--import", "../engine-host/src/runtime/register.js", "src/main.ts"], {
	cwd: serverDir,
	env: { ...process.env, PORT: String(PORT), NONAME_GAME_SPEED: process.env.E2E_SPEED || "vvfast", NONAME_LOG_LEVEL: "info", ...(EXTENSIONS ? { NONAME_EXTENSIONS: EXTENSIONS.join(","), NONAME_DATA_DIR: path.resolve(serverDir, "../engine-host/test/fixtures") } : {}) },
	stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", d => {
	serverLog += d;
	for (const line of String(d).split("\n")) if ((/"level":(40|50|60)/.test(line) || /"msg":"game"/.test(line)) && (!/"msg":"engine"/.test(line) || /Error|unhandled|uncaught/.test(line))) say("[server]", line.slice(0, 400));
});
server.stderr.on("data", d => say("[server:err]", String(d).slice(0, 400)));

const shotDir = process.env.E2E_SHOTS || "/tmp/claude-1000/e2e-shots";
const fail = async msg => {
	say("E2E FAIL:", msg);
	try {
		const fs = await import("node:fs");
		fs.mkdirSync(shotDir, { recursive: true });
		for (const p of players) {
			await p.page.screenshot({ path: `${shotDir}/p${p.i}.png` }).catch(() => {});
			say(`p${p.i} frames:`, p.page.frames().map(f => f.url().slice(0, 120)).join(" | "));
		}
		fs.writeFileSync(`${shotDir}/server.log`, serverLog);
	} catch {}
	await browser?.close().catch(() => {});
	server.kill();
	process.exit(1);
};
setTimeout(() => fail("timeout"), TIMEOUT).unref();

async function waitFor(fn, ms, what) {
	const end = Date.now() + ms;
	for (;;) {
		const v = await fn().catch(() => undefined);
		if (v) return v;
		if (Date.now() > end) return fail(`waiting for ${what}`);
		await new Promise(r => setTimeout(r, 300));
	}
}

await waitFor(async () => (await fetch(`${base}/healthz`)).ok, 120000, "server up");
say("server up");

const browser = await chromium.launch({ headless: true });
const players = [];
for (let i = 0; i < PLAYERS; i++) {
	const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
	const page = await context.newPage();
	page.on("dialog", d => (say(`[p${i}] dialog`, d.message().slice(0, 40)), d.accept()));
	page.on("pageerror", e => say(`[p${i}] pageerror`, String(e).slice(0, 300)));
	page.on("console", m => {
		if (["error", "warning"].includes(m.type()) || process.env.E2E_CONSOLE) say(`[p${i}] console.${m.type()}`, m.text().slice(0, 300));
	});
	players.push({ i, context, page });
}

/** simulate a network blip: close the iframe's underlying WebSocket (the resumable socket reconnects) */
async function dropSocket(p) {
	for (const frame of p.page.frames()) {
		if (!frame.url().includes("sa-room=")) continue;
		const ok = await frame
			.evaluate(async () => {
				const { game } = await import("/noname.js");
				if (!game.ws?.ws) return `no inner ws: ${game.ws?.constructor?.name} online=${game.online}`;
				game.ws.ws.close();
				return true;
			})
			.catch(e => String(e));
		if (ok === true) drops++;
		else say("drop failed:", ok);
	}
}

/** the newest game iframe's engine state */
async function clientState(p) {
	// the visible game iframe (the lobby may also hold a hidden, preloaded page for the next game)
	let frame = null;
	for (const f of p.page.frames()) {
		if (!f.url().includes("sa-room=")) continue;
		const el = await f.frameElement().catch(() => null);
		const visible = el && (await el.evaluate(e => !e.classList.contains("pending") && !!e.dataset.game).catch(() => false));
		if (visible) frame = f;
	}
	if (!frame) return null;
	return frame
		.evaluate(async () => {
			const { game, _status } = await import("/noname.js");
			return { over: !!_status.over, players: game.players?.length ?? 0, round: game.roundNumber, event: _status.event?.name, me: game.me?.name, identity: game.me?.identity, online: !!game.online };
		})
		.catch(e => ({ error: String(e).slice(0, 100) }));
}

/** make the game iframe answer prompts with local AI */
async function autoAnswer(p) {
	for (const frame of p.page.frames()) {
		if (!frame.url().includes("sa-room=")) continue;
		await frame
			.evaluate(async () => {
				if (window.__e2eAuto) return;
				window.__e2eAuto = true;
				const { _status } = await import("/noname.js");
				setInterval(() => (_status.auto = true), 300);
			})
			.catch(() => {});
	}
}

async function acceptGpl(page) {
	if (await page.isVisible("#gpl").catch(() => false)) await page.click("#gplAccept");
}

const roomState = p => p.page.evaluate(() => document.getElementById("roomCode")?.textContent || "");

// owner creates the room
const owner = players[0];
await owner.page.goto(base + "/");
await acceptGpl(owner.page);
await owner.page.fill("#nickname", "房主");
await owner.page.dispatchEvent("#nickname", "change");
await waitFor(() => owner.page.isEnabled("#createBtn"), 30000, "lobby");
await owner.page.click("#createBtn");
const code = await waitFor(() => roomState(owner), 30000, "room created");
say("room", code);
// 4 seats
await owner.page.selectOption("#options select >> nth=0", { index: 0 }).catch(() => {});
await owner.page.evaluate(seats => {
	const ws = [...document.querySelectorAll("#options label")].find(l => l.textContent.includes("游戏人数") || l.textContent.includes("人数"));
	const sel = ws?.querySelector("select");
	if (sel) {
		sel.value = seats;
		sel.dispatchEvent(new Event("change"));
	}
}, SEATS);

for (const p of players.slice(1)) {
	await p.page.goto(`${base}/room/${code}`);
	await acceptGpl(p.page);
	await waitFor(async () => (await roomState(p)) === code, 30000, `p${p.i} joined`);
	say(`p${p.i} joined`);
}

const markShell = p => p.page.evaluate(() => (window.__e2eShellMark ??= Math.random())).catch(() => null);
const visibleGame = p =>
	p.page.evaluate(() => [...document.querySelectorAll("#frames iframe:not(.pending)")].map(f => f.dataset.game).pop() ?? null).catch(() => null);

async function playOneGame(label) {
	const before = Date.now();
	const marks = await Promise.all(players.map(markShell));
	const prevGame = await visibleGame(players[1]);
	await waitFor(() => owner.page.isVisible(label === "first" ? "#startBtn" : "#againBtn"), 30000, "start button");
	await owner.page.click(label === "first" ? "#startBtn" : "#againBtn");
	say(`${label}: start clicked`);
	if (label !== "first") {
		// P3: the new game must become visible without reloading the lobby page
		const t = Date.now();
		await waitFor(async () => {
			const g = await visibleGame(players[1]);
			return g && g !== prevGame;
		}, 60000, "new game visible");
		say(`${label}: new game visible after ${((Date.now() - t) / 1000).toFixed(1)}s`);
		const after = await Promise.all(players.map(markShell));
		for (let i = 1; i < players.length; i++) if (after[i] !== marks[i]) return fail(`p${i} lobby page reloaded during restart`);
	}
	// every player gets a game iframe
	for (const p of players) await waitFor(async () => p.page.frames().some(f => f.url().includes("sa-room=")), 60000, `p${p.i} iframe`);
	const killAt = KILL_OWNER && label === "first" ? Date.now() + 20000 : 0;
	let killed = false;
	let nextDrop = Date.now() + 8000;
	let nextReport = Date.now() + 30000;
	const checkedExtensions = new Set();
	await waitFor(
		async () => {
			for (const p of players) {
				await autoAnswer(p);
				const state = await clientState(p);
				if (EXTENSIONS && state?.players && !checkedExtensions.has(p.i)) {
					for (const frame of p.page.frames().filter(f => f.url().includes("sa-room="))) {
						const el = await frame.frameElement().catch(() => null);
						if (!el || !(await el.evaluate(e => !e.classList.contains("pending") && !!e.dataset.game))) continue;
						const loaded = await frame.evaluate(async () => {
							const { lib } = await import("/noname.js");
							return { extensions: lib.config.extensions, character: !!lib.character.e2etest_hero, autoImport: lib.config.extension_auto_import };
						});
						try {
							assert.deepEqual(loaded.extensions, EXTENSIONS);
							assert.equal(loaded.autoImport, false);
							if (EXTENSIONS.includes("e2etest")) assert.equal(loaded.character, true);
						} catch (e) { return fail(`p${p.i} extensions: ${e}`); }
						checkedExtensions.add(p.i);
						say(`p${p.i} extensions verified`, JSON.stringify(loaded));
					}
				}
			}
			if (Date.now() > nextReport) {
				nextReport = Date.now() + 30000;
				say("progress", JSON.stringify(await Promise.all(players.map(p => clientState(p)))));
			}
			if (DROP && Date.now() > nextDrop) {
				nextDrop = Date.now() + 8000;
				const p = players[1 + (drops % (players.length - 1))];
				await dropSocket(p);
				say(`DROP p${p.i} socket (total ${drops})`);
			}
			if (killAt && !killed && Date.now() > killAt) {
				killed = true;
				say("KILL owner page (simulated browser crash) and reopen");
				await owner.page.close();
				owner.page = await owner.context.newPage();
				owner.page.on("pageerror", e => say(`[p0] pageerror`, String(e).slice(0, 300)));
				await owner.page.goto(`${base}/room/${code}`);
				await acceptGpl(owner.page);
			}
			const ended = await Promise.all(players.map(p => p.page.isVisible("#endbar").catch(() => false)));
			if (!ended.every(Boolean)) return false;
			// every client's own engine must have played and finished the game (not just the server)
			const clientOver = await Promise.all(players.map(p => clientState(p)));
			const bad = clientOver.filter(s => !s?.over || !s.players);
			if (bad.length) return fail(`server finished but clients did not: ${JSON.stringify(clientOver)}`);
			if (EXTENSIONS && checkedExtensions.size !== players.length) return fail("extensions not verified in every client");
			say(`${label}: clients`, JSON.stringify(clientOver));
			return true;
		},
		TIMEOUT,
		`${label} game over`
	);
	say(`${label}: game over on all pages after ${((Date.now() - before) / 1000).toFixed(1)}s`);
}

await playOneGame("first");
if (RESTART) await playOneGame("second");

const health = await (await fetch(`${base}/healthz`)).json();
say("health", JSON.stringify(health), "drops", drops);
say("E2E PASS");
await browser.close();
server.kill();
process.exit(0);
