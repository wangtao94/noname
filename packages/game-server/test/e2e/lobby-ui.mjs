// Visual and interaction checks for the dependency-free lobby; owns its server process.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";

const base = "http://127.0.0.1:18091";
const shotDir = "/tmp/claude-1000/ui-shots";
const server = spawn(process.execPath, ["--import", "../engine-host/src/runtime/register.js", "src/main.ts"], {
	cwd: new URL("../../", import.meta.url),
	env: { ...process.env, PORT: "18091", NONAME_LOG_LEVEL: "warn" },
	stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
server.stdout.on("data", data => (log += data));
server.stderr.on("data", data => (log += data));
let browser;
try {
	const end = Date.now() + 120000;
	while (
		!(await fetch(`${base}/healthz`)
			.then(r => r.ok)
			.catch(() => false))
	) {
		if (Date.now() > end || server.exitCode !== null) throw new Error(`server not ready: ${log}`);
		await new Promise(resolve => setTimeout(resolve, 200));
	}
	await mkdir(shotDir, { recursive: true });
	browser = await chromium.launch({ headless: true });
	const page = async name => {
		const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
		await context.addInitScript(() => localStorage.setItem("gplv3_noname_alerted", "true"));
		const p = await context.newPage();
		p.on("pageerror", error => {
			throw error;
		});
		await p.goto(base);
		await p.locator("#home").waitFor({ state: "visible" });
		await p.locator("#nickname").fill(name);
		await p.locator("#nickname").dispatchEvent("change");
		return p;
	};
	const owner = await page("清风");
	await owner.locator("#createBtn").click();
	await owner.locator("#room").waitFor({ state: "visible" });
	const code = await owner.locator("#roomCode").textContent();
	await owner.locator('[data-key="player_number"]').selectOption("4");
	await owner.waitForFunction(() => document.querySelector("#roomHint").textContent.includes("/4"));
	await owner.locator('[aria-label="搜索禁用武将"]').waitFor({ state: "visible" });
	await owner.waitForFunction(() => !document.querySelector('[aria-label="搜索禁用武将"]').disabled);
	await owner.locator('[aria-label="搜索禁用武将"]').fill("caocao");
	await owner.locator(".ban-results button").first().click();
	await owner.waitForFunction(() => [...document.querySelectorAll(".ban-picker .chip")].some(e => e.textContent.includes("曹操")));
	const select = owner.locator('[data-key="plugin_opening_hand_pick_n_zhu"]');
	assert.match(await select.locator('option[value="auto"]').textContent(), /自动（\d）/);
	// A reduced pile must recalculate the auto budget live.
	const cardPacks = owner.locator(".pack-block").nth(1);
	const selectedPacks = await cardPacks.locator('button[aria-pressed="true"]').allTextContents();
	for (const text of selectedPacks) {
		await cardPacks.getByRole("button", { name: text, exact: true }).click();
		await owner.waitForTimeout(50);
	}
	await owner.waitForFunction(() => document.querySelector(".pile-count").textContent === "牌堆：0 张");
	assert.equal(await select.locator('option[value="auto"]').textContent(), "自动（1）");
	for (const text of selectedPacks) {
		await cardPacks.getByRole("button", { name: text, exact: true }).click();
		await owner.waitForTimeout(50);
	}
	await owner.screenshot({ path: `${shotDir}/owner-desktop-1280.png`, fullPage: true });
	await owner.setViewportSize({ width: 400, height: 860 });
	assert.equal(await owner.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "mobile horizontal overflow");
	await owner.screenshot({ path: `${shotDir}/owner-mobile-400.png`, fullPage: true });
	await owner.setViewportSize({ width: 1280, height: 900 });
	const second = await page("听雨");
	await second.locator("#createBtn").click();
	await second.locator("#room").waitFor({ state: "visible" });
	const viewer = await page("访客");
	await viewer.waitForFunction(() => document.querySelectorAll(".room-list-row").length === 2);
	await viewer.screenshot({ path: `${shotDir}/home-two-rooms.png`, fullPage: true });
	await viewer.goto(`${base}/room/${code}`);
	await viewer.locator("#room").waitFor({ state: "visible" });
	assert.equal(await viewer.locator("#options input:not(:disabled), #options select:not(:disabled)").count(), 0);
	assert.equal(await viewer.locator("#options .chip:is(button)").count(), 0);
	await viewer.screenshot({ path: `${shotDir}/non-owner-desktop.png`, fullPage: true });
	console.log("PASS: lobby interactions, auto budget, read-only controls and 400px layout; screenshots", shotDir);
} finally {
	await browser?.close();
	server.kill();
}
