import type { JsonValue } from "type-fest";

const map = new Map<string, JsonValue>();

const key = (namespace: string, name: string) => `${namespace}:${name}`;

export const store = {
	get(namespace: string, name: string): JsonValue | undefined {
		return map.get(key(namespace, name));
	},
	set(namespace: string, name: string, value: JsonValue): void {
		map.set(key(namespace, name), value);
	},
};
