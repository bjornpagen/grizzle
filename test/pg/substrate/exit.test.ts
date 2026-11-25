/**
 * A process whose work over the test substrate and grizzle is done exits by itself, against PostgreSQL 19.
 *
 * Each case runs test/support/substrate/exit.child.ts as a child process under the flags every process of a run runs
 * under (the runner's HARDENED_FLAGS), from the checkout its worker runs in (Checkout.dir), in the place the case lends
 * it (shared.ts lend: the case's own database on its member, and a test pool's permits of the case's budget, so the
 * worker and its child hold no more than the worker's budget): it builds its substrate there (Substrate.lentLayer),
 * installs a relation, opens no Db, one or two in turn, each reading through a query or not, closes every
 * scope, and writes the kinds of the resources still open. The box is every number of Dbs from none to two, each with
 * and without a read; the one with no Db reads nothing. The oracle is the leak rule: once its scopes are closed nothing
 * it opened is open, no socket, connection attempt or timer, which the child reports before the case awaits its exit,
 * and the child then exits by itself with status 0.
 */

import { assert } from "@bjornpagen/testing/assert"
import { Checkout } from "@bjornpagen/testing/checkout"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { HARDENED_FLAGS } from "@bjornpagen/testing/runner"
import { Array as Arr, Effect, Fiber, Formatter, Option, Path, Stream } from "effect"
import { ChildProcess } from "effect/process"
import { jsonText, trustedJson } from "#compiler/core/trusted.ts"
import { caseGen, childModule, type Feature, leaked } from "#test/pg/substrate/exit.fixtures.ts"
import { testPoolMax } from "#test/support/substrate/connections.ts"
import { lend } from "#test/support/substrate/shared.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"
import { exitedCleanly } from "#test/unit/dev/consumer.ts"

/** No socket, connection or timer is left once the substrate and every Db are released, and the process exits. */
export const exitsOnceItsScopesClose = property.exhaust(finite(caseGen), {
	needs: { checkout: Checkout.dir, substrate: Substrate.fresh(baseSubstrate) },
	situations: ["0 Dbs", "1 Dbs", "1 Dbs, read", "2 Dbs", "2 Dbs, read"] satisfies ReadonlyArray<
		Reached<Feature>
	>,
	check:
		({ checkout, substrate }, k: Case<Feature>) =>
		(c) =>
			Effect.scoped(
				Effect.gen(function* () {
					const root = yield* checkout
					const { substrate: s } = yield* substrate
					const lent = yield* lend(s, testPoolMax)
					const path = yield* Path.Path
					const child = yield* ChildProcess.make(
						process.execPath,
						[
							...HARDENED_FLAGS,
							path.join(root, childModule),
							jsonText({ dbs: c.dbs, read: c.read })
						],
						{ cwd: root, stdin: "ignore", env: lent, extendEnv: true }
					)
					const stderr = yield* Effect.forkScoped(Stream.mkString(Stream.decodeText(child.stderr)))
					/** The child's report, read before its exit is awaited: a leak never lets it exit. */
					const report = yield* Stream.runHead(Stream.splitLines(Stream.decodeText(child.stdout)))
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
			),
	oracle: {
		kind: "specification",
		name: "the leak rule: nothing a closed scope opened is open, and the process exits by itself"
	},
	box: "every number of Dbs from none to two, each with and without a read through a query",
	kept: [],
	kills: [
		{
			file: "packages/grizzle/src/adapter/wire/pool.ts",
			original: "\t\tyield* Effect.addFinalizer(() => Effect.suspend(end))\n",
			replacement: "",
			why: "A DbLayer's scope never ends its session pool (adapter/wire/pool.ts, its end no finalizer of the layer), so a closed Db leaves its sockets holding the process open."
		}
	]
})
