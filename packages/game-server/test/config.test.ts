import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.ts";

test("NONAME_EXTENSIONS defaults, whitespace, empty entries and duplicates", () => {
	const previous = process.env.NONAME_EXTENSIONS;
	try {
		delete process.env.NONAME_EXTENSIONS;
		assert.deepEqual(loadConfig().extensions, []);
		process.env.NONAME_EXTENSIONS = "";
		assert.deepEqual(loadConfig().extensions, []);
		process.env.NONAME_EXTENSIONS = " boss, e2etest, ,杀海拾遗,boss, ";
		assert.deepEqual(loadConfig().extensions, ["boss", "e2etest", "杀海拾遗"]);
		for (const name of ["..", ".", "../escape", "a/b", "a\\b"]) {
			process.env.NONAME_EXTENSIONS = name;
			assert.throws(loadConfig, /invalid NONAME_EXTENSIONS/);
		}
	} finally {
		if (previous === undefined) delete process.env.NONAME_EXTENSIONS;
		else process.env.NONAME_EXTENSIONS = previous;
	}
});
