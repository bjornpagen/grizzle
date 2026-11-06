import { catchRefusal, Refusal } from "#compiler/core/canonical.ts"
import type { KeyFault } from "#compiler/core/causes.ts"
import { CompileError, type ProseTag, prose } from "#compiler/core/errors.ts"
import { identity } from "#compiler/core/identity.ts"
import type { ConstraintName, IndexName, LawId } from "#compiler/core/ids.ts"
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
	combine,
	combineAll,
	compareBooleans,
	compareNumbers,
	compareStrings,
	flip,
	mapInput
} from "#compiler/core/order.ts"
import type * as Result from "#compiler/core/result.ts"
import { identityValueOf } from "#compiler/ir/expr.ts"
import {
	allRows,
	defaultOpclass,
	type IndexOpclass,
	type IndexRows,
	isSpanField,
	type NativeColumn,
	type Selector
} from "#compiler/ir/law.ts"
import {
	type AccessUse,
	type IndexRequest,
	type PhysicalReason,
	sameIndexOpclass,
	vectorCosineOpclass
} from "#compiler/ir/products.ts"
import { baseOf, fewValued, type ScalarType, spanCarrierOf } from "#compiler/ir/scalar.ts"
import { literalKey } from "#compiler/laws/model/names.ts"
import type {
	BuiltTarget,
	IndexColumn,
	InstallBuilder,
	TargetField
} from "#compiler/physical/ddl/context.ts"
import { type KeyIndex, rowsPredicate } from "#compiler/physical/ddl/tables.ts"
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
	readonly dir: "asc" | "desc"
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

/** An index's access method. */
type Method = "btree" | "gist" | "hnsw"

/** What a column holds, by its field's type: a GiST index names btree_gist's class for a scalar, whose equality operator
 * serves a B-tree equality probe, and the range type's own for a span. */
type Holds = "scalar" | "span"

const holdsOf = (type: ScalarType): Holds => (spanCarrierOf(type) === undefined ? "scalar" : "span")

/** What serving reads of an index beside its rows (see `planIndexes`): its relation, access method, keys in index order,
 * and whether it holds at most one row per key. */
export interface KeyedIndex {
	readonly relation: string
	readonly method: Method
	readonly keys: ReadonlyArray<IndexKey>
	readonly unique: boolean
}

export interface PlannedIndex extends KeyedIndex {
	/** The index's identifier: one the engine created, or a key or enforcement index another object installs. */
	readonly index:
		| { readonly kind: "created"; readonly name: IndexName }
		| { readonly kind: "installed"; readonly name: ConstraintName }
	/** The rows it holds: a partial index's, the rows of its selection. */
	readonly rows: IndexRows
	/** The graph object that realizes it. */
	readonly object: Node<"structure" | "indexes">
	/** The requests it serves, merged provenance. */
	readonly requests: ReadonlyArray<IndexRequest>
}

/** A function declaration, so that control flow knows a call never returns. */
function fail(tag: ProseTag, label: string, capability: string): never {
	throw new Refusal(CompileError.make(prose(tag, SourceLoc(label, []), capability)))
}

/** The rows a request reads: a law's probe states them; the workload's access reads every row. */
const rowsOf = (r: IndexRequest): IndexRows => (r.role === "lawMaintenance" ? r.rows : allRows)

const requestLabel = (r: IndexRequest): string => {
	const rows = rowsOf(r)
	const selected =
		rows.kind === "all"
			? ""
			: ` of the rows selected by ${rows.selection.map((s) => s.column).join(", ")}`
	return `${r.role} index request on ${r.relation}(${requestColumns(r).map(columnText).join(", ")})${selected} for ${r.use}`
}

/** The columns a request's keys name, in key order: a law's by their arms, the workload's by their fields' names. */
const requestColumns = (r: IndexRequest): ReadonlyArray<IndexColumn> =>
	r.role === "lawMaintenance"
		? r.keys.map((k) => indexColumnOf(k.column))
		: r.keys.map((k): IndexColumn => ({ kind: "field", field: String(k.expr) }))

const reasonOf = (r: IndexRequest): PhysicalReason =>
	r.role === "lawMaintenance" ? { kind: "law", law: r.justification.law } : { kind: "access" }

/**
 * The reverse lookup of every containment the law model lowered to a referencing-side index: one request per law the
 * index serves, over its referencing columns, each a field or a law column by its arm. The law model leaves a constant
 * law column out of them: one value in every row narrows no lookup.
 */
export const reverseRequests = (b: InstallBuilder): ReadonlyArray<IndexRequest> =>
	b.natives.flatMap(({ object: n }) => {
		if (n.kind !== "ReverseIndex") {
			return []
		}
		const columns = n.columns
		const spans = columns.some((c) => c.kind === "field" && isSpanField(c.field))
		return n.lawIds.map((law: LawId): IndexRequest => ({
			relation: n.relation.name,
			keys: mapNonEmpty(columns, (column) => ({
				column,
				dir: "asc" as const,
				opclass: defaultOpclass
			})),
			/** A PERIOD reference's reverse probe tests overlap on the span, which a GiST index serves with its scalar
			 * prefix through btree_gist. */
			method: spans ? "gist" : "btree",
			role: "lawMaintenance",
			use: "reverse reference",
			/** A reference's reverse probe reads every row that references the deleted key. */
			rows: allRows,
			justification: { kind: "law", law }
		}))
	})

/** Whether two selections are one: the same fields in the same order, each equal to the same literal. Both are in their
 * relation's declared field order (`IndexRows`). */
const sameSelection = (
	a: NonEmptyReadonlyArray<Selector>,
	b: NonEmptyReadonlyArray<Selector>
): boolean =>
	a.length === b.length &&
	a.every((x, i) => {
		const y = b[i]
		return y !== undefined && x.column === y.column && literalKey(x.value) === literalKey(y.value)
	})

/** Whether the rows an index holds serve a request that reads `read` (see `planIndexes`): an index of every row serves
 * any request, a partial index only the requests of its own selection. */
const rowsServe = (held: IndexRows, read: IndexRows): boolean =>
	held.kind === "all" || (read.kind === "selected" && sameSelection(held.selection, read.selection))

const sameRows = (a: IndexRows, b: IndexRows): boolean => rowsServe(a, b) && rowsServe(b, a)

type Keys = NonEmptyReadonlyArray<IndexKey>

/** What each column of a request's relation holds, by field: a scalar or a span, and whether it holds few values
 * (fewValued), so that fixing it bounds no scan. */
interface Columns {
	readonly holds: (column: IndexColumn) => Holds
	readonly few: (column: IndexColumn) => boolean
}

/** The access methods of the indexes that may hold a placement, in preference order: an index created for it takes the
 * first. */
type Methods = NonEmptyReadonlyArray<Method>

/** A run of columns that lead an index together, in any order among themselves. */
type Block = NonEmptyReadonlyArray<IndexKey>

/** Columns leading an index as blocks, an ordered request's in its directions or all opposite. */
interface BlocksPlacement {
	readonly kind: "blocks"
	readonly methods: Methods
	readonly blocks: NonEmptyReadonlyArray<Block>
	/** The ordered request's keys, which fix each block's direction up to reversal, when the request is an order. */
	readonly directed: Keys | undefined
}

/** One of `lead` first, and each of `held` among the index's keys. */
interface LedPlacement {
	readonly kind: "led"
	readonly methods: Methods
	readonly lead: Keys
	readonly held: ReadonlyArray<IndexKey>
}

/** A GiST request's own (see `planIndexes`): the first of the index's keys of many values one of `lead`, whatever keys of
 * few values stand before it, and each of `bound` among its keys. */
interface ManyLedPlacement {
	readonly kind: "manyLed"
	readonly methods: Methods
	readonly bound: Keys
	readonly lead: Keys
}

/** A unique index all of whose keys are among `within`: it finds at most one row, on which PostgreSQL rechecks the
 * request's other columns. */
interface KeyedPlacement {
	readonly kind: "keyed"
	readonly methods: Methods
	readonly within: Keys
}

/** Where a request's columns sit in a serving index (see `planIndexes`), and the access methods of the indexes that may
 * hold them so: as blocks leading it, led by one of them and holding others, led by one of them among its columns of many
 * values and holding the rest, or, for a unique index, its every key among some of them. */
type Placement = BlocksPlacement | LedPlacement | ManyLedPlacement | KeyedPlacement

/** A request's placements: the one an index created for it takes, and every other one an index may hold to serve it. */
interface Placements {
	readonly own: BlocksPlacement | ManyLedPlacement
	readonly others: ReadonlyArray<Placement>
}

/** The columns of `fixed` of many values, any of which may lead a serving index that holds the rest. */
const leadsOf = (fixed: ReadonlyArray<IndexKey>, columns: Columns): ReadonlyArray<IndexKey> =>
	fixed.filter((k) => !columns.few(k.column))

/** The methods of an index serving an equality lookup or a range on `keys`: a B-tree, and a GiST index when every key holds
 * a scalar under the default class, through btree_gist's equality and comparison operators. */
const btreeMethods = (keys: Keys, columns: Columns): Methods =>
	keys.every((k) => columns.holds(k.column) === "scalar" && k.opclass.kind === "default")
		? ["btree", "gist"]
		: ["btree"]

/** An index led by one of `leads` and holding every column of `held`, when the request has a lead of many values. */
const ledPlacements = (
	methods: Methods,
	leads: ReadonlyArray<IndexKey>,
	held: ReadonlyArray<IndexKey>
): ReadonlyArray<Placement> =>
	isNonEmpty(leads) ? [{ kind: "led", methods, lead: leads, held }] : []

/** An equality lookup on every column. */
const equalityPlacements = (keys: Keys, columns: Columns): Placements => {
	const methods = btreeMethods(keys, columns)
	return {
		own: { kind: "blocks", methods, blocks: [keys], directed: undefined },
		others: [
			{ kind: "keyed", methods, within: keys },
			...ledPlacements(methods, leadsOf(keys, columns), keys)
		]
	}
}

/** An equality prefix and one range column. */
const rangePlacements = (keys: Keys, columns: Columns): Placements => {
	const methods = btreeMethods(keys, columns)
	const prefix = keys.slice(0, -1)
	const bounded = lastNonEmpty(keys)
	return {
		own: {
			kind: "blocks",
			methods,
			blocks: isNonEmpty(prefix) ? [prefix, [bounded]] : [[bounded]],
			directed: undefined
		},
		others: [
			...(isNonEmpty(prefix) ? [{ kind: "keyed" as const, methods, within: prefix }] : []),
			...ledPlacements(methods, leadsOf(prefix, columns), keys)
		]
	}
}

/** An order, which only a B-tree has. */
const orderedPlacements = (keys: Keys): Placements => ({
	own: {
		kind: "blocks",
		methods: ["btree"],
		blocks: mapNonEmpty(keys, (k): Block => [k]),
		directed: keys
	},
	others: []
})

/** A GiST probe binding every column, a scalar by equality through btree_gist and a span by overlap or equality: a GiST
 * index holding them all, led among its columns of many values by one of theirs, or a unique index all of whose keys the
 * probe binds and the index applies the probe to, a GiST index any, a B-tree its scalars. */
const gistPlacements = (keys: Keys, columns: Columns): Placements => {
	const leads = leadsOf(keys, columns)
	const scalars = keys.filter((k) => columns.holds(k.column) === "scalar")
	const scalarKeyed: ReadonlyArray<Placement> = isNonEmpty(scalars)
		? [{ kind: "keyed", methods: ["btree"], within: scalars }]
		: []
	return {
		own: isNonEmpty(leads)
			? { kind: "manyLed", methods: ["gist"], bound: keys, lead: leads }
			: { kind: "blocks", methods: ["gist"], blocks: [keys], directed: undefined },
		others: [{ kind: "keyed", methods: ["gist"], within: keys }, ...scalarKeyed]
	}
}

/** The nearest vectors, which only an HNSW index on the column under its class finds. */
const nearestPlacements = (keys: Keys): Placements => ({
	own: { kind: "blocks", methods: ["hnsw"], blocks: [keys], directed: undefined },
	others: []
})

/** The placements of each workload use on a B-tree (`accessUses` names them): every column fixed by equality, an
 * equality prefix and one range column, or an order. A span predicate is GiST's and an approximate retrieval HNSW's,
 * which extraction never pairs with a B-tree; the strictest, an order, stands for them. */
const btreePlacements: Readonly<Record<AccessUse, (keys: Keys, columns: Columns) => Placements>> = {
	"key lookup": equalityPlacements,
	"equality lookup": equalityPlacements,
	"join key": equalityPlacements,
	"write target": equalityPlacements,
	range: rangePlacements,
	"prefix search": rangePlacements,
	"take seek": orderedPlacements,
	"page seek": orderedPlacements,
	"span predicate": orderedPlacements,
	"approximate vector retrieval": orderedPlacements
}

/** A request's placements, its keys those it states over `columns`, read once from its access method, role and use: a
 * GiST request binds every column, an HNSW request asks the nearest vectors, a law's B-tree probe looks every column up by
 * equality, and a workload B-tree request needs what its use does. */
const placementsOf = (request: IndexRequest, keys: Keys, columns: Columns): Placements => {
	switch (request.method) {
		case "gist":
			return gistPlacements(keys, columns)
		case "hnsw":
			return nearestPlacements(keys)
		case "btree":
			return request.role === "lawMaintenance"
				? equalityPlacements(keys, columns)
				: btreePlacements[request.use](keys, columns)
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
		case "manyLed": {
			const first = keys.find((l) => !columns.few(l.column))
			return (
				first !== undefined &&
				placement.lead.some((c) => sameKey(first, c)) &&
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

/** A request as the engine plans it: its placements, the rows it reads, and what its relation's columns hold. */
interface Planned {
	readonly request: IndexRequest
	readonly placements: Placements
	readonly rows: IndexRows
	/** Its keys as it states them. */
	readonly keys: Keys
	readonly columns: Columns
	readonly label: string
	readonly target: BuiltTarget
}

/** The access method of the index a planned request creates. */
const ownMethod = (planned: Planned): Method => planned.placements.own.methods[0]

/** Whether an index's relation, access method and keys serve a planned request (see `planIndexes`): it holds one of the
 * request's placements, as an index of a method that placement admits. Serving also asks the index's rows (serves). */
const keysServe = (index: KeyedIndex, planned: Planned): boolean =>
	index.relation === planned.request.relation &&
	[planned.placements.own, ...planned.placements.others].some(
		(p) => p.methods.includes(index.method) && placed(index, p, planned.columns)
	)

/** Whether `index` serves a planned request (see `planIndexes`): it holds the rows the request reads, and its keys serve it. */
const serves = (index: PlannedIndex, planned: Planned): boolean =>
	rowsServe(index.rows, planned.rows) && keysServe(index, planned)

/** An index under construction (see `planIndexes`): the methods it may still have, the rows it holds, blocks covering its
 * columns, and the order whose directions it takes, when an ordered request fixed them. */
interface Draft {
	readonly methods: Methods
	readonly rows: IndexRows
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
 * placement, and a many-led one, whose leads are of many values: of its first block's columns among `lead`, the one the
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

/** The draft of the index a planned request creates: its own placement's methods and blocks, a GiST request's bound
 * columns as one block, in any order a later request fixes, the request's own otherwise, and the rows it reads. */
const draftOf = (planned: Planned): Draft => {
	const own = planned.placements.own
	switch (own.kind) {
		case "blocks":
			return {
				methods: own.methods,
				rows: planned.rows,
				blocks: own.blocks,
				directed: own.directed
			}
		case "manyLed":
			return { methods: own.methods, rows: planned.rows, blocks: [own.bound], directed: undefined }
	}
}

/** Another request a draft's look-ahead reads (see `planIndexes`): one no planned index serves yet, which needs an index,
 * or one another index serves, which PostgreSQL may read through this one too. */
type Ahead =
	| { readonly kind: "unserved"; readonly planned: Planned }
	| { readonly kind: "served"; readonly planned: Planned }

/** The rows a draft holds to serve another request too: its own when they serve the request's; every row for an unserved
 * request of every row, which needs an index of every row anyway; none otherwise. */
const rowsFor = (held: IndexRows, ahead: Ahead): IndexRows | undefined => {
	const read = ahead.planned.rows
	if (rowsServe(held, read)) {
		return held
	}
	return ahead.kind === "unserved" && read.kind === "all" ? allRows : undefined
}

/** A draft refined by one placement of another request, holding `rows`, or none when no one index holds both: no method
 * admits both, or no one order satisfies both. A created index is never unique, so no keyed placement refines it. */
const refinedBy = (
	draft: Draft,
	placement: Placement,
	rows: IndexRows,
	rank: Rank
): Draft | undefined => {
	const methods = draft.methods.filter((m) => placement.methods.includes(m))
	if (!isNonEmpty(methods)) {
		return undefined
	}
	switch (placement.kind) {
		case "keyed":
			return undefined
		case "led": {
			const blocks = leadDraft(draft.blocks, placement.lead, placement.held, rank)
			return blocks === undefined ? undefined : { methods, rows, blocks, directed: draft.directed }
		}
		case "manyLed": {
			const blocks = leadDraft(draft.blocks, placement.lead, placement.bound, rank)
			return blocks === undefined ? undefined : { methods, rows, blocks, directed: draft.directed }
		}
		case "blocks": {
			const blocks = mergeBlocks(draft.blocks, placement.blocks)
			if (blocks === undefined) {
				return undefined
			}
			if (placement.directed === undefined) {
				return { methods, rows, blocks, directed: draft.directed }
			}
			if (draft.directed === undefined) {
				return { methods, rows, blocks, directed: placement.directed }
			}
			const directed = oneDirection(draft.directed, placement.directed)
			return directed === undefined ? undefined : { methods, rows, blocks, directed }
		}
	}
}

/** A draft refined by another request: by its own placement, else by the first of its others that refines it; none when
 * no placement does or the draft's rows cannot hold the request's. */
const refined = (draft: Draft, ahead: Ahead, rank: Rank): Draft | undefined => {
	const rows = rowsFor(draft.rows, ahead)
	if (rows === undefined) {
		return undefined
	}
	const { own, others } = ahead.planned.placements
	for (const placement of [own, ...others]) {
		const found = refinedBy(draft, placement, rows, rank)
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

type Selection = Extract<IndexRows, { readonly kind: "selected" }>["selection"][number]

const selectionOrder: Comparator<ReadonlyArray<Selection>> = listOrder(
	combine(
		mapInput(compareStrings, (x: Selection) => x.column),
		mapInput(compareStrings, (x: Selection) => literalKey(x.value))
	)
)

/** Every row before a selection, then selections by their fields and literals' canonical encodings. */
const rowsOrder: Comparator<IndexRows> = (a, b) => {
	if (a.kind === "all") {
		return b.kind === "all" ? 0 : -1
	}
	if (b.kind === "all") {
		return 1
	}
	return selectionOrder(a.selection, b.selection)
}

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
 * Coverage, one rule (`keysServe` and `serves`), over where a request's columns may sit in a serving index and the access
 * methods of the indexes that may hold them so (Placements), read once from its access method, role and use:
 *
 * - only an index of the same relation can serve a request;
 * - an equality lookup on every requested column (a law's B-tree probe, or a workload key lookup, equality lookup, join
 *   key or B-tree write target) is served by an index whose leading columns are exactly the
 *   requested set, in any order and direction (`(tenant, account, created)` serves an equality lookup on `(account,
 *   tenant)`), or by one led by a requested column of many values that holds every requested column, which bounds the
 *   scan to that column's rows and checks the rest within the index (`(account, created, tenant)` serves it too; a
 *   closed handle or a boolean holds few values, so leading with one bounds no scan). A B-tree serves it, and so does
 *   a GiST index whose leading columns all hold scalars under the default class, because btree_gist gives each scalar
 *   column of a GiST index its equality and comparison operators, a range below likewise: a constraint-created index can satisfy a
 *   request when its native behavior fits (the reverse probes on `employment` and `shift` are
 *   served by the GiST index of a span key, whose leading `employee` column btree_gist serves; a workload lookup of a
 *   key's usage by `key` is served by the GiST index the coverage law of its spans needs on `(key, during)`). A B-tree
 *   index of the same relation is preferred when one serves;
 * - a workload range or prefix-search request is an equality prefix followed by one range column: a B-tree whose leading
 *   columns before the last are exactly the prefix's set in any order, and the next the range column in either
 *   direction, because a B-tree scans an interval forward or backward, or a GiST index so led, its columns scalars
 *   under the default class (the span key's GiST index on `(room, during)` serves a range on room); or an index led by
 *   a prefix column of many values that holds every requested column, as for an equality lookup;
 * - an ordered request, a take or page seek, is served only by a B-tree whose leading columns are the requested ones in
 *   order and either in direction or all in the opposite direction, since a B-tree scanned backward yields the exact
 *   reverse of its order; GiST has no order;
 * - a GiST request (a workload span predicate or GiST write target, a law's GiST probe) binds every requested column,
 *   a scalar by equality through btree_gist and a span by overlap or equality, and is served by a GiST index that holds
 *   every column it binds, and whose first column of many values is one of them, so that every condition of the probe
 *   is the index's and PostgreSQL rechecks none of the rows the index finds. PostgreSQL documents that a multicolumn
 *   GiST index can be used with conditions on any subset of its columns, but that the condition on the first column
 *   decides how much of the index is scanned, and that the index is relatively ineffective when its first column has
 *   few distinct values: GiST places an entry, and splits a page, by the first column whose penalty tells entries apart
 *   (gistchoose, gistSplitByKey), so the entries that tie on a column of few values are placed by the next one, and its
 *   first column of many values decides the scan: a column of few values before it narrows the scan little whether the
 *   request binds it or not, and when the request leaves it unbound, the scan reads every entry of the values before
 *   it. On PostgreSQL 19, over 20,000 rows, a probe binding an int4 of 20,000 values touches 4 buffers of an index on
 *   `(enum, int4, ...)` when it binds the three-valued enum too and 6 when it does not, and 126 of one on `(enum,
 *   numeric, int4, ...)` whose numeric of 141 values it leaves unbound. It is also served by a unique index, a key's of
 *   any access method that applies the probe to its keys (a GiST index any, another its scalars), all of whose keys the
 *   request binds: the index finds the rows of one key, on which PostgreSQL rechecks the rest. So the GiST index of a
 *   span key on `(room, during)` serves a span predicate on `(room, id, during)`, and never one on `during` alone, which
 *   reads most of it, and a GiST index on `(during)` serves the one on `during` alone, while a primary key on `(id)`
 *   serves a span predicate on `(id, during)`. A request that binds no column of many values (its columns all closed
 *   handles or booleans, none a span) is served by an index its bound columns lead, in any order. Extraction states a
 *   span predicate with every column its fixed values and join partners bind, so a request on `during` alone is one
 *   where nothing binds a scalar beside it;
 * - an equality lookup, or a range whose prefix fixes them, is also served by a key's unique index all of whose keys
 *   the request fixes by equality: the index finds at most one row, on which PostgreSQL rechecks the request's other
 *   columns, so a law's probe on `(id, tenant)` is served by the primary key on `id`; an order is not, since PostgreSQL
 *   still sorts by the columns after a key;
 * - an approximate vector retrieval is served by an HNSW index on its column under its class;
 * - operator classes must agree; every collatable key is pg_catalog.pg_c_utf8 by construction, so collation
 *   never differs;
 * - rows: a request reads every row of its relation, or, a law's probe of a selected source (a coverage's source
 *   probe), only the rows its selection chooses (`IndexRows`). An index
 *   of every row serves either; a key's holds every row, the ones null in a column of it too (NULLS DISTINCT). A
 *   partial index, which holds only the rows of its selection (one the engine created for a selected probe), serves
 *   exactly the requests of that selection: a full-table request would miss the rows it leaves out, and so would a
 *   probe of another selection, which PostgreSQL could not prove implies its predicate.
 *
 * Each request's placements in a serving index (`placementsOf`) are the one statement of the rules on columns and methods:
 * its own, which an index created for it takes, and the others an index may hold instead, each with the access methods
 * of the indexes that may hold it, the method an index created for it takes first. A placement is blocks of columns
 * leading the index, each block's columns in any order among themselves (an ordered request's keys each a block of its
 * own, in its directions or all opposite); or one of some columns first and others held (an equality lookup's or a
 * range's led by a column of many values); or one of some columns first among the index's columns of many values, every
 * other held (a GiST request's own); or, for a unique index, every key among some of the columns the request fixes (a
 * GiST request's: a GiST index's among all of them, a B-tree's among its scalars). keysServe reads them to judge an
 * index, and the engine reads them to draft an index it creates.
 *
 * A served request adds its justification to the serving object's reasons; a constraint index can serve it (a primary
 * key serves the reverse lookup of a self-reference, a span key's GiST index the reverse probe of a PERIOD foreign
 * key). Of the indexes that serve a request, it lands on a key or enforcement index before a created one, then on one of
 * its own access method before one standing in for it, then on one of its own rows before one of every row, then on the
 * first planned (`hostOrder`). An unserved request becomes a new index `<table>__ix__<col>[__<col>...]`, wider requests
 * first, so a narrower one lands on a wider index that serves it. The index is drafted (`draftFor`): it starts as the
 * request's own placement, its methods, and the rows the request reads, and is refined, in the plan's order, by the
 * placements of each later request no planned index serves yet, as long as one index still holds them all: of one
 * access method both admit, in one order, and of rows that serve both. An unserved request of every row widens a
 * selected probe's draft to every row, since it needs an index of every row anyway, so a selected probe lands on an
 * index of every row that another request needs rather than adding one beside it (a partial index never serves a
 * full-table request, whatever keys either names); a probe of another selection never does. An unserved selected probe
 * whose draft no full-table request widens becomes a partial index `WHERE <selection>` holding only the selected rows
 * (`rowsPredicate`), a predicate the probe's own WHERE implies, since the law's function spells the selection with the
 * same literals. So an equality lookup on `{account, created}` planned
 * before a range on `created` then `account` creates `(created, account)`, which serves both, a wider equality lookup
 * takes the order a narrower range or order over its columns fixes, an equality lookup on scalars becomes a GiST index
 * when a GiST request over its columns refines it, and a GiST index leads with a column of many values a later GiST
 * request binds (a span predicate on `(fixed, span)` beside one on `(span)` creates `(span, fixed)`, which serves both).
 * A GiST request's draft is refined too by every other request of its relation it can serve, one another index already
 * serves among them, the GiST requests first, never widening its rows for one: PostgreSQL costs
 * a GiST scan by the selectivity of all its conditions whatever their columns' places (genericcostestimate), so it may
 * read a request through any GiST index that holds its columns, and on PostgreSQL 19 it reads a span predicate on
 * `(span)` through `(fixed, span)`, which it sweeps, rather than through the `(span, other)` it is planned on. Within a
 * block the columns keep the request's own order. Since the draft looks ahead, the plan's order only fixes the outcome:
 * it is canonical, so the plan does not depend on the order requests arrive in.
 * Its keys are canonical under reversal: a key no ordered request directs takes the first key's direction, and an index
 * whose first key descends is created reversed, so an order and its exact reverse are one index. Its identity is its
 * columns, the canonical directions and each key's operator class, which serving requires equal, its access method and
 * its rows; the name marks a method other than the B-tree, the descending keys, the classes beyond the default and a
 * partial index's selection, each part of its identity at the naming door (identity.accessIndex). Uniqueness is
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
				rows: allRows,
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
				const columns: Columns = {
					holds: (column) => holdsOf(typeOf(column)),
					few: (column) => fewValued[baseOf(typeOf(column)).carrier]
				}
				return [
					{
						request: r,
						placements: placementsOf(r, keys, columns),
						rows: rowsOf(r),
						keys,
						columns,
						label,
						target: o
					}
				]
			})
			.toSorted(canonical)
		for (const [at, entry] of plan.entries()) {
			const [host] = candidates.filter((c) => serves(c.index, entry)).toSorted(hostOrder(entry))
			if (host !== undefined) {
				host.requests.push(entry.request)
				b.graph.addReasons(host.index.object, [reasonOf(entry.request)])
				continue
			}
			const index = createIndex(b, entry, draftFor(entry, ahead(entry, plan, at, candidates)))
			candidates.push({ index, requests: [entry.request] })
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
	mapInput(rowsOrder, (x: Planned) => x.rows),
	mapInput(compareStrings, (x: Planned) => x.request.use)
])

/** The serving indexes a request lands on first (see `planIndexes`): a key or enforcement index before a created one, so
 * a request a key serves adds nothing; then one of the request's own access method before one standing in for it; then
 * one of its own rows before one of every row serving a selected probe; then the first planned. */
const hostOrder = (entry: Planned): Comparator<Candidate> =>
	combineAll([
		mapInput(compareBooleans, (c: Candidate) => c.index.index.kind === "created"),
		mapInput(compareBooleans, (c: Candidate) => c.index.method !== ownMethod(entry)),
		mapInput(compareBooleans, (c: Candidate) => !sameRows(c.index.rows, entry.rows))
	])

/** The requests the draft of the index created for the unserved `plan[at]` reads ahead (see `planIndexes`): the later
 * requests of its relation no planned index serves yet; for a GiST request, every other request of its relation too, the
 * GiST requests first. */
const ahead = (
	entry: Planned,
	plan: ReadonlyArray<Planned>,
	at: number,
	candidates: ReadonlyArray<Candidate>
): ReadonlyArray<Ahead> => {
	const later = plan
		.slice(at + 1)
		.filter(
			(q) =>
				q.request.relation === entry.request.relation && !candidates.some((c) => serves(c.index, q))
		)
	const unserved = later.map((planned): Ahead => ({ kind: "unserved", planned }))
	if (ownMethod(entry) !== "gist") {
		return unserved
	}
	const served = plan
		.filter(
			(q) => q !== entry && q.request.relation === entry.request.relation && !later.includes(q)
		)
		.map((planned): Ahead => ({ kind: "served", planned }))
	return [...unserved, ...served].toSorted(
		mapInput(compareBooleans, (q: Ahead) => ownMethod(q.planned) !== "gist")
	)
}

/** The draft of the index created for `planned` (see `planIndexes`): its own, refined by each request it reads ahead, in
 * order, that one index can still serve with all before it. */
const draftFor = (planned: Planned, reads: ReadonlyArray<Ahead>): Draft => {
	const rank = rankIn(planned.keys)
	return reads.reduce((draft, q) => refined(draft, q, rank) ?? draft, draftOf(planned))
}

const opposite = (dir: "asc" | "desc"): "asc" | "desc" => (dir === "asc" ? "desc" : "asc")

/** A request's keys canonical under reversal: reversed when the first descends, so the first ascends. */
const canonicalKeys = (keys: NonEmptyReadonlyArray<IndexKey>): NonEmptyReadonlyArray<IndexKey> =>
	keys[0].dir === "desc" ? mapNonEmpty(keys, (k) => ({ ...k, dir: opposite(k.dir) })) : keys

/** A new index for an unserved request, as drafted for it (draftFor): the draft's first method, its rows, and its keys in
 * the order the draft fixes, its entry checked against the access method's limit. */
const createIndex = (b: InstallBuilder, planned: Planned, draft: Draft): PlannedIndex => {
	const { request, label, target: o } = planned
	const { rows } = draft
	const method = draft.methods[0]
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
						nullable: keys[i]?.column.kind === "law"
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
	}
	const named = identity.accessIndex(
		request.relation,
		method,
		keys.map((k) => ({ field: columnText(k.column), dir: k.dir, opclass: k.opclass.kind })),
		rows.kind === "all"
			? []
			: rows.selection.map((s) => ({ field: s.column, value: identityValueOf(s.value) }))
	)
	const name = b.name(named)
	const where = rowsPredicate(
		b,
		request.relation,
		rows,
		(field) => targetField({ kind: "field", field }).type
	)
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
		where
	}
	const object = b.add(
		{
			kind: "index",
			ident: b.qualified("index", named),
			ddl: [ddl],
			reasons: [reasonOf(request)],
			phase: "indexes"
		},
		[
			o.object,
			...(method === "gist" && keys.some((k) => planned.columns.holds(k.column) === "scalar")
				? [b.provider("btree_gist")]
				: [])
		]
	)
	return {
		index: { kind: "created", name },
		relation: request.relation,
		method,
		keys,
		rows,
		unique: false,
		object,
		requests: [request]
	}
}
