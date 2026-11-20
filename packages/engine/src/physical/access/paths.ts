import {
	combineAll,
	type Comparator,
	compareNumbers,
	compareStrings,
	mapInput,
	thenBy
} from "#compiler/core/order.ts"

import { defaultOpclass, type IndexOpclass } from "#compiler/ir/law.ts"
import type { AccessIndexRequest, AccessKey, AccessPath } from "#compiler/ir/products.ts"

/** The operator class every key of a path takes, by its access method: the column type's default for a B-tree or a
 * GiST index, pgvector's cosine class for an HNSW one, whose schema is the installation's vector extension schema. */
const methodOpclass = {
	btree: "default",
	gist: "default",
	hnsw: "vectorCosine",
	gin: "default"
} as const satisfies Record<AccessPath["method"], "default" | "vectorCosine">

/** The identity of a path: equal paths of several programs are one request. Its parts are joined by NUL, its keys by
 * \u0003 and a key's parts by \u0001; no name holds a control character. The method decides the operator class. */
const pathKey = (p: AccessPath): string =>
	`${p.relation}\u0000${p.method}\u0000${p.keys.map((k) => `${k.field}\u0001${k.dir}`).join("\u0003")}\u0000${p.use}`

/** The canonical order of paths, by relation, method, keys and use: strings by code unit; key lists elementwise, the
 * longer first when one begins the other. */
const keyOrder: Comparator<AccessKey> = thenBy(
	mapInput(compareStrings, (k: AccessKey) => k.field),
	mapInput(compareStrings, (k: AccessKey) => k.dir)
)

const keysOrder: Comparator<ReadonlyArray<AccessKey>> = (a, b) => {
	for (const [i, x] of a.entries()) {
		const y = b[i]
		if (y === undefined) {
			break
		}
		const order = keyOrder(x, y)
		if (order !== 0) {
			return order
		}
	}
	return compareNumbers(b.length, a.length)
}

const pathOrder: Comparator<AccessPath> = combineAll([
	mapInput(compareStrings, (p: AccessPath) => p.relation),
	mapInput(compareStrings, (p: AccessPath) => p.method),
	mapInput(keysOrder, (p: AccessPath) => p.keys),
	mapInput(compareStrings, (p: AccessPath) => p.use)
])

/**
 * A path a read asks for and the lookups through it (physical/access/extract.ts extractLookups): each lookup the columns
 * its probe context fixes by equality, its own facts' and its partners', in code point order, each set once; none for a
 * path no probe context asks for, an ordered or a vector one.
 */
export interface Lookup {
	readonly path: AccessPath
	readonly binds: ReadonlyArray<ReadonlyArray<string>>
}

/** Each path once, in canonical order (`uniquePaths`), with every lookup through it. */
export const uniqueLookups = (lookups: ReadonlyArray<Lookup>): ReadonlyArray<Lookup> => {
	const through = new Map<string, Map<string, ReadonlyArray<string>>>()
	for (const { path, binds } of lookups) {
		const sets = through.get(pathKey(path)) ?? new Map<string, ReadonlyArray<string>>()
		for (const columns of binds) {
			sets.set(columns.join("\u0001"), columns)
		}
		through.set(pathKey(path), sets)
	}
	return uniquePaths(lookups.map((l) => l.path)).map((path) => ({
		path,
		binds: [...(through.get(pathKey(path))?.values() ?? [])]
	}))
}

/** Each path once, in canonical order. */
export const uniquePaths = (paths: ReadonlyArray<AccessPath>): ReadonlyArray<AccessPath> => {
	const byKey = new Map<string, AccessPath>()
	for (const p of paths) {
		if (!byKey.has(pathKey(p))) {
			byKey.set(pathKey(p), p)
		}
	}
	return [...byKey.values()].toSorted(pathOrder)
}

/** A path's operator class as the request states it: the installation's vector schema qualifies the cosine class. */
const requestOpclass = (method: AccessPath["method"], vectorSchema: string): IndexOpclass => {
	switch (methodOpclass[method]) {
		case "default":
			return defaultOpclass
		case "vectorCosine":
			return { kind: "vectorCosine", schema: vectorSchema }
	}
}

/** A path as the index request the engine plans. */
export const pathRequest = (p: AccessPath, vectorSchema: string): AccessIndexRequest => ({
	relation: p.relation,
	keys: p.keys.map((k) => ({
		expr: k.field,
		dir: k.dir,
		opclass: requestOpclass(p.method, vectorSchema)
	})),
	method: p.method,
	role: "access",
	use: p.use
})
