import { array, boolean, constant, element, type Gen, int, oneOf } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import {
	Array as Arr,
	Cause,
	Effect,
	Exit,
	FileSystem,
	Option,
	Order,
	Path,
	PlatformError,
	String as Str
} from "effect"
import { assert, defined } from "#test/support/assert.ts"
import {
	batchOwned,
	type Checking,
	caseOwned,
	checkedBatch,
	type Judged,
	type Owner,
	type Part,
	type Problem,
	type Program,
	type ProgramModule,
	problemText,
	type TypesDisagreed
} from "#test/types/batch/batch.ts"
import type { Reading } from "#test/types/batch/compiler.ts"
import { type FileLine, lineKey } from "#test/types/batch/directives.ts"

/**
 * What a planted line's declaration raises: nothing, TS2322 (a string where a number is declared) or TS2741 (an object
 * missing the property its declared type requires).
 */
const RAISES = ["nothing", "TS2322", "TS2741"] as const

type Raises = (typeof RAISES)[number]

/** A twin's labels: two, so a program may hold two twins, each on one line or on several. */
const LABELS = ["a", "b"] as const

/** The directive over a planted line: none; a code claim, always of TS2322; refused; or a twin of a label. */
type Over =
	| Readonly<{ kind: "none" | "code" | "refused" }>
	| Readonly<{ kind: "twin"; label: (typeof LABELS)[number] }>

/** A planted line: what its declaration raises, the directive over it, and who answers for both. */
type PlantedLine = Readonly<{ raises: Raises; over: Over; owner: Owner }>

/**
 * A planted program: how it is checked, how many cases its batch holds, its modules (the first its entry), a file
 * outside the program that its entry imports, whether that file raises a diagnostic, and whether the checkout and the
 * program's directory are spelled through symbolic links.
 */
export type PlantedProgram = Readonly<{
	checking: Checking
	cases: number
	modules: Arr.NonEmptyReadonlyArray<Arr.NonEmptyReadonlyArray<PlantedLine>>
	unowned: Option.Option<Readonly<{ raises: boolean }>>
	symlinked: boolean
}>

/** What a planted program reaches. */
export type AttributionFeature =
	| "an armed program"
	| "a disarmed program"
	| "two modules"
	| "an unused directive"
	| "a code its directive does not claim"
	| "a refused line"
	| "twins that agree"
	| "twins that differ"
	| "a twin alone"
	| "a twin across owners"
	| "an unowned file that raises"
	| "an unowned file that raises nothing"
	| "a symlinked root"
	| "a case that agrees beside one that disagrees"
	| "the batch's own lines disagreeing"

/**
 * A line's directive in a program of twins, whose directed lines are all twins, so its labels meet one another; in a
 * program of single directives; and in a program of none.
 */
const twinOver: Gen<Over> = oneOf<Over>([
	constant<Over>({ kind: "none" }),
	(source) => ({ kind: "twin", label: source.draw(element(LABELS)) })
])

const singleOver: Gen<Over> = oneOf<Over>([
	constant<Over>({ kind: "none" }),
	constant<Over>({ kind: "code" }),
	constant<Over>({ kind: "refused" })
])

const bareOver: Gen<Over> = constant<Over>({ kind: "none" })

/** How a program's lines are directed: none of them, each alone, or as twins, each arm as often as the others. */
const programOver: Gen<Gen<Over>> = oneOf<Gen<Over>>([
	constant(bareOver),
	constant(singleOver),
	constant(twinOver)
])

/** The owner of a planted line among a batch of `cases` cases: the batch, or one case, as often as each other. */
const ownerOf = (cases: number): Gen<Owner> =>
	oneOf<Owner>([constant(batchOwned), (source) => caseOwned(source.draw(int(0, cases - 1)))])

const lineOf =
	(over: Gen<Over>, owner: Gen<Owner>): Gen<PlantedLine> =>
	(source) => ({
		raises: source.draw(element(RAISES)),
		over: source.draw(over),
		owner: source.draw(owner)
	})

/** A planted module's lines: one to four. */
const moduleLines =
	(line: Gen<PlantedLine>): Gen<Arr.NonEmptyReadonlyArray<PlantedLine>> =>
	(source) =>
		Arr.prepend(source.draw(array(line, { min: 0, max: 3 })), source.draw(line))

/**
 * A planted program: one or two modules of lines owned by its batch or by one of up to three cases, checked armed or
 * disarmed, so each case reaches several of the situations the search requires.
 */
export const plantedProgram: Gen<PlantedProgram> = (source) => {
	const checking = source.draw(element<Checking>(["armed", "disarmed"]))
	const cases = source.draw(int(1, 3))
	const line = lineOf(source.draw(programOver), ownerOf(cases))
	const modules = Arr.prepend(
		source.draw(array(moduleLines(line), { min: 0, max: 1 })),
		source.draw(moduleLines(line))
	)
	const unowned = source.draw(boolean)
		? Option.some({ raises: source.draw(boolean) })
		: Option.none()
	return { checking, cases, modules, unowned, symlinked: source.draw(boolean) }
}

/** A declaration that raises what `raises` names. */
const declaration = (raises: Raises, index: number): string => {
	switch (raises) {
		case "nothing":
			return `export const v${index}: number = 1`
		case "TS2322":
			return `export const v${index}: number = "s"`
		case "TS2741":
			return `export const v${index}: { readonly a: number } = {}`
	}
}

/** The directive line over a planted line, if it has one. */
const directiveOf = (over: Over): ReadonlyArray<string> => {
	switch (over.kind) {
		case "none":
			return []
		case "code":
			return ["// @ts-expect-error -- TS2322: the declared type refuses the value"]
		case "refused":
			return ["// @ts-expect-error -- refused: the declared type refuses the value"]
		case "twin":
			return [`// @ts-expect-error -- twin ${over.label}: one probe at two places`]
	}
}

/** The file a planted module is: the program's entry, then its second module. */
const fileOf = (index: number): string => (index === 0 ? "index.ts" : "m1.ts")

/** The file outside the program its entry imports. */
const unownedFile = "planted.ts"

/** The entry's import of the file outside the program, and its use of it, the batch's own lines. */
const unownedHeader: ReadonlyArray<string> = [
	`import { planted } from "./${unownedFile}"`,
	"export const read: number = planted"
]

/** A planted line as written: its module, the line its directive sits on, and the line of its declaration. */
type Written = Readonly<{
	file: string
	planted: PlantedLine
	directive: number
	statement: number
}>

/** The header of the planted program's module at `index`: the unowned import, in the entry alone. */
const headerOf = (planted: PlantedProgram, index: number): ReadonlyArray<string> =>
	index === 0 && Option.isSome(planted.unowned) ? unownedHeader : []

/** The planted program as the batch checks it: each module, its header the batch's, each line its owner's. */
const programOf = (planted: PlantedProgram): Program =>
	Arr.map(planted.modules, (lines, index): ProgramModule => ({
		file: fileOf(index),
		parts: [
			{ owner: batchOwned, lines: headerOf(planted, index) },
			...Arr.map(lines, (line, k): Part => ({
				owner: line.owner,
				lines: [...directiveOf(line.over), declaration(line.raises, k)]
			}))
		]
	}))

/** Every planted line as written, in program order. */
const writtenOf = (planted: PlantedProgram): ReadonlyArray<Written> =>
	Arr.flatMap(planted.modules, (lines, index) => {
		let at = headerOf(planted, index).length
		return Arr.map(lines, (line): Written => {
			const directive = at + directiveOf(line.over).length
			at = directive + 1
			return { file: fileOf(index), planted: line, directive, statement: at }
		})
	})

/** Whether two owners are one. */
const sameOwner = (a: Owner, b: Owner): boolean =>
	a.kind === "batch" ? b.kind === "batch" : b.kind === "case" && b.at === a.at

/** An owner's lines as a verdict compares them: promised lines, error lines and problems, each sorted. */
type JudgedView = Readonly<{
	expected: ReadonlyArray<string>
	actual: ReadonlyArray<string>
	problems: ReadonlyArray<string>
}>

/**
 * A case's verdict as compared: it agrees; it disagrees, with its own lines, the batch's and whether each line no line
 * of the program owns names the file outside it; or it died, a defect, with its cause.
 */
export type VerdictView =
	| Readonly<{ kind: "agrees" }>
	| Readonly<{ kind: "died"; cause: string }>
	| Readonly<{
			kind: "disagrees"
			own: JudgedView
			batch: JudgedView
			unowned: ReadonlyArray<boolean>
	  }>

const viewOf = (judged: Judged): JudgedView => ({
	expected: judged.expected,
	actual: judged.actual,
	problems: Arr.sort(Arr.map(judged.problems, problemText), Order.String)
})

const agreeing = (view: JudgedView): boolean =>
	!Arr.isReadonlyArrayNonEmpty(view.problems) &&
	Arr.join(view.expected, "\n") === Arr.join(view.actual, "\n")

/** What a line raises, as a twin compares lines. */
const raisedAt = (raises: Raises): ReadonlyArray<string> => (raises === "nothing" ? [] : [raises])

/** A problem, and every owner who answers for it. */
type Owned = Readonly<{ problem: Problem; owners: ReadonlyArray<Owner> }>

/** The model's judgement of every owner of a planted program: what each owner's lines come to, as compared. */
const modelOf = (planted: PlantedProgram) => {
	const written = writtenOf(planted)
	const disarmed = planted.checking === "disarmed"
	const errors = Arr.flatMap(
		written,
		({ file, planted: line, directive, statement }): ReadonlyArray<FileLine & { owner: Owner }> => {
			if (disarmed || line.over.kind === "none") {
				return line.raises === "nothing" ? [] : [{ file, line: statement, owner: line.owner }]
			}
			return line.raises === "nothing" ? [{ file, line: directive, owner: line.owner }] : []
		}
	)
	const directed = disarmed
		? Arr.filter(written, ({ planted: line }) => line.over.kind !== "none")
		: []
	const coded = Arr.flatMap(directed, ({ file, planted: line, statement }): ReadonlyArray<Owned> =>
		line.over.kind === "code" && line.raises === "TS2741"
			? [
					{
						problem: {
							kind: "code",
							at: { file, line: statement },
							claimed: "TS2322",
							raised: ["TS2741"]
						},
						owners: [line.owner]
					}
				]
			: []
	)
	const twins = Arr.flatMap(LABELS, (label): ReadonlyArray<Owned> => {
		const of = Arr.filter(
			directed,
			({ planted: line }) => line.over.kind === "twin" && line.over.label === label
		)
		const owners = Arr.map(of, ({ planted: line }) => line.owner)
		const [first, ...rest] = of
		if (first === undefined) {
			return []
		}
		if (!Arr.isReadonlyArrayNonEmpty(rest)) {
			return [
				{
					problem: { kind: "twin alone", label, at: { file: first.file, line: first.statement } },
					owners
				}
			]
		}
		return Arr.every(rest, ({ planted: line }) => line.raises === first.planted.raises)
			? []
			: [
					{
						problem: {
							kind: "twins differ",
							label,
							lines: Arr.map(of, ({ file, planted: line, statement }) => ({
								at: { file, line: statement },
								raised: raisedAt(line.raises)
							}))
						},
						owners
					}
				]
	})
	const keys = (places: ReadonlyArray<FileLine>): ReadonlyArray<string> =>
		Arr.sort(Arr.dedupe(Arr.map(places, lineKey)), Order.String)
	const judgedOf = (owner: Owner): JudgedView => ({
		expected: keys(
			Arr.flatMap(directed, ({ file, planted: line, statement }) =>
				sameOwner(line.owner, owner) ? [{ file, line: statement }] : []
			)
		),
		actual: keys(Arr.filter(errors, (e) => sameOwner(e.owner, owner))),
		problems: Arr.sort(
			Arr.flatMap([...coded, ...twins], ({ problem, owners }) =>
				Arr.some(owners, (o) => sameOwner(o, owner)) ? [problemText(problem)] : []
			),
			Order.String
		)
	})
	const raising = Option.exists(planted.unowned, ({ raises }) => raises)
	const batch = judgedOf(batchOwned)
	const cases = Array.from({ length: planted.cases }, (_, at) => judgedOf(caseOwned(at)))
	const verdicts = Arr.map(cases, (own): VerdictView =>
		agreeing(own) && agreeing(batch) && !raising
			? { kind: "agrees" }
			: { kind: "disagrees", own, batch, unowned: raising ? [true] : [] }
	)
	return { batch, cases, verdicts, twins }
}

/** What a planted program reaches: its form, its directives' claims, its twins, and its owners' verdicts. */
export const attributionNotes = (planted: PlantedProgram): ReadonlyArray<AttributionFeature> => {
	const written = writtenOf(planted)
	const disarmed = planted.checking === "disarmed"
	const model = modelOf(planted)
	const twinsOf = (label: string) =>
		Arr.filter(
			written,
			({ planted: line }) => line.over.kind === "twin" && line.over.label === label
		)
	const agreeingTwins = Arr.some(LABELS, (label) => {
		const [first, ...rest] = twinsOf(label)
		return (
			first !== undefined &&
			Arr.isReadonlyArrayNonEmpty(rest) &&
			Arr.every(rest, ({ planted: line }) => line.raises === first.planted.raises)
		)
	})
	const acrossOwners = Arr.some(LABELS, (label) => {
		const [first, ...rest] = twinsOf(label)
		return (
			first !== undefined &&
			Arr.some(rest, ({ planted: line }) => !sameOwner(line.owner, first.planted.owner))
		)
	})
	const ownDisagreeing = Arr.some(model.cases, (own) => !agreeing(own))
	const ownAgreeing = Arr.some(model.cases, agreeing)
	const when = (holds: boolean, feature: AttributionFeature): ReadonlyArray<AttributionFeature> =>
		holds ? [feature] : []
	const some = (holds: (line: PlantedLine) => boolean): boolean =>
		Arr.some(written, ({ planted: line }) => holds(line))
	return [
		...when(disarmed, "a disarmed program"),
		...when(!disarmed, "an armed program"),
		...when(planted.modules.length > 1, "two modules"),
		...when(
			!disarmed && some((line) => line.raises === "nothing" && line.over.kind !== "none"),
			"an unused directive"
		),
		...when(
			disarmed && some((line) => line.over.kind === "code" && line.raises === "TS2741"),
			"a code its directive does not claim"
		),
		...when(disarmed && some((line) => line.over.kind === "refused"), "a refused line"),
		...when(disarmed && agreeingTwins, "twins that agree"),
		...Arr.map(model.twins, ({ problem }): AttributionFeature =>
			problem.kind === "twin alone" ? "a twin alone" : "twins that differ"
		),
		...when(disarmed && acrossOwners, "a twin across owners"),
		...when(
			Option.exists(planted.unowned, ({ raises }) => raises),
			"an unowned file that raises"
		),
		...when(
			Option.exists(planted.unowned, ({ raises }) => !raises),
			"an unowned file that raises nothing"
		),
		...when(planted.symlinked, "a symlinked root"),
		...when(
			agreeing(model.batch) && ownAgreeing && ownDisagreeing,
			"a case that agrees beside one that disagrees"
		),
		...when(!agreeing(model.batch), "the batch's own lines disagreeing")
	]
}

/** A case's verdict as it settled, compared as the model states it: a verdict that died is a defect, as it ran. */
const verdictViewOf = (exit: Exit.Exit<void, TypesDisagreed>): VerdictView =>
	Exit.isSuccess(exit)
		? { kind: "agrees" }
		: Option.match(Exit.findErrorOption(exit), {
				onNone: (): VerdictView => ({ kind: "died", cause: Cause.pretty(exit.cause) }),
				onSome: (failure): VerdictView => ({
					kind: "disagrees",
					own: viewOf(failure.judged),
					batch: viewOf(failure.batch),
					unowned: Arr.map(failure.unattributed, Str.startsWith(`${unownedFile}(`))
				})
			})

/**
 * Writes a planted program into the case's directory `dir`, beside the file outside it, checks it through the batch
 * against the repository, both spelled through symbolic links when the case says so, and holds each case's verdict
 * to the model's.
 */
export const attributed = (planted: PlantedProgram, c: Case<AttributionFeature>, dir: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		c.noteAll(attributionNotes(planted))
		const repository = yield* fs.realPath(path.resolve(import.meta.dirname, "../../.."))
		const programDir = path.join(dir, "program")
		yield* fs.makeDirectory(programDir)
		yield* Option.match(planted.unowned, {
			onNone: () => Effect.void,
			onSome: ({ raises }) =>
				fs.writeFileString(
					path.join(programDir, unownedFile),
					`export const planted: number = ${raises ? '"s"' : "1"}\n`
				)
		})
		if (planted.symlinked) {
			yield* fs.symlink(repository, path.join(dir, "repository"))
			yield* fs.symlink(programDir, path.join(dir, "linked"))
		}
		const spelled = planted.symlinked
			? { checkout: path.join(dir, "repository"), program: path.join(dir, "linked") }
			: { checkout: repository, program: programDir }
		const program = programOf(planted)
		const verdicts = yield* checkedBatch(
			spelled.checkout,
			spelled.program,
			planted.checking,
			planted.cases,
			() => program
		)
		const settled = yield* Effect.forEach(verdicts, (verdict) => Effect.exit(verdict))
		assert.deepEqual(Arr.map(settled, verdictViewOf), modelOf(planted).verdicts)
	})

/**
 * What a planted check runs: tsgo over a tiny program, clean or raising, checked once or held in watch mode; or a
 * command whose work runs in a child, busy until its window and one reading more have passed, while its own process
 * waits for it, as tsc's Node wrapper waits for tsgo.
 */
type PlantedWork =
	| Readonly<{ kind: "check"; raises: boolean; watch: boolean }>
	| Readonly<{ kind: "busy child" }>

/** A planted check: its work, under a drawn window and a drawn interval between readings. */
export type PlantedCheck = Readonly<{
	work: PlantedWork
	windowMillis: number
	everyMillis: number
}>

const plantedWork: Gen<PlantedWork> = oneOf<PlantedWork>([
	(source) => ({ kind: "check", raises: source.draw(boolean), watch: source.draw(boolean) }),
	constant<PlantedWork>({ kind: "busy child" })
])

/**
 * How long one case of the stall guard's property may run: a planted tsgo check of a tiny program, once or in watch
 * mode until its guard's window passes idle, or a busy child past its window, then the kill a window later. Its work is
 * a few seconds of one process's CPU, so its time is the machine's contention, and the runner's 60 s deadline cut one
 * honest case at a load of 755 to 820.
 *
 * @limitKind measured
 * @owner the type tier's stall guard property (test/types/batch/batch.test.ts stallGuard)
 * @unit milliseconds
 * @scope one case of stallGuard: one planted command run to its end or to its stall under a drawn window of 1 to 3 s
 * @evidence ~/.cache/grizzle-release/TESTSYS/GZ-TYPES/measure/run-full.txt (toolchain-test run test/types, the case
 *   hung past 60 s) and three replays of its token with GNU time
 * @observed 2026-11-16, 04:44 to 05:06 UTC
 * @environment cassowary, Ubuntu 26.04 arm64, 64 cores, Node 26.13, TypeScript 7.1.0-beta (tsgo), toolchain 31fa236;
 *   load average 580 to 820 from other sessions, 230 of 247 GB in use during the full run
 * @workload the case {work: tsgo --watch over a raising program, window 1,822 ms, every 68 ms} inside the whole type
 *   tier's run (51 properties, up to 79 tsgo processes of the run at once), then alone by replay
 * @result inside the full run it ran past the runner's 60 s case deadline; replayed alone it passed in 11.0, 11.0 and
 *   25.7 s of wall with 4.5 to 4.6 s of CPU, the runner's start included
 * @decision 300 s, more than ten times its slowest replay, so the case finishes on a machine as loaded as the full
 *   run's; a planted check that never stalls or never ends is still reported, by the guard's own window or by this
 *   deadline
 * @revalidate a TypeScript 7 or tsgo upgrade; another machine; a planted window above 3 s
 */
export const stallCaseDeadline = 300_000

export const plantedCheck: Gen<PlantedCheck> = (source) => ({
	work: source.draw(plantedWork),
	windowMillis: source.draw(int(1000, 3000)),
	everyMillis: source.draw(int(50, 300))
})

/** What a planted check reaches: a stall, a check to its end, or a busy child's work past its window. */
export type StallFeature =
	| "stalled"
	| "checked clean"
	| "checked with an error"
	| "worked past its window"

export const stallFeatureOf = (work: PlantedWork): StallFeature => {
	switch (work.kind) {
		case "check":
			return work.watch ? "stalled" : work.raises ? "checked with an error" : "checked clean"
		case "busy child":
			return "worked past its window"
	}
}

/**
 * A busy child's two scripts: the parent starts the child (its first argument) with the milliseconds (its second) and
 * waits for it, then exits as the child did; the child spins until those milliseconds have passed on the clock.
 */
export const busyScripts = {
	parent:
		'import { spawnSync } from "node:child_process"\nconst { status } = spawnSync(process.execPath, [process.argv[2], process.argv[3]], { stdio: "inherit" })\nprocess.exit(status ?? 1)\n',
	child: "const end = Date.now() + Number(process.argv[2])\nwhile (Date.now() < end) {}\n"
} as const

/** A thread of a planted process tree: its id, its state as proc(5) prints it, and the processes it started. */
type PlantedTask = Readonly<{
	tid: number
	state: "R" | "S" | "D"
	children: ReadonlyArray<number>
}>

/**
 * A process of a planted tree: its pid, its command's name, which may hold a parenthesis, its own user and system time
 * and its waited-for children's, in clock ticks, and its threads.
 */
type PlantedProcess = Readonly<{
	pid: number
	comm: string
	times: readonly [number, number, number, number]
	tasks: ReadonlyArray<PlantedTask>
}>

/** How a /proc file of a planted tree fails once the task it describes has ended: reaped, or exited and not yet. */
type Ended = "ENOENT" | "ESRCH"

/**
 * A planted process tree as /proc shows it mid-reading: its processes, the first its root, each later one a child of a
 * thread of an earlier one, and the files whose task has ended by the time the reader reaches them.
 */
export type PlantedTree = Readonly<{
	processes: ReadonlyArray<PlantedProcess>
	ended: ReadonlyArray<readonly [string, Ended]>
}>

/** What a planted tree's reading reaches. */
export type TreeFeature =
	| "a thread ended as it was read"
	| "a process reaped as it was read"
	| "a busy child under a waiting parent"
	| "a command name holding a parenthesis"

/** A planted tree's files, each by its path: a process's stat and task directory, each thread's stat and children. */
const treeFiles = (processes: ReadonlyArray<PlantedProcess>): ReadonlyArray<string> =>
	Arr.flatMap(processes, (p) => [
		`/proc/${p.pid}/stat`,
		`/proc/${p.pid}/task`,
		...Arr.flatMap(p.tasks, (t) => [
			`/proc/${p.pid}/task/${t.tid}/stat`,
			`/proc/${p.pid}/task/${t.tid}/children`
		])
	])

/**
 * How a planted tree is drawn: freely, each thread's state and each file's fate drawn; or as a check under tsc's Node
 * wrapper, whose root's threads all sleep while a child it started runs, every file of the two standing.
 */
type TreeArm = "drawn" | "waiting parent"

export const plantedTree: Gen<PlantedTree> = (source) => {
	const arm = source.draw(element<TreeArm>(["drawn", "waiting parent"]))
	const count = source.draw(int(arm === "drawn" ? 1 : 2, 4))
	const shapes = Array.from({ length: count }, (_, i) => ({
		pid: 100 + i,
		comm: source.draw(element(["tsgo", "node", "a) b", "(x)"])),
		times: [
			source.draw(int(0, 2500)),
			source.draw(int(0, 2500)),
			source.draw(int(0, 2500)),
			source.draw(int(0, 2500))
		] as const,
		threads: source.draw(int(1, 3)),
		states: Array.from({ length: 3 }, (_, k) =>
			arm === "waiting parent" && i === 0
				? "S"
				: arm === "waiting parent" && i === 1 && k === 0
					? "R"
					: source.draw(element(["R", "S", "D"] as const))
		),
		parent: i === 0 ? 0 : arm === "waiting parent" && i === 1 ? 0 : source.draw(int(0, i - 1)),
		at: source.draw(int(0, 2))
	}))
	const processes = Arr.map(shapes, (shape, s): PlantedProcess => ({
		pid: shape.pid,
		comm: shape.comm,
		times: shape.times,
		tasks: Array.from({ length: shape.threads }, (_, k) => ({
			tid: k === 0 ? shape.pid : shape.pid * 10 + k,
			state: defined(shape.states[k], "a thread's state"),
			children: Arr.flatMap(shapes, (child, c) =>
				c > 0 && child.parent === s && child.at % shape.threads === k ? [child.pid] : []
			)
		}))
	}))
	const standing = new Set(arm === "waiting parent" ? treeFiles(Arr.take(processes, 2)) : [])
	const ended = Arr.flatMap(
		treeFiles(processes),
		(file): ReadonlyArray<readonly [string, Ended]> => {
			if (standing.has(file)) {
				return []
			}
			const fate = source.draw(element(["stands", "ENOENT", "ESRCH"] as const))
			return fate === "stands" ? [] : [[file, fate]]
		}
	)
	return { processes, ended }
}

/** A planted file's stat line: its process's or thread's id, command, state and times, in proc(5)'s fields. */
const statLine = (
	id: number,
	comm: string,
	state: string,
	times: readonly [number, number, number, number]
): string =>
	`${id} (${comm}) ${state} 1 ${id} ${id} 0 -1 4194560 0 0 0 0 ${Arr.join(Arr.map(times, String), " ")} 20 0 1 0 0 0 0\n`

/** The planted tree as a file system that reads only /proc: each file as it stands, or failing as its task ended. */
export const plantedProc = (tree: PlantedTree): FileSystem.FileSystem => {
	const ended = new Map(tree.ended)
	const byPid = new Map(Arr.map(tree.processes, (p) => [p.pid, p] as const))
	const fail = (method: string, path: string, errno: Ended) =>
		Effect.fail(
			PlatformError.systemError({
				_tag: errno === "ENOENT" ? "NotFound" : "Unknown",
				module: "FileSystem",
				method,
				pathOrDescriptor: path,
				cause: { code: errno }
			})
		)
	const parts = (path: string): ReadonlyArray<string> =>
		Arr.filter(Str.split(path, "/"), (x) => x !== "")
	return FileSystem.makeNoop({
		readFileString: (path) => {
			const gone = ended.get(path)
			if (gone !== undefined) {
				return fail("readFileString", path, gone)
			}
			const [, pid, third, tid, file] = parts(path)
			const owner = byPid.get(Number(pid))
			if (owner === undefined) {
				return fail("readFileString", path, "ENOENT")
			}
			if (third === "stat") {
				return Effect.succeed(statLine(owner.pid, owner.comm, "S", owner.times))
			}
			const thread = Number(tid)
			const task = Arr.findFirst(owner.tasks, (t) => t.tid === thread)
			return Option.match(task, {
				onNone: () => fail("readFileString", path, "ENOENT"),
				onSome: (t) =>
					Effect.succeed(
						file === "stat"
							? statLine(t.tid, owner.comm, t.state, [0, 0, 0, 0])
							: Arr.join(
									Arr.map(t.children, (c) => `${c} `),
									""
								)
					)
			})
		},
		readDirectory: (path) => {
			const gone = ended.get(path)
			if (gone !== undefined) {
				return fail("readDirectory", path, gone)
			}
			const [, pid] = parts(path)
			return Option.match(Option.fromUndefinedOr(byPid.get(Number(pid))), {
				onNone: () => fail("readDirectory", path, "ENOENT"),
				onSome: (p) => Effect.succeed(Arr.map(p.tasks, (t) => String(t.tid)))
			})
		}
	})
}

/**
 * The model's reading of the planted tree at `pid`: none once its stat has ended; otherwise busy where a thread whose
 * stat stands runs, waits for a CPU or on the disk, or a child's reading is busy, and its ticks its own four times and
 * every standing child's, each child read where its thread's children file stands.
 */
export const modelReading = (tree: PlantedTree, pid: number): Option.Option<Reading> => {
	const ended = new Set(Arr.map(tree.ended, ([file]) => file))
	const at = (id: number): Option.Option<Reading> =>
		Option.flatMap(
			Arr.findFirst(tree.processes, (p) => p.pid === id),
			(p) => {
				if (ended.has(`/proc/${p.pid}/stat`)) {
					return Option.none()
				}
				const tasks = ended.has(`/proc/${p.pid}/task`) ? [] : p.tasks
				const children = Arr.getSomes(
					Arr.flatMap(tasks, (t) =>
						ended.has(`/proc/${p.pid}/task/${t.tid}/children`) ? [] : Arr.map(t.children, at)
					)
				)
				return Option.some({
					busy:
						Arr.some(
							tasks,
							(t) => !ended.has(`/proc/${p.pid}/task/${t.tid}/stat`) && t.state !== "S"
						) || Arr.some(children, (c) => c.busy),
					ticks: Arr.reduce(
						children,
						Arr.reduce(p.times, 0, (sum, t) => sum + t),
						(sum, c) => sum + c.ticks
					)
				})
			}
		)
	return at(pid)
}

/** What a planted tree reaches, by its ended files and its processes. */
export const treeFeatures = (tree: PlantedTree): ReadonlyArray<TreeFeature> => {
	const ended = new Map(tree.ended)
	const root = defined(tree.processes[0], "the tree's root")
	const waiting = Arr.every(
		root.tasks,
		(t) => t.state === "S" || ended.has(`/proc/${root.pid}/task/${t.tid}/stat`)
	)
	return [
		...(Arr.some(tree.ended, ([file, errno]) => errno === "ESRCH" && Str.includes("/task/")(file))
			? (["a thread ended as it was read"] as const)
			: []),
		...(Arr.some(tree.ended, ([file, errno]) => errno === "ENOENT" && Str.endsWith("/stat")(file))
			? (["a process reaped as it was read"] as const)
			: []),
		...(waiting && Option.exists(modelReading(tree, root.pid), (r) => r.busy)
			? (["a busy child under a waiting parent"] as const)
			: []),
		...(Arr.some(tree.processes, (p) => Str.includes(")")(p.comm))
			? (["a command name holding a parenthesis"] as const)
			: [])
	]
}
