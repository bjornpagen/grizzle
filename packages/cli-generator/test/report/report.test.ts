/**
 * The generation report and the generator's exit status (report/index.ts, design 8.1): a run's report, printed and read
 * back, is the report design 8.1 makes of the run, its servers, inputs and their digests in the order given, its
 * version and renames, and its refusals and notices split by severity, each in the order given, its top-level keys
 * printed sorted; and a run exits 1 when another run holds the lock, on a document refusal and on any refusal under
 * --strict, and 0 otherwise.
 */
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Order, Result } from "effect"
import { Digest } from "effect/crypto"
import { generatorExitStatus, makeGenerationReport, printGenerationReport } from "#report/index.ts"
import { type InvalidJsonText, parseJson } from "#runtime/json.ts"
import {
	expectedReport,
	reportEntry,
	expectedStatus,
	inputOf,
	type OutcomeFeature,
	outcomeFeature,
	outcomeOf,
	outcomeSpace,
	type RunFeature,
	runFeatures,
	runSpace,
	topLevelKeys
} from "#test/report/report.fixtures.ts"
import { digestService } from "#test/support/digest.ts"

/** A run's report, printed and read back, is the one design 8.1 makes of the run. */
export const reportBytes = property.explore(runSpace, {
	needs: { digest: digestService },
	situations: [
		"a refusal",
		"a notice",
		"refusals and notices interleaved",
		"two inputs",
		"a rename",
		"no server"
	] satisfies ReadonlyArray<Reached<RunFeature>>,
	check: (resources, k: Case<RunFeature>) => (run) =>
		Effect.gen(function* () {
			k.noteAll(runFeatures(run))
			const digest = yield* resources.digest
			const { input, diagnostics } = yield* Effect.provideService(
				inputOf(run),
				Digest.Digest,
				digest
			)
			const text = printGenerationReport(makeGenerationReport(input), reportEntry)
			const keys = topLevelKeys(text)
			assert.deepEqual(keys, Arr.sort(keys, Order.String))
			assert.deepEqual<Result.Result<unknown, InvalidJsonText>>(
				parseJson(text),
				Result.succeed(expectedReport(input, diagnostics))
			)
		}),
	oracle: {
		kind: "specification",
		name: "design 8.1's report of the run: diagnostics split by severity in the order given, every other field as given"
	},
	kept: [],
	kills: [
		{
			file: "packages/cli-generator/src/report/index.ts",
			original: "refusals: Arr.filter(input.diagnostics, isRefusal),",
			replacement: "refusals: input.diagnostics,",
			why: "A notice is listed among the refusals; the property fails."
		},
		{
			file: "packages/cli-generator/src/report/index.ts",
			original: "notices: Arr.filter(input.diagnostics, (diagnostic) => !isRefusal(diagnostic)),",
			replacement: "notices: Arr.filter(input.diagnostics, isRefusal),",
			why: "The refusals are listed as the notices and the notices are lost; the property fails."
		},
		{
			file: "packages/cli-generator/src/report/index.ts",
			original: "inputs: input.inputs,",
			replacement: "inputs: Arr.reverse(input.inputs),",
			why: "The inputs are recorded out of document order, so a digest stands beside another document; the property fails."
		}
	]
})

/** A run's exit status is the one design 8.1 gives its outcome, over every outcome. */
export const exitStatus = property.exhaust(outcomeSpace, {
	box: "a held lock, and output written with or without --strict, with or without a notice, with refusals at any set of scopes",
	needs: {},
	situations: [
		"a held lock",
		"a run with no refusal",
		"a document refusal",
		"a partly refused run",
		"a partly refused run under --strict"
	] satisfies ReadonlyArray<Reached<OutcomeFeature>>,
	check: (_, k: Case<OutcomeFeature>) => (sketch) =>
		Effect.gen(function* () {
			k.note(outcomeFeature(sketch))
			const outcome = yield* outcomeOf(sketch)
			assert.equal(generatorExitStatus(outcome), expectedStatus(sketch))
		}),
	oracle: {
		kind: "specification",
		name: "design 8.1: 1 on a held lock, a document refusal, or any refusal under --strict; else 0"
	},
	kept: [],
	kills: [
		{
			file: "packages/cli-generator/src/report/index.ts",
			original: 'if (outcome._tag === "LockHeld") {',
			replacement: 'if (outcome._tag !== "LockHeld") {',
			why: "A held lock exits by the refusals of a run that wrote nothing, and every written run exits 1; the property fails."
		},
		{
			file: "packages/cli-generator/src/report/index.ts",
			original: 'Arr.some(refusals, (diagnostic) => diagnostic.scope === "document")',
			replacement: 'Arr.some(refusals, (diagnostic) => diagnostic.scope === "operation")',
			why: "A document refusal exits 0 without --strict, and an operation refusal exits 1; the property fails."
		},
		{
			file: "packages/cli-generator/src/report/index.ts",
			original: "return outcome.strict && refusals.length > 0 ? 1 : 0",
			replacement: "return refusals.length > 0 ? 1 : 0",
			why: "A partly refused run exits 1 without --strict; the property fails."
		}
	]
})
