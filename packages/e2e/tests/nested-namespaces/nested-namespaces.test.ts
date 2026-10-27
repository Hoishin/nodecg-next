import { loadNodeCG } from "@nodecg-next/client";
import { describe, expect, onTestFinished, test } from "vitest";

import { suiteBase } from "../../src/client/suite-base.ts";
import { nestAssetsManifest } from "./manifest.ts";

const base = suiteBase("nested-namespaces");

describe("children", () => {
	test("a child loads with its parent", async () => {
		const {
			namespaces: { assets },
			dispose,
		} = await loadNodeCG({
			baseUrl: base,
			namespaces: { assets: nestAssetsManifest },
		});
		onTestFinished(dispose);

		expect(await assets.replicant.files.get()).toBe(4);
	});
});
