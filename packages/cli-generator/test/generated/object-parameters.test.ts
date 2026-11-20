/**
 * A generated CLI takes an object-schema parameter as JSON, from its path positional or its flag, and sends the
 * object's members, in their order, by its style's RFC 6570 expansion. Path and query text is RFC 3986
 * percent-encoded (everything outside unreserved); header text is never encoded:
 *
 * - Path `simple` is `k1,v1,k2,v2`, exploded `k1=v1,k2=v2`; `label` is `.k1,v1,k2,v2`, exploded `.k1=v1.k2=v2`;
 *   `matrix` is `;o=k1,v1,k2,v2`, exploded `;k1=v1;k2=v2`, a member whose text is empty as `;k1`.
 * - Query `form` is `k1=v1&k2=v2`, unexploded `qn=k1,v1,k2,v2`; `deepObject` is `deep[k1]=v1&deep[k2]=v2`, the brackets
 *   encoded. An empty object sends nothing.
 * - Header `simple` is `k1,v1,k2,v2`, exploded `k1=v1,k2=v2`. An empty object sends no header.
 *
 * A number is sent as its JSON digits, past 2^53 included; a boolean as `true` or `false`. Each refusal is exit 2
 * before any connection: a null or nested member anywhere; an empty object in the path, which is required; a `.` in an
 * exploded label, which `.` would leave ambiguous; a `[` or `]` in a `deepObject` member name; a header part with an
 * edge space or a code point past U+00FF, which no header line carries unchanged; a `,` in a header part, or `=` in an
 * exploded header member name, which the expansion would leave ambiguous; and text that is not JSON for an object
 * parameter or a JSON body field.
 *
 * One package; a check that every object positional and flag, and the JSON body field flag, shows `json` as its value
 * in `--help`; properties per location (the six path styles, the three query parameters, the two headers), each oracle
 * the expansion above computed from the drawn object and compared byte for byte with what reached the capture server;
 * and an exhaustion of text that is not JSON for every kind of JSON input.
 */
import { assert } from "@bjornpagen/testing/assert"
import { Checkout } from "@bjornpagen/testing/checkout"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Option } from "effect"
import {
	HEADER_FEATURES,
	headerArgs,
	headerCases,
	headerExpected,
	type HeaderFeature,
	headerFeatures,
	jsonInputs,
	NOT_JSON_TARGETS,
	notJsonCases,
	notJsonInvocation,
	type NotJsonTarget,
	objectFixture,
	observedRun,
	type Outcome,
	PATH_FEATURES,
	pathArgs,
	pathCases,
	pathExpected,
	type PathFeature,
	pathFeatures,
	QUERY_FEATURES,
	queryArgs,
	queryCases,
	queryExpected,
	type QueryFeature,
	queryFeatures,
	REFUSED_RUN,
	type Shown,
	shownOf
} from "#test/generated/object-parameters.fixtures.ts"

/** Each object positional and flag, and the JSON body field flag, shows json as its value in --help. */
export const objectJsonHelp = property.exhaust(jsonInputs, {
	box: "every JSON input of the box: each path style's positional, the three query flags, the two header flags and the JSON body field flag",
	needs: { fixture: objectFixture, checkout: Checkout.dir },
	situations: [],
	check:
		({ fixture }) =>
		([operation, left]) =>
			Effect.gen(function* () {
				const opened = yield* fixture
				const shown = yield* shownOf(opened, operation, left)
				assert.deepEqual<Shown>(
					shown,
					{ operation, left, exitCode: 0, metavar: Option.some("json") },
					"each object positional and flag, and the JSON body field flag, takes json"
				)
			}),
	oracle: { kind: "specification", name: "a JSON input's value is named json in --help" },
	kept: [],
	kills: [
		{
			file: "packages/cli-generator/src/emit/cli.ts",
			original:
				"const takesJsonText = (parameter: Typed): boolean =>\n\tisObjectParameter(parameter) ||",
			replacement: "const takesJsonText = (parameter: Typed): boolean =>",
			why: "An object parameter's flag or positional shows no value name, only a JSON content one does; the property fails."
		}
	]
})

/** Each object in the path is sent by its style's expansion, or refused before any connection. Its budget is the count its suite stated before the conversion: 6 independent cases, and up to 24 steered while a situation is unreached. */
export const objectsInPath = property.explore(pathCases, {
	needs: { fixture: objectFixture, checkout: Checkout.dir },
	situations: PATH_FEATURES,
	check:
		({ fixture }, k: Case<PathFeature>) =>
		(c) =>
			Effect.gen(function* () {
				const opened = yield* fixture
				k.noteAll(pathFeatures(c))
				const outcome = yield* observedRun(opened, c.target.operation, pathArgs(c))
				assert.deepEqual<Outcome>(
					outcome,
					pathExpected(c),
					"the object is sent by its style's expansion, or refused before any connection"
				)
			}),
	oracle: {
		kind: "second-implementation",
		name: "each style's RFC 6570 expansion of the drawn object, byte for byte against what reached the server"
	},
	kept: [],
	budget: { runs: 6, steered: 24 },
	kills: [
		{
			file: "packages/cli-generator/src/runtime-src/runtime/serialize.ts",
			original: '\t\treturn [...(exploded ? ["."] : []), ...(reserved ? [",", "="] : [])]',
			replacement: '\t\treturn [...(reserved ? [",", "="] : [])]',
			why: "A . in an exploded label is sent, where the expansion leaves it ambiguous and it is refused; the property fails."
		}
	]
})

/** Each object in the query is sent by its style's expansion, or refused before any connection. Its budget is the count its suite stated before the conversion: 6 independent cases, and up to 24 steered while a situation is unreached. */
export const objectsInQuery = property.explore(queryCases, {
	needs: { fixture: objectFixture, checkout: Checkout.dir },
	situations: QUERY_FEATURES,
	check:
		({ fixture }, k: Case<QueryFeature>) =>
		(c) =>
			Effect.gen(function* () {
				const opened = yield* fixture
				k.noteAll(queryFeatures(c))
				const outcome = yield* observedRun(opened, "query", queryArgs(c))
				assert.deepEqual<Outcome>(
					outcome,
					queryExpected(c),
					"the object is sent by its style's expansion, or refused before any connection"
				)
			}),
	oracle: {
		kind: "second-implementation",
		name: "each style's RFC 6570 expansion of the drawn object, byte for byte against what reached the server"
	},
	kept: [],
	budget: { runs: 6, steered: 24 },
	kills: [
		{
			file: "packages/cli-generator/src/runtime-src/runtime/serialize.ts",
			original:
				"\t\treturn Arr.some(text.members, ([member]) => bracketInKey.test(member))\n\t\t\t? refuseBracketKey(name)\n\t\t\t: Effect.void",
			replacement: "\t\treturn Effect.void",
			why: "A deepObject member name holding [ or ] is sent, where its encoded bracket reads as the path's and it is refused; the property fails."
		}
	]
})

/** Each object in a header is sent unencoded, or refused before any connection. Its budget is the count its suite stated before the conversion: 6 independent cases, and up to 24 steered while a situation is unreached. */
export const objectsInHeaders = property.explore(headerCases, {
	needs: { fixture: objectFixture, checkout: Checkout.dir },
	situations: HEADER_FEATURES,
	check:
		({ fixture }, k: Case<HeaderFeature>) =>
		(c) =>
			Effect.gen(function* () {
				const opened = yield* fixture
				k.noteAll(headerFeatures(c))
				const outcome = yield* observedRun(opened, "headers", headerArgs(c))
				assert.deepEqual<Outcome>(
					outcome,
					headerExpected(c),
					"the object is sent by its style's expansion, or refused before any connection"
				)
			}),
	oracle: {
		kind: "second-implementation",
		name: "each style's RFC 6570 expansion of the drawn object, byte for byte against what reached the server"
	},
	kept: [],
	budget: { runs: 6, steered: 24 },
	kills: [
		{
			file: "packages/cli-generator/src/runtime-src/runtime/serialize.ts",
			original: "\t\tif (headerAmbiguity(text, options.explode).length > 0) {",
			replacement: "\t\tif (false) {",
			why: "A , in a header part, or = in an exploded member name, is sent, where the expansion leaves it ambiguous and it is refused; the property fails."
		}
	]
})

/** Text that is not JSON, for every kind of JSON input, is a usage error before any connection. */
export const objectNotJson = property.exhaust(notJsonCases, {
	box: "every JSON input kind, given R alone or R and one of , = 1",
	needs: { fixture: objectFixture, checkout: Checkout.dir },
	situations: NOT_JSON_TARGETS,
	check:
		({ fixture }, k: Case<NotJsonTarget>) =>
		({ target, text }) =>
			Effect.gen(function* () {
				const opened = yield* fixture
				k.note(target)
				const { operation, args } = notJsonInvocation(target, text)
				const outcome = yield* observedRun(opened, operation, args)
				assert.deepEqual<Outcome>(
					outcome,
					REFUSED_RUN,
					"text that is not JSON is a usage error before any connection"
				)
			}),
	oracle: { kind: "specification", name: "exit 2 before any connection" },
	kept: [],
	kills: [
		{
			file: "packages/cli-generator/src/runtime-src/runtime/input.ts",
			original: "\t\tEffect.mapError(decodeIntegers(raw), failure)",
			replacement: "\t\tEffect.orElseSucceed(decodeIntegers(raw), () => ({}))",
			why: "Text that is not JSON is taken as an empty object, so the run goes on and sends it; the property fails."
		}
	]
})
