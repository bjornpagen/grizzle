import { Effect, Stream } from "effect"
import { ChildProcess } from "effect/process"

const repoRoot = `${import.meta.dirname}/../../`

/**
 * Child processes a test owns: the doctor, and anything else a test runs to completion.
 *
 * No child outlives the test that started it. `run` ends only after the child has exited, and kills it when its fiber
 * is interrupted (a test's abort interrupts the test's Effect, and a timeout interrupts what it times).
 *
 * Where a child runs, and what its environment adds to this process's; its stdin is empty. runOptions states the plain
 * child's; a test spreads it with what it changes.
 */
export interface RunOptions {
	readonly cwd: string
	readonly env: Readonly<Record<string, string>>
}

/** A plain child: run in the repository, with this process's environment. */
export const runOptions: RunOptions = { cwd: repoRoot, env: {} }

/**
 * The condition under which the package's own name, `@bjornpagen/grizzle`, resolves to packages/grizzle/src/index.ts (package.json's
 * "grizzle-source" export, first in "."), never to the dist/ the repository does not build. Every Node process the
 * repository runs on its own code carries it: Vitest's own process, whose global setups load the source (package.json's
 * test scripts), every test process (the Vitest configs' conditions), the bin under test, the benchmark children and
 * the mutation tester's runs. A consumer of the published package never does, so it resolves dist/
 * (test/unit/dev/package.test.ts); for that reason it is never put in NODE_OPTIONS, which every child inherits.
 */
export const sourceCondition = "--conditions=grizzle-source"

/**
 * The hardened Node every process of the repository's own code runs under: no `Object.prototype.__proto__` accessor
 * (prototype pollution has no path) and no inspector opened on SIGUSR1; a deprecated Node API, a pending deprecation
 * included, throws instead of warning; only context-aware native addons load; no module resolves from the global
 * folders; and an unhandled rejection is an uncaught exception. V8's JIT and code generation from strings stay on.
 * package.json's test scripts and the mutation tester put them in NODE_OPTIONS, which Vitest's own process, every test
 * process and every child a test spawns inherit; the `grizzle` bin's shebang carries the first two.
 */
export const hardenedNode = [
	"--disable-proto=delete",
	"--disable-sigusr1",
	"--throw-deprecation",
	"--pending-deprecation",
	"--force-context-aware",
	"--no-global-search-paths",
	"--unhandled-rejections=strict"
] as const

/** What a child run to completion did: its exit code and its output. */
interface Ran {
	readonly status: number
	readonly stdout: string
	readonly stderr: string
}

/**
 * Runs `command` with `args` to completion, as a child of a scope of its own, which kills it when the run is
 * interrupted; a child that cannot be spawned or read is a defect of the run. It spawns through the
 * ChildProcessSpawner its caller provides (NodeServices.layer).
 */
export const run = Effect.fn("run")(
	function* (command: string, args: ReadonlyArray<string>, options: RunOptions) {
		const handle = yield* ChildProcess.make(command, args, {
			cwd: options.cwd,
			env: { ...options.env },
			extendEnv: true,
			stdin: "ignore"
		})
		const [stdout, stderr, status] = yield* Effect.all(
			[
				Stream.mkString(Stream.decodeText(handle.stdout)),
				Stream.mkString(Stream.decodeText(handle.stderr)),
				handle.exitCode
			],
			{ concurrency: "unbounded" }
		)
		const ran: Ran = { status, stdout, stderr }
		return ran
	},
	Effect.scoped,
	Effect.orDie
)
