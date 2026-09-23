import { getRolesForNamespace } from "@nodecg-next/core";
import type { Identity, MePayload } from "@nodecg-next/internal";
import { Array, Effect } from "effect";

import { FieldRegistryService } from "./field-registry.ts";

// TODO: move to local scope of call site
export const listPermissions = Effect.fn("listPermissions")(function* (
	identity: Identity,
) {
	const { declaredRoles } = yield* FieldRegistryService;
	const namespaces: Record<string, MePayload["namespaces"][string]> = {};
	for (const [namespace, declared] of declaredRoles) {
		namespaces[namespace] = {
			roles: Array.intersection(
				getRolesForNamespace(identity, namespace),
				declared,
			),
		};
	}
	return namespaces;
});
