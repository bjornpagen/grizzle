import { Array as Arr, Data, Effect, Option, Path, type PlatformError, String as Str } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { repoRoot } from "#bench/cold/identity.ts"
import { defaultGateDirectories } from "#bench/harness/runner.ts"

export type BenchCommand =
	| {
			readonly kind: "gates"
			readonly quick: boolean
			readonly only: ReadonlyArray<string>
			readonly directories: ReadonlyArray<string>
			readonly outDir: string
			readonly report: boolean
	  }
	| { readonly kind: "list"; readonly directories: ReadonlyArray<string> }
	| { readonly kind: "suite"; readonly suite: Suite; readonly args: ReadonlyArray<string> }
	| { readonly kind: "all"; readonly quick: boolean }
	| { readonly kind: "full" }

/** A command line `pnpm bench` cannot read, and why. */
class UsageError extends Data.TaggedError("UsageError")<{ readonly reason: string }> {}

const usage = (reason: string): Effect.Effect<never, UsageError> =>
	Effect.fail(new UsageError({ reason }))

/**
 * The benchmarks with an entry point of their own: the cold starts, a bytes value's delivery at each chunk length, and,
 * with no database, the subset construction and a large schema's build and compile.
 */
type Suite = "cold" | "dfa" | "compile" | "bytes"

const suiteEntries: Readonly<Record<Suite, string>> = {
	cold: `${repoRoot}/bench/cold/main.ts`,
	dfa: `${repoRoot}/bench/dfa/main.ts`,
	compile: `${repoRoot}/bench/compile/main.ts`,
	bytes: `${repoRoot}/bench/bytes/main.ts`
}

const suiteOf = (command: string | undefined): Option.Option<Suite> =>
	Arr.findFirst(["cold", "dfa", "compile", "bytes"] as const, (s) => s === command)

type Listed = "gates" | "list" | "all"

type Flag = "--quick" | "--only" | "--dir" | "--out" | "--report"

const allowed: Readonly<Record<Listed, ReadonlyArray<Flag>>> = {
	gates: ["--quick", "--only", "--dir", "--out", "--report"],
	list: ["--dir"],
	all: ["--quick"]
}

/** The flags read so far. */
interface Flags {
	readonly quick: boolean
	readonly report: boolean
	readonly only: ReadonlyArray<string>
	readonly directories: ReadonlyArray<string>
	readonly outDir: Option.Option<string>
}

/** The flag's value, the argument after it, and the arguments after that. */
const valueOf = (
	flag: string,
	rest: ReadonlyArray<string>
): Effect.Effect<readonly [string, ReadonlyArray<string>], UsageError> =>
	Arr.match(rest, {
		onEmpty: () => usage(`${flag} needs a value`),
		onNonEmpty: ([value, ...after]) =>
			Str.startsWith("--")(value)
				? usage(`${flag} needs a value`)
				: Effect.succeed([value, after] as const)
	})

/** One flag and what it reads, then the flags after it. */
const readFlag = Effect.fn("readFlag")(function* (
	command: Listed,
	flag: string,
	rest: ReadonlyArray<string>,
	flags: Flags
): Effect.fn.Return<Flags, UsageError, Path.Path> {
	const path = yield* Path.Path
	const known = Arr.findFirst(allowed[command], (f) => f === flag)
	if (Option.isNone(known)) {
		return yield* usage(`${command}: unknown argument ${flag}`)
	}
	switch (known.value) {
		case "--quick":
			return yield* readFlags(command, rest, { ...flags, quick: true })
		case "--report":
			return yield* readFlags(command, rest, { ...flags, report: true })
		case "--only": {
			const [value, after] = yield* valueOf(flag, rest)
			const named = Arr.filter(Arr.map(Str.split(value, ","), Str.trim), (s) => s !== "")
			return yield* readFlags(command, after, { ...flags, only: [...flags.only, ...named] })
		}
		case "--dir": {
			const [value, after] = yield* valueOf(flag, rest)
			return yield* readFlags(command, after, {
				...flags,
				directories: [...flags.directories, path.resolve(value)]
			})
		}
		case "--out": {
			const [value, after] = yield* valueOf(flag, rest)
			return yield* readFlags(command, after, {
				...flags,
				outDir: Option.some(path.resolve(value))
			})
		}
	}
})

const readFlags = (
	command: Listed,
	args: ReadonlyArray<string>,
	flags: Flags
): Effect.Effect<Flags, UsageError, Path.Path> =>
	Arr.match(args, {
		onEmpty: () => Effect.succeed(flags),
		onNonEmpty: ([flag, ...rest]) => readFlag(command, flag, rest, flags)
	})

const noFlags: Flags = {
	quick: false,
	report: false,
	only: [],
	directories: [],
	outDir: Option.none()
}

const listedOf = (command: string): Option.Option<Listed> =>
	Arr.findFirst(["gates", "list", "all"] as const, (c) => c === command)

/**
 * The command `argv` names, every path in it absolute.
 */
export const parseBenchArgs = Effect.fn("parseBenchArgs")(function* (
	argv: ReadonlyArray<string>
): Effect.fn.Return<BenchCommand, UsageError, Path.Path> {
	const [first, ...rest] = argv
	const suite = suiteOf(first)
	if (Option.isSome(suite)) {
		return { kind: "suite", suite: suite.value, args: rest } satisfies BenchCommand
	}
	const named = first !== undefined && !Str.startsWith("--")(first)
	const command = named ? first : "gates"
	const args = named ? rest : argv
	if (command === "full") {
		return Arr.isReadonlyArrayNonEmpty(args)
			? yield* usage(`full: unknown argument ${args[0]}`)
			: ({ kind: "full" } satisfies BenchCommand)
	}
	const listed = listedOf(command)
	if (Option.isNone(listed)) {
		return yield* usage(`unknown command ${command}`)
	}
	const flags = yield* readFlags(listed.value, args, noFlags)
	const directories = Arr.isReadonlyArrayNonEmpty(flags.directories)
		? flags.directories
		: defaultGateDirectories
	switch (listed.value) {
		case "list":
			return { kind: "list", directories } satisfies BenchCommand
		case "all":
			return { kind: "all", quick: flags.quick } satisfies BenchCommand
		case "gates":
			return {
				kind: "gates",
				quick: flags.quick,
				only: flags.only,
				directories,
				outDir: Option.getOrElse(flags.outDir, () => `${repoRoot}/bench/results`),
				report: flags.report
			} satisfies BenchCommand
	}
})

/**
 * Runs a benchmark entry point to completion in a child process this one owns: the child shares the terminal, an
 * interrupt of this process kills it with its process group, and the effect ends only after it has exited. A child
 * that cannot start, or that a signal ends, fails the effect.
 */
export const runSuite = Effect.fn("runSuite")(function* (
	suite: Suite,
	args: ReadonlyArray<string>
): Effect.fn.Return<number, PlatformError.PlatformError, ChildProcessSpawner.ChildProcessSpawner> {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	return yield* spawner.exitCode(
		ChildProcess.make(process.execPath, [suiteEntries[suite], ...args], {
			cwd: repoRoot,
			stdin: "inherit",
			stdout: "inherit",
			stderr: "inherit",
			killSignal: "SIGKILL"
		})
	)
})
