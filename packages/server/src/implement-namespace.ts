import type { NamespaceManifest } from "@nodecg/core";
import { mergeRecords } from "@nodecg/internal/utils";
import type { JsonValue, Promisable } from "type-fest";

export type FrontendConfig = {
	readonly dir: ReadonlyArray<string | URL>;
	readonly spa?: boolean;
	readonly vite?: { readonly root: string | URL };
};

export type RpcShape = Record<
	string,
	{ readonly request: unknown; readonly response: unknown }
>;

export type BaseNamespaceShape = {
	readonly replicant: Record<string, unknown>;
	readonly computed: Record<string, unknown>;
	readonly topic: Record<string, unknown>;
	readonly rpc: RpcShape;
};

export type SeedReplicant<out Replicant extends Record<string, unknown>> = {
	readonly [K in keyof Replicant & string]: () => Promisable<Replicant[K]>;
};

export type SourceSnapshot<out Replicant extends Record<string, unknown>> = {
	readonly [K in keyof Replicant & string]: Replicant[K];
};

export type CrossReplicantView<out Replicant extends Record<string, unknown>> =
	{
		readonly replicant: {
			readonly [K in keyof Replicant & string]: {
				readonly get: () => Replicant[K];
			};
		};
	};

export type ComputeContext = {
	readonly use: <S extends BaseNamespaceShape>(
		implemented: ImplementedNamespace<S>,
	) => CrossReplicantView<S["replicant"]>;
};

export type ImplementComputed<
	in Replicant extends Record<string, unknown>,
	out Computed extends Record<string, unknown>,
> = {
	readonly [K in keyof Computed & string]: (
		sources: SourceSnapshot<Replicant>,
		ctx: ComputeContext,
	) => Computed[K];
};

export type Subscribe<out Decoded> = (
	handler: (value: Decoded) => Promisable<void>,
) => Promise<() => Promise<void>>;

export type ReplicantField<in out Decoded> = {
	readonly get: () => Decoded;
	readonly set: (value: Decoded) => void;
	readonly update: (fn: (value: Decoded) => Decoded) => void;
	readonly validate: (value: Decoded) => Promise<JsonValue>;
	readonly subscribe: Subscribe<Decoded>;
};

export type ComputedField<out Decoded> = {
	readonly get: () => Decoded;
	readonly subscribe: Subscribe<Decoded>;
};

export type TopicField<in out Decoded> = {
	readonly publish: (value: Decoded) => Promise<void>;
	readonly subscribe: Subscribe<Decoded>;
};

export type RpcField<in Request, out Response> = (
	request: Request,
) => Promise<Response>;

export interface LoadedNamespace<
	in out Replicant extends Record<string, unknown> = Record<string, unknown>,
	out Computed extends Record<string, unknown> = Record<string, unknown>,
	in out Topic extends Record<string, unknown> = Record<string, unknown>,
	in out Rpc extends RpcShape = RpcShape,
> {
	readonly replicant: {
		readonly [K in keyof Replicant & string]: ReplicantField<Replicant[K]>;
	};
	readonly computed: {
		readonly [K in keyof Computed & string]: ComputedField<Computed[K]>;
	};
	readonly topic: {
		readonly [K in keyof Topic & string]: TopicField<Topic[K]>;
	};
	readonly rpc: {
		readonly [K in keyof Rpc & string]: RpcField<
			Rpc[K]["request"],
			Rpc[K]["response"]
		>;
	};
}

export type OnLoadContext<
	Replicant extends Record<string, unknown>,
	Computed extends Record<string, unknown>,
	Topic extends Record<string, unknown>,
	Rpc extends RpcShape,
> = LoadedNamespace<Replicant, Computed, Topic, Rpc> & {
	readonly use: UseCrossNamespace;
};

export type OnLoad<
	in out Replicant extends Record<string, unknown>,
	in Computed extends Record<string, unknown>,
	in out Topic extends Record<string, unknown>,
	in out Rpc extends RpcShape,
> = (
	ctx: OnLoadContext<Replicant, Computed, Topic, Rpc>,
) => Promisable<void | (() => Promisable<void>)>;

export type RpcReplicantAccessor<in out Decoded> = {
	readonly get: () => Decoded;
	readonly set: (value: Decoded) => void;
	readonly update: (fn: (value: Decoded) => Decoded) => void;
};

export type RpcComputedAccessor<out Decoded> = {
	readonly get: () => Decoded;
};

export type RpcTopicAccessor<in Decoded> = {
	readonly publish: (value: Decoded) => Promise<void>;
};

type RpcFieldAccessors<
	in out Replicant extends Record<string, unknown>,
	out Computed extends Record<string, unknown>,
	in out Topic extends Record<string, unknown>,
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

export type CrossNamespaceHandle<
	Replicant extends Record<string, unknown>,
	Computed extends Record<string, unknown>,
	Topic extends Record<string, unknown>,
	Rpc extends RpcShape,
> = RpcFieldAccessors<Replicant, Computed, Topic> & {
	readonly rpc: {
		readonly [K in keyof Rpc & string]: RpcField<
			Rpc[K]["request"],
			Rpc[K]["response"]
		>;
	};
};

export type UseCrossNamespace = <S extends BaseNamespaceShape>(
	implemented: ImplementedNamespace<S>,
) => CrossNamespaceHandle<S["replicant"], S["computed"], S["topic"], S["rpc"]>;

export type RpcContext<
	Replicant extends Record<string, unknown>,
	Computed extends Record<string, unknown>,
	Topic extends Record<string, unknown>,
> = RpcFieldAccessors<Replicant, Computed, Topic> & {
	readonly use: UseCrossNamespace;
};

export type ImplementRpc<
	in out Replicant extends Record<string, unknown>,
	in Computed extends Record<string, unknown>,
	in out Topic extends Record<string, unknown>,
	in out Rpc extends RpcShape,
> = {
	readonly [K in keyof Rpc & string]: (
		request: Rpc[K]["request"],
		ctx: RpcContext<Replicant, Computed, Topic>,
	) => Promisable<Rpc[K]["response"]>;
};

export type NamespaceOptions<
	in out Replicant extends Record<string, unknown>,
	in out Computed extends Record<string, unknown>,
	in out Topic extends Record<string, unknown>,
	in out Rpc extends RpcShape,
> = {
	readonly seedReplicant?: SeedReplicant<Replicant>;
	readonly implementComputed?: ImplementComputed<Replicant, Computed>;
	readonly implementRpc?: ImplementRpc<Replicant, Computed, Topic, Rpc>;
	readonly onLoad?: OnLoad<Replicant, Computed, Topic, Rpc>;
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

export interface ImplementedNamespace<in out S extends BaseNamespaceShape> {
	readonly manifest: NamespaceManifest<
		S["replicant"],
		S["computed"],
		S["topic"],
		S["rpc"]
	>;
	readonly impl:
		| (NamespaceOptions<S["replicant"], S["computed"], S["topic"], S["rpc"]> & {
				readonly frontend?: FrontendConfig;
		  })
		| undefined;
}

export interface WidenedImplementedNamespace {
	readonly manifest: NamespaceManifest<{}, {}, {}, {}>;
	readonly impl:
		| (Omit<NamespaceOptions<{}, {}, {}, {}>, "onLoad"> & {
				readonly onLoad?: (
					ctx: never,
				) => Promisable<void | (() => Promisable<void>)>;
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
		? [
				options?: {
					readonly frontend?: FrontendConfig;
					readonly onLoad?: OnLoad<Replicant, Computed, Topic, Rpc>;
				},
			]
		: [
				impl: RequiredOptions<Replicant, Computed, Topic, Rpc> & {
					readonly frontend?: FrontendConfig;
					readonly onLoad?: OnLoad<Replicant, Computed, Topic, Rpc>;
				},
			]
): ImplementedNamespace<{
	replicant: Replicant;
	computed: Computed;
	topic: Topic;
	rpc: Rpc;
}> {
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
			}) & {
		readonly onLoad?: OnLoad<Replicant, Computed, Topic, Rpc>;
		readonly frontend?: FrontendConfig;
	};

const combineOnLoad = <
	Replicant extends Record<string, unknown>,
	Computed extends Record<string, unknown>,
	Topic extends Record<string, unknown>,
	Rpc extends RpcShape,
>(
	base: OnLoad<Replicant, Computed, Topic, Rpc> | undefined,
	extension: OnLoad<Replicant, Computed, Topic, Rpc> | undefined,
): OnLoad<Replicant, Computed, Topic, Rpc> | undefined => {
	if (typeof base === "undefined") return extension;
	if (typeof extension === "undefined") return base;
	return async (ctx) => {
		const cleanupBase = await base(ctx);
		const cleanupExtension = await extension(ctx);
		return async () => {
			if (typeof cleanupExtension === "function") await cleanupExtension();
			if (typeof cleanupBase === "function") await cleanupBase();
		};
	};
};

export function implementExtendedNamespace<
	Replicant extends Record<string, unknown>,
	Computed extends Record<string, unknown>,
	Topic extends Record<string, unknown>,
	Rpc extends RpcShape,
	const Base extends ImplementedNamespace<any>,
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
): ImplementedNamespace<{
	replicant: Replicant;
	computed: Computed;
	topic: Topic;
	rpc: Rpc;
}> {
	const baseFrontend = implemented.impl?.frontend;
	const frontend =
		baseFrontend && additional.frontend
			? {
					...baseFrontend,
					...additional.frontend,
					dir: [...new Set([...baseFrontend.dir, ...additional.frontend.dir])],
				}
			: (additional.frontend ?? baseFrontend);
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
			onLoad: combineOnLoad(implemented.impl?.onLoad, additional.onLoad),
			frontend,
		},
	};
}
