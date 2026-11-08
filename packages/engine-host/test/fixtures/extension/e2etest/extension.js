import { lib } from "noname";

// Use the real extension format, including an asset read from the admin directory.
const info = await lib.init.promises.json(`${lib.assetURL}extension/e2etest/info.json`);
export const type = "extension";
export default {
	name: info.name,
	connect: true,
	config: {},
	content() {},
	precontent() {},
	help: {},
	package: {
		...info,
		character: {
			character: { e2etest_hero: ["male", "wei", 4, ["e2etest_vigor"], ["forbidai"]] },
			translate: { e2etest_hero: "测试武将" },
		},
		skill: {
			skill: { e2etest_vigor: { mod: { maxHandcard(player, num) { return num + 1; } } } },
			translate: { e2etest_vigor: "精力", e2etest_vigor_info: "手牌上限+1。" },
		},
	},
	files: { character: [], card: [], skill: [], audio: [] },
};
