/** What rule-data-step.test.ts reads: its space, its two versions and each case's migration. */

import { assert } from "@bjornpagen/testing/assert"
import { element, type Gen } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, String as Str } from "effect"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { sqlstates } from "#compiler/core/sqlstate.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { check, derived, mutable, relation, schema, unit } from "#compiler/public/schema.ts"
import { migrated } from "#test/support/installed.ts"
import { parsedName, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import type { Placeholder } from "#test/support/migrate/review.ts"
import { migrationRefusedLaws } from "#test/support/pg/migrate/support.ts"

/** The value the data step gives P's row 1: one Small keeps, under 10, and one it breaks. */
const values = [5, 99] as const

/** A case: the value a reviewer's data step of the second version's migration writes into P's row 1. */
export interface DataStep {
	readonly value: (typeof values)[number]
}

export const dataStepGen: Gen<DataStep> = (s) => ({ value: s.draw(element(values)) })

export type DataStepFeature =
	| "a data step that keeps the rule applied"
	| "a data step that breaks the rule refused at it"

/** P, mutable, and the rule over a query Small: every row's v is under 10, a check over Seen, a query of P's rows. */
const relationsOf = (withW: boolean) =>
	relation(
		"P",
		withW ? { id: pg.integer, v: pg.integer, w: pg.integer } : { id: pg.integer, v: pg.integer },
		["id"]
	)

const versionOf = (name: string, withW: boolean) => {
	const P = relationsOf(withW)
	const Base = schema(name, [P], [mutable(P), unit("Row", { id: pg.integer })])
	const Seen = derived(
		"Seen",
		query(Base).rule((r) => {
			const { id, v: value } = v(P, "p")
			return r.match(P, { id, v: value }).find({ id, v: value })
		})
	)
	return schema.extend([Base], `${name}_1`, [Seen], [check("Small", Seen, (s) => s.lt(s.v, 10))])
}

const namesOf = (declared: string) => {
	const schemaIdent = quoteIdent(identifierOf(identity.schema(parsedSchemaName(declared))))
	return {
		table: (r: string) =>
			`${schemaIdent}.${quoteIdent(identifierOf(identity.table(parsedName(r))))}`,
		column: (f: string) => quoteIdent(identifierOf(identity.column(parsedName(f))))
	}
}

/** The placeholder of w, which the second version adds to P's stored rows: 0. */
const wPlaceholder = (_: Placeholder): string => "0"

/**
 * One case: the first version installed with P's rows 1 and 2 of v 1 and 2, then the second migrated over them, its
 * Structure file holding, right after its SET CONSTRAINTS ALL IMMEDIATE (deploy/diff/diff.ts checkedAtOnce), which
 * precedes every data step, a reviewer's UPDATE of row 1's v to the case's value. One Small breaks is refused at that
 * statement of the Structure file by the judge, with Small's check_violation and law: P's capture writes its rows,
 * then the sentinel's row, whose trigger fires the judge at the end of that insert in the immediate transaction, after
 * the rows; written before them, the judge read none, and the full violation check of the Validate file refused the
 * rows instead. One Small keeps is applied.
 */
export const runDataStep = (d: DataStep, c: Case<DataStepFeature>) =>
	Effect.gen(function* () {
		const state = { declared: "" }
		const edit = (version: number, file: { readonly name: string; readonly text: string }) => {
			if (version !== 1 || !Str.endsWith("-structure.sql")(file.name)) {
				return file.text
			}
			const { table, column } = namesOf(state.declared)
			const marker = "SET CONSTRAINTS ALL IMMEDIATE;"
			const [head, ...tail] = Str.split(marker)(file.text)
			if (tail.length !== 1) {
				throw new Error(
					"the second version's Structure file sets its constraints immediate once, before its data steps"
				)
			}
			return Arr.join(
				[
					head,
					marker,
					`\n\nUPDATE ${table("P")} SET ${column("v")} = ${d.value} WHERE ${column("id")} = 1;`,
					...tail
				],
				""
			)
		}
		const outcome = yield* Effect.result(
			migrated({
				label: "rule_data_step",
				schemaName: { kind: "unique" },
				first: (name) => {
					state.declared = name
					return { schema: versionOf(name, false), logins: [] }
				},
				later: [(name) => ({ schema: versionOf(name, true), logins: [] })],
				apply: { kind: "reviewed", value: wPlaceholder, edit },
				declared: () => noDeclarations,
				observe: Option.some((version: number, owner) =>
					version === 0
						? Effect.gen(function* () {
								const { table, column } = namesOf(state.declared)
								yield* owner.query("BEGIN ISOLATION LEVEL SERIALIZABLE", [])
								yield* owner.query(
									`INSERT INTO ${table("P")} (${column("id")}, ${column("v")}) VALUES (1, 1), (2, 2)`,
									[]
								)
								yield* owner.query("COMMIT", [])
							})
						: Effect.void
				)
			})
		)
		if (d.value < 10) {
			assert.ok(
				outcome._tag === "Success",
				`a data step that keeps Small is applied: ${outcome._tag === "Failure" ? outcome.failure.message : ""}`
			)
			c.note("a data step that keeps the rule applied")
			return
		}
		if (outcome._tag !== "Failure" || outcome.failure._tag !== "MigrateError") {
			return assert.fail("a data step that breaks Small fails its migration")
		}
		const failure = outcome.failure
		const reason = failure.reason
		assert.ok(
			reason._tag === "StatementFailed" &&
				Str.endsWith("-structure.sql")(reason.file) &&
				reason.failure._tag === "ServerError" &&
				reason.failure.sqlstate === sqlstates.checkViolation,
			`a data step that breaks Small is refused at its statement of the Structure file by check_violation, the judge's: ${failure.message}`
		)
		assert.ok(
			Arr.some(migrationRefusedLaws(failure), (law) => Str.includes("small")(law)),
			`the refusal names Small's law: ${failure.message}`
		)
		c.note("a data step that breaks the rule refused at it")
	})
