// Storage abstraction. Default implementation keeps everything in memory; a Redis-backed
// implementation can be added behind the same interfaces (semantics are plain key/value).
// Live engine state is NOT stored here — it lives inside each game worker.

export interface UserRecord {
	uid: string;
	token: string;
	nickname: string;
	avatar: string;
	createdAt: number;
	lastSeenAt: number;
}

export interface UserStore {
	getByToken(token: string): Promise<UserRecord | undefined>;
	get(uid: string): Promise<UserRecord | undefined>;
	put(user: UserRecord): Promise<void>;
}

/** A finished game, persisted after the game ends (for match history later). */
export interface GameRecord {
	gameId: string;
	roomCode: string;
	mode: string;
	config: Record<string, unknown>;
	players: { uid: string | null; nickname: string; seat: number }[];
	startedAt: number;
	endedAt: number;
}

export interface RecordSink {
	save(record: GameRecord): Promise<void>;
}

export class MemoryUserStore implements UserStore {
	#byUid = new Map<string, UserRecord>();
	#byToken = new Map<string, string>();

	async getByToken(token: string) {
		const uid = this.#byToken.get(token);
		return uid ? this.#byUid.get(uid) : undefined;
	}

	async get(uid: string) {
		return this.#byUid.get(uid);
	}

	async put(user: UserRecord) {
		const old = this.#byUid.get(user.uid);
		if (old && old.token !== user.token) this.#byToken.delete(old.token);
		this.#byUid.set(user.uid, user);
		this.#byToken.set(user.token, user.uid);
	}
}

/** Keeps the last N records in memory. */
export class MemoryRecordSink implements RecordSink {
	readonly records: GameRecord[] = [];
	constructor(private readonly limit = 200) {}

	async save(record: GameRecord) {
		this.records.push(record);
		if (this.records.length > this.limit) this.records.splice(0, this.records.length - this.limit);
	}
}
