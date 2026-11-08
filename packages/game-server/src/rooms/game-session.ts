// One running game = one engine worker. Bridges per-user game sockets to the worker.
import { Worker } from "node:worker_threads";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

const engineHost = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../engine-host/src");
const workerFile = path.join(engineHost, "host/worker.js");
const registerFile = path.join(engineHost, "runtime/register.js");

import { Link, type GameSocket, type ResumeRequest } from "./link.ts";
export type { GameSocket } from "./link.ts";

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
	/** uid -> resumable stream; present while the engine considers the user connected */
	readonly #links = new Map<string, Link>();
	readonly #joined = new Set<string>();
	/** lobby profile per uid, handed to the engine so in-game names match the lobby */
	readonly #profiles = new Map<string, { nickname: string; avatar: string }>();
	#beginTimer?: NodeJS.Timeout;

	constructor(
		readonly engine: EngineWorker,
		readonly mode: string,
		readonly config: Record<string, unknown>,
		/** uids expected to take a seat */
		readonly players: string[],
		private readonly opts: { joinTimeoutMs: number; graceMs: number; log: (msg: string) => void }
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
				for (const uid of this.#links.keys()) this.#open(uid);
				this.#beginTimer = setTimeout(() => this.#begin(), this.opts.joinTimeoutMs);
				break;
			case "joined":
				this.#joined.add(m.id);
				if (this.status === "waiting" && this.players.every(uid => this.#joined.has(uid))) this.#begin();
				break;
			case "send":
				if (process.env.NONAME_DEBUG_GAME) this.opts.log(`-> ${m.id.slice(0, 6)} ${m.data.slice(0, 80)}`);
				this.#links.get(m.id)?.push(m.data);
				break;
			case "kick":
				this.opts.log(`engine closed client ${m.id}`);
				this.#dropLink(m.id, 4000, "kicked");
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

	#dropLink(uid: string, code?: number, reason?: string) {
		const link = this.#links.get(uid);
		if (!link) return;
		this.#links.delete(uid);
		if (code) link.socket?.close(code, reason);
		link.dispose();
		this.engine.post({ t: "close", id: uid });
	}

	/**
	 * Attach a user's game socket. With `resume` (the client still holds its state) the stream continues
	 * seamlessly if possible; otherwise the client is told to reload ("fresh") and reconnect from scratch,
	 * which the engine answers with a full snapshot (reinit).
	 */
	#open(uid: string) {
		this.engine.post({ t: "open", id: uid, profile: this.#profiles.get(uid) });
	}

	attach(uid: string, socket: GameSocket, resume?: ResumeRequest, profile?: { nickname: string; avatar: string }) {
		if (profile) this.#profiles.set(uid, profile);
		const link = this.#links.get(uid);
		if (resume) {
			if (link?.canResume(resume.serverSeq)) {
				this.opts.log(`resume ${uid} from ${resume.serverSeq} (server at ${link.outSeq})`);
				link.attach(socket, resume);
				return;
			}
			this.opts.log(`cannot resume ${uid} from ${resume.serverSeq} (link ${link ? `at ${link.outSeq}` : "gone"}): fresh`);
			socket.send("\u0006fresh");
			socket.close(1000, "fresh");
			return;
		}
		if (link) this.#dropLink(uid, 4001, "replaced");
		this.opts.log(`attach ${uid} (fresh stream, status ${this.status})`);
		const fresh = new Link(uid, {
			maxBufferBytes: 8 * 1024 * 1024,
			graceMs: this.opts.graceMs,
			onExpire: l => {
				if (this.#links.get(uid) === l) this.#dropLink(uid);
			},
		});
		fresh.attach(socket);
		this.#links.set(uid, fresh);
		if (this.status !== "starting") this.#open(uid);
	}

	message(uid: string, socket: GameSocket, frame: string) {
		const link = this.#links.get(uid);
		if (!link || link.socket !== socket) return;
		const data = link.receive(frame);
		if (data !== undefined) {
			if (process.env.NONAME_DEBUG_GAME) this.opts.log(`<- ${uid.slice(0, 6)} ${data.slice(0, 80)}`);
			this.engine.post({ t: "msg", id: uid, data });
		}
	}

	/** socket closed: the seat stays connected for the grace period, then falls back to AI */
	detach(uid: string, socket: GameSocket) {
		this.#links.get(uid)?.detach(socket);
	}

	isConnected(uid: string) {
		return !!this.#links.get(uid)?.connected;
	}

	async close() {
		clearTimeout(this.#beginTimer);
		for (const link of this.#links.values()) link.dispose();
		this.#links.clear();
		await this.engine.terminate();
		this.#setStatus("closed");
	}
}
