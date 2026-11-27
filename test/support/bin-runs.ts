/**
 * Runs of the real `grizzle` bin from projects of their own, each in a process of its own: its time zone and locale,
 * where its project lies, where it runs from and what its configuration file is named, drawn two by two, each pair
 * apart in every one of these (test/unit/cli/draft-determinism.test.ts, test/unit/cli/draft-key.test.ts).
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import { array, element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, FileSystem, String as Str } from "effect"
import { binWith, configName, workspace } from "#test/pg/cli/support.ts"

/**
 * The time zones a run's process is in, each its own offset from UTC or its own daylight saving: UTC, the first and the
 * last offsets of the day (+14, -12), and the quarter and half hours (Nepal, Newfoundland, Lord Howe's half-hour DST).
 */
const zones = [
	"UTC",
	"Pacific/Kiritimati",
	"Etc/GMT+12",
	"Asia/Kathmandu",
	"America/St_Johns",
	"Australia/Lord_Howe"
] as const

/**
 * The locales a run's process is in, LANG and LC_ALL alike: the POSIX locale, its UTF-8 form, and locales whose case
 * mapping, collation or digits part from it (Turkish dotted and dotless i, German, Japanese, Arabic).
 */
const locales = [
	"C",
	"C.UTF-8",
	"en_US.UTF-8",
	"tr_TR.UTF-8",
	"de_DE.UTF-8",
	"ja_JP.UTF-8",
	"ar_SA.UTF-8"
] as const

/** The names a project's configuration file goes by: the one the CLI tests write, or another. */
const configFiles = [configName, "db.config.ts"] as const

/** The segments a project nests under its workspace by: none, or a name, one with a space among them. */
const segments = ["p", "nested-project", "with space"] as const

/** Where a run's bin runs from: the project, the workspace above it, or the checkout's root, naming the file by its path. */
export type Cwd = "the project" | "the workspace" | "the checkout"

/** One run's process: its time zone, its locale, how deep its project lies, where it runs from and its file's name. */
export interface RunEnv {
	readonly zone: (typeof zones)[number]
	readonly locale: (typeof locales)[number]
	readonly nesting: ReadonlyArray<(typeof segments)[number]>
	readonly cwd: Cwd
	readonly config: (typeof configFiles)[number]
}

/** The configuration file name a run's env gives other than the CLI tests' own. */
export const otherConfigName: RunEnv["config"] = "db.config.ts"

/** Two distinct elements of `values`, in a drawn order. */
const twoOf =
	<A>(values: Arr.NonEmptyReadonlyArray<A>): Gen<readonly [A, A]> =>
	(source) => {
		const first = source.draw(int(0, values.length - 1))
		const offset = source.draw(int(1, values.length - 1))
		return [
			defined(values[first], "a drawn element"),
			defined(values[(first + offset) % values.length], "a drawn element")
		] as const
	}

/** A project's nesting under its workspace: up to two segments. */
const nestingGen: Gen<ReadonlyArray<(typeof segments)[number]>> = array(element(segments), {
	min: 0,
	max: 2
})

/** The directories a run runs from. */
const cwds: Arr.NonEmptyReadonlyArray<Cwd> = ["the project", "the workspace", "the checkout"]

/** Two runs' processes, apart in their time zones, their locales and where they run from, each nested on its own. */
export const runPairGen: Gen<readonly [RunEnv, RunEnv]> = (source) => {
	const [zoneA, zoneB] = source.draw(twoOf(zones))
	const [localeA, localeB] = source.draw(twoOf(locales))
	const [cwdA, cwdB] = source.draw(twoOf(cwds))
	const env = (zone: RunEnv["zone"], locale: RunEnv["locale"], cwd: Cwd): RunEnv => ({
		zone,
		locale,
		nesting: source.draw(nestingGen),
		cwd,
		config: source.draw(element(configFiles))
	})
	return [env(zoneA, localeA, cwdA), env(zoneB, localeB, cwdB)] as const
}

/** `runs` with the first run from `cwd`, the second taking the first's where it ran from there too. */
export const firstFrom = (runs: readonly [RunEnv, RunEnv], cwd: Cwd): readonly [RunEnv, RunEnv] => {
	const [first, other] = runs
	return [{ ...first, cwd }, other.cwd === cwd ? { ...other, cwd: first.cwd } : other] as const
}

/** The situations a pair of runs reaches: each directory one runs from, a nesting with a space, another file name. */
export type RunFeature =
	| "run from the project"
	| "run from the workspace"
	| "run from the checkout"
	| "a project nested in a path with a space"
	| "a configuration file of another name"

export const runNotes = (runs: ReadonlyArray<RunEnv>): ReadonlyArray<RunFeature> => [
	...Arr.map(runs, (r): RunFeature => `run from ${r.cwd}` as const),
	...(Arr.some(runs, (r) => Arr.contains(r.nesting, "with space"))
		? (["a project nested in a path with a space"] as const)
		: []),
	...(Arr.some(runs, (r) => r.config !== configName)
		? (["a configuration file of another name"] as const)
		: [])
]

/** A run's project: a directory of its own, at its nesting under a workspace of its own inside the checkout. */
export interface Project {
	readonly env: RunEnv
	readonly workspace: string
	readonly dir: string
}

/** A project for `env`: a scratch workspace inside the checkout, removed when the case ends, and its nesting under it. */
export const projectOf = (env: RunEnv) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const ws = yield* workspace("draftdet")
		const dir = Arr.join([ws, ...env.nesting], "/")
		yield* fs.makeDirectory(dir, { recursive: true })
		const project: Project = { env, workspace: ws, dir }
		return project
	})

/** A project's configuration file, absolute. */
export const configFileOf = (p: Project): string => `${p.dir}/${p.env.config}`

/**
 * The bin of the checkout at `checkout` run as `command` over `argv` for `p`'s project, Node importing `imports` before
 * it with `env` beside its own, in the project's time zone and locale, from where its env runs it, the configuration
 * file named by its path from there; refused but for exit 0. Its stdout and stderr.
 */
export const binIn = (
	checkout: string,
	p: Project,
	command: "generate" | "draft-key",
	argv: ReadonlyArray<string>,
	imports: ReadonlyArray<string>,
	env: Readonly<Record<string, string>>
) =>
	Effect.gen(function* () {
		const relative = Str.slice(p.workspace.length + 1)(configFileOf(p))
		const [dir, config] =
			p.env.cwd === "the project"
				? [p.dir, p.env.config]
				: p.env.cwd === "the workspace"
					? [p.workspace, relative]
					: [checkout, configFileOf(p)]
		const ran = yield* binWith(dir, [command, config, ...argv], imports, {
			...env,
			TZ: p.env.zone,
			LANG: p.env.locale,
			LC_ALL: p.env.locale
		})
		assert.equal(
			ran.status,
			0,
			`grizzle ${command} in ${p.env.zone}, ${p.env.locale}: ${ran.stderr}`
		)
		return ran
	})
