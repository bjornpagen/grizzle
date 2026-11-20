/**
 * A response body's read is bounded by the stream idle timeout of design 9 I5: `--idle-timeout`, else
 * `<PREFIX>_IDLE_TIMEOUT`, else none, the unprefixed `IDLE_TIMEOUT` never read, and a variable that is no whole number
 * of seconds 1 or more a usage error naming the variable, never its value, before anything is sent. A read that waits
 * longer than the bound for the body's next chunk or its end fails idleTimeout (exit 5), the error body's read
 * included, stdout keeping what was written and `--output` leaving neither target nor temp file; a body whose every
 * wait is within the bound is read whole however long it takes in all, and with no bound every wait is waited. Time is
 * virtual, each wait passing only once the send waits for the piece after it.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Scratch } from "@bjornpagen/testing/resources"
import { Effect } from "effect"
import {
	aimedRuns,
	expectedOf,
	type IdleFeature,
	idleFeatures,
	leftBy
} from "#test/runtime/output-idle.fixtures.ts"

/**
 * A send's body read ends where its idle timeout says. It replaces thirteen example cases, so its rotating stream is
 * thirteen drawn sends; its floor and steered phase reach each situation by an aimed one.
 */
export const idleBound = property.explore(aimedRuns, {
	needs: { dir: Scratch.dir },
	situations: [
		"a wait past the bound on stdout",
		"a wait past the bound writing --output",
		"a wait past the bound in an error body",
		"the end past the bound",
		"a body past the bound in all",
		"no bound, a wait past every bound",
		"the flag decides over the variable",
		"an unprefixed variable alone",
		"an invalid variable",
		"an error body read whole"
	] satisfies ReadonlyArray<Reached<IdleFeature>>,
	check:
		({ dir }, c: Case<IdleFeature>) =>
		(run) =>
			Effect.gen(function* () {
				c.noteAll(idleFeatures(run))
				const scratch = yield* dir
				const left = yield* leftBy(scratch, run)
				assert.deepEqual(left, expectedOf(run))
			}),
	oracle: {
		kind: "specification",
		name: "design 9 I5: the idle timeout's sources and precedence, and each read's end under it"
	},
	kept: [],
	budget: { runs: 13, steered: 30 },
	kills: [
		{
			file: "packages/cli-generator/src/runtime-src/runtime/output.ts",
			original: "duration: Duration.seconds(seconds),",
			replacement: "duration: Duration.infinity,",
			why: "A body's read is bounded by no idle timeout, so a wait past the bound is waited and the body read whole; the property fails."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/output.ts",
			original: "{ bytes: bodyOf(ok, idleSeconds), mediaType },",
			replacement: "{ bytes: bodyOf(ok, Option.none()), mediaType },",
			why: "A 2xx body is read under no idle timeout, so a wait past the bound on stdout or into --output is waited; the property fails."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/output.ts",
			original: "readErrorBody(bodyOf(response, idleSeconds), scrubbed)",
			replacement: "readErrorBody(bodyOf(response, Option.none()), scrubbed)",
			why: "An error body's excerpt is read under no idle timeout, so a stalled error body is waited and its run ends with the API error; the property fails."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/output.ts",
			original: '(error) => error.reason !== "idleTimeout",',
			replacement: "() => true,",
			why: "An error body's idle timeout is swallowed as an empty excerpt, so the run ends with the API error (exit 1) where it stalled (exit 5); the property fails."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/output.ts",
			original: `const name = \`\${envPrefix}_IDLE_TIMEOUT\``,
			replacement: 'const name = "IDLE_TIMEOUT"',
			why: "The unprefixed IDLE_TIMEOUT is read in place of the prefixed variable, so an invalid prefixed value is never refused; the property fails."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/output.ts",
			original: "\t\tif (Option.isSome(flag)) {\n\t\t\treturn flag\n\t\t}",
			replacement: "{}",
			why: "--idle-timeout no longer beats the variable, so a variable the flag overrides decides the read; the property fails."
		}
	]
})
