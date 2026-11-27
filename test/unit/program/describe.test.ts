import * as Result from "@bjornpagen/grizzle-text/base/result"
import { assert } from "@bjornpagen/testing/assert"
import { word } from "@bjornpagen/testing/dictionary"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { describeQuery, lowerQuery } from "#compiler/program/describe.ts"
import { queryInput } from "#compiler/program/input.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { schema } from "#compiler/public/schema.ts"
import { relationBuilder } from "#compiler/schema/relation.ts"
import { refused, succeeded } from "#test/support/assert.ts"
import { CallKeys, type CallKind, cellQuery, pinnedCell } from "#test/support/call-sources.ts"
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
import { checkAuthored, checkedIn, checkOptions } from "#test/support/policy.ts"
import { callSourceBox } from "#test/unit/program/describe.dictionary.ts"
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

/** The call sources' schema, checked as a compile checks it. */
const callSourcesChecked = succeeded(checkedIn(CallKeys), "the call sources' schema checks")

/**
 * A query over each call a rule matches, its row's id pinned (test/support/call-sources.ts), described (describeQuery),
 * sent as JSON or not and read back, enters the compiler's described door (program/input.ts queryInput), is checked as
 * an author's Description (checkAuthored) and rebuilds (queryFromDescription) as its own Description. metis's kept
 * feedback is of the box, a cell's arm at its relation's whole key: the Description decoder held no case of an arm's
 * source, so a described query reading one was refused as malformed at the door (MalformedDescription at its source's
 * kind), where its built twin compiled. Every decoder of a tagged union is now held to its union's tags (ir/shape.ts
 * tagged), so a source kind without a case is a compile error.
 */
export const describeQueryReadsAQueryOfEveryCallSourceBackThroughTheDescribedDoorAsItsOwnDescription =
	property.exhaust(finite(word(callSourceBox)), {
		needs: {},
		box: "a row keyed by its id matched with each call at its fields, its id pinned: its cell's arm, its list's tokens, pieces, rest, path, target within its base and split at its last comma, a series of its ends, a declared function's rows and a field of a declared function's row",
		situations: [],
		check: () => (call: CallKind) =>
			Effect.sync(() => {
				const q = cellQuery(pinnedCell(call))
				const d = describeQuery(q)
				for (const sent of sentForms(d)) {
					const desc = succeeded(fromQueryDescription(sent), `${call}: its Description read back`)
					const door = succeeded(queryInput(desc), `${call}: the described door`)
					assert.equal(door.kind, "described")
					succeeded(
						checkAuthored(callSourcesChecked, desc, checkOptions("a call source")),
						`${call}: checked as an author's Description`
					)
					const rebuilt = succeeded(queryFromDescription(sent, CallKeys), `${call}: rebuilt`)
					assert.equal(text(rebuilt), text(q))
				}
			}),
		oracle: {
			kind: "universal",
			name: "queryFromDescription ∘ describeQuery = id over every call source, through the described door and an author's check"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/desc.ts",
				original:
					'\tarm: S.struct({\n\t\tvariant: S.ref("a field descriptor", () => fieldDescShape),\n\t\thandle: S.nonEmptyString,\n\t\tvalue: S.ref("an expression", () => exprDescShape)\n\t}),\n',
				replacement: "",
				why: "The Description decoder holds no case of an arm's source (ir/desc.ts sourceDescBody), a type error against SourceDesc's kinds, and at run time the described query over a cell's arm, metis's kept feedback, is refused as malformed at the described door."
			}
		]
	})
