import { everyProperty, Refusal } from "#compiler/core/canonical.ts"
import { resourceBound } from "#compiler/core/errors.ts"
import { digest } from "#compiler/core/fingerprint.ts"
import { defined, invariant } from "#compiler/core/invariant.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { isNonEmpty, mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { RelationInfo } from "#compiler/ir/law.ts"
import type { CarrierDecl } from "#compiler/ir/products.ts"
import type { Heading, HeadingColumn, RelNode } from "#compiler/ir/rel.ts"
import { columnIn, columnType, emptyEnv } from "#compiler/lower/conservative/context.ts"
import type { PhysicalNames } from "#compiler/lower/conservative/types.ts"
import { withoutSerial } from "#compiler/scalar/compute/types.ts"
import type {
	Analyze,
	ColumnDef,
	CreateCarrier,
	FromItem,
	Insert,
	Select,
	SelectBody
} from "#compiler/sql/ast.ts"
import { col, cUtf8Collation, select, simpleSelect, target } from "#compiler/sql/build.ts"
import { emitText } from "#compiler/sql/emit.ts"
import { type CarrierName, carrierName, emptyNameMap } from "#compiler/sql/naming.ts"
import {
	type AnalyzeResult,
	buildStatement,
	type CarrierResult,
	ownBuild,
	type WriteContext,
	type WriteStatement,
	writeValue
} from "#compiler/write/insert/statement.ts"

/** A field of a carrier's heading with the column that holds it. */
export interface CarrierColumn extends HeadingColumn {
	readonly column: string
}

/** A carrier: its declaration, each field of its heading with its column.
 *
 * Transaction-scoped carriers filled by INSERT ... SELECT.
 *
 * A described member is a leading CTE of the statement that consumes it, or a carrier with the same ON COMMIT DROP
 * and NOT NULL shape, filled by INSERT ... SELECT, when sequential statements consume it: a same-key deletion and
 * addition on an immutable relation, the sequence advance after explicit serial values (serial/), or a read-back of
 * post-change state. A carrier is a temporary relation, so it lives in pg_temp and is never
 * schema-qualified, it drops at COMMIT, and every column is NOT NULL:
 *
 *   CREATE TEMPORARY TABLE "__carrier_<n>" ("c1" uuid NOT NULL, "c2" uuid NOT NULL, "c3" "work"."kind" NOT NULL)
 *     ON COMMIT DROP
 *   INSERT INTO "__carrier_<n>" ("c1", "c2", "c3") SELECT ... FROM (<member query>) AS "r0"(...)
 *
 * Carriers are named `__carrier_<n>` and their columns c1 to cn. The number n names the carrier's column types: its
 * high bits are a digest of its heading's types, and its low bits the carrier's ordinal among the program's carriers of
 * those types (carrierNumber). A session parses each named statement text once and PostgreSQL refuses a cached plan whose
 * result type changed (0A000), so a statement text must mean one result type wherever it is sent: two programs that
 * read or write "__carrier_<n>" by equal text read carriers of equal column types. A count per program would let one
 * text address carriers of different types, which a session meets as a stale statement on a correct write. A column is
 * typed as the value it carries is written: a contract's domain, a refinement's `__text_` domain, an
 * enum, or the builtin with its typmod, a builtin text column naming pg_catalog.pg_c_utf8 like every stored column,
 * so a statement reading the carrier sees the types a stored column of the relation has. A deletion's
 * member writes nothing, so its carrier is typed as the deletion compares it instead: each field's base type with its
 * typmod, no contract or refinement domain (`compareHeading`, `CastInto` "compare").
 *
 * A carrier is filled only by INSERT ... SELECT: from a described member, from a stored relation (the conservative
 * realization's state snapshot), or from the difference of two such relations (a delta by state comparison). */
export interface Carrier extends CarrierDecl {
	readonly heading: NonEmptyReadonlyArray<CarrierColumn>
}

/** A carrier's columns, in heading order. */
export const carrierColumns = (carrier: Carrier): NonEmptyReadonlyArray<string> =>
	mapNonEmpty(carrier.heading, (c) => c.column)

/** How many carriers of one heading's column types one program may hold: a carrier number's low bits. */
const ordinalSpan = 0x1_0000

/** How many leading hex digits of the types' digest a carrier number keeps: 36 bits, so the number, those bits times
 * ordinalSpan plus the ordinal, stays an exact integer below 2^53. */
const typesDigestHex = 9

/** The digest of a heading's column types, as a carrier number's high bits. Only the types count: a carrier's columns
 * are named c1 to cn whatever its fields are called, so two headings of equal types give a statement equal result
 * types. */
const typesDigest = (heading: Heading): number => {
	const d = digest(
		"carrier column types",
		heading.map((c) => c.type),
		everyProperty
	)
	if (!d.ok) {
		throw new Refusal(d.error)
	}
	return Number.parseInt(d.value.slice(0, typesDigestHex), 16)
}

/** The number of the `ordinal`-th carrier of the column types whose digest is `types`, ordinal from 1. */
const carrierNumber = (types: number, ordinal: number): number => types * ordinalSpan + ordinal

/** The carriers of one program, each numbered by its column types and its ordinal among the program's carriers of those
 * types (see `Carrier`). */
export class CarrierSupply {
	readonly #ordinals = new Map<number, number>()
	readonly #all: Array<Carrier> = []

	/** A carrier of `heading`. The one site of the fact "a carrier carries at least one column": a relation's carrier
	 * passes its nonempty heading, but a carried share's node, a described member's delivered fields and a world
	 * relation's delta are IR headings, which the IR types as possibly empty though the share selection skips an empty
	 * node, the front end refuses a member delivering no field, and a world relation's definition heads a field. */
	next(heading: Heading): Carrier {
		invariant(isNonEmpty(heading), "a carrier carries at least one column")
		const types = typesDigest(heading)
		const ordinal = (this.#ordinals.get(types) ?? 0) + 1
		if (ordinal >= ordinalSpan) {
			throw new Refusal(
				resourceBound(SourceLoc("write lowering", ["carriers"]), {
					kind: "carriers",
					limit: ordinalSpan - 1
				})
			)
		}
		this.#ordinals.set(types, ordinal)
		const carrier: Carrier = Object.freeze({
			name: carrierName(carrierNumber(types, ordinal)),
			heading: Object.freeze(
				mapNonEmpty(heading, (c, i): CarrierColumn =>
					Object.freeze({ name: c.name, type: c.type, column: `c${i + 1}` })
				)
			),
			fill: "insertSelect" as const
		})
		this.#all.push(carrier)
		return carrier
	}

	all(): ReadonlyArray<Carrier> {
		return [...this.#all]
	}
}

/** The carrier column of a field of its heading: the carrier was made over the fields its readers read. The one site of
 * the fact "a field a carrier's reader reads is a column of the carrier": readers name the fields of their relation by
 * name, and a carrier is made over a list of them. */
export const carrierField = (carrier: Carrier, field: string): CarrierColumn =>
	defined(
		carrier.heading.find((c) => c.name === field),
		`the field ${field} in carrier ${carrier.name}`
	)

export const carrierScan = (carrier: Carrier, alias: string): FromItem => ({
	kind: "table",
	table: carrier.name,
	alias
})

const createAst = (w: WriteContext, carrier: Carrier): CreateCarrier => {
	const at = `carrier ${carrier.name}`
	return {
		kind: "createCarrier",
		name: carrier.name,
		columns: mapNonEmpty(carrier.heading, (c): ColumnDef => {
			const type = w.cx.typeRef(c.type, at)
			return type.kind === "builtin" && type.name === "text"
				? {
						name: c.column,
						type,
						collation: cUtf8Collation,
						generated: undefined,
						default: undefined
					}
				: { name: c.column, type, collation: undefined, generated: undefined, default: undefined }
		})
	}
}

export const buildCreateCarrier = (
	w: WriteContext,
	carrier: Carrier
): WriteStatement<CarrierResult> =>
	buildStatement(w, { kind: "shared", memo: w.share.creations, key: [carrier] }, () => ({
		ast: createAst(w, carrier),
		role: "carrier",
		result: { kind: "carrier", carrier: carrier.name, step: "create" },
		skipWhenEmpty: undefined
	}))

/** ANALYZE pg_temp.__carrier_<n>, ... of carriers the program created and filled, so each later statement that joins
 * one against a stored relation plans with its exact row count instead of PostgreSQL's ten-page guess for a relation
 * never analyzed (placement in). A carrier is the session's own,
 * so the lock it takes is uncontended, and the statement reads no stored relation. */
export const buildAnalyzeCarriers = (
	carriers: ReadonlyArray<CarrierName>
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
			readonly snapshot: Carrier
	  }

/** A relation's stored facts, its fields in heading order, read under `names`. */
const storedBody = (w: WriteContext, relation: RelationInfo, names: PhysicalNames): SelectBody => {
	const alias = w.cx.supply.relation({ kind: "internal", purpose: "carrier operand" })
	return simpleSelect(
		relation.heading.map((f) => target(col(alias, names.column(relation.name, f.name)))),
		[{ kind: "table", table: names.relation(relation.name), alias }],
		undefined
	).body
}

/** A carrier's rows, its columns in heading order. */
const carrierBody = (w: WriteContext, carrier: Carrier): SelectBody => {
	const alias = w.cx.supply.relation({ kind: "internal", purpose: "carrier operand" })
	return simpleSelect(
		carrier.heading.map((c) => target(col(alias, c.column))),
		[carrierScan(carrier, alias)],
		undefined
	).body
}

/** The rows of the described node `node` as a carrier of `heading`, the node's own fields, holds them: each column cast
 * into its type. */
export const memberRows = (
	w: WriteContext,
	heading: Heading,
	node: RelNode,
	at: string
): Select => {
	const lowered = w.cx.lower(node, emptyEnv)
	const wrapped = w.cx.wrap(lowered, node.heading, { kind: "node", node: node.id })
	return simpleSelect(
		heading.map((c) => {
			const value = columnIn(wrapped.map, c.name)
			const type = columnType(node.heading, c.name)
			return target(writeValue(w, value, { type, sqlType: undefined }, c.type, at))
		}),
		[wrapped.item],
		undefined
	)
}

const fillQuery = (
	w: WriteContext,
	carrier: Carrier,
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
			return select({ kind: "setOp", op: "EXCEPT", left: leftBody, right: right() })
		}
	}
}

export const buildFillCarrier = (
	w: WriteContext,
	carrier: Carrier,
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

/** A carrier for the facts of a relation, its fields in heading order, serial generation flags dropped, the order a
 * read-back's Delta node reads position by position. */
export const relationCarrier = (supply: CarrierSupply, relation: RelationInfo): Carrier =>
	supply.next(mapNonEmpty(relation.heading, (f) => ({ name: f.name, type: withoutSerial(f.type) })))
