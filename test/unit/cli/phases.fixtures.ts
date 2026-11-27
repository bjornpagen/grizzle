/** What the property of phases.test.ts reads: generate and check run with and without `--phases`, and their lines read. */

import { assert, nonEmpty } from "@bjornpagen/testing/assert"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { type Need, NeedFailed } from "@bjornpagen/testing/property"
import { regex } from "arkregex"
import {
	Array as Arr,
	Cause,
	Effect,
	FileSystem,
	Order,
	type PlatformError,
	String as Str
} from "effect"
import { processMeter } from "#cli/main.ts"
import type { PhaseMeter } from "#cli/phases.ts"
import { type PhaseEdge, type PhaseName, phaseNames } from "#compiler/core/phase.ts"
import { cliMetered, configName, workspace } from "#test/pg/cli/support.ts"
import { fixtureNeedBudget } from "#test/support/budgets.ts"
import { config } from "#test/unit/cli/served.fixtures.ts"

/**
 * The phase each phase runs inside, as the pipeline nests them: none for a phase of the whole run, and the schema's
 * draft or check for each step of it.
 */
const parentOf: { readonly [P in PhaseName]: PhaseName | undefined } = {
	config: undefined,
	schema: undefined,
	build: "schema",
	basis: "schema",
	workload: "schema",
	workloadLogin: "workload",
	changes: "schema",
	loginChanges: "changes",
	frontEnd: "loginChanges",
	changeSet: "loginChanges",
	certification: "changes",
	installation: "schema",
	installPlan: "installation",
	judge: "installation",
	indexes: "installation",
	draft: "schema",
	served: "schema",
	servedLogin: "served",
	render: "schema",
	write: undefined
}

/** One boundary a run reported: the phase's name, what it is of, its edge, and the heap it read, in megabytes. */
export interface Boundary {
	readonly name: string
	readonly label: string
	readonly edge: PhaseEdge
	readonly heapUsed: number
}

/** A reading's value as a line prints it: seconds to a thousandth, megabytes to a tenth. */
const seconds = regex("^[0-9]+\\.[0-9]{3}$")
const megabytes = regex("^[0-9]+\\.[0-9]$")

/** The fields after a line's edge, each with the form of its value, in the order the line states them. */
const readingFields = [
	["t", seconds],
	["cpu", seconds],
	["heapUsed", megabytes],
	["heapTotal", megabytes],
	["rss", megabytes],
	["external", megabytes]
] as const

/** The value of `field` among a line's `words`, at `at`, refused unless the word is `<field>=<value>` of its form. */
const valueAt = (
	words: ReadonlyArray<string>,
	at: number,
	field: string,
	form: RegExp,
	line: string
): number => {
	const word = words[at] ?? ""
	const value = Str.slice(field.length + 1)(word)
	assert.ok(
		Str.startsWith(`${field}=`)(word) && form.test(value),
		`${field} at word ${at} of: ${line}`
	)
	return Number(value)
}

/** The heap a line read, its readings each refused unless of its form, from word `from` on. */
const heapOf = (words: ReadonlyArray<string>, from: number, line: string): number => {
	for (const [i, [field, form]] of readingFields.entries()) {
		valueAt(words, from + i, field, form, line)
	}
	return valueAt(words, from + 2, "heapUsed", megabytes, line)
}

/**
 * A run's lines read: every boundary in order, `grizzle phase <name>[/<of>…] <start|end> t=… cpu=… heapUsed=…
 * heapTotal=… rss=… external=…`, then the done line, `grizzle phase done <the same readings> peakHeapUsed=<MB>`, and
 * the peak it states; refused unless every line reads so.
 */
export const readLines = (
	lines: ReadonlyArray<string>
): { readonly boundaries: ReadonlyArray<Boundary>; readonly peak: number } => {
	const all = nonEmpty(lines, "the run's phase lines")
	const done = Arr.lastNonEmpty(all)
	const doneWords = Str.split(done, " ")
	assert.ok(
		doneWords.length === 10 &&
			doneWords[0] === "grizzle" &&
			doneWords[1] === "phase" &&
			doneWords[2] === "done",
		`the last line is the done line: ${done}`
	)
	heapOf(doneWords, 3, done)
	const peak = valueAt(doneWords, 9, "peakHeapUsed", megabytes, done)
	const boundaries = Arr.map(Arr.initNonEmpty(all), (line) => {
		const words = Str.split(line, " ")
		const label = words[2] ?? ""
		const edge = words[3]
		assert.ok(
			words.length === 10 &&
				words[0] === "grizzle" &&
				words[1] === "phase" &&
				(edge === "start" || edge === "end"),
			`a phase line: ${line}`
		)
		const boundary: Boundary = {
			label,
			name: Str.split(label, "/")[0],
			edge: edge === "start" ? "start" : "end",
			heapUsed: heapOf(words, 4, line)
		}
		return boundary
	})
	return { boundaries, peak }
}

/** Each phase of the roster. */
export const phaseGen: Gen<PhaseName> = (source) => source.draw(element(phaseNames))

/** A meter reading the process as the bin does, its lines kept in `lines`. */
const recordingMeter = (lines: Array<string>): PhaseMeter => ({
	read: processMeter.read,
	write: (line) => {
		lines.push(line)
	}
})

/** Every file under `dir`, by its path below it, with its text. */
const filesUnder = (
	fs: FileSystem.FileSystem,
	dir: string
): Effect.Effect<ReadonlyArray<readonly [string, string]>, PlatformError.PlatformError> =>
	Effect.gen(function* () {
		const listed = yield* fs.readDirectory(dir, { recursive: true })
		const files: Array<readonly [string, string]> = []
		for (const name of Arr.sort(listed, Order.String)) {
			const info = yield* fs.stat(`${dir}/${name}`)
			if (info.type === "File") {
				const text = yield* fs.readFileString(`${dir}/${name}`)
				files.push([name, text])
			}
		}
		return files
	})

/**
 * generate's first draft of the served shop and its check, each run in a workspace of its own without `--phases` and in
 * another with it: what each printed, the files each generate wrote, and the lines each run with the flag reported.
 */
export const phasesNeed = {
	key: "test/unit/cli/phases.fixtures.ts phasesNeed",
	budget: fixtureNeedBudget,
	runNeeds: [],
	open: Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const plain = yield* workspace("phases-plain")
		const phased = yield* workspace("phases-phased")
		const unused: Array<string> = []
		const generated: Array<string> = []
		const checked: Array<string> = []
		const generate = ["generate", configName, "--name", "init"]
		const plainGenerate = yield* cliMetered(plain, config, generate, recordingMeter(unused))
		const phasedGenerate = yield* cliMetered(
			phased,
			config,
			[...generate, "--phases"],
			recordingMeter(generated)
		)
		const plainCheck = yield* cliMetered(
			plain,
			config,
			["check", configName],
			recordingMeter(unused)
		)
		const phasedCheck = yield* cliMetered(
			phased,
			config,
			["check", "--phases", configName],
			recordingMeter(checked)
		)
		assert.equal(plainGenerate.code, 0, plainGenerate.stderr)
		const plainFiles = yield* filesUnder(fs, `${plain}/migrations`)
		const phasedFiles = yield* filesUnder(fs, `${phased}/migrations`)
		assert.equal(plainCheck.code, 0, plainCheck.stdout)
		return {
			unused,
			generate: { plain: plainGenerate, phased: phasedGenerate, lines: generated },
			check: { plain: plainCheck, phased: phasedCheck, lines: checked },
			files: { plain: plainFiles, phased: phasedFiles }
		}
	}).pipe(
		Effect.mapBoth({
			onFailure: (error) =>
				NeedFailed.make({
					need: "test/unit/cli/phases.fixtures.ts phasesNeed",
					message: Cause.pretty(Cause.fail(error))
				}),
			onSuccess: (made) => Effect.succeed(made)
		})
	)
} as const satisfies Need<unknown>

/**
 * Whether the boundaries nest as the pipeline does, for the phase `phase`: each of its starts opened inside its parent
 * (parentOf) or at the top, and each of its ends closing the phase last opened, its own start; the refusal names the
 * first boundary out of place.
 */
export const nestingFault = (
	boundaries: ReadonlyArray<Boundary>,
	phase: PhaseName
): string | undefined => {
	const open: Array<Boundary> = []
	for (const [i, b] of boundaries.entries()) {
		if (b.edge === "start") {
			const parent = Arr.last(open)
			if (b.name === phase) {
				const inside = parent._tag === "Some" ? parent.value.name : undefined
				if (inside !== parentOf[phase]) {
					return `boundary ${i}: ${b.label} starts inside ${inside ?? "nothing"}, not ${parentOf[phase] ?? "nothing"}`
				}
			}
			open.push(b)
			continue
		}
		const closed = open.pop()
		if (closed === undefined || closed.label !== b.label) {
			return `boundary ${i}: ${b.label} ends where ${closed?.label ?? "nothing"} is open`
		}
	}
	return open.length === 0
		? undefined
		: `${Arr.join(
				Arr.map(open, (b) => b.label),
				", "
			)} never end`
}

/** How many times a run's boundaries start the phase `phase`. */
export const startsOf = (boundaries: ReadonlyArray<Boundary>, phase: PhaseName): number =>
	Arr.filter(boundaries, (b) => b.name === phase && b.edge === "start").length
