import { utf8Length } from "@bjornpagen/grizzle-text/utf8"
import { type Reached } from "@bjornpagen/testing/features"
import { element, finite, int } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, String as Str } from "effect"

import { assert } from "@bjornpagen/testing/assert"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { refused, succeeded } from "#test/support/assert.ts"
import { compileTemplate, testCompile } from "#test/support/compile.ts"
import { Id } from "#test/support/ids.ts"
import {
	boundedKinds,
	boundOf,
	type LengthFeature,
	type LimitFeature,
	limits,
	literalUnit,
	repetitions,
	twoMiB
} from "#test/unit/program/limits.fixtures.ts"

/** PostgreSQL's limits admit what reaches each limit, and refuse one past it as ResourceBound naming the limit and the count. */
export const postgreSQLsLimitsAdmitWhatReachesEachLimitAndRefuseOnePastItAsResourceBoundNamingTheLimitAndTheCount =
	property.exhaust(
		finite((source) => [source.draw(element(boundedKinds)), source.draw(int(-1, 1))] as const),
		{
			needs: {},
			situations: Arr.flatMap(boundedKinds, (kind): Arr.NonEmptyReadonlyArray<LimitFeature> => [
				`${kind} within`,
				`${kind} at`,
				`${kind} past`
			]) satisfies ReadonlyArray<Reached<LimitFeature>>,
			check:
				(_, c: Case<LimitFeature>) =>
				([kind, offset]) =>
					Effect.sync(() => {
						const { limit, compile, bound } = limits[kind]
						const count = limit + offset
						c.note(`${kind} ${offset < 0 ? "within" : offset === 0 ? "at" : "past"}`)
						const result = compile(count)
						if (count <= limit) {
							succeeded(result, `${count} under ${kind}`)
							return
						}
						assert.deepEqual(boundOf(refused(result, "ResourceBound")), bound(count))
					}),
			oracle: {
				kind: "specification",
				name: "each limit's published value: admitted up to it, refused past it with the count"
			},
			box: "each of tableMaxColumns, selectMaxEntries and statementMaxParams, met by one less, by it, and by one more",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/physical/ddl/context.ts",
					original: "\t\tif (needed > tableMaxColumns) {",
					replacement: "\t\tif (needed > tableMaxColumns + 1) {",
					why: "A table of one column past tableMaxColumns is admitted."
				},
				{
					file: "packages/engine/src/sql/print.ts",
					original: "\tif (params > statementMaxParams) {",
					replacement: "\tif (params > Number.MAX_SAFE_INTEGER) {",
					why: "A statement's placeholders are bounded by nothing, so one past statementMaxParams prints."
				}
			]
		}
	)

/** PostgreSQL's limits compile a query whose literal is drawn past 2 MiB, each statement holding it. Its budget is its suite's before it was a property (test/unit/program/limits.test.ts at 4ca3036a): 4 runs and 8 steered cases. */
export const postgreSQLsLimitsCompileAQueryWhoseLiteralIsDrawnPast2MiBEachStatementHoldingIt =
	property.explore((source) => [source.draw(literalUnit), source.draw(repetitions)] as const, {
		needs: {},
		budget: { runs: 4, steered: 8 },
		situations: ["a short literal", "a literal past 2 MiB"] satisfies ReadonlyArray<
			Reached<LengthFeature>
		>,
		check: (_, c: Case<LengthFeature>) => (sketch) =>
			Effect.gen(function* () {
				const body = (([unit, times]) => Str.repeat(times)(unit))(sketch)
				return yield* Effect.sync(() => {
					const Note = relation("Note", { id: Id, body: str.regex("^.*$", "su") }, ["id"])
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
			}),
		oracle: {
			kind: "specification",
			name: "a statement's length is bounded by messageMaxBytes alone"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/registry.ts",
				original:
					'(typeof value === "object" || typeof value === "function") && value !== null && owned.has(value)',
				replacement: '(typeof value === "object" || typeof value === "function") && value !== null',
				why: 'Operator mutant 6c8a36999c at packages/engine/src/scalar/registry.ts:260 in isOwnedDescriptor: `(typeof value === "object" || typeof value === "function") && value !== null && owned.has(value)` becomes `(typeof value === "object" || typeof value === "function") && value !== null`; the property fails (the census, lane TESTPOLICY2).'
			}
		]
	})
