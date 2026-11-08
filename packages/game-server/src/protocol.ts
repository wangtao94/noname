// Control-plane protocol between the lobby shell and the server (JSON over WebSocket /ws).
// The game plane (/ws/game) carries the engine's own messages unchanged.

export const PROTOCOL_VERSION = 1;

export interface MemberView {
	uid: string;
	nickname: string;
	avatar: string;
	online: boolean;
}

export interface RoomView {
	code: string;
	ownerId: string;
	mode: string;
	config: Record<string, unknown>;
	members: MemberView[];
	status: "lobby" | "playing" | "ended";
	/** current game (present while playing / ended) */
	game?: { id: string; startedAt: number; endedAt?: number };
	maxPlayers: number;
}

export interface ModeOption {
	key: string;
	name: string;
	init: unknown;
	/** select options: value -> label */
	item?: Record<string, string>;
	/** free text input */
	input?: boolean;
	intro?: string;
	frequent?: boolean;
}

export interface ModeInfo {
	id: string;
	name: string;
	options: ModeOption[];
	identityTable?: string[][];
}

export interface PackInfo {
	id: string;
	name: string;
	count: number;
}
export interface BanCandidate {
	id: string;
	name: string;
	pack: string;
}
export interface PackCatalog {
	characterPacks: PackInfo[];
	cardPacks: PackInfo[];
	defaultCharacterPacks: string[];
	defaultCardPacks: string[];
}
export interface RoomSummary {
	code: string;
	mode: string;
	modeName: string;
	ownerName: string;
	players: number;
	maxPlayers: number;
	status: RoomView["status"];
}

export type ClientMsg = { t: "rooms.watch"; on: boolean } | { t: "hello"; token: string; nickname?: string; avatar?: string } | { t: "profile"; nickname?: string; avatar?: string } | { t: "room.create"; mode?: string; config?: Record<string, unknown> } | { t: "room.join"; code: string } | { t: "room.leave" } | { t: "room.dissolve" } | { t: "room.config"; mode?: string; config?: Record<string, unknown> } | { t: "room.kick"; uid: string } | { t: "room.transfer"; uid: string } | { t: "room.start" } | { t: "room.restart" } | { t: "room.back" } | { t: "ping" };

export type ServerMsg = { t: "welcome"; uid: string; nickname: string; avatar: string; version: number; serverVersion: string; extensions: string[]; modes: ModeInfo[]; packs: PackCatalog } | { t: "rooms"; rooms: RoomSummary[] } | { t: "room"; room: RoomView | null } | { t: "error"; code: string; message: string } | { t: "pong" };

export interface CharacterDetail {
	id: string;
	name: string;
	image: string;
	group: string;
	hp: string;
	skills: { name: string; description: string }[];
}
export interface CardDetail {
	id: string;
	name: string;
	type: string;
	count: number;
	description: string;
}
export interface PackDetails {
	character: Record<string, CharacterDetail[]>;
	card: Record<string, CardDetail[]>;
}
