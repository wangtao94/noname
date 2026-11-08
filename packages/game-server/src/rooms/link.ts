// A user's resumable game stream. Survives socket drops for a grace period; frames are numbered
// so a reconnecting client can resume exactly where it stopped (see apps/core/noname/init/server-room.js).
//
// Wire format both ways: "<seq>\n<payload>"; control frames start with \u0006.

export interface GameSocket {
	send(data: string): void;
	close(code?: number, reason?: string): void;
}

export interface ResumeRequest {
	/** last server frame the client processed */
	serverSeq: number;
	/** last client frame the client sent (informational) */
	clientSeq: number;
}

const CTRL = "\u0006";

export class Link {
	socket?: GameSocket;
	/** last outbound seq assigned */
	outSeq = 0;
	/** last inbound client seq delivered to the engine */
	inSeq = 0;
	/** outbound frames not yet acknowledged */
	#buffer: [number, string][] = [];
	#bufferBytes = 0;
	#graceTimer?: NodeJS.Timeout;

	constructor(
		readonly uid: string,
		private readonly opts: { maxBufferBytes: number; graceMs: number; onExpire: (link: Link) => void }
	) {}

	/** true when every frame after `serverSeq` is still buffered */
	canResume(serverSeq: number) {
		if (serverSeq > this.outSeq) return false;
		const first = this.#buffer[0]?.[0] ?? this.outSeq + 1;
		return serverSeq >= first - 1;
	}

	/** attach a socket; with `resume`, replays the missed frames */
	attach(socket: GameSocket, resume?: ResumeRequest) {
		clearTimeout(this.#graceTimer);
		this.#graceTimer = undefined;
		if (this.socket && this.socket !== socket) this.socket.close(4001, "superseded");
		this.socket = socket;
		if (resume) {
			socket.send(`${CTRL}resume:${this.inSeq}`);
			for (const [seq, data] of this.#buffer) if (seq > resume.serverSeq) socket.send(`${seq}\n${data}`);
		}
	}

	/** socket went away: keep the stream for the grace period */
	detach(socket: GameSocket) {
		if (this.socket !== socket) return false;
		this.socket = undefined;
		clearTimeout(this.#graceTimer);
		this.#graceTimer = setTimeout(() => this.opts.onExpire(this), this.opts.graceMs);
		this.#graceTimer.unref?.();
		return true;
	}

	get connected() {
		return !!this.socket;
	}

	/** engine -> client */
	push(data: string) {
		const seq = ++this.outSeq;
		this.#buffer.push([seq, data]);
		this.#bufferBytes += data.length;
		while (this.#bufferBytes > this.opts.maxBufferBytes && this.#buffer.length > 1) {
			this.#bufferBytes -= this.#buffer.shift()![1].length;
		}
		this.socket?.send(`${seq}\n${data}`);
	}

	/** client -> engine; returns the payload to deliver, or undefined for control / duplicate frames */
	receive(frame: string): string | undefined {
		if (frame.startsWith(CTRL)) {
			if (frame.startsWith(`${CTRL}ack:`)) this.#ack(Number(frame.slice(5)));
			return undefined;
		}
		const nl = frame.indexOf("\n");
		if (nl <= 0) return undefined;
		const seq = Number(frame.slice(0, nl));
		if (!Number.isSafeInteger(seq) || seq <= this.inSeq) return undefined;
		this.inSeq = seq;
		return frame.slice(nl + 1);
	}

	#ack(seq: number) {
		if (!Number.isSafeInteger(seq)) return;
		while (this.#buffer.length && this.#buffer[0][0] <= seq) this.#bufferBytes -= this.#buffer.shift()![1].length;
	}

	dispose() {
		clearTimeout(this.#graceTimer);
		this.socket?.close(4002, "game closed");
		this.socket = undefined;
	}
}
