import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import {
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import { Refusal } from "#compiler/core/canonical.ts"
import { resourceBound } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { temporarySchema } from "#compiler/core/temporary.ts"
import { type FactColumn, factOperand, factSet } from "#compiler/ir/compare.ts"
import type { RelationInfo } from "#compiler/ir/law.ts"
import { always } from "#compiler/ir/needs.ts"
import type { PhysicalNames } from "#compiler/ir/physical.ts"
import type { CarrierDecl } from "#compiler/ir/products.ts"
import type { Heading, HeadingColumn, RelNode } from "#compiler/ir/rel.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { columnIn, emptyEnv } from "#compiler/lower/conservative/context.ts"
import type { BoundCarrier } from "#compiler/lower/conservative/types.ts"
import { columnType } from "#compiler/runtime/lower/columns.ts"
import type { StandUp } from "#compiler/runtime/write/flight.ts"
import {
	type ColumnDef,
	type CreateCarrier,
	type EmittedText,
	type EmptyCarrier,
	type FromItem,
	type FromSource,
	type Insert,
	isSetQuery,
	type PlFunction,
	type Select,
	type SetCore,
	type TypeRef
} from "#compiler/sql/ast.ts"
import {
	col,
	cUtf8Collation,
	derived,
	distinctCore,
	keyedSet,
	namedType,
	objectName,
	provedCore,
	select,
	simpleSelect,
	target,
	unitTargets
} from "#compiler/sql/build.ts"
import { emitText } from "#compiler/sql/emit.ts"
import {
	type CarrierDeclaration,
	type CarrierScope,
	carrierName,
	carrierReaderName,
	carrierReaderScan,
	emptyNameMap
} from "#compiler/sql/naming.ts"
import { carrierEmptying, printTableName, sessionReaderRows } from "#compiler/sql/print.ts"
import { sessionTypes } from "#compiler/sql/type-schemas.ts"
import {
	buildStatement,
	type CarrierResult,
	ownBuild,
	type WriteContext,
	type WriteStatement,
	writeKeeps,
	writeValue
} from "#compiler/write/insert/statement.ts"

/**
 * The most columns one table of PostgreSQL holds: a stored relation's table with the tag columns added to it, a view, a
 * stored derived relation's table and a write program's carrier, each refused as ResourceBound (tableColumns) where it is emitted,
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

/** A carrier: its declaration, each field of its heading with its column; a carrier of the unit relation has none.
 *
 * Session carriers filled by INSERT ... SELECT, each holding one use's rows.
 *
 * A described member is a leading CTE of the statement that consumes it, or a carrier of the same NOT NULL shape,
 * filled by INSERT ... SELECT, when sequential statements consume it: a same-key deletion and addition on an immutable
 * relation. A carrier holds a delta side only where a read-back after the last stratum reads it: the statement making
 * the side whole fills it from its RETURNING inside itself (write/readback/deltas.ts carriedFill). A carrier is a
 * temporary relation, so it lives in pg_temp and is never schema-qualified, and every column is NOT NULL. It is the
 * session's own: the session's stand-up of the write makes it, ON COMMIT PRESERVE ROWS, with its emptying, a session
 * function of its own name (`carrierStandUp`, runtime/write/flight.ts StandUp), once, before the session's first call
 * of the write, and each use empties it before it fills it (`buildEmptyCarrier`), so it holds that use's rows alone and
 * no COMMIT drops it, and it lives until the session ends. A carrier of a relation's facts, the write oracle's state
 * snapshot, is keyed by the relation's primary key (`relationCarrier`):
 *
 *   CREATE TEMPORARY TABLE "pg_temp"."__carrier_<k>" ("c1" uuid NOT NULL, "c2" uuid NOT NULL,
 *     "c3" "work"."kind" NOT NULL) ON COMMIT PRESERVE ROWS                        (the stand-up)
 *   SELECT "pg_temp"."__carrier_<k>"()                                            (each use: its emptying)
 *   INSERT INTO "pg_temp"."__carrier_<k>" ("c1", "c2", "c3") SELECT ... FROM (<member query>) AS "r0"(...)
 *
 * and a keyed one's CREATE ends its columns with PRIMARY KEY ("c1") DEFERRABLE INITIALLY IMMEDIATE.
 *
 * Carriers are named `__carrier_<k>_<digest>`, k the carrier's ordinal among its program's carriers from 1 and the
 * digest its declaration's, and their columns c1 to cn (sql/naming.ts CarrierName): a session keeps each served
 * statement under its text (core/prepared.ts), so the name a text reads a carrier by fixes the carrier's declaration,
 * its row type among it. A column
 * is typed as the value it carries is written: a contract's domain, a refinement's `__text_` domain, a
 * roster's domain, or the builtin with its typmod, a builtin text column naming pg_catalog.pg_c_utf8 like every stored column,
 * so a statement reading the carrier sees the types a stored column of the relation has. A deletion's
 * member writes nothing, so its carrier is typed as the deletion compares it instead: each field's base type with its
 * typmod, no contract or refinement domain (`compareHeading`, `CastInto` "compare").
 *
 * A carrier is filled only by INSERT ... SELECT: from a described member, from a stored relation (the conservative
 * realization's state snapshot), from the difference of two such relations (a delta by state comparison), or from a
 * delta side's rows, a data-modifying CTE of the statement that makes it (a carried side). A carrier
 * of no column, which PostgreSQL holds, is the unit relation's: filled by
 * `INSERT INTO "__carrier_<k>" SELECT FROM ...`, one row of no column per row its source reads, and read through
 * the unit marker. */
export interface WriteCarrier extends CarrierDecl {
	readonly heading: ReadonlyArray<CarrierColumn>
	/**
	 * Its CREATE TEMPORARY TABLE's columns, each typed as its value is written, and the columns of its primary key, in
	 * key order: a carrier of a relation's facts (`relationCarrier`) holds a set of them, keyed as the relation is, so
	 * the key a reader of it relies on is the carrier's own constraint; a member's or a share's rows, a set by their
	 * fill (`memberRows`), have none. Its name digests it.
	 */
	readonly declaration: CarrierDeclaration
}

/** A carrier's columns, in heading order. */
export const carrierColumns = (carrier: WriteCarrier): ReadonlyArray<string> =>
	carrier.heading.map((c) => c.column)

/**
 * The PostgreSQL type a carrier column of a value of `t` is declared with: its session type (ir/physical.ts
 * sessionTypeRef), the value's base type, never an installation's domain, so no migration that drops or changes a
 * domain meets a live session's carrier, and no role needs USAGE on a domain to stand one up.
 */
export type CarrierTyping = (t: ScalarType) => TypeRef

/**
 * How a program declares its carriers, each of which its name digests: whose session tables they are (sql/naming.ts
 * CarrierScope) and the type of each column (CarrierTyping). Every carrier of a program, its own and every staged one
 * (write/program/staged.ts, slot-carriers.ts), is declared by it.
 */
export interface CarrierDeclaring {
	readonly scope: CarrierScope
	readonly typing: CarrierTyping
}

/** The carriers of one program, each named by its ordinal among them and its declaration (see `WriteCarrier`). */
export class CarrierSupply {
	readonly #all: Array<WriteCarrier> = []
	readonly #declaring: CarrierDeclaring

	constructor(declaring: CarrierDeclaring) {
		this.#declaring = declaring
	}

	/** A carrier of `heading`, of any width, keyed by the fields `key` names, or by none. */
	next(heading: Heading, key: NonEmptyReadonlyArray<string> | undefined): WriteCarrier {
		const ordinal = this.#all.length + 1
		const at = `carrier ${ordinal}`
		const columns = Object.freeze(
			heading.map((c, i): CarrierColumn =>
				Object.freeze({ name: c.name, type: c.type, column: `c${i + 1}` })
			)
		)
		const declaration: CarrierDeclaration = Object.freeze({
			columns: Object.freeze(
				columns.map((c) => carrierColumnDef(c.column, this.#declaring.typing(c.type)))
			),
			primaryKey:
				key === undefined
					? undefined
					: Object.freeze(
							mapNonEmpty(
								key,
								(field) =>
									defined(
										columns.find((c) => c.name === field),
										`the key field ${field} in ${at}`
									).column
							)
						)
		})
		const carrier: WriteCarrier = Object.freeze({
			name: carrierName(this.#declaring.scope, ordinal, declaration),
			heading: columns,
			fill: "insertSelect" as const,
			declaration
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
 * The rows of the carrier `carrier` as a statement reads them: through its reader (sql/naming.ts carrierReaderScan), a
 * staged carrier's among them (write/program/staged.ts).
 */
export const carrierRead = (carrier: CreateCarrier, alias: string): FromSource =>
	carrierReaderScan(
		carrier.name,
		carrier.columns.map((c) => c.name),
		alias
	)

export const carrierScan = (carrier: WriteCarrier, alias: string): FromSource =>
	carrierRead(carrierTable(carrier), alias)

/**
 * A carrier as a lowering reads the rows of a relation parameter its ChangeSet binds to a query (lower/conservative
 * BoundCarrier, ir/rel.ts InputSetInput `bound`): scanned as every carrier is (`carrierScan`), each field in its column.
 */
export const carrierRows = (carrier: WriteCarrier): BoundCarrier => ({
	carrier: carrier.name,
	scan: (alias) => carrierScan(carrier, alias),
	column: (field) => carrierField(carrier, field).column
})

/**
 * A carrier's CREATE TEMPORARY TABLE, which the session's stand-up of the write sends (runtime/write/flight.ts
 * StandUp), refused as ResourceBound (tableColumns) for a heading wider than a table of PostgreSQL holds,
 * tableMaxColumns.
 */
export const carrierTable = (carrier: WriteCarrier): CreateCarrier => {
	if (carrier.heading.length > tableMaxColumns) {
		throw new Refusal(
			resourceBound(SourceLoc("write lowering", ["carriers", carrier.name]), {
				kind: "tableColumns",
				table: printTableName(carrier.name),
				limit: tableMaxColumns,
				needed: carrier.heading.length
			})
		)
	}
	return {
		kind: "createCarrier",
		name: carrier.name,
		primaryKey: carrier.declaration.primaryKey,
		columns: carrier.declaration.columns
	}
}

/** A carrier column `column` of `type`: a builtin text one names pg_catalog.pg_c_utf8, like every stored column. */
export const carrierColumnDef = (column: string, type: TypeRef): ColumnDef =>
	type.kind === "builtin" && type.name === "text"
		? { name: column, type, collation: cUtf8Collation, generated: undefined }
		: { name: column, type, collation: undefined, generated: undefined }

/**
 * A carrier's reader, the session function the session's stand-up makes beside the carrier, in pg_temp
 * (sql/naming.ts carrierReaderName): its rows' one SELECT, every column of the carrier, as RETURNS SETOF the carrier's
 * own row type, declaring the rows a call returns (sql/print.ts sessionReaderRows). Every statement reads the carrier through it
 * (`carrierRead`), so a statement's plan depends on the function, never on the table: a
 * TRUNCATE the emptying gives the carrier once it outgrows its page (sql/print.ts sessionTableEmptied), a new file of the table
 * and an invalidation of every plan over it, leaves every statement's plan standing for the next call, and only the
 * reader's own SELECT is planned again, as a judge's delta's reader does (physical/ddl/deltas.ts addReaders). Its owner
 * is the role that made the carrier, as its emptying's is.
 *
 *   CREATE OR REPLACE FUNCTION "pg_temp"."<carrier>_rows"() RETURNS SETOF "pg_temp"."<carrier>" ROWS 10 ... AS $$BEGIN
 *     RETURN QUERY SELECT r1.<column>, ... FROM pg_temp.<carrier> AS r1;
 *   END$$
 */
export const carrierReader = (carrier: CreateCarrier): PlFunction => ({
	kind: "createFunction",
	language: "plpgsql",
	name: objectName(temporarySchema, carrierReaderName(carrier.name)),
	params: [],
	returns: {
		setOf: namedType(sessionTypes, carrier.name, []),
		rows: { kind: "declared", rows: sessionReaderRows }
	},
	volatility: "VOLATILE",
	parallel: "UNSAFE",
	security: "DEFINER",
	body: {
		declare: [],
		body: [
			{
				kind: "returnQuery",
				query: simpleSelect(
					carrier.columns.map((c) => ({ expr: col("r1", c.name), alias: undefined })),
					[{ kind: "table", table: objectName(temporarySchema, carrier.name), alias: "r1" }],
					undefined
				)
			}
		]
	}
})

/**
 * A carrier's stand-up (runtime/write/flight.ts StandUp): its table; its emptying, the session function of its own
 * name in pg_temp (sql/print.ts carrierEmptying); and its reader, the session function every statement reads it
 * through (sql/print.ts carrierReader); each made as the write's role by the session's stand-up of the write, once, so
 * each use empties it by a call PostgreSQL plans once in the session, and no statement's plan depends on the table.
 */
export const carrierStandUp = (table: CreateCarrier): StandUp<EmittedText> => ({
	kind: "carrier",
	table: emitText(table, emptyNameMap).text,
	emptying: emitText(carrierEmptying(table.name), emptyNameMap).text,
	reader: emitText(carrierReader(table), emptyNameMap).text
})

/** A carrier's emptying before a use fills it (sql/ast.ts EmptyCarrier). */
const emptyAst = (carrier: WriteCarrier): EmptyCarrier => ({
	kind: "emptyCarrier",
	name: carrier.name
})

/**
 * A carrier's emptying as a statement of its own, which no lowering builds or shares: a staged member slot's carrier's
 * (write/program/slot-carriers.ts), placed after the statements are built.
 */
export const carrierEmptied = (carrier: WriteCarrier): WriteStatement<CarrierResult> => {
	const ast = emptyAst(carrier)
	return Object.freeze({
		role: "carrier" as const,
		ast,
		sql: emitText(ast, emptyNameMap),
		params: [],
		result: Object.freeze({
			kind: "carrier" as const,
			carrier: carrier.name,
			step: "empty" as const
		}),
		needs: always
	})
}

/** A carrier's emptying at the start of its stratum (write/schedule/plan.ts `emptyCarrier`). */
export const buildEmptyCarrier = (
	w: WriteContext,
	carrier: WriteCarrier
): WriteStatement<CarrierResult> =>
	buildStatement(w, { kind: "shared", memo: w.share.emptyings, key: [carrier] }, () => ({
		ast: emptyAst(carrier),
		role: "carrier",
		result: { kind: "carrier", carrier: carrier.name, step: "empty" },
		needs: always
	}))

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
		from: carrierScan(carrier, alias),
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
			[derived(difference, alias, [...columns, ...signs], false)],
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

export const buildFillCarrier = (
	w: WriteContext,
	carrier: WriteCarrier,
	source: CarrierSource
): WriteStatement<CarrierResult> => {
	return buildStatement(w, ownBuild, () => {
		const ast: Insert = {
			kind: "insert",
			table: carrier.name,
			columns: carrierColumns(carrier),
			source: { kind: "query", query: fillQuery(w, carrier, source) },
			with: undefined,
			alias: undefined,
			onConflict: undefined,
			returning: []
		}
		return {
			ast,
			role: "carrier",
			result: { kind: "carrier", carrier: carrier.name, step: "fill" },
			needs: always
		}
	})
}

/** A carrier for the facts of a relation, its fields in heading order, the order a read-back's Delta node reads
 * position by position, keyed by the relation's primary key: what it holds is some of the relation's facts as they
 * stand before or after a change, a set by that key, as the write oracle's state comparison holds them
 * (test/support/oracle/write/realize.ts). */
export const relationCarrier = (supply: CarrierSupply, relation: RelationInfo): WriteCarrier =>
	supply.next(
		relation.heading.map((f) => ({ name: f.name, type: f.type })),
		mapNonEmpty(relation.primaryFields, (f) => f.name)
	)
