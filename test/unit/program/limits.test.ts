import { describe, it } from "@effect/vitest"
import { exhaust, explore, sketched } from "@grizzle/testing/explore"
import { required, requiredInSpace } from "@grizzle/testing/features"
import { characterOf, element, type Gen, int, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Record as Rec, String as Str } from "effect"
import type { CompileBound, CompileError } from "#compiler/core/errors.ts"
import {
	type Limit,
	selectMaxEntries,
	statementMaxParams,
	tableMaxColumns
} from "#compiler/core/limits.ts"
import * as Engine from "#compiler/core/result.ts"
import { utf8Length } from "#compiler/core/sha256.ts"
import { compileInstallation, installOptions } from "#compiler/physical/install/compile.ts"
import { pg, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import type { Expr } from "#compiler/sql/ast.ts"
import { eq, lit, or, param, provedSelect, target, types } from "#compiler/sql/build.ts"
import { emit } from "#compiler/sql/emit.ts"
import { emptyNameMap } from "#compiler/sql/naming.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import { assert, refused, succeeded } from "#test/support/assert.ts"
import { compileTemplate, testCompile } from "#test/support/compile.ts"
import { caseHang } from "#test/support/limits.ts"
import { nonEmptyList } from "#test/support/oracle/pick.ts"
import { ownedInput } from "#test/support/policy.ts"
import { upTo } from "#test/support/up-to.ts"

/**
 * PostgreSQL's limits where grizzle meets them (core/limits.ts), each drawn on both sides of it:
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
 * Oracle: each limit's published value (core/limits.ts), a specification. The first box is exhaustive: each limit met
 * by one less, by it and by one more.
 *
 * Features: each limit within, at and past; a short literal and one past 2 MiB.
 *
 * Plants (~/.cache/grizzle-release/BR02/plants): limits-table-columns-off-by-one, limits-params-unbounded.
 */

/** The bound of a ResourceBound refusal; any other refusal fails the test. */
const boundOf = (error: CompileError): CompileBound => {
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
		compileInstallation(owned, installOptions(owned, "owner"))
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
const limits: {
	readonly [B in Bounded]: {
		readonly limit: Limit
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
			limit: tableMaxColumns.value,
			needed: count
		})
	},
	selectList: {
		limit: selectMaxEntries,
		compile: (count) => emit(selectOf(count), emptyNameMap),
		bound: (count) => ({ kind: "selectList", limit: selectMaxEntries.value, needed: count })
	},
	statementParams: {
		limit: statementMaxParams,
		compile: (count) => emit(placeholders(count), emptyNameMap),
		bound: (count) => ({ kind: "statementParams", limit: statementMaxParams.value, needed: count })
	}
}

const boundedKinds: Arr.NonEmptyReadonlyArray<Bounded> = [
	"tableColumns",
	"selectList",
	"statementParams"
]

type LimitFeature = `${Bounded} ${"within" | "at" | "past"}`

/** A text a literal is made of: ASCII and characters of two, three and four UTF-8 bytes. */
const literalUnit: Gen<string> = characterOf(["x", "é", "€", "\u{1f600}"])

/** A literal's repetitions of its unit: a few KiB, or past 2 MiB of UTF-8 whatever the unit. */
const repetitions: Gen<number> = weighted([
	[1, int(0, 4_096)],
	[1, int(2_100_000, 2_400_000)]
])

type LengthFeature = "a short literal" | "a literal past 2 MiB"

const twoMiB = 2 * 1024 * 1024

describe("PostgreSQL's limits", () => {
	it.effect(
		"admit what reaches each limit, and refuse one past it as ResourceBound naming the limit and the count",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/program/limits",
						generator: (source) =>
							[source.draw(element(boundedKinds)), source.draw(int(-1, 1))] as const,
						literal: Formatter.format,
						box: "each of tableMaxColumns, selectMaxEntries and statementMaxParams, met by one less, by it, and by one more",
						oracle: {
							kind: "specification",
							name: "each limit's published value: admitted up to it, refused past it with the count"
						},
						coverage: requiredInSpace<LimitFeature>(
							Arr.flatMap(boundedKinds, (kind): Arr.NonEmptyReadonlyArray<LimitFeature> => [
								`${kind} within`,
								`${kind} at`,
								`${kind} past`
							])
						),
						caseHang,
						concurrency: 1
					},
					([kind, offset], c) =>
						Effect.sync(() => {
							const { limit, compile, bound } = limits[kind]
							const count = limit.value + offset
							c.note(`${kind} ${offset < 0 ? "within" : offset === 0 ? "at" : "past"}`)
							const result = compile(count)
							if (count <= limit.value) {
								succeeded(result, `${count} under ${kind}`)
								return
							}
							assert.deepEqual(boundOf(refused(result, "ResourceBound")), bound(count))
						})
				)
			)
	)

	it.effect("compile a query whose literal is drawn past 2 MiB, each statement holding it", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/program/limits-statement-length",
					draw: sketched(
						(source) => [source.draw(literalUnit), source.draw(repetitions)] as const,
						([unit, times]) => Str.repeat(times)(unit)
					),
					literal: Formatter.format,
					oracle: {
						kind: "specification",
						name: "a statement's length is bounded by messageMaxBytes alone"
					},
					coverage: required<LengthFeature>(["a short literal", "a literal past 2 MiB"], {
						cases: 8,
						sense: notesOnly
					}),
					kept: [],
					runs: 4,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				(body, c) =>
					Effect.sync(() => {
						const Note = relation("Note", { id: uuid, body: str.regex("^.*$", "su") }, ["id"])
						const Notes = schema("Notes", [Note], [])
						const matching = query(Notes).rule((r) => {
							const { id } = v(Note, "note")
							return r.match(Note, { id, body }).find({ id })
						})
						const template = succeeded(
							compileTemplate(matching, undefined, testCompile),
							"the template"
						)
						const bytes = utf8Length(body)
						c.note(bytes > twoMiB ? "a literal past 2 MiB" : "a short literal")
						for (const s of Arr.appendAll(template.optimized, template.conservative)) {
							assert.ok(utf8Length(s.sql) > bytes, "each statement holds the literal")
						}
					})
			)
		)
	)
})
