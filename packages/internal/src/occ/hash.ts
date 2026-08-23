// Replicant OCC detects divergence by hashing values
// This runs on every write on both sides, so the hash is fast and non-cryptographic

import stringify from "fast-json-stable-stringify";
import murmur from "murmurhash3js-revisited";
import type { JsonValue } from "type-fest";

declare const TextEncoder: {
	new (): { encode(input: string): Uint8Array };
};
const encoder = new TextEncoder();

export const stableStringify = (value: JsonValue) => stringify(value);

const jsonToBytes = (value: JsonValue) =>
	encoder.encode(stableStringify(value));

export const computeTestHash = (value: JsonValue) =>
	murmur.x64.hash128(jsonToBytes(value));
