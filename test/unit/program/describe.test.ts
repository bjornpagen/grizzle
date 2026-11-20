import * as Result from "@bjornpagen/grizzle-text/base/result"
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { describeQuery, lowerQuery } from "#compiler/program/describe.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { schema } from "#compiler/public/schema.ts"
import { relationBuilder } from "#compiler/schema/relation.ts"
import { refused, succeeded } from "#test/support/assert.ts"
import { fromQueryDescription, queryFromDescription } from "#test/support/describe.ts"
import { Work } from "#test/support/fixtures/api/work.ts"
import { Id } from "#test/support/ids.ts"
import { buildRoot, buildSchema } from "#test/support/oracle/public/build.ts"
import {
	caseSketchGen,
	type ProgramFeature,
	programFeatures,
	programForms,
	resolveCase
} from "#test/support/oracle/public/generate.ts"
import { printCase } from "#test/support/oracle/public/print.ts"
import { named, sentForms, text } from "#test/unit/program/describe.fixtures.ts"

/** DescribeQuery, queryFromDescription and lowerQuery rebuild every generated query read as the same Description, which lowers to the same statements. Its budget is its suite's before it was a property (test/unit/program/describe.test.ts at 4ca3036a): 300 runs and 300 steered cases. */
export const describeQueryQueryFromDescriptionAndLowerQueryRebuildEveryGeneratedQueryReadAsTheSameDescriptionWhichLowersToTheSameStatements =
	property.explore(caseSketchGen, {
		needs: {},
		budget: { runs: 300, steered: 300 },
		situations: programForms satisfies ReadonlyArray<Reached<ProgramFeature>>,
		check: (_, k: Case<ProgramFeature>) => (sketch) =>
			Effect.sync(() => {
				const c = k.draw(resolveCase(sketch))
				const built = buildSchema(c.schema)
				for (const read of c.reads) {
					if (read.kind !== "query") {
						continue
					}
					const q = buildRoot(built, built.schema, read.query)
					const d = describeQuery(q)
					const lowered = succeeded(lowerQuery(q), `the generated query lowers\n${printCase(c)}`)
					for (const sent of sentForms(d)) {
						const rebuilt = succeeded(
							queryFromDescription(sent, built.schema),
							`the rebuild\n${printCase(c)}`
						)
						assert.equal(text(rebuilt), text(q))
						assert.deepEqual(lowerQuery(rebuilt), Result.ok(lowered))
					}
					/** A bare Description names no schema, so the compiler has none to lower it against. */
					const bare = succeeded(fromQueryDescription(d), "the Description read back")
					refused(lowerQuery(bare), "MalformedDescription", "lowered with no schema")
					for (const feature of programFeatures(read.query)) {
						if (Arr.some(programForms, (f) => f === feature)) {
							k.note(feature)
						}
					}
				}
			}),
		oracle: {
			kind: "universal",
			name: "queryFromDescription ∘ describeQuery = id, and lowering a function of the Description"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/program/describe.ts",
				original: "\treturn description.value",
				replacement:
					'\treturn JSON.parse(JSON.stringify(description.value).replaceAll(/"~n:-?[0-9]+"/g, \'"~n:0"\'))',
				why: "A Description spells every integer literal as 0."
			}
		]
	})

/** DescribeQuery, queryFromDescription and lowerQuery check a Description against the schema it is given. Its budget is its suite's before it was a property (test/unit/program/describe.test.ts at 4ca3036a): 20 runs and 20 steered cases. */
export const describeQueryQueryFromDescriptionAndLowerQueryCheckADescriptionAgainstTheSchemaItIsGiven =
	property.explore(named, {
		needs: {},
		budget: { runs: 20, steered: 20 },
		situations: ["elsewhere"] satisfies ReadonlyArray<Reached<"elsewhere">>,
		check: (_, k: Case<"elsewhere">) => (name) =>
			Effect.sync(() => {
				const Elsewhere = relationBuilder(name, { task: Id, budget: pg.bigint }, ["task"], [])
				const Elsewheres = schema("Elsewhere", [Elsewhere], [])
				const d = describeQuery(
					query(Elsewheres).rule((r) => {
						const { task, budget } = v(Elsewhere, "elsewhere")
						return r.match(Elsewhere, { task, budget }).find({ task, budget })
					})
				)
				succeeded(queryFromDescription(d, Elsewheres), "a schema with the relation")
				const e = refused(queryFromDescription(d, Work), "Refused", "a schema without the relation")
				assert.equal(
					e.reason._tag === "Refused" ? e.reason.refusal : undefined,
					"the relation is not in this query's schema"
				)
				k.note("elsewhere")
			}),
		oracle: {
			kind: "specification",
			name: "a Description is checked against the schema it is given: a relation it lacks is refused"
		},
		kept: [],
		kills: [
			{
				file: "packages/text/src/regex/print.ts",
				original:
					'return setText(dialect, atom.node.set)\n\t\t\t\tcase "anchor":\n\t\t\t\t\treturn dialect.anchors[atom.anchor]',
				replacement:
					'return dialect.anchors[atom.anchor]     case "anchor":      return setText(dialect, atom.node.set)',
				why: 'Operator mutant 72e8ee7434 at packages/text/src/regex/print.ts:204 in atomText: `return setText(dialect, atom.node.set)     case "anchor":      return dialect.anchors[atom.anchor]` becomes `return dialect.anchors[atom.anchor]     case "anchor":      return setText(dialect, atom.node.set)`; the property fails (the census, lane TESTPOLICY2).'
			}
		]
	})
