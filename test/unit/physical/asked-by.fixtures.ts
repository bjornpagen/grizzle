/** What asked-by.test.ts reads: its box, its cases, and the refusal generate meets drafting its login. */

import { defined } from "@bjornpagen/testing/assert"
import { element, type FiniteSpace, finite, subarray } from "@bjornpagen/testing/gen"
import { Array as Arr, Cause, Effect, Exit, Formatter, Record as Rec } from "effect"
import { compileSchema, resolveConfig } from "#cli/config.ts"
import { draftSchema } from "#cli/generate.ts"
import { silentPhases } from "#compiler/core/phase.ts"
import { emptySnapshot } from "#compiler/deploy/snapshot/build.ts"
import { workload } from "#compiler/program/workload/value.ts"
import { int4 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { login, relation, role, schema, wholeEntriesOf } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { defineConfig } from "#index.ts"
import { repoRoot } from "#test/support/files.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import { offlineOwner } from "#test/support/pg/cli/support.ts"

/** A note keyed by its id, with a text of no byte bound, which no B-tree entry holds and the relation declares no digest of. */
const Note = relation("Note", { id: int4, text: str.regex("^.+$", "su") }, ["id"])

const Base = schema("AskedBox", [Note], [])

/**
 * The box's reads: two that bind the note's text by equality alone, each a lookup no index finds its rows by, which the
 * installation refuses as UnrepresentableKey; and one that binds its id, its key.
 */
const reads = {
	byText: query(Base).rule((r) => {
		const { id } = v(Note, "note")
		return r.match(Note, { id, text: r.param("text", Note.fields.text) }).find({ id })
	}),
	alsoByText: query(Base).rule((r) => {
		const { id } = v(Note, "other")
		return r.match(Note, { id, text: r.param("text", Note.fields.text) }).find({ id })
	}),
	byId: query(Base).rule((r) => {
		const { text } = v(Note, "keyed")
		return r.match(Note, { id: r.param("id", int4), text }).find({ text })
	})
} as const

export type ReadName = keyof typeof reads

const readNames = ["alsoByText", "byId", "byText"] as const satisfies ReadonlyArray<ReadName>

/** The reads binding the note's text alone, whose request the installation refuses. */
export const textReads: ReadonlySet<ReadName> = new Set(["alsoByText", "byText"])

/** A case: the reads its login serves, one at least. */
export type Case = Arr.NonEmptyReadonlyArray<ReadName>

export const caseGen: FiniteSpace<Case> = finite((source) => {
	const first = source.draw(element(readNames))
	return [first, ...Arr.filter(source.draw(subarray(readNames)), (n) => n !== first)]
})

const file = `${repoRoot}app/grizzle.config.ts`

/** The refusal generate meets drafting the login `app` serving the case's reads, none where it drafts them. */
export const refusalOf = (c: Case) =>
	Effect.gen(function* () {
		const reader = role(Base, "reader", wholeEntriesOf(Base), {})
		const app = login(Base, "app", [reader], {
			workload: [
				workload(Base, Rec.fromEntries(Arr.map(c, (name) => [name, reads[name]] as const)))
			]
		})
		const config = yield* resolveConfig(
			defineConfig({
				schemas: [Base],
				logins: [app],
				migrations: "migrations",
				rolePrefixBytes: 0,
				connection: () => offlineOwner
			}),
			file
		)
		const configured = defined(config.schemas[0], "the configured schema")
		const exit = yield* Effect.exit(
			Effect.gen(function* () {
				const compiled = yield* Effect.fromResult(compileSchema(configured))
				return yield* draftSchema(
					compiled,
					emptySnapshot({ schemaName: configured.declared, schema: configured.ident }),
					[],
					noDeclarations,
					silentPhases
				)
			})
		)
		return Exit.isFailure(exit) ? Formatter.format(Cause.squash(exit.cause)) : undefined
	})
