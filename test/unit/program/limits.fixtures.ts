import * as Engine from "@bjornpagen/grizzle-text/base/result"
import { assert } from "@bjornpagen/testing/assert"
import { characterOf, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, Record as Rec } from "effect"
import type { CompileBound, CompileError } from "#compiler/core/errors.ts"
import { installOptions } from "#compiler/physical/install/compile.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { pg } from "#compiler/public/fields.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import type { Expr } from "#compiler/sql/ast.ts"
import { eq, lit, or, param, provedSelect, target, types } from "#compiler/sql/build.ts"
import { emit } from "#compiler/sql/emit.ts"
import { emptyNameMap } from "#compiler/sql/naming.ts"
import { selectMaxEntries, statementMaxParams, printObjectName } from "#compiler/sql/print.ts"
import { tableMaxColumns } from "#compiler/write/carriers/carriers.ts"
import { succeeded } from "#test/support/assert.ts"
import { nonEmptyList } from "#test/support/oracle/pick.ts"
import { ownedInput } from "#test/support/policy.ts"
import { upTo } from "#test/support/up-to.ts"

/**
 * PostgreSQL's limits where grizzle meets them, each drawn on both sides of it:
 *
 * - a stored relation's table holds at most tableMaxColumns columns: a relation of that many fields is admitted when its
 *   installation is compiled, where its table is created, and one of a field more is refused there, as ResourceBound
 *   (tableColumns) naming the table;
 * - a select list holds at most selectMaxEntries entries, refused as ResourceBound (selectList) when it is printed;
 * - a statement binds at most statementMaxParams placeholders, refused as ResourceBound (statementParams) when it is
 *   printed;
 * - a statement's length is bounded by PostgreSQL's longest message, about a gigabyte, and by nothing smaller: a query
 *   whose literal is drawn up to a few MiB of UTF-8 compiles, each of its statements holding the literal whole.
 *
 * Oracle: each limit's published value, a specification. The first box is exhaustive: each limit met
 * by one less, by it and by one more.
 *
 * Features: each limit within, at and past; a short literal and one past 2 MiB.
 */

/** The bound of a ResourceBound refusal; any other refusal fails the test. */
export const boundOf = (error: CompileError): CompileBound => {
	const reason = error.reason
	assert.equal(reason._tag, "ResourceBound", error.message)
	if (reason._tag !== "ResourceBound") {
		throw new Error(error.message)
	}
	return reason.bound
}

/** A schema of one relation of `columns` integer fields, `c0` its key. */
const wideSchema = (columns: number) =>
	schema(
		"Wide",
		[
			relation("Wide", Rec.fromEntries(upTo(columns, (i) => [`c${i}`, pg.integer] as const)), [
				"c0"
			])
		],
		[]
	)

/** The installation of a schema of one relation of `columns` integer fields (`wideSchema`). */
const wideInstallation = (columns: number) =>
	Engine.flatMap(ownedInput(wideSchema(columns)), (owned) =>
		compileInstallation(owned, installOptions(owned))
	)

/** SELECT of `entries` integer literals. */
const selectOf = (entries: number) =>
	provedSelect(
		"oneRow",
		upTo(entries, (i) => target(lit.int(i, types.integer))),
		[],
		undefined
	)

/** SELECT 1 WHERE $1 = 0 OR ... OR $n = 0: a statement of `params` placeholders. */
const placeholders = (params: number) =>
	provedSelect(
		"oneRow",
		[target(lit.int(1, types.integer))],
		[],
		or(
			nonEmptyList(
				upTo(params, (i): Expr => eq(param(i + 1, types.integer), lit.int(0, types.integer))),
				"the parameters"
			)
		)
	)

/** The limits a compile meets: a table's columns, a select list's entries and a statement's placeholders. */
type Bounded = Extract<CompileBound["kind"], "tableColumns" | "selectList" | "statementParams">

/** Each limit, and what meeting `count` of what it bounds gives: the compile's result and the bound a refusal names. */
export const limits: {
	readonly [B in Bounded]: {
		readonly limit: number
		readonly compile: (count: number) => Engine.Result<unknown, CompileError>
		readonly bound: (count: number) => CompileBound
	}
} = {
	tableColumns: {
		limit: tableMaxColumns,
		compile: wideInstallation,
		bound: (count) => ({
			kind: "tableColumns",
			table: printObjectName(succeeded(wideInstallation(1), "one column").names.relation("Wide")),
			limit: tableMaxColumns,
			needed: count
		})
	},
	selectList: {
		limit: selectMaxEntries,
		compile: (count) => emit(selectOf(count), emptyNameMap),
		bound: (count) => ({ kind: "selectList", limit: selectMaxEntries, needed: count })
	},
	statementParams: {
		limit: statementMaxParams,
		compile: (count) => emit(placeholders(count), emptyNameMap),
		bound: (count) => ({ kind: "statementParams", limit: statementMaxParams, needed: count })
	}
}

export const boundedKinds: Arr.NonEmptyReadonlyArray<Bounded> = [
	"tableColumns",
	"selectList",
	"statementParams"
]

export type LimitFeature = `${Bounded} ${"within" | "at" | "past"}`

/** A text a literal is made of: ASCII and characters of two, three and four UTF-8 bytes. */
export const literalUnit: Gen<string> = characterOf(["x", "é", "€", "\u{1f600}"])

/** A literal's repetitions of its unit: a few KiB, or past 2 MiB of UTF-8 whatever the unit. */
export const repetitions: Gen<number> = weighted([
	[1, int(0, 4_096)],
	[1, int(2_100_000, 2_400_000)]
])

export type LengthFeature = "a short literal" | "a literal past 2 MiB"

export const twoMiB = 2 * 1024 * 1024
