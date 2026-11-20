/**
 * Security schemes and requirements, as normalize models them (design 6.5): every scheme kind a line admits is
 * modelled (an apiKey by its location and name, http basic and bearer, mutualTLS from 3.1, OAuth 2 and OpenID
 * Connect with their flows, scopes and discovery URLs recorded for help only, sanitized, and the 3.2
 * `oauth2MetadataUrl` on 3.2 alone), and a scheme it cannot send is refused at element scope; each OAuth flow's and
 * OpenID Connect's token acquisition is refused at element scope while the scheme stays usable. An operation's list
 * replaces the root's; an alternative naming an undeclared or unusable scheme, or two schemes that each set the
 * Authorization header, is removed with element-scope refusals, and an operation with no alternative left is refused
 * at operation scope. The author config's `security.add` adds schemes after the declared ones, refuses a name the spec
 * declares at document scope, applies its requirement only where the spec declares no security, and reaches nothing
 * from a spec requirement (AS-1). Findings come in document order.
 *
 * Oracle: design 6.5's model of schemes and alternatives, applied to the drawn document and author config.
 */
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	actualOf,
	expectedOf,
	type SecurityFeature,
	securityFeatures,
	securitySpace
} from "#test/normalize/security.fixtures.ts"

/**
 * A document's schemes and its operation's alternatives normalize as design 6.5 states. Its budget replaces the
 * twenty-two example cases of the four suites it converts (author-supplied, security-metadata-url, security-mtls and
 * security-token), twice over.
 */
export const securityRules = property.explore(securitySpace, {
	needs: {},
	situations: [
		"apiKey scheme",
		"http basic scheme",
		"http bearer scheme",
		"unsupported http scheme",
		"mutualTLS scheme",
		"oauth2 scheme",
		"openIdConnect scheme",
		"invalid apiKey name",
		"deprecated scheme",
		"metadata URL recorded",
		"metadata URL left out",
		"unsafe characters stripped",
		"operation list over the root",
		"root list inherited",
		"no security declared",
		"conflicting Authorization",
		"undeclared scheme named",
		"unusable scheme named",
		"operation refused with no alternative left",
		"anonymous alternative",
		"added scheme applied",
		"added scheme collides",
		"spec requirement names an added scheme",
		"scheme environment name"
	] satisfies ReadonlyArray<Reached<SecurityFeature>>,
	check: (_, c: Case<SecurityFeature>) => (sketch) =>
		Effect.gen(function* () {
			const expected = expectedOf(sketch)
			c.noteAll(securityFeatures(sketch, expected))
			const actual = yield* actualOf(sketch)
			assert.deepEqual<typeof expected>(actual, expected)
		}),
	oracle: {
		kind: "specification",
		name: "design 6.5's schemes and alternatives, applied to the drawn document and author config"
	},
	kept: [],
	budget: { runs: 44, steered: 256 },
	kills: [
		{
			file: "packages/cli-generator/src/normalize/security.ts",
			original: "node.deprecated ?? false",
			replacement: "node.deprecated",
			why: "A scheme that writes no `deprecated` is decoded with the mark absent, so it is refused as malformed and every alternative naming it is removed; the property fails (CATCH's evidence, mutant 887e3a2408)."
		},
		{
			file: "packages/cli-generator/src/resolve/index.ts",
			original: "\t\t\tif (known !== undefined && known !== member) {",
			replacement: "\t\t\tif (known !== undefined && known === member) {",
			why: "Resolution takes a member it already holds for a new one, so the document set is refused; the property fails (CATCH's evidence, mutant 503dbfe0f1)."
		},
		{
			file: "packages/cli-generator/src/model/author-config.ts",
			original: 'keyWhere(Str.isNonEmpty, "unknown-key"),\n\t\t\t\t\tcredentialVariable',
			replacement:
				'keyWhere((name) => name === "add", "unknown-key"),\n\t\t\t\t\tcredentialVariable',
			why: "The author config's `security` refuses every scheme's environment name and admits only `add`, so a config naming a scheme's variable is refused; the property fails (CATCH's evidence, mutant 7195dc3ec1)."
		},
		{
			file: "packages/cli-generator/src/normalize/security.ts",
			original: "\t\tmodelled === undefined",
			replacement: "\t\tmodelled !== undefined",
			why: "Every scheme normalize can model is refused as malformed, and only an unknown one is kept; the property fails (CATCH's evidence, mutant a20dfcc157)."
		},
		{
			file: "packages/cli-generator/src/normalize/security.ts",
			original:
				'[\n\t\t...Option.toArray(\n\t\t\tOption.map(operation, (pointer): Source => ({\n\t\t\t\tpointer: childPointer(pointer, "security"),\n\t\t\t\trows: ["SEC-01", "SEC-04"]\n\t\t\t}))\n\t\t),\n\t\t{ pointer: "/security", rows: ["SEC-01", "SEC-03"] }\n\t]',
			replacement: '[{ pointer: "/security", rows: ["SEC-01", "SEC-03"] }]',
			why: "An operation's own `security` is never read, so the root's list (or none) applies where the operation overrides it; the property fails (CATCH's evidence, mutant 0d376bbffa)."
		},
		{
			file: "packages/cli-generator/src/normalize/security.ts",
			original:
				"nodeOption(resolution, schemes).pipe(\n\t\tOption.flatMap((json) => decodeJsonMap(json)),\n\t\tOption.match({ onNone: (): string[] => [], onSome: (map) => Record.keys(map) })\n\t)",
			replacement:
				"nodeOption(resolution, schemes).pipe(Option.flatMap((json) => decodeJsonMap(json)))",
			why: "The declared schemes' names are never listed, so no scheme is modelled and every requirement names an undeclared one; the property fails (CATCH's evidence, mutant dadf3d56a5)."
		}
	]
})
