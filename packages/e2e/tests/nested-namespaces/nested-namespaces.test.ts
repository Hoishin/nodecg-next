import { loadNodeCG } from "@nodecg-next/client";
import { describe, expect, onTestFinished, test } from "vitest";

import { makeAuthHelpers } from "../../src/client/auth.ts";
import { suiteBase } from "../../src/client/suite-base.ts";
import { nestAssetsManifest } from "./manifest.ts";

const base = suiteBase("nested-namespaces");
const { createUser, grantAsAdmin, login, logout } = makeAuthHelpers(base);

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

describe("role links", () => {
	test("the parent role lets its holder write the child", async () => {
		const operatorUserId = await createUser("operator");
		await grantAsAdmin(operatorUserId, {
			namespace: "e2e-nest",
			name: "operator",
		});
		await login("operator");
		onTestFinished(logout);
		const {
			namespaces: { assets },
			dispose,
		} = await loadNodeCG({
			baseUrl: base,
			namespaces: { assets: nestAssetsManifest },
		});
		onTestFinished(dispose);

		await assets.replicant.uploads.set(3);

		expect(await assets.replicant.uploads.get()).toBe(3);
	});

	test("a parent role without a link cannot write the child", async () => {
		const viewerUserId = await createUser("viewer");
		await grantAsAdmin(viewerUserId, {
			namespace: "e2e-nest",
			name: "viewer",
		});
		await login("viewer");
		onTestFinished(logout);
		const {
			namespaces: { assets },
			dispose,
		} = await loadNodeCG({
			baseUrl: base,
			namespaces: { assets: nestAssetsManifest },
		});
		onTestFinished(dispose);

		await expect(assets.replicant.uploads.set(1)).rejects.toThrow(
			/Permission denied/,
		);
	});
});
