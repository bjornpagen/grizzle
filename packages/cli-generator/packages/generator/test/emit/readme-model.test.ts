/**
 * The README as a function of what it is written from: the model, the author config, the names plan and every stage's
 * diagnostics, each made by the generator's own stages from a generated document and author config. Its contract,
 * checked fact by fact rather than as whole text: the title is the bin name; the sections come in their fixed order,
 * Secret fields and Webhooks only when there are any, and the OAuth2 and client certificate subsections only when a
 * token scheme or a certificate is planned; every planned credential's environment variable and file flag is listed,
 * and every certificate's three environment variables; the settings name the package's prefix; the refusal summary lists each refused operation once, sorted, as an escaped literal in a fence, and counts
 * the element and field refusals of the commands that remain; the webhooks are listed in document order as escaped
 * literals; every fence closes, and no line inside one could close it; no control, format, separator or lone surrogate
 * code point appears raw; and oxfmt leaves the Markdown unchanged.
 */
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { format } from "oxfmt"
import { emitReadme } from "#emit/readme.ts"
import {
	caseGen,
	type Feature,
	featuresOf,
	readmeFindings,
	readmeInputOf
} from "#test/emit/readme-model.fixtures.ts"

/**
 * The README states exactly what its model, config, plan and diagnostics hold, in Markdown the formatter keeps. Its
 * budget is the count its suite stated before the conversion: 200 independent cases, and up to 800 steered while a
 * situation is unreached.
 */
export const readme = property.explore(caseGen, {
	needs: {},
	situations: [
		"a credential",
		"a token scheme",
		"a certificate",
		"a secret field",
		"a refused operation",
		"an element refusal",
		"nothing refused",
		"a webhook",
		"an env prefix"
	] satisfies ReadonlyArray<Reached<Feature>>,
	check: (_, k: Case<Feature>) => (drawnCase) =>
		Effect.gen(function* () {
			const input = yield* readmeInputOf(drawnCase)
			const { content } = emitReadme(input)
			const formatted = yield* Effect.promise(() => format("README.md", content))
			k.noteAll(featuresOf(input, drawnCase, content))
			assert.deepEqual(
				{
					formatted: formatted.code,
					errors: formatted.errors.length,
					findings: readmeFindings(input, drawnCase, content)
				},
				{ formatted: content, errors: 0, findings: [] }
			)
		}),
	oracle: {
		kind: "specification",
		name: "the README's contract, fact by fact, against the model, config, plan and diagnostics it is written from"
	},
	kept: [],
	budget: { runs: 200, steered: 800 },
	kills: [
		{
			file: "packages/generator/src/normalize/parameters.ts",
			original: '["cookie", "header", "path", "query", "querystring"]',
			replacement: '["cookie", "header", "path", "querystring"]',
			why: "Normalize no longer knows query as a parameter location, so every query parameter's operation is refused and the README's refusal summary differs from the document; the property fails (CATCH's evidence, mutant 10046593fa)."
		}
	]
})
