import test from "node:test";
import assert from "node:assert/strict";
import { defaultGroups, bestGroup, chooseGroup } from "../src/plugins/opening-hand-pick.js";
import { injectPluginOptions, activatePlugins, installPluginActivation } from "../src/plugins/index.js";

test("auto: normal eight-seat and two-seat games", () => {
	assert.deepEqual(defaultGroups({ identities: ["zhu", "zhong", "zhong", "fan", "fan", "fan", "fan", "nei"], startCount: 4, pileSize: 160 }), { zhu: 2, zhong: 2, fan: 2, nei: 3 });
	assert.deepEqual(defaultGroups({ identities: ["zhu", "nei"], startCount: 4, pileSize: 100 }), { zhu: 2, zhong: 2, fan: 2, nei: 3 });
});
test("auto: small pile reduces largest groups and resolves ties in identity order", () => {
	assert.deepEqual(defaultGroups({ identities: ["zhu", "zhong", "fan", "nei"], startCount: 4, pileSize: 47 }), { zhu: 2, zhong: 2, fan: 2, nei: 1 });
	assert.deepEqual(defaultGroups({ identities: ["zhu", "zhong", "fan", "nei"], startCount: 4, pileSize: 40 }), { zhu: 2, zhong: 2, fan: 1, nei: 1 });
	assert.deepEqual(defaultGroups({ identities: ["zhu", "zhong", "fan", "nei"], startCount: 4, pileSize: 1 }), { zhu: 1, zhong: 1, fan: 1, nei: 1 });
});
test("unknown identities use fan budget", () => {
	const result = defaultGroups({ identities: ["zhu", "commoner"], startCount: 4, pileSize: 20 });
	assert.equal(result.fan, 1);
	assert.equal(result.zhu, 2);
});
test("options use connect_plugin namespace and identity mode only", () => {
	const lib = { mode: { identity: { connect: {} }, other: { connect: {} }, offline: {} } };
	injectPluginOptions(lib);
	assert.equal(lib.mode.identity.connect.connect_plugin_opening_hand_pick_enable.init, true);
	assert.equal(lib.mode.identity.connect.connect_plugin_opening_hand_pick_n_fan.init, "auto");
	assert.equal(lib.mode.identity.connect.connect_plugin_opening_hand_pick_timeout.init, "15");
	assert.equal(Object.keys(lib.mode.identity.connect).length, 6);
	assert.deepEqual(lib.mode.other.connect, {});
});
test("activation reads config lazily, after original startBefore", () => {
	let configured = false;
	let activated = 0;
	const engine = { lib: { configOL: {} }, game: { loadModeAsync(name, callback) { callback({ startBefore() { configured = true; } }); } } };
	const plugins = [{ id: "test", name: "test", modes: "*", options: [{ key: "n", init: 2 }], setup(_, config) { assert.equal(config.n, 3); if (activated > 0) assert.equal(configured, true); activated++; } }];
	engine.lib.configOL = { plugin_test_enable: true, plugin_test_n: 3 };
	activatePlugins(engine, "identity", plugins);
	assert.equal(activated, 1);
	engine.lib.configOL.plugin_test_enable = false;
	activatePlugins(engine, "identity", plugins);
	assert.equal(activated, 1);
	engine.lib.configOL.plugin_test_enable = true;
	installPluginActivation(engine, "identity", plugins);
	engine.game.loadModeAsync("identity", exports => exports.startBefore());
	assert.equal(configured, true);
	assert.equal(activated, 2);
});
test("AI and invalid/timeout remote replies choose highest summed value", async () => {
	const groups = [[1, 2], [4, 5], [3, 3]];
	const engine = { get: { value: card => card }, lib: { node: { torespondtimeout: {} } } };
	assert.equal(bestGroup(groups, {}, engine.get), 1);
	assert.equal(await chooseGroup({ isOnline: () => false }, groups, {}, engine), 1);
	let callback;
	const current = { playerid: "remote", isOnline: () => true, wait(fn) { callback = fn; }, send() {}, unwait(result) { callback(result); } };
	assert.equal(await chooseGroup(current, groups, { timeout: 0.001 }, engine), 1);
	current.send = () => callback({ control: "第3组" });
	assert.equal(await chooseGroup(current, groups, { timeout: 15 }, engine), 2);
});
