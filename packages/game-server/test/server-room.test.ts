import test from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error core JS has no standalone declaration
import { applyServerRoomConfig } from "../../../apps/core/noname/init/server-room.js";

test("server-room extensions override local settings in memory, including empty lists", () => {
	const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
	Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
	const previous = Object.getOwnPropertyDescriptor(globalThis, "location");
	try {
		for (const value of ["e2etest", ""]) {
			Object.defineProperty(globalThis, "location", { configurable: true, value: { search: `?sa-room=123456&sa-uid=user&sa-token=token&sa-ext=${value}` } });
			const saved = ["local-only", "e2etest"];
			const plays = ["coin"];
			const lib = { config: { extensions: saved, plays, extension_auto_import: true, "extension_local-only_enable": true } };
			assert.equal(applyServerRoomConfig(lib, {}), true);
			assert.deepEqual(lib.config.extensions, value ? [value] : []);
			assert.equal(lib.config["extension_local-only_enable"], false);
			assert.equal(lib.config.extension_auto_import, false);
			assert.equal(lib.config.plays, plays);
			assert.deepEqual(saved, ["local-only", "e2etest"]);
		}
	} finally {
		if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
		else Reflect.deleteProperty(globalThis, "window");
		if (previous) Object.defineProperty(globalThis, "location", previous);
		else Reflect.deleteProperty(globalThis, "location");
	}
});
