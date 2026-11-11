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
 *   CREATE TEMPORARY TABLE "pg_temp"."__carrier_<k>" ("c5" uuid NOT NULL, "c6" bytea NOT NULL, ...) ON COMMIT DROP
 *   INSERT INTO "pg_temp"."__carrier_<k>" ("c5", "c6", ...)
 *     SELECT "r7"."c5", "r7"."c6", ... FROM (SELECT pg_catalog.unnest($1::uuid[]) AS "c5", ...) AS "r7"
 *   ... the fill again, once per chunk of the rows ...
 *   ANALYZE "pg_temp"."__carrier_<k>", ...                     -- where the statement needs it (below)
 *   <the statement, each nested rows FROM item "pg_temp"."__carrier_<k>" AS "r7", its other placeholders from $1>
 *
 * The staged form (`stagedOf`) is compiled with the statement: each FROM item that reads its nested rows' arrays reads
 * a carrier of the same columns under the same alias instead, and the placeholders left are numbered again in order.
 * The runtime (`executionsOf`) sends the statement inline where its Bind message, measured from the rows' encoded
 * lengths, fits the transport, and otherwise the carriers' creations, their fills, each chunk of the rows as long as
 * one fill's Bind message carries, their ANALYZE where it is needed, and the staged statement, in that order, every
 * one in the call's flight. The statement runs once over every row, so what it writes and what its laws judge are the inline
 * statement's. A carrier is the session's own, named after the program's carriers (sql/naming.ts carrierName), drops at
 * COMMIT, and a rollback drops it with the rest; the role creates it under the database's TEMPORARY privilege, without
 * which the write is TemporaryRefused.
 *
 * The ANALYZE is for what the statement may refuse, never for speed, and the statement's own shape decides whether it
 * is sent (`analyzeOf`). A carrier created in the transaction that reads it has never been analyzed, so the planner
 * reads its size from its heap alone, and a heap of under ten pages, which rows of large values stored out of line make
 * (pantry's sixteen entries of 64 MiB are one page), is planned as ten pages of narrow rows, hundreds of them. A
 * statement reads stored rows only through sources each driven by a row it holds, or the row an arbitration met
 * (write/probe.ts), which PostgreSQL plans once per driving row whatever the carrier's count, so an arbitrated insert,
 * pantry's import among them, needs no ANALYZE. A target the statement updates, deletes from or merges into is planned
 * as a join against the rows the carriers feed: against the guess it scans the target whole, and under SERIALIZABLE a
 * sequential scan takes a relation-level SIRead lock, so every concurrent writer of that relation meets this write as a
 * serialization conflict and one of the two fails with 40001, a refusal of no conflict the two writes' rows hold.
 * Counted, the carrier's rows are what the planner probes the target by, one key at a time, as the program's own
 * carriers are analyzed for (write/program/analyze.ts). So a statement that holds such a target, a family additions
 * statement's recount of its owners, sends the ANALYZE, and no other does.
 */
import { defect, defined } from "#compiler/core/invariant.ts"
import { isNonEmpty, mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { StratumAt } from "#compiler/ir/stratum.ts"
import type { WriteParamSlot } from "#compiler/lower/conservative/types.ts"
import { partIndex } from "#compiler/runtime/lower/slots.ts"
import type { Staged, StagedAnalyze } from "#compiler/runtime/write/staged.ts"
import type {
	ArrayColumn,
	CreateCarrier,
	CteBody,
	EmittedText,
	FromSource,
	Insert,
	SqlStatement
} from "#compiler/sql/ast.ts"
import { arrays, col, positionalValue, provedCore, select, target } from "#compiler/sql/build.ts"
import { emitText } from "#compiler/sql/emit.ts"
import { type CarrierName, carrierName, emptyNameMap } from "#compiler/sql/naming.ts"
import { identityHooks, transformStatement } from "#compiler/sql/transform.ts"

/** A placeholder of a stratum's nested rows of `relation`: the column at `part` of their sent layout. */
export interface NestedColumnSlot {
	readonly stratum: StratumAt
	readonly relation: string
	readonly part: number
}

/** The column of nested rows a placeholder carries, none for any other. */
export const nestedColumnOf = (slot: WriteParamSlot): NestedColumnSlot | undefined =>
	slot.kind === "nestedRows"
		? { stratum: slot.stratum, relation: slot.relation, part: partIndex(slot.part) }
		: undefined

const noStaging: Staged = Object.freeze({ kind: "none" })

/** A FROM item reading a relation input's arrays, of at least one column. */
type ColumnsSource = Extract<FromSource, { readonly kind: "arrays" }> & {
	readonly source: { readonly kind: "columns" }
}

/** A FROM item of a statement's nested rows: the item, its columns, and the carrier it reads once staged. */
interface StagedSource {
	readonly item: ColumnsSource
	readonly columns: NonEmptyReadonlyArray<ArrayColumn>
	readonly carrier: CarrierName
}

/** Whether a FROM item reads a relation input's columns. */
const isColumnsSource = (source: FromSource): source is ColumnsSource =>
	source.kind === "arrays" && source.source.kind === "columns"

/** Every FROM item of `ast` that reads nested rows, in the transform's order, each with its carrier from `first`. */
const nestedSources = (
	ast: SqlStatement,
	nested: ReadonlyArray<NestedColumnSlot | undefined>,
	first: number
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
			found.push({ item: source, columns, carrier: carrierName(first + found.length) })
			return undefined
		}
	})
	return found
}

/** Whether `query` changes a target the planner joins against the rows it reads: an UPDATE, a DELETE or a MERGE; an
 * INSERT writes its rows and arbitrates by index, and a query changes nothing. */
const joinsTarget = (query: SqlStatement | CteBody): boolean =>
	query.kind === "update" || query.kind === "delete" || query.kind === "merge"

/**
 * The ANALYZE of a staged statement's carriers (see the header): needed where the statement, or a data-modifying CTE
 * of it, changes a target the planner joins against the rows the carriers feed (`joinsTarget`), absent otherwise. A
 * data-modifying CTE stands only in a statement's top-level WITH, so those are all the statement's changes.
 */
const analyzeOf = (
	ast: SqlStatement,
	sources: NonEmptyReadonlyArray<StagedSource>
): StagedAnalyze<EmittedText> => {
	const ctes = "with" in ast && ast.with !== undefined ? ast.with.ctes : []
	return joinsTarget(ast) || ctes.some((c) => joinsTarget(c.query))
		? {
				kind: "needed",
				text: emitText(
					{ kind: "analyze", carriers: mapNonEmpty(sources, (s) => s.carrier) },
					emptyNameMap
				).text
			}
		: { kind: "absent" }
}

/** A carrier's CREATE TEMPORARY TABLE: a column per array of its FROM item, of its element type and collation. */
const createOf = (source: StagedSource): CreateCarrier => ({
	kind: "createCarrier",
	name: source.carrier,
	columns: source.columns.map((c) => ({
		name: c.definition.name,
		type: c.definition.type,
		collation: c.definition.collation,
		generated: undefined
	})),
	primaryKey: undefined
})

/** A carrier's fill: its FROM item's arrays, its placeholders numbered from $1 in column order, inserted whole. */
const fillOf = (source: StagedSource): Insert => {
	const alias = source.item.alias
	const columns = mapNonEmpty(source.columns, (c, i) => ({
		definition: c.definition,
		array: positionalValue(i + 1)
	}))
	return {
		kind: "insert",
		with: undefined,
		table: source.carrier,
		alias: undefined,
		overriding: undefined,
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
 * The staged form of a statement (see the header), its carriers named from the program's `first`-th: none where it
 * reads no nested rows. `nested` gives each of its placeholders, by position, the column of nested rows it carries, or
 * none. A placeholder of nested rows anywhere but the FROM item of their columns is a defect: a statement reads its
 * nested rows once, as one source.
 */
export const stagedOf = (
	ast: SqlStatement,
	nested: ReadonlyArray<NestedColumnSlot | undefined>,
	first: number
): Staged => {
	if (nested.every((slot) => slot === undefined)) {
		return noStaging
	}
	const sources = nestedSources(ast, nested, first)
	if (!isNonEmpty(sources)) {
		throw defect("a statement's placeholders of nested rows read in a FROM item of their columns")
	}
	const moved = new Set(sources.flatMap((s) => s.columns.map((c) => c.array.number)))
	const kept = nested.flatMap((_, i) => (moved.has(i + 1) ? [] : [i]))
	const numbered = new Map(kept.map((position, i) => [position + 1, i + 1] as const))
	const renumbered = (number: number): number =>
		defined(numbered.get(number), `placeholder $${number}, which no nested rows' FROM item carries`)
	const carriers = new Map<FromSource, CarrierName>(sources.map((s) => [s.item, s.carrier]))
	const staged = transformStatement(ast, {
		...identityHooks,
		replaceSource: (source) => {
			const carrier = carriers.get(source)
			return carrier === undefined || source.kind !== "arrays"
				? undefined
				: { kind: "table", table: carrier, alias: source.alias }
		},
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
	return Object.freeze({
		kind: "carriers",
		carriers: mapNonEmpty(sources, (s) =>
			Object.freeze({
				create: emitText(createOf(s), emptyNameMap).text,
				fill: emitText(fillOf(s), emptyNameMap).text,
				columns: mapNonEmpty(s.columns, (c) => c.array.number - 1)
			})
		),
		analyze: Object.freeze(analyzeOf(ast, sources)),
		sql: emitText(staged, emptyNameMap).text,
		kept: Object.freeze(kept)
	})
}

/** The carriers a staged form names, which the next statement's are numbered after. */
export const carriersOf = (staged: Staged): number =>
	staged.kind === "carriers" ? staged.carriers.length : 0
