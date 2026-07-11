import { HttpApiBuilder } from "@effect/platform";
import { Layer } from "effect";

import { buildFieldRegistry } from "../../field-registry.ts";
import type { LoadedNamespace } from "../../load-namespace.ts";
import { RootApi } from "../root-api.ts";
import { buildInternalGroups } from "./api-internal.ts";
import { buildPublicGroups } from "./api-v0.ts";

export const buildRootApi = (options: {
	namespaces: ReadonlyArray<LoadedNamespace>;
}) => {
	const registry = buildFieldRegistry(options.namespaces);
	return HttpApiBuilder.api(RootApi).pipe(
		Layer.provide(buildInternalGroups(registry)),
		Layer.provide(buildPublicGroups(registry)),
	);
};
