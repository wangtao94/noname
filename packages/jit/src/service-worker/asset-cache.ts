/// <reference lib="WebWorker" />
const worker = globalThis as unknown as ServiceWorkerGlobalScope;
interface Manifest {
	version: string;
	files: Record<string, string>;
}
const manifestURL = new URL("/asset-manifest.json", worker.location.origin).href;
let manifest: Manifest | undefined;
let lastCheck = 0;
let refreshing: Promise<void> | undefined;
const backgroundFills = new Map<string, Promise<void>>();
const maxBackgroundFillBytes = 20 * 1024 * 1024;
const excluded = (path: string) =>
	["index.html", "service-worker.js", "asset-manifest.json"].includes(path.split("/").slice(-1)[0] ?? "") ||
	["", "ws", "healthz", "api"].includes(path) ||
	path.startsWith("api/");
function valid(value: unknown): value is Manifest {
	if (!value || typeof value !== "object") return false;
	const m = value as Manifest;
	return (
		typeof m.version === "string" &&
		!!m.files &&
		typeof m.files === "object" &&
		!Array.isArray(m.files) &&
		Object.values(m.files).every(hash => typeof hash === "string" && /^[a-f0-9]{16}$/.test(hash))
	);
}
const loaded = (async () => {
	try {
		const saved = await (await caches.open("noname-meta")).match(manifestURL);
		if (saved) {
			const value = await saved.json();
			if (valid(value)) manifest = value;
		}
	} catch {
		/* Cache Storage may be unavailable. */
	}
})();

export function refreshAssetManifest(force = false): Promise<void> {
	if (refreshing) return refreshing;
	if (!force && Date.now() - lastCheck < 60_000) return loaded;
	lastCheck = Date.now();
	refreshing = (async () => {
		await loaded;
		try {
			const response = await fetch(manifestURL, { cache: "no-store" });
			if (!response.ok) return;
			const next: unknown = await response.json();
			if (!valid(next)) return;
			const assets = await caches.open("noname-assets");
			manifest = next;
			await (
				await caches.open("noname-meta")
			).put(manifestURL, new Response(JSON.stringify(next), { headers: { "Content-Type": "application/json" } }));
			for (const key of await assets.keys()) {
				const url = new URL(key.url);
				let path: string;
				try {
					path = decodeURIComponent(url.pathname.slice(1));
				} catch {
					await assets.delete(key);
					continue;
				}
				if (next.files[path] !== url.searchParams.get("h")) await assets.delete(key);
			}
		} catch {
			/* Offline: retain the last known manifest. */
		}
	})().finally(() => {
		refreshing = undefined;
	});
	return refreshing;
}

function cacheKey(path: string, hash: string) {
	return new URL(path.split("/").map(encodeURIComponent).join("/") + "?h=" + hash, worker.location.origin + "/").href;
}
function fillFullAsset(request: Request, cache: Cache, key: string, path: string, hash: string): Promise<void> {
	const existing = backgroundFills.get(key);
	if (existing) return existing;
	const fill = (async () => {
		try {
			const headers = new Headers(request.headers);
			headers.delete("Range");
			headers.delete("If-Range");
			const response = await fetch(new Request(request, { headers, cache: "no-cache" }));
			const length = response.headers.get("Content-Length");
			if (
				response.status !== 200 ||
				length === null ||
				!/^\d+$/.test(length) ||
				Number(length) > maxBackgroundFillBytes ||
				manifest?.files[path] !== hash
			) {
				await response.body?.cancel();
				return;
			}
			await cache.put(key, response);
			if (manifest?.files[path] !== hash) await cache.delete(key);
		} catch {
			/* Background download or cache quota failures must not interrupt playback. */
		}
	})().finally(() => {
		backgroundFills.delete(key);
	});
	backgroundFills.set(key, fill);
	return fill;
}

async function rangeResponse(response: Response, range: string): Promise<Response> {
	const body = await response.arrayBuffer();
	const size = body.byteLength;
	const match = /^bytes=(\d*)-(\d*)$/.exec(range);
	// Multiple or malformed ranges are handled by the origin instead.
	if (!match || (!match[1] && !match[2])) throw new Error("Unsupported range");
	const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
	const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
	const headers = new Headers(response.headers);
	headers.delete("Content-Encoding");
	headers.set("Accept-Ranges", "bytes");
	if (start > end || start >= size) {
		headers.set("Content-Range", `bytes */${size}`);
		headers.set("Content-Length", "0");
		return new Response(null, { status: 416, headers });
	}
	headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
	headers.set("Content-Length", String(end - start + 1));
	return new Response(body.slice(start, end + 1), { status: 206, headers });
}

export function handleAssetRequest(event: FetchEvent): void {
	const request = event.request;
	const url = new URL(request.url);
	if (request.method !== "GET" || url.origin !== worker.location.origin) return;
	if (request.mode === "navigate") event.waitUntil(refreshAssetManifest());
	let path: string;
	try {
		path = decodeURIComponent(url.pathname.replace(/^\//, ""));
	} catch {
		return;
	}
	if (excluded(path)) return;
	event.respondWith(
		(async () => {
			await loaded;
			const hash =
				manifest && Object.prototype.hasOwnProperty.call(manifest.files, path)
					? manifest.files[path]
					: undefined;
			if (!hash) return fetch(request);
			let cache: Cache;
			let cached: Response | undefined;
			const key = cacheKey(path, hash);
			try {
				cache = await caches.open("noname-assets");
				cached = await cache.match(key);
			} catch {
				return fetch(request);
			}
			const range = request.headers.get("Range");
			if (range) {
				if (cached) {
					try {
						return await rangeResponse(cached, range);
					} catch {
						/* Origin fallback. */
					}
				} else {
					event.waitUntil(fillFullAsset(request, cache, key, path, hash));
				}
				return fetch(request);
			}
			if (cached) return cached;
			// Revalidate the HTTP cache on a miss so stable URLs do not seed old content under a new hash.
			const response = await fetch(new Request(request, { cache: "no-cache" }));
			if (response.status === 200 && manifest?.files[path] === hash) {
				try {
					await cache.put(key, response.clone());
					if (manifest?.files[path] !== hash) await cache.delete(key);
				} catch {
					/* Quota exhaustion must not break the request. */
				}
			}
			return response;
		})()
	);
}
