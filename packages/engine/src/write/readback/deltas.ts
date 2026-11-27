import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import type { CheckedEntry } from "#compiler/analysis/schema.ts"
import type { RelationInfo } from "#compiler/ir/law.ts"
import type { DeltaSide } from "#compiler/ir/rel.ts"
import { columnIn } from "#compiler/lower/conservative/context.ts"
import type { Cte, Select, StatementText } from "#compiler/sql/ast.ts"
import { col, conjunction, cteRef, provedSelect, target } from "#compiler/sql/build.ts"
import { namedBody, type NameSupply } from "#compiler/sql/naming.ts"
import {
	type CarrierColumn,
	carrierStash,
	emptyStash,
	ridingStash,
	type RidingNames,
	type StashNames,
	stashedWidth,
	type WriteCarrier
} from "#compiler/write/carriers/carriers.ts"
import type { FamilyReturning } from "#compiler/write/family/written.ts"
import type {
	DeleteResult,
	InsertResult,
	ModifyingStatement,
	ReturnedSide
} from "#compiler/write/insert/statement.ts"
import type { PutStatement } from "#compiler/write/put/statement.ts"

/** The stored relation a Delta of `relation` names the delta of: its own, or a query entry's target (`entries`,
 * WriteFrontend.deltaEntries). */
export const deltaTarget = (entries: ReadonlyMap<string, CheckedEntry>, relation: string): string =>
	entries.get(relation)?.target.name ?? relation

/**
 * One side of a relation's delta as a read-back reads it: a CTE of the one statement that makes that side whole, over
 * the rows that statement returns, where the read-back rides that statement (`deltaCte`), each of the relation's fields
 * in heading order with the column that holds it; the carrier that statement fills from the same rows, where the
 * read-back runs after the last stratum (`carriedStash`), each field in its column; or the empty relation, where no
 * statement makes the side.
 *
 * Read-back deltas from the write statements' RETURNING channels.
 *
 * `delta.added(R)` is the RETURNING of R's write statements restricted to what they made present, `delta.removed(R)`
 * the RETURNING of R's deletions widened to the complete fact, the occupants a put displaced included, and
 * `delta.met(R)` the stored facts an insertion met at its arbiter key and did not refuse. A statement sees the snapshot
 * from before its own writes, and its RETURNING exists only inside it. A read-back whose sides one statement makes
 * whole, and whose state is settled there, is evaluated inside that statement, over its RETURNING, and its rows are
 * that statement's rows behind the read-back's tag (write/program/single.ts). Any other is evaluated after the last
 * stratum, and each side it reads is carried there: the statement making the side whole fills the side's carrier from
 * its RETURNING inside itself, so the rows the carrier holds are exactly the side's, and the read-back reads them with
 * the state the whole write leaves (write/schedule/plan.ts placeReadBacks). A side no one statement makes whole is
 * refused.
 *
 * A relation a read-back names but the ChangeSet never writes has an empty delta by construction, as has a world
 * relation whose definition reads nothing the ChangeSet writes (`NamedDelta` "empty"): a read-back reads it as the empty
 * relation, wherever it runs.
 */
export type DeltaHeld =
	| { readonly kind: "cte"; readonly cte: string; readonly heading: ReadonlyArray<CarrierColumn> }
	| { readonly kind: "carrier"; readonly carrier: WriteCarrier }
	| { readonly kind: "empty" }

/** A side of a delta a read-back reads outside the statement that makes it: the empty relation, where no statement
 * makes `side` of `name`'s delta, `made` holding the sides some statement makes; none for any other, whose rows only
 * the statement making them holds, or its carrier (`deltaAfter`). */
export const emptyDelta = (
	made: ReadonlyMap<string, ReadonlySet<DeltaSide>>,
	name: string,
	side: DeltaSide
): DeltaHeld | undefined => (made.get(name)?.has(side) === true ? undefined : { kind: "empty" })

/** A side of a delta a read-back after the last stratum reads: the empty relation, where no statement makes it
 * (`emptyDelta`); else the carrier the statement making it whole filled, `carried` holding every carried side's
 * (write/schedule/plan.ts WritePlan `carried`). */
export const deltaAfter = (
	made: ReadonlyMap<string, ReadonlySet<DeltaSide>>,
	carried: ReadonlyMap<string, ReadonlyMap<DeltaSide, WriteCarrier>>,
	name: string,
	side: DeltaSide
): DeltaHeld | undefined => {
	const carrier = carried.get(name)?.get(side)
	return carrier === undefined ? emptyDelta(made, name, side) : { kind: "carrier", carrier }
}

/** The CTE of one side of a relation's delta within the statement that writes it (`deltaCte`): its name, and each of
 * the relation's fields, in heading order, with the column that holds it. */
export interface DeltaCteName {
	readonly relation: RelationInfo
	readonly side: DeltaSide
	readonly cte: string
	readonly heading: ReadonlyArray<CarrierColumn>
}

/** The name of the CTE of `relation`'s delta on `side`, and its columns, from `supply`. A statement's two forms name it
 * alike, so a read-back riding the statement reads it by one name in either. */
export const deltaCteName = (
	relation: RelationInfo,
	side: DeltaSide,
	supply: NameSupply
): DeltaCteName => {
	const origin = { kind: "internal", purpose: `delta ${side} of ${relation.name}` } as const
	return {
		relation,
		side,
		cte: supply.relation(origin),
		heading: relation.heading.map((f) => ({
			name: f.name,
			type: f.type,
			column: supply.column(origin)
		}))
	}
}

/** The rows of `named`'s side `statement`'s RETURNING returns, none where it returns no rows of that side: an
 * insertion removes nothing and only an insertion meets stored facts it did not refuse (insert/protocol.ts
 * writesMet). */
const returnedSideOf = (
	statement:
		| ModifyingStatement<InsertResult | DeleteResult, StatementText>
		| PutStatement<StatementText>,
	side: DeltaSide
): ReturnedSide | undefined => {
	const returned = statement.returning
	switch (side) {
		case "added":
			return returned.kind === "removed" ? undefined : returned.added
		case "removed":
			return returned.kind === "removed" || returned.kind === "both" ? returned.removed : undefined
		case "met":
			return returned.kind === "insertion" ? returned.met : undefined
	}
}

/**
 * The CTE `named` of `statement`, the one statement that makes that side of its relation's delta, for the read-backs
 * riding that statement: the rows its RETURNING CTE returns of that side, restricted by the side's conditions, so it
 * holds exactly the facts the statement made present or absent, each of the relation's fields in heading order:
 *
 *   WITH ..., "r2" AS (INSERT ... RETURNING ...),
 *   "r9"("c20", "c21") AS (SELECT "r2"."c4", "r2"."c5" FROM "r2")
 *
 * Every column of a write statement's RETURNING is a stored column, so it has the relation's type exactly and the CTE
 * casts nothing. None where the statement returns no rows of that side, whose delta is the empty relation (`deltaIn`).
 */
export const deltaCte = (
	statement:
		| ModifyingStatement<InsertResult | DeleteResult, StatementText>
		| PutStatement<StatementText>,
	named: DeltaCteName
): Cte | undefined => {
	const returned = returnedSideOf(statement, named.side)
	if (returned === undefined) {
		return undefined
	}
	const byName = new Map(returned.columns.pairs.map((p) => [p.field.name, p.column] as const))
	const cte = statement.returning.cte
	return {
		name: named.cte,
		materialized: undefined,
		query: namedBody(
			provedSelect(
				"keyed",
				named.heading.map((c) => target(col(cte, columnIn(byName, c.name)))),
				[cteRef(cte)],
				conjunction(returned.conditions)
			),
			named.heading.map((c) => c.column)
		)
	}
}

/** What a read-back riding `statement` reads of the delta `named`: its CTE, or the empty relation where the statement
 * returns no rows of its side (`deltaCte`). */
export const deltaIn = (
	statement:
		| ModifyingStatement<InsertResult | DeleteResult, StatementText>
		| PutStatement<StatementText>,
	named: DeltaCteName
): DeltaHeld =>
	returnedSideOf(statement, named.side) === undefined
		? { kind: "empty" }
		: { kind: "cte", cte: named.cte, heading: named.heading }

/**
 * The fill of `carrier`, a carried side's (write/schedule/plan.ts CarriedSide), from the delta CTE `named` of the one
 * statement that makes that side whole, riding that statement as a part of no row (write/carriers/carriers.ts
 * ridingStash): every row of the side, each of the relation's fields in its column, which the carrier's heading holds in
 * heading order as `named` does, under `names` (`carriedNames`); no row where the statement returns none of the side:
 *
 *   SELECT FROM (SELECT pg_catalog.set_config('grizzle.__carrier_<k>_c1', COALESCE(pg_catalog.array_agg("r10"."c30"::
 *     uuid), '{}'::uuid[])::text, true) ... FROM (SELECT "r9"."c20", ... FROM "r9") AS "r10"("c30", ...)) AS "r11"("c31")
 *     OFFSET 1
 *
 * The statement reads it to its end once its writes have returned their rows, so the carrier holds exactly the side's
 * rows once the statement has run. Each column of the side is a stored column of the relation, cast to the carrier
 * column's session type, which every base type of a domain admits.
 */
export const carriedStash = (
	named: DeltaCteName | undefined,
	carrier: WriteCarrier,
	names: CarriedNames
): Select =>
	ridingStash(
		named === undefined
			? emptyStash(carrier)
			: carrierStash(
					carrier,
					provedSelect(
						"keyed",
						carrier.heading.map((c) => target(col(named.cte, deltaColumn(named, c.name)))),
						[cteRef(named.cte)],
						undefined
					),
					names
				),
		names
	)

/** The names a carried side's fill riding its statement defines (`carriedStash`). */
export type CarriedNames = StashNames & RidingNames

/** The names of `carrier`'s fill riding its statement, drawn from `supply`. */
export const carriedNames = (carrier: WriteCarrier, supply: NameSupply): CarriedNames => {
	const origin = { kind: "internal", purpose: "carried side" } as const
	return {
		alias: supply.relation(origin),
		columns: carrier.heading.map(() => supply.column(origin)),
		stash: supply.relation(origin),
		stashed: Array.from({ length: stashedWidth(carrier) }, () => supply.column(origin))
	}
}

/** The column of the delta CTE `named` that holds the relation field `field`. */
const deltaColumn = (named: DeltaCteName, field: string): string =>
	defined(
		named.heading.find((c) => c.name === field),
		`the field ${field} in the delta CTE ${named.cte}`
	).column

/**
 * The CTE `named`, the added side of a relation a family statement inserts, over the rows that insert's RETURNING
 * `returning` returns (write/family/written.ts FamilyReturning), each of the relation's fields in heading order: the
 * facts the statement made present, each column a stored column of the relation's type, so the CTE casts nothing.
 */
export const familyAddedCte = (returning: FamilyReturning, named: DeltaCteName): Cte => {
	const fields = returning.result.kind === "insert" ? returning.result.fields : []
	return {
		name: named.cte,
		materialized: undefined,
		query: namedBody(
			provedSelect(
				"keyed",
				named.heading.map((c) =>
					target(
						col(
							returning.cte,
							defined(
								returning.columns[fields.indexOf(c.name)],
								`the returned column of ${returning.relation}.${c.name}`
							).alias
						)
					)
				),
				[cteRef(returning.cte)],
				undefined
			),
			named.heading.map((c) => c.column)
		)
	}
}
