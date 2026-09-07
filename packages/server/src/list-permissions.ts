import { getRolesFromIdentity } from "@nodecg-next/core";
import type { Identity, MePayload } from "@nodecg-next/internal";
import { Effect } from "effect";

import { FieldRegistryService } from "./field-registry.ts";

export const listPermissions = Effect.fn("listPermissions")(function* (
	identity: Identity,
) {
	const { declaredRoles } = yield* FieldRegistryService;
	const held = getRolesFromIdentity(identity);
	const namespaces: Record<string, MePayload["namespaces"][string]> = {};
	for (const [namespace, declared] of declaredRoles) {
		namespaces[namespace] = { roles: held.intersection(declared) };
	}
	return namespaces;
});
