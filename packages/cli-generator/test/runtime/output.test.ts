/**
 * What the generated runtime's output module prints, by design 7.1, 7.4, 7.5 and 13.1: every recorded value leaves a
 * print as its placeholder however the values overlap, touch, nest or are split by a character the print strips, on
 * every path that prints a server's or a person's text; an error body is read to its end and printed whole; an invalid
 * value prints its name and never the text typed; the final catch ends each failure no rendered class names with its
 * exit; and an existing `--output` target is refused before `send` sends a request whose answer it would discard.
 * What the rendering of design 7.1's classes prints (an API response error's line, request id and body, an empty body,
 * a defect's one line, each class printed once with its exit) is error-rendering.test.ts's errorRendering, and each
 * wire form of a recorded value is redact.test.ts's scrubbedEchoes; the scenes here hold the run's values together.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Scratch } from "@bjornpagen/testing/resources"
import { Effect } from "effect"
import {
	aimedBodies,
	aimedInvalids,
	aimedScenes,
	BODY_SITUATIONS,
	type BodyFeature,
	bodyFeatures,
	bodyPrintsOf,
	expectedBodyOf,
	expectedInvalidOf,
	expectedOtherOf,
	expectedPrintsOf,
	expectedTargetedOf,
	INVALID_SITUATIONS,
	type InvalidFeature,
	invalidFeatures,
	invalidPrintsOf,
	OTHER_SITUATIONS,
	type OtherFeature,
	otherCaughtOf,
	others,
	printsOf,
	SCENE_SITUATIONS,
	type SceneFeature,
	sceneFeatures,
	TARGET_SITUATIONS,
	type TargetFeature,
	targetedIn,
	targetFeatures,
	targetings
} from "#test/runtime/output.fixtures.ts"

/**
 * Every recorded value leaves every print as its placeholder, one per run of values that overlap or touch, under the
 * earliest and longest one's scheme, found as sent and again once the print strips what split it. It replaces
 * output.test.ts's thirty-three scrubbing cases, and its budget is theirs: thirty-three drawn scenes in its rotating
 * stream and up to thirty-three steered; its floor and steered phase reach each situation by an aimed scene.
 */
export const scrubbedRuns = property.explore(aimedScenes, {
	needs: {},
	situations: SCENE_SITUATIONS satisfies ReadonlyArray<Reached<SceneFeature>>,
	check: (_, c: Case<SceneFeature>) => (scene) =>
		Effect.gen(function* () {
			c.noteAll(sceneFeatures(scene))
			const prints = yield* printsOf(scene)
			assert.deepEqual(prints, expectedPrintsOf(scene))
		}),
	oracle: {
		kind: "second-implementation",
		name: "design 7.5's scrub by trying every form at every place, its runs merged and labelled as recheck N1 says, around 7.4's strip"
	},
	kept: [],
	budget: { runs: 33, steered: 33 },
	kills: [
		{
			file: "packages/cli-generator/src/runtime-src/runtime/redact.ts",
			original: "\tOrder.mapInput(Order.flip(Order.Number), (range: Covered) => range.end)",
			replacement: "\tOrder.mapInput(Order.Number, (range: Covered) => range.end)",
			why: "A value beginning a longer one wins their run, so the run prints the shorter value's scheme; the property fails."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/redact.ts",
			original: "range.start <= last.end",
			replacement: "range.start < last.end",
			why: "Echoes that touch print one placeholder each where the run is one; the property fails."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/redact.ts",
			original: "end: Math.max(last.end, range.end)",
			replacement: "end: last.end",
			why: "A run of overlapping forms ends where its first form does, so the rest of the second prints in clear; the property fails."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/redact.ts",
			original: "(form) => [form, strip(form)]",
			replacement: "(form) => [form]",
			why: "The second pass matches each value only as sent, so a value holding a stripped character, split by another, prints in clear; the property fails."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/redact.ts",
			original: '\treturn Arr.filter(Arr.dedupe(forms), (form) => form !== "")',
			replacement: "\treturn Arr.dedupe(forms)",
			why: "An empty recorded value is a form found at every place, so its placeholder is printed between every two characters; the property fails."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/output.ts",
			original: "\tscrubAround(text, credentials, sanitize)",
			replacement: "\tscrub(sanitize(text), credentials)",
			why: "A print strips its text before it scrubs it once, so a value holding a stripped character is never found as sent; the property fails."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/output.ts",
			original:
				"const text = raw === undefined ? undefined : scrubbedAndSanitized(raw, credentials)",
			replacement: "const text = raw",
			why: "A parse error's report prints the option typed unscrubbed; the property fails."
		}
	]
})

/**
 * An error body is read to its end across any chunks and printed whole, however long: the cap a long body once met is
 * gone. It replaces output.test.ts's four reading and printing cases; its rotating stream is the runner's, its floor and
 * steered phase reach each situation by an aimed body, a hundred thousand characters long for the longest, the length
 * those cases printed.
 */
export const errorBodyWhole = property.explore(aimedBodies, {
	needs: {},
	situations: BODY_SITUATIONS satisfies ReadonlyArray<Reached<BodyFeature>>,
	check: (_, c: Case<BodyFeature>) => (body) =>
		Effect.gen(function* () {
			c.noteAll(bodyFeatures(body))
			const printed = yield* bodyPrintsOf(body)
			assert.deepEqual(printed, expectedBodyOf(body))
		}),
	oracle: {
		kind: "specification",
		name: "design 7.4: an error body is the response body read whole as UTF-8, and printed whole"
	},
	kept: [],
	kills: [
		{
			file: "packages/cli-generator/src/runtime-src/runtime/output.ts",
			original: "Stream.mkUint8Array(body)",
			replacement: "Stream.mkUint8Array(Stream.take(body, 1))",
			why: "An error body is its first chunk alone; the property fails."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/output.ts",
			original: "return scrubbedAndSanitized(error.body, credentials)",
			replacement: "return scrubbedAndSanitized(error.body.slice(0, 65_536), credentials)",
			why: "A rendered body is cut at 64 KiB, as a long body once was; the property fails."
		}
	]
})

/**
 * An invalid value prints its kind and name, never the text typed or the expectation that quotes it, through the
 * value-free formatter and the final catch, alone or inside help. It replaces output.test.ts's four value-free cases;
 * its rotating stream is the runner's, its floor and steered phase reach each kind and expectation by an aimed value.
 */
export const valueFreeInvalid = property.explore(aimedInvalids, {
	needs: {},
	situations: INVALID_SITUATIONS satisfies ReadonlyArray<Reached<InvalidFeature>>,
	check: (_, c: Case<InvalidFeature>) => (invalid) =>
		Effect.gen(function* () {
			c.noteAll(invalidFeatures(invalid))
			const prints = yield* invalidPrintsOf(invalid)
			assert.deepEqual(prints, expectedInvalidOf(invalid))
		}),
	oracle: {
		kind: "specification",
		name: "design 7.5 (SM-3): an invalid value names its flag or argument and nothing it held"
	},
	kept: [],
	kills: [
		{
			file: "packages/cli-generator/src/runtime-src/runtime/output.ts",
			original: "formatError: (error) => errorsText([valueFreeMessage(error)]),",
			replacement: "formatError: base.formatError,",
			why: "The formatter's single error prints the value typed; the property fails."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/output.ts",
			original: "formatCliError: valueFreeMessage,",
			replacement: "formatCliError: base.formatCliError,",
			why: "The formatter's error message prints the value typed; the property fails."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/output.ts",
			original: 'error._tag === "InvalidValue" ? invalidValueMessage(error) : error.message',
			replacement: "error.message",
			why: "The final catch's report prints the value typed; the property fails."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/output.ts",
			original: 'error.kind === "flag" ?',
			replacement: 'error.kind !== "flag" ?',
			why: "A flag prints as an argument and an argument as a flag; the property fails."
		}
	]
})

/**
 * The final catch ends each failure no rendered class names as design 7.1 and 7.4 say: its line once and its exit, a
 * defect's "internal error, please report" and 70, help with no parse error unprinted. It replaces output.test.ts's
 * four such cases, in a box of every one of them.
 */
export const finalCatchOthers = property.exhaust(others, {
	box: "an output error of each reason, a client error that is no transport failure, a failure no class names of each shape, and help with no parse error at the root and under a command",
	needs: {},
	situations: OTHER_SITUATIONS satisfies ReadonlyArray<Reached<OtherFeature>>,
	check: (_, c: Case<OtherFeature>) => (other) =>
		Effect.gen(function* () {
			c.note(other.kind)
			const caught = yield* otherCaughtOf(other)
			assert.deepEqual(caught, expectedOtherOf(other))
		}),
	oracle: {
		kind: "specification",
		name: "design 7.1's exit codes and 7.4's final catch: each failure printed once, a defect as an internal error"
	},
	kept: [],
	kills: [
		{
			file: "packages/cli-generator/src/runtime-src/runtime/output.ts",
			original: "readonly [Runtime.errorExitCode] = 70",
			replacement: "readonly [Runtime.errorExitCode] = 1",
			why: "A defect exits 1, the code of a failed request, where the contract documents 70; the property fails."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/output.ts",
			original: 'Option.getOrElse(defectMessage(Cause.squash(cause)), () => "unknown failure")',
			replacement: '"unknown failure"',
			why: "A defect's own message is never printed; the property fails."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/output.ts",
			original: "errors.length === 0 ? undefined",
			replacement: "errors.length < 0 ? undefined",
			why: "Help with no parse error prints an empty report; the property fails."
		}
	]
})

/**
 * `--output` meets `send` as design 13.1 (HB4) says: an existing target without `--force` is refused before any
 * request, one made while the request runs is refused at the link, `--force` replaces either, and `--dry-run` sends and
 * refuses nothing. It replaces output.test.ts's four `--output` cases, in a box of every setting.
 */
export const outputBeforeSend = property.exhaust(targetings, {
	box: "a target there or not, with and without --force, with and without --dry-run, made while the request runs or not",
	needs: { dir: Scratch.dir },
	situations: TARGET_SITUATIONS satisfies ReadonlyArray<Reached<TargetFeature>>,
	check:
		({ dir }, c: Case<TargetFeature>) =>
		(targeting) =>
			Effect.gen(function* () {
				c.noteAll(targetFeatures(targeting))
				const scratch = yield* dir
				const targeted = yield* targetedIn(scratch, targeting)
				assert.deepEqual(targeted, expectedTargetedOf(targeting))
			}),
	oracle: {
		kind: "specification",
		name: "design 13.1 (HB4): a refused --output target never discards the answer of a request that took effect"
	},
	kept: [],
	kills: [
		{
			file: "packages/cli-generator/src/runtime-src/runtime/client.ts",
			original: "seconds === 0 ? attempt",
			replacement: "seconds === -1 ? attempt",
			why: "A run with no --timeout times every request out at once, so no answer is written (TESTPOLICY2's census, mutant 7f4c0b6bd6); the property fails."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/output.ts",
			original: "if (target !== undefined && target !== stdoutPath && !(yield* Force)) {",
			replacement: "if (target !== undefined && target === stdoutPath && !(yield* Force)) {",
			why: "An existing target is checked only after the request is sent, so the server acts on a request whose answer is refused; the property fails."
		}
	]
})
