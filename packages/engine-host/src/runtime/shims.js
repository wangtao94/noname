// Browser API shims for running the noname engine headless under happy-dom.
export function installShims(log = () => {}) {
	const g = globalThis;
	// Browser semantics: Symbol.toStringTag is a fixed per-interface string (happy-dom returns constructor.name,
	// which breaks noname's get.objtype() for Object.setPrototypeOf-ed elements such as Dialog/Player/Card).
	for (const key of Object.getOwnPropertyNames(g)) {
		if (!/^(HTML\w*Element|SVG\w*Element|Element|Node|Document|DocumentFragment|Text|Comment|CharacterData|ShadowRoot)$/.test(key)) continue;
		const C = g[key];
		if (typeof C !== "function" || !C.prototype) continue;
		Object.defineProperty(C.prototype, Symbol.toStringTag, { value: key, configurable: true });
	}
	g.alert = msg => log("alert", msg);
	g.confirm = msg => (log("confirm", msg), false);
	g.prompt = () => null;
	if (!g.matchMedia) g.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
	class FakeAudio extends EventTarget {
		constructor(src) {
			super();
			this.src = src ?? "";
			this.volume = 1;
			this.paused = true;
		}
		play() {
			return Promise.resolve();
		}
		pause() {}
		load() {}
		remove() {}
	}
	g.Audio = FakeAudio;
	g.HTMLAudioElement ??= FakeAudio;
	if (!g.AudioContext) {
		g.AudioContext = class {
			createGain() {
				return { connect() {}, gain: { value: 1 } };
			}
			decodeAudioData() {
				return Promise.resolve({});
			}
			createBufferSource() {
				return { connect() {}, start() {}, stop() {}, addEventListener() {} };
			}
			get destination() {
				return {};
			}
			resume() {
				return Promise.resolve();
			}
		};
	}
	// <canvas>: no-op 2D context
	const noop = () => {};
	let ctx2d;
	ctx2d = new Proxy({}, { get: (t, k) => (k in t ? t[k] : k === "measureText" ? () => ({ width: 0 }) : k === "getImageData" ? () => ({ data: [] }) : () => ctx2d), set: (t, k, v) => ((t[k] = v), true) });
	if (g.HTMLCanvasElement) g.HTMLCanvasElement.prototype.getContext = () => ctx2d;
	g.requestAnimationFrame ??= cb => setTimeout(() => cb(Date.now()), 16);
	g.cancelAnimationFrame ??= id => clearTimeout(id);
	g.requestIdleCallback ??= cb => setTimeout(() => cb({ timeRemaining: () => 0, didTimeout: true }), 1);
}
