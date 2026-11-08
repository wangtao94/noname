// Keeps a few engine workers booted ahead of time so starting a game (or "play again") is instant.
import { EngineWorker } from "./game-session.ts";

export class WorkerPool {
	#idle: EngineWorker[] = [];
	#booting = 0;
	#closed = false;

	constructor(
		private readonly opts: {
			size: number;
			/** live games + idle workers must stay below this */
			capacity: () => number;
			preset: Record<string, unknown>;
			log: (msg: string) => void;
		}
	) {}

	start() {
		this.#refill();
	}

	/** Take a booted worker (waits for one if none is idle). */
	async take(): Promise<EngineWorker> {
		let w = this.#idle.shift();
		if (!w) w = this.#spawn();
		this.#refill();
		await w.booted;
		return w;
	}

	get idle() {
		return this.#idle.length;
	}

	#spawn() {
		const w = new EngineWorker({ preset: this.opts.preset, log: this.opts.log });
		w.events.once("exit", () => {
			this.#idle = this.#idle.filter(x => x !== w);
		});
		return w;
	}

	#refill() {
		if (this.#closed) return;
		while (this.#idle.length + this.#booting < this.opts.size && this.opts.capacity() > this.#idle.length + this.#booting) {
			this.#booting++;
			const w = this.#spawn();
			w.booted
				.then(() => this.#idle.push(w))
				.catch(e => this.opts.log(`pool worker failed to boot: ${e}`))
				.finally(() => {
					this.#booting--;
				});
		}
	}

	async close() {
		this.#closed = true;
		await Promise.all(this.#idle.splice(0).map(w => w.terminate()));
	}
}
