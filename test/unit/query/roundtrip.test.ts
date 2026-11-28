/**
 * A Description rebuilds the same query: a query value rebuilt from its QueryDesc records the same Description,
 * carries the same heading and supports the same combinators; and the builder's output is deterministic, valid,
 * canonical and stable over generated queries.
 *
 * - Generated chains (arms over the worked example's schema and over the span example's, then a chain of rules, named
 *   stages, attachments, takes and imports, then a set or ordered ending): the Description decodes, is canonical, is
 *   built alike twice, rebuilds to the same text through the Description and through a QueryDescription carried as
 *   JSON, keeps its heading's names, and a prefix rebuilt and resumed is the whole chain. Oracle: the round trip, a
 *   universal law, and the builder run twice.
 * - Attachments: a rebuilt query keeps its attachment names, refusing what the original refuses. Oracle: the original,
 *   a differential.
 * - A rebuilt recursive row is typed under the schema's rosters as the original was: a literal against its handle is
 *   checked against the roster. Oracle: the original, and the roster's own handles.
 *
 * Features: each op of a chain and each ending, a chain cut inside; a roster handle and a text that is none.
 */

import * as Result from "@bjornpagen/grizzle-text/base/result"
import { assert, nonEmpty } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { codePoint, element, finite, string, weighted } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { catchCompileError } from "#compiler/core/canonical.ts"
import type { CompileReasonTag } from "#compiler/core/errors.ts"
import { queryState } from "#compiler/query/build/state.ts"
import { Work } from "#test/support/fixtures/api/work.ts"
import { descOf } from "#test/support/unit/query/fixtures.ts"
import {
	type Attached,
	attachedQuery,
	back,
	type ChainFeature,
	chainFeatures,
	chainRoundTrip,
	generatedChains,
	type Handle,
	handles,
	matchingKind,
	names,
	operate,
	type Operation,
	original,
	rebuiltQuery,
	spans,
	work
} from "#test/unit/query/roundtrip.fixtures.ts"

/** Rebuilding from a Description keeps the attachment names of a rebuilt query, refusing what the original refuses. */
export const rebuildingFromADescriptionKeepsTheAttachmentNamesOfARebuiltQueryRefusingWhatTheOriginalRefuses =
	property.exhaust(
		finite(
			(source) =>
				[
					source.draw(element<Attached>(["an attach stage", "an arm's attach"])),
					source.draw(
						element<Operation>([
							"attach the name again",
							"attach another name",
							"order by the attachment"
						])
					)
				] as const
		),
		{
			needs: {},
			situations: [],
			check:
				() =>
				([from, operation]) =>
					Effect.sync(() => {
						const original = attachedQuery(from)
						const back = rebuiltQuery(descOf(original), Work)
						assert.deepEqual(names(back), names(original))
						/** An attachment's name is a field of the result: attached again or ordered by, it is refused. */
						const refusal: CompileReasonTag = "MalformedDescription"
						const expected = operation === "attach another name" ? "built" : refusal
						const outcome = (f: () => unknown): CompileReasonTag | "built" => {
							const r = catchCompileError(f)
							return r.ok ? "built" : r.error.reason._tag
						}
						assert.equal(outcome(operate(original, operation)), expected, `${from}: ${operation}`)
						assert.equal(
							outcome(operate(back, operation)),
							expected,
							`${from}, rebuilt: ${operation}`
						)
					}),
			oracle: {
				kind: "second-implementation",
				name: "the original query, before the round trip"
			},
			box: "both ways to attach, under each operation on the attachment's name",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/query/build/state.ts",
					original:
						"\t\t\treturn withAttachment(stageHeading(stage.input, env), stage.attach.name)",
					replacement: "\t\t\treturn stageHeading(stage.input, env)",
					why: "A heading rebuilt from an attach stage without its attachment's name; the attachments search and both generated-chain searches fail."
				}
			]
		}
	)

/**
 * Rebuilding from a Description types a rebuilt recursive row under the schema's rosters, as the original was typed.
 *
 * Budget: 60 runs and 60 steered cases, what its suite stated before it became a property
 * (test/unit/query/roundtrip.test.ts:545 at 8cad5bce, its runs and its coverage's cases).
 */
export const rebuildingFromADescriptionTypesARebuiltRecursiveRowUnderTheSchemasRostersAsTheOriginalWasTyped =
	property.explore(
		weighted([
			[1, element(nonEmpty(handles, "Kind's handles"))],
			[1, string(codePoint(0x20, 0x7e), { min: 0, max: 8 })]
		]),
		{
			needs: {},
			budget: { runs: 60, steered: 60 },
			situations: ["a roster handle", "no handle"] satisfies ReadonlyArray<Reached<Handle>>,
			check: (_, c: Case<Handle>) => (handle) =>
				Effect.sync(() => {
					assert.deepEqual(
						queryState(back)?.heading.fields.get("kind"),
						queryState(original)?.heading.fields.get("kind")
					)
					/**
					 * A literal against the rebuilt row's handle is checked against the roster, as against the original's.
					 */
					const outcome = (q: unknown) =>
						Result.map(catchCompileError(matchingKind(q, handle)), () => "built")
					const expected = outcome(original)
					assert.deepEqual(
						Result.mapError(outcome(back), (e) => e.reason),
						Result.mapError(expected, (e) => e.reason)
					)
					assert.equal(expected.ok, handles.includes(handle), handle)
					c.note(expected.ok ? "a roster handle" : "no handle")
				}),
			oracle: {
				kind: "second-implementation",
				name: "the original recursive row, and the roster's own handles"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/query/build/heading.ts",
					original: "\treturn scalar.ok ? typed(scalar.value) : untyped",
					replacement:
						"\treturn scalar.ok && descriptor !== undefined ? typed(scalar.value) : untyped",
					why: "A field with no descriptor, typed only by its Description, rebuilt untyped; the rebuilt recursive row's search fails."
				}
			]
		}
	)

/**
 * Generated queries over the worked example's schema decode, are canonical and deterministic, and rebuild to the same
 * query.
 *
 * Budget: 300 runs and 300 steered cases, what its suite stated before it became a property
 * (test/unit/query/roundtrip.test.ts:604 at 8cad5bce, its runs and its coverage's cases).
 */
export const generatedQueriesOverTheWorkedExamplesSchemaDecodeAreCanonicalAndDeterministicAndRebuildToTheSameQuery =
	property.explore(generatedChains(work), {
		needs: {},
		budget: { runs: 300, steered: 300 },
		situations: chainFeatures satisfies ReadonlyArray<Reached<ChainFeature>>,
		check: (_, c: Case<ChainFeature>) => (value) => chainRoundTrip(work)(value, c),
		oracle: {
			kind: "universal",
			name: "the round trip through the Description and its JSON, and the builder run twice"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/query/build/state.ts",
				original: "\t\t\treturn withAttachment(stageHeading(stage.input, env), stage.attach.name)",
				replacement: "\t\t\treturn stageHeading(stage.input, env)",
				why: "A heading rebuilt from an attach stage without its attachment's name; the attachments search and both generated-chain searches fail."
			}
		]
	})

/**
 * Generated queries over spans decode, are canonical and deterministic, and rebuild to the same query.
 *
 * Budget: 150 runs and 150 steered cases, what its suite stated before it became a property
 * (test/unit/query/roundtrip.test.ts:630 at 8cad5bce, its runs and its coverage's cases).
 */
export const generatedQueriesOverSpansDecodeAreCanonicalAndDeterministicAndRebuildToTheSameQuery =
	property.explore(generatedChains(spans), {
		needs: {},
		budget: { runs: 150, steered: 150 },
		situations: chainFeatures satisfies ReadonlyArray<Reached<ChainFeature>>,
		check: (_, c: Case<ChainFeature>) => (value) => chainRoundTrip(spans)(value, c),
		oracle: {
			kind: "universal",
			name: "the round trip through the Description and its JSON, and the builder run twice"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/query/build/state.ts",
				original: "\t\t\treturn withAttachment(stageHeading(stage.input, env), stage.attach.name)",
				replacement: "\t\t\treturn stageHeading(stage.input, env)",
				why: "A heading rebuilt from an attach stage without its attachment's name; the attachments search and both generated-chain searches fail."
			}
		]
	})
