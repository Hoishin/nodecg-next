import type {
	EmptyNamespaceFields,
	NamespaceManifest,
	WidestNamespaceFields,
} from "@nodecg-next/core";
import {
	findCaseClash,
	mapEffectValues,
	mapValues,
} from "@nodecg-next/internal/utils";
import {
	Effect,
	type HKT,
	Layer,
	ManagedRuntime,
	Option,
	Path,
	Schema,
	Scope,
} from "effect";
import { FetchHttpClient } from "effect/http";

import { adaptAuthClient, makeAuthClient } from "./auth-client.ts";
import {
	adaptNamespace,
	type BuiltNamespace,
	type LoadedNamespace,
	loadNamespaceEffect,
} from "./load-namespace.ts";
import { httpFieldTransport } from "./services/field-transport/http-field-transport.ts";
import { webSocketMessageChannel } from "./services/message-channel/websocket-message-channel.ts";

export class DuplicateNamespace extends Schema.TaggedError<DuplicateNamespace>()(
	"DuplicateNamespace",
	{ namespace: Schema.String, clash: Schema.String },
) {
	override readonly message =
		this.namespace === this.clash
			? `Namespace "${this.namespace}" was loaded twice`
			: `Namespace "${this.namespace}" differs from "${this.clash}" only in case`;
}

export type LoadNodeCGOptions<
	Shapes extends Record<string, WidestNamespaceFields>,
> = {
	readonly baseUrl?: string;
	readonly namespaces: {
		readonly [K in keyof Shapes & string]: NamespaceManifest<Shapes[K]>;
	};
};

type NamespaceHandle<S extends WidestNamespaceFields> = Omit<
	LoadedNamespace<S>,
	"dispose"
>;

interface ManifestLambda extends HKT.TypeLambda {
	readonly Target: EmptyNamespaceFields;
	readonly type: NamespaceManifest<this["Target"]>;
}

interface BuiltNamespaceLambda extends HKT.TypeLambda {
	readonly Target: EmptyNamespaceFields;
	readonly type: BuiltNamespace<this["Target"]>;
}

interface NamespaceHandleLambda extends HKT.TypeLambda {
	readonly Target: EmptyNamespaceFields;
	readonly type: NamespaceHandle<this["Target"]>;
}

export const loadNodeCGEffect = Effect.fn("loadNodeCGEffect")(function* <
	Shapes extends Record<string, WidestNamespaceFields>,
>(options: LoadNodeCGOptions<Shapes>) {
	const widened: Readonly<
		Record<string, NamespaceManifest<EmptyNamespaceFields>>
	> = options.namespaces;

	const loaded = new Set<string>();
	for (const { namespace } of Object.values(widened)) {
		if (loaded.has(namespace)) {
			return yield* DuplicateNamespace.make({ namespace, clash: namespace });
		}
		loaded.add(namespace);
	}
	const clash = findCaseClash(loaded, []);
	if (Option.isSome(clash)) {
		return yield* DuplicateNamespace.make({
			namespace: clash.value.name,
			clash: clash.value.clash,
		});
	}

	const namespaces = yield* mapEffectValues<
		ManifestLambda,
		BuiltNamespaceLambda
	>()((manifest) => loadNamespaceEffect(manifest))<Shapes>(options.namespaces);
	const auth = yield* makeAuthClient(options.baseUrl);
	return { namespaces, auth };
});

export interface LoadedNodeCG<
	Shapes extends Record<string, WidestNamespaceFields>,
> {
	readonly namespaces: {
		readonly [K in keyof Shapes & string]: NamespaceHandle<Shapes[K]>;
	};
	readonly auth: ReturnType<typeof adaptAuthClient>;
	readonly dispose: () => void;
}

/**
 * Client-side entrypoint loading every namespace of the record over one connection
 */
export async function loadNodeCG<
	Shapes extends Record<string, WidestNamespaceFields>,
>(options: LoadNodeCGOptions<Shapes>): Promise<LoadedNodeCG<Shapes>> {
	const runtime = ManagedRuntime.make(
		Layer.mergeAll(
			httpFieldTransport(options.baseUrl),
			webSocketMessageChannel(options.baseUrl),
			FetchHttpClient.layer,
		).pipe(Layer.provide(Path.layer)),
	);

	const { namespaces, auth } = await runtime.runPromise(
		loadNodeCGEffect(options).pipe(
			Scope.provide(runtime.scope),
			Effect.onError(() => runtime.disposeEffect),
		),
	);

	return {
		namespaces: mapValues<BuiltNamespaceLambda, NamespaceHandleLambda>(
			(built) => adaptNamespace(runtime, built),
		)(namespaces),
		auth: adaptAuthClient(runtime, auth),
		dispose: runtime.dispose,
	};
}
