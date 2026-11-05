import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, Option, String as Str } from "effect"
import { collectInputs } from "#adapter/apply/collect.ts"
import { flight } from "#compiler/lower/conservative/types.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import type { FromSource } from "#compiler/sql/ast.ts"
import {
	arrays,
	col,
	columnDefinition,
	core,
	namedType,
	numericType,
	positionalValue,
	select,
	target,
	types
} from "#compiler/sql/build.ts"
import { printStatement } from "#compiler/sql/print.ts"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"
import { bindWrite } from "#compiler/write/program/bind.ts"
import { compileWrite } from "#compiler/write/program/compile.ts"
import { readArrayLiteral } from "#test/support/arrays.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { compileTemplate, realityWrite, testArtifacts, testCompile } from "#test/support/compile.ts"
import { largeStatements } from "#test/support/oracle/forms.ts"
import { checking } from "#test/support/policy.ts"
import { testTypeSchema } from "#test/support/sql.ts"
import { descOf, parsedOf } from "#test/unit/write/changeset/fixtures.ts"

/**
 * Relation inputs travel as arrays, one placeholder per column, whatever their size (lower/shapes/relparam): the
 * printed select-list form, the read and write lowerings that emit no jsonb recordset, and a ChangeSet input of
 * 250,000 facts bound with no refusal.
 */

/** Whether a statement text reads an input the way the arrays replaced. */
const readsJsonb = (sql: string): boolean =>
	Str.includes("jsonb_to_recordset")(sql) || Str.includes("jsonb_array_elements")(sql)

describe("a relation input's arrays", () => {
	it("print in the select-list form: a qualified unnest per column, text collated, typmods cast back", () => {
		const vectors = testTypeSchema("vector_ext")
		const kinds = testTypeSchema("work")
		const source: FromSource = arrays(
			{
				kind: "columns",
				columns: [
					{ definition: columnDefinition("c1", types.uuid), array: positionalValue(1) },
					{ definition: columnDefinition("c2", types.text), array: positionalValue(2) },
					{ definition: columnDefinition("c3", numericType(10, 2)), array: positionalValue(3) },
					{
						definition: columnDefinition("c4", namedType(vectors, "vector", [3])),
						array: positionalValue(4)
					},
					{
						definition: columnDefinition("c5", namedType(kinds, "kind", [])),
						array: positionalValue(5)
					}
				]
			},
			"r1"
		)
		assert.equal(
			printStatement(select(core([target(col("r1", "c1"))], [source], undefined))),
			'SELECT "r1"."c1"\n' +
				'FROM (SELECT "pg_catalog"."unnest"($1::"pg_catalog"."uuid"[]) AS "c1", ' +
				'"pg_catalog"."unnest"($2::"pg_catalog"."text"[] COLLATE "pg_catalog"."pg_c_utf8") AS "c2", ' +
				'"pg_catalog"."unnest"($3::numeric(10, 2)[])::numeric(10, 2) AS "c3", ' +
				'"pg_catalog"."unnest"($4::"vector_ext"."vector"(3)[])::"vector_ext"."vector"(3) AS "c4", ' +
				'"pg_catalog"."unnest"($5::"work"."kind"[]) AS "c5") AS "r1"'
		)
	})

	it("print an input of no column as the generated series of its count", () => {
		const source = arrays({ kind: "count", count: positionalValue(1) }, "r2")
		assert.equal(
			printStatement(select(core([target(col("r2", "r2"))], [source], undefined))),
			'SELECT "r2"."r2"\nFROM "pg_catalog"."generate_series"(1::bigint, $1::bigint) AS "r2"'
		)
	})
})

const Item = relation(
	"Item",
	{ id: pg.bigint, label: str.regex("^.*$", "su"), price: pg.numeric(10, 2), live: pg.boolean },
	["id"]
)
const Shop = schema("Shop", { Item }, [])

/** Reads of a relation parameter over Item, each carrying other columns: one, a text and a numeric(p, s) among two. */
const reads = {
	ids: query(Shop).rule((r) => {
		const asked = r.relation("asked", { id: pg.bigint })
		const { id } = v(Item, "item")
		return r.match(asked, { id }).match(Item, { id }).find({ id })
	}),
	labelled: query(Shop).rule((r) => {
		const asked = r.relation("asked", { id: pg.bigint, label: str.regex("^.*$", "su") })
		const { id, label } = v(Item, "item")
		return r.match(asked, { id, label }).match(Item, { id, label }).find({ id })
	}),
	priced: query(Shop).rule((r) => {
		const asked = r.relation("asked", {
			id: pg.bigint,
			label: str.regex("^.*$", "su"),
			price: pg.numeric(10, 2),
			live: pg.boolean
		})
		const { id, label, price, live } = v(Item, "item")
		return r
			.match(asked, { id, label, price, live })
			.match(Item, { id, label, price, live })
			.find({ id })
	})
} as const
const readWidths: Readonly<Record<keyof typeof reads, number>> = { ids: 1, labelled: 2, priced: 4 }

describe("a read's relation parameters", () => {
	it.effect(
		"lower to one array placeholder per column in both artifacts, and to no jsonb recordset",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/lower/relparam-arrays",
						literal: Formatter.format,
						generator: element(["ids", "labelled", "priced"] as const),
						limit: 3,
						coverage: requiredInSpace<keyof typeof reads>(["ids", "labelled", "priced"]),
						caseHang: Duration.minutes(2)
					},
					(read, c) =>
						Effect.sync(() => {
							const width = readWidths[read]
							const template = succeeded(compileTemplate(reads[read], Shop, testCompile))
							const optimized = flight(template.programs.optimized.roots)
							const statements = [
								...optimized,
								...largeStatements(optimized, (l) => l.statement),
								...flight(template.programs.conservative.roots)
							]
							const reading = Arr.filter(statements, (s) =>
								Arr.some(s.params, (slot) => slot.kind === "relation")
							)
							assert.ok(reading.length > 0, "a statement reads the relation parameter")
							for (const s of statements) {
								assert.ok(!readsJsonb(s.sql.text), s.sql.text)
								const slots = Arr.filter(s.params, (slot) => slot.kind === "relation")
								assert.equal(slots.length % width, 0, s.sql.text)
								for (const slot of slots) {
									assert.equal(slot.columns.length, width)
									assert.ok(
										Str.includes(`"pg_catalog"."unnest"($${slot.number}::`)(s.sql.text),
										`placeholder ${slot.number} is an unnest of an array: ${s.sql.text}`
									)
								}
							}
							c.note(read)
						})
				)
			)
	)
})

describe("a write's enumerated members", () => {
	const artifacts = succeeded(testArtifacts(Shop, testCompile))
	const program = (changes: unknown) =>
		succeeded(compileWrite(checking(Shop), descOf(changes), realityWrite(artifacts)))
	const fact = (i: number) => ({
		id: BigInt(i),
		label: `item "${i}", {a\\b}`,
		price: Decimal.of(`${i % 1000}.25`),
		live: i % 2 === 0
	})

	it.effect(
		"lower to arrays, never a jsonb recordset, and an input of 250,000 facts binds every statement with no refusal",
		() =>
			Effect.gen(function* () {
				const rows = Array.from({ length: 250_000 }, (_, i) => fact(i))
				const changes = ChangeSet.empty(Shop).insert(Item, rows)
				const compiled = program(changes)
				const members = yield* collectInputs(compiled.frontend, parsedOf(changes).inputs)
				const bound = succeeded(bindWrite(compiled, { members, params: {} }))
				assert.equal(bound.kind, "bound")
				if (bound.kind !== "bound") {
					return
				}
				const artifact = compiled.artifacts.optimized
				const skip = bound.skip(artifact)
				let arraysSent = 0
				for (const s of artifact.statements) {
					if (s.step.kind === "readBack" || skip.has(s.index)) {
						continue
					}
					const form = bound.form(s)
					assert.ok(!readsJsonb(form.sql), form.sql)
					const texts = succeeded(bound.values(s))
					assert.equal(texts.length, form.paramSlots.length)
					for (const [i, slot] of form.paramSlots.entries()) {
						if (slot.kind !== "member") {
							continue
						}
						arraysSent += 1
						const elements = readArrayLiteral(Option.getOrThrow(Arr.get(texts, i)))
						assert.equal(elements.length, 250_000, `placeholder ${i + 1} carries every fact`)
					}
				}
				assert.ok(arraysSent >= 4, `${arraysSent} member arrays sent`)
			}),
		{ timeout: 120_000 }
	)
})
