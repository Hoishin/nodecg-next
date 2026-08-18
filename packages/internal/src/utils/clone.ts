import { klona } from "klona/json";
import type { JsonValue } from "type-fest";

export type MutableJson =
	| null
	| boolean
	| number
	| string
	| MutableJson[]
	| { [k: string]: MutableJson };

export function cloneJson(value: JsonValue): MutableJson {
	return klona(value) as MutableJson;
}
