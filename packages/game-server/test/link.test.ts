import { test } from "node:test";
import assert from "node:assert/strict";
import { Link, type GameSocket } from "../src/rooms/link.ts";

function sock() {
	const sent: string[] = [];
	let closed: number | undefined;
	const s: GameSocket & { sent: string[]; closed?: number } = {
		sent,
		send: d => sent.push(d),
		close: c => {
			closed = c;
			s.closed = closed;
		},
	};
	return s;
}

const mk = (onExpire = () => {}, maxBufferBytes = 1024, graceMs = 50) => new Link("u", { maxBufferBytes, graceMs, onExpire });

test("frames are numbered and acks trim the buffer", () => {
	const l = mk();
	const a = sock();
	l.attach(a);
	l.push("x");
	l.push("y");
	assert.deepEqual(a.sent, ["1\nx", "2\ny"]);
	assert.equal(l.receive("\u0006ack:1"), undefined);
	assert.ok(!l.canResume(0));
	assert.ok(l.canResume(1));
});

test("resume replays only missed frames and reports inbound progress", () => {
	const l = mk();
	const a = sock();
	l.attach(a);
	assert.equal(l.receive("1\nhello"), "hello");
	assert.equal(l.receive("1\nhello"), undefined, "duplicate dropped");
	l.push("a");
	l.push("b");
	l.detach(a);
	l.push("c");
	const b = sock();
	assert.ok(l.canResume(1));
	l.attach(b, { serverSeq: 1, clientSeq: 1 });
	assert.deepEqual(b.sent, ["\u0006resume:1", "2\nb", "3\nc"]);
});

test("buffer overflow makes old positions unresumable", () => {
	const l = mk(undefined, 10);
	l.attach(sock());
	for (let i = 0; i < 10; i++) l.push("12345");
	assert.ok(!l.canResume(0));
	assert.ok(l.canResume(9));
	assert.ok(!l.canResume(11), "future seq is not resumable");
});

test("grace period expires only while detached", async () => {
	let expired = 0;
	const l = mk(() => expired++, 1024, 30);
	const a = sock();
	l.attach(a);
	l.detach(a);
	await new Promise(r => setTimeout(r, 10));
	l.attach(sock(), { serverSeq: 0, clientSeq: 0 });
	await new Promise(r => setTimeout(r, 50));
	assert.equal(expired, 0);
	const c = sock();
	l.attach(c);
	l.detach(c);
	await new Promise(r => setTimeout(r, 50));
	assert.equal(expired, 1);
});

test("a second socket supersedes the first", () => {
	const l = mk();
	const a = sock();
	const b = sock();
	l.attach(a);
	l.attach(b);
	assert.equal(a.closed, 4001);
	assert.equal(l.detach(a), false);
});
