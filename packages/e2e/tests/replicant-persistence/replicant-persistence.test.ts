import { loadNodeCG } from "@nodecg-next/client";
import { describe, expect, test } from "vitest";
import { commands } from "vitest/browser";

import { suiteBase } from "../../src/client/suite-base.ts";
import { persistenceManifest } from "./manifest.ts";

const base = suiteBase("replicant-persistence");

describe("replicant persistence", () => {
	test("restores only persisted replicants after a restart", async () => {
		const nodecg = await loadNodeCG({
			baseUrl: base,
			namespaces: { persistence: persistenceManifest },
		});
		await nodecg.namespaces.persistence.replicant.live.set(7);
		await nodecg.namespaces.persistence.replicant.score.set(7);
		nodecg.dispose();

		await commands.restartServer("replicant-persistence");

		const {
			namespaces: { persistence },
		} = await loadNodeCG({
			baseUrl: base,
			namespaces: { persistence: persistenceManifest },
		});
		expect(await persistence.replicant.live.get()).toBe(0);
		expect(await persistence.replicant.score.get()).toBe(7);
	});
});
