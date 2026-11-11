/**
 * str.regex's runtime core (text/field.ts regexField) over drawn sources and flags.
 *
 * - Descriptor: it is frozen, keeps its source and flags, and where the text analysis admits the pattern its desc is a
 *   valid Description field carrying the analysis's language, and a schema holds it; where the analysis refuses the
 *   pattern, a schema over it is refused for the analysis's reason.
 *
 * Oracle: the specification, the text analysis's own verdict (text/refinement.ts textLookup) deciding each side.
 *
 * Features: an admitted pattern and a refused one.
 *
 * Plants: text-field-flags-dropped (a descriptor's flags always "u").
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Effect, Formatter } from "effect"
import { SourceLoc } from "#compiler/core/loc.ts"
import { decodeDesc } from "#compiler/ir/desc.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { describeField } from "#compiler/scalar/registry.ts"
import { schemaDescOf } from "#compiler/schema/schema.ts"
import { regexField } from "#compiler/text/field.ts"
import { textLookup } from "#compiler/text/refinement.ts"
import { assert, succeeded, throwsRefused } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { families, flagsGen, patternOver } from "#test/unit/text/generators.ts"

describe("str.regex", () => {
	it.effect(
		"builds an immutable descriptor that keeps its source and flags, whose desc is a valid Description field, and which a schema holds exactly when the text analysis admits its pattern",
		(ctx) => {
			type Admission = "admitted" | "refused"
			return searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "the text analysis's verdict on the pattern (textLookup) decides the descriptor and the schema"
						},
						suite: "unit/text/field",
						draw: drawn((source) => ({
							source: source.draw(patternOver(source.draw(element(families)).alphabet)),
							flags: source.draw(flagsGen)
						})),
						literal: Formatter.format,
						coverage: required<Admission>(["admitted", "refused"], {
							cases: 200,
							sense: notesOnly
						}),
						kept: [],
						runs: 200,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					({ source, flags }, c) =>
						Effect.sync(() => {
							/**
							 * str.regex's runtime core over a drawn source (its literal-typed signature validates a written one).
							 */
							const field = flags === "u" ? regexField(source, ["u"]) : regexField(source, ["su"])
							assert.equal(Object.isFrozen(field), true)
							assert.equal(Object.isFrozen(field.patterns), true)
							assert.deepEqual(field.patterns, [{ source, flags }])
							const content = () =>
								schema("Content", [relation("Article", { state: field }, ["state"])], [])
							const analyzed = textLookup([{ source, flags }])
							if (analyzed.ok) {
								const desc = succeeded(describeField(field, SourceLoc("field", []))).desc
								assert.deepEqual(desc, {
									kind: "text",
									patterns: [{ source, flags }],
									bytes: undefined,
									language: analyzed.value
								})
								assert.equal(decodeDesc("field", desc).ok, true)
								assert.equal(decodeDesc("schema", schemaDescOf(content())).ok, true)
								c.note("admitted")
							} else {
								throwsRefused(content, analyzed.error.reason._tag)
								c.note("refused")
							}
						})
				)
			)
		}
	)
})
