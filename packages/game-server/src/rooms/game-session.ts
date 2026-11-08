// One running game = one engine worker. Bridges per-user game sockets to the worker.
import { Worker } from "node:worker_threads";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

const engineHost = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../engine-host/src");
const workerFile = path.join(engineHost, "host/worker.js");
const registerFile = path.join(engineHost, "runtime/register.js");

export interface GameSocket {
	send(data: string): void;
	close(code?: number, reason?: string): void;
}

type WorkerMsg =
	| { t: "booted"; catalog: unknown[] }
	| { t: "ready" }
	| { t: "joined"; id: string; reconnect?: boolean }
	| { t: "send"; id: string; data: string }
	| { t: "kick"; id: string }
	| { t: "config"; config: Record<string, unknown> }
	| { t: "over" }
	| { t: "log"; args: string[] };

/** A booted engine worker that has not been assigned a mode yet (see WorkerPool). */
export class EngineWorker {
	readonly worker: Worker;
	readonly booted: Promise<void>;
	readonly events = new EventEmitter();
	/** mode options reported by the engine on boot */
	catalog: unknown[] = [];
	#exited = false;

	constructor(opts: { preset?: Record<string, unknown>; log?: (msg: string) => void }) {
		this.worker = new Worker(workerFile, {
			execArgv: ["--import", registerFile],
			workerData: { roomId: "pool", preset: opts.preset ?? {} },
			stdout: true,
			stderr: true,
		});
		// engine prints a lot of content warnings; keep them out of the server log unless debugging
		this.worker.stdout.on("data", d => process.env.NONAME_ENGINE_STDOUT && process.stdout.write(d));
		this.worker.stderr.on("data", d => process.env.NONAME_ENGINE_STDOUT && process.stderr.write(d));
		this.booted = new Promise((resolve, reject) => {
			const onMsg = (m: WorkerMsg) => {
				if (m.t === "booted") {
					this.catalog = m.catalog ?? [];
					this.worker.off("message", onMsg);
					resolve();
				}
			};
			this.worker.on("message", onMsg);
			this.worker.once("error", reject);
			this.worker.once("exit", code => reject(new Error(`engine worker exited during boot (${code})`)));
		});
		this.worker.on("message", (m: WorkerMsg) => {
			if (m.t === "log") opts.log?.(m.args.join(" "));
			this.events.emit("message", m);
		});
		this.worker.on("exit", () => {
			this.#exited = true;
			this.events.emit("exit");
		});
		this.worker.on("error", e => this.events.emit("error", e));
	}

	get exited() {
		return this.#exited;
	}

	post(msg: unknown) {
		if (!this.#exited) this.worker.postMessage(msg);
	}

	async terminate() {
		if (!this.#exited) await this.worker.terminate();
	}
}

export type GameStatus = "starting" | "waiting" | "playing" | "over" | "closed";

/**
 * Lifecycle: configure -> waiting (players' game sockets connect & handshake) -> begin -> playing -> over.
 * Sockets are keyed by uid; the uid is also the engine-side client id, so reconnecting with the same uid
 * resumes the seat (engine "reinit").
 */
export class GameSession extends EventEmitter {
	readonly gameId = randomUUID();
	readonly startedAt = Date.now();
	status: GameStatus = "starting";
	endedAt?: number;
	readonly #sockets = new Map<string, GameSocket>();
	readonly #joined = new Set<string>();
	#beginTimer?: NodeJS.Timeout;

	constructor(
		readonly engine: EngineWorker,
		readonly mode: string,
		readonly config: Record<string, unknown>,
		/** uids expected to take a seat */
		readonly players: string[],
		private readonly opts: { joinTimeoutMs: number; log: (msg: string) => void }
	) {
		super();
		engine.events.on("message", (m: WorkerMsg) => this.#onWorker(m));
		engine.events.on("exit", () => this.#setStatus("closed"));
		engine.post({ t: "configure", mode, config });
	}

	#setStatus(s: GameStatus) {
		if (this.status === s || this.status === "closed") return;
		this.status = s;
		if (s === "over") this.endedAt = Date.now();
		this.emit("status", s);
	}

	#onWorker(m: WorkerMsg) {
		switch (m.t) {
			case "ready":
				this.#setStatus("waiting");
				for (const uid of this.#sockets.keys()) this.engine.post({ t: "open", id: uid });
				this.#beginTimer = setTimeout(() => this.#begin(), this.opts.joinTimeoutMs);
				break;
			case "joined":
				this.#joined.add(m.id);
				if (this.status === "waiting" && this.players.every(uid => this.#joined.has(uid))) this.#begin();
				break;
			case "send":
				this.#sockets.get(m.id)?.send(m.data);
				break;
			case "kick":
				this.#sockets.get(m.id)?.close(4000, "kicked");
				break;
			case "over":
				this.#setStatus("over");
				break;
		}
	}

	#begin() {
		clearTimeout(this.#beginTimer);
		if (this.status !== "waiting") return;
		this.#setStatus("playing");
		this.engine.post({ t: "begin" });
	}

	/** Attach (or re-attach) a user's game socket. */
	attach(uid: string, socket: GameSocket) {
		const old = this.#sockets.get(uid);
		if (old && old !== socket) {
			this.#sockets.delete(uid);
			this.engine.post({ t: "close", id: uid });
			old.close(4001, "replaced");
		}
		this.#sockets.set(uid, socket);
		if (this.status !== "starting") this.engine.post({ t: "open", id: uid });
	}

	message(uid: string, socket: GameSocket, data: string) {
		if (this.#sockets.get(uid) === socket) this.engine.post({ t: "msg", id: uid, data });
	}

	detach(uid: string, socket: GameSocket) {
		if (this.#sockets.get(uid) !== socket) return;
		this.#sockets.delete(uid);
		this.engine.post({ t: "close", id: uid });
	}

	isConnected(uid: string) {
		return this.#sockets.has(uid);
	}

	async close() {
		clearTimeout(this.#beginTimer);
		for (const s of this.#sockets.values()) s.close(4002, "game closed");
		this.#sockets.clear();
		await this.engine.terminate();
		this.#setStatus("closed");
	}
}
