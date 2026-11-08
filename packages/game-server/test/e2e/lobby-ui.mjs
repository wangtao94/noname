// Visual and interaction checks for the dependency-free lobby; owns its server process.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";

const base = "http://127.0.0.1:18091";
const shotDir = "/tmp/claude-1000/ui-shots-2";
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
	await owner.screenshot({ path: `${shotDir}/home.png`, fullPage: true });
	await owner.locator("#createBtn").click();
	await owner.locator("#room").waitFor({ state: "visible" });
	const code = await owner.locator("#roomCode").textContent();
	await owner.locator('[data-players="4"]').click();
	await owner.waitForFunction(() => document.querySelector("#roomHint").textContent.includes("/4"));
	await owner.screenshot({ path: `${shotDir}/beginner-owner-1280.png`, fullPage: true });
	await owner.setViewportSize({ width: 400, height: 860 });
	assert.equal(await owner.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
	await owner.screenshot({ path: `${shotDir}/beginner-owner-400.png`, fullPage: true });
	await owner.setViewportSize({ width: 1280, height: 900 });
	await owner.locator("#customPreset").click();
	await owner.locator('[aria-label="搜索禁用武将"]').waitFor({ state: "visible" });
	await owner.waitForFunction(() => !document.querySelector('[aria-label="搜索禁用武将"]').disabled);
	await owner.locator('[aria-label="搜索禁用武将"]').fill("caocao");
	await owner.locator(".ban-results button").first().click();
	await owner.waitForFunction(() => [...document.querySelectorAll(".ban-picker .chip")].some(e => e.textContent.includes("曹操")));
	const select = owner.locator('[data-key="plugin_opening_hand_pick_n_zhu"]');
	assert.match(await select.locator('option[value="auto"]').textContent(), /自动（\d）/);
	const cardPacks = owner.locator(".pack-block").nth(1);
	await cardPacks.getByRole("button", { name: "清空", exact: true }).click();
	await owner.waitForFunction(() => document.querySelector(".pile-count").textContent === "牌堆：0 张");
	assert.equal(await select.locator('option[value="auto"]').textContent(), "自动（1）");
	await cardPacks.getByRole("button", { name: "恢复默认", exact: true }).click();
	await owner.waitForFunction(() => document.querySelector(".pile-count").textContent !== "牌堆：0 张");
	await owner.screenshot({ path: `${shotDir}/custom-owner-1280.png`, fullPage: true });
	await owner.locator(".option-row .help").first().click();
	await owner.screenshot({ path: `${shotDir}/explanation-open.png`, fullPage: true });
	await owner.locator(".pack-block").first().getByRole("button", { name: "查看标准武将包", exact: true }).click();
	await owner.locator(".character-detail").first().waitFor();
	await owner.locator(".character-detail summary").first().click();
	await owner.locator(".character-detail").first().scrollIntoViewIfNeeded();
	await owner.screenshot({ path: `${shotDir}/character-preview-1280.png` });
	await owner.setViewportSize({ width: 400, height: 860 });
	assert.equal(await owner.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
	await owner.locator(".character-detail").first().scrollIntoViewIfNeeded();
	await owner.screenshot({ path: `${shotDir}/character-preview-400.png` });
	await owner.locator("#previewSearch").fill("caocao");
	assert.equal(await owner.locator(".character-detail").count(), 1);
	await owner.keyboard.press("Escape");
	await owner.setViewportSize({ width: 1280, height: 900 });
	await cardPacks.locator(".preview-button").first().click();
	await owner.locator(".card-list article").first().waitFor();
	await owner.screenshot({ path: `${shotDir}/card-preview.png` });
	await owner.locator("#closePreview").click();
	await owner.locator("#beginnerPreset").click();
	await owner.locator("#presetConfirm").waitFor({ state: "visible" });
	assert.equal(await owner.locator("#customMode").isVisible(), true, "reset requires inline confirmation");
	await owner.locator("#cancelPreset").click();
	await owner.locator("#beginnerPreset").click();
	await owner.locator("#confirmPreset").click();
	await owner.locator(".player-picker").waitFor();
	assert.equal(await owner.locator("#customMode").isVisible(), false);
	assert.match(await owner.locator(".player-picker .selected").textContent(), /四人/);
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
	assert.equal(await viewer.locator("#customPreset").isDisabled(), true);
	await viewer.screenshot({ path: `${shotDir}/non-owner-desktop.png`, fullPage: true });
	console.log("PASS: lobby interactions, auto budget, read-only controls and 400px layout; screenshots", shotDir);
} finally {
	await browser?.close();
	server.kill();
}
