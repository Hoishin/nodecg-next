import { loadNamespace } from "@nodecg/client";
import { describe, expect, test, vi } from "vitest";

import { crossManifest, extendedManifest } from "../../src/shared/manifests.ts";

describe("cross-namespace rpc via ctx.use", () => {
	test("an rpc writes another namespace's replicant", async () => {
		const cross = await loadNamespace(crossManifest);
		const extended = await loadNamespace(extendedManifest);
		const before = await extended.replicant.score.get();

		const returned = await cross.rpc.addScore.call(5);

		expect(returned).toBe(before + 5);
		expect(await extended.replicant.score.get()).toBe(before + 5);
	});
});

describe("cross-namespace computed via ctx.use", () => {
	test("recomputes when the source in the other namespace changes", async () => {
		const cross = await loadNamespace(crossManifest);
		const extended = await loadNamespace(extendedManifest);
		const score = await extended.replicant.score.get();

		expect(await cross.computed.scaledScore.get()).toBe(score * 2);

		const received: number[] = [];
		const cancel = await cross.computed.scaledScore.subscribe((value) => {
			received.push(value);
		});
		await vi.waitFor(() => expect(received.at(-1)).toBe(score * 2));

		await cross.rpc.addScore.call(3);

		await vi.waitFor(() => expect(received.at(-1)).toBe((score + 3) * 2));
		await cancel();
	});
});
