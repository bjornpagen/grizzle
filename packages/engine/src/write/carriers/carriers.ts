import { Refusal } from "#compiler/core/canonical.ts"
import { resourceBound } from "#compiler/core/errors.ts"
import { defined } from "#compiler/core/invariant.ts"
import { tableMaxColumns } from "#compiler/core/limits.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { isNonEmpty, mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { RelationInfo } from "#compiler/ir/law.ts"
import type { PhysicalNames } from "#compiler/ir/physical.ts"
import type { CarrierDecl } from "#compiler/ir/products.ts"
import type { Heading, HeadingColumn, RelNode } from "#compiler/ir/rel.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { columnIn, emptyEnv } from "#compiler/lower/conservative/context.ts"
import { columnType } from "#compiler/runtime/lower/columns.ts"
import {
	type Analyze,
	type ColumnDef,
	type CreateCarrier,
	type FromItem,
	type Insert,
	isSetQuery,
	type Select,
	type SetCore,
	type TypeRef
} from "#compiler/sql/ast.ts"
import {
	col,
	cUtf8Collation,
	distinctCore,
	keyedSet,
	provedCore,
	select,
	target,
	unitTargets
} from "#compiler/sql/build.ts"
import { emitText } from "#compiler/sql/emit.ts"
import {
	type CarrierDeclaration,
	type CarrierName,
	carrierName,
	emptyNameMap
} from "#compiler/sql/naming.ts"
import { printTableName } from "#compiler/sql/print.ts"
import {
	type AnalyzeResult,
	buildStatement,
	type CarrierResult,
	ownBuild,
	type WriteContext,
	type WriteStatement,
	writeKeeps,
	writeValue
} from "#compiler/write/insert/statement.ts"

/** A field of a carrier's heading with the column that holds it. */
export interface CarrierColumn extends HeadingColumn {
	readonly column: string
}

/** A carrier: its declaration, each field of its heading with its column; a carrier of the unit relation has none.
 *
 * Transaction-scoped carriers filled by INSERT ... SELECT.
 *
 * A described member is a leading CTE of the statement that consumes it, or a carrier with the same ON COMMIT DROP
 * and NOT NULL shape, filled by INSERT ... SELECT, when sequential statements consume it: a same-key deletion and
 * addition on an immutable relation, the sequence advance after explicit serial values (serial/), or a read-back of
 * post-change state. A carrier is a temporary relation, so it lives in pg_temp and is never
 * schema-qualified, it drops at COMMIT, and every column is NOT NULL; a carrier of a relation's facts is keyed by the
 * relation's primary key (`relationCarrier`):
 *
 *   CREATE TEMPORARY TABLE "__carrier_<k>" ("c1" uuid NOT NULL, "c2" uuid NOT NULL, "c3" "work"."kind" NOT NULL)
 *     ON COMMIT DROP
 *   INSERT INTO "__carrier_<k>" ("c1", "c2", "c3") SELECT ... FROM (<member query>) AS "r0"(...)
 *   CREATE TEMPORARY TABLE "__carrier_<k>" ("c1" uuid NOT NULL, "c2" text COLLATE pg_catalog.pg_c_utf8 NOT NULL,
 *     PRIMARY KEY ("c1") DEFERRABLE INITIALLY IMMEDIATE) ON COMMIT DROP
 *
 * Carriers are named `__carrier_<k>_<digest>`, k the carrier's ordinal among its program's carriers from 1 and the
 * digest its declaration's, and their columns c1 to cn (sql/naming.ts CarrierName): a session keeps each served
 * statement under its text (core/prepared.ts), and PostgreSQL plans it again over the carrier its next call creates,
 * so the name a text reads a carrier by fixes the carrier's declaration, its row type among it. A column
 * is typed as the value it carries is written: a contract's domain, a refinement's `__text_` domain, a
 * roster's domain, or the builtin with its typmod, a builtin text column naming pg_catalog.pg_c_utf8 like every stored column,
 * so a statement reading the carrier sees the types a stored column of the relation has. A deletion's
 * member writes nothing, so its carrier is typed as the deletion compares it instead: each field's base type with its
 * typmod, no contract or refinement domain (`compareHeading`, `CastInto` "compare").
 *
 * A carrier is filled only by INSERT ... SELECT: from a described member, from a stored relation (the conservative
 * realization's state snapshot), or from the difference of two such relations (a delta by state comparison). A carrier
 * of no column, which PostgreSQL holds, is the unit relation's: filled by
 * `INSERT INTO "__carrier_<k>" SELECT FROM ...`, one row of no column per row its source reads, and read through
 * the unit marker. */
export interface WriteCarrier extends CarrierDecl {
	readonly heading: ReadonlyArray<CarrierColumn>
	/**
	 * Its CREATE TEMPORARY TABLE's columns, each typed as its value is written, and the columns of its primary key, in
	 * key order: a carrier of a relation's facts (`relationCarrier`) holds a set of them, keyed as the relation is, so
	 * the key a reader of it relies on is the carrier's own constraint; a member's or a share's rows, a set by their
	 * fill (`memberRows`) that no constraint keys, and a world relation's empty delta have none. Its name digests it.
	 */
	readonly declaration: CarrierDeclaration
}

/** A carrier's columns, in heading order. */
export const carrierColumns = (carrier: WriteCarrier): ReadonlyArray<string> =>
	carrier.heading.map((c) => c.column)

/**
 * A carrier's row as a comparison of facts or a RETURNING target reads it: the unit row of a carrier of no column,
 * whose every row is the unit relation's one fact, read through the unit marker; or its columns, at least one.
 */
export type CarrierRow =
	| { readonly kind: "unit" }
	| { readonly kind: "columns"; readonly columns: NonEmptyReadonlyArray<CarrierColumn> }

export const carrierRow = (carrier: WriteCarrier): CarrierRow =>
	isNonEmpty(carrier.heading) ? { kind: "columns", columns: carrier.heading } : { kind: "unit" }

/**
 * The PostgreSQL type a carrier column of a value of `t` is declared with, as a stored column of its type is: a
 * contract's domain, a refinement's `__text_` domain, a roster's domain, or the builtin with its typmod
 * (lower/conservative/context.ts typeRef), `at` naming the carrier where a type is refused.
 */
export type CarrierTyping = (t: ScalarType, at: string) => TypeRef

/** The carriers of one program, each named by its ordinal among them and its declaration (see `WriteCarrier`). */
export class CarrierSupply {
	readonly #all: Array<WriteCarrier> = []
	readonly #typing: CarrierTyping

	constructor(typing: CarrierTyping) {
		this.#typing = typing
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
			columns: Object.freeze(columns.map((c) => columnDefOf(c.column, this.#typing(c.type, at)))),
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
			name: carrierName(ordinal, declaration),
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

export const carrierScan = (carrier: WriteCarrier, alias: string): FromItem => ({
	kind: "table",
	table: carrier.name,
	alias
})

/**
 * A carrier's CREATE TEMPORARY TABLE, refused as ResourceBound (tableColumns) for a heading wider than a table of
 * PostgreSQL holds, tableMaxColumns.
 */
const createAst = (carrier: WriteCarrier): CreateCarrier => {
	if (carrier.heading.length > tableMaxColumns.value) {
		throw new Refusal(
			resourceBound(SourceLoc("write lowering", ["carriers", carrier.name]), {
				kind: "tableColumns",
				table: printTableName(carrier.name),
				limit: tableMaxColumns.value,
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
const columnDefOf = (column: string, type: TypeRef): ColumnDef =>
	type.kind === "builtin" && type.name === "text"
		? { name: column, type, collation: cUtf8Collation, generated: undefined }
		: { name: column, type, collation: undefined, generated: undefined }

export const buildCreateCarrier = (
	w: WriteContext,
	carrier: WriteCarrier
): WriteStatement<CarrierResult> =>
	buildStatement(w, { kind: "shared", memo: w.share.creations, key: [carrier] }, () => ({
		ast: createAst(carrier),
		role: "carrier",
		result: { kind: "carrier", carrier: carrier.name, step: "create" },
		skipWhenEmpty: undefined
	}))

/** ANALYZE pg_temp.__carrier_<k>, ... of carriers the program created and filled, so each later statement that joins
 * one against a stored relation plans with its exact row count instead of PostgreSQL's ten-page guess for a relation
 * never analyzed (placement in). A carrier is the session's own,
 * so the lock it takes is uncontended, and the statement reads no stored relation. */
export const buildAnalyzeCarriers = (
	carriers: NonEmptyReadonlyArray<CarrierName>
): WriteStatement<AnalyzeResult> => {
	const ast: Analyze = { kind: "analyze", carriers: Object.freeze([...carriers]) }
	const sql = emitText(ast, emptyNameMap)
	return Object.freeze({
		role: "carrier" as const,
		ast,
		sql,
		params: [],
		result: { kind: "analyze" as const, carriers: ast.carriers },
		skipWhenEmpty: undefined
	})
}

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

/** A relation's stored facts, its fields in heading order, read under `names`. */
const storedBody = (w: WriteContext, relation: RelationInfo, names: PhysicalNames): SetCore => {
	const alias = w.cx.supply.relation({ kind: "internal", purpose: "carrier operand" })
	return provedCore(
		"keyed",
		relation.heading.map((f) => target(col(alias, names.column(relation.name, f.name)))),
		[{ kind: "table", table: names.relation(relation.name), alias }],
		undefined
	)
}

/** A carrier's rows, its columns in heading order. */
const carrierBody = (w: WriteContext, carrier: WriteCarrier): SetCore => {
	const alias = w.cx.supply.relation({ kind: "internal", purpose: "carrier operand" })
	return provedCore(
		"keyed",
		carrier.heading.map((c) => target(col(alias, c.column))),
		[carrierScan(carrier, alias)],
		undefined
	)
}

/**
 * The rows of the described node `node` as a carrier of `heading`, the node's own fields, holds them: each column cast
 * into its type, and a set, as every INSERT source is. The write's duplicate-elimination placement leaves a member's
 * root plain for its consumer to bound (program/compile.ts writeFacts), so the rows are read keyed only where the
 * member's lowering is a set and every cast keeps its value (writeKeeps); otherwise SELECT DISTINCT bounds them, since a
 * plain root may repeat a row and a cast may round two values onto one. A member of no field is bounded under its unit
 * marker: its rows are the unit relation's, one row of no column at most.
 */
export const memberRows = (
	w: WriteContext,
	heading: Heading,
	node: RelNode,
	at: string
): Select => {
	const lowered = w.cx.lower(node, emptyEnv)
	const origin = { kind: "node", node: node.id } as const
	const wrapped = w.cx.wrap(lowered, node.heading, origin)
	const columns = heading.map((c) => {
		const value = columnIn(wrapped.map, c.name)
		const type = columnType(node.heading, c.name)
		return {
			target: target(writeValue(w, value, { type, sqlType: undefined }, c.type, at)),
			keeps: writeKeeps(w, type, c.type)
		}
	})
	const targets = columns.map((c) => c.target)
	if (isSetQuery(lowered) && columns.every((c) => c.keeps)) {
		return select(keyedSet(targets, [wrapped.item], undefined, "a described member's rows"))
	}
	if (isNonEmpty(targets)) {
		return select(distinctCore(targets, [wrapped.item], undefined))
	}
	const unit = w.cx.wrap(select(distinctCore(unitTargets, [wrapped.item], undefined)), [], origin)
	return select(keyedSet([], [unit.item], undefined, "a described member's row of no column"))
}

const fillQuery = (
	w: WriteContext,
	carrier: WriteCarrier,
	source: CarrierSource,
	at: string
): Select => {
	switch (source.kind) {
		case "member":
			return memberRows(w, carrier.heading, source.node, at)
		case "relation":
			return select(storedBody(w, source.relation, source.names))
		case "difference": {
			const stored = () => storedBody(w, source.relation, source.names)
			const snapshot = () => carrierBody(w, source.snapshot)
			const [left, right] = source.side === "added" ? [stored, snapshot] : [snapshot, stored]
			const leftBody = left()
			return select({ kind: "setOp", op: "EXCEPT", arms: [leftBody, right()] })
		}
	}
}

export const buildFillCarrier = (
	w: WriteContext,
	carrier: WriteCarrier,
	source: CarrierSource
): WriteStatement<CarrierResult> => {
	const at = `fill ${carrier.name}`
	return buildStatement(w, ownBuild, () => {
		const ast: Insert = {
			kind: "insert",
			table: carrier.name,
			columns: carrierColumns(carrier),
			source: { kind: "query", query: fillQuery(w, carrier, source, at) },
			with: undefined,
			alias: undefined,
			overriding: undefined,
			onConflict: undefined,
			returning: []
		}
		return {
			ast,
			role: "carrier",
			result: { kind: "carrier", carrier: carrier.name, step: "fill" },
			skipWhenEmpty: undefined
		}
	})
}

/** A carrier for the facts of a relation, its fields in heading order, the order a read-back's Delta node reads
 * position by position, keyed by the relation's primary key: what it holds is some of the relation's facts as they
 * stand before or after a change, a set by that key. */
export const relationCarrier = (supply: CarrierSupply, relation: RelationInfo): WriteCarrier =>
	supply.next(
		relation.heading.map((f) => ({ name: f.name, type: f.type })),
		mapNonEmpty(relation.primaryFields, (f) => f.name)
	)
