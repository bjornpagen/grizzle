import { describe, it } from "@effect/vitest"
import { Array as Arr, Record as Rec, String as Str } from "effect"
import type { CompileBound, CompileError } from "#compiler/core/errors.ts"
import { selectMaxEntries, statementMaxParams, tableMaxColumns } from "#compiler/core/limits.ts"
import { utf8Length } from "#compiler/core/sha256.ts"
import { pg, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import type { Expr } from "#compiler/sql/ast.ts"
import { eq, lit, or, param, simpleSelect, target, types } from "#compiler/sql/build.ts"
import { emit } from "#compiler/sql/emit.ts"
import { emptyNameMap } from "#compiler/sql/naming.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import { assert, refused, succeeded } from "#test/support/assert.ts"
import { compileTemplate, testArtifacts, testCompile } from "#test/support/compile.ts"

/**
 * PostgreSQL's limits where grizzle meets them (core/limits.ts), each a planted case on both sides of it:
 *
 * - a stored relation's table holds at most tableMaxColumns columns: a relation of that many fields is admitted when its
 *   schema is compiled, and one of a field more is refused there, as ResourceBound (tableColumns) naming the table;
 * - a select list holds at most selectMaxEntries entries, refused as ResourceBound (selectList) when it is printed;
 * - a statement binds at most statementMaxParams placeholders, refused as ResourceBound (statementParams) when it is
 *   printed;
 * - a statement's length is bounded by PostgreSQL's longest message, about a gigabyte, and by nothing smaller: a query
 *   whose statements are each over 2 MiB, which the compiler once refused by summing every artifact's text, compiles.
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
		{
			Wide: relation(
				"Wide",
				Rec.fromEntries(Arr.makeBy(columns, (i) => [`c${i}`, pg.integer] as const)),
				["c0"]
			)
		},
		[]
	)

/** SELECT of `entries` integer literals. */
const selectOf = (entries: number) =>
	simpleSelect(
		Arr.makeBy(entries, (i) => target(lit.int(i, types.integer))),
		[],
		undefined
	)

/** SELECT 1 WHERE $1 = 0 OR ... OR $n = 0: a statement of `params` placeholders. */
const placeholders = (params: number) =>
	simpleSelect(
		[target(lit.int(1, types.integer))],
		[],
		or(Arr.makeBy(params, (i): Expr => eq(param(i + 1, types.integer), lit.int(0, types.integer))))
	)

describe("PostgreSQL's limits", () => {
	it("admits a relation of tableMaxColumns fields when its schema is compiled, and refuses one of a field more there", () => {
		const widest = succeeded(
			testArtifacts(wideSchema(tableMaxColumns.value), testCompile),
			"the widest table"
		)
		assert.deepEqual(
			boundOf(
				refused(testArtifacts(wideSchema(tableMaxColumns.value + 1), testCompile), "ResourceBound")
			),
			{
				kind: "tableColumns",
				table: printObjectName(widest.names.relation("Wide")),
				limit: tableMaxColumns.value,
				needed: tableMaxColumns.value + 1
			}
		)
	})

	it("admits a select list of selectMaxEntries entries and refuses one of an entry more", () => {
		succeeded(emit(selectOf(selectMaxEntries.value), emptyNameMap), "the longest select list")
		assert.deepEqual(
			boundOf(refused(emit(selectOf(selectMaxEntries.value + 1), emptyNameMap), "ResourceBound")),
			{ kind: "selectList", limit: selectMaxEntries.value, needed: selectMaxEntries.value + 1 }
		)
	})

	it("admits a statement of statementMaxParams placeholders and refuses one of a placeholder more", () => {
		succeeded(emit(placeholders(statementMaxParams.value), emptyNameMap), "the most placeholders")
		assert.deepEqual(
			boundOf(
				refused(emit(placeholders(statementMaxParams.value + 1), emptyNameMap), "ResourceBound")
			),
			{
				kind: "statementParams",
				limit: statementMaxParams.value,
				needed: statementMaxParams.value + 1
			}
		)
	})

	it("compiles a query whose statements are each over 2 MiB", () => {
		const Note = relation("Note", { id: uuid, body: str.regex("^.*$", "su") }, ["id"])
		const Notes = schema("Notes", { Note }, [])
		const body = Str.repeat(2 * 1024 * 1024)("x")
		const matching = query(Notes).rule((r) => {
			const { id } = v(Note, "note")
			return r.match(Note, { id, body }).find({ id })
		})
		const template = succeeded(compileTemplate(matching, undefined, testCompile), "the template")
		const sizes = Arr.map(Arr.appendAll(template.optimized, template.conservative), (s) =>
			utf8Length(s.sql)
		)
		assert.ok(
			Arr.every(sizes, (bytes) => bytes > 2 * 1024 * 1024),
			`each statement holds the literal: ${Arr.join(Arr.map(sizes, String), ", ")} bytes`
		)
	})
})
