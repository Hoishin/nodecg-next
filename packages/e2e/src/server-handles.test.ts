import { loadNamespace } from "@nodecg/client";
import { describe, expect, test, vi } from "vitest";

import { fixtureManifest } from "./fixture-replicant.ts";

describe("entry-script namespace handles", () => {
	test("a source change is mirrored by the entry script's handle subscription", async () => {
		const ns = await loadNamespace(fixtureManifest);

		await ns.replicant.mirrorSource.set(21);

		await vi.waitFor(async () => {
			expect(await ns.replicant.mirror.get()).toBe(21);
		});
	});
});
