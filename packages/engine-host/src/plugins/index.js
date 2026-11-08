import openingHandPick from "./opening-hand-pick.js";

/**
 * @param {{ id: string, name: string, modes: string[] | "*", enabledByDefault?: boolean,
 * options: Array<{key: string, name: string, init: unknown, item?: object, intro?: string}>,
 * setup: (engine: {lib: any, game: any, get: any, _status: any, ui: any, ai: any}, config: object) => void }} def
 */
export function definePlugin(def) {
	if (!def.id || !def.name || !(def.modes === "*" || Array.isArray(def.modes)) || !Array.isArray(def.options) || typeof def.setup !== "function") throw new TypeError("Invalid plugin definition");
	if (def.options.some(option => option.key.startsWith("connect_") || option.key === "enable")) throw new TypeError("Plugin option keys must be plain names; enable is reserved");
	return def;
}

export const builtInPlugins = [definePlugin(openingHandPick)];
export const pluginPrefix = plugin => `plugin_${plugin.id.replaceAll("-", "_")}_`;
const supports = (plugin, mode) => plugin.modes === "*" || plugin.modes.includes(mode);

export function injectPluginOptions(lib, plugins = builtInPlugins) {
	for (const [mode, info] of Object.entries(lib.mode)) {
		if (!info?.connect) continue;
		for (const plugin of plugins.filter(plugin => supports(plugin, mode))) {
			for (const option of [{ key: "enable", name: plugin.name, init: plugin.enabledByDefault ?? false }, ...plugin.options]) {
				const { key, ...definition } = option;
				info.connect[`connect_${pluginPrefix(plugin)}${key}`] = { ...definition, item: definition.item && { ...definition.item }, connect: true };
			}
		}
	}
}

export function activatePlugins(engine, mode, plugins = builtInPlugins) {
	for (const plugin of plugins.filter(plugin => supports(plugin, mode))) {
		const prefix = pluginPrefix(plugin);
		if (!(engine.lib.configOL[prefix + "enable"] ?? plugin.enabledByDefault ?? false)) continue;
		const config = Object.fromEntries(plugin.options.map(option => [option.key, engine.lib.configOL[prefix + option.key] ?? option.init]));
		plugin.setup(engine, config);
	}
}

/** switchMode fills configOL before startBefore, and executes start content afterwards. */
export function installPluginActivation(engine, mode, plugins = builtInPlugins) {
	const load = engine.game.loadModeAsync;
	engine.game.loadModeAsync = function (name, callback, ...args) {
		if (name !== mode) return load.call(this, name, callback, ...args);
		engine.game.loadModeAsync = load;
		return load.call(this, name, exports => {
			const wrapped = { ...exports, startBefore() {
				exports.startBefore?.apply(this, arguments);
				activatePlugins(engine, mode, plugins);
			} };
			return callback(wrapped);
		}, ...args);
	};
}
