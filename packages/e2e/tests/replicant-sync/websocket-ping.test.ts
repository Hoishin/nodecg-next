import { expect, onTestFinished, test, vi } from "vitest";

import { suiteBase } from "../../src/client/suite-base.ts";

test("answers a ping with a pong", async () => {
	const url = new URL(`${suiteBase("replicant-sync")}/ws/internal`);
	url.protocol = "ws:";
	const socket = new WebSocket(url);
	onTestFinished(() => socket.close());
	const replies: unknown[] = [];
	socket.onmessage = (event) => replies.push(event.data);
	socket.onopen = () => socket.send('{"_tag":"ping"}');

	await vi.waitFor(() => expect(replies).toEqual(['{"_tag":"pong"}']));
});
