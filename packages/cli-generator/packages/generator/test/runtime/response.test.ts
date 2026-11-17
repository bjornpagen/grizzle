/**
 * A response is matched and classified as the design says (7.1, 7.3). Its key is the explicit code, else the code's
 * range, else default, else undeclared; a HEAD answer, a 1xx, a 204 and a 304 carry no body; a 2xx passes whichever
 * key matched; any other status fails as an API response error with the matched key, the status, the operation, the
 * media type's essence, exit 3 for a 401 or 403 and 1 otherwise, a 3xx's Location with its credentials redacted, and
 * the request id from the designated header only: whole, its control, format and surrogate characters and U+2028/9
 * removed, every value the run recorded (a credential, a secret file's text) its placeholder however it is split by
 * removed characters or holds them itself.
 */

import { deepStrictEqual } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	actualOf,
	actualReason,
	type AnswerFeature,
	answerFeatures,
	answers,
	clientFailures,
	expectedOf,
	expectedReason,
	type FailureFeature,
	failureFeatures
} from "#test/runtime/response.fixtures.ts"

/**
 * A response classifies as the design says. It replaces twenty-four example cases (response.test.ts's matching and
 * request id cases, request-id.test.ts's ten); its budget is 96 drawn answers, its floor 24, steered up to 96 while a
 * situation is unreached.
 */
export const responseDispatch = property.explore(answers, {
	needs: {},
	situations: [
		"an explicit code",
		"a range",
		"default",
		"undeclared",
		"a bodiless answer",
		"a 401 or 403",
		"a 3xx with a Location",
		"a request id with lost characters",
		"a recorded value in the request id",
		"a recorded value split by a lost character",
		"a recorded value holding lost characters",
		"a request id header not designated",
		"a media type with parameters"
	] satisfies ReadonlyArray<Reached<AnswerFeature>>,
	check: (_, c: Case<AnswerFeature>) => (answer) =>
		Effect.gen(function* () {
			const classified = yield* actualOf(answer)
			c.noteAll(answerFeatures(answer, classified))
			deepStrictEqual(classified, expectedOf(answer))
		}),
	oracle: {
		kind: "specification",
		name: "design 7.1/7.3: the matched key's precedence, the error's fields, its exit, and the request id's scrub"
	},
	kept: [],
	budget: { runs: 96, steered: 96 },
	kills: [
		{
			file: "packages/generator/src/runtime-src/runtime/response.ts",
			original: "status >= 200 && status < 300",
			replacement: "true",
			why: "Every status reads as a success, so no non-2xx answer fails; the property fails (CATCH's evidence, mutant 0504314175)."
		},
		{
			file: "packages/generator/src/runtime-src/runtime/response.ts",
			original: "Rec.has(responses, key)",
			replacement: "false",
			why: "No key reads as declared, so every answer matches default or nothing; the property fails (CATCH's evidence, mutant 0756fea87a)."
		},
		{
			file: "packages/generator/src/runtime-src/runtime/response.ts",
			original: "if (declares(responses, range)) {\n\t\treturn range\n\t}",
			replacement: "{}",
			why: "A range key is never matched, so a status only a range covers falls to default or undeclared; the property fails (CATCH's evidence, mutant 1d1d4f1f28)."
		},
		{
			file: "packages/generator/src/runtime-src/runtime/response.ts",
			original:
				'isSuccess(response.status)\n\t\t\t? Effect.succeed(response)\n\t\t\t: Effect.fail(toApiResponseError(table, response, "", scrubbed, Option.none()))',
			replacement:
				'isSuccess(response.status) ? Effect.fail(toApiResponseError(table, response, "", scrubbed, Option.none())) : Effect.succeed(response)',
			why: "A 2xx fails and every other status passes; the property fails (CATCH's evidence, mutant 65041189b6)."
		},
		{
			file: "packages/generator/src/runtime-src/runtime/response.ts",
			original: "Rec.has(responses, key)",
			replacement: "true",
			why: "Every key reads as declared, so every status matches as its explicit code; the property fails (CATCH's evidence, mutant 7ca7975dfe)."
		},
		{
			file: "packages/generator/src/runtime-src/runtime/response.ts",
			original: "\tresponse.status === 304",
			replacement: "\tresponse.status !== 304",
			why: "Every answer but a 304 reads as bodiless and a 304 as carrying a body; the property fails (CATCH's evidence, mutant 9730702d65)."
		},
		{
			file: "packages/generator/src/runtime-src/runtime/redact.ts",
			original: "some",
			replacement: "every",
			why: "A recorded value is scrubbed only where every one of its occurrences sits inside a token, so a value in a request id survives; the property fails (CATCH's evidence, mutant ccafccff2d)."
		},
		{
			file: "packages/generator/src/runtime-src/runtime/response.ts",
			original: "const isSuccess = (status: number): boolean => status >= 200 && status < 300",
			replacement: "const isSuccess = (status: number): boolean => status >= 200 && status >= 300",
			why: "Every status from 200 up reads as a success, so a 4xx or 5xx passes; the property fails (CATCH's evidence, mutant dc298bbad2)."
		},
		{
			file: "packages/generator/src/runtime-src/runtime/response.ts",
			original:
				'\tconst redirect = response.status >= 300 && response.status < 400 ? locationNote(response) : ""',
			replacement:
				'\tconst redirect = response.status < 300 && response.status < 400 ? locationNote(response) : ""',
			why: "A 3xx's Location is never noted, and a 1xx's would be; the property fails (CATCH's evidence, mutant f3100d697b)."
		},
		{
			file: "packages/generator/src/runtime-src/runtime/response.ts",
			original: "status >= 200 && status < 300",
			replacement: "false",
			why: "No status reads as a success, so a 2xx fails; the property fails (CATCH's evidence, mutant fde28c1487)."
		}
	]
})

/**
 * A client failure maps as the design says: a transport failure to its reason by the strongest sign anywhere in its
 * cause chain (a timeout, an abort, a TLS code or word, a DNS code or word; a connect failure otherwise), a cyclic
 * chain ending with a reason, its URL's credentials redacted; any other failure a defect. It replaces fifteen example
 * cases; its budget is 36 drawn failures, its floor 9, steered up to 36 while a situation is unreached.
 */
export const transportReason = property.explore(clientFailures, {
	needs: {},
	situations: [
		"timeout",
		"aborted",
		"tls",
		"dns",
		"connect",
		"a defect",
		"a cyclic cause",
		"a reason two links deep"
	] satisfies ReadonlyArray<Reached<FailureFeature>>,
	check: (_, c: Case<FailureFeature>) => (failure) =>
		Effect.gen(function* () {
			const reason = yield* actualReason(failure)
			c.noteAll(failureFeatures(failure, reason))
			deepStrictEqual(reason, expectedReason(failure))
		}),
	oracle: {
		kind: "specification",
		name: "the transport table: timeout, aborted, tls, dns in that order of strength, else connect; other failures defects"
	},
	kept: [],
	budget: { runs: 36, steered: 36 },
	kills: [
		{
			file: "packages/generator/src/runtime-src/runtime/response.ts",
			original: '\t\treason._tag === "TransportError"',
			replacement: '\t\treason._tag !== "TransportError"',
			why: "A transport failure dies as a defect and an invalid URL becomes a transport error; the property fails (CATCH's evidence, mutant 0b39447738)."
		},
		{
			file: "packages/generator/src/runtime-src/runtime/response.ts",
			original: 'link.name === "AbortError"',
			replacement: "true",
			why: "Every link reads as an abort, so a TLS, DNS or connect failure reports aborted; the property fails (CATCH's evidence, mutant 19ab08bc31)."
		},
		{
			file: "packages/generator/src/runtime-src/runtime/response.ts",
			original:
				'{\n\tconst code = String(link.code ?? "")\n\n\treturn tlsCodes.has(code) || tlsCode.test(code) || tlsMessage.test(link.message ?? "")\n}',
			replacement: "{ return false }",
			why: "No link reads as TLS, so a certificate failure reports dns or connect; the property fails (CATCH's evidence, mutant a3fd6b6fc8)."
		}
	]
})
