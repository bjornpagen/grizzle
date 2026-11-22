import { pathToFileURL } from "node:url"
import { defined } from "@bjornpagen/testing/assert"
import { Array as Arr, Effect, FileSystem, Option, Order, Stream, String as Str } from "effect"
import { ChildProcess } from "effect/process"
import { trustedJson } from "#compiler/core/trusted.ts"

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
 * The hardened Node every process of the repository's own code runs under: no `Object.prototype.__proto__` accessor
 * (prototype pollution has no path) and no inspector opened on SIGUSR1; a deprecated Node API, a pending deprecation
 * included, throws instead of warning; only context-aware native addons load; no module resolves from the global
 * folders; and an unhandled rejection is an uncaught exception. V8's JIT and code generation from strings stay on.
 * Each is given on the command line of every node that runs the repository's code: package.json's test scripts start
 * Vitest's own process with them, the testing library's config gives every test process them (its hardened flags),
 * the mutation tester starts its Vitest with them, and a test that runs the repository's code in a child passes them
 * on the child's command line; the `grizzle` bin's shebang carries the first two. None travels in NODE_OPTIONS: this
 * machine's Node is built without it (process.config.variables.node_without_node_options), so a flag there is
 * silently ignored, and no child would inherit it.
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

/** The line test/support/load-probe.ts writes as the process exits: its marker, then the loaded modules' URLs. */
const probeMarker = "loadProbe "

/**
 * `entry`, a path in the checkout at `checkout`, run under hardened Node over `argv` with test/support/load-probe.ts
 * imported before it, in an empty directory of its own: its exit status, its stdout, its stderr but the probe's line,
 * the path in the checkout of every file module it loaded, and the URL of every other it loaded (a dependency, which a
 * worker tree's node_modules links to outside it), each in code point order.
 */
export const probedRun = (checkout: string, entry: string, argv: ReadonlyArray<string>) =>
	Effect.scoped(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "grizzle-probe-" })
			const ran = yield* run(
				process.execPath,
				[
					...hardenedNode,
					"--import",
					`${checkout}/test/support/load-probe.ts`,
					`${checkout}/${entry}`,
					...argv
				],
				{ cwd, env: {} }
			)
			const lines = Str.split(ran.stderr, "\n")
			const probed = defined(
				Option.getOrUndefined(Arr.findFirst(lines, Str.startsWith(probeMarker))),
				`the probe's line among stderr:\n${ran.stderr}`
			)
			const root = `${pathToFileURL(checkout).href}/`
			const urls = trustedJson<ReadonlyArray<string>>(Str.slice(probeMarker.length)(probed))
			const modules = Arr.filter(urls, Str.startsWith("file:"))
			const files = Arr.filter(modules, Str.startsWith(root))
			const outside = Arr.filter(modules, (url) => !Str.startsWith(root)(url))
			return {
				status: ran.status,
				stdout: ran.stdout,
				stderr: Arr.join(
					Arr.filter(lines, (line) => line !== "" && !Str.startsWith(probeMarker)(line)),
					"\n"
				),
				loaded: Arr.sort(Arr.map(files, Str.slice(root.length)), Order.String),
				outside: Arr.sort(outside, Order.String)
			}
		})
	)
