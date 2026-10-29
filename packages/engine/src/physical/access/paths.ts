import {
	type Comparator,
	combine,
	combineAll,
	compareNumbers,
	compareStrings,
	mapInput
} from "#compiler/core/order.ts"

import {
	type AccessIndexRequest,
	type AccessKey,
	type AccessPath,
	defaultOpclass,
	type IndexOpclass
} from "#compiler/ir/products.ts"

/** The operator class every key of a path takes, by its access method: the column type's default for a B-tree or a
 * GiST index, pgvector's cosine class for an HNSW one, whose schema is the installation's vector extension schema. */
const methodOpclass = {
	btree: "default",
	gist: "default",
	hnsw: "vectorCosine"
} as const satisfies Record<AccessPath["method"], "default" | "vectorCosine">

/** The identity of a path: equal paths of several programs are one request. Its parts are joined by NUL, its keys by
 * \u0003 and a key's parts by \u0001; no name holds a control character. The method decides the operator class. */
const pathKey = (p: AccessPath): string =>
	`${p.relation}\u0000${p.method}\u0000${p.keys.map((k) => `${k.field}\u0001${k.dir}`).join("\u0003")}\u0000${p.use}`

/** The canonical order of paths, by relation, method, keys and use: strings by code unit; key lists elementwise, the
 * longer first when one begins the other. */
const keyOrder: Comparator<AccessKey> = combine(
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

/** A readable label of a path for diagnostics: `task(account, priority desc, id) btree for page seek`. It names
 * relations and fields only, never a value. */
export const pathLabel = (p: AccessPath): string =>
	`${p.relation}(${p.keys
		.map(
			(k) =>
				`${k.field}${k.dir === "desc" ? " desc" : ""}${methodOpclass[p.method] === "default" ? "" : ` ${methodOpclass[p.method]}`}`
		)
		.join(", ")}) ${p.method} for ${p.use}`
