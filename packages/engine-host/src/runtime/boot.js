// Boot the noname engine headless inside the current thread (one engine per thread).
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const coreRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../apps/core");

/**
 * @param {object} opts
 * @param {Record<string, any>} [opts.preset] config preset (game.saveConfig keys; `<key>_mode_config_<mode>` for mode options)
 * @param {(noname: any) => void | Promise<void>} [opts.beforeBoot]
 * @param {(...args: any[]) => void} [opts.log]
 */
export async function bootEngine({ preset = {}, beforeBoot, log = () => {} } = {}) {
	GlobalRegistrator.register({
		url: "http://localhost/",
		width: 1280,
		height: 720,
		settings: {
			disableJavaScriptFileLoading: true,
			disableCSSFileLoading: true,
			disableIframePageLoading: true,
			navigator: { userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0 Safari/537.36 noname-server" },
		},
	});
	const { installShims } = await import("./shims.js");
	installShims(log);
	await import("fake-indexeddb/auto");
	const noname = await import("noname");
	globalThis.__NONAME_PRESET__ = preset;
	const { serverPreload } = await import("./preload.js");
	await serverPreload({ lib: noname.lib, game: noname.game, coreRoot, log });
	localStorage.setItem("noname_0.9_directstart", "true");
	localStorage.setItem("gplv3_noname_alerted", "true");
	await beforeBoot?.(noname);
	const { boot } = await import("@/init/index.js");
	await boot();
	return noname;
}
