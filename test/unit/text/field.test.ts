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
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { element } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { SourceLoc } from "#compiler/core/loc.ts"
import { decodeDesc } from "#compiler/ir/desc.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { describeField } from "#compiler/scalar/registry.ts"
import { schemaDescOf } from "#compiler/schema/schema.ts"
import { regexField } from "#compiler/text/field.ts"
import { textLookup } from "#compiler/text/refinement.ts"
import { succeeded, throwsRefused } from "#test/support/assert.ts"
import { families, flagsGen, patternOver } from "#test/support/unit/text/generators.ts"
import type { Admission } from "#test/unit/text/field.fixtures.ts"

/** Str.regex builds an immutable descriptor that keeps its source and flags, whose desc is a valid Description field, and which a schema holds exactly when the text analysis admits its pattern. Its budget is its suite's before it was a property (test/unit/text/field.test.ts at 4ca3036a): 200 runs and 200 steered cases. */
export const strRegexBuildsAnImmutableDescriptorThatKeepsItsSourceAndFlagsWhoseDescIsAValidDescriptionFieldAndWhichASchemaHoldsExactlyWhenTheTextAnalysisAdmitsItsPattern =
	property.explore(
		(source) => ({
			source: source.draw(patternOver(source.draw(element(families)).alphabet)),
			flags: source.draw(flagsGen)
		}),
		{
			needs: {},
			budget: { runs: 200, steered: 200 },
			situations: ["admitted", "refused"] satisfies ReadonlyArray<Reached<Admission>>,
			check:
				(_, c: Case<Admission>) =>
				({ source, flags }) =>
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
					}),
			oracle: {
				kind: "specification",
				name: "the text analysis's verdict on the pattern (textLookup) decides the descriptor and the schema"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/text/field.ts",
					original: `\tconst resolved: RegexFlags = flagsOf[\`\${first}\` as const]`,
					replacement: "\tconst resolved: RegexFlags = flagsOf.u",
					why: 'str.regex\'s descriptor always takes the flags "u", whatever its flags argument; the descriptor property fails.'
				}
			]
		}
	)
