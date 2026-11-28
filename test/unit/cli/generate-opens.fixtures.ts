import { type Gen, int, map } from "@bjornpagen/testing/gen"
import { Record as Rec } from "effect"
import { noServedTypes } from "#compiler/physical/ddl/domains.ts"
import type { InstalledSource } from "#compiler/program/schema.ts"
import { bool } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { login, relation, role, schema, type RelationName } from "#compiler/public/schema.ts"
import { workload } from "#compiler/public/workload.ts"
import { selectMaxEntries } from "#compiler/sql/print.ts"
import { repoRoot } from "#test/support/files.ts"
import { Id } from "#test/support/ids.ts"
import { upTo } from "#test/support/up-to.ts"

/**
 * Where the layer's artifacts take the types its programs cast their parameters to: planned from the workload's
 * programs, as generate plans the artifacts its served file compiles over (cli/generate.ts plannedLogins), which here
 * are none, the box's one query declaring no parameter.
 */
export const boxParams: InstalledSource = { kind: "planned", types: noServedTypes }

/** A head around the select list's bound: its entries, and how many of them are the left relation's fields. */
export interface Head {
	readonly entries: number
	readonly left: number
}

/** A head on the bound or one entry past it, its fields split evenly between two relations. */
export const headGen: Gen<Head> = map(int(0, 1), (offset): Head => {
	const entries = selectMaxEntries + offset
	return { entries, left: Math.ceil((entries - 1) / 2) }
})

export type Width = "within the bound" | "at the bound" | "past the bound" | "one past the bound"

/** Where a head stands against the bound. */
export const widthsOf = (head: Head): ReadonlyArray<Width> => [
	head.entries <= selectMaxEntries ? "within the bound" : "past the bound",
	...(head.entries === selectMaxEntries ? ["at the bound" as const] : []),
	...(head.entries === selectMaxEntries + 1 ? ["one past the bound" as const] : [])
]

/**
 * A relation keyed by `id`, with `count` boolean fields named `<prefix><i>` beside it: one byte each, so a row fits one
 * heap tuple, which the select list is the first limit past.
 */
const side = <const Name extends string>(
	name: RelationName<Name>,
	prefix: string,
	count: number
) => {
	const fields: Readonly<Record<string, typeof Id | typeof bool>> = {
		id: Id,
		...Rec.fromEntries(upTo(count, (i) => [`${prefix}${i}`, bool] as const))
	}
	return relation(name, fields, ["id"])
}

/** The schema and login of a head: every field of a left relation and of the right one of its id. */
export const pairsOf = (head: Head) => {
	const Left = side("Left", "l", head.left)
	const Right = side("Right", "r", head.entries - 1 - head.left)
	const Pairs = schema("Pairs", [Left, Right], [])
	const pairs = query(Pairs).rule((r) => {
		const left = v(Left, "left")
		const right = v(Right, "right")
		return r
			.match(Left, left)
			.match(Right, { ...right, id: left["id"] })
			.find({ ...right, ...left })
	})
	return {
		schema: Pairs,
		login: login(Pairs, "server", [role(Pairs, "reader", { Left, Right })], {
			workload: [workload(Pairs, { pairs })]
		})
	}
}

export const file = `${repoRoot}app/grizzle.config.ts`

/**
 * How long one case may run: a case compiles a login whose one query's head holds PostgreSQL's 1,664 select entries (or
 * one more) twice, through generate and through DbLayer.make, synchronously, about half a minute of one core's work,
 * past the runner's one-minute case deadline once the machine is oversubscribed.
 *
 * @limitKind measured
 * @owner test/unit/cli/generate-opens.test.ts, its property's cases
 * @unit milliseconds per case
 * @scope one case of the generate-opens property, on one worker of toolchain-test's pool
 * @evidence `/usr/bin/time -v toolchain-test replay` of each of the property's two cases (its whole space), and the
 *   full run that lost case 0's worker, in lane GZ-UNIT-C's landing clone
 *   (~/.cache/grizzle-release/TESTSYS/GZ-UNIT-C/land-run3.txt, the run's report); Vitest's record of the old test,
 *   59,362 ms for both cases in one file (~/.cache/grizzle-release/TESTSYS/GZ-UNIT-C/vitest-base.txt)
 * @observed 2026-11-16: replays 04:02 to 04:04 UTC; the full run 03:41 to 04:02 UTC; Vitest 02:17 UTC
 * @environment cassowary, Ubuntu 26.04 on an AWS Graviton3 (arm64) instance with 64 logical CPUs, Node 26.13,
 *   toolchain-test at toolchain acbe88c, other sessions' runs on the machine: load average 418 to 511 over the
 *   replays, 545 to 840 over the full run, 120 to 170 under Vitest
 * @workload the property's two cases: a head of 1,664 entries (the bound) and of 1,665 (one past it), each compiled by
 *   generate and by DbLayer.make
 * @result case 0: 34.27 s user, 1.03 s system, 54.55 s wall; case 1: 30.63 s user, 0.92 s system, 53.46 s wall (each
 *   replay's process start included); under the full run case 0 held its worker's event loop past the runner's 60 s
 *   deadline and its grace, and the worker was killed
 * @decision ten minutes: 17.5 times the slowest case's 34.3 s of CPU, where the most oversubscription observed is
 *   about 14 times (a load of 900 on 64 CPUs, 2026-11-16), so a case that still runs at ten minutes is hung, not slow
 * @revalidate a change to the compile of a login (adapter/served/compile.ts, served/login.ts), to generate's draft, or
 *   to selectMaxEntries; a different machine; a run that loses this property's worker at the deadline
 */
export const compileCaseDeadline = 600_000
