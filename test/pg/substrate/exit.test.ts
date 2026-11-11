/**
 * A process whose work over the test substrate and grizzle is done exits by itself, against PostgreSQL 19.
 *
 * Each case runs test/support/substrate/exit-child.ts as a child process under the test flags: it builds an isolated
 * substrate, installs a relation, opens no Db, one or two in turn, each reading through a query or not, closes every
 * scope, and writes the kinds of the resources still open. The box is every number of Dbs from none to two, each with
 * and without a read; the one with no Db reads nothing. The oracle is the leak rule: once its scopes are closed nothing
 * it opened is open, no socket, connection attempt or timer, which the child reports before the case awaits its exit,
 * and the child then exits by itself with status 0.
 *
 * Plants (main's test phase): substrate-exit-pool-never-ended.patch.
 */
import { NodeChildProcessSpawner, NodeFileSystem, NodePath } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { boolean, element, type Gen } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Fiber, Formatter, Layer, Option, Stream } from "effect"
import { ChildProcess } from "effect/process"
import { jsonText, trustedJson } from "#compiler/core/trusted.ts"
import { assert } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { exitedCleanly } from "#test/unit/dev/published.ts"

/** The child's case (exit-child.ts ExitCase). */
interface ExitCase {
	readonly dbs: 0 | 1 | 2
	readonly read: boolean
}

const dbCounts = [0, 1, 2] as const

const caseGen: Gen<ExitCase> = (source) => {
	const dbs = source.draw(element(dbCounts))
	return { dbs, read: dbs > 0 && source.draw(boolean) }
}

/** The kinds of resource that hold a process open and that a closed scope must have ended. */
const leaked = Object.freeze([
	"TCPSocketWrap",
	"TCPWrap",
	"TCPConnectWrap",
	"ConnectWrap",
	"Timeout",
	"Immediate"
])

/** The test flags a child runs under, as the network tests' own process does (package.json test:network). */
const flags = Object.freeze([
	"--conditions=grizzle-source",
	"--disable-proto=delete",
	"--disable-sigusr1",
	"--throw-deprecation",
	"--unhandled-rejections=strict"
])

const childPath = new URL("../../support/substrate/exit-child.ts", import.meta.url).pathname

const spawner = NodeChildProcessSpawner.layer.pipe(
	Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))
)

type Feature = `${0 | 1 | 2} Dbs${"" | ", read"}`

layer(spawner, { excludeTestServices: true })(
	"a process over the substrate and grizzle exits once its scopes close",
	(it) => {
		it.effect(
			"no socket, connection or timer is left once the substrate and every Db are released",
			(ctx) =>
				searched(
					ctx,
					exhaust(
						{
							suite: "substrate/exit",
							generator: caseGen,
							literal: Formatter.format,
							coverage: requiredInSpace<Feature>([
								"0 Dbs",
								"1 Dbs",
								"1 Dbs, read",
								"2 Dbs",
								"2 Dbs, read"
							]),
							box: "every number of Dbs from none to two, each with and without a read through a query",
							oracle: {
								kind: "specification",
								name: "the leak rule: nothing a closed scope opened is open, and the process exits by itself"
							},
							caseHang
						},
						(c, k) =>
							Effect.scoped(
								Effect.gen(function* () {
									const child = yield* ChildProcess.make(
										process.execPath,
										[...flags, childPath, jsonText({ dbs: c.dbs, read: c.read })],
										{ cwd: process.cwd(), stdin: "ignore" }
									)
									const stderr = yield* Effect.forkScoped(
										Stream.mkString(Stream.decodeText(child.stderr))
									)
									/** The child's report, read before its exit is awaited: a leak never lets it exit. */
									const report = yield* Stream.runHead(
										Stream.splitLines(Stream.decodeText(child.stdout))
									)
									if (Option.isNone(report)) {
										const said = yield* Fiber.join(stderr)
										return assert.fail(`the child reports what is open: ${said}`)
									}
									const open = trustedJson<ReadonlyArray<string>>(report.value)
									assert.deepEqual(
										Arr.filter(open, (kind) => leaked.includes(kind)),
										[],
										`nothing a closed scope opened is open: ${Formatter.format(open)}`
									)
									const exitCode = yield* child.exitCode
									assert.equal(exitCode, exitedCleanly, "the child exits by itself")
									k.note(`${c.dbs} Dbs${c.read ? ", read" : ""}`)
								})
							)
					)
				)
		)
	}
)
