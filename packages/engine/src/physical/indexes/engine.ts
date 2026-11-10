import { catchRefusal, Refusal } from "#compiler/core/canonical.ts"
import type { KeyFault } from "#compiler/core/causes.ts"
import { CompileError, type ProseTag, prose } from "#compiler/core/errors.ts"
import { identity, type IndexMethod } from "#compiler/core/identity.ts"
import type { ConstraintName, IndexName, LawId } from "#compiler/core/ids.ts"
import { defined } from "#compiler/core/invariant.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import {
	extendNonEmpty,
	isNonEmpty,
	lastNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray,
	sortNonEmpty
} from "#compiler/core/nonempty.ts"

import {
	type Comparator,
	combineAll,
	compareBooleans,
	compareNumbers,
	compareStrings,
	flip,
	mapInput,
	type Direction,
	opposite
} from "#compiler/core/order.ts"
import type * as Result from "#compiler/core/result.ts"
import { defaultOpclass, type IndexOpclass, type NativeColumn } from "#compiler/ir/law.ts"
import {
	type AccessUse,
	type IndexRequest,
	type PhysicalReason,
	sameIndexOpclass,
	vectorCosineOpclass
} from "#compiler/ir/products.ts"
import { baseOf, fewValued, type ScalarType, spanCarrierOf } from "#compiler/ir/scalar.ts"
import type {
	BuiltTarget,
	IndexColumn,
	InstallBuilder,
	TargetField
} from "#compiler/physical/ddl/context.ts"
import type { KeyIndex } from "#compiler/physical/ddl/tables.ts"
import type { Node } from "#compiler/physical/obligations/graph.ts"
import {
	btreeEntry,
	gistEntryBytes,
	gistMaxItemSize,
	indexMaxKeys,
	keyDatums
} from "#compiler/schema/representability.ts"
import type { CreateIndex } from "#compiler/sql/ast.ts"
import { columnKey } from "#compiler/sql/build.ts"

/** A key of an index, or one a request asks an index for. */
export interface IndexKey {
	/** The column the key holds, by its arm: a field, or a law column. */
	readonly column: IndexColumn
	readonly dir: Direction
	readonly opclass: IndexOpclass
}

/** A native object's column as an index names it, by its arm. */
const indexColumnOf = (c: NativeColumn): IndexColumn =>
	c.kind === "field" ? { kind: "field", field: c.field.name } : c

/**
 * A column's text as the plan orders, labels and names its indexes by: a field's name, or a law column's identifier.
 * A law column's identifier starts with `__`, which no declared name does, so the texts of a relation's columns are
 * distinct.
 */
const columnText = (c: IndexColumn): string => (c.kind === "field" ? c.field : c.column)

/** Whether two columns are one: one field, or one law column. */
const sameColumn = (a: IndexColumn, b: IndexColumn): boolean =>
	a.kind === "field"
		? b.kind === "field" && a.field === b.field
		: b.kind === "law" && a.column === b.column

/**
 * What a column holds, by its field's type: a scalar of few values, a closed id's roster code or a boolean (fewValued),
 * whose fixing bounds no scan; a scalar of many values; or a span. A GiST index names btree_gist's class for a scalar,
 * whose equality and comparison operators search a B-tree's conditions, and the range type's own for a span; it places
 * an entry by its first column of many values, a scalar's or a span's, so a column of few values places none, and a
 * scan descends once per value of one before that column that its condition leaves unbound.
 */
type Holds = "few" | "many" | "span"

const holdsOf = (type: ScalarType): Holds =>
	spanCarrierOf(type) !== undefined ? "span" : fewValued[baseOf(type).carrier] ? "few" : "many"

/** What serving reads of an index (see `planIndexes`): its relation, access method, keys in index order, and whether it
 * holds at most one row per key. */
export interface KeyedIndex {
	readonly relation: string
	readonly method: IndexMethod
	readonly keys: ReadonlyArray<IndexKey>
	readonly unique: boolean
}

export interface PlannedIndex extends KeyedIndex {
	/** The index's identifier: one the engine created, or a key or enforcement index another object installs. */
	readonly index:
		| { readonly kind: "created"; readonly name: IndexName }
		| { readonly kind: "installed"; readonly name: ConstraintName }
	/** The graph object that realizes it. */
	readonly object: Node<"structure" | "indexes">
	/** The requests it serves, merged provenance. */
	readonly requests: ReadonlyArray<IndexRequest>
}

/** A function declaration, so that control flow knows a call never returns. */
function fail(tag: ProseTag, label: string, capability: string): never {
	throw new Refusal(CompileError.make(prose(tag, SourceLoc(label, []), capability)))
}

const requestLabel = (r: IndexRequest): string =>
	`${r.role} index request on ${r.relation}(${requestColumns(r).map(columnText).join(", ")}) for ${r.use}`

/** The columns a request's keys name, in key order: a law's by their arms, the workload's by their fields' names. */
const requestColumns = (r: IndexRequest): ReadonlyArray<IndexColumn> =>
	r.role === "lawMaintenance"
		? r.keys.map((k) => indexColumnOf(k.column))
		: r.keys.map((k): IndexColumn => ({ kind: "field", field: String(k.expr) }))

const reasonOf = (r: IndexRequest): PhysicalReason =>
	r.role === "lawMaintenance" ? { kind: "law", law: r.justification.law } : { kind: "access" }

/**
 * The reverse lookup of every containment the law model lowered to a referencing-side index: one request per law the
 * index serves, over the columns and by the method the law model planned it (ir/law.ts ReverseIndexOn), each a field
 * or a law column by its arm. The law model leaves a constant law column out of them: one value in every row narrows no
 * lookup.
 */
export const reverseRequests = (b: InstallBuilder): ReadonlyArray<IndexRequest> =>
	b.natives.flatMap(({ object: n }) => {
		if (n.kind !== "ReverseIndex") {
			return []
		}
		return n.lawIds.map((law: LawId): IndexRequest => ({
			relation: n.relation.name,
			keys: mapNonEmpty(n.columns, (column) => ({
				column,
				dir: "asc" as const,
				opclass: defaultOpclass
			})),
			method: n.method,
			role: "lawMaintenance",
			use: "reverse reference",
			justification: { kind: "law", law }
		}))
	})

type Keys = NonEmptyReadonlyArray<IndexKey>

/** What each column of a request's relation holds (Holds), by field. */
interface Columns {
	readonly holds: (column: IndexColumn) => Holds
}

/** A run of columns that lead an index together, in any order among themselves. */
type Block = NonEmptyReadonlyArray<IndexKey>

/**
 * Columns leading an index as blocks, an ordered request's in its directions or all opposite: a B-tree's, which narrows
 * its scan by its leading columns in order whatever values they hold, or the one column of a hash or an HNSW index. A
 * GiST index places an entry by its first column of many values, so no blocks of its columns place a request
 * (PlacedPlacement).
 */
interface BlocksPlacement {
	readonly kind: "blocks"
	readonly method: Exclude<IndexMethod, "gist">
	readonly blocks: NonEmptyReadonlyArray<Block>
	/** The ordered request's keys, which fix each block's direction up to reversal, when the request is an order. */
	readonly directed: Keys | undefined
}

/** A B-tree led by one of `lead`, columns of many values the request fixes, holding each of `held`. */
interface LedPlacement {
	readonly kind: "led"
	readonly lead: Keys
	readonly held: ReadonlyArray<IndexKey>
}

/**
 * A GiST index whose first column of many values is one of `lead`, every column of few values before it one of `bound`,
 * holding each of `bound`: GiST places an entry by that column (see `planIndexes`), and its scan descends once per value
 * of a column of few values before it that the request leaves unbound, so a request binding every one of them reads, in
 * one descent, the entries its condition on that column selects, and searches every other condition within the index.
 */
interface PlacedPlacement {
	readonly kind: "placed"
	readonly lead: Keys
	readonly bound: Keys
}

/** A unique index of `method` all of whose keys are among `within`: it finds at most one row, on which PostgreSQL
 * rechecks the request's other columns. */
interface KeyedPlacement {
	readonly kind: "keyed"
	readonly method: KeyIndex["method"]
	readonly within: Keys
}

/** Where a request's columns sit in a serving index (see `planIndexes`), each by the access method that holds them so:
 * blocks leading a B-tree, a hash or an HNSW index, a B-tree led by one of them and holding others, a GiST index placed by
 * one of them and holding the rest, or, for a unique index, its every key among some of them. */
type Placement = BlocksPlacement | LedPlacement | PlacedPlacement | KeyedPlacement

/** The access method of the indexes that hold a placement. */
const methodOf = (placement: Placement): IndexMethod => {
	switch (placement.kind) {
		case "blocks":
		case "keyed":
			return placement.method
		case "led":
			return "btree"
		case "placed":
			return "gist"
	}
}

/** A request's placements: the one an index created for it takes, and every other one an index may hold to serve it. */
interface Placements {
	readonly own: BlocksPlacement | PlacedPlacement
	readonly others: ReadonlyArray<Placement>
}

/** The columns of `fixed` that place an entry, of many values or a span: any may lead a B-tree that holds the rest, or be
 * a GiST index's first column of many values. */
const placingOf = (fixed: ReadonlyArray<IndexKey>, columns: Columns): ReadonlyArray<IndexKey> =>
	fixed.filter((k) => columns.holds(k.column) !== "few")

/** A B-tree led by one of `lead` and holding every column of `held`, when the request fixes a column that places. */
const ledBy = (
	lead: ReadonlyArray<IndexKey>,
	held: ReadonlyArray<IndexKey>
): ReadonlyArray<Placement> => (isNonEmpty(lead) ? [{ kind: "led", lead, held }] : [])

/** A GiST index placed by one of `lead` and holding every column of `bound`, a B-tree request's own columns, when the
 * request fixes a column that places and btree_gist searches each of `bound` by its equality and comparison operators,
 * a scalar under the default class. */
const placedBy = (
	lead: ReadonlyArray<IndexKey>,
	bound: Keys,
	columns: Columns
): ReadonlyArray<Placement> =>
	isNonEmpty(lead) &&
	bound.every((k) => columns.holds(k.column) !== "span" && k.opclass.kind === "default")
		? [{ kind: "placed", lead, bound }]
		: []

/** An equality lookup on every column. */
const equalityPlacements = (keys: Keys, columns: Columns): Placements => {
	const lead = placingOf(keys, columns)
	return {
		own: { kind: "blocks", method: "btree", blocks: [keys], directed: undefined },
		others: [
			{ kind: "keyed", method: "btree", within: keys },
			...ledBy(lead, keys),
			...placedBy(lead, keys, columns)
		]
	}
}

/** An equality prefix and one range column, `keys` the prefix and then the range column, the prefix's columns placing a
 * GiST index's entries. */
const prefixedRangePlacements = (
	keys: Keys,
	prefix: Keys,
	bounded: IndexKey,
	columns: Columns
): Placements => {
	const lead = placingOf(prefix, columns)
	return {
		own: { kind: "blocks", method: "btree", blocks: [prefix, [bounded]], directed: undefined },
		others: [
			{ kind: "keyed", method: "btree", within: prefix },
			...ledBy(lead, keys),
			...placedBy(lead, keys, columns)
		]
	}
}

/** One range column alone, which places a GiST index's entries itself. */
const bareRangePlacements = (bounded: IndexKey, columns: Columns): Placements => ({
	own: { kind: "blocks", method: "btree", blocks: [[bounded]], directed: undefined },
	others: placedBy(placingOf([bounded], columns), [bounded], columns)
})

/** An equality prefix and one range column: the prefix places a GiST index's entries, or, empty, the range column. */
const rangePlacements = (keys: Keys, columns: Columns): Placements => {
	const prefix = keys.slice(0, -1)
	const bounded = lastNonEmpty(keys)
	return isNonEmpty(prefix)
		? prefixedRangePlacements(keys, prefix, bounded, columns)
		: bareRangePlacements(bounded, columns)
}

/** An order, which only a B-tree has. */
const orderedPlacements = (keys: Keys): Placements => ({
	own: {
		kind: "blocks",
		method: "btree",
		blocks: mapNonEmpty(keys, (k): Block => [k]),
		directed: keys
	},
	others: []
})

/** A GiST probe binding every column, a scalar by equality through btree_gist and a span by overlap or equality: a GiST
 * index holding them all, placed by one of theirs of many values, a span's at least, or a unique index all of whose keys
 * the probe binds and the index applies the probe to, a GiST index any, a B-tree its scalars. A probe binding no span
 * and no scalar of many values places no GiST entry: no request extraction or the law model makes is one. */
const gistPlacements = (keys: Keys, columns: Columns, label: string): Placements => {
	const lead = placingOf(keys, columns)
	const scalars = keys.filter((k) => columns.holds(k.column) !== "span")
	return {
		own: isNonEmpty(lead)
			? { kind: "placed", lead, bound: keys }
			: fail(
					"MalformedDescription",
					label,
					"a GiST request binding a span or a column of many values"
				),
		others: [
			{ kind: "keyed", method: "gist", within: keys },
			...(isNonEmpty(scalars)
				? [{ kind: "keyed" as const, method: "btree" as const, within: scalars }]
				: [])
		]
	}
}

/**
 * An equality probe on one column that no B-tree entry holds, which only a hash index on that column serves: no
 * B-tree, GiST or HNSW request ever lands on a hash index, nor a hash request on another.
 */
const hashPlacements = (keys: Keys): Placements => ({
	own: { kind: "blocks", method: "hash", blocks: [keys], directed: undefined },
	others: []
})

/** The nearest vectors, which only an HNSW index on the column under its class finds. */
const nearestPlacements = (keys: Keys): Placements => ({
	own: { kind: "blocks", method: "hnsw", blocks: [keys], directed: undefined },
	others: []
})

/** What each workload use asks of a B-tree (`accessUses` names them): every column fixed by equality, an equality prefix
 * and one range column, or an order; none of a span predicate, GiST's, or an approximate retrieval, HNSW's, which
 * extraction never asks of a B-tree. */
const btreeNeeds: Readonly<Record<AccessUse, "lookup" | "range" | "order" | "none">> = {
	"key lookup": "lookup",
	"equality lookup": "lookup",
	"join key": "lookup",
	"write target": "lookup",
	range: "range",
	"prefix search": "range",
	"take seek": "order",
	"page seek": "order",
	"span predicate": "none",
	"approximate vector retrieval": "none"
}

/** A workload B-tree request's placements, by what its use asks of a B-tree (btreeNeeds). */
const btreeAccessPlacements = (
	use: AccessUse,
	keys: Keys,
	columns: Columns,
	label: string
): Placements => {
	switch (btreeNeeds[use]) {
		case "lookup":
			return equalityPlacements(keys, columns)
		case "range":
			return rangePlacements(keys, columns)
		case "order":
			return orderedPlacements(keys)
		case "none":
			return fail("MalformedDescription", label, `a use a B-tree serves; ${use} is none`)
	}
}

/** A request's placements, its keys those it states over `columns`, read once from its access method, role and use: a
 * GiST request binds every column, an HNSW request asks the nearest vectors, a law's B-tree probe looks every column up by
 * equality, and a workload B-tree request needs what its use does. */
const placementsOf = (
	request: IndexRequest,
	keys: Keys,
	columns: Columns,
	label: string
): Placements => {
	switch (request.method) {
		case "gist":
			return gistPlacements(keys, columns, label)
		case "hnsw":
			return nearestPlacements(keys)
		case "hash":
			return hashPlacements(keys)
		case "btree":
			return request.role === "lawMaintenance"
				? equalityPlacements(keys, columns)
				: btreeAccessPlacements(request.use, keys, columns, label)
	}
}

/** Whether two keys name one column under one class. */
const sameKey = (a: IndexKey, b: IndexKey): boolean =>
	sameColumn(a.column, b.column) && sameIndexOpclass(a.opclass, b.opclass)

/** Whether keys, as many of each, name exactly the same columns under the same classes, in any order. */
const sameSet = (have: ReadonlyArray<IndexKey>, want: ReadonlyArray<IndexKey>): boolean =>
	have.length === want.length &&
	want.every((k) => have.some((l) => sameKey(l, k))) &&
	have.every((l) => want.some((k) => sameKey(l, k)))

/** Whether `keys` lead with `directed`'s columns in its directions, or all opposite. */
const alongEither = (keys: ReadonlyArray<IndexKey>, directed: Keys): boolean => {
	const along = (reversed: boolean): boolean =>
		directed.every((k, i) => {
			const l = keys[i]
			return l !== undefined && (l.dir === k.dir) !== reversed
		})
	return along(false) || along(true)
}

/** Whether an index's keys hold a placement (see `planIndexes`), over `columns`, what its relation's columns hold. */
const placed = (index: KeyedIndex, placement: Placement, columns: Columns): boolean => {
	const keys = index.keys
	switch (placement.kind) {
		case "led": {
			const first = keys[0]
			return (
				first !== undefined &&
				placement.lead.some((c) => sameKey(first, c)) &&
				placement.held.every((c) => keys.some((l) => sameKey(l, c)))
			)
		}
		case "placed": {
			const at = keys.findIndex((l) => columns.holds(l.column) !== "few")
			const first = keys[at]
			return (
				first !== undefined &&
				placement.lead.some((c) => sameKey(first, c)) &&
				keys.slice(0, at).every((l) => placement.bound.some((c) => sameKey(l, c))) &&
				placement.bound.every((c) => keys.some((l) => sameKey(l, c)))
			)
		}
		case "keyed":
			return index.unique && keys.every((k) => placement.within.some((c) => sameKey(k, c)))
		case "blocks": {
			let at = 0
			for (const block of placement.blocks) {
				if (!sameSet(keys.slice(at, at + block.length), block)) {
					return false
				}
				at += block.length
			}
			return placement.directed === undefined || alongEither(keys, placement.directed)
		}
	}
}

/** A request as the engine plans it: its placements, and what its relation's columns hold. */
interface Planned {
	readonly request: IndexRequest
	readonly placements: Placements
	/** Its keys as it states them. */
	readonly keys: Keys
	readonly columns: Columns
	readonly label: string
	readonly target: BuiltTarget
}

/** The access method of the index a planned request creates. */
const ownMethod = (planned: Planned): IndexMethod => methodOf(planned.placements.own)

/** Whether an index's relation, access method and keys serve a planned request (see `planIndexes`): it holds one of the
 * request's placements, as an index of that placement's method. */
const serves = (index: KeyedIndex, planned: Planned): boolean =>
	index.relation === planned.request.relation &&
	[planned.placements.own, ...planned.placements.others].some(
		(p) => methodOf(p) === index.method && placed(index, p, planned.columns)
	)

/** An index under construction (see `planIndexes`): its access method, its own request's, blocks covering its columns,
 * and the order whose directions it takes, when an ordered request fixed them. */
interface Draft {
	readonly method: IndexMethod
	readonly blocks: NonEmptyReadonlyArray<Block>
	readonly directed: Keys | undefined
}

/** Two block sequences as one that satisfies both, or none when no order does: `draft`'s cover the index's columns, and
 * `leading` must lead it. Of the two current blocks the smaller leads and must lie within the larger, whose rest stays
 * current; a block of `leading` left over names a column the index does not hold. */
const mergeBlocks = (
	draft: NonEmptyReadonlyArray<Block>,
	leading: NonEmptyReadonlyArray<Block>
): NonEmptyReadonlyArray<Block> | undefined => {
	const out: Array<Block> = []
	const restA = [...draft]
	const restB = [...leading]
	let a = restA.shift()
	let b = restB.shift()
	while (a !== undefined && b !== undefined) {
		const fromDraft = a.length <= b.length
		const small = fromDraft ? a : b
		const large = fromDraft ? b : a
		if (!small.every((k) => large.some((l) => sameKey(k, l)))) {
			return undefined
		}
		out.push(small)
		const left = large.filter((l) => !small.some((k) => sameKey(k, l)))
		const rest = isNonEmpty(left) ? left : undefined
		if (fromDraft) {
			a = restA.shift()
			b = rest ?? restB.shift()
		} else {
			b = restB.shift()
			a = rest ?? restA.shift()
		}
	}
	if (b !== undefined) {
		return undefined
	}
	const merged = a === undefined ? out : [...out, a, ...restA]
	return isNonEmpty(merged) ? merged : undefined
}

/** Where each column stands in the order a created index's own request states them, which a block keeps among its
 * columns. */
type Rank = (k: IndexKey) => number

const rankIn =
	(stated: Keys): Rank =>
	(k) =>
		stated.findIndex((s) => sameKey(s, k))

/** A draft's blocks refined so that one of `lead` comes first and each of `held` is among them, which holds a led
 * placement, and a placed one, whose leads are of many values: of its first block's columns among `lead`, the one the
 * request states first leads, alone, and the rest of the block follows; none when the first block holds no column of
 * `lead` or the draft misses one of `held`. */
const leadDraft = (
	draft: NonEmptyReadonlyArray<Block>,
	lead: Keys,
	held: ReadonlyArray<IndexKey>,
	rank: Rank
): NonEmptyReadonlyArray<Block> | undefined => {
	const [first, ...rest] = draft
	if (!held.every((c) => draft.some((block) => block.some((k) => sameKey(k, c))))) {
		return undefined
	}
	const [leader] = first
		.filter((k) => lead.some((c) => sameKey(k, c)))
		.toSorted(mapInput(compareNumbers, rank))
	if (leader === undefined) {
		return undefined
	}
	const other = first.filter((k) => !sameKey(k, leader))
	return isNonEmpty(other) ? [[leader], other, ...rest] : [[leader], ...rest]
}

/** The order of two ordered requests leading one index, when they read it in one direction: the longer, when the
 * shorter's keys lie each in its direction or each opposite. */
const oneDirection = (a: Keys, b: Keys): Keys | undefined => {
	const short = a.length <= b.length ? a : b
	const long = a.length <= b.length ? b : a
	return alongEither(long, short) ? long : undefined
}

/** The draft of the index a planned request creates: its own placement's method and blocks, a GiST request's bound
 * columns as one block, in any order a later request fixes, the request's own otherwise. */
const draftOf = (planned: Planned): Draft => {
	const own = planned.placements.own
	switch (own.kind) {
		case "blocks":
			return { method: own.method, blocks: own.blocks, directed: own.directed }
		case "placed":
			return { method: "gist", blocks: [own.bound], directed: undefined }
	}
}

/** Another request a draft's look-ahead reads (see `planIndexes`): one no planned index serves yet, which needs an index,
 * or one another index serves, which PostgreSQL may read through this one too. */
type Ahead =
	| { readonly kind: "unserved"; readonly planned: Planned }
	| { readonly kind: "served"; readonly planned: Planned }

/** A draft refined by one placement of another request, or none when no one index holds both: the placement is another
 * method's, or no one order satisfies both. A created index is never unique, so no keyed placement refines it. */
const refinedBy = (draft: Draft, placement: Placement, rank: Rank): Draft | undefined => {
	if (methodOf(placement) !== draft.method) {
		return undefined
	}
	const { method } = draft
	switch (placement.kind) {
		case "keyed":
			return undefined
		case "led": {
			const blocks = leadDraft(draft.blocks, placement.lead, placement.held, rank)
			return blocks === undefined ? undefined : { method, blocks, directed: draft.directed }
		}
		case "placed": {
			const blocks = leadDraft(draft.blocks, placement.lead, placement.bound, rank)
			return blocks === undefined ? undefined : { method, blocks, directed: draft.directed }
		}
		case "blocks": {
			const blocks = mergeBlocks(draft.blocks, placement.blocks)
			if (blocks === undefined) {
				return undefined
			}
			if (placement.directed === undefined) {
				return { method, blocks, directed: draft.directed }
			}
			if (draft.directed === undefined) {
				return { method, blocks, directed: placement.directed }
			}
			const directed = oneDirection(draft.directed, placement.directed)
			return directed === undefined ? undefined : { method, blocks, directed }
		}
	}
}

/** A draft refined by another request: by its own placement, else by the first of its others that refines it; none when
 * no placement does. */
const refined = (draft: Draft, ahead: Ahead, rank: Rank): Draft | undefined => {
	const { own, others } = ahead.planned.placements
	for (const placement of [own, ...others]) {
		const found = refinedBy(draft, placement, rank)
		if (found !== undefined) {
			return found
		}
	}
	return undefined
}

/** A draft's keys (see `planIndexes`): its blocks in order, each block's columns in the request's own order, the keys an
 * ordered request directs in its directions and every other in the first key's, canonical under reversal. */
const keysOf = (draft: Draft, rank: Rank): NonEmptyReadonlyArray<IndexKey> => {
	const byRank = mapInput(compareNumbers, rank)
	const [leading, ...following] = draft.blocks
	const keys = extendNonEmpty(
		sortNonEmpty(leading, byRank),
		following.flatMap((block) => block.toSorted(byRank))
	)
	const directed = draft.directed
	const first = directed === undefined ? "asc" : directed[0].dir
	return canonicalKeys(
		mapNonEmpty(keys, (k, i): IndexKey => {
			const along = directed?.[i]
			return { column: k.column, dir: along === undefined ? first : along.dir, opclass: k.opclass }
		})
	)
}

/** The plan's fixed orders compare structurally: strings by code unit; lists elementwise, the longer first on a common
 * prefix; a key's default operator class after any named one. */
const listOrder =
	<A extends object | string>(item: Comparator<A>): Comparator<ReadonlyArray<A>> =>
	(a, b) => {
		for (const [i, x] of a.entries()) {
			const y = b[i]
			if (y === undefined) {
				break
			}
			const order = item(x, y)
			if (order !== 0) {
				return order
			}
		}
		return compareNumbers(b.length, a.length)
	}

const opclassOrder: Comparator<IndexOpclass> = (a, b) =>
	a.kind === "default"
		? b.kind === "default"
			? 0
			: 1
		: b.kind === "default"
			? -1
			: compareStrings(`${a.schema}.${vectorCosineOpclass}`, `${b.schema}.${vectorCosineOpclass}`)

const keyOrder: Comparator<IndexKey> = combineAll([
	mapInput(compareStrings, (k: IndexKey) => columnText(k.column)),
	mapInput(compareStrings, (k: IndexKey) => k.dir),
	mapInput(opclassOrder, (k: IndexKey) => k.opclass)
])

/** A law's request before the workload's access, then by the law. */
const justificationOrder: Comparator<IndexRequest> = (a, b) => {
	if (a.role === "lawMaintenance") {
		return b.role === "lawMaintenance"
			? compareStrings(a.justification.law, b.justification.law)
			: -1
	}
	return b.role === "lawMaintenance" ? 1 : 0
}

/** The planned indexes: every key and enforcement index, then each new index the requests need, every request merged
 * into the index that serves it. Adds the new index objects and the served reasons to the graph.
 *
 * The index request engine: every index beyond a key's own cites a law's maintenance or the workload's access, and requests
 * are deduplicated against the key indexes and against each other, merging provenance. Containments imply useful
 * indexes.
 *
 * Requests come from two sources. Law maintenance is generated here from the law model: a reverse foreign-key lookup
 * for every containment PostgreSQL does not index on the referencing side (the ReverseIndex natives, over fields and
 * law columns alike, each by its arm); workload access paths arrive from the
 * workload compiler through an installer extension's contribution (`workloadExtension`). A law-maintenance request is
 * always served, because a per-key check without one is a table scan.
 *
 * Coverage, one rule (`serves`), over where a request's columns may sit in a serving index, each place owned by the
 * access method whose scan it narrows (Placements), read once from the request's access method, role and use. A B-tree
 * narrows its scan by its leading columns in order, whatever values they hold. A GiST index narrows it by its first
 * column of many values, a scalar's or a span's (Holds): PostgreSQL
 * documents that a multicolumn GiST index can be used with conditions on any subset of its columns, but that the
 * condition on the first column decides how much of the index is scanned, and that the index is relatively ineffective
 * when its first column has few distinct values. GiST places an entry, and splits a page, by the first column whose
 * penalty tells entries apart (gistchoose, gistSplitByKey), so the entries that tie on a column of few values are
 * placed by the next one, and its first column of many values decides the scan: a column of few values before it
 * narrows the scan little when the request binds it, and when the request leaves it unbound, the scan descends into the
 * entries of each of its values. On PostgreSQL 19, over 20,000 rows, a probe binding an int4 of 20,000 values touches 4
 * buffers of an index on `(enum, int4, ...)` when it binds the three-valued enum too and 6 when it does not, and 126 of
 * one on `(enum, numeric, int4, ...)` whose numeric of 141 values it leaves unbound; a lookup on a uuid of 141 values
 * touches 7 buffers of one on `(c, uuid, span)` when c, unbound, holds two or three values evenly, and 11 to 18, past
 * the 10 of one descent, when it holds four to eight, but 7 to 9, within 11, at each count when nine rows in ten hold
 * one value of c. The descents grow with the values of the columns left unbound and with how evenly the rows hold them,
 * which a plan made before any row cannot price, so a GiST index serves only in one descent, as a B-tree serves no
 * request by a skip scan over a leading column the request leaves unbound: it serves a request that binds every column
 * before its first column of many values and whose condition on that column selects the request's rows, holding every
 * other column the request conditions, which it searches within the index, so PostgreSQL rechecks none of the rows it
 * finds:
 *
 * - only an index of the same relation can serve a request;
 * - an equality lookup on every requested column (a law's B-tree probe, or a workload key lookup, equality lookup, join
 *   key or B-tree write target) is served by a B-tree whose leading columns are exactly the requested set, in any order
 *   and direction (`(tenant, account, created)` serves an equality lookup on `(account, tenant)`), or by one led by a
 *   requested column of many values that holds every requested column, which bounds the scan to that column's rows and
 *   checks the rest within the index (`(account, created, tenant)` serves it too; a closed handle or a boolean holds few
 *   values, so leading with one bounds no scan); and by a GiST index whose first column of many values is a requested
 *   one, every column before it a requested one too, and that holds every requested column, each a scalar under the
 *   default class, which btree_gist searches by its
 *   equality and comparison operators, a range below likewise. So a constraint-created index can satisfy a request when
 *   its native behavior fits (the reverse probes on `employment` and `shift` are served by the GiST index of a span key,
 *   whose leading `employee` column btree_gist serves; a workload lookup of a key's usage by `key` is served by the GiST
 *   index the coverage law of its spans needs on `(key, during)`), and no GiST index serves a lookup on closed handles
 *   and booleans alone. A B-tree index of the same relation is preferred when one serves;
 * - a workload range or prefix-search request is an equality prefix followed by one range column: a B-tree whose leading
 *   columns before the last are exactly the prefix's set in any order, and the next the range column in either
 *   direction, because a B-tree scans an interval forward or backward, or one led by a prefix column of many values that
 *   holds every requested column, as for an equality lookup; or a GiST index, its requested columns scalars under the
 *   default class, that holds every requested column and whose first column of many values is a prefix column, or, when
 *   the prefix is empty, the range column, every column before it a requested one (the span key's GiST index on `(room, during)` serves a range on room). A
 *   prefix of closed handles and booleans alone leaves a GiST index's placement to the range column, so its scan reads
 *   the range across every value of the prefix: on PostgreSQL 19, over 20,000 rows, a range on the half of a numeric of
 *   141 values after a three-valued handle touches 92 buffers of a GiST index on `(handle, numeric, handle, span)` for its
 *   3,334 rows, three times their share;
 * - an ordered request, a take or page seek, is served only by a B-tree whose leading columns are the requested ones in
 *   order and either in direction or all in the opposite direction, since a B-tree scanned backward yields the exact
 *   reverse of its order; GiST has no order;
 * - a GiST request (a workload span predicate, GiST key lookup or GiST write target, a law's GiST probe) binds every
 *   requested column, a scalar by equality through btree_gist and a span by overlap or equality, a span among them, and
 *   is served by a GiST index that holds every column it binds and whose first column of many values, and every column
 *   before it, is one of them. It
 *   is also served by a unique index, a key's of any access method that applies the probe to its keys (a GiST index any,
 *   another its scalars), all of whose keys the request binds: the index finds the rows of one key, on which PostgreSQL
 *   rechecks the rest. So the GiST index of a span key on `(room, during)` serves a span predicate on `(room, id,
 *   during)`, and never one on `during` alone, which reads most of it, and a GiST index on `(during)` serves the one on
 *   `during` alone, while a primary key on `(id)` serves a span predicate on `(id, during)`. Extraction states a span
 *   predicate with every column its fixed values and join partners bind, so a request on `during` alone is one where
 *   nothing binds a scalar beside it;
 * - an equality lookup, or a range whose prefix fixes them, is also served by a key's unique B-tree all of whose keys
 *   the request fixes by equality: the index finds at most one row, on which PostgreSQL rechecks the request's other
 *   columns, so a law's probe on `(id, tenant)` is served by the primary key on `id`; an order is not, since PostgreSQL
 *   still sorts by the columns after a key;
 * - an approximate vector retrieval is served by an HNSW index on its column under its class;
 * - operator classes must agree; every collatable key is pg_catalog.pg_c_utf8 by construction, so collation
 *   never differs;
 * - every request reads every row of its relation, and every index holds every row, a key's the ones null in a column
 *   of it too (NULLS DISTINCT).
 *
 * Each request's placements in a serving index (`placementsOf`) are the one statement of the rules on columns and methods:
 * its own, which an index created for it takes, and the others an index may hold instead, each owned by the access
 * method of the indexes that hold it (methodOf). A placement is blocks of columns leading a B-tree, a hash or an HNSW
 * index, each block's columns in any order among themselves (an ordered request's keys each a block of its own, in its
 * directions or all opposite); or a B-tree led by one of some columns and holding others (an equality lookup's or a
 * range's led by a column of many values); or a GiST index whose first column of many values is one of some columns,
 * every column before it and every other held (a GiST request's own, and an equality lookup's or a range's whose prefix, or range column when it has
 * none, holds many values); or, for a unique index, every key among some of the columns the request fixes (a B-tree's for
 * an equality lookup or a range; a GiST request's: a GiST index's among all of them, a B-tree's among its scalars). No
 * blocks place a GiST index's entries, so no placement of a GiST index is one by columns of few values alone. `serves`
 * reads them to judge an index, and the engine reads them to draft an index it creates.
 *
 * A served request adds its justification to the serving object's reasons; a constraint index can serve it (a primary
 * key serves the reverse lookup of a self-reference, a span key's GiST index the reverse probe of a PERIOD foreign
 * key). Of the indexes that serve a request, it lands on a key or enforcement index before a created one, then on one of
 * its own access method before one standing in for it, then on the first planned (`hostOrder`). An unserved request
 * becomes a new index `<table>__ix__<col>[__<col>...]`, wider requests first, so a narrower one lands on a wider index
 * that serves it. The index is drafted (`draftFor`): it starts as the request's own placement and its method, and is
 * refined, in the plan's order, by the placements of each later request no planned index serves yet, as long as one
 * index still holds them all: placements of its method, in one order. So an equality lookup on `{account, created}`
 * planned before a range on `created` then `account` creates `(created, account)`, which serves both, a wider equality
 * lookup takes the order a narrower range or order over its columns fixes, and a GiST index leads with a column of many
 * values a later request fixes (a span predicate on `(fixed, span)` beside one on `(span)` creates `(span, fixed)`,
 * which serves both).
 * The draft is refined too, after those, by every other request of its relation it can serve that another index
 * already serves, the requests of its own access method first, since PostgreSQL may read such a request through it. It costs a GiST scan by the selectivity of all its conditions whatever their
 * columns' places (genericcostestimate), so it may read a request through any GiST index that holds its columns, and
 * on PostgreSQL 19 it reads a span predicate on `(span)` through `(fixed, span)`, which it sweeps, rather than through
 * the `(span, other)` it is planned on.
 * Within a block the columns keep the request's own order. Since the draft looks ahead, the plan's order only fixes the outcome:
 * it is canonical, so the plan does not depend on the order requests arrive in.
 * Its keys are canonical under reversal: a key no ordered request directs takes the first key's direction, and an index
 * whose first key descends is created reversed, so an order and its exact reverse are one index. Its identity is its
 * columns, the canonical directions and each key's operator class, which serving requires equal, and its access method;
 * the name marks a method other than the B-tree, the descending keys and the classes beyond the default, each part of
 * its identity at the naming door (identity.accessIndex). Uniqueness is
 * never traded: a request never turns into or replaces a unique constraint, and enforcement objects (keys) stay
 * separate from access-path indexes. The index's key entry must fit its access method, like a key's.
 *
 * A derived relation's materialized view takes indexes like a table: the derived relation
 * extension registers the view's fields and inherited key indexes with the builder (`addIndexedView`),
 * the key indexes serve requests as a table's key indexes do, and an unserved request becomes an index of the view,
 * created after the view. A request on a derived relation no extension installs is deferred with the relation, which
 * the installation reports (Installation.deferred).
 *
 * Requests whose keys are expressions, a form the workload compiler does not produce, are refused as
 * UnsupportedOperation. */
export const planIndexes = (
	b: InstallBuilder,
	keyIndexes: ReadonlyArray<KeyIndex>,
	requests: ReadonlyArray<IndexRequest>
): Result.Result<ReadonlyArray<PlannedIndex>, CompileError> =>
	catchRefusal(() => {
		/** Each key index by its columns' arms: a table's key's, and a view's unique index's, over its fields. */
		const installed: ReadonlyArray<
			Omit<KeyIndex, "columns"> & { readonly columns: ReadonlyArray<IndexColumn> }
		> = [
			...keyIndexes.map((k) => ({ ...k, columns: k.columns.map(indexColumnOf) })),
			...b.indexedViews().flatMap((view) =>
				view.uniqueIndexes.map((u) => ({
					object: u.object,
					name: u.name,
					relation: view.relation,
					method: "btree" as const,
					columns: u.columns.map((field): IndexColumn => ({ kind: "field", field })),
					unique: true as const
				}))
			)
		]
		/** Each key index's keys ascending under the default class, over every row. */
		const candidates: Array<Candidate> = installed.map((k) => ({
			index: {
				index: { kind: "installed", name: k.name },
				relation: k.relation,
				method: k.method,
				keys: k.columns.map((column): IndexKey => ({
					column,
					dir: "asc",
					opclass: defaultOpclass
				})),
				unique: true,
				object: k.object,
				requests: []
			},
			requests: []
		}))
		const plan = requests
			.flatMap((r): ReadonlyArray<Planned> => {
				const label = requestLabel(r)
				const o = b.target(r.relation)
				switch (o.kind) {
					case "none":
						return fail(
							"MalformedDescription",
							label,
							`an index request on a stored or derived relation; ${r.relation} is none`
						)
					case "deferred":
						return []
					case "built":
						break
				}
				const keys = requestColumns(r).map((column, i): IndexKey => {
					const k = r.keys[i]
					if (k === undefined || o.field(column) === undefined) {
						return fail(
							"UnsupportedOperation",
							label,
							`a key column of ${r.relation}; ${columnText(column)} is none, and expression keys are the workload compiler's`
						)
					}
					return { column, dir: k.dir, opclass: k.opclass }
				})
				if (!isNonEmpty(keys)) {
					return fail("MalformedDescription", label, "an index request with a key")
				}
				const typeOf = (column: IndexColumn): ScalarType => {
					const f = o.field(column)
					return f === undefined
						? fail("MalformedDescription", label, `a field ${columnText(column)} of ${r.relation}`)
						: f.type
				}
				const columns: Columns = { holds: (column) => holdsOf(typeOf(column)) }
				return [
					{
						request: r,
						placements: placementsOf(r, keys, columns, label),
						keys,
						columns,
						label,
						target: o
					}
				]
			})
			.toSorted(canonical)
		/** The candidates and the plan's requests of each relation, in their order: an index serves only its own
		 * relation's requests (serves), so each request reads its relation's alone, and the plan, ordered by relation
		 * first (canonical), is walked relation by relation in its own order. */
		const candidatesOf = new Map<string, Array<Candidate>>()
		const hold = (c: Candidate): void => {
			const held = candidatesOf.get(c.index.relation)
			if (held === undefined) {
				candidatesOf.set(c.index.relation, [c])
			} else {
				held.push(c)
			}
		}
		for (const c of candidates) {
			hold(c)
		}
		const planOf = new Map<string, Array<Planned>>()
		for (const entry of plan) {
			const held = planOf.get(entry.request.relation)
			if (held === undefined) {
				planOf.set(entry.request.relation, [entry])
			} else {
				held.push(entry)
			}
		}
		for (const relationPlan of planOf.values()) {
			for (const entry of relationPlan) {
				const own = candidatesOf.get(entry.request.relation) ?? []
				const [host] = own.filter((c) => serves(c.index, entry)).toSorted(hostOrder(entry))
				if (host !== undefined) {
					host.requests.push(entry.request)
					b.graph.addReasons(host.index.object, [reasonOf(entry.request)])
					continue
				}
				const index = createIndex(b, entry, draftFor(entry, ahead(entry, relationPlan, own)))
				const created = { index, requests: [entry.request] }
				candidates.push(created)
				hold(created)
			}
		}
		return candidates.map((c) => ({ ...c.index, requests: c.requests }))
	})

/** A planned index and the requests it serves, in the plan's order. */
interface Candidate {
	readonly index: PlannedIndex
	readonly requests: Array<IndexRequest>
}

/** The plan's order: by relation, wider requests first, then a fixed order, so the plan does not depend on request
 * order; each index's requests and reasons are merged in it. */
const canonical: Comparator<Planned> = combineAll([
	mapInput(compareStrings, (x: Planned) => x.request.relation),
	mapInput(flip(compareNumbers), (x: Planned) => x.keys.length),
	mapInput(listOrder(keyOrder), (x: Planned) => x.keys),
	mapInput(justificationOrder, (x: Planned) => x.request),
	mapInput(compareStrings, (x: Planned) => x.request.method),
	mapInput(compareStrings, (x: Planned) => x.request.use)
])

/** The serving indexes a request lands on first (see `planIndexes`): a key or enforcement index before a created one, so
 * a request a key serves adds nothing; then one of the request's own access method before one standing in for it; then
 * the first planned. */
const hostOrder = (entry: Planned): Comparator<Candidate> =>
	combineAll([
		mapInput(compareBooleans, (c: Candidate) => c.index.index.kind === "created"),
		mapInput(compareBooleans, (c: Candidate) => c.index.method !== ownMethod(entry))
	])

/** The requests the draft of the index created for the unserved `plan[at]` reads ahead (see `planIndexes`): the later
 * requests of its relation no planned index serves yet, then every other request of its relation, which another index
 * serves; those of its own access method first. */
const ahead = (
	entry: Planned,
	relationPlan: ReadonlyArray<Planned>,
	candidates: ReadonlyArray<Candidate>
): ReadonlyArray<Ahead> => {
	const later = relationPlan
		.slice(relationPlan.indexOf(entry) + 1)
		.filter((q) => !candidates.some((c) => serves(c.index, q)))
	const served = relationPlan.filter((q) => q !== entry && !later.includes(q))
	return [
		...later.map((planned): Ahead => ({ kind: "unserved", planned })),
		...served.map((planned): Ahead => ({ kind: "served", planned }))
	].toSorted(mapInput(compareBooleans, (q: Ahead) => ownMethod(q.planned) !== ownMethod(entry)))
}

/** The draft of the index created for `planned` (see `planIndexes`): its own, refined by each request it reads ahead, in
 * order, that one index can still serve with all before it. */
const draftFor = (planned: Planned, reads: ReadonlyArray<Ahead>): Draft => {
	const rank = rankIn(planned.keys)
	return reads.reduce((draft, q) => refined(draft, q, rank) ?? draft, draftOf(planned))
}

/** A request's keys canonical under reversal: reversed when the first descends, so the first ascends. */
const canonicalKeys = (keys: NonEmptyReadonlyArray<IndexKey>): NonEmptyReadonlyArray<IndexKey> =>
	keys[0].dir === "desc" ? mapNonEmpty(keys, (k) => ({ ...k, dir: opposite(k.dir) })) : keys

/** A new index for an unserved request, as drafted for it (draftFor): the draft's method, and its keys in the order
 * the draft fixes, its entry checked against the access method's limit. */
const createIndex = (b: InstallBuilder, planned: Planned, draft: Draft): PlannedIndex => {
	const { request, label, target: o } = planned
	const method = draft.method
	const targetField = (column: IndexColumn): TargetField =>
		o.field(column) ??
		fail("MalformedDescription", label, `a field ${columnText(column)} of ${request.relation}`)
	const keys = keysOf(draft, rankIn(planned.keys))
	const fields = keys.map((k) => columnText(k.column))
	const unrepresentable = (fault: KeyFault): never => {
		throw new Refusal(
			CompileError.make({
				_tag: "UnrepresentableKey",
				at: SourceLoc(label, []),
				subject: `${request.role} index (${fields.join(", ")}) of ${request.relation}`,
				key: fields,
				fault
			})
		)
	}
	switch (method) {
		case "btree":
		case "gist": {
			/** A B-tree or GiST entry is bounded, so every key datum is (`keyDatums`). */
			const datums = keyDatums(
				keys.map((k) => ({ field: columnText(k.column), desc: targetField(k.column).desc }))
			)
			if (!datums.ok) {
				return unrepresentable(datums.error)
			}
			if (method === "btree") {
				/** A law column may hold NULL, which gives the entry its null bitmap; a field is NOT NULL. */
				const entry = btreeEntry(
					datums.value.map((d, i) => ({
						name: d.field,
						datum: d.datum,
						nullable: defined(keys[i], "a datum per key").column.kind === "law"
					}))
				)
				if (!entry.ok) {
					unrepresentable(entry.error)
				}
				break
			}
			const bytes = gistEntryBytes(datums.value)
			if (!bytes.ok) {
				unrepresentable({ kind: "gistOperatorClass", field: bytes.error })
			} else if (bytes.value > gistMaxItemSize.value) {
				unrepresentable({ kind: "gistEntry", bytes: bytes.value, limit: gistMaxItemSize.value })
			}
			break
		}
		case "hnsw":
			if (keys.length > indexMaxKeys.value) {
				unrepresentable({ kind: "columns", limit: indexMaxKeys.value })
			}
			break
		case "hash":
			break
	}
	const named = identity.accessIndex(
		request.relation,
		method,
		keys.map((k) => ({ field: columnText(k.column), dir: k.dir, opclass: k.opclass.kind }))
	)
	const name = b.name(named)
	const ddl: CreateIndex = {
		kind: "createIndex",
		name,
		table: b.names.relation(request.relation),
		method,
		keys: mapNonEmpty(keys, (k) => ({
			...columnKey(o.column(k.column)),
			opclass:
				k.opclass.kind === "default"
					? undefined
					: { schema: k.opclass.schema, name: vectorCosineOpclass },
			direction: k.dir === "desc" ? "DESC" : "ASC"
		})),
		unique: false,
		concurrently: false,
		include: [],
		where: undefined
	}
	const object = b.add(
		{
			kind: "index",
			ident: b.qualifiedOf("index", request.relation, named),
			ddl: [ddl],
			reasons: [reasonOf(request)],
			phase: "indexes"
		},
		[
			o.object,
			...(method === "gist" && keys.some((k) => planned.columns.holds(k.column) !== "span")
				? [b.provider("btree_gist")]
				: [])
		]
	)
	return {
		index: { kind: "created", name },
		relation: request.relation,
		method,
		keys,
		unique: false,
		object,
		requests: [request]
	}
}
