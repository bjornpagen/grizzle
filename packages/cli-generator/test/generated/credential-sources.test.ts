/**
 * A generated CLI reads each scheme's credential from wherever the operator put it and sends it where the scheme says,
 * refuses a credential no request could carry, and refuses a run that needs a credential it was not given.
 *
 * - The box: one operation per scheme kind (http bearer and basic, apiKey in a header, the query and a cookie, oauth2
 *   with scopes and flows whose URLs name the capture server, openIdConnect).
 * - Sources, an exhaustion: every scheme with a simple value from the environment, a file or stdin (with and without a
 *   last line end, which is dropped), or with no credential at all.
 * - Values, a property: any value the scheme's carrier admits, an inner space and characters past ASCII among them, for
 *   a drawn scheme, or, while schemes are pending, one of them.
 * - Prompt, a property: no source at all, on a terminal script(1) opens, the value typed once the prompt shows; the
 *   terminal must never show the typed value. What the terminal shows is every byte script(1) reads from the
 *   pseudo-terminal's master, so an echo from the line discipline is caught as well as one the CLI writes.
 * - Faults, an exhaustion: one planted fault of each family a carrier refuses (a line break or an edge space in a
 *   header, a basic credential without its colon, a cookie value with a separator), from every source. Oracles: one
 *   request to the operation, the credential in exactly the scheme's place (`Authorization` with the scheme word, the
 *   header, the query parameter, the cookie) and no other credential; no scope name anywhere in it and no request to a
 *   flow's URL; exit 3 and no request without a credential, exit 2 and no request for a planted fault; and the
 *   credential's value nowhere in what the run prints.
 * - Help: the root's help offers every scheme's `--<scheme>-file` flag with a description naming that scheme.
 */
import { assert } from "@bjornpagen/testing/assert"
import { Checkout } from "@bjornpagen/testing/checkout"
import { type Case, property } from "@bjornpagen/testing/property"
import { Scratch } from "@bjornpagen/testing/resources"
import { Array as Arr, Effect, FileSystem, Path, String as Str } from "effect"
import {
	carriedOf,
	caseFeatures,
	checkRun,
	type CredentialFeature,
	credentialFixture,
	expectedCarried,
	FAULT_FEATURES,
	faultCases,
	landing,
	NAMES,
	type Outcome,
	rootHelp,
	SCHEMES,
	SOURCE_FEATURES,
	sourceCases,
	typedCases,
	valueCases
} from "#test/generated/credential-sources.fixtures.ts"
import { runBin, runBinOnTerminal } from "#test/support/cli-package.ts"

/** Every scheme's simple credential goes where its scheme says from every source, and nowhere else. */
export const credentialSources = property.exhaust(sourceCases, {
	box: "every scheme's simple credential from the environment, a file, stdin or no source, with and without a last line end where the source can hold one",
	needs: { fixture: credentialFixture, scratch: Scratch.dir, checkout: Checkout.dir },
	situations: SOURCE_FEATURES,
	check:
		({ fixture, scratch: scratchDir }, k: Case<CredentialFeature>) =>
		(c) =>
			Effect.gen(function* () {
				const { server, built, commands } = yield* fixture
				const fs = yield* FileSystem.FileSystem
				const path = yield* Path.Path
				const scratch = yield* scratchDir
				k.noteAll(caseFeatures(c))
				yield* checkRun(c, { server, built, commands, fs, file: path.join(scratch, "credential") })
			}),
	oracle: {
		kind: "specification",
		name: "one request with the credential in exactly its scheme's place, exit 3 with no request when there is none, and its value nowhere in what the run prints"
	},
	kept: [],
	kills: [
		{
			file: "packages/cli-generator/src/runtime-src/runtime/auth.ts",
			original: "\t\tEffect.map(stripLineEnd)",
			replacement: "\t\tEffect.map((text) => text)",
			why: "A credential read from a file or stdin keeps its last line end, so a header carrier refuses it and the query and cookie carry it; the property fails."
		}
	]
})

/** Each scheme's --<scheme>-file flag is offered by the root's help, described by the scheme whose credential it reads. */
export const credentialFileHelp = property.exhaust(rootHelp, {
	box: "the root's --help",
	needs: { fixture: credentialFixture, checkout: Checkout.dir },
	situations: [],
	check:
		({ fixture }) =>
		(flag) =>
			Effect.gen(function* () {
				const { built } = yield* fixture
				const help = yield* runBin(built, { args: [flag], env: {}, stdin: new Uint8Array(0) })
				const lines = Arr.map(Str.split("\n")(new TextDecoder().decode(help.stdout)), Str.trim)
				assert.deepEqual(
					Arr.map(SCHEMES, (scheme) =>
						Arr.some(
							lines,
							(line) =>
								Str.startsWith(`${NAMES[scheme].flag} path|-`)(line) &&
								Str.includes(`Read the ${scheme} credential from <path>`)(line)
						)
					),
					Arr.map(SCHEMES, () => true),
					"every scheme's --<scheme>-file flag is described by the scheme whose credential it reads"
				)
			}),
	oracle: {
		kind: "specification",
		name: "a file flag for every scheme, its description naming the scheme"
	},
	kept: [],
	kills: [
		{
			file: "packages/cli-generator/src/runtime-src/runtime/auth.ts",
			original: `\t\t\t\t\`Read the \${scheme} credential from <path>, or from stdin when <path> is -\``,
			replacement: '\t\t\t\t"Read the credential from <path>, or from stdin when <path> is -"',
			why: "A file flag's description names no scheme, so the help cannot say whose credential each file holds; the property fails."
		}
	]
})

/**
 * Any value a scheme's carrier admits is carried exactly as given. Its budget is the count its suite stated before the
 * conversion: 8 independent cases, and up to 20 steered while a situation is unreached.
 */
export const credentialValues = property.explore(valueCases, {
	needs: { fixture: credentialFixture, scratch: Scratch.dir, checkout: Checkout.dir },
	situations: [...SCHEMES, "a value holding a space", "a value beyond ASCII"],
	check:
		({ fixture, scratch: scratchDir }, k: Case<CredentialFeature>) =>
		(c) =>
			Effect.gen(function* () {
				const { server, built, commands } = yield* fixture
				const fs = yield* FileSystem.FileSystem
				const path = yield* Path.Path
				const scratch = yield* scratchDir
				k.noteAll(caseFeatures(c))
				yield* checkRun(c, { server, built, commands, fs, file: path.join(scratch, "credential") })
			}),
	oracle: {
		kind: "specification",
		name: "the credential in exactly its scheme's place on the one request, and its value nowhere in what the run prints"
	},
	kept: [],
	budget: { runs: 8, steered: 20 },
	kills: [
		{
			file: "packages/cli-generator/src/runtime-src/runtime/auth.ts",
			original: "HttpClientRequest.basicAuth(request, user, password)",
			replacement: "HttpClientRequest.basicAuth(request, password, user)",
			why: "A basic credential's user and password are sent swapped; the property fails."
		}
	]
})

/** Every fault a carrier refuses is refused before any request, from every source. */
export const credentialFaults = property.exhaust(faultCases, {
	box: "every fault of every family a carrier refuses (a line break, an edge space, no colon, a cookie separator), under each scheme whose carrier refuses it, from the environment, a file and stdin",
	needs: { fixture: credentialFixture, scratch: Scratch.dir, checkout: Checkout.dir },
	situations: FAULT_FEATURES,
	check:
		({ fixture, scratch: scratchDir }, k: Case<CredentialFeature>) =>
		(c) =>
			Effect.gen(function* () {
				const { server, built, commands } = yield* fixture
				const fs = yield* FileSystem.FileSystem
				const path = yield* Path.Path
				const scratch = yield* scratchDir
				k.noteAll(caseFeatures(c))
				yield* checkRun(c, { server, built, commands, fs, file: path.join(scratch, "credential") })
			}),
	oracle: {
		kind: "specification",
		name: "exit 2 with no request for a credential its carrier refuses, and its value nowhere in what the run prints"
	},
	kept: [],
	kills: [
		{
			file: "packages/cli-generator/src/runtime-src/runtime/auth.ts",
			original: "\tunsafeHeaderValue(value)\n\t\t? refuse(",
			replacement: "\tfalse\n\t\t? refuse(",
			why: "A header credential with a line break, an edge space or a code point above U+00FF is passed to the request, where it is refused before any connection; the property fails."
		}
	]
})

/**
 * A credential typed at a prompt on a terminal goes where its scheme says, and the terminal never shows it. Its budget
 * is the count its suite stated before the conversion: 7 independent cases, and up to 20 steered while a situation is
 * unreached.
 */
export const credentialPrompt = property.explore(typedCases, {
	needs: { fixture: credentialFixture, checkout: Checkout.dir },
	situations: SCHEMES,
	check:
		({ fixture }, k: Case<CredentialFeature>) =>
		({ scheme, text }) =>
			Effect.gen(function* () {
				const { server, built, commands } = yield* fixture
				k.note(scheme)
				const observed = yield* server.observe(
					() => landing,
					runBinOnTerminal(built, {
						args: Arr.appendAll(commands[scheme], ["--base-url", server.origins["127.0.0.1"]]),
						env: {},
						typed: text
					})
				)
				assert.deepEqual<Outcome>(
					{
						exitCode: observed.result.exitCode,
						requests: Arr.map(observed.requests, carriedOf),
						leaked: Str.includes(Str.trim(text))(new TextDecoder().decode(observed.result.terminal))
					},
					{ exitCode: 0, requests: [expectedCarried(scheme, text)], leaked: false },
					"the value typed at the prompt goes where its scheme says and the terminal never shows it"
				)
			}),
	oracle: {
		kind: "specification",
		name: "the typed credential in its scheme's place on the one request, and the typed value nowhere the terminal shows"
	},
	kept: [],
	budget: { runs: 7, steered: 20 },
	kills: [
		{
			file: "packages/cli-generator/src/runtime-src/runtime/auth.ts",
			original: "\tPrompt.run(Prompt.Password({",
			replacement: "\tPrompt.run(Prompt.Text({",
			why: "The prompt echoes what is typed, so the terminal shows the credential; the property fails."
		}
	]
})
