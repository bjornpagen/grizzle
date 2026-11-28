import { defect, defined, invariant } from "@bjornpagen/grizzle-text/base/invariant"
import {
	extendNonEmpty,
	isNonEmpty,
	lastNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray,
	sortNonEmpty
} from "@bjornpagen/grizzle-text/base/nonempty"
import type * as Result from "@bjornpagen/grizzle-text/base/result"
import { catchRefusal, Refusal } from "#compiler/core/canonical.ts"
import type { KeyFault } from "#compiler/core/causes.ts"
import { CompileError, type ProseTag, prose } from "#compiler/core/errors.ts"
import {
	type EntryRole,
	identifierOf,
	identity,
	type IndexMethod
} from "#compiler/core/identity.ts"
import type { ConstraintName, IndexName, LawId } from "#compiler/core/ids.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import {
	type Comparator,
	combineAll,
	compareBooleans,
	compareNumbers,
	compareStrings,
	flip,
	listOrder,
	mapInput,
	type Direction,
	opposite
} from "#compiler/core/order.ts"
import {
	defaultOpclass,
	type IndexOpclass,
	type LawIndexRequest,
	type NativeColumn
} from "#compiler/ir/law.ts"
import { lawColumnType } from "#compiler/ir/physical.ts"
import {
	type AccessUse,
	type IndexRequest,
	indexOpclassText,
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
import type { KeyIndex, KeyRole } from "#compiler/physical/ddl/tables.ts"
import {
	fewestSharingGroups,
	type OrderKey,
	together as ordersTogether
} from "#compiler/physical/indexes/chains.ts"
import {
	type IndexRef,
	type IndexResolver,
	type IndexServing,
	indexRef
} from "#compiler/physical/indexes/ref.ts"
import type { Node } from "#compiler/physical/obligations/graph.ts"
import {
	type DatumBound,
	datumBound,
	gistEntryBytes,
	gistMaxItemSize,
	indexMaxKeys,
	keyDatums,
	lookupEntry
} from "#compiler/schema/representability.ts"
import type { ColumnDefinition, CreateIndex, IndexKey as SqlIndexKey } from "#compiler/sql/ast.ts"
import {
	cast,
	columnKey,
	exprKey,
	namedType,
	objectName,
	row,
	tableCol
} from "#compiler/sql/build.ts"
import { suffixKeyOf } from "#compiler/sql/suffix.ts"
import { installationTypes } from "#compiler/sql/type-schemas.ts"

/**
 * What an index key holds: a column by its arm, a field or a law column; or a text field's suffix key,
 * `chr(1) || reverse(column)` (sql/suffix.ts suffixKeyOf), which a law's probe seeks a suffix it holds fixed through as a
 * range of the key (sql/bind.ts, ir/products.ts AccessKeyTerm), every judged read of a stored text stating the range in
 * place of its suffix test (seekingSuffixes), a key past its request's equalities that only an index holding the same field's
 * suffix key serves. No key holds a column by an image: an index holds a column as itself or not at all (README "Keys
 * and indexes").
 *
 * The suffix key's coordinates are code points: its range is code point order, which comparing two texts collated
 * pg_catalog.pg_c_utf8 is, the one collation grizzle stores a text in (sql/ast.ts Collation), which PostgreSQL defines
 * for the UTF8 encoding alone, so an installation stands only in a UTF8 database; PostgreSQL's reverse() reverses by
 * code points, a multibyte character kept whole; and the leading U+0001 is a sentinel under which every suffix has a
 * least text above its keys, the key's last code point not U+10FFFF raised by one, U+D7FF to U+E000 past the
 * surrogates, which no text holds. The engine drafts a B-tree on a suffix key only where a judged read's plan ranges one
 * (physical/ddl/rules.ts routineRequests), never a workload's, whose statements state no suffix range.
 */
export type KeyTerm = IndexColumn | { readonly kind: "suffix"; readonly of: IndexColumn }

/** A key of an index, or one a request asks an index for. */
export interface IndexKey {
	readonly column: KeyTerm
	readonly dir: Direction
	readonly opclass: IndexOpclass
}

/** A native object's column as an index names it, by its arm. */
const indexColumnOf = (c: NativeColumn): IndexColumn =>
	c.kind === "field" ? { kind: "field", field: c.field.name } : c

/**
 * A key's text as the plan orders, labels and names its indexes by: a field's name, a law column's identifier, or a
 * suffix key's `suffix(<column>)`. A law column's identifier starts with `__`, and no declared name holds a parenthesis,
 * so the texts of a relation's keys are distinct.
 */
export const keyTermText = (c: KeyTerm): string => {
	switch (c.kind) {
		case "field":
			return c.field
		case "law":
			return c.column
		case "suffix":
			return `suffix(${keyTermText(c.of)})`
	}
}

/** A native column's text, as an index's key names it (`keyTermText`). */
export const nativeText = (c: NativeColumn): string => keyTermText(indexColumnOf(c))

/** Whether two keys hold one thing: one field, one law column, or the suffix key of one, which no equality reads. */
const sameColumn = (a: KeyTerm, b: KeyTerm): boolean => {
	if (a.kind === "suffix" || b.kind === "suffix") {
		return a.kind === "suffix" && b.kind === "suffix" && sameColumn(a.of, b.of)
	}
	switch (a.kind) {
		case "field":
			return b.kind === "field" && a.field === b.field
		case "law":
			return b.kind === "law" && a.column === b.column
	}
}

/**
 * A suffix key's datum (sql/suffix.ts suffixKeyOf): its text's, which it holds reversed, and the sentinel U+0001
 * before it, one byte of UTF-8 more.
 */
const suffixDatum = (text: DatumBound): DatumBound => ({ ...text, bytes: text.bytes + 1 })

/** The column a key reads: its own, or the column it is the suffix key of. */
const readColumn = (c: KeyTerm): IndexColumn => (c.kind === "suffix" ? c.of : c)

/** What a column of `relation` holds, by its text (`keyTermText`): none for a column it does not hold. */
const columnHolds = (relation: CoveredRelation, column: IndexColumn): Holds | undefined => {
	const text = keyTermText(column)
	return Object.hasOwn(relation.holds, text) ? relation.holds[text] : undefined
}

/** A key's widest datum on `relation`: its column's (CoveredRelation `datums`), a suffix key's with the sentinel's byte
 * (`suffixDatum`); none for a text of no byte bound or a bytes field, which no entry holds. */
const keyDatum = (relation: CoveredRelation, k: IndexKey): DatumBound | undefined => {
	const text = keyTermText(readColumn(k.column))
	const datum = Object.hasOwn(relation.datums, text) ? relation.datums[text] : undefined
	return k.column.kind === "suffix" && datum !== undefined ? suffixDatum(datum) : datum
}

/**
 * The B-tree entry over `keys` on `relation`, each key in its role (`roleOf`), as lookupEntry holds it
 * (schema/representability.ts): the places of the keys that fit it, each equality left out a filter beside it, or its
 * fault. A law column, which a guard or a predecessor's first slot leaves NULL, gives the entry its null bitmap; a field
 * is NOT NULL.
 */
const fittingKeys = (
	relation: CoveredRelation,
	keys: NonEmptyReadonlyArray<IndexKey>,
	roleOf: (k: IndexKey, at: number) => EntryRole
): ReturnType<typeof lookupEntry> =>
	lookupEntry(
		mapNonEmpty(keys, (k, at) => ({
			name: keyTermText(k.column),
			datum: keyDatum(relation, k),
			nullable: readColumn(k.column).kind === "law",
			role: roleOf(k, at)
		}))
	)

/**
 * What each of a request's keys, in their order, is to its entry (core/identity.ts EntryRole): a law's probe's every
 * key an equality but a suffix key, which its seek matches a prefix of; a workload request's every key its path binds
 * by equality (AccessIndexRequest `fixed`) an equality, a seek's fixed prefix among them, and every key past them a
 * prefix matched where it is a prefix search's and read in its order otherwise.
 */
const keyRoles = (
	request: IndexRequest,
	keys: ReadonlyArray<IndexKey>
): ReadonlyArray<EntryRole> => {
	if (request.role === "lawMaintenance") {
		return keys.map((k) => (k.column.kind === "suffix" ? "prefix" : "equality"))
	}
	const past: EntryRole = request.use === "prefix search" ? "prefix" : "order"
	return keys.map((_, at) => (at < request.fixed ? "equality" : past))
}

/**
 * What a column holds, by its field's type: a scalar of few values, a closed id's roster code or a boolean (fewValued);
 * a scalar of many values; or a span. A GiST index names btree_gist's class for a scalar,
 * whose equality and comparison operators search a B-tree's conditions, and the range type's own for a span; it places
 * an entry by its first column of many values, a scalar's or a span's, so a column of few values places none, and a
 * scan descends once per value of one before that column that its condition leaves unbound.
 */
export type Holds = "few" | "many" | "span"

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
	/** The index's identifier: one the engine created, or a key or enforcement index another object installs, whose order is
	 * its key's. */
	readonly index:
		| { readonly kind: "created"; readonly name: IndexName }
		| { readonly kind: "installed"; readonly name: ConstraintName }
	/** The graph object that realizes it. */
	readonly object: Node<"structure" | "indexes">
	/** The requests it serves, merged provenance. */
	readonly requests: ReadonlyArray<IndexRequest>
}

/**
 * What coverage reads of the table a relation's indexes are on (see `planIndexes`): what each column an index of it may
 * name holds (Holds), a field by its name and a law column by its identifier (`keyTermText`); each such column's widest
 * datum in an index entry, but a text's of no byte bound and a bytes field's, which no B-tree entry holds; and whether
 * it is a stored derived relation's table, a lookup of which by equalities of columns no B-tree entry holds reads a hash
 * index.
 */
export interface CoveredRelation {
	readonly holds: Readonly<Record<string, Holds>>
	readonly datums: Readonly<Record<string, DatumBound>>
	readonly stored: boolean
}

/** A relation's table as coverage reads it (CoveredRelation), each column of its target by its text, in text order. */
const coveredRelationOf = (target: BuiltTarget, stored: boolean): CoveredRelation => {
	const fields = target.fields.toSorted(([a], [b]) => compareStrings(a, b))
	return {
		holds: Object.fromEntries(fields.map(([text, field]) => [text, holdsOf(field.type)] as const)),
		datums: Object.fromEntries(
			fields.flatMap(([text, field]) => {
				const datum = field.desc.kind === "bytes" ? undefined : datumBound(field.desc)
				return datum === undefined ? [] : [[text, datum] as const]
			})
		),
		stored
	}
}

/**
 * What an index stands as among the indexes that serve a request (`hostOrder`): its relation's primary key's or another
 * key's, which the schema's statements state, or one the engine created, `at` its place among the installation's
 * indexes when it was created, the plan's canonical order (`canonical`).
 */
export type Standing =
	| { readonly kind: KeyRole }
	| { readonly kind: "created"; readonly at: number }

/** An index the installation holds as coverage reads it: what serving reads of it, how it stands, and the reference a plan
 * names it by. */
export interface InstalledIndex extends KeyedIndex {
	readonly standing: Standing
	readonly ref: IndexRef
}

/**
 * The installation's indexes as coverage reads them, with the table of every relation one is on (see `planIndexes`):
 * the one input of resolution (`resolverOf`), planning's over the indexes it planned and every served compile's over the
 * ones its snapshot records (deploy/snapshot/types.ts SnapshotDerived `indexSet`), so a read resolves to one index
 * whichever compile binds it.
 */
export interface IndexSet {
	readonly indexes: ReadonlyArray<InstalledIndex>
	readonly relations: Readonly<Record<string, CoveredRelation>>
}

/**
 * What index planning gives the installation (see `planIndexes`): every index it holds, a key's or enforcement's and
 * each the engine created, with the requests each serves; the set they are as coverage reads them, which the snapshot
 * records; and the resolver of that set and its partial form (`resolverOf`, `servingOf`).
 */
export interface IndexPlan {
	readonly indexes: ReadonlyArray<PlannedIndex>
	readonly set: IndexSet
	readonly resolve: IndexResolver
	readonly serving: IndexServing
}

/**
 * Whether an index of `method` over columns of `carriers` returns the values it stores (amcanreturn), which an
 * index-only scan reads: a B-tree always; a GiST index where every column's operator class has a fetch function or no
 * compress function (gistget.c gistcanreturn): a range's own class has no compress, and btree_gist's classes fetch but
 * gist_inet_ops and gist_cidr_ops, which have no fetch function, as core's inet_ops is held alike; a hash, GIN or HNSW
 * index never.
 */
const returnsOf = (method: IndexMethod, carriers: ReadonlyArray<string>): boolean => {
	switch (method) {
		case "btree":
			return true
		case "gist":
			return carriers.every((c) => c !== "inet" && c !== "cidr")
		case "hash":
		case "gin":
		case "hnsw":
			return false
	}
}

/** A function declaration, so that control flow knows a call never returns. */
function fail(tag: ProseTag, label: string, capability: string): never {
	throw new Refusal(CompileError.make(prose(tag, SourceLoc(label, []), capability)))
}

const requestLabel = (r: IndexRequest): string =>
	`${r.role} index request on ${r.relation}(${requestColumns(r).map(keyTermText).join(", ")}) for ${r.use}`

/** The keys a request states, in key order, each column a law's by its arm, an access request's its field or the
 * field's suffix key (AccessKeyTerm). */
const statedKeys = (r: IndexRequest): ReadonlyArray<IndexKey> =>
	r.role === "lawMaintenance"
		? lawBlocks(r).flat()
		: r.keys.map((k): IndexKey => ({
				column:
					typeof k.expr === "string"
						? { kind: "field", field: k.expr }
						: { kind: "suffix", of: { kind: "field", field: k.expr.suffix } },
				dir: k.dir,
				opclass: k.opclass
			}))

/** The columns a request's keys name, in key order (statedKeys). */
const requestColumns = (r: IndexRequest): ReadonlyArray<KeyTerm> =>
	statedKeys(r).map((k) => k.column)

const reasonOf = (r: IndexRequest): PhysicalReason =>
	r.role === "lawMaintenance" ? r.justification : { kind: "access" }

/** A law-maintenance request's justification as one text: its law, or what it enforces. */
const justificationText = (j: LawIndexRequest["justification"]): string =>
	j.kind === "law" ? `law ${j.law}` : `enforcement ${j.of}`

/**
 * The reverse lookup of every foreign key the law model installs, each of which carries its referencing-side index
 * (laws/model/plan.ts Reversed): one request per law the index serves, over the columns and by the method the law model
 * planned it (ir/law.ts ReverseIndexOn), each a field or a law column by its arm. The law model leaves a constant law
 * column out of them: one value in every row narrows no lookup.
 */
export const reverseRequests = (b: InstallBuilder): ReadonlyArray<IndexRequest> =>
	b.natives.flatMap(({ object: n }) => {
		if (n.kind !== "ReverseIndex") {
			return []
		}
		return n.lawIds.map((law: LawId): IndexRequest => ({
			relation: n.relation.name,
			blocks: [
				mapNonEmpty(n.columns, (column) => ({
					column,
					dir: "asc" as const,
					opclass: defaultOpclass
				}))
			],
			method: n.method,
			role: "lawMaintenance",
			use: "reverse reference",
			justification: { kind: "law", law }
		}))
	})

type Keys = NonEmptyReadonlyArray<IndexKey>

/** What each key of a request's relation holds (Holds), by field. */
interface Columns {
	readonly holds: (column: KeyTerm) => Holds
}

/** A run of columns that lead an index together, in any order among themselves. */
type Block = NonEmptyReadonlyArray<IndexKey>

/** A law's request's blocks of keys (ir/law.ts LawIndexRequest), each column an index column, a suffix key over one. */
const lawBlocks = (r: LawIndexRequest): NonEmptyReadonlyArray<Block> =>
	mapNonEmpty(r.blocks, (block) =>
		mapNonEmpty(block, (k): IndexKey => ({
			column:
				k.column.kind === "suffix"
					? { kind: "suffix", of: indexColumnOf(k.column.of) }
					: indexColumnOf(k.column),
			dir: k.dir,
			opclass: k.opclass
		}))
	)

/**
 * Columns leading an index as blocks, each block's columns in any order among themselves, an ordered request's order
 * keys in their directions or all opposite: a B-tree's, which narrows its scan by its leading columns in order whatever
 * values they hold; the one column of a hash or an HNSW index; or a GiST index's leading columns where its first block
 * holds a column of many values, which places its entries (`gistLed`), so a scan binding that block descends once.
 */
interface BlocksPlacement {
	readonly kind: "blocks"
	readonly method: IndexMethod
	readonly blocks: NonEmptyReadonlyArray<Block>
	/**
	 * An ordered request's order keys, those past the columns it fixes by equality, each a block of its own after them,
	 * whose directions its index takes up to reversal (`together`); none for any other request, and none for a fixed
	 * column, which one value holds within the seek, so any direction serves it.
	 */
	readonly directed: Keys | undefined
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
 * blocks leading an index, a GiST index placed by one of them and holding the rest, which serves a GiST request alone, or,
 * for a unique index, its every key among some of them. */
type Placement = BlocksPlacement | PlacedPlacement | KeyedPlacement

/** The access method of the indexes that hold a placement. */
const methodOf = (placement: Placement): IndexMethod => {
	switch (placement.kind) {
		case "blocks":
		case "keyed":
			return placement.method
		case "placed":
			return "gist"
	}
}

/** A request's placements: the one an index created for it takes, and every other one an index may hold to serve it. */
interface Placements {
	readonly own: BlocksPlacement | PlacedPlacement
	readonly others: ReadonlyArray<Placement>
}

/** The columns of `fixed` that place an entry, of many values or a span: any may be a GiST index's first column of many
 * values. */
const placingOf = (fixed: ReadonlyArray<IndexKey>, columns: Columns): ReadonlyArray<IndexKey> =>
	fixed.filter((k) => columns.holds(k.column) !== "few")

/**
 * A GiST index leading with `blocks`, a B-tree request's own, as a B-tree would (`placementsOf`), where its first block
 * holds a column of many values, which places the index's entries, so the request's scan descends once, and btree_gist
 * searches each of its columns by its equality and comparison operators, a scalar under the default class.
 */
const gistLed = (
	blocks: NonEmptyReadonlyArray<Block>,
	columns: Columns
): ReadonlyArray<Placement> =>
	isNonEmpty(placingOf(blocks[0], columns)) &&
	blocks.every((block) =>
		block.every((k) => columns.holds(k.column) !== "span" && k.opclass.kind === "default")
	)
		? [{ kind: "blocks", method: "gist", blocks, directed: undefined }]
		: []

/**
 * A law's lookup, an equality lookup on every column that PostgreSQL's RI trigger or the rule judge runs once per row a
 * write touches (ri_triggers.c, RI_FKey_noaction_del): an index whose leading columns are exactly the requested set, its
 * blocks in order (ir/law.ts LawIndexRequest), a B-tree's or a GiST index's (`gistLed`), or a unique B-tree all of whose
 * keys it binds, which finds at most one row.
 */
const reversePlacements = (
	blocks: NonEmptyReadonlyArray<Block>,
	keys: Keys,
	columns: Columns
): Placements => ({
	own: { kind: "blocks", method: "btree", blocks, directed: undefined },
	others: [{ kind: "keyed", method: "btree", within: keys }, ...gistLed(blocks, columns)]
})

/** An equality lookup on every column: an index whose leading columns are exactly its set, or a unique B-tree all of
 * whose keys it binds. */
const equalityPlacements = (keys: Keys, columns: Columns): Placements => ({
	own: { kind: "blocks", method: "btree", blocks: [keys], directed: undefined },
	others: [{ kind: "keyed", method: "btree", within: keys }, ...gistLed([keys], columns)]
})

/** An equality prefix and one range column, `keys` the prefix and then the range column: an index whose leading columns
 * are exactly the prefix's set and then the range column, or a unique B-tree all of whose keys the prefix binds. */
const prefixedRangePlacements = (
	prefix: Keys,
	bounded: IndexKey,
	columns: Columns
): Placements => ({
	own: { kind: "blocks", method: "btree", blocks: [prefix, [bounded]], directed: undefined },
	others: [
		{ kind: "keyed", method: "btree", within: prefix },
		...gistLed([prefix, [bounded]], columns)
	]
})

/** One range column alone: an index led by it. */
const bareRangePlacements = (bounded: IndexKey, columns: Columns): Placements => ({
	own: { kind: "blocks", method: "btree", blocks: [[bounded]], directed: undefined },
	others: gistLed([[bounded]], columns)
})

/** An equality prefix and one range column: the prefix places a GiST index's entries, or, empty, the range column. */
const rangePlacements = (keys: Keys, columns: Columns): Placements => {
	const prefix = keys.slice(0, -1)
	const bounded = lastNonEmpty(keys)
	return isNonEmpty(prefix)
		? prefixedRangePlacements(prefix, bounded, columns)
		: bareRangePlacements(bounded, columns)
}

/**
 * An order, which only a B-tree has, its first `fixed` keys bound by equality: a B-tree leading with those keys as one
 * block, in any order and any direction, since one value holds each within the seek, then each order key after them in
 * its direction, or each opposite (BlocksPlacement `directed`), so two seeks that differ only in their fixed keys' order
 * or directions ask for one index; or, a superkey seek, a unique B-tree all of whose keys those equalities bind, which
 * finds at most one row, in every order, so the seek asks for no index of its own beside the key's.
 */
const orderedPlacements = (keys: Keys, fixed: number): Placements => {
	const bound = keys.slice(0, fixed)
	const order = keys.slice(fixed)
	return {
		own: {
			kind: "blocks",
			method: "btree",
			blocks: isNonEmpty(bound)
				? extendNonEmpty<Block>(
						[bound],
						order.map((k): Block => [k])
					)
				: mapNonEmpty(keys, (k): Block => [k]),
			directed: isNonEmpty(order) ? order : undefined
		},
		others: isNonEmpty(bound) ? [{ kind: "keyed", method: "btree", within: bound }] : []
	}
}

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
 * An equality probe that no B-tree entry holds, which only a hash index serves: on its one column, or, a row equality,
 * on the row of its columns (`createIndex`), its one hash code the row's: no B-tree, GiST or HNSW request ever lands on
 * a hash index, nor a hash request on another.
 */
const hashPlacements = (keys: Keys): Placements => ({
	own: { kind: "blocks", method: "hash", blocks: [keys], directed: undefined },
	others: []
})

/**
 * The documents a query matches, which only a GIN index on the search document's column finds: tsvector's default GIN
 * class indexes each lexeme a document holds, so a match reads the documents of the query's lexemes and no other row.
 */
const textSearchPlacements = (keys: Keys): Placements => ({
	own: { kind: "blocks", method: "gin", blocks: [keys], directed: undefined },
	others: []
})

/**
 * The values of a network column that contain, lie within or overlap a known value, which only a GiST index on the
 * column under inet_ops finds for every one of the three: a B-tree reads a column's networks within a constant as a
 * range, but none containing it.
 */
const containmentPlacements = (keys: Keys): Placements => ({
	own: { kind: "placed", lead: keys, bound: keys },
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
	"approximate vector retrieval": "none",
	"text search": "none",
	"network containment": "none",
	"row equality": "none"
}

/** A workload B-tree request's placements, by what its use asks of a B-tree (btreeNeeds), its first `fixed` keys bound
 * by equality (AccessIndexRequest `fixed`). */
const btreeAccessPlacements = (
	use: AccessUse,
	keys: Keys,
	fixed: number,
	columns: Columns,
	label: string
): Placements => {
	switch (btreeNeeds[use]) {
		case "lookup":
			return equalityPlacements(keys, columns)
		case "range":
			return rangePlacements(keys, columns)
		case "order":
			return orderedPlacements(keys, fixed)
		case "none":
			return fail("MalformedDescription", label, `a use a B-tree serves; ${use} is none`)
	}
}

/** A request's placements, its keys those it states over `columns`, read once from its access method, role and use: a
 * row equality binds the row of its columns, a GiST request binds every column, an HNSW request asks the nearest
 * vectors, a law's B-tree probe looks every column up by equality, and a workload B-tree request needs what its use
 * does. */
const placementsOf = (
	request: IndexRequest,
	keys: Keys,
	blocks: NonEmptyReadonlyArray<Block>,
	columns: Columns,
	label: string
): Placements => {
	if (request.role === "access" && request.use === "row equality") {
		return hashPlacements(keys)
	}
	switch (request.method) {
		case "gist":
			return request.role === "access" && request.use === "network containment"
				? containmentPlacements(keys)
				: gistPlacements(keys, columns, label)
		case "hnsw":
			return nearestPlacements(keys)
		case "gin":
			return textSearchPlacements(keys)
		case "hash":
			return hashPlacements(keys)
		case "btree":
			return request.role === "lawMaintenance"
				? reversePlacements(blocks, keys, columns)
				: btreeAccessPlacements(request.use, keys, request.fixed, columns, label)
	}
}

/** A request's keys as blocks (`placementsOf`): a law's request's blocks, any other's keys as one. */
const blocksOf = (request: IndexRequest, keys: Keys): NonEmptyReadonlyArray<Block> =>
	request.role === "lawMaintenance" ? lawBlocks(request) : [keys]

/** Whether two keys name one column under one class. */
const sameKey = (a: IndexKey, b: IndexKey): boolean =>
	sameColumn(a.column, b.column) && sameIndexOpclass(a.opclass, b.opclass)

/** Whether keys, as many of each, name exactly the same columns under the same classes, in any order. */
const sameSet = (have: ReadonlyArray<IndexKey>, want: ReadonlyArray<IndexKey>): boolean =>
	have.length === want.length &&
	want.every((k) => have.some((l) => sameKey(l, k))) &&
	have.every((l) => want.some((k) => sameKey(l, k)))

/** Whether two lists of keys take one direction on the columns they share (indexes/chains.ts `together`): an index
 * holds an order (BlocksPlacement `directed`) when its keys and the order are together, its blocks having placed the
 * order's columns. */
const together = (a: ReadonlyArray<IndexKey>, b: ReadonlyArray<IndexKey>): boolean =>
	ordersTogether(a.map(orderKeyOf), b.map(orderKeyOf))

/** A key as an order's key (indexes/chains.ts OrderKey): its identity in a chain's sets, and its direction. */
const orderKeyOf = (k: IndexKey): OrderKey => ({ key: keyIdentity(k), dir: k.dir })

/** Whether an index's keys hold a placement (see `planIndexes`), over `columns`, what its relation's columns hold. */
const placed = (index: KeyedIndex, placement: Placement, columns: Columns): boolean => {
	const keys = index.keys
	switch (placement.kind) {
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
			return placement.directed === undefined || together(keys, placement.directed)
		}
	}
}

/**
 * Refuses each text of no byte bound a B-tree request binds by equality where it binds no digest of it (its target's
 * `digests`, physical/ddl/context.ts BuiltTarget) and its other equalities bind none of its relation's keys (`keyed`),
 * as UnrepresentableKey (KeyFault `undigestedText`), and whether it refused one: no B-tree entry holds the text, so its
 * index could only filter it beside the columns it holds, every row those find read and compared, where the text's
 * digest, which the read binds wherever the rule states the text's equality (check/checker.ts RuleCheck
 * `#stateDigests`), is a 32-byte key its index holds, so the read seeks the rows of its digest and rechecks the text on
 * them alone. A request whose other equalities bind a key reads one row, which the text's filter rechecks. A refused
 * request plans no index.
 */
const refusedUndigested = (
	b: InstallBuilder,
	r: IndexRequest,
	label: string,
	o: BuiltTarget,
	stated: Stated,
	keyed: (columns: ReadonlyArray<KeyTerm>) => boolean
): boolean => {
	const { keys, roles } = stated
	const equalities = keys.filter((_, at) => roles[at] === "equality")
	const unbounded = equalities.filter((k) => {
		const field = o.field(readColumn(k.column))
		return (
			field !== undefined &&
			field.desc.kind !== "bytes" &&
			baseOf(field.type).carrier === "text" &&
			keyDatum(stated.relation, k) === undefined
		)
	})
	const digests = o.digests
	const undigested = unbounded.filter((k) => {
		const digest = digests.get(keyTermText(k.column))
		return digest === undefined || !equalities.some((e) => keyTermText(e.column) === digest)
	})
	if (
		!isNonEmpty(undigested) ||
		keyed(equalities.filter((e) => !unbounded.some((u) => sameKey(u, e))).map((e) => e.column))
	) {
		return false
	}
	const fields = keys.map((k) => keyTermText(k.column))
	for (const k of undigested) {
		const field = keyTermText(k.column)
		b.keys.refuse({
			at: SourceLoc(label, []),
			subject: `${label} (${r.role === "lawMaintenance" ? justificationText(r.justification) : "the workload's access"})`,
			key: fields,
			fault: { kind: "undigestedText", field, digest: digests.get(field) }
		})
	}
	return true
}

/**
 * A request as its statement reads on its relation's table (`statedOf`): its keys as it states them (`statedKeys`), each
 * a column `relation` holds; their blocks (`blocksOf`), each key as a created index holds it; what each key, in their
 * order, is to its entry (`keyRoles`); what each column holds; and its placements as its access method, role and use
 * read them (`placementsOf`).
 */
interface Stated {
	readonly request: IndexRequest
	readonly relation: CoveredRelation
	readonly keys: Keys
	readonly blocks: NonEmptyReadonlyArray<Block>
	readonly roles: ReadonlyArray<EntryRole>
	readonly columns: Columns
	readonly placements: Placements
	readonly label: string
}

/**
 * `request` as it reads on `relation`, its relation's table (Stated): a request naming a column the table does not hold,
 * or one its access method, role and use place nowhere, refused as its asker's malformed description.
 */
const statedOf = (request: IndexRequest, relation: CoveredRelation): Stated => {
	const label = requestLabel(request)
	const stated = statedKeys(request)
	if (!isNonEmpty(stated)) {
		return fail("MalformedDescription", label, "an index request with a key")
	}
	const held = (column: IndexColumn): Holds =>
		columnHolds(relation, column) ??
		fail(
			"UnsupportedOperation",
			label,
			`a key column of ${request.relation}; ${keyTermText(column)} is none, and expression keys are the workload compiler's`
		)
	for (const key of stated) {
		held(readColumn(key.column))
	}
	const blocks = blocksOf(request, stated)
	const keys = extendNonEmpty(blocks[0], blocks.slice(1).flat())
	const columns: Columns = {
		holds: (column) => (column.kind === "suffix" ? "many" : held(column))
	}
	return {
		request,
		relation,
		keys,
		blocks,
		roles: keyRoles(request, keys),
		columns,
		placements: placementsOf(request, keys, blocks, columns, label),
		label
	}
}

/**
 * A request as coverage reads it (see `planIndexes`): as it states itself on its relation's table (Stated), its
 * placements those an index serving it holds, and the keys a B-tree of its own leaves out of its entry, each an
 * equality its reads apply as a filter beside the index (`fittingKeys`), none where every key fits or its index is no
 * B-tree: an index holding the rest serves it too.
 */
interface Covered extends Stated {
	readonly filtered: ReadonlyArray<IndexKey>
}

/**
 * A stated request as coverage reads it (Covered): its entry's keys judged where its own index is a B-tree; a lookup of a
 * stored derived relation's table by equalities of one column no B-tree entry holds reads a hash index on it, and one of
 * several such columns, each by an equality of its own, is refused, since a hash index on one of them reads every row
 * sharing that one value. The one derivation of what serves a request, planning's and resolution's (`resolverOf`).
 */
const coveredOf = (stated: Stated): Covered => {
	const { request, relation, keys, roles, placements, label } = stated
	const entry =
		methodOf(placements.own) === "btree"
			? fittingKeys(relation, keys, (_, at) => defined(roles[at], "a role per key"))
			: undefined
	if (
		entry !== undefined &&
		!entry.ok &&
		entry.error.kind === "unboundedText" &&
		roles.every((role) => role === "equality") &&
		relation.stored
	) {
		return isNonEmpty(keys.slice(1))
			? fail(
					"UnsupportedOperation",
					label,
					`a lookup of the stored relation ${request.relation} by one column of no byte bound, which a hash index finds the rows of; it binds ${keys.map((k) => keyTermText(k.column)).join(", ")}, each of no byte bound, and a hash index on one of them reads every row sharing that one value: bind a key of it, or a column a B-tree holds`
				)
			: { ...stated, placements: hashPlacements(keys), filtered: [] }
	}
	return {
		...stated,
		filtered:
			entry === undefined || !entry.ok ? [] : keys.filter((_, at) => !entry.value.held.includes(at))
	}
}

/** A request as the engine plans it: as coverage reads it, and the table an index created for it is built on. */
interface Planned extends Covered {
	readonly target: BuiltTarget
}

/** The access method of the index a planned request creates. */
const ownMethod = (planned: Covered): IndexMethod => methodOf(planned.placements.own)

/** Whether an index's relation, access method and keys serve a request (see `planIndexes`): it holds one of the
 * request's placements, as an index of that placement's method, or one of them without the keys the request's entry
 * leaves out as filters (`leavingOut`). */
const serves = (index: KeyedIndex, planned: Covered): boolean =>
	index.relation === planned.request.relation &&
	[planned.placements.own, ...planned.placements.others].some((p) => {
		const holds = (at: Placement): boolean =>
			methodOf(at) === index.method && placed(index, at, planned.columns)
		const fitting = isNonEmpty(planned.filtered) ? leavingOut(p, planned.filtered) : undefined
		return holds(p) || (fitting !== undefined && holds(fitting))
	})

/** `keys` but each of `left`. */
const without = (
	keys: ReadonlyArray<IndexKey>,
	left: ReadonlyArray<IndexKey>
): ReadonlyArray<IndexKey> => keys.filter((k) => !left.some((l) => sameKey(k, l)))

/**
 * A placement without the keys `left`, the equalities a request's entry leaves out as filters (Planned `filtered`): an
 * index that holds the rest serves the request, its reads applying the filters beside it; none where no key would place
 * it. A GiST and a unique index's placements leave nothing out, since only a B-tree's entry leaves an equality out, and
 * an order's keys stay directed, since none is an equality (BlocksPlacement `directed`).
 */
const leavingOut = (p: Placement, left: ReadonlyArray<IndexKey>): Placement | undefined => {
	switch (p.kind) {
		case "blocks": {
			const blocks = p.blocks.flatMap((block): ReadonlyArray<Block> => {
				const kept = without(block, left)
				return isNonEmpty(kept) ? [kept] : []
			})
			return isNonEmpty(blocks) ? { ...p, blocks } : undefined
		}
		case "placed":
		case "keyed":
			return p
	}
}

/** An index under construction (see `planIndexes`): its access method, its own request's, blocks covering its columns,
 * the columns of its first block one of which leads it, and the orders whose directions it takes, each an ordered
 * request's it answers to. */
interface Draft {
	readonly method: IndexMethod
	readonly blocks: NonEmptyReadonlyArray<Block>
	/**
	 * The columns of the first block any of which may lead the index (see `planIndexes`): every column of a B-tree's,
	 * a GiST index's own leads, narrowed by each placement that refines it to those still leading every one of them, so
	 * a column stays one a later request may lead with until a request refuses it (leadDraft); the one the index's own
	 * request states first leads (`keysOf`).
	 */
	readonly leaders: Block
	/** The order keys of each ordered request it answers to (BlocksPlacement `directed`), together pairwise (`together`),
	 * whose directions its keys take (`directionsOf`). */
	readonly orders: ReadonlyArray<Keys>
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

/** Where each key's column stands in its relation's heading (BuiltTarget `place`), which orders a block's columns. */
type Place = (k: IndexKey) => number

/** A draft's leaders narrowed so that one of `lead` comes first, with each of `held` among its columns, which holds a
 * placed placement, whose leads are of many values: its leaders among `lead`, every one of which leads every placement
 * before it still; none when no leader is one of `lead` or the draft misses one of `held`. */
const leadDraft = (draft: Draft, lead: Keys, held: ReadonlyArray<IndexKey>): Draft | undefined => {
	if (!held.every((c) => draft.blocks.some((block) => block.some((k) => sameKey(k, c))))) {
		return undefined
	}
	const leaders = draft.leaders.filter((k) => lead.some((c) => sameKey(k, c)))
	return isNonEmpty(leaders) ? { ...draft, leaders } : undefined
}

/** The draft of the index a planned request creates: its own placement's method and blocks, a GiST request's bound
 * columns as one block, in any order a later request fixes, the request's own otherwise. */
const draftOf = (planned: Planned): Draft => {
	const own = planned.placements.own
	switch (own.kind) {
		case "blocks":
			return {
				method: own.method,
				blocks: own.blocks,
				leaders: own.blocks[0],
				orders: own.directed === undefined ? [] : [own.directed]
			}
		case "placed":
			return { method: "gist", blocks: [own.bound], leaders: own.lead, orders: [] }
	}
}

/** A draft refined by one placement of another request, or none when no one index holds both: the placement is another
 * method's, or no one order satisfies both. A created index is never unique, so no keyed placement refines it. */
const refinedBy = (draft: Draft, placement: Placement): Draft | undefined => {
	if (methodOf(placement) !== draft.method) {
		return undefined
	}
	const { method } = draft
	switch (placement.kind) {
		case "keyed":
			return undefined
		case "placed":
			return leadDraft(draft, placement.lead, placement.bound)
		case "blocks": {
			const blocks = mergeBlocks(draft.blocks, placement.blocks)
			if (blocks === undefined) {
				return undefined
			}
			const leaders = draft.leaders.filter((k) => blocks[0].some((l) => sameKey(k, l)))
			if (!isNonEmpty(leaders)) {
				return undefined
			}
			const { directed } = placement
			if (directed === undefined) {
				return { method, blocks, leaders, orders: draft.orders }
			}
			return draft.orders.every((order) => together(order, directed))
				? { method, blocks, leaders, orders: [...draft.orders, directed] }
				: undefined
		}
	}
}

/** A draft refined by another request: by its own placement, else by the first of its others that refines it; none when
 * no placement does. */
const refined = (draft: Draft, ahead: Planned): Draft | undefined => {
	const { own, others } = ahead.placements
	for (const placement of [own, ...others]) {
		const found = refinedBy(draft, placement)
		if (found !== undefined) {
			return found
		}
	}
	return undefined
}

/**
 * The order of the columns within one block of a draft, which any order of them serves alike (`placed`, `sameSet`), by
 * the index's access method: the relation's heading order (`place`), the key's text breaking a tie between a column and
 * its suffix key, so every index that holds one block holds it in one order whichever order its requests stated it in,
 * and the plan is a function of what its requests ask, never of how each spells its columns; but a GiST index's
 * columns of few values after its columns of many values. GiST splits a page by its first column (gistsplit.c
 * gistSplitByKey: picksplit runs on it, and a later column only redistributes the entries it ties), and btree_gist's
 * picksplit halves a page in that column's order, so the halves of a split on a column of few values share its middle
 * value and each keeps every value of the columns after it, and a probe follows more of them down. On PostgreSQL 19.0,
 * over the 20,000 rows of serving-workload's kept case (test/pg/physical/serving.test.ts), whose load writes two closed
 * handles of 3 values and a numeric and a span of 141, a probe binding every column touches 7 to 10 buffers of a GiST
 * index on (handle, handle, numeric, span) over twenty builds of the same rows, which differ as gistchoose breaks ties
 * between equally good subtrees at random, and 4 or 5 over twenty builds of one on (numeric, span, handle, handle), this
 * order. It was measured on 19rc2, whose GiST code 19.0 keeps (git diff REL_19_RC2 REL_19_0 -- src/backend/access/gist
 * contrib/btree_gist src/backend/utils/adt/rangetypes_gist.c is empty), with the pin's btree_gist patch then, which
 * priced only multibyte text keys and so none of these: the handles are int2 codes. The first column of many values,
 * which places the entries, stays the first by the request's order, so every request the block's order served is served
 * still, and none needs to bind a column of few values to keep its scan in one descent.
 */
const withinBlock: Readonly<
	Record<IndexMethod, (place: Place, columns: Columns) => Comparator<IndexKey>>
> = {
	btree: (place) => combineAll([mapInput(compareNumbers, place), keyOrder]),
	hash: (place) => combineAll([mapInput(compareNumbers, place), keyOrder]),
	hnsw: (place) => combineAll([mapInput(compareNumbers, place), keyOrder]),
	gin: (place) => combineAll([mapInput(compareNumbers, place), keyOrder]),
	gist: (place, columns) =>
		combineAll([
			mapInput(compareBooleans, (k: IndexKey) => columns.holds(k.column) === "few"),
			mapInput(compareNumbers, place),
			keyOrder
		])
}

/**
 * A draft's keys (see `planIndexes`): its first leader, then the rest of its first block, then the rest of its blocks in
 * order, each block's columns in its method's order (`withinBlock`), in the directions its orders take (`directionsOf`).
 */
const keysOf = (draft: Draft, place: Place, columns: Columns): NonEmptyReadonlyArray<IndexKey> => {
	const order = withinBlock[draft.method](place, columns)
	const [leading, ...following] = draft.blocks
	const [leader] = sortNonEmpty(draft.leaders, order)
	const keys = extendNonEmpty(
		[leader],
		[
			...leading.filter((k) => !sameKey(k, leader)).toSorted(order),
			...following.flatMap((block) => block.toSorted(order))
		]
	)
	return directionsOf(keys, draft.orders)
}

/**
 * An index's keys in the directions `orders` take, canonical under reversal: the first ascending, and each after it in
 * the direction of the key before it, but opposite where an order holds both and directs them apart. An order's keys
 * stand adjacent in every index that holds it, so each adjacent pair of its keys is one the walk directs, the same way
 * whichever order holding both it reads, orders one index holds being together (`together`): every order is held in its
 * directions or each opposite, an order and its exact reverse are one index, and a key no order directs, a fixed column
 * or one no order holds, takes the direction of the key before it.
 */
const directionsOf = (
	keys: NonEmptyReadonlyArray<IndexKey>,
	orders: ReadonlyArray<Keys>
): NonEmptyReadonlyArray<IndexKey> => {
	const apart = (a: IndexKey, b: IndexKey): boolean =>
		orders.some((order) => {
			const x = order.find((k) => sameKey(k, a))
			const y = order.find((k) => sameKey(k, b))
			return x !== undefined && y !== undefined && x.dir !== y.dir
		})
	const [first, ...rest] = keys
	return rest.reduce(
		(held: NonEmptyReadonlyArray<IndexKey>, k): NonEmptyReadonlyArray<IndexKey> => {
			const before = lastNonEmpty(held)
			return extendNonEmpty(held, [
				{ ...k, dir: apart(before, k) ? opposite(before.dir) : before.dir }
			])
		},
		[{ ...first, dir: "asc" }]
	)
}

/** The plan's fixed orders compare structurally: strings by code unit; lists elementwise, the longer first on a common
 * prefix (core/order.ts listOrder); a key's default operator class after any named one. */
const opclassOrder: Comparator<IndexOpclass> = (a, b) =>
	a.kind === "default"
		? b.kind === "default"
			? 0
			: 1
		: b.kind === "default"
			? -1
			: compareStrings(`${a.schema}.${vectorCosineOpclass}`, `${b.schema}.${vectorCosineOpclass}`)

const keyOrder: Comparator<IndexKey> = combineAll([
	mapInput(compareStrings, (k: IndexKey) => keyTermText(k.column)),
	mapInput(compareStrings, (k: IndexKey) => k.dir),
	mapInput(opclassOrder, (k: IndexKey) => k.opclass)
])

/** A law's request before the workload's access, then by the law. */
const justificationOrder: Comparator<IndexRequest> = (a, b) => {
	if (a.role === "lawMaintenance") {
		return b.role === "lawMaintenance"
			? compareStrings(justificationText(a.justification), justificationText(b.justification))
			: -1
	}
	return b.role === "lawMaintenance" ? 1 : 0
}

/** The planned indexes: every key and enforcement index, then each new index the requests need, every request merged
 * into the index that serves it; the set they are as coverage reads them (IndexSet), with the table of every relation
 * one is on; and its resolver (IndexPlan `resolve`, `resolverOf`), which sends every request, planned here or asked by
 * any compile after, to the index it lands on among them, named by its reference (physical/indexes/ref.ts IndexRef):
 * one function of the set and the request, so planning and every served compile resolve a read alike, and a request no
 * index serves is an internal compiler error wherever it is asked, every request planned here landing by construction
 * of the walk below, on the index resolution sends it to (`hostIn`), its reasons added to that index's object; and the
 * resolver's partial form (IndexPlan `serving`, `servingOf`), none where no index serves a request. The plan is settled against the keys the installation met (core/canonical.ts KeyLedger): one
 * refused here or before leaves no resolver, its installation refused naming them all. Adds the new index objects and
 * the served reasons to the graph.
 *
 * The index request engine: every index beyond a key's own cites a law's maintenance or the workload's access, and requests
 * are deduplicated against the key indexes and against each other, merging provenance. Containments imply useful
 * indexes.
 *
 * Requests come from two sources. Law maintenance is generated here from the law model: a reverse foreign-key lookup
 * for every foreign key, plain or PERIOD, a family's axes among them, which PostgreSQL does not index on the
 * referencing side (the ReverseIndex natives, over fields and law columns alike, each by its arm); workload access
 * paths arrive from the
 * workload compiler through an installer extension's contribution (`workloadExtension`). Every request is served: a
 * per-key check or a keyed read without its index is a table scan.
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
 *   key or B-tree write target) is served by an index whose leading columns are exactly the requested set, in any order
 *   and direction (`(tenant, account, created)` serves an equality lookup on `(account, tenant)`, and
 *   `(account, created, tenant)` does not: it would read every row of the account and filter the tenant among them, as
 *   a read that binds a column an index leaves unbound before it does), a B-tree's, or a GiST index's whose leading
 *   columns hold one of many values, which places its entries, each a scalar under the default class, which btree_gist
 *   searches by its equality and comparison operators (`gistLed`), a range below likewise. So a constraint-created
 *   index can satisfy a request when
 *   its native behavior fits (the reverse probes on `employment` and `shift` are served by the GiST index of a span key,
 *   whose leading `employee` column btree_gist serves; a workload lookup of a key's usage by `key` is served by the GiST
 *   index the coverage law of its spans needs on `(key, during)`), and no GiST index serves a lookup on closed handles
 *   and booleans alone. A B-tree index of the same relation is preferred when one serves;
 * - a workload range or prefix-search request is an equality prefix followed by one range column: a B-tree whose leading
 *   columns before the last are exactly the prefix's set in any order, and the next the range column in either
 *   direction, because a B-tree scans an interval forward or backward; or a GiST index that leads the same way, its
 *   requested columns scalars under the default class and its leading prefix, or the range column where the prefix is
 *   empty, holding one of many values (the span key's GiST index on `(room, during)` serves a range on room). A prefix
 *   of closed handles and booleans alone leaves a GiST index's placement to the range column, so its scan reads the
 *   range across every value of the prefix: on PostgreSQL 19, over 20,000 rows, a range on the half of a numeric of 141
 *   values after a three-valued handle touches 92 buffers of a GiST index on `(handle, numeric, handle, span)` for its
 *   3,334 rows, three times their share;
 * - an ordered request, a take or page seek, is served only by a B-tree whose leading columns are the ones its
 *   equalities fix, in any order and any direction, since one value holds each within the seek, then the keys it orders
 *   by, in order and either each in its direction or each in the opposite direction, since a B-tree scanned backward
 *   yields the exact reverse of its order; GiST has no order. A superkey seek, whose equalities bind every key of a
 *   unique B-tree, is served by that index too: at most one row answers it, which is in every order, so it asks for no
 *   index of its own beside the key's;
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
 * method of the indexes that hold it (methodOf). A placement is blocks of columns leading an index, each block's columns
 * in any order among themselves (an ordered request's fixed columns one block, then each key it orders by a block of its
 * own, in its directions or all opposite),
 * a B-tree's, a hash or an HNSW index's, or a GiST index's whose first block holds a column of many values (an equality
 * lookup's, a range's or a law's probe's, `gistLed`); or a GiST index whose first column of many values is one of some
 * columns, every column before it and every other held, a GiST request's own; or, for a unique index, every key among
 * some of the columns the request fixes (a B-tree's for
 * an equality lookup, a range or a seek's equalities; a GiST request's: a GiST index's among all of them, a B-tree's among its scalars). No
 * blocks place a GiST index's entries, so no placement of a GiST index is one by columns of few values alone. `serves`
 * reads them to judge an index, and the engine reads them to draft an index it creates.
 *
 * A served request adds its justification to the serving object's reasons; a constraint index can serve it (a primary
 * key serves the reverse lookup of a self-reference, a span key's GiST index the reverse probe of a PERIOD foreign
 * key). Of the indexes that serve a request, it lands on a key or enforcement index before a created one, then on one
 * of its own access method before one standing in for it, then on its relation's primary key before another key, then
 * on the key of fewest keys, then by its keys and name, what it is and not where its statement stands, and of created
 * indexes on the first the plan created (`hostOrder`), among every index the plan holds once the walk is done, which
 * is where resolution sends it (`hostIn`). An unserved request becomes a new index
 * `<table>__ix__<col>[__<col>...]`. The B-tree requests whose own placement is blocks, an equality lookup's, a range's,
 * a law's probe's, its suffix seek's or an order's, that no key serves once every other request of their relation has
 * landed or created its index, are planned together (`chainsOf`): each needs a chain of sets its index must lead with,
 * and they are grouped into the fewest indexes whose groups' sets are each one chain, two orders sharing one only when
 * they direct the keys they both order by alike or each opposite (`together`; indexes/chains.ts fewestSharingGroups),
 * each index ordering its columns along its chain, each block's columns in the heading's order (`withinBlock`); each
 * lands on its own chain's index, where an index of another chain that serves it too would leave its own ordered for a
 * request it never serves (a seek ordered by f2 with nothing bound, grouped with a lookup of (doc, f2) beside a chain
 * (f2, f3) ⊂ (f1, f2, f3), led (f2, doc) and landed on (f2, f3, f1)).
 * Every other unserved request, wider requests first, so a narrower one lands on a
 * wider index that serves it, creates an index drafted for it (`draftFor`): it starts as the request's own placement and
 * its method, and is refined, in the plan's
 * order, by the placements of each later request no planned index serves yet, as long as one index still holds them
 * all: placements of its method, in one order. So an equality lookup on `{account, created}` planned before a range on
 * `created` then `account` creates `(created, account)`, which serves both, a wider equality lookup takes the order a
 * narrower range or order over its columns fixes, and a GiST index leads with a column of many values a later request
 * fixes (a span predicate on `(fixed, span)` beside one on `(span)` creates `(span, fixed)`, which serves both). A
 * placed placement narrows the columns that may lead the draft to those among its leads, never to one of them (Draft
 * `leaders`), so a column stays one a later request may lead with until a request refuses it, and the one the request
 * states first among those left leads: a span predicate on `(a, b, c, span)` beside one on `(b, c, span)` and an
 * equality lookup on `(c)` creates `(c, ...)`, which serves all three, where choosing `b` at the second would have
 * refused the third. Within a block the columns take the heading's order (`withinBlock`). Since the draft looks ahead,
 * the plan's order only fixes the outcome: it is canonical, so the plan does not depend on the order requests arrive
 * in. Its keys are canonical under reversal: the first ascends, and a key
 * no ordered request directs takes the direction of the key before it (`directionsOf`), so an order and its exact
 * reverse are one index. Its identity is its columns, the canonical directions and each key's operator class,
 * which serving requires equal, and its access method; the name marks a method other than the B-tree, the descending
 * keys and the classes beyond the default, each part of its identity at the naming door (identity.accessIndex).
 * Uniqueness is never traded: a request never turns into or replaces a unique constraint, and enforcement objects
 * (keys) stay separate from access-path indexes. The index's key entry must fit its access method, like a key's, in any
 * order of its columns (schema/representability.ts btreeEntryBytes): a B-tree holds a column as itself or not at all,
 * never by an image. Where its keys could outgrow BTMaxItemSize, it leaves out the columns its requests bind by
 * equality, the widest first and a column of no byte bound widest of all, until the rest fits, each left out a filter
 * its reads apply beside the index; a column it orders by or matches a prefix of stays, and an entry those still
 * overfill is refused naming them (schema/representability.ts lookupEntry, KeyFault `orderedColumns`).
 *
 * A derived relation's stored table takes indexes like a table: the stored tables extension registers the table's
 * fields and inherited key indexes with the builder (`addIndexedView`), the key indexes serve requests as a table's key
 * indexes do, and an unserved request becomes an index of the table, created after it, but a lookup that binds by
 * equality only texts of no byte bound, which asks for none. A request on a live derived relation, which stores no
 * table, asks for none.
 *
 * Requests whose keys are expressions, a form the workload compiler does not produce, are refused as
 * UnsupportedOperation. */
export const planIndexes = (
	b: InstallBuilder,
	keyIndexes: ReadonlyArray<KeyIndex>,
	asked: ReadonlyArray<IndexRequest>
): Result.Result<IndexPlan, CompileError> => b.keys.settle(planOver(b, keyIndexes, asked))

/**
 * The indexes `asked` need beside `keyIndexes` and the index each access request resolves to (see `planIndexes`), before
 * the plan is settled against the keys the installation met: a request refused here, or a key refused before, leaves no
 * resolver, since the installation that met it is refused. Each request lands on the index resolution sends it to
 * (`hostIn`), the one derivation of both, its reasons added to that index's object.
 */
const planOver = (
	b: InstallBuilder,
	keyIndexes: ReadonlyArray<KeyIndex>,
	asked: ReadonlyArray<IndexRequest>
): Result.Result<IndexPlan, CompileError> =>
	catchRefusal((): IndexPlan => {
		/** Each request on the relation it is installed as (analysis/schema.ts CheckedSchema installedAs): an alias's of
		 * one definition on its canonical relation, whose table, keys and indexes are planned and named once, by it; any
		 * other request as it was asked, the one its index's `requests` hold. */
		const requests = asked.map((r): IndexRequest => {
			const relation = b.checked.installedAs(r.relation)
			return relation === r.relation ? r : { ...r, relation }
		})
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
					unique: true as const,
					role: "unique" as const
				}))
			)
		]
		/** Each key index's keys ascending under the default class, over every row. */
		const candidates: Array<Candidate> = installed.map((k) => ({
			standing: { kind: k.role },
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
		/** Whether equalities over `columns` bind every column of one of `relation`'s key indexes, which finds one row. */
		const keyed =
			(relation: string) =>
			(columns: ReadonlyArray<KeyTerm>): boolean =>
				installed.some(
					(k) =>
						k.relation === relation && k.columns.every((c) => columns.some((x) => sameColumn(x, c)))
				)
		/**
		 * The stored derived relations' tables: a lookup of one that binds by equality one bytes column alone, of no byte
		 * bound, which no B-tree entry holds, reads a hash index on it, whose entry is the value's 4-byte hash code, the rows
		 * it finds the lookup's own (a text of no byte bound is refused before it as undigested, `refusedUndigested`). The
		 * installation stores the relation by its own inference (analysis/derived/storage.ts), so its table refuses no such
		 * read for want of a bound; a lookup binding several such columns reads a hash index over their row where it states
		 * them as one row equality (AccessUse `row equality`, `hashPlacements`), and is refused where it binds an equality of
		 * each, since a hash index on one of them reads every row sharing that one value (`coveredOf`).
		 */
		const stored = new Set(b.indexedViews().map((view) => view.relation))
		/** Each relation's table as coverage reads it (CoveredRelation), once: what the plan and its resolver read alike. */
		const tables = new Map<
			string,
			{ readonly target: BuiltTarget; readonly covered: CoveredRelation }
		>()
		const tableOf = (relation: string, label: string) => {
			const known = tables.get(relation)
			if (known !== undefined) {
				return known
			}
			const o = b.target(relation)
			switch (o.kind) {
				case "none":
					return fail(
						"MalformedDescription",
						label,
						`an index request on a stored or derived relation; ${relation} is none`
					)
				case "deferred":
					return undefined
				case "built": {
					const table = { target: o, covered: coveredRelationOf(o, stored.has(relation)) }
					tables.set(relation, table)
					return table
				}
			}
		}
		const plan = requests
			.flatMap((r): ReadonlyArray<Planned> => {
				const table = tableOf(r.relation, requestLabel(r))
				if (table === undefined) {
					return []
				}
				const stated = statedOf(r, table.covered)
				if (
					methodOf(stated.placements.own) === "btree" &&
					refusedUndigested(b, r, stated.label, table.target, stated, keyed(r.relation))
				) {
					return []
				}
				return [{ ...coveredOf(stated), target: table.target }]
			})
			.toSorted(canonical)
		/** The candidates and the plan's requests of each relation, in their order: an index serves only its own
		 * relation's requests (serves), so each request reads its relation's alone, and the plan, ordered by relation
		 * first (canonical), is walked relation by relation in its own order. */
		const candidatesOf = new Map<string, Array<Candidate>>()
		const hold = (c: Candidate): void => {
			candidatesOf.getOrInsertComputed(c.index.relation, () => []).push(c)
		}
		for (const c of candidates) {
			hold(c)
		}
		const planOf = new Map<string, Array<Planned>>()
		for (const entry of plan) {
			planOf.getOrInsertComputed(entry.request.relation, () => []).push(entry)
		}
		/** Every planned request, in the order the walk finds an index serving it: the order its reasons are added in. */
		const landed: Array<Planned> = []
		for (const relationPlan of planOf.values()) {
			/** Whether `host` serves `entry`, which then lands where resolution sends it (`hostIn`, after the walk). */
			const landOn = (host: Candidate, entry: Planned): boolean => {
				if (!serves(host.index, entry)) {
					return false
				}
				landed.push(entry)
				return true
			}
			/** Whether a planned index serves `entry`, which then lands where resolution sends it. */
			const land = (entry: Planned): boolean => {
				const own = candidatesOf.get(entry.request.relation) ?? []
				const host = own.find((c) => serves(c.index, entry))
				return host !== undefined && landOn(host, entry)
			}
			/** Creates the index `draft` holds for `planned`, each key's role read by `roleOf`: the candidate created, or none
			 * where an index of its relation has its method and keys already (`createIndex`). */
			const create = (planned: Planned, draft: Draft, roleOf: RoleOf): Candidate | undefined => {
				const index = createIndex(
					b,
					planned,
					draft,
					roleOf,
					relationPlan,
					candidatesOf.get(planned.request.relation) ?? []
				)
				if (index === undefined) {
					return undefined
				}
				const created: Candidate = {
					standing: { kind: "created", at: candidates.length },
					index,
					requests: []
				}
				candidates.push(created)
				hold(created)
				return created
			}
			const chained = relationPlan.flatMap((entry) => {
				const c = chainedOf(entry)
				return c === undefined ? [] : [c]
			})
			for (const [at, entry] of relationPlan.entries()) {
				if (chainedOf(entry) !== undefined || land(entry)) {
					continue
				}
				const own = candidatesOf.get(entry.request.relation) ?? []
				create(entry, draftFor(entry, ahead(at, relationPlan, own)), plannedRoles(entry))
				invariant(land(entry), `the index created for the ${entry.label} serves it`)
			}
			const unserved = chained.filter(({ entry }) => !land(entry))
			for (const chain of chainsOf(unserved)) {
				const host = create(chain.members[0], chain.draft, chain.roleOf)
				for (const entry of chain.members) {
					invariant(
						host === undefined ? land(entry) : landOn(host, entry),
						`the index of the chain of the ${entry.label} serves it`
					)
				}
			}
		}
		/** The reference a plan names `index` by (physical/indexes/ref.ts): its schema-qualified name, its method, the
		 * installed columns it stores as themselves in key order, a suffix key storing none and a hash index, which holds
		 * hash codes, none, and whether it returns them. */
		const refOf = (index: PlannedIndex): IndexRef => {
			const target = b.target(index.relation)
			if (target.kind !== "built") {
				return defect(`the table of ${index.relation}, which its index ${index.index.name} is on`)
			}
			return indexRef({
				name: { schema: b.names.relation(index.relation).schema, name: index.index.name },
				method: index.method,
				stores:
					index.method === "hash"
						? []
						: index.keys.flatMap((k) =>
								k.column.kind === "suffix" ? [] : [target.column(k.column)]
							),
				returns: returnsOf(
					index.method,
					index.keys.map(
						(k) =>
							baseOf(
								defined(
									target.field(readColumn(k.column)),
									`the field ${keyTermText(k.column)} of ${index.relation}`
								).type
							).carrier
					)
				)
			})
		}
		/** The planned indexes as coverage reads them, in the walk's order, with the table of every relation one is on. */
		const set: IndexSet = {
			indexes: candidates.map((c): InstalledIndex => ({
				relation: c.index.relation,
				method: c.index.method,
				keys: c.index.keys,
				unique: c.index.unique,
				standing: c.standing,
				ref: refOf(c.index)
			})),
			relations: Object.fromEntries(
				[...new Set(candidates.map((c) => c.index.relation))]
					.toSorted(compareStrings)
					.flatMap((relation) => {
						const table = tableOf(relation, `the indexes of ${relation}`)
						return table === undefined ? [] : [[relation, table.covered] as const]
					})
			)
		}
		for (const entry of landed) {
			const host = hostIn(set, entry)
			const candidate = host === undefined ? undefined : candidates[set.indexes.indexOf(host)]
			if (candidate === undefined) {
				return defect(
					`a missed index: the ${entry.label} landed on no index of ${entry.request.relation}, which every planned request lands on`
				)
			}
			candidate.requests.push(entry.request)
			b.graph.addReasons(candidate.index.object, [reasonOf(entry.request)])
		}
		return {
			indexes: candidates.map((c): PlannedIndex => ({ ...c.index, requests: c.requests })),
			set,
			resolve: resolverOf(set, (relation) => b.checked.installedAs(relation)),
			serving: servingOf(set, (relation) => b.checked.installedAs(relation))
		}
	})

/** A planned index and the requests it serves, in the plan's order. */
interface Candidate {
	readonly standing: Standing
	readonly index: PlannedIndex
	readonly requests: Array<IndexRequest>
}

/** The plan's order: by relation, wider requests first, then a fixed order, so the plan does not depend on request
 * order, nor on the order a request states the columns of a block in, which any order of serves alike: each block's
 * keys compared as a set, in keyOrder (`withinBlock`), where comparing them as stated ordered three lookups of
 * Event's (tenant, unrelated), (tenant, account) and (account, unrelated) by their statement, one plan for each
 * statement of a lookup's columns; each index's requests and reasons are merged in it. */
const canonical: Comparator<Planned> = combineAll([
	mapInput(compareStrings, (x: Planned) => x.request.relation),
	mapInput(flip(compareNumbers), (x: Planned) => x.keys.length),
	mapInput(listOrder(keyOrder), (x: Planned) =>
		x.blocks.flatMap((block) => block.toSorted(keyOrder))
	),
	mapInput(justificationOrder, (x: Planned) => x.request),
	mapInput(compareStrings, (x: Planned) => x.request.method),
	mapInput(compareStrings, (x: Planned) => x.request.use)
])

/** The serving indexes a request lands on first (see `planIndexes`): a key or enforcement index before a created one, so
 * a request a key serves adds nothing; then one of the request's own access method before one standing in for it; then
 * its relation's primary key before another key; then of created indexes the first the plan created, and of keys by what
 * the key is, never by the order its statement stands in: the fewest keys, then its keys (listOrder), then its name,
 * which its content mints. */
const hostOrder = (entry: Covered): Comparator<InstalledIndex> =>
	combineAll([
		mapInput(compareBooleans, (c: InstalledIndex) => c.standing.kind === "created"),
		mapInput(compareBooleans, (c: InstalledIndex) => c.method !== ownMethod(entry)),
		mapInput(compareBooleans, (c: InstalledIndex) => c.standing.kind !== "primary"),
		mapInput(compareNumbers, (c: InstalledIndex) =>
			c.standing.kind === "created" ? c.standing.at : 0
		),
		mapInput(compareNumbers, (c: InstalledIndex) => c.keys.length),
		mapInput(listOrder(keyOrder), (c: InstalledIndex) => c.keys),
		mapInput(compareStrings, (c: InstalledIndex) => c.ref.name.name)
	])

/** The index of `set` a request lands on (see `planIndexes`): the first by `hostOrder` of those that serve it, none where
 * none does. */
const hostIn = (set: IndexSet, entry: Covered): InstalledIndex | undefined => {
	const [host] = set.indexes.filter((c) => serves(c, entry)).toSorted(hostOrder(entry))
	return host
}

/**
 * Where a request lands among the indexes of `set` (IndexSet), its relation read as it is installed (`installedAs`,
 * analysis/schema.ts CheckedSchema installedAs): the index it lands on (`hostIn`), read through the one derivation of
 * what serves a request (`statedOf`, `coveredOf`) on the table `set` records of its relation, as planning lands every
 * request it plans; else why no index serves it: its relation one `set` holds no index of, a request its table cannot
 * state, or one no index of the table serves. The one landing `servingOf` and `resolverOf` read, and a served compile
 * under a snapshot (deploy/snapshot/served.ts snapshotResolver), whose miss is a refusal of its program.
 */
export const landingIn = (
	set: IndexSet,
	installedAs: (relation: string) => string,
	request: IndexRequest
):
	| { readonly kind: "served"; readonly index: IndexRef }
	| { readonly kind: "unserved"; readonly label: string; readonly why: string } => {
	const relation = installedAs(request.relation)
	const asked = relation === request.relation ? request : { ...request, relation }
	const unserved = (why: string) => ({ kind: "unserved", label: requestLabel(asked), why }) as const
	const table = Object.hasOwn(set.relations, relation) ? set.relations[relation] : undefined
	if (table === undefined) {
		return unserved(`of ${relation}, which the installation indexes none of`)
	}
	const covered = catchRefusal(() => coveredOf(statedOf(asked, table)))
	if (!covered.ok) {
		return unserved(`of ${relation}, whose table refuses it: ${covered.error.message}`)
	}
	const host = hostIn(set, covered.value)
	return host === undefined
		? unserved(`the installation holds on ${relation}`)
		: { kind: "served", index: host.ref }
}

/**
 * The index of `set` each request lands on (`landingIn`), none where no index of `set` serves it: what a migration's
 * data step reads through, its requests planned no index (sql/bind.ts BoundReads `whole`), each read at a constant
 * sought where an index serves it and read whole beside its filter where none does.
 */
export const servingOf =
	(set: IndexSet, installedAs: (relation: string) => string): IndexServing =>
	(request) => {
		const landing = landingIn(set, installedAs, request)
		return landing.kind === "served" ? landing.index : undefined
	}

/**
 * The resolver of `set` (IndexSet): the index each request lands on (`landingIn`), as `servingOf` finds it, every
 * request one an index serves. A request no index of `set` serves is a missed index, the asker's internal compiler
 * error, never an index guessed.
 */
export const resolverOf =
	(set: IndexSet, installedAs: (relation: string) => string): IndexResolver =>
	(request) => {
		const landing = landingIn(set, installedAs, request)
		return landing.kind === "served"
			? landing.index
			: defect(`a missed index: the ${landing.label} is served by no index ${landing.why}`)
	}

/** The requests the draft of the index created for the unserved `plan[at]` reads ahead (see `planIndexes`): the later
 * requests of its relation no planned index serves yet, those of its own access method first. */
const ahead = (
	at: number,
	relationPlan: ReadonlyArray<Planned>,
	candidates: ReadonlyArray<Candidate>
): ReadonlyArray<Planned> => {
	const entry = defined(relationPlan[at], "the request read ahead from")
	return relationPlan
		.slice(at + 1)
		.filter((q) => !candidates.some((c) => serves(c.index, q)))
		.toSorted(mapInput(compareBooleans, (q: Planned) => ownMethod(q) !== ownMethod(entry)))
}

/** The draft of the index created for `planned` (see `planIndexes`): its own, refined by each request it reads ahead, in
 * order, that one index can still serve with all before it. */
const draftFor = (planned: Planned, reads: ReadonlyArray<Planned>): Draft =>
	reads.reduce((draft: Draft, q): Draft => refined(draft, q) ?? draft, draftOf(planned))

/** What each key of an index under construction is to its entry (core/identity.ts EntryRole). */
type RoleOf = (k: IndexKey) => EntryRole

/** The roles of the keys of the index created for `planned`, each key's role in it (`keyRoles`): its draft holds its
 * own keys alone, every placement refining it holding none it lacks (`mergeBlocks`, `leadDraft`). */
const plannedRoles =
	(planned: Planned): RoleOf =>
	(k) =>
		defined(
			planned.roles[
				planned.keys.findIndex((p) => sameColumn(readColumn(p.column), readColumn(k.column)))
			],
			"a role per key"
		)

/** A request the chain cover plans (`chainsOf`), with the blocks its own placement leads an index with. */
interface Chained {
	readonly entry: Planned
	readonly blocks: NonEmptyReadonlyArray<Block>
	/** An order's order keys (BlocksPlacement `directed`), whose directions its index takes up to reversal; none for any
	 * other request. */
	readonly directed: Keys | undefined
}

/**
 * A request as the chain cover plans it (`chainsOf`), where it is a B-tree request whose own placement is blocks, in no
 * direction or an order's, an equality lookup's, a range's, a law's probe's, its suffix seek's or a take or page
 * seek's, served by any index whose leading columns are its blocks' sets in order, whatever order within each, an
 * order's order keys in their directions or all opposite, each block without the columns its entry leaves out (Planned `filtered`),
 * which no index holds; none for a GiST, hash, HNSW or GIN request, which fixes its own method, or one that states a
 * column twice, whose sets would hide it, each drafted on its own (`draftFor`), which refuses what it cannot create.
 */
const chainedOf = (entry: Planned): Chained | undefined => {
	const stated = entry.placements.own
	const own = isNonEmpty(entry.filtered) ? leavingOut(stated, entry.filtered) : stated
	return entry.request.method === "btree" &&
		own?.kind === "blocks" &&
		own.method === "btree" &&
		new Set(entry.keys.map(keyIdentity)).size === entry.keys.length
		? { entry, blocks: own.blocks, directed: own.directed }
		: undefined
}

/** A key's identity in a chain's sets: its column's text and its class. */
const keyIdentity = (k: IndexKey): string =>
	`${keyTermText(k.column)}\u0000${indexOpclassText(k.opclass) ?? ""}`

/** One set of keys a chain holds as the leading columns of its index: its identity, its members' and its keys. */
interface ChainSet {
	readonly id: string
	readonly members: ReadonlySet<string>
	readonly keys: Keys
}

/** The sets a chained request needs its index to lead with, in order: each of its blocks with every block before it. */
const setsOf = ({ blocks }: Chained): NonEmptyReadonlyArray<ChainSet> =>
	mapNonEmpty(blocks, (_, at): ChainSet => {
		const keys = extendNonEmpty(blocks[0], blocks.slice(1, at + 1).flat())
		const members = new Set(keys.map(keyIdentity))
		return { id: [...members].toSorted(compareStrings).join("\u0001"), members, keys }
	})

/** An index a chain of sets plans (`chainsOf`): the requests of its chain, each of which lands on it, the first the one
 * whose label and relation it bears; its draft; and its keys' roles. */
interface Chain {
	readonly members: NonEmptyReadonlyArray<Planned>
	readonly draft: Draft
	readonly roleOf: RoleOf
}

/**
 * The fewest B-trees whose leading columns are exactly each set the chained requests no index serves need (`setsOf`):
 * the requests are grouped so that every group's sets are one chain under inclusion, in the fewest groups
 * (indexes/chains.ts fewestSharingGroups), and each group is one index that orders its columns along its chain, drafted
 * as blocks of its chain's sets less the set before each, each block's columns in heading order (`keysOf`), every key an
 * equality where any request it holds binds it so.
 */
const chainsOf = (entries: ReadonlyArray<Chained>): ReadonlyArray<Chain> => {
	const needed = entries.map(setsOf)
	return fewestSharingGroups(
		needed.map((sets, at) => ({
			sets: mapNonEmpty(sets, (x) => x.members),
			order: entries[at]?.directed?.map(orderKeyOf)
		}))
	).groups.map((group): Chain => {
		const holds = mapNonEmpty(group, (at) => defined(entries[at], "a member of a group"))
		const distinct = new Map<string, ChainSet>()
		for (const at of group) {
			for (const set of needed[at] ?? []) {
				distinct.set(set.id, distinct.get(set.id) ?? set)
			}
		}
		const [first, ...after] = sortNonEmpty(
			extendNonEmpty(setsOf(holds[0]), [...distinct.values()]),
			mapInput(compareNumbers, (x: ChainSet) => x.members.size)
		).filter((x, at, all) => all.findIndex((y) => y.id === x.id) === at)
		const lowest = defined(first, "a set per chain")
		const following = after.flatMap((x, at): ReadonlyArray<Block> => {
			const before = at === 0 ? lowest : after[at - 1]
			const added = x.keys.filter(
				(k) => before === undefined || !before.members.has(keyIdentity(k))
			)
			return isNonEmpty(added) ? [added] : []
		})
		const roleOf: RoleOf = (k) => {
			const roles = holds.flatMap(({ entry }) =>
				entry.keys.flatMap((p, at) =>
					sameKey(p, k) ? [defined(entry.roles[at], "a role per key")] : []
				)
			)
			return roles.includes("equality") ? "equality" : (roles[0] ?? "order")
		}
		const blocks = extendNonEmpty([lowest.keys], following)
		return {
			members: mapNonEmpty(holds, ({ entry }) => entry),
			draft: {
				method: "btree",
				blocks,
				leaders: blocks[0],
				orders: holds.flatMap(({ directed }) => (directed === undefined ? [] : [directed]))
			},
			roleOf
		}
	})
}

/**
 * A new index for an unserved request, as drafted for it (draftFor): the draft's method, and its keys in the order the
 * draft fixes, its entry judged against the access method's limit: one whose entry no index holds is refused in the installation's ledger (b
 * `keys`) as UnrepresentableKey and created over its proposed keys all the same, so the installation goes on to meet
 * every other such index. None where one of `others`, its relation's planned indexes, has its method and its keys
 * already, as two chains' indexes have once each entry leaves out the widest columns it cannot hold: that one serves
 * every request this one would.
 */
const createIndex = (
	b: InstallBuilder,
	planned: Planned,
	draft: Draft,
	roleOf: RoleOf,
	relationPlan: ReadonlyArray<Planned>,
	others: ReadonlyArray<Candidate>
): PlannedIndex | undefined => {
	const { request, label, target: o } = planned
	const method = draft.method
	const targetField = (column: IndexColumn): TargetField =>
		o.field(column) ??
		fail("MalformedDescription", label, `a field ${keyTermText(column)} of ${request.relation}`)
	const proposed = keysOf(draft, (k) => planned.target.place(readColumn(k.column)), planned.columns)
	/** The index refused for `fault`, its keys the proposed ones. */
	const unrepresentable = (fault: KeyFault): NonEmptyReadonlyArray<IndexKey> => {
		const fields = proposed.map((k) => keyTermText(k.column))
		b.keys.refuse({
			at: SourceLoc(label, []),
			subject: `${request.role} index (${fields.join(", ")}) of ${request.relation}`,
			key: fields,
			fault
		})
		return proposed
	}
	/** The index's keys: a B-tree's that fit its entry, every other method's as proposed. */
	const heldKeys = (): NonEmptyReadonlyArray<IndexKey> => {
		if (proposed.length > indexMaxKeys) {
			return unrepresentable({ kind: "columns", limit: indexMaxKeys })
		}
		switch (method) {
			case "btree": {
				const entry = fittingKeys(planned.relation, proposed, roleOf)
				return entry.ok
					? mapNonEmpty(entry.value.held, (at) => defined(proposed[at], "a held key"))
					: unrepresentable(entry.error)
			}
			case "gist": {
				const columns = keyDatums(
					proposed.map((k) => ({
						field: keyTermText(k.column),
						desc: targetField(readColumn(k.column)).desc
					}))
				)
				if (!columns.ok) {
					return unrepresentable(columns.error)
				}
				const bytes = gistEntryBytes(columns.value)
				return !bytes.ok
					? unrepresentable({ kind: "gistOperatorClass", field: bytes.error })
					: bytes.value > gistMaxItemSize
						? unrepresentable({
								kind: "gistEntry",
								bytes: bytes.value,
								limit: gistMaxItemSize
							})
						: proposed
			}
			case "hnsw":
			case "gin":
			case "hash":
				return proposed
		}
	}
	const keys = heldKeys()
	if (
		others.some(
			(c) =>
				c.index.method === method &&
				c.index.keys.length === keys.length &&
				c.index.keys.every((k, at) => {
					const held = keys[at]
					return held !== undefined && sameKey(k, held) && k.dir === held.dir
				})
		)
	) {
		return undefined
	}
	/** Every key a request this index serves binds and it leaves out, a filter its reads apply beside it: its own
	 * proposed keys' and each of its relation's requests' it serves by their fitting columns (`serves`), in text order. */
	const index: KeyedIndex = { relation: request.relation, method, keys, unique: false }
	const filtered = [
		...new Set(
			[
				...without(proposed, keys),
				...relationPlan.flatMap((q) => (serves(index, q) ? without(q.filtered, keys) : []))
			].map((k) => keyTermText(k.column))
		)
	].toSorted(compareStrings)
	const named = identity.accessIndex(
		request.relation,
		method,
		keys.map((k) => ({ field: keyTermText(k.column), dir: k.dir, opclass: k.opclass.kind })),
		filtered
	)
	const name = b.name(named)
	/**
	 * The row a hash index over several columns holds the one hash code of, a row equality's (`hashPlacements`): the
	 * composite type of its columns in its key order, its own object in its relation's level, created before the index
	 * and dropped with it, PUBLIC holding nothing on it; and the index's one key, `ROW(<columns>)::<type>`, which a read
	 * states as its row equality's left side. PostgreSQL indexes no anonymous record, a pseudo-type, so the row is cast to
	 * a type of its own; the type's hash class is the record's (hash_record), each attribute hashed by its own class.
	 */
	const hashedRow = (
		members: NonEmptyReadonlyArray<IndexKey>
	): { readonly node: Node<"setup">; readonly key: SqlIndexKey } => {
		const level = b.names.levelOf(request.relation)
		const typed = identity.hashRow(
			request.relation,
			members.map((k) => keyTermText(k.column))
		)
		const typeName = objectName(identifierOf(level), b.name(typed))
		const attributes = mapNonEmpty(members, (k): ColumnDefinition => {
			const { type, collation } = lawColumnType(b.names, targetField(readColumn(k.column)).type)
			return { name: o.column(readColumn(k.column)), type, collation }
		})
		const node = b.add(
			{
				kind: "rowType",
				ident: { kind: "type", schema: level, name: typed },
				ddl: [
					{ kind: "createRowType", name: typeName, attributes },
					{
						kind: "revoke",
						privileges: ["ALL"],
						on: { kind: "TYPE", names: [typeName] },
						from: [{ kind: "PUBLIC" }]
					}
				],
				reasons: [reasonOf(request)],
				phase: "setup"
			},
			[b.levelNode(request.relation)]
		)
		const columns = mapNonEmpty(members, (k) => tableCol(o.column(readColumn(k.column))))
		return {
			node,
			key: {
				...exprKey(cast(row(columns), namedType(installationTypes(level), typeName.name, []))),
				opclass: undefined,
				direction: "ASC"
			}
		}
	}
	const [first, ...more] = keys
	const rowed = method === "hash" && isNonEmpty(more) ? hashedRow([first, ...more]) : undefined
	const ddl: CreateIndex = {
		kind: "createIndex",
		name,
		table: b.names.relation(request.relation),
		method,
		keys:
			rowed === undefined
				? mapNonEmpty(keys, (k) => ({
						...(k.column.kind === "suffix"
							? exprKey(suffixKeyOf(tableCol(o.column(k.column.of))))
							: columnKey(o.column(k.column))),
						opclass:
							k.opclass.kind === "default"
								? undefined
								: { schema: k.opclass.schema, name: vectorCosineOpclass },
						direction: k.dir === "desc" ? "DESC" : "ASC"
					}))
				: [rowed.key],
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
			reasons: [],
			phase: "indexes"
		},
		[
			o.object,
			...(rowed === undefined ? [] : [rowed.node]),
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
