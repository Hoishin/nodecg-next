// Apply patch produced from diff.ts

import { Data, Either, Match, Option } from "effect";
import type { JsonValue } from "type-fest";

import { cloneJson, type MutableJson } from "../utils/clone.ts";
import type { ChangeOp, Pointer } from "./schema.ts";

const unescapeToken = (token: string) =>
	token.replaceAll("~1", "/").replaceAll("~0", "~");

const parsePointer = (pointer: Pointer) => {
	const tokens = pointer.split("/");
	// Drop the empty string before the leading slash
	tokens.shift();
	return tokens.map(unescapeToken);
};

const parseIndex = (token: string) => {
	const index = Number.parseInt(token);
	if (Number.isSafeInteger(index) && index >= 0 && index.toString() === token) {
		return Option.some(index);
	}
	return Option.none();
};

// Why an op did not apply. Every cause rejects the same way, the tag carries the diagnostics.
export type ApplyFailure = Data.TaggedEnum<{
	NonContainer: { readonly token: string };
	InvalidIndex: { readonly token: string };
	IndexOutOfBounds: { readonly index: number };
	MissingKey: { readonly key: string };
	ForbiddenKey: { readonly key: string };
	ImmovableRoot: {};
}>;
export const ApplyFailure = Data.taggedEnum<ApplyFailure>();

const getChild = (
	parent: MutableJson,
	token: string,
): Either.Either<MutableJson, ApplyFailure> => {
	// Primitive
	if (parent === null || typeof parent !== "object") {
		return Either.left(ApplyFailure.NonContainer({ token }));
	}

	if (Array.isArray(parent)) {
		const idx = parseIndex(token);
		if (Option.isNone(idx)) {
			return Either.left(ApplyFailure.InvalidIndex({ token }));
		}
		const element = parent[idx.value];
		if (typeof element === "undefined") {
			return Either.left(ApplyFailure.IndexOutOfBounds({ index: idx.value }));
		}
		return Either.right(element);
	}

	// hasOwn to avoid "constructor" and other prototype properties
	if (!Object.hasOwn(parent, token)) {
		return Either.left(ApplyFailure.MissingKey({ key: token }));
	}
	const value = parent[token];
	if (typeof value === "undefined") {
		return Either.left(ApplyFailure.MissingKey({ key: token }));
	}
	return Either.right(value);
};

const navigate = (root: MutableJson, tokens: ReadonlyArray<string>) =>
	tokens.reduce<Either.Either<MutableJson, ApplyFailure>>(
		(cur, token) =>
			cur.pipe(Either.flatMap((currentValue) => getChild(currentValue, token))),
		Either.right(root),
	);

/**
 * RFC 6902 add: returns the new document
 * - array: insert at the index, "-" appends at the end
 * - object: upsert on the key
 * - "" replaces the whole document
 */
const add = (
	root: MutableJson,
	pointer: Pointer,
	value: MutableJson,
): Either.Either<MutableJson, ApplyFailure> => {
	const tokens = parsePointer(pointer);
	const targetToken = tokens.pop();

	// Replace the whole document for empty pointer
	if (typeof targetToken === "undefined") {
		return Either.right(value);
	}

	const parentNavigateResult = navigate(root, tokens);
	if (Either.isLeft(parentNavigateResult)) {
		return parentNavigateResult;
	}
	const parent = parentNavigateResult.right;
	if (Array.isArray(parent)) {
		if (targetToken === "-") {
			parent.push(value);
			return Either.right(root);
		}
		const idx = parseIndex(targetToken);
		if (Option.isNone(idx)) {
			return Either.left(ApplyFailure.InvalidIndex({ token: targetToken }));
		}
		if (idx.value > parent.length) {
			return Either.left(ApplyFailure.IndexOutOfBounds({ index: idx.value }));
		}
		parent.splice(idx.value, 0, value);
		return Either.right(root);
	}
	if (parent !== null && typeof parent === "object") {
		// Assigning __proto__ would fire the inherited setter instead of adding a key
		if (targetToken === "__proto__") {
			return Either.left(ApplyFailure.ForbiddenKey({ key: targetToken }));
		}
		parent[targetToken] = value;
		return Either.right(root);
	}
	return Either.left(ApplyFailure.NonContainer({ token: targetToken }));
};

/**
 * RFC 6902 remove: returns the new document
 * - array: remove at the index
 * - object: remove the key
 */
const remove = (
	root: MutableJson,
	pointer: Pointer,
): Either.Either<MutableJson, ApplyFailure> => {
	const tokens = parsePointer(pointer);
	const targetToken = tokens.pop();

	// Cannot remove the whole document
	if (typeof targetToken === "undefined") {
		return Either.left(ApplyFailure.ImmovableRoot());
	}

	const parentNavigateResult = navigate(root, tokens);
	if (Either.isLeft(parentNavigateResult)) {
		return parentNavigateResult;
	}
	const parent = parentNavigateResult.right;
	if (Array.isArray(parent)) {
		const idx = parseIndex(targetToken);
		if (Option.isNone(idx)) {
			return Either.left(ApplyFailure.InvalidIndex({ token: targetToken }));
		}
		if (parent.splice(idx.value, 1).length === 0) {
			return Either.left(ApplyFailure.IndexOutOfBounds({ index: idx.value }));
		}
		return Either.right(root);
	}
	if (parent !== null && typeof parent === "object") {
		if (!Object.hasOwn(parent, targetToken)) {
			return Either.left(ApplyFailure.MissingKey({ key: targetToken }));
		}
		delete parent[targetToken];
		return Either.right(root);
	}
	return Either.left(ApplyFailure.NonContainer({ token: targetToken }));
};

/**
 * RFC 6902 replace: returns the new document
 * - array: replace at the index
 * - object: replace on the existing key
 * - "" replaces the whole document
 */
const replace = (
	root: MutableJson,
	pointer: Pointer,
	value: MutableJson,
): Either.Either<MutableJson, ApplyFailure> => {
	const tokens = parsePointer(pointer);
	const targetToken = tokens.pop();

	// Replace the whole document for empty pointer
	if (typeof targetToken === "undefined") {
		return Either.right(value);
	}

	const parentNavigateResult = navigate(root, tokens);
	if (Either.isLeft(parentNavigateResult)) {
		return parentNavigateResult;
	}
	const parent = parentNavigateResult.right;
	if (Array.isArray(parent)) {
		const idx = parseIndex(targetToken);
		if (Option.isNone(idx)) {
			return Either.left(ApplyFailure.InvalidIndex({ token: targetToken }));
		}
		if (idx.value >= parent.length) {
			return Either.left(ApplyFailure.IndexOutOfBounds({ index: idx.value }));
		}
		parent[idx.value] = value;
		return Either.right(root);
	}
	if (parent !== null && typeof parent === "object") {
		if (!Object.hasOwn(parent, targetToken)) {
			return Either.left(ApplyFailure.MissingKey({ key: targetToken }));
		}
		parent[targetToken] = value;
		return Either.right(root);
	}
	return Either.left(ApplyFailure.NonContainer({ token: targetToken }));
};

const applyChangeOp = (
	root: MutableJson,
	op: ChangeOp,
): Either.Either<MutableJson, ApplyFailure> =>
	Match.value(op).pipe(
		Match.when({ op: "add" }, ({ path, value }) =>
			add(root, path, cloneJson(value)),
		),
		Match.when({ op: "remove" }, ({ path }) => remove(root, path)),
		Match.when({ op: "replace" }, ({ path, value }) =>
			replace(root, path, cloneJson(value)),
		),
		Match.exhaustive,
	);

export interface PatchFailure {
	readonly op: ChangeOp;
	readonly cause: ApplyFailure;
}

export const applyPatch = (
	current: JsonValue,
	patch: ReadonlyArray<ChangeOp>,
): Either.Either<MutableJson, PatchFailure> => {
	let doc = cloneJson(current);
	for (const op of patch) {
		const result = applyChangeOp(doc, op);
		if (Either.isLeft(result)) {
			return Either.left({ op, cause: result.left });
		}
		doc = result.right;
	}
	return Either.right(doc);
};
