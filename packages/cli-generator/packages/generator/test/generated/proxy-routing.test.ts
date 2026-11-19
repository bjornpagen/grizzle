/**
 * A generated CLI sends a hop to a loopback host directly and every other hop through the proxy its environment names
 * (unless its no-proxy list covers the host), carries credentials only to its bound origins, gives the proxy's
 * userinfo to the proxy alone, and warns once when credentials are sent in plaintext to a host that is not loopback.
 *
 * - Routes: four origins: A (the capture server's 127.0.0.1 listener) and B (its localhost listener), which are
 *   loopback; and N and M, the names n.test and m.test on A's and B's ports, which no resolver knows and the recording
 *   proxy maps to A's and B's listeners. The author config binds A and N. A run starts at any of them by --base-url,
 *   with or without --allow-credentials-for-base-url, follows a chain of redirects across them, and runs with HTTP_PROXY
 *   or http_proxy naming the proxy (with userinfo or without) or with neither, and a no-proxy list naming n.test, m.test,
 *   every host, or nothing. Oracles: the route the routing rule gives each hop, a hop that has no route ending the run
 *   with exit 4; the proxy's heads naming exactly the hosts it carried; a bearer token on exactly the hops to a bound
 *   origin or, with the flag, to the base; Proxy-Authorization at the proxy exactly when its URL has userinfo, and never
 *   at an origin; and one warning for a credentialed plaintext base that is not loopback, none for a loopback base.
 *
 * While a required feature is still pending, a case aimed at it draws the run made to reach it
 * (proxy-routing.fixtures.ts runs), so each is reached on every run seed.
 */
import { deepStrictEqual } from "@bjornpagen/testing/assert"
import { Checkout } from "@bjornpagen/testing/checkout"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option } from "effect"
import {
	expectedOf,
	FEATURES,
	hopOf,
	type Outcome,
	proxiedOf,
	proxyEnv,
	type RouteFeature,
	routingFixture,
	runFeatures,
	runs,
	scriptOf,
	TOKEN,
	warningsPrinted
} from "#test/generated/proxy-routing.fixtures.ts"
import { runBin } from "#test/support/cli-package.ts"

/**
 * Each hop takes the route the routing rule gives it, the proxy carries exactly the hosts it routes, and the token goes
 * only where it is bound. Its budget is the count its suite stated before the conversion: 12 independent cases, and up
 * to 30 steered while a situation is unreached.
 */
export const proxyRouting = property.explore(runs, {
	needs: { fixture: routingFixture, checkout: Checkout.dir },
	situations: FEATURES,
	check:
		({ fixture }, k: Case<RouteFeature>) =>
		(r) =>
			Effect.gen(function* () {
				const { server, proxy, built, command, urls, authorities } = yield* fixture
				const expected = expectedOf(r, authorities)
				k.noteAll(runFeatures(r, expected))
				const observed = yield* proxy.observe(
					server.observe(
						scriptOf(r, urls),
						runBin(built, {
							args: Arr.flatten([
								command,
								["--base-url", urls[r.base]],
								r.allow ? ["--allow-credentials-for-base-url"] : []
							]),
							env: { ROUTES_BEARER_AUTH: TOKEN, ...proxyEnv(r, proxy) },
							stdin: new Uint8Array(0)
						})
					)
				)
				deepStrictEqual<Outcome>(
					{
						hops: Arr.map(observed.result.requests, hopOf),
						exitCode: observed.result.result.exitCode,
						proxied: proxiedOf(observed.heads),
						warnings: Option.map(expected.warnings, () =>
							warningsPrinted(observed.result.result.stderr)
						)
					},
					expected,
					"each hop takes the route the rule gives it and carries the token only where it is bound"
				)
			}),
	oracle: {
		kind: "specification",
		name: "the routing rule's route for each hop, the proxy's heads, and where the credentials and Proxy-Authorization went"
	},
	kept: [],
	budget: { runs: 12, steered: 30 },
	kills: [
		{
			file: "packages/generator/src/runtime-src/runtime/client.ts",
			original:
				"\t\treturn isLoopbackHost(url.success.hostname) ? clients.direct : clients.environment",
			replacement: "\t\treturn clients.environment",
			why: "A loopback hop is routed by the proxy variables too, so a run with a proxy sends its hops to A and B through it; the property fails."
		},
		{
			file: "packages/generator/src/runtime-src/runtime/auth.ts",
			original: '\t\t\tprotocol === "http:" && !isLoopbackHost(hostname)',
			replacement: '\t\t\tprotocol === "http:"',
			why: "The plaintext warning is printed for a loopback base too, whose requests never reach a proxy; the property fails."
		}
	]
})
