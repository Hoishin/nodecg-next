import type { NamespaceManifest } from "@nodecg/core";
import { mergeRecords } from "@nodecg/internal/utils";
import type { Promisable } from "type-fest";

export type FrontendConfig = {
	readonly dir: string | URL;
	readonly vite?: { readonly root: string | URL; readonly spa?: boolean };
};

export type RpcShape = Record<
	string,
	{ readonly request: unknown; readonly response: unknown }
>;

export type SeedReplicant<Replicant extends Record<string, unknown>> = {
	readonly [K in keyof Replicant & string]: () => Promisable<Replicant[K]>;
};

export type SourceSnapshot<Replicant extends Record<string, unknown>> = {
	readonly [K in keyof Replicant & string]: Replicant[K];
};

export type ImplementComputed<
	Replicant extends Record<string, unknown>,
	Computed extends Record<string, unknown>,
> = {
	readonly [K in keyof Computed & string]: (
		sources: SourceSnapshot<Replicant>,
	) => Computed[K];
};

export type RpcReplicantAccessor<Decoded> = {
	readonly get: () => Decoded;
	readonly set: (value: Decoded) => void;
	readonly update: (fn: (value: Decoded) => Decoded) => void;
};

export type RpcComputedAccessor<Decoded> = {
	readonly get: () => Decoded;
};

export type RpcTopicAccessor<Decoded> = {
	readonly publish: (value: Decoded) => Promise<void>;
};

/**
 * The second argument handed to every rpc handler: a live view of the
 * namespace's own non-rpc field groups, built once at load. Mirrors the public
 * server surface minus topic `subscribe` (streaming) and `rpc` (self-referential).
 */
export type RpcContext<
	Replicant extends Record<string, unknown>,
	Computed extends Record<string, unknown>,
	Topic extends Record<string, unknown>,
> = {
	readonly replicant: {
		readonly [K in keyof Replicant & string]: RpcReplicantAccessor<
			Replicant[K]
		>;
	};
	readonly computed: {
		readonly [K in keyof Computed & string]: RpcComputedAccessor<Computed[K]>;
	};
	readonly topic: {
		readonly [K in keyof Topic & string]: RpcTopicAccessor<Topic[K]>;
	};
};

export type ImplementRpc<
	Replicant extends Record<string, unknown>,
	Computed extends Record<string, unknown>,
	Topic extends Record<string, unknown>,
	Rpc extends RpcShape,
> = {
	readonly [K in keyof Rpc & string]: (
		request: Rpc[K]["request"],
		ctx: RpcContext<Replicant, Computed, Topic>,
	) => Promisable<Rpc[K]["response"]>;
};

export type NamespaceOptions<
	Replicant extends Record<string, unknown>,
	Computed extends Record<string, unknown>,
	Topic extends Record<string, unknown>,
	Rpc extends RpcShape,
> = {
	readonly seedReplicant?: SeedReplicant<Replicant>;
	readonly implementComputed?: ImplementComputed<Replicant, Computed>;
	readonly implementRpc?: ImplementRpc<Replicant, Computed, Topic, Rpc>;
};

export type RequiredOptions<
	Replicant extends Record<string, unknown>,
	Computed extends Record<string, unknown>,
	Topic extends Record<string, unknown>,
	Rpc extends RpcShape,
> = ([keyof Replicant] extends [never]
	? {}
	: { readonly seedReplicant: SeedReplicant<Replicant> }) &
	([keyof Computed] extends [never]
		? {}
		: { readonly implementComputed: ImplementComputed<Replicant, Computed> }) &
	([keyof Rpc] extends [never]
		? {}
		: {
				readonly implementRpc: ImplementRpc<Replicant, Computed, Topic, Rpc>;
			});

export interface ImplementedNamespace<
	Replicant extends Record<string, unknown> = Record<string, unknown>,
	Computed extends Record<string, unknown> = Record<string, unknown>,
	Topic extends Record<string, unknown> = Record<string, unknown>,
	Rpc extends RpcShape = RpcShape,
> {
	readonly manifest: NamespaceManifest<Replicant, Computed, Topic, Rpc>;
	readonly impl:
		| (NamespaceOptions<Replicant, Computed, Topic, Rpc> & {
				readonly frontend?: FrontendConfig;
		  })
		| undefined;
}

export function implementNamespace<
	Replicant extends Record<string, unknown> = {},
	Computed extends Record<string, unknown> = {},
	Topic extends Record<string, unknown> = {},
	Rpc extends RpcShape = {},
>(
	manifest: NamespaceManifest<Replicant, Computed, Topic, Rpc>,
	...rest: [keyof Replicant | keyof Computed | keyof Rpc] extends [never]
		? [options?: { readonly frontend?: FrontendConfig }]
		: [
				impl: RequiredOptions<Replicant, Computed, Topic, Rpc> & {
					readonly frontend?: FrontendConfig;
				},
			]
): ImplementedNamespace<Replicant, Computed, Topic, Rpc> {
	const [impl] = rest;
	return { manifest, impl };
}

type RelaxCovered<O, Covered extends PropertyKey> = Omit<O, Covered> &
	Partial<Pick<O, Extract<keyof O, Covered>>>;

type ExtensionSupplement<
	Replicant extends Record<string, unknown>,
	Computed extends Record<string, unknown>,
	Topic extends Record<string, unknown>,
	Rpc extends RpcShape,
	CoveredReplicant extends PropertyKey,
	CoveredComputed extends PropertyKey,
	CoveredRpc extends PropertyKey,
> = ([keyof Omit<Replicant, CoveredReplicant>] extends [never]
	? {
			readonly seedReplicant?: RelaxCovered<
				SeedReplicant<Replicant>,
				CoveredReplicant
			>;
		}
	: {
			readonly seedReplicant: RelaxCovered<
				SeedReplicant<Replicant>,
				CoveredReplicant
			>;
		}) &
	([keyof Omit<Computed, CoveredComputed>] extends [never]
		? {
				readonly implementComputed?: RelaxCovered<
					ImplementComputed<Replicant, Computed>,
					CoveredComputed
				>;
			}
		: {
				readonly implementComputed: RelaxCovered<
					ImplementComputed<Replicant, Computed>,
					CoveredComputed
				>;
			}) &
	([keyof Omit<Rpc, CoveredRpc>] extends [never]
		? {
				readonly implementRpc?: RelaxCovered<
					ImplementRpc<Replicant, Computed, Topic, Rpc>,
					CoveredRpc
				>;
			}
		: {
				readonly implementRpc: RelaxCovered<
					ImplementRpc<Replicant, Computed, Topic, Rpc>,
					CoveredRpc
				>;
			});

export function implementExtendedNamespace<
	Replicant extends Record<string, unknown>,
	Computed extends Record<string, unknown>,
	Topic extends Record<string, unknown>,
	Rpc extends RpcShape,
	const Base extends ImplementedNamespace<any, any, any, any>,
>(
	manifest: NamespaceManifest<Replicant, Computed, Topic, Rpc>,
	implemented: Base,
	additional: ExtensionSupplement<
		Replicant,
		Computed,
		Topic,
		Rpc,
		keyof Base["manifest"]["replicant"] & string,
		keyof Base["manifest"]["computed"] & string,
		keyof Base["manifest"]["rpc"] & string
	>,
	options?: {
		readonly frontend?: FrontendConfig;
	},
): ImplementedNamespace<Replicant, Computed, Topic, Rpc> {
	return {
		manifest,
		impl: {
			seedReplicant: mergeRecords<SeedReplicant<Replicant>>(
				implemented.impl?.seedReplicant,
				additional.seedReplicant,
			),
			implementComputed: mergeRecords<ImplementComputed<Replicant, Computed>>(
				implemented.impl?.implementComputed,
				additional.implementComputed,
			),
			implementRpc: mergeRecords<ImplementRpc<Replicant, Computed, Topic, Rpc>>(
				implemented.impl?.implementRpc,
				additional.implementRpc,
			),
			frontend: options?.frontend ?? implemented.impl?.frontend,
		},
	};
}
