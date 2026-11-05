import { canonicalFormat, encode, everyProperty, Refusal } from "#compiler/core/canonical.ts"
import { resourceBound, unsupported } from "#compiler/core/errors.ts"
import { defined } from "#compiler/core/invariant.ts"
import { tableMaxColumns } from "#compiler/core/limits.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { isNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { sha256Hex } from "#compiler/core/sha256.ts"
import type { RelationInfo } from "#compiler/ir/law.ts"
import type { PhysicalNames } from "#compiler/ir/physical.ts"
import type { CarrierDecl } from "#compiler/ir/products.ts"
import type { Heading, HeadingColumn, RelNode } from "#compiler/ir/rel.ts"
import { columnIn, columnType, emptyEnv } from "#compiler/lower/conservative/context.ts"
import type {
	Analyze,
	ColumnDef,
	CreateCarrier,
	FromItem,
	Insert,
	Select,
	SelectCore
} from "#compiler/sql/ast.ts"
import { col, core, cUtf8Collation, select, simpleSelect, target } from "#compiler/sql/build.ts"
import { emitText } from "#compiler/sql/emit.ts"
import {
	carrierDigestHex,
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
 * schema-qualified, it drops at COMMIT, and every column is NOT NULL:
 *
 *   CREATE TEMPORARY TABLE "__carrier_<d>_<k>" ("c1" uuid NOT NULL, "c2" uuid NOT NULL, "c3" "work"."kind" NOT NULL)
 *     ON COMMIT DROP
 *   INSERT INTO "__carrier_<d>_<k>" ("c1", "c2", "c3") SELECT ... FROM (<member query>) AS "r0"(...)
 *
 * Carriers are named `__carrier_<d>_<k>` and their columns c1 to cn. The name is a pair: d, a digest of its heading's
 * column types (typesDigest), and k, the carrier's ordinal among the program's carriers of those types, so a program
 * holds as many carriers of one column-type class as it makes. A session parses each named statement text once and
 * PostgreSQL refuses a cached plan whose result type changed (0A000), so a statement text must mean one result type
 * wherever it is sent: two programs that read or write "__carrier_<d>_<k>" by equal text read carriers of equal column
 * types. A count per program alone would let one text address carriers of different types, which a session meets as a
 * stale statement on a correct write. A column is
 * typed as the value it carries is written: a contract's domain, a refinement's `__text_` domain, an
 * enum, or the builtin with its typmod, a builtin text column naming pg_catalog.pg_c_utf8 like every stored column,
 * so a statement reading the carrier sees the types a stored column of the relation has. A deletion's
 * member writes nothing, so its carrier is typed as the deletion compares it instead: each field's base type with its
 * typmod, no contract or refinement domain (`compareHeading`, `CastInto` "compare").
 *
 * A carrier is filled only by INSERT ... SELECT: from a described member, from a stored relation (the conservative
 * realization's state snapshot), or from the difference of two such relations (a delta by state comparison). A carrier
 * of no column, which PostgreSQL holds, is the unit relation's: filled by
 * `INSERT INTO "__carrier_<d>_<k>" SELECT FROM ...`, one row of no column per row its source reads, and read through
 * the unit marker. */
export interface Carrier extends CarrierDecl {
	readonly heading: ReadonlyArray<CarrierColumn>
}

/** A carrier's columns, in heading order. */
export const carrierColumns = (carrier: Carrier): ReadonlyArray<string> =>
	carrier.heading.map((c) => c.column)

/**
 * A carrier's row as a comparison of facts or a RETURNING target reads it: the unit row of a carrier of no column,
 * whose every row is the unit relation's one fact, read through the unit marker; or its columns, at least one.
 */
export type CarrierRow =
	| { readonly kind: "unit" }
	| { readonly kind: "columns"; readonly columns: NonEmptyReadonlyArray<CarrierColumn> }

export const carrierRow = (carrier: Carrier): CarrierRow =>
	isNonEmpty(carrier.heading) ? { kind: "columns", columns: carrier.heading } : { kind: "unit" }

/** The canonical text of a heading's column types, what a carrier's digest stands for. Only the types count: a carrier's
 * columns are named c1 to cn whatever its fields are called, so two headings of equal types give a statement equal
 * result types. */
const typesText = (heading: Heading): string => {
	const text = encode(
		heading.map((c) => c.type),
		everyProperty
	)
	if (!text.ok) {
		throw new Refusal(text.error)
	}
	return text.value
}

/** The digest a carrier's name holds for the column types whose canonical text is `types`: the leading
 * carrierDigestHex hex digits of SHA-256 over them, domain-separated as every fingerprint is (core/fingerprint.ts). */
export const typesDigest = (types: string): string =>
	sha256Hex(`${canonicalFormat}\ncarrier column types\n${types}`).slice(0, carrierDigestHex.value)

/** The column types one digest stands for in a program, and how many carriers of them the program holds. */
interface TypesClass {
	readonly types: string
	readonly count: number
}

/** The carriers of one program, each named by its column types' digest and its ordinal among the program's carriers of
 * those types (see `Carrier`). A digest stands for one column-type class in the program: two classes that `digest`
 * gives one digest are refused, so no name is shared between different column types. */
export class CarrierSupply {
	readonly #digest: (types: string) => string
	readonly #classes = new Map<string, TypesClass>()
	readonly #all: Array<Carrier> = []

	/** A supply naming carriers by `digest`: typesDigest, or a test's stand-in. */
	constructor(digest: (types: string) => string) {
		this.#digest = digest
	}

	/** A carrier of `heading`, of any width. */
	next(heading: Heading): Carrier {
		const types = typesText(heading)
		const digest = this.#digest(types)
		const known = this.#classes.get(digest)
		if (known !== undefined && known.types !== types) {
			throw new Refusal(
				unsupported(
					SourceLoc("write lowering", ["carriers"]),
					`carriers of distinct column types under distinct digests; two of this program's share the digest ${digest}`
				)
			)
		}
		const ordinal = (known?.count ?? 0) + 1
		this.#classes.set(digest, { types, count: ordinal })
		const carrier: Carrier = Object.freeze({
			name: carrierName(digest, ordinal),
			heading: Object.freeze(
				heading.map((c, i): CarrierColumn =>
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

/**
 * A carrier's CREATE TEMPORARY TABLE, refused as ResourceBound (tableColumns) for a heading wider than a table of
 * PostgreSQL holds, tableMaxColumns.
 */
const createAst = (w: WriteContext, carrier: Carrier): CreateCarrier => {
	const at = `carrier ${carrier.name}`
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
		columns: carrier.heading.map((c): ColumnDef => {
			const type = w.cx.typeRef(c.type, at)
			return type.kind === "builtin" && type.name === "text"
				? {
						name: c.column,
						type,
						collation: cUtf8Collation,
						generated: undefined
					}
				: { name: c.column, type, collation: undefined, generated: undefined }
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

/** ANALYZE pg_temp.__carrier_<d>_<k>, ... of carriers the program created and filled, so each later statement that joins
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
			readonly snapshot: Carrier
	  }

/** A relation's stored facts, its fields in heading order, read under `names`. */
const storedBody = (w: WriteContext, relation: RelationInfo, names: PhysicalNames): SelectCore => {
	const alias = w.cx.supply.relation({ kind: "internal", purpose: "carrier operand" })
	return core(
		relation.heading.map((f) => target(col(alias, names.column(relation.name, f.name)))),
		[{ kind: "table", table: names.relation(relation.name), alias }],
		undefined
	)
}

/** A carrier's rows, its columns in heading order. */
const carrierBody = (w: WriteContext, carrier: Carrier): SelectCore => {
	const alias = w.cx.supply.relation({ kind: "internal", purpose: "carrier operand" })
	return core(
		carrier.heading.map((c) => target(col(alias, c.column))),
		[carrierScan(carrier, alias)],
		undefined
	)
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
			return select({ kind: "setOp", op: "EXCEPT", arms: [leftBody, right()] })
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

/** A carrier for the facts of a relation, its fields in heading order, the order a
 * read-back's Delta node reads position by position. */
export const relationCarrier = (supply: CarrierSupply, relation: RelationInfo): Carrier =>
	supply.next(relation.heading.map((f) => ({ name: f.name, type: f.type })))
