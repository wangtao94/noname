// Browser end-to-end test: real Chromium pages play a full game through the lobby shell.
//
//   node test/e2e/browser-game.mjs            (expects `pnpm build` output in /dist)
//   E2E_PLAYERS=3 E2E_SEATS=4 E2E_RESTART=1 E2E_KILL_OWNER=1 E2E_TIMEOUT=600000
//
// Each page answers every prompt with the client-side AI (without telling the host it is in auto mode),
// so the host's remote-player code path is exercised.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(here, "../..");
const PORT = Number(process.env.E2E_PORT || 18090);
const PLAYERS = Number(process.env.E2E_PLAYERS || 3);
const SEATS = String(process.env.E2E_SEATS || 4);
const RESTART = process.env.E2E_RESTART === "1";
const KILL_OWNER = process.env.E2E_KILL_OWNER === "1";
const TIMEOUT = Number(process.env.E2E_TIMEOUT || 600000);
const base = `http://127.0.0.1:${PORT}`;
const t0 = Date.now();
const say = (...a) => console.log(((Date.now() - t0) / 1000).toFixed(1).padStart(6), ...a);

const server = spawn(process.execPath, ["--import", "../engine-host/src/runtime/register.js", "src/main.ts"], {
	cwd: serverDir,
	env: { ...process.env, PORT: String(PORT), NONAME_GAME_SPEED: process.env.E2E_SPEED || "vvfast", NONAME_LOG_LEVEL: "info" },
	stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", d => {
	serverLog += d;
	for (const line of String(d).split("\n")) if (/"level":(40|50|60)/.test(line) && !/"msg":"engine"/.test(line)) say("[server]", line.slice(0, 400));
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
	page.on("pageerror", e => say(`[p${i}] pageerror`, String(e).slice(0, 300)));
	page.on("console", m => {
		if (["error", "warning"].includes(m.type()) || process.env.E2E_CONSOLE) say(`[p${i}] console.${m.type()}`, m.text().slice(0, 300));
	});
	players.push({ i, context, page });
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

const roomState = p => p.page.evaluate(() => document.getElementById("roomCode")?.textContent || "");

// owner creates the room
const owner = players[0];
await owner.page.goto(base + "/");
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
	await waitFor(async () => (await roomState(p)) === code, 30000, `p${p.i} joined`);
	say(`p${p.i} joined`);
}

async function playOneGame(label) {
	const before = Date.now();
	await waitFor(() => owner.page.isVisible(label === "first" ? "#startBtn" : "#againBtn"), 30000, "start button");
	await owner.page.click(label === "first" ? "#startBtn" : "#againBtn");
	say(`${label}: start clicked`);
	// every player gets a game iframe
	for (const p of players) await waitFor(async () => p.page.frames().some(f => f.url().includes("sa-room=")), 60000, `p${p.i} iframe`);
	const killAt = KILL_OWNER && label === "first" ? Date.now() + 20000 : 0;
	let killed = false;
	await waitFor(
		async () => {
			for (const p of players) await autoAnswer(p);
			if (killAt && !killed && Date.now() > killAt) {
				killed = true;
				say("KILL owner page (simulated browser crash) and reopen");
				await owner.page.close();
				owner.page = await owner.context.newPage();
				owner.page.on("pageerror", e => say(`[p0] pageerror`, String(e).slice(0, 300)));
				await owner.page.goto(`${base}/room/${code}`);
			}
			const ended = await Promise.all(players.map(p => p.page.isVisible("#endbar").catch(() => false)));
			return ended.every(Boolean);
		},
		TIMEOUT,
		`${label} game over`
	);
	say(`${label}: game over on all pages after ${((Date.now() - before) / 1000).toFixed(1)}s`);
}

await playOneGame("first");
if (RESTART) await playOneGame("second");

const health = await (await fetch(`${base}/healthz`)).json();
say("health", JSON.stringify(health));
say("E2E PASS");
await browser.close();
server.kill();
process.exit(0);
