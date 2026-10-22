import { loadNamespace } from "@nodecg-next/client";
import { describe, expect, test } from "vitest";
import { commands } from "vitest/browser";

import { suiteBase } from "../../src/client/suite-base.ts";
import { persistenceManifest } from "./manifest.ts";

const base = suiteBase("replicant-persistence");

describe("replicant persistence", () => {
	test("restores only persisted replicants after a restart", async () => {
		const ns = await loadNamespace(persistenceManifest, { baseUrl: base });
		await ns.replicant.live.set(7);
		await ns.replicant.score.set(7);
		ns.dispose();

		await commands.restartServer("replicant-persistence");

		const restarted = await loadNamespace(persistenceManifest, {
			baseUrl: base,
		});
		expect(await restarted.replicant.live.get()).toBe(0);
		expect(await restarted.replicant.score.get()).toBe(7);
	});
});
