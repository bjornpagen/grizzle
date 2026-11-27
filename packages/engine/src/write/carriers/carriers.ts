import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import {
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import { type FactColumn, factOperand, factSet } from "#compiler/ir/compare.ts"
import type { RelationInfo } from "#compiler/ir/law.ts"
import { always } from "#compiler/ir/needs.ts"
import type { PhysicalNames } from "#compiler/ir/physical.ts"
import type { CarrierDecl } from "#compiler/ir/products.ts"
import type { Heading, HeadingColumn, RelNode } from "#compiler/ir/rel.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { columnIn, emptyEnv } from "#compiler/lower/conservative/context.ts"
import type { BoundCarrier } from "#compiler/lower/conservative/types.ts"
import { loosestRank, type Rank, rowsBound } from "#compiler/lower/optimize/cte-policy/index.ts"
import { columnType } from "#compiler/runtime/lower/columns.ts"
import {
	type ColumnDef,
	type EmittedSql,
	type Expr,
	type FromItem,
	type FromSource,
	isSetQuery,
	type OperandSelect,
	type Select,
	type SetCore,
	type Target,
	type TypeRef
} from "#compiler/sql/ast.ts"
import {
	call,
	cast,
	col,
	countStar,
	cUtf8Collation,
	derived,
	distinctCore,
	firstNonNull,
	keyedSet,
	lit,
	provedCore,
	provedSelect,
	select,
	target,
	types,
	unitTargets
} from "#compiler/sql/build.ts"
import {
	carrierReading,
	carrierSetting,
	travelling,
	travellingArray
} from "#compiler/sql/carriers.ts"
import { type CarrierDeclaration, carrierName, namedQuery } from "#compiler/sql/naming.ts"
import {
	buildStatement,
	type CarrierResult,
	ownBuild,
	type WriteContext,
	writeKeeps,
	type WriteStatement,
	writeValue,
	type StatementWriting
} from "#compiler/write/insert/statement.ts"

/**
 * The most columns one table of PostgreSQL holds: a stored relation's table with the tag columns added to it, a view and
 * a stored derived relation's table, each refused as ResourceBound (tableColumns) where it is emitted,
 * since PostgreSQL refuses the statement with 54011, "tables can have at most 1600 columns". A column the table once
 * held and dropped counts too, which a migration cannot see: PostgreSQL refuses such an ADD COLUMN itself.
 *
 * @limitKind published
 * @owner PostgreSQL 19.0
 * @unit columns
 * @scope one table or view, its dropped columns included
 * @constraint compile-time constant
 * @source https://github.com/postgres/postgres/blob/REL_19_0/src/include/access/htup_details.h#L48
 * @quote #define MaxHeapAttributeNumber 1600
 * @verified 2026-11-20
 */
export const tableMaxColumns = 1_600

/** A field of a carrier's heading with the column that holds it. */
export interface CarrierColumn extends HeadingColumn {
	readonly column: string
}

/**
 * A carrier: rows one statement of a write's flight makes and a later statement of the same flight reads, which no
 * later statement could make again, since they are of a state the statements between have changed: a relation
 * parameter's evaluation another state reads (write/schedule/plan.ts step `bound`), a described member or a shared
 * sub-query several statements of a stratum read, a delta side a read-back after the last stratum reads, a member slot
 * several statements read (write/program/slot-carriers.ts). Its declaration, each field of its heading with its column,
 * c1 to cn; a carrier of the unit relation has none.
 *
 * A carrier travels in the transaction's own settings, never in a relation: each column is one transaction-local
 * setting (`carrierSetting`), the text of the array of the column's values, one element per row, all of one length,
 * written by the statement that makes the rows, `set_config(name, value, true)`, and read by every later statement of
 * the flight as `unnest(current_setting(name)::text[])` in lockstep, one function scan of them all, each element cast
 * back into its column's type (`carrierRead`), which PostgreSQL evaluates once a statement however often a plan
 * rescans it:
 *
 *   SELECT pg_catalog.set_config('grizzle.__carrier_<k>_c1', COALESCE(pg_catalog.array_agg("r1"."c1"::uuid),
 *     '{}'::uuid[])::text, true), ... FROM (<member query>) AS "r1"("c1", ...)                        (its fill)
 *   ... FROM (SELECT "u"."c1"::uuid AS "c1", ... FROM ROWS FROM (pg_catalog.unnest(pg_catalog.current_setting(
 *     'grizzle.__carrier_<k>_c1')::text[]), ...) AS "u"("c1", ...)) AS "r9"                          (a reader)
 *
 * So no statement names an object of the session, and its text and its identity are the program's alone: it is one
 * statement in every session (one queryid, one entry a budget holds), a session plans it once, and no session creates,
 * empties or drops anything to run a write. A relation kept the rows otherwise, a temporary table the session stood up
 * once: its OID was the session's, so every statement naming it was a new statement in each session; its stand-up was
 * DDL at each session's first call, catalog rows and invalidations every backend reads, and a queue of them past its
 * length reset every backend's plans; its reader was a function no plan saw into, so metis's assign read every test of
 * the catalog for one (edullm Q14); and its emptying truncated it past 100 pages, planning what read it again. A
 * setting writes no heap, no catalog and no WAL, and every plan over it stays valid. A setting lives until the
 * transaction ends, its value reverting there, and each flight writes every carrier it reads before any statement reads
 * it (write/program/compile.ts), so a reader never meets another flight's rows, a share's of one call among them.
 *
 * A column's array is typed by the column's session type (`CarrierTyping`): its value's base type, never an
 * installation's domain, the type every statement reading it reads; a value reaches a stored column through the column's
 * domain, which judges it there. Its text is PostgreSQL's own output of the array, which its input reads back exactly
 * under the settings every Db session fixes (extra_float_digits = 1, DateStyle ISO, bytea_output hex): the one form a
 * parameter of every statement already travels in. A column's setting holds its text whole, so one carrier is bounded
 * by a setting's value, PostgreSQL's longest text, MaxAllocSize, as a parameter is: every carrier's rows are of one
 * statement's evaluation over one call's rows.
 */
export interface WriteCarrier extends CarrierDecl {
	readonly heading: ReadonlyArray<CarrierColumn>
	/** Its columns, each typed as its value travels, which its name digests. */
	readonly declaration: CarrierDeclaration
	/** The rank its rows are bounded at, which the compiler states of each carrier (`CarrierBound`). */
	readonly bound: CarrierBound
	/** What its rows are, as a refusal names them. */
	readonly rows: string
}

/**
 * The rank a carrier's rows are bounded at (lower/optimize/cte-policy rowsBound): `key`, a row of a key the call fixes;
 * `held`, the call's own rows, its input's, each led at a key; `unit`, one unit's rows, or a unit's per row of the
 * call's own; `prefix`, `cross` or `none`, rows that grow with the store. A setting holds a carrier's column whole, at
 * most MaxAllocSize, 1 GB, so the last three are a population-scaling read held whole in a backend's memory (plan
 * contract 3).
 */
export type CarrierBound = Rank | "none"

/**
 * What a carrier's rows are, by what bounds them: the rank of each source of its rows, a node's (rowsBound) or the
 * call's own, a slot's facts or a family statement's nested rows, `held`; `rows` names them.
 */
export interface CarriedRows {
	readonly ranks: NonEmptyReadonlyArray<Rank | undefined>
	readonly rows: string
}

/** The rows of the nodes `nodes`, each ranked by what bounds it (rowsBound), named `rows`. */
export const nodeRows = (nodes: NonEmptyReadonlyArray<RelNode>, rows: string): CarriedRows => ({
	ranks: mapNonEmpty(nodes, rowsBound),
	rows
})

/** A carrier's columns, in heading order. */
export const carrierColumns = (carrier: WriteCarrier): ReadonlyArray<string> =>
	carrier.heading.map((c) => c.column)

/**
 * The PostgreSQL type a carrier column of a value of `t` travels as: its session type (ir/physical.ts sessionTypeRef),
 * the value's base type, never an installation's domain, so a carrier's text reads back whatever a migration does to a
 * domain, and its readers read every value as a stored column's base holds it.
 */
export type CarrierTyping = (t: ScalarType) => TypeRef

/**
 * How a program declares its carriers, each of which its name digests: the type of each column (CarrierTyping). Every
 * carrier of a program, its own and every staged one (write/program/slot-carriers.ts), is declared by it.
 */
export interface CarrierDeclaring {
	readonly typing: CarrierTyping
}

/** The carriers of one program, each named by its ordinal among them and its declaration (see `WriteCarrier`). */
export class CarrierSupply {
	readonly #all: Array<WriteCarrier> = []
	readonly #declaring: CarrierDeclaring

	constructor(declaring: CarrierDeclaring) {
		this.#declaring = declaring
	}

	/** A carrier of `heading`, of any width, holding `rows`, bounded at the loosest of their ranks (`CarrierBound`). */
	next(heading: Heading, rows: CarriedRows): WriteCarrier {
		const ordinal = this.#all.length + 1
		const columns = Object.freeze(
			heading.map((c, i): CarrierColumn =>
				Object.freeze({ name: c.name, type: c.type, column: `c${i + 1}` })
			)
		)
		const declaration: CarrierDeclaration = Object.freeze({
			columns: Object.freeze(
				columns.map((c) => carrierColumnDef(c.column, this.#declaring.typing(c.type)))
			)
		})
		const carrier: WriteCarrier = Object.freeze({
			name: carrierName(ordinal),
			heading: columns,
			declaration,
			bound: loosestRank(rows.ranks) ?? "none",
			rows: rows.rows
		})
		this.#all.push(carrier)
		return carrier
	}

	all(): ReadonlyArray<WriteCarrier> {
		return [...this.#all]
	}
}

/** The carrier column of a field of its heading: the carrier was made over the fields its readers read. The one site of
 * the fact "a field a carrier's reader reads is a column of the carrier": readers name the fields of their relation by
 * name, and a carrier is made over a list of them. */
export const carrierField = (carrier: WriteCarrier, field: string): CarrierColumn =>
	defined(
		carrier.heading.find((c) => c.name === field),
		`the field ${field} in carrier ${carrier.name}`
	)

/**
 * The rows of the carrier `carrier` as a statement reads them under `alias` (sql/carriers.ts carrierReading): its
 * columns' settings read as arrays, unnested in lockstep. The one way a statement reads a carrier.
 */
export const carrierRead = (carrier: WriteCarrier, alias: string): FromSource =>
	carrierReading(carrier.name, carrier.declaration.columns, alias)

/** The names a carrier's fill reads its rows under: the alias of its source, and the name of each of its columns. */
export interface StashNames {
	readonly alias: string
	readonly columns: ReadonlyArray<string>
}

/**
 * The query that fills `carrier` with the rows `source` delivers, each column in the carrier's order, read under
 * `names`: one row, the call of set_config of each column's setting, local to the transaction, to the text of the array
 * of its values, each cast into the column's type, the empty array where no row is; of a carrier of no column, its
 * count of rows. Its one aggregation reads every row once, so the arrays hold the rows in one order, index by index.
 */
export const carrierStash = (
	carrier: WriteCarrier,
	source: OperandSelect,
	names: StashNames
): Select => {
	const from = derived(namedQuery(source, names.columns), names.alias, false)
	const stated = (column: string | undefined, value: Expr): Target =>
		target(
			call("set_config", [
				lit.text(carrierSetting(carrier.name, column), types.text),
				cast(value, types.text),
				lit.bool(true)
			])
		)
	const columns = carrier.declaration.columns
	const targets = isNonEmpty(columns)
		? columns.map((c, i) =>
				stated(
					c.name,
					firstNonNull([
						call("array_agg", [
							cast(
								col(names.alias, defined(names.columns[i], "a carrier column's source")),
								travelling(c)
							)
						]),
						lit.text("{}", travellingArray(c))
					])
				)
			)
		: [stated(undefined, countStar())]
	return provedSelect("oneRow", targets, [from], undefined)
}

/**
 * The query that fills `carrier` with no row: each column's setting the empty array's text, a carrier of no column's
 * count 0. The fill of a side a statement returns no row of.
 */
export const emptyStash = (carrier: WriteCarrier): Select => {
	const stated = (column: string | undefined, value: string): Target =>
		target(
			call("set_config", [
				lit.text(carrierSetting(carrier.name, column), types.text),
				lit.text(value, types.text),
				lit.bool(true)
			])
		)
	const columns = carrier.declaration.columns
	return provedSelect(
		"oneRow",
		isNonEmpty(columns) ? columns.map((c) => stated(c.name, "{}")) : [stated(undefined, "0")],
		[],
		undefined
	)
}

/** The names a carrier's fill riding a statement reads its one row under: its alias, and a column per setting. */
export interface RidingNames {
	readonly stash: string
	readonly stashed: ReadonlyArray<string>
}

/**
 * A carrier's fill `stash` (`carrierStash`, `emptyStash`) riding a statement that delivers rows of its own
 * (write/program/compile.ts ridingSingle, ridingFamily): its one row read under `names` past OFFSET 1, so it delivers no
 * row, of no column, and the statement's arm that reads it evaluates it once, since an OFFSET reads every row it skips.
 * An arm of a UNION ALL is read to its end, so the fill runs whatever rows the statement's other arms deliver, none
 * among them.
 */
export const ridingStash = (stash: Select, names: RidingNames): Select => ({
	...provedSelect(
		"keyed",
		[],
		[derived(namedQuery(stash, names.stashed), names.stash, false)],
		undefined
	),
	offset: lit.int(1, types.bigint)
})

/** The columns a carrier's fill delivers, one per setting it writes: one per column, or its count's of no column. */
export const stashedWidth = (carrier: WriteCarrier): number =>
	Math.max(carrier.declaration.columns.length, 1)

/**
 * A carrier as a lowering reads the rows of a relation parameter its ChangeSet binds to a query (lower/conservative
 * BoundCarrier, ir/rel.ts InputSetInput `bound`): read as every carrier is (`carrierRead`), each field in its column.
 */
export const carrierRows = (carrier: WriteCarrier): BoundCarrier => ({
	carrier: carrier.name,
	scan: (alias) => carrierRead(carrier, alias),
	column: (field) => carrierField(carrier, field).column
})

/** A carrier column `column` of `type`: a builtin text one names pg_catalog.pg_c_utf8, like every stored column. */
export const carrierColumnDef = (column: string, type: TypeRef): ColumnDef =>
	type.kind === "builtin" && type.name === "text"
		? { name: column, type, collation: cUtf8Collation, generated: undefined }
		: { name: column, type, collation: undefined, generated: undefined }

/**
 * What fills a carrier: a described member's rows; or, for a carrier of a relation's facts (`relationCarrier`), the
 * relation's stored facts, or their difference with a snapshot carrier of the same relation, `added` the stored facts
 * the snapshot lacks and `removed` the reverse. A stored relation is read under `names`: reality's table, a role's view
 * of a whole entry, or, for a relation the role writes through a query entry, its table under the role's row security,
 * which shows exactly the entry's rows. A relation's carriers hold its fields in heading order, so every operand's
 * columns follow the filled carrier's position by position.
 */
type CarrierSource =
	| { readonly kind: "member"; readonly node: RelNode }
	| { readonly kind: "relation"; readonly relation: RelationInfo; readonly names: PhysicalNames }
	| {
			readonly kind: "difference"
			readonly side: "added" | "removed"
			readonly relation: RelationInfo
			readonly names: PhysicalNames
			readonly snapshot: WriteCarrier
	  }

/** A relation's facts as a statement reads them: the FROM item over them and each field's column, in heading order. */
interface FactsRead {
	readonly from: FromItem
	readonly columns: NonEmptyReadonlyArray<FactColumn>
}

/** A relation's stored facts, its fields in heading order, read under `names`. */
const storedFacts = (w: WriteContext, relation: RelationInfo, names: PhysicalNames): FactsRead => {
	const alias = w.cx.supply.relation({ kind: "internal", purpose: "carrier operand" })
	return {
		from: { kind: "table", table: names.relation(relation.name), alias },
		columns: mapNonEmpty(relation.heading, (f) => ({
			target: target(col(alias, names.column(relation.name, f.name))),
			type: f.type
		}))
	}
}

/** A snapshot carrier of `relation`'s facts (`relationCarrier`), its columns in the relation's heading order. */
const snapshotFacts = (
	w: WriteContext,
	relation: RelationInfo,
	carrier: WriteCarrier
): FactsRead => {
	const alias = w.cx.supply.relation({ kind: "internal", purpose: "carrier operand" })
	return {
		from: carrierRead(carrier, alias),
		columns: mapNonEmpty(relation.heading, (f) => ({
			target: target(col(alias, carrierField(carrier, f.name).column)),
			type: f.type
		}))
	}
}

/** Facts read whole, a set by the key of the relation they are facts of. */
const keyedFacts = (read: FactsRead): SetCore =>
	provedCore(
		"keyed",
		read.columns.map((c) => c.target),
		[read.from],
		undefined
	)

/**
 * The facts of `left` that `right` lacks, by their identity, a float's -0 and +0 two of them (ir/compare.ts
 * factOperand): a stored row changed only in its zero's sign is a change, where EXCEPT under PostgreSQL's equality
 * holds it unchanged. The EXCEPT reads each operand's float columns' signs after its columns, and its rows are read back
 * at the columns alone, a set by the relation's key, which every row of `left` holds.
 */
const factDifference = (w: WriteContext, left: FactsRead, right: FactsRead): Select => {
	const leftOperand = factOperand(left.columns)
	const rightOperand = factOperand(right.columns)
	const alias = w.cx.supply.relation({ kind: "internal", purpose: "carrier difference" })
	const columns = mapNonEmpty(left.columns, () =>
		w.cx.supply.column({ kind: "internal", purpose: "carrier difference column" })
	)
	const signs = Array.from({ length: leftOperand.signs }, () =>
		w.cx.supply.column({ kind: "internal", purpose: "carrier difference zero sign" })
	)
	const difference = select({
		kind: "setOp",
		op: "EXCEPT",
		arms: [
			provedCore("keyed", leftOperand.targets, [left.from], undefined),
			provedCore("keyed", rightOperand.targets, [right.from], undefined)
		]
	})
	return select(
		provedCore(
			"keyed",
			columns.map((c) => target(col(alias, c))),
			[derived(namedQuery(difference, [...columns, ...signs]), alias, false)],
			undefined
		)
	)
}

/**
 * The rows of the described node `node` as a carrier of `heading`, the node's own fields, holds them: each column cast
 * into its type, and a set, as every INSERT source is. The write's duplicate-elimination placement leaves a member's
 * root plain for its consumer to bound (program/compile.ts writeFacts), so the rows are read keyed only where the
 * member's lowering is a set and every cast keeps its value (writeKeeps); otherwise they are bounded as a set of facts
 * (ir/compare.ts factSet), since a plain root may repeat a row and a cast may round two values onto one, and a float's
 * two zeros are two facts. A member of no field is bounded under its unit
 * marker: its rows are the unit relation's, one row of no column at most.
 */
export const memberRows = (w: WriteContext, heading: Heading, node: RelNode): Select => {
	const lowered = w.cx.lower(node, emptyEnv)
	const origin = { kind: "node", node: node.id } as const
	const wrapped = w.cx.wrap(lowered, node.heading, origin)
	const columns = heading.map((c) => {
		const value = columnIn(wrapped.map, c.name)
		const type = columnType(node.heading, c.name)
		return {
			target: target(writeValue(w, value, { type, sqlType: undefined }, c.type)),
			type: c.type,
			keeps: writeKeeps(w, type, c.type)
		}
	})
	const targets = columns.map((c) => c.target)
	if (isSetQuery(lowered) && columns.every((c) => c.keeps)) {
		return select(keyedSet(targets, [wrapped.item], undefined, "a described member's rows"))
	}
	if (isNonEmpty(columns)) {
		return select(factSet(columns, [wrapped.item], undefined))
	}
	const unit = w.cx.wrap(select(distinctCore(unitTargets, [wrapped.item], undefined)), [], origin)
	return select(keyedSet([], [unit.item], undefined, "a described member's row of no column"))
}

const fillQuery = (w: WriteContext, carrier: WriteCarrier, source: CarrierSource): Select => {
	switch (source.kind) {
		case "member":
			return memberRows(w, carrier.heading, source.node)
		case "relation":
			return select(keyedFacts(storedFacts(w, source.relation, source.names)))
		case "difference": {
			const stored = () => storedFacts(w, source.relation, source.names)
			const snapshot = () => snapshotFacts(w, source.relation, source.snapshot)
			const [left, right] = source.side === "added" ? [stored, snapshot] : [snapshot, stored]
			const leftRead = left()
			return factDifference(w, leftRead, right())
		}
	}
}

/**
 * The statement filling `carrier` from `source` (`carrierStash`), a statement of its own in the write's flight, first
 * among the statements that read it: its one row carries nothing to decode.
 */
export const buildFillCarrier = (
	w: StatementWriting<EmittedSql>,
	carrier: WriteCarrier,
	source: CarrierSource
): WriteStatement<CarrierResult> =>
	buildStatement(w, ownBuild, (supply) => {
		const origin = { kind: "internal", purpose: "carrier fill" } as const
		const rows = fillQuery(w, carrier, source)
		return {
			ast: carrierStash(carrier, rows, {
				alias: supply.relation(origin),
				columns: carrier.heading.map(() => supply.column(origin))
			}),
			role: "carrier",
			result: { kind: "carrier", carrier: carrier.name },
			needs: always
		}
	})

/** A carrier for the facts of a relation, its fields in heading order, the order a read-back's Delta node reads
 * position by position: what it holds is some of the relation's facts as they stand before or after a change, a set by
 * the relation's key, as the write oracle's state comparison holds them (test/support/oracle/write/realize.ts). */
export const relationCarrier = (supply: CarrierSupply, relation: RelationInfo): WriteCarrier =>
	supply.next(
		relation.heading.map((f) => ({ name: f.name, type: f.type })),
		{
			ranks: ["cross"],
			rows: `${relation.name}'s facts`
		}
	)
