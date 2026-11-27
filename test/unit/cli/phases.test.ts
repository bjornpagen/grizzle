/**
 * `grizzle generate --phases` and `grizzle check --phases`: each phase of the pipeline reported at its start and its end,
 * so a run that dies names the phase it died in, and nothing else the command prints or writes changed by the flag.
 *
 * Oracle: the pipeline's own nesting (phases.fixtures.ts parentOf) and the roster's order (core/phase.ts phaseNames):
 * every roster phase is reported by generate, and by check but `render` and `write`, which check never does (it renders
 * the folder inside its draft and writes nothing), each start inside its
 * parent and each end closing its own start, first started in the roster's order, every line in the stated format
 * with a done line whose peak is at least every heap reading; and the same command line without the flag prints the
 * same report and, for generate, writes byte-identical files.
 */

import { assert } from "@bjornpagen/testing/assert"
import { finite } from "@bjornpagen/testing/gen"
import { property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option } from "effect"
import { type PhaseName, phaseNames } from "#compiler/core/phase.ts"
import {
	type Boundary,
	nestingFault,
	phaseGen,
	phasesNeed,
	readLines,
	startsOf
} from "#test/unit/cli/phases.fixtures.ts"

/** Where the first start of `phase` stands among the boundaries, if it is reported. */
const firstStart = (boundaries: ReadonlyArray<Boundary>, phase: PhaseName): Option.Option<number> =>
	Arr.findFirstIndex(boundaries, (b) => b.name === phase && b.edge === "start")

/** The lines of one run with the flag, held to the roster for `phase`, the phases the command never reports aside. */
const holdsPhase = (
	command: string,
	lines: ReadonlyArray<string>,
	phase: PhaseName,
	reported: ReadonlyArray<PhaseName>
): void => {
	const { boundaries, peak } = readLines(lines)
	for (const b of boundaries) {
		assert.ok(
			peak >= b.heapUsed,
			`${command}: the done line's peak ${peak} is below ${b.label}'s heap ${b.heapUsed}`
		)
	}
	if (!Arr.contains(reported, phase)) {
		assert.equal(startsOf(boundaries, phase), 0, `${command} reports no ${phase}`)
		return
	}
	assert.ok(
		startsOf(boundaries, phase) > 0,
		`${command} reports ${phase}:\n${Arr.join(lines, "\n")}`
	)
	const fault = nestingFault(boundaries, phase)
	assert.equal(
		fault,
		undefined,
		`${command}: ${phase} nests as the pipeline does:\n${Arr.join(lines, "\n")}`
	)
	const at = Arr.findFirstIndex(reported, (p) => p === phase)
	const before = Option.flatMap(at, (i) => (i === 0 ? Option.none() : Arr.get(reported, i - 1)))
	if (Option.isSome(before)) {
		const mine = firstStart(boundaries, phase)
		const theirs = firstStart(boundaries, before.value)
		assert.ok(
			Option.isSome(mine) && Option.isSome(theirs) && mine.value > theirs.value,
			`${command}: ${phase} first starts after ${before.value}, as the roster orders them`
		)
	}
}

/**
 * Every roster phase is reported in order and nested as the pipeline runs it, generate's and check's, and the flag
 * changes nothing either prints or generate writes.
 */
export const everyPhaseIsReportedAtItsStartAndEndInOrderAndTheFlagChangesNothingElse =
	property.exhaust(finite(phaseGen), {
		box: "each phase of the roster, over generate's first draft of the served shop (a login with a reader and a writer role and a ChangeSet) and its check, each run without --phases and with it",
		needs: { phasesNeed },
		situations: [],
		check:
			({ phasesNeed }) =>
			(phase) =>
				Effect.gen(function* () {
					const { unused, generate, check, files } = yield* phasesNeed
					assert.equal(
						unused.length,
						0,
						`a run without --phases reports nothing: ${Arr.join(unused, "\n")}`
					)
					assert.equal(generate.phased.code, 0, generate.phased.stderr)
					assert.equal(
						generate.phased.stdout,
						generate.plain.stdout,
						"generate prints the same report"
					)
					assert.equal(
						generate.phased.stderr,
						generate.plain.stderr,
						"generate prints the same errors"
					)
					assert.deepEqual(files.phased, files.plain, "generate writes byte-identical files")
					assert.equal(check.phased.code, check.plain.code, "check exits the same")
					assert.equal(check.phased.stdout, check.plain.stdout, "check prints the same report")
					assert.equal(check.phased.stderr, check.plain.stderr, "check prints the same findings")
					holdsPhase("generate", generate.lines, phase, phaseNames)
					holdsPhase(
						"check",
						check.lines,
						phase,
						Arr.filter(phaseNames, (p) => p !== "render" && p !== "write")
					)
				}),
		oracle: {
			kind: "specification",
			name: "the pipeline's nesting of its phases and the roster's order; the flagless run's report and files"
		},
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/cli/generate.ts",
				original:
					'\t\tfromEngine(phased(phases, { name: "draft", of: [] }, () => planMigration(input))),',
				replacement: "\t\tfromEngine(planMigration(input)),",
				why: "generate drops the draft phase's report, so a run that dies drafting names the installation instead; the draft case fails."
			},
			{
				file: "packages/grizzle/src/cli/generate.ts",
				original:
					'\t\t\t\tphased(phases, { name: "render", of: [] }, () =>\n\t\t\t\t\trenderMigration(planned, naming, timestamp)\n\t\t\t\t)',
				replacement: "\t\t\t\trenderMigration(planned, naming, timestamp)",
				why: "generate drops the render phase's report, so a run that dies rendering its folder names the served files instead; the render case fails."
			},
			{
				file: "packages/engine/src/core/phase.ts",
				original: '\tconst result = run()\n\tphases.report(phase, "end")',
				replacement: '\tphases.report(phase, "end")\n\tconst result = run()',
				why: "an engine phase reports its end before its work, so the phases inside it start outside it; the workloadLogin case fails."
			},
			{
				file: "packages/grizzle/src/cli/args.ts",
				original: '\t\t\tcommand: { kind: command },\n\t\t\tphases: scanned.switches.has("phases")',
				replacement: "\t\t\tcommand: { kind: command },\n\t\t\tphases: false",
				why: "check accepts --phases and reports nothing; every case fails on check's lines."
			}
		]
	})
