/**
 * A statement's nested rows past one Bind message, carried through transaction carriers in the call's one flight.
 *
 * A family additions statement reads a stratum's nested rows of a relation as one array per column of their sent
 * layout (write/family/additions.ts), and PostgreSQL reads no Bind message longer than its longest message (core/
 * limits.ts messageMaxBytes), nor any array longer. The statement draws every family's indexes, counts and ends from
 * the rows it holds, and its laws judge what it writes at its end, so it is never run over a part of its rows: a fresh
 * owner's insert carries the count its whole family draws, which no part's members copy, and a mutable owner's
 * recount would write a count and ends one statement never writes. So the rows are moved, not the statement cut:
 *
 *   SELECT "pg_temp"."__carrier_<k>"()                       (the carrier emptied, sql/ast.ts EmptyCarrier)
 *   INSERT INTO "pg_temp"."__carrier_<k>" ("c5", "c6", ...)
 *     SELECT "r7"."c5", "r7"."c6", ... FROM (SELECT pg_catalog.unnest($1::uuid[]) AS "c5", ...) AS "r7"
 *   ... the fill again, once per chunk of the rows ...
 *   <the statement, each nested rows FROM item "pg_temp"."__carrier_<k>" AS "r7", its other placeholders from $1>
 *
 * The staged form (`stagedOf`) is compiled with the statement: each FROM item that reads its nested rows' arrays reads
 * a carrier of the same columns under the same alias instead, and the placeholders left are numbered again in order.
 * The runtime (`executionsOf`) sends the statement inline where its Bind message, measured from the rows' encoded
 * lengths, fits the transport, and otherwise the carriers' emptyings, their fills, each chunk of the rows as long as
 * one fill's Bind message carries, and the staged statement, in that order, every
 * one in the call's flight. The statement runs once over every row, so what it writes and what its laws judge are the inline
 * statement's. A carrier is the session's own, named after the program's carriers (sql/naming.ts carrierName), made with
 * its emptying by the session's stand-up of the write (`table`, runtime/write/flight.ts StandUp) as every carrier of the
 * write is, whether a call stages its rows or not; the role creates it under the database's TEMPORARY privilege, without
 * which the stand-up is TemporaryRefused.
 *
 * No carrier is analyzed, so PostgreSQL reads its size from its heap alone, and a heap of under ten pages, which rows of large values stored out of line make (pantry's
 * sixteen entries of 64 MiB are one page), is planned as ten pages of narrow rows, hundreds of them. Every stored
 * relation the statement joins is restricted to the keys of the rows it holds (write/probe.ts amongHeld), so it is
 * read by its key's index whatever that estimate, never whole, which under SERIALIZABLE takes a relation-level SIRead
 * lock and fails every concurrent writer of the relation with 40001.
 */
import { indices } from "@bjornpagen/grizzle-text/base/array"
import { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
import {
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import type { StratumAt } from "#compiler/ir/stratum.ts"
import type { WriteParamSlot } from "#compiler/lower/conservative/types.ts"
import type { Staged } from "#compiler/runtime/write/staged.ts"
import type {
	ArrayColumn,
	CreateCarrier,
	FromSource,
	Insert,
	SqlStatement
} from "#compiler/sql/ast.ts"
import { arrays, col, positionalValue, provedCore, select, target } from "#compiler/sql/build.ts"
import { emitText } from "#compiler/sql/emit.ts"
import {
	type CarrierDeclaration,
	type CarrierName,
	carrierName,
	emptyNameMap
} from "#compiler/sql/naming.ts"
import { identityHooks, transformStatement } from "#compiler/sql/transform.ts"
import {
	type CarrierDeclaring,
	carrierColumnDef,
	carrierRead
} from "#compiler/write/carriers/carriers.ts"

/** A placeholder of a column of a stratum's nested rows of `relation`: the column's type, which its carrier holds it by. */
export interface NestedColumnSlot {
	readonly stratum: StratumAt
	readonly relation: string
	readonly type: ScalarType
}

/** The column of nested rows a placeholder carries, none for any other: a count of rows is no column. */
export const nestedColumnOf = (slot: WriteParamSlot): NestedColumnSlot | undefined =>
	slot.kind === "nestedRows" && slot.part.kind === "column"
		? {
				stratum: slot.stratum,
				relation: slot.relation,
				type: defined(
					slot.columns[slot.part.index],
					"the column of a nested rows placeholder's part"
				).type
			}
		: undefined

const noStaging: Staged = Object.freeze({ kind: "none" })

/** A FROM item reading a relation input's arrays, of at least one column. */
type ColumnsSource = Extract<FromSource, { readonly kind: "arrays" }> & {
	readonly source: { readonly kind: "columns" }
}

/** A FROM item of a statement's nested rows: the item, its columns, the declaration of the carrier it reads once
 * staged, a column per array of its element type and collation, and that carrier. */
interface StagedSource {
	readonly item: ColumnsSource
	readonly columns: NonEmptyReadonlyArray<ArrayColumn>
	readonly declaration: CarrierDeclaration
	readonly carrier: CarrierName
}

/** Whether a FROM item reads a relation input's columns. */
const isColumnsSource = (source: FromSource): source is ColumnsSource =>
	source.kind === "arrays" && source.source.kind === "columns"

/** Every FROM item of `ast` that reads nested rows, in the transform's order, each with its carrier from `first`. */
const nestedSources = (
	ast: SqlStatement,
	nested: ReadonlyArray<NestedColumnSlot | undefined>,
	first: number,
	declaring: CarrierDeclaring
): ReadonlyArray<StagedSource> => {
	const found: Array<StagedSource> = []
	transformStatement(ast, {
		...identityHooks,
		replaceSource: (source) => {
			if (!isColumnsSource(source)) {
				return undefined
			}
			const columns = source.source.columns
			const of = columns.map((c) => nested[c.array.number - 1])
			if (of.every((slot) => slot === undefined)) {
				return undefined
			}
			const [head] = of
			if (
				head === undefined ||
				source.source.ordinal !== undefined ||
				!of.every(
					(slot) =>
						slot !== undefined && slot.stratum === head.stratum && slot.relation === head.relation
				)
			) {
				throw defect(
					"a FROM item of nested rows reads one stratum's rows of one relation alone, with no ordinal"
				)
			}
			const declaration: CarrierDeclaration = {
				columns: columns.map((c, i) =>
					carrierColumnDef(
						c.definition.name,
						declaring.typing(defined(of[i], "a nested rows column's placeholder").type)
					)
				),
				primaryKey: undefined
			}
			found.push({
				item: source,
				columns,
				declaration,
				carrier: carrierName(declaring.scope, first + found.length, declaration)
			})
			return undefined
		}
	})
	return found
}

/** A carrier's CREATE TEMPORARY TABLE, of its declaration, which the session's stand-up of the write sends. */
const createOf = (source: StagedSource): CreateCarrier => ({
	kind: "createCarrier",
	name: source.carrier,
	columns: source.declaration.columns,
	primaryKey: source.declaration.primaryKey
})

/** A carrier's fill: its FROM item's arrays, its placeholders numbered from $1 in column order, inserted whole. */
const fillOf = (source: StagedSource): Insert => {
	const alias = source.item.alias
	const columns = mapNonEmpty(source.columns, (c, i) => ({
		definition: c.definition,
		array: positionalValue(i + 1),
		check: c.check
	}))
	return {
		kind: "insert",
		with: undefined,
		table: source.carrier,
		alias: undefined,
		onConflict: undefined,
		returning: [],
		columns: source.columns.map((c) => c.definition.name),
		source: {
			kind: "query",
			query: select(
				provedCore(
					"input",
					source.columns.map((c) => target(col(alias, c.definition.name))),
					[arrays({ kind: "columns", columns, ordinal: undefined }, alias)],
					undefined
				)
			)
		}
	}
}

/**
 * The numbering of a statement's placeholders `$1` to `$count` once the `moved` ones are gone, each other numbered again
 * in order: a defect for a moved one, which the FROM item that read it no longer does once it is replaced.
 */
export const renumbering = (
	count: number,
	moved: ReadonlySet<number>
): ((number: number) => number) => {
	const kept = indices(count).flatMap((i) => (moved.has(i + 1) ? [] : [i + 1]))
	const numbered = new Map(kept.map((number, i) => [number, i + 1] as const))
	return (number) =>
		defined(numbered.get(number), `placeholder $${number}, which a replaced FROM item carries`)
}

/**
 * `ast` with each FROM item `replace` replaces, and every placeholder of the rest, a value's and an arrays FROM item's
 * count's and columns', numbered by `renumbered` (`renumbering`).
 */
export const renumberedStatement = (
	ast: SqlStatement,
	renumbered: (number: number) => number,
	replace: (source: FromSource) => FromSource | undefined
): SqlStatement =>
	transformStatement(ast, {
		...identityHooks,
		replaceSource: replace,
		expr: (e) =>
			e.kind === "param" ? { ...e, slot: positionalValue(renumbered(e.slot.number)) } : e,
		fromSource: (source) => {
			if (source.kind !== "arrays") {
				return source
			}
			const read = source.source
			return read.kind === "count"
				? { ...source, source: { ...read, count: positionalValue(renumbered(read.count.number)) } }
				: {
						...source,
						source: {
							...read,
							columns: mapNonEmpty(read.columns, (c) => ({
								...c,
								array: positionalValue(renumbered(c.array.number))
							}))
						}
					}
		}
	})

/**
 * The staged form of a statement (see the header), its carriers named from the program's `first`-th: none where it
 * reads no nested rows. `nested` gives each of its placeholders, by position, the column of nested rows it carries, or
 * none. A placeholder of nested rows anywhere but the FROM item of their columns is a defect: a statement reads its
 * nested rows once, as one source.
 */
export const stagedOf = (
	ast: SqlStatement,
	nested: ReadonlyArray<NestedColumnSlot | undefined>,
	first: number,
	declaring: CarrierDeclaring
): Staged => {
	if (nested.every((slot) => slot === undefined)) {
		return noStaging
	}
	const sources = nestedSources(ast, nested, first, declaring)
	if (!isNonEmpty(sources)) {
		throw defect("a statement's placeholders of nested rows read in a FROM item of their columns")
	}
	const moved = new Set(sources.flatMap((s) => s.columns.map((c) => c.array.number)))
	const kept = nested.flatMap((_, i) => (moved.has(i + 1) ? [] : [i]))
	const carriers = new Map<FromSource, CreateCarrier>(sources.map((s) => [s.item, createOf(s)]))
	const staged = renumberedStatement(ast, renumbering(nested.length, moved), (source) => {
		const carrier = carriers.get(source)
		return carrier === undefined || source.kind !== "arrays"
			? undefined
			: carrierRead(carrier, source.alias)
	})
	return Object.freeze({
		kind: "carriers",
		carriers: mapNonEmpty(sources, (s) =>
			Object.freeze({
				table: createOf(s),
				empty: emitText({ kind: "emptyCarrier", name: s.carrier }, emptyNameMap).text,
				fill: emitText(fillOf(s), emptyNameMap).text,
				columns: mapNonEmpty(s.columns, (c) => c.array.number - 1)
			})
		),
		sql: emitText(staged, emptyNameMap).text,
		kept: Object.freeze(kept)
	})
}

/** The carriers a staged form names, which the next statement's are numbered after. */
export const carriersOf = (staged: Staged): number =>
	staged.kind === "carriers" ? staged.carriers.length : 0
