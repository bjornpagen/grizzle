/**
 * HDR-03, the response clause: a required response header the matched case declares (its code, else its range, else
 * default, among the operation's declared response keys) and the answer leaves out (names compared without case)
 * writes one stderr warning, in document order, before the body; stdout and the exit are what the run would give with
 * no header required, and a matched key that requires nothing checks nothing.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	aimedExchanges,
	type ExchangeFeature,
	exchangeFeatures,
	judged,
	runsOf
} from "#test/runtime/response-headers.fixtures.ts"

/**
 * A run warns of each missing required header and changes nothing else. It replaces five example cases; its rotating
 * stream is five drawn exchanges, its floor and steered phase reach each situation by an aimed one.
 */
export const requiredHeaders = property.explore(aimedExchanges, {
	needs: {},
	situations: [
		"a required header missing",
		"two required headers missing",
		"a required header present in another case",
		"a non-2xx key checked",
		"a key that requires nothing",
		"an operation without required headers"
	] satisfies ReadonlyArray<Reached<ExchangeFeature>>,
	check: (_, c: Case<ExchangeFeature>) => (exchange) =>
		Effect.gen(function* () {
			c.noteAll(exchangeFeatures(exchange))
			const runs = yield* runsOf(exchange)
			const { actual, expected } = judged(exchange, runs)
			assert.deepEqual<typeof expected>(actual, expected)
		}),
	oracle: {
		kind: "specification",
		name: "HDR-03: one warning per missing required header of the matched key, before the body, nothing else changed"
	},
	kept: [],
	budget: { runs: 5, steered: 18 },
	kills: [
		{
			file: "packages/generator/src/runtime-src/runtime/output.ts",
			original:
				"yield* respond.pipe(\n\t\t\t\tEffect.flatMap((ok) =>\n\t\t\t\t\tisBodiless(ok)\n\t\t\t\t\t\t? Effect.void\n\t\t\t\t\t\t: Effect.flatMap(framedOf(ok), (framed) =>\n\t\t\t\t\t\t\t\twriteStream(retrying(framed.bytes), framed.binary)\n\t\t\t\t\t\t\t)\n\t\t\t\t),\n\t\t\t\tEffect.provideService(RetryAfterCap, cap),\n\t\t\t\tEffect.scoped,\n\t\t\t\tEffect.provide(redactedNames(security))\n\t\t\t)",
			replacement: "{}",
			why: "A successful answer's body is never written, so stdout loses it; the property fails (CATCH's evidence, mutant 24dfb4ca36)."
		},
		{
			file: "packages/generator/src/runtime-src/runtime/response.ts",
			original: `\tconst range = \`\${Math.floor(status / 100)}XX\``,
			replacement: `\tconst range = \`\${Math.floor(status / 101)}XX\``,
			why: "A status's range is computed one off, so a 4xx is matched to no key and its required headers go unchecked; the property fails (CATCH's evidence, mutant 39df168cfc)."
		},
		{
			file: "packages/generator/src/runtime-src/runtime/output.ts",
			original: "required.filter((name) => Option.isNone(Headers.get(response.headers, name))),",
			replacement:
				"required.filter((name) => Option.isNone(Headers.get(response.headers, name)) && false),",
			why: "No missing required header is warned of; the property fails."
		},
		{
			file: "packages/generator/src/runtime-src/runtime/output.ts",
			original:
				"\tconst key = matchResponse(meta.media.responses, response.status)\n\tconst required",
			replacement: "\tconst key = String(response.status)\n\tconst required",
			why: "The required headers are looked up under the status itself, never its range, so a 4xx's required headers go unchecked; the property fails."
		}
	]
})
