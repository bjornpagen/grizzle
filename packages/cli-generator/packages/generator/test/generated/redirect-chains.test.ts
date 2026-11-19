/**
 * A generated CLI follows redirects as its contract says, and sends credentials only to its bound origin.
 *
 * - Chains: from the bound origin (the capture server's 127.0.0.1 listener), a chain of up to sixteen redirects, each a
 *   301, 302, 303, 307 or 308 to the bound origin or the unbound one (its localhost listener), absolute or relative,
 *   to a fresh path or back to the path of an earlier request, after a GET or a POST with or without a JSON body, run
 *   with a bearer token, a header key, a query key and a cookie key. Oracle: the redirect loop's specification as a
 *   model: each hop's origin, method, target and body (a 301 or 302 POST and a 303 of anything but GET or HEAD continue
 *   as a body-less GET; a body never crosses origins, and a hop that would send a request the chain already sent, the
 *   same method to the same origin and path, is a loop, each refused with exit 4 and its reason; a revisit under
 *   another method or at another origin is followed, and no count of hops ends a chain), every credential on each hop
 *   to the bound origin and none on a hop to the unbound one, no trace propagation header on any hop, and exit 0 once
 *   the chain lands.
 */
import { assert } from "@bjornpagen/testing/assert"
import { Checkout } from "@bjornpagen/testing/checkout"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { jsonTextOf } from "@superstarter/json"
import { Array as Arr, Effect, Option } from "effect"
import {
	type ChainFeature,
	chainFeatures,
	chains,
	expectedOf,
	hopOf,
	landing,
	redirectFixture,
	refusedOf,
	runOf
} from "#test/generated/redirect-chains.fixtures.ts"
import { runBin } from "#test/support/cli-package.ts"
import { chainScript } from "#test/support/redirect-model.ts"

/**
 * Each hop of a chain is the one the redirect loop's contract sends, credentials only on the bound origin, and the run
 * exits as the chain ends. Its budget is the count its suite stated before the conversion: 20 independent cases, and up
 * to 60 steered while a situation is unreached.
 */
export const redirectChains = property.explore(chains, {
	needs: { fixture: redirectFixture, checkout: Checkout.dir },
	situations: [
		"no redirect",
		"a chain past ten redirects",
		"a revisit under another method",
		"a revisit at another origin",
		"a loop refused",
		"a hop to the unbound origin",
		"back to the bound origin",
		"a relative Location",
		"a POST turned GET",
		"a body kept across a 307 or 308",
		"a body refused across origins",
		"status 301",
		"status 302",
		"status 303",
		"status 307",
		"status 308"
	] satisfies ReadonlyArray<Reached<ChainFeature>>,
	check:
		({ fixture }, k: Case<ChainFeature>) =>
		(c) =>
			Effect.gen(function* () {
				const { server, built, commands } = yield* fixture
				const run = runOf(c)
				const expected = expectedOf(c, run)
				k.noteAll(chainFeatures(c, run, expected))
				const observed = yield* server.observe(
					chainScript(c.redirects, server.origins, landing),
					runBin(built, {
						args: [
							...commands[c.method],
							"--base-url",
							server.origins["127.0.0.1"],
							...Option.match(c.note, {
								onNone: () => [],
								onSome: (note) => ["--body", jsonTextOf({ note })]
							})
						],
						env: {
							HOPS_BEARER_AUTH: c.credentials.bearer,
							HOPS_HEADER_KEY: c.credentials.header,
							HOPS_QUERY_KEY: c.credentials.query,
							HOPS_COOKIE_KEY: c.credentials.cookie
						},
						stdin: new Uint8Array(0)
					})
				)
				assert.deepEqual<typeof expected>(
					{
						hops: Arr.map(observed.requests, hopOf),
						exitCode: observed.result.exitCode,
						refused: refusedOf(observed.result.stderr)
					},
					expected,
					"each hop is the one the loop's contract sends, credentials only on the bound origin"
				)
			}),
	oracle: {
		kind: "second-implementation",
		name: "the redirect loop's specification as a model (redirect-model.ts)"
	},
	kept: [],
	budget: { runs: 20, steered: 60 },
	kills: [
		{
			file: "packages/generator/src/runtime-src/runtime/client.ts",
			original: '\t(status === 303 && method !== "GET" && method !== "HEAD")',
			replacement: "\tfalse",
			why: "A 303 after a POST is followed as a POST, its body sent again, where the contract continues as a body-less GET; the property fails."
		},
		{
			file: "packages/generator/src/runtime-src/runtime/client.ts",
			original: 'if (next.body._tag !== "Empty" && target.origin !== from.origin) {',
			replacement: "if (false) {",
			why: "A 307 or 308 sends its body on to another origin, which the contract refuses; the property fails."
		},
		{
			file: "packages/generator/src/runtime-src/runtime/client.ts",
			original: "if (HashSet.has(sent, { method: next.method, url })) {",
			replacement: "if (HashSet.has(earlier, { method: next.method, url })) {",
			why: "The hop just sent is not yet among the requests the chain sent, so a redirect to itself is followed once more before the loop is refused; the property fails."
		}
	]
})
