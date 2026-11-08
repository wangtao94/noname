import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assetPath, rootedPath, initialize, resolve } from "../src/runtime/hooks.js";

test("extension fallback preserves core precedence and rejects traversal/symlink escapes", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "noname-extensions-"));
	const core = path.join(dir, "core");
	const data = path.join(dir, "data");
	const old = process.env.NONAME_DATA_DIR;
	try {
		for (const root of [core, data]) fs.mkdirSync(path.join(root, "extension", "test"), { recursive: true });
		process.env.NONAME_DATA_DIR = data;
		const name = "extension/test/extension.js";
		fs.writeFileSync(path.join(data, name), "export default {};");
		assert.equal(assetPath(core, name), path.join(data, name));
		await initialize({ coreRoot: core });
		const resolved = await resolve("/" + name, {}, () => assert.fail("fallback should resolve"));
		assert.equal(resolved.url, new URL("file://" + path.join(data, name)).href);
		fs.writeFileSync(path.join(core, name), "export default {};");
		assert.equal(assetPath(core, name), path.join(core, name));
		assert.throws(() => assetPath(core, "../../outside"), /escapes/);
		fs.symlinkSync(dir, path.join(data, "extension", "escape"));
		assert.throws(() => assetPath(core, "extension/escape/missing.js"), /escapes/);
		assert.throws(() => rootedPath(data, "../outside"), /escapes/);
		await assert.rejects(resolve("../../../outside.ts", { parentURL: new URL("file://" + path.join(data, name)).href }, () => assert.fail()), /escapes/);
		// A stock TypeScript entry wins over an admin JavaScript entry.
		fs.renameSync(path.join(core, name), path.join(core, name.replace(".js", ".ts")));
		assert.match((await resolve("/" + name, {}, () => assert.fail())).url, /core\/extension\/test\/extension.ts$/);
	} finally {
		if (old === undefined) delete process.env.NONAME_DATA_DIR;
		else process.env.NONAME_DATA_DIR = old;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
