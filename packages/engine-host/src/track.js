// Debug: track live (GC-surviving) elements by creation site.
export function installTracker(log) {
	const live = new Map();
	const reg = new FinalizationRegistry(site => {
		const c = live.get(site) - 1;
		c ? live.set(site, c) : live.delete(site);
	});
	const orig = document.createElement;
	let n = 0;
	document.createElement = function (...a) {
		const el = orig.apply(this, a);
		if (n++ % 10 === 0) {
			const st = new Error().stack.split("\n").slice(2).filter(l => !l.includes("ui/create") && !l.includes("happy-dom") && !l.includes("track.js")).slice(0, 2).map(l => l.trim().replace(/^at /, "").replace(/file:\/\/\/home\/tacrux\/workspace\/noname\/apps\/core\//g, "")).join(" <- ");
			live.set(st, (live.get(st) || 0) + 1);
			reg.register(el, st);
		}
		return el;
	};
	return () => {
		global.gc?.();
		return [...live].sort((a, b) => b[1] - a[1]).slice(0, 15);
	};
}
