/**
 * Effective servers and the bound origin set (design 6.4, 9 I3), as effectiveServers and boundOrigins give them: the
 * operation level wins over the path item, which wins over the root; an absent or empty root is the single server `/`,
 * and an empty override is refused; a value that is no list of Server Objects, an illegal template and an undeclared
 * variable are refused. A server is accepted only when the author config lists it, by URL or, on 3.2, by name, and an
 * accepted server must pass the baked-default rules (https, or http with allowInsecure; no userinfo, query or
 * fragment; a relative server only through retrievalUri; a scheme or authority variable only with an enum; a path
 * variable value staying on the server's origin), the first refusing assignment of its variables naming the code, at
 * the config entry that accepts it and never echoing the secret it carries. An accepted server expands to every origin
 * its enums give; the bound set adds the author's acceptedOrigins under the same rules, sorted and without repeats.
 *
 * Oracle: design 6.4's server levels and baked-default rules, applied to the drawn templates as they are written.
 */
import { assertTrue, deepStrictEqual } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	actualOf,
	echoesNoSecret,
	expectedOf,
	type ServersFeature,
	serversFeatures,
	serversSpace
} from "#test/normalize/servers.fixtures.ts"

/**
 * An operation's servers and the run's bound origins are what design 6.4 states. Its budget replaces the thirty-six
 * example cases of the suite it converts, twice over.
 */
export const serversRules = property.explore(serversSpace, {
	needs: {},
	situations: [
		"operation level wins",
		"path item level wins",
		"root level",
		"implicit server",
		"empty override",
		"servers not a list",
		"server not an object",
		"invalid template",
		"undeclared variable",
		"accepted by URL",
		"accepted by name",
		"name ignored before 3.2",
		"server not accepted",
		"insecure scheme refused",
		"insecure scheme allowed",
		"unsupported scheme",
		"userinfo refused",
		"query or fragment refused",
		"relative needs retrievalUri",
		"relative through retrievalUri",
		"unsupported relative form",
		"variable needs an enum",
		"enumerated host expanded",
		"two variables expanded",
		"path variable value refused",
		"value leaves the authority",
		"accepted origin refused",
		"accepted origins bound"
	] satisfies ReadonlyArray<Reached<ServersFeature>>,
	check: (_, c: Case<ServersFeature>) => (sketch) =>
		Effect.gen(function* () {
			const expected = expectedOf(sketch)
			c.noteAll(serversFeatures(sketch, expected))
			const actual = yield* actualOf(sketch)
			deepStrictEqual(actual, expected)
			assertTrue(echoesNoSecret(actual), "no diagnostic echoes a secret")
		}),
	oracle: {
		kind: "specification",
		name: "design 6.4's server levels and baked-default rules, applied to the drawn templates"
	},
	kept: [],
	budget: { runs: 72, steered: 512 },
	kills: [
		{
			file: "packages/generator/src/normalize/servers.ts",
			original: "\tif (Arr.some(variableNames(url), (name) => variables[name] === undefined)) {",
			replacement: "\tif (Arr.some(variableNames(url), (name) => variables[name] !== undefined)) {",
			why: "A server whose variables are all declared is refused as using an undeclared one, and one using an undeclared variable is built; the property fails (CATCH's evidence, mutant 2270f82c90)."
		},
		{
			file: "packages/generator/src/normalize/servers.ts",
			original: "!Arr.isReadonlyArrayNonEmpty(value)",
			replacement: "Arr.isReadonlyArrayNonEmpty(value)",
			why: "An empty servers list is read as a list of servers and a non-empty one as empty, so the implicit `/` and SRV-16 land on the wrong levels; the property fails (CATCH's evidence, mutant 601946ab55)."
		},
		{
			file: "packages/generator/src/normalize/servers.ts",
			original: "\tif (Arr.some(names, (name) => variables[name]?.enum === undefined)) {",
			replacement: "\tif (Arr.every(names, (name) => variables[name]?.enum === undefined)) {",
			why: "An origin span needs an enum only when none of its variables has one, so a span with one enumerated and one free variable is accepted; the property fails (CATCH's evidence, mutant 70b30ee556)."
		},
		{
			file: "packages/generator/src/normalize/servers.ts",
			original: "config.servers?.accepted ?? []",
			replacement: "config.servers?.accepted",
			why: "An author config that accepts no server makes the acceptance lookup throw; the property fails (CATCH's evidence, mutant 78308d1eca)."
		},
		{
			file: "packages/generator/src/normalize/servers.ts",
			original:
				'if (declares(levels.pathItem)) {\n\t\treturn normalizeLevel(levels.pathItem, "pathItem", context)\n\t}',
			replacement: "{}",
			why: "The path item's servers are never chosen, so an operation under a path item with servers falls to the root's; the property fails (CATCH's evidence, mutant 8b746147d6)."
		},
		{
			file: "packages/generator/src/model/entities.ts",
			original: '["operation", "pathItem", "root"]',
			replacement: '["operation", "root"]',
			why: "A server of the path item level cannot be made, so a path item's servers fail to build; the property fails (CATCH's evidence, mutant a315e7f644)."
		},
		{
			file: "packages/generator/src/normalize/servers.ts",
			original: '["acceptedOrigins", String(index)]',
			replacement: '["acceptedOrigins"]',
			why: "A refused acceptedOrigins entry is reported at the list, not at its own index; the property fails (CATCH's evidence, mutant eb8c9b6cf2)."
		},
		{
			file: "packages/generator/src/normalize/servers.ts",
			original:
				"\n\tconst variables = raw.variables ?? {}\n\n\tif (Arr.some(variableNames(url), (name) => variables[name] === undefined)) {",
			replacement:
				"\n\tconst variables = raw.variables\n\n\tif (Arr.some(variableNames(url), (name) => variables[name] === undefined)) {",
			why: "A server with no `variables` member reads its variables from nothing, so a template naming a variable it never declares throws instead of being refused; the property fails (CATCH's evidence, mutant fd58e06d3e)."
		}
	]
})
