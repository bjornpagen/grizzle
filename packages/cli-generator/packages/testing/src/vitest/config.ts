import { Array as Arr, Config, Effect, Option } from "effect"
import { defineConfig } from "vitest/config"
import { residualReporter } from "#vitest/reporter.ts"

/**
 * The flags every test process runs under: no `__proto__` accessor and no inspector opened on SIGUSR1; a deprecated
 * Node API, a pending deprecation included, throws instead of warning; only context-aware native addons load; no
 * module resolves from the global folders; and an unhandled rejection is an uncaught exception. V8's JIT and code
 * generation from strings stay on.
 */
export const HARDENED_FLAGS: ReadonlyArray<string> = [
	"--disable-proto=delete",
	"--disable-sigusr1",
	"--throw-deprecation",
	"--pending-deprecation",
	"--force-context-aware",
	"--no-global-search-paths",
	"--unhandled-rejections=strict"
]

/**
 * How long a test or a hook may take: without bound, or a number of milliseconds. A long search that keeps making
 * progress must never fail on wall time; each case's hang guard is what catches a case that stops.
 */
export type Timeout =
	| Readonly<{ kind: "unbounded" }>
	| Readonly<{ kind: "bounded"; millis: number }>

/**
 * The stack the small-stack project runs under: 160 KB, about a sixth of Node's default 984 KB, so a per-element use of
 * the stack (a spread argument, a recursion over a list) fails at the widths ordinary generators reach. A measured
 * limit: on Node 26.13.0 (V8 14.6.202.34), a small-stack worker boots and runs every one of grizzle's 52 small-stack
 * files at 107 KB and no lower (at 106 KB its bootstrap overflows compiling Node's own internals, before any test), and
 * 160 KB is that floor with half again as headroom for the runtime's own growth. At 160 KB a recursion over a list of
 * 1,000 elements and a spread of 16,000 arguments overflow, where the regular project runs both.
 */
const SMALL_STACK = "--stack-size=160"

/** Vitest's form of a timeout, where zero means none. */
const millisOf = (timeout: Timeout) => (timeout.kind === "unbounded" ? 0 : timeout.millis)

/**
 * What a package states about its tests: which files they are; which of them run alone, one at a time and after every
 * other file, because they hold something the others share (a cluster-wide setting, a lock every test takes); which
 * steer by V8's block coverage, so their processes count blocks from the start, before the code under test loads; its own
 * global setup files, which run after the library's, beside the run seed; the export conditions its code resolves with;
 * how long a test and a hook may take; and how many files may run at once, when something the files share (a pool of
 * database connections, a set of worker databases) holds fewer than Vitest's default of one per core; and `smallStack`,
 * the files whose suites run a second time under SMALL_STACK, about a sixth of Node's default stack, so a
 * per-element use of the stack (a spread argument, a recursion over a list) fails at the widths ordinary generators
 * reach. A package with none of a list states it empty, and one with no such limit states none. The exclusive, guided
 * and small-stack lists are projects of their own, so each names its files outright: a glob there reaches every file it
 * matches, inside `include` or not.
 */
export type TestConfig = Readonly<{
	include: ReadonlyArray<string>
	exclusive: ReadonlyArray<string>
	guided: ReadonlyArray<string>
	setup: ReadonlyArray<string>
	conditions: ReadonlyArray<string>
	timeouts: Readonly<{ test: Timeout; hook: Timeout }>
	maxWorkers: Option.Option<number>
	smallStack: ReadonlyArray<string>
}>

/**
 * A package's Vitest config. Tests run as Node runs the code: native ESM by type stripping, never through Vite's
 * module runner or loader, so no transform changes what a module means; one process per file; the hardened flags;
 * the run seed chosen once by global setup; and the residual table at the end. A fuzz run lifts every timeout: its
 * budget is its own, and each case's hang guard still catches a case that stops.
 */
export const defineTestConfig = (config: TestConfig) => {
	const fuzzing = Option.isSome(Effect.runSync(Config.option(Config.String("TEST_FUZZ"))))
	const timeoutOf = (timeout: Timeout) => millisOf(fuzzing ? { kind: "unbounded" } : timeout)
	const execArgv = [
		...HARDENED_FLAGS,
		...Arr.map(config.conditions, (condition) => `--conditions=${condition}`)
	]
	return defineConfig({
		test: {
			pool: "forks",
			isolate: true,
			execArgv,
			experimental: { viteModuleRunner: false, nodeLoader: false },
			globalSetup: [`${import.meta.dirname}/global-setup.ts`, ...config.setup],
			projects: [
				{
					extends: true,
					test: {
						name: "parallel",
						include: Arr.copy(config.include),
						exclude: [...config.exclusive, ...config.guided],
						sequence: { groupOrder: 0 }
					}
				},
				...(Arr.isReadonlyArrayNonEmpty(config.guided)
					? [
							{
								extends: true,
								test: {
									name: "guided",
									include: Arr.copy(config.guided),
									setupFiles: [`${import.meta.dirname}/coverage.ts`],
									sequence: { groupOrder: 0 }
								}
							}
						]
					: []),
				...(Arr.isReadonlyArrayNonEmpty(config.smallStack)
					? [
							{
								extends: true,
								test: {
									name: "small-stack",
									include: Arr.copy(config.smallStack),
									execArgv: Arr.append(execArgv, SMALL_STACK),
									sequence: { groupOrder: 0 }
								}
							}
						]
					: []),
				...(Arr.isReadonlyArrayNonEmpty(config.exclusive)
					? [
							{
								extends: true,
								test: {
									name: "exclusive",
									include: Arr.copy(config.exclusive),
									fileParallelism: false,
									maxWorkers: 1,
									sequence: { groupOrder: 1 }
								}
							}
						]
					: [])
			],
			...Option.match(config.maxWorkers, {
				onNone: () => ({}),
				onSome: (maxWorkers) => ({ maxWorkers })
			}),
			reporters: ["default", residualReporter()],
			testTimeout: timeoutOf(config.timeouts.test),
			hookTimeout: timeoutOf(config.timeouts.hook)
		}
	})
}
