/** What the property of generate-heap.test.ts reads: its box, the installation its child generates, and the run read. */

import { defined, nonEmpty } from "@bjornpagen/testing/assert"
import { type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Record as Rec, String as Str } from "effect"
import { defineConfig } from "#adapter/config/define.ts"
import {
	assembledSchema,
	domainOf,
	ordinaryOf,
	pairsAt,
	rostersAt,
	type Scale,
	statementsOf
} from "#bench/compile/schema.ts"
import { login } from "#compiler/program/workload/login.ts"
import { workload } from "#compiler/program/workload/value.ts"
import { roleBuilder as role, wholeWritesOf } from "#compiler/schema/world.ts"
import type { EntryValue } from "#compiler/types/schema/world.ts"
import { changeSetOver } from "#compiler/write/changeset/value.ts"
import { offlineOwner } from "#test/support/pg/cli/support.ts"
import { upTo } from "#test/support/up-to.ts"

/** A case: how many logins the installation serves, and over how many relations each runs a keyed read and an insert. */
export type HeapCase = Readonly<{ logins: number; programs: number }>

/** The box: from four logins to eight, each over eight relations to twelve, every relation of the schema. */
export const heapCaseGen: Gen<HeapCase> = (source) => ({
	logins: source.draw(int(4, 8)),
	programs: source.draw(int(8, 12))
})

/** The scale of the compile benchmark's generated schema the installation stands on: the scaling property's base. */
const heapScale: Scale = { handles: 40, relations: 12, rows: 800, patterns: 12 }

/**
 * The installation a case generates: the compile benchmark's generated schema at heapScale (bench/compile/schema.ts),
 * and `logins` logins over it, the k-th with a role of its own holding every ordinary relation and roster whole and
 * writing every ordinary relation, as the benchmark's role does, running a keyed read of each of `programs` relations
 * from the k-th on, counting around, and an insert into each of them (a ChangeSet built as a caller whose schema is
 * known at run time builds it, write/changeset/value.ts changeSetOver).
 */
export const heapConfig = (c: HeapCase) => {
	const rosters = rostersAt(heapScale)
	const pairs = pairsAt(rosters, heapScale)
	const domains = nonEmpty(upTo(heapScale.patterns, domainOf), "the scale's patterns")
	const ordinary = nonEmpty(
		upTo(heapScale.relations, (i) => ordinaryOf(i, domains, rosters)),
		"the scale's relations"
	)
	const base = assembledSchema(
		rosters,
		pairs,
		ordinary,
		Arr.flatMap(ordinary, (r, i) =>
			statementsOf(r, i, i === 0 ? undefined : ordinary[i - 1], rosters, pairs)
		)
	)
	const entries: Record<string, EntryValue> = {}
	for (const r of [...ordinary, ...Arr.map(rosters, ({ roster }) => roster)]) {
		entries[r.name] = r
	}
	const logins = upTo(c.logins, (k) => {
		const app = role(base, `app${String(k)}`, entries, wholeWritesOf(base))
		const over = upTo(c.programs, (j) =>
			defined(ordinary[(k + j) % ordinary.length], "a relation counted around")
		)
		return login(base, `web${String(k)}`, [app], {
			workload: [
				workload(
					app,
					Rec.fromEntries([
						...Arr.map(over, (r) => [`by${r.name}`, r] as const),
						...Arr.map(
							over,
							(r) => [`add${r.name}`, changeSetOver.empty(app).insert(r, [])] as const
						)
					])
				)
			]
		})
	})
	return defineConfig({
		schemas: [base],
		logins,
		migrations: "migrations",
		rolePrefixBytes: 0,
		connection: () => offlineOwner
	})
}

/** The phases whose boundaries the bound reads (core/phase.ts phaseNames): the plan's and every phase after it. */
export const heapPhases = ["draft", "served", "servedLogin", "render", "write"] as const

/** A boundary of the measured run: its phase's label, as a phase line prints it, its edge, and the live heap in bytes. */
export type HeapBoundary = Readonly<{ label: string; edge: "start" | "end"; live: number }>

/**
 * What the child prints (generate-heap.child.ts): each boundary of the measured run's heapPhases in order, and the
 * bytes of each file it wrote, by its path in the schema's directory.
 */
export type HeapRun = Readonly<{
	boundaries: ReadonlyArray<HeapBoundary>
	files: ReadonlyArray<readonly [string, number]>
}>

/**
 * The artifact a file of the schema's directory belongs to, as generate makes them, each in one compile: a login's
 * served file and OpenAPI document, the snapshot's two files, or the migration folder.
 */
const artifactOf = (path: string): string => {
	const [head, rest] = Str.split(path, "/")
	if (rest === undefined) {
		return "snapshot"
	}
	return head === "served" || head === "openapi" ? `login ${rest}` : "folder"
}

/** The bytes of the largest artifact the run wrote (artifactOf), its files' bytes together. */
export const largestArtifact = (run: HeapRun): number => {
	const sizes = new Map<string, number>()
	for (const [path, bytes] of run.files) {
		sizes.set(artifactOf(path), (sizes.get(artifactOf(path)) ?? 0) + bytes)
	}
	return Arr.reduce([...sizes.values()], 0, (most, bytes) => Math.max(most, bytes))
}

/** The live heap at the first boundary of phase `name` (its label's first part) at `edge`. */
export const liveAt = (run: HeapRun, name: string, edge: "start" | "end"): number =>
	defined(
		Option.getOrUndefined(
			Arr.findFirst(run.boundaries, (b) => phaseOf(b) === name && b.edge === edge)
		),
		`the run's ${name} ${edge}`
	).live

/** The phase a boundary is of: its label's first part. */
export const phaseOf = (b: HeapBoundary): string => Str.split(b.label, "/")[0]

/** The boundaries from the first start of phase `name` on, in order. */
export const fromPhase = (run: HeapRun, name: string): ReadonlyArray<HeapBoundary> =>
	Arr.dropWhile(run.boundaries, (b) => !(phaseOf(b) === name && b.edge === "start"))
