import { loadNodeCG } from "@nodecg-next/client";
import { describe, expect, onTestFinished, test, vi } from "vitest";

import { suiteBase } from "../../src/client/suite-base.ts";
import { telemetryManifest } from "./manifest.ts";

const base = suiteBase("telemetry");

const load = async () => {
	const nodecg = await loadNodeCG({
		baseUrl: base,
		namespaces: { telemetry: telemetryManifest },
	});
	onTestFinished(nodecg.dispose);
	return nodecg;
};

describe("telemetry", () => {
	test("runs a request in its own trace", async () => {
		const { telemetry } = (await load()).namespaces;

		await fetch(`${base}/api/internal/me?marker=root`);

		await vi.waitFor(async () => {
			const spans = await telemetry.rpc.endedSpans.call("GET");
			expect(spans).toContainEqual(
				expect.objectContaining({ root: true, query: "marker=REDACTED" }),
			);
			expect(spans.map(({ root }) => root)).not.toContain(false);
		});
	});

	test("runs a later persistence write in its own trace", async () => {
		const { telemetry } = (await load()).namespaces;

		await telemetry.replicant.score.set(1);

		await vi.waitFor(async () => {
			const spans = await telemetry.rpc.endedSpans.call(
				"ReplicantRepository.write",
			);
			expect(spans).toHaveLength(2);
			expect(spans[1]?.root).toBe(true);
		});
	});

	test("redacts query values on request spans", async () => {
		const { telemetry } = (await load()).namespaces;

		await fetch(`${base}/api/internal/me?code=query-secret&=unnamed-secret`);

		await vi.waitFor(async () => {
			const spans = await telemetry.rpc.endedSpans.call("GET");
			expect(spans.map(({ query }) => query)).toContain(
				"code=REDACTED&=REDACTED",
			);
		});
	});

	test("does not report a closed client as an error", async () => {
		const closing = await load();
		const { telemetry } = (await load()).namespaces;

		closing.dispose();

		await vi.waitFor(async () => {
			const spans = await telemetry.rpc.endedSpans.call("GET");
			const sockets = spans.filter(({ path }) =>
				path?.endsWith("/ws/internal"),
			);
			expect(sockets).not.toHaveLength(0);
			expect(sockets.map(({ failed }) => failed)).not.toContain(true);
		});
	});
});
