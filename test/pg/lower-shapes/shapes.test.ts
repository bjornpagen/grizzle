import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, type Gen, int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, pipe, Record as Rec, String as Str } from "effect"
import { resultTextCasts } from "#compiler/codec/scalar.ts"
import { indices } from "#compiler/core/array.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { codecOf, codeOf } from "#compiler/ir/codes.ts"
import type { Heading, HeadingColumn, RelNode, ValidDag } from "#compiler/ir/rel.ts"
import { baseOf } from "#compiler/ir/scalar.ts"
import { lowerConservative } from "#compiler/lower/conservative/index.ts"
import {
	conservativeInput,
	type ConservativeParamSlot,
	type ConservativeProgram,
	flight,
	statementOutput
} from "#compiler/lower/conservative/types.ts"
import { defined, unorderedEqual } from "#test/support/assert.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import { fixtureGroup, type ResetGroup, replaceRows } from "#test/support/substrate/replace.ts"
import { freshSchema, Substrate } from "#test/support/substrate/substrate.ts"
import { relations, Task, uuidOf } from "#test/unit/lower/conservative/fixtures.ts"
import * as Cases from "#test/unit/lower/conservative/queries.ts"
import { type ConditionalForm, conditional } from "#test/unit/lower/shapes/queries.ts"

import { jsonText } from "#compiler/core/trusted.ts"
import { caseHang } from "#test/support/limits.ts"
import { shapedFacts, shapedProgram, testOptions } from "#test/unit/lower/shapes/support.ts"

/**
 * The lowering shapes on PostgreSQL 19 (packages/engine/src/lower/shapes), where no generator reaches them yet.
 *
 * The ledger fixture installs under a fresh schema, and the conditional aggregate's count(*) FILTER and CASE sum
 * (R24.conditionalCount) are checked against the conservative lowering, the oracle baseline that deduplicates at every
 * set boundary, by raw text row sets and with no repeated row, over generated groups where no binding, some and every
 * binding satisfies the predicate, the case a filtered sum gets wrong.
 *
 * Every other shape is the generated suites': the per-group takes, heading groups and the VALUES transport the
 * optimized differential's (test/pg/oracle/optimized), and the fused and pipelined attachments, spellings and
 * array_out quoting the public-boundary differential's (test/pg/oracle/public), decoded as an application reads them.
 * That the oracle tells a shape resting on an unsound fact from a sound one is the optimized differential's mutant
 * populations (test/pg/oracle/optimized/counterexamples.ts): each invalid rewrite is killed on its population.
 */

/** The fixture's physical names, its codebook among them: the names the lowerings under test emit. */
const namesOf = (schema: string) => testOptions(schema).names

/** A roster's domain in the fixture's schema, quoted: what a closed id's column and literal are typed by. */
const rosterDomainSql = (schema: string, roster: string): string => {
	const domain = namesOf(schema).rosterDomain(parsedName(roster))
	return `"${domain.schema}"."${domain.name}"`
}

const sqlType = (schema: string, c: HeadingColumn): string => {
	switch (c.type.carrier) {
		case "uuid":
			return "uuid"
		case "date":
			return "date"
		case "int4":
			return "integer"
		case "int8":
			return "bigint"
		case "float8":
			return "double precision"
		case "numeric":
			return "numeric"
		case "money":
			return "money"
		case "bool":
			return "boolean"
		case "text":
			return "text COLLATE pg_catalog.pg_c_utf8"
		case "code":
			return rosterDomainSql(schema, c.type.roster.closed)
		case "float4":
		case "int2":
		case "range4":
		case "range8":
		case "vector":
		case "bits":
		case "exactInteger":
		case "exactMoney":
			throw new Error(`no fixture column type for ${c.type.carrier}`)
	}
}

const quote = (value: string): string => `'${Str.replaceAll("'", "''")(value)}'`

/** A fixture fact's value as a typed literal: a closed id's handle as its code under the fixture's codebook. */
const literalOf = (schema: string, c: HeadingColumn, value: string): string =>
	c.type.carrier === "code"
		? `${codeOf(codecOf(namesOf(schema).codes, c.type.roster), value)}::smallint::${sqlType(schema, c)}`
		: `${quote(value)}::${pipe(sqlType(schema, c), Str.replace(" COLLATE pg_catalog.pg_c_utf8", ""))}`

type Relation = (typeof relations)[number]

const tableOf = (schema: string, r: Relation): string =>
	`"${schema}"."${identifierOf(identity.table(parsedName(r.name)))}"`

/** The INSERT of a relation's fixture facts (Cases.facts), none when it has none. */
const factInserts = (schema: string, r: Relation): ReadonlyArray<string> => {
	const rows = Arr.map(
		Cases.facts[r.name] ?? [],
		(row) =>
			`(${Arr.join(
				Arr.map(row, (v, i) => literalOf(schema, defined(r.heading[i], "column"), v)),
				", "
			)})`
	)
	return rows.length === 0
		? []
		: [`INSERT INTO ${tableOf(schema, r)} VALUES ${Arr.join(rows, ", ")}`]
}

/** Every table the fixture creates in `schema`, which a reset truncates together (substrate/replace.ts). */
const fixtureTables = (schema: string): ResetGroup =>
	fixtureGroup(Arr.map(relations, (r) => tableOf(schema, r)))

const install = (schema: string): ReadonlyArray<string> => [
	`CREATE DOMAIN ${rosterDomainSql(schema, "Kind")} AS smallint`,
	...Arr.flatMap(relations, (r) => {
		const columns = Arr.map(
			r.heading,
			(c) => `"${identifierOf(identity.column(parsedName(c.name)))}" ${sqlType(schema, c)} NOT NULL`
		)
		const pk = Arr.join(
			Arr.map(r.primaryKey, (k) => `"${identifierOf(identity.column(parsedName(k)))}"`),
			", "
		)
		return [
			`CREATE TABLE ${tableOf(schema, r)} (${Arr.join(columns, ", ")}, PRIMARY KEY (${pk}))`,
			...factInserts(schema, r)
		]
	})
]

type Params = Readonly<Record<string, string | ReadonlyArray<Readonly<Record<string, string>>>>>

interface Ran {
	/** Each row as record text, and its columns as text. */
	readonly text: ReadonlyArray<string>
	readonly columns: ReadonlyArray<ReadonlyArray<string>>
}

/**
 * Runs one SQL text whose output has `width` columns, or the columns of a heading, every column read back as its
 * exact text, money through numeric as the outermost SELECT casts it (codec resultTextCasts). A numeric column of a
 * heading is read as its value, through trim_scale: a value is only its value, and the display scale PostgreSQL
 * computes for a sum or a cast is none of it; the row's text is then the row of those column texts.
 */
const runText = (text: string, width: number | Heading, params: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		const { admin } = yield* Substrate
		const count = typeof width === "number" ? width : width.length
		const names = Arr.map(indices(count), (i) => `"p${i}"`)
		const column = (n: string, i: number): string => {
			if (typeof width === "number") {
				return `t.${n}::text`
			}
			const type = defined(width[i], "column").type
			return Arr.reduce(
				resultTextCasts(type),
				baseOf(type).carrier === "numeric" ? `pg_catalog.trim_scale(t.${n})` : `t.${n}`,
				(e, cast) => `(${e})::${cast}`
			)
		}
		const columns = Arr.map(names, column)
		const row = typeof width === "number" ? "t::text" : `ROW(${Arr.join(columns, ", ")})::text`
		const wrapped = `SELECT ${row}, ${Arr.join(columns, ", ")} FROM (${text}) AS t(${Arr.join(names, ", ")})`
		const rows = yield* admin.queryValues(wrapped, params)
		return {
			text: Arr.map(rows, (r) => String(r[0])),
			columns: Arr.map(rows, (r) => Arr.map(r.slice(1), (v) => String(v)))
		} satisfies Ran
	})

const slotValue = (params: Params, slot: ConservativeParamSlot): string => {
	switch (slot.kind) {
		case "scalar": {
			const value = params[slot.param]
			if (typeof value !== "string") {
				throw new Error(`no scalar value for ${slot.param}`)
			}
			return value
		}
		case "relation": {
			const value = params[slot.param]
			if (value === undefined || typeof value === "string") {
				throw new Error(`no relation value for ${slot.param}`)
			}
			/**
			 * The host codec deduplicates complete facts before encoding (codec/recordset.ts), which is what
			 * lets the statement read the recordset without a DISTINCT; the fixture facts are already canonical text.
			 */
			const rows = Arr.map(value, (row) =>
				jsonText(
					Rec.fromEntries(
						Arr.map(slot.columns, (c) => [
							c.definition.name,
							defined(row[c.name], `the fact's ${c.name}`)
						])
					)
				)
			)
			return `[${Arr.join([...new Set(rows)], ",")}]`
		}
		case "member":
		case "page":
			throw new Error(
				`a query statement's placeholder is a declared parameter, not a ${slot.kind} placeholder`
			)
	}
}

const runProgram = (program: ConservativeProgram, params: Params) =>
	Effect.gen(function* () {
		const ran: Array<Ran> = []
		for (const statement of flight(program.roots)) {
			const values = Arr.map(statement.params, (slot) => slotValue(params, slot))
			const text = yield* runText(
				statement.sql.text,
				statementOutput(statement.role, statement.heading, []).heading,
				values
			)
			ran.push(text)
		}
		return ran
	})

const conservative = (
	query: { readonly dag: ValidDag; readonly root: RelNode },
	schema: string
) => {
	const r = lowerConservative(query, testOptions(schema))
	if (!r.ok) {
		throw new Error(r.error.message)
	}
	return r.value
}

/**
 * The Task facts an R24 case installs, each a binding of one of three accounts with an amount from a small range, and
 * the threshold its predicate compares the amount with: small enough ranges that a group none, some or all of whose
 * bindings qualify each meets most cases.
 */
interface ConditionalCase {
	readonly tasks: ReadonlyArray<readonly [account: number, amount: number]>
	readonly threshold: number
}

const accounts = [Cases.A, Cases.B, Cases.C] as const

const conditionalCaseGen: Gen<ConditionalCase> = (source) => ({
	tasks: source.draw(
		array((task) => [task.draw(int(0, 2)), task.draw(int(0, 60))] as const, { min: 0, max: 9 })
	),
	threshold: source.draw(int(-1, 61))
})

/** What a delivered group met: none, some or all of its bindings satisfying the predicate. */
type Qualifying = "none qualify" | "some qualify" | "all qualify"

const qualifying = (passed: number, bindings: number): Qualifying =>
	passed === 0 ? "none qualify" : passed === bindings ? "all qualify" : "some qualify"

layer(Substrate.layer)("the lowering shapes on PostgreSQL 19", (it) => {
	const installed = Effect.gen(function* () {
		const s = yield* Substrate
		const schema = yield* s.schema(freshSchema)
		for (const statement of install(schema)) {
			yield* s.admin.query(statement, [])
		}
		return schema
	})

	it.effect(
		"R24: the conditional count and sum agree with the composition on generated groups none, some or all of whose bindings qualify",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const schema = yield* installed
					const { admin } = yield* Substrate
					const task = tableOf(schema, Task)
					const forms: ReadonlyArray<ConditionalForm> = [
						"int4",
						"int8",
						"numeric",
						"numeric5.2",
						"term"
					]
					const others = Arr.filter(relations, (r) => r !== Task)
					const otherInserts = Arr.flatMap(others, (r) => factInserts(schema, r))
					return yield* explore(
						{
							suite: "pg/lower-shapes/conditional",
							draw: drawn(conditionalCaseGen),
							literal: Formatter.format,
							coverage: required<Qualifying>(["none qualify", "some qualify", "all qualify"], {
								cases: 60,
								sense: notesOnly
							}),
							kept: [],
							runs: 60,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						(c, k) =>
							Effect.gen(function* () {
								yield* replaceRows(admin, fixtureTables(schema), [
									...Arr.map(otherInserts, (sql) => ({ sql, params: [] })),
									...(c.tasks.length === 0
										? []
										: [
												{
													sql: `INSERT INTO ${task} VALUES ${Arr.join(
														Arr.map(
															c.tasks,
															([account, amount], i) =>
																`(${Arr.join(
																	Arr.map(
																		[
																			uuidOf(0x2000 + i),
																			defined(accounts[account], "an account"),
																			"Automatic",
																			String(amount)
																		],
																		(value, j) =>
																			literalOf(
																				schema,
																				defined(Task.heading[j], "a Task column"),
																				value
																			)
																	),
																	", "
																)})`
														),
														", "
													)}`,
													params: []
												}
											])
								])
								for (const form of forms) {
									const built = conditional(form, c.threshold)
									const query = conservativeInput(built)
									const composed = yield* runProgram(conservative(query, schema), {})
									const base = defined(composed[0], "the composition's statement")
									const { facts } = shapedFacts(built.dag, {}, "placement")
									const shapedRuns = yield* runProgram(
										shapedProgram(query, facts, testOptions(schema)),
										{}
									)
									const shaped = defined(shapedRuns[0], "the shaped statement")
									unorderedEqual(shaped.text, base.text, `${form} > ${c.threshold}`)
									if (form === "int4") {
										for (const [account, passed] of base.columns) {
											k.note(
												qualifying(
													Number(passed),
													Arr.filter(c.tasks, ([a]) => accounts[a] === account).length
												)
											)
										}
									}
								}
							})
					)
				})
			)
	)
})
