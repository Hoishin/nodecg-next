import type { ResolvedPermission } from "@nodecg/core";
import { CurrentIdentity } from "@nodecg/internal";
import { Data, Effect } from "effect";

export class FieldPermissionDenied extends Data.TaggedError(
	"FieldPermissionDenied",
)<{
	namespace: string;
	name: string;
	operation: "read" | "write";
}> {
	override readonly message = `Permission denied to ${this.operation} "${this.name}" in "${this.namespace}"`;
}

export const requirePermission = (
	permission: ResolvedPermission,
	namespace: string,
	name: string,
	operation: "read" | "write",
) =>
	Effect.gen(function* () {
		const identity = yield* CurrentIdentity;
		const allowed =
			operation === "read"
				? permission.canRead(identity)
				: permission.canWrite(identity);
		if (!allowed) {
			return yield* new FieldPermissionDenied({ namespace, name, operation });
		}
	});
