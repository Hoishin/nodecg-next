import {
	implementExtendedNamespace,
	implementNamespace,
	loadNodeCG,
} from "@nodecg/server";

import { makeFakeAuthProvider } from "./fake-auth-provider.ts";
import {
	baseManifest,
	chainManifest,
	crossManifest,
	extendedManifest,
	fixtureManifest,
} from "./fixture-replicant.ts";

const fixture = implementNamespace(fixtureManifest, {
	seedReplicant: {
		count: () => 0,
		mirrorSource: () => 0,
		mirror: () => 0,
		label: () => "hello",
		secret: () => "classified",
		producerOnly: () => "producers-only",
		membersOnly: () => "members-only",
	},
	implementComputed: {
		doubledCount: (ctx) => ctx.replicant.count.get() * 2,
		summary: (ctx) =>
			ctx.replicant.count.get() > 0
				? `${ctx.replicant.label.get()} x${ctx.replicant.count.get()}`
				: "idle",
	},
	implementRpc: {
		echo: (request: string) => request.toUpperCase(),
		bump: (request: number, ctx) => {
			ctx.replicant.count.update((count) => count + request);
			return ctx.replicant.count.get();
		},
	},
	frontend: {
		dir: [import.meta.resolve("./fixture-frontend")],
	},
});

const baseImplemented = implementNamespace(baseManifest, {
	seedReplicant: { score: () => 0 },
	frontend: {
		dir: [import.meta.resolve("./fixture-frontend-spa")],
		spa: true,
	},
});
const extended = implementExtendedNamespace(extendedManifest, baseImplemented, {
	seedReplicant: { bonus: () => 0 },
	implementComputed: {
		total: (ctx) => ctx.replicant.score.get() + ctx.replicant.bonus.get(),
	},
	frontend: {
		dir: [import.meta.resolve("./fixture-frontend-extra")],
	},
});

const chain = implementNamespace(chainManifest, {
	seedReplicant: { points: () => 0, target: () => 0 },
	implementComputed: {
		lead: (ctx) => ctx.replicant.points.get() - ctx.replicant.target.get(),
		status: (ctx) => {
			const lead = ctx.computed.lead.get();
			return lead > 0 ? "ahead" : lead < 0 ? "behind" : "level";
		},
	},
});

const cross = implementNamespace(crossManifest, {
	seedReplicant: { factor: () => 2 },
	implementComputed: {
		scaledScore: (ctx) =>
			ctx.replicant.factor.get() * ctx.use(extended).replicant.score.get(),
	},
	implementRpc: {
		addScore: (points, ctx) => {
			ctx.use(extended).replicant.score.update((score) => score + points);
			return ctx.use(extended).replicant.score.get();
		},
	},
});

process.env["SUPERADMINS"] = "dev:root";

const nodecg = await loadNodeCG({
	namespaces: { cross, fixture, extended, chain },
	authProviders: [
		makeFakeAuthProvider("dev", [{ id: "alice", displayName: "Alice" }]),
	],
	onReady: () => {
		if (typeof process.send === "undefined") {
			throw new Error("start-server.ts must be spawned with an IPC channel");
		}
		process.send("ready");
	},
});

const { mirrorSource, mirror } = nodecg.namespaces.fixture.replicant;
await mirrorSource.subscribe((value) => {
	mirror.set(value);
});

nodecg.start();
