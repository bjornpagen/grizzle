import { describe, it } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { features, noFeatures } from "@grizzle/testing/features"
import { element, filter, type Gen, map, uniqueArray } from "@grizzle/testing/gen"
import { type Drawn, passed, wild } from "@grizzle/testing/lsw"
import { matching } from "@grizzle/testing/pattern"
import { completeShrink } from "@grizzle/testing/shrink"
import type { Source } from "@grizzle/testing/source"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, Record as Rec } from "effect"
import { catchCompileError } from "#compiler/core/canonical.ts"
import type { SchemaFingerprint } from "#compiler/core/ids.ts"
import { formatLoc } from "#compiler/core/loc.ts"
import { decodeDesc } from "#compiler/ir/desc.ts"
import { describeQuery, queryFromDescription } from "#compiler/program/describe.ts"
import { pageQueryFingerprint } from "#compiler/program/workload/fingerprint.ts"
import { workload as admitWorkload, programDescOf } from "#compiler/program/workload/value.ts"
import { workloadState } from "#compiler/program/workload/value.ts"
import { uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { schema } from "#compiler/public/schema.ts"
import { workload } from "#compiler/public/workload.ts"
import {
	assert,
	defined,
	nonEmpty,
	refusalLoc,
	refused,
	succeeded,
	throwsRefused,
	unorderedEqual
} from "#test/support/assert.ts"
import { compileTestWorkload, testCompile } from "#test/support/compile.ts"
import {
	Board,
	fixtureLogin,
	orderedTasks,
	planOf,
	switchToManualDescribed,
	tasksForAccount,
	titlesByPrefix,
	topThree,
	urgentAtLeast,
	W
} from "#test/unit/workload/fixtures.ts"

import { regex } from "arkregex"
/**
 * workload(schema, programs) as a value (program/workload/value.ts), and the page fingerprint of each query
 * (program/workload/fingerprint.ts): a workload records a WorkloadDesc holding each program's Description under its name,
 * compiles from that Description with the schema named to the plan its value compiles to, and refuses what its
 * signature forbids; a query's page fingerprint is one per query and schema, whatever its name or its source
 * locations.
 *
 * The programs are the workload fixtures' (workload/fixtures.ts), drawn into workloads under drawn names.
 */

type Kind = "query" | "changeSet"

interface Program {
	readonly source: string
	readonly value: unknown
	readonly kind: Kind
}

/**
 * A schema value, the name its WorkloadDesc records (an extension keeps its base's), and programs over it or one of its
 * levels.
 */
interface Workloads {
	readonly schema: unknown
	readonly name: string
	readonly programs: ReadonlyArray<Program>
}

const namedQuery = (source: string, value: unknown): Program => ({ source, value, kind: "query" })

const boardPrograms: ReadonlyArray<Program> = [
	namedQuery("orderedTasks", orderedTasks),
	namedQuery("tasksForAccount", tasksForAccount),
	namedQuery("topThree", topThree),
	namedQuery("urgentAtLeast", urgentAtLeast),
	namedQuery("titlesByPrefix", titlesByPrefix)
]

const switchToManual: Program = {
	source: "switchToManualDescribed",
	value: switchToManualDescribed,
	kind: "changeSet"
}

const boardWorkloads: Workloads = { schema: Board, name: "Board", programs: boardPrograms }

const workWorkloads: Workloads = {
	schema: W.Work,
	name: "Work",
	programs: [
		namedQuery("tasksById", W.tasksById),
		namedQuery("taskCards", W.taskCards),
		namedQuery("accountsByPrefix", W.accountsByPrefix),
		switchToManual
	]
}

const workloads: Arr.NonEmptyReadonlyArray<Workloads> = [
	boardWorkloads,
	workWorkloads,
	{
		schema: W.Reports,
		name: "Work",
		programs: [namedQuery("tasksById", W.tasksById), namedQuery("accountBudgets", W.accountBudgets)]
	}
]

const nameGen = matching(regex("^[a-z][a-zA-Z0-9]{0,6}$"))

/** A schema's workload of drawn programs under drawn names, and another schema. */
type WorkloadSketch = readonly [
	Workloads,
	ReadonlyArray<{ readonly name: string; readonly p: Program }>,
	Workloads
]

const workloadGen: Gen<WorkloadSketch> = (source) => {
	const c = source.draw(element(workloads))
	const names = source.draw(uniqueArray(nameGen, (name) => name, { min: 0, max: 4 }, 20))
	return [
		c,
		Arr.map(names, (name) => ({
			name,
			p: source.draw(element(nonEmpty(c.programs, "a workload's programs")))
		})),
		source.draw(
			element(
				nonEmpty(
					Arr.filter(workloads, (o) => o.name !== c.name),
					"another schema's workload"
				)
			)
		)
	]
}

type ValueFeature = Kind | "an extension's workload" | "an empty workload"

describe("workload(schema, programs)", () => {
	it.effect(
		"records each program's Description under its name, and compiles from it with the schema named alone",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/workload/value-desc",
						/** Planted: Work's one ChangeSet program, which its drawn workloads hold a few times a run. */
						draw: drawn(workloadGen),
						literal: Formatter.format,
						features: features<ValueFeature>([
							"query",
							"changeSet",
							"an extension's workload",
							"an empty workload"
						]),
						kept: [
							{
								note: "a workload of a ChangeSet",
								sketch: [
									workWorkloads,
									[{ name: "switchToManual", p: switchToManual }],
									boardWorkloads
								],
								draws: "",
								reaches: ["changeSet"]
							}
						],
						runs: 40,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						steering: { kind: "none" },
						caseHang: Duration.minutes(2)
					},
					([c, entries, other], k) =>
						Effect.sync(() => {
							const value = admitWorkload(
								c.schema,
								Rec.fromEntries(Arr.map(entries, (e) => [e.name, e.p.value]))
							)
							unorderedEqual(
								Rec.keys(value.programs),
								Arr.map(entries, (e) => e.name)
							)
							const desc = defined(workloadState(value)?.desc, "the workload's Description")
							succeeded(decodeDesc("workload", desc), "a valid WorkloadDesc")
							assert.equal(desc.schema, c.name)
							for (const e of entries) {
								assert.equal(defined(desc.programs[e.name], e.name).kind, e.p.kind)
								k.note(e.p.kind)
							}
							const owned = (w: unknown) => [{ login: fixtureLogin, workloads: [w] }]
							const byValue = succeeded(
								compileTestWorkload(owned(value), c.schema, testCompile),
								"the workload value compiles"
							)
							const byDesc = succeeded(
								compileTestWorkload(owned(desc), c.schema, testCompile),
								"its Description compiles"
							)
							assert.deepEqual(byDesc.paths, byValue.paths)
							assert.deepEqual(byDesc.access, byValue.access)
							refused(
								compileTestWorkload(owned(desc), other.schema, testCompile),
								"MalformedDescription",
								"another schema"
							)
							if (c.schema === W.Reports) {
								k.note("an extension's workload")
							}
							if (entries.length === 0) {
								k.note("an empty workload")
							}
						})
				)
			)
	)

	it.effect("compiles a ChangeSet over a schema of the same content under another name", (ctx) =>
		Effect.gen(function* () {
			const own = planOf(W.Work, { switchToManual: switchToManualDescribed })
			yield* searched(
				ctx,
				explore(
					{
						suite: "unit/workload/value-renamed",
						draw: drawn(
							filter(matching(regex("^[A-Z][A-Za-z0-9]{0,8}$")), (name) => name !== "Work", 100)
						),
						literal: Formatter.format,
						features: features<"renamed">(["renamed"]),
						kept: [],
						runs: 10,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						steering: { kind: "none" },
						caseHang: Duration.minutes(2)
					},
					(name, k) =>
						Effect.sync(() => {
							const renamed = schema(name, W.Work.relations, W.Work.statements)
							const plan = succeeded(
								compileTestWorkload(
									[
										{
											login: fixtureLogin,
											workloads: [
												admitWorkload(renamed, { switchToManual: switchToManualDescribed })
											]
										}
									],
									renamed,
									testCompile
								),
								"the workload over the renamed schema compiles"
							)
							const paths = (p: typeof plan) =>
								Rec.map(
									defined(p.access[fixtureLogin], "the login's programs' access"),
									(a) => a.paths
								)
							assert.deepEqual(paths(plan), paths(own))
							k.note("renamed")
						})
				)
			)
		})
	)

	it.effect("refuses a program the checker refuses, naming the program", (ctx) =>
		Effect.gen(function* () {
			/** A Description reaches past the builder's level check: a query over Work's Account in Board's workload. */
			const board = defined(workloadState(workload(Board, {}))?.desc, "Board's workload")
			const foreign = defined(
				defined(
					workloadState(workload(W.Work, { accountsByPrefix: W.accountsByPrefix }))?.desc,
					"Work's workload"
				).programs["accountsByPrefix"],
				"accountsByPrefix's Description"
			)
			yield* searched(
				ctx,
				explore(
					{
						suite: "unit/workload/value-checker",
						draw: drawn(nameGen),
						literal: Formatter.format,
						features: features<"named">(["named"]),
						kept: [],
						runs: 20,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						steering: { kind: "none" },
						caseHang: Duration.minutes(2)
					},
					(name, k) =>
						Effect.sync(() => {
							const r = refused(
								compileTestWorkload(
									[
										{
											login: fixtureLogin,
											workloads: [{ ...board, programs: { [name]: foreign } }]
										}
									],
									Board,
									testCompile
								),
								"MalformedDescription",
								"a program over another schema"
							)
							assert.deepEqual(
								refusalLoc(r).path.slice(0, 2),
								["programs", name],
								formatLoc(refusalLoc(r))
							)
							k.note("named")
						})
				)
			)
		})
	)
})

/** What workload()'s signature forbids, each refused MalformedDescription. */
const forbidden: Arr.NonEmptyReadonlyArray<readonly [string, () => unknown]> = [
	["no schema", () => admitWorkload({}, {})],
	["programs as a list", () => admitWorkload(Board, [orderedTasks])],
	["a program that is no program", () => admitWorkload(Board, { x: 1 })],
	["an empty program name", () => admitWorkload(Board, { "": orderedTasks })],
	["a third argument", () => admitWorkload(Board, {}, {})],
	[
		"a program over a schema that is no level of the workload's",
		() => admitWorkload(W.Work, { orderedTasks })
	],
	[
		"a program over an extension of the workload's schema",
		() => admitWorkload(W.Work, { accountBudgets: W.accountBudgets })
	]
]

/**
 * Where a JavaScript caller hands workload() a value whose reading runs the caller's code: as the programs record, or as
 * one program in it beside a live one.
 */
type UnreadableSite = "programs record" | "program"

type UnreadableFeature = `${UnreadableSite} ${"proxy" | "throwing getter"}`

describe("workload()'s signature", () => {
	it.effect("refuses what it forbids with MalformedDescription", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					suite: "unit/workload/value-signature",
					generator: element(forbidden),
					literal: Formatter.format,
					limit: forbidden.length,
					features: noFeatures,
					caseHang: Duration.minutes(2)
				},
				([why, call]) =>
					Effect.sync(() => {
						refused(catchCompileError(call), "MalformedDescription", why)
					})
			)
		)
	)

	it.effect(
		"refuses a programs record or a program whose reading throws with MalformedDescription, never a defect",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/workload/value-unreadable",
						draw: drawn((source) => ({
							site: source.draw(element<UnreadableSite>(["programs record", "program"])),
							wild: source.draw(
								map(wild(["proxy", "throwing-getter"]), (w): Drawn<never, never> => ({
									kind: "wild",
									wild: w
								}))
							)
						})),
						literal: Formatter.format,
						features: features<UnreadableFeature>([
							"programs record proxy",
							"programs record throwing getter",
							"program proxy",
							"program throwing getter"
						]),
						kept: [],
						runs: 40,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						steering: { kind: "none" },
						caseHang: Duration.minutes(2)
					},
					({ site, wild }, k) =>
						Effect.sync(() => {
							const unreadable = passed(wild)
							assert.ok(
								typeof unreadable === "object" && unreadable !== null,
								"an unreadable value is an object"
							)
							throwsRefused(
								() =>
									site === "programs record"
										? admitWorkload(Board, unreadable)
										: admitWorkload(Board, { orderedTasks, unreadable }),
								"MalformedDescription"
							)
							k.note(
								`${site} ${wild.kind === "wild" && wild.wild.kind === "proxy" ? "proxy" : "throwing getter"}`
							)
						})
				)
			)
	)
})

const schemas: Arr.NonEmptyReadonlyArray<{
	readonly name: string
	readonly fingerprint: SchemaFingerprint
}> = [
	{ name: "Board", fingerprint: planOf(Board, {}).schema },
	{ name: "Work", fingerprint: planOf(W.Work, {}).schema }
]

/** One program written at two lines of this file: the same program at other source locations. */
const writtenOnce = query(W.Work).rule((r) => {
	const { id, account } = v(W.Task)
	return r
		.match(W.Task, { id, account })
		.where(r.eq(account, r.param("account", uuid)))
		.find({ id })
})

const writtenTwice = query(W.Work).rule((r) => {
	const { id, account } = v(W.Task)
	return r
		.match(W.Task, { id, account })
		.where(r.eq(account, r.param("account", uuid)))
		.find({ id })
})

/** The programs whose fingerprints are compared, with the schema each is written over; the twins are one program. */
const fingerprinted = nonEmpty<Program & { readonly over: unknown }>(
	[
		...Arr.map(boardPrograms, (p) => ({ ...p, over: Board })),
		{ ...namedQuery("the twin", writtenOnce), over: W.Work },
		{ ...namedQuery("the twin", writtenTwice), over: W.Work }
	],
	"the fingerprinted programs"
)

/** A program as the workload receives it: the value, or the value rebuilt from its Description. */
type Form = "the program" | "the rebuilt program"

const descOf = (program: (typeof fingerprinted)[number], form: Form) => {
	const value =
		form === "the program"
			? program.value
			: succeeded(queryFromDescription(describeQuery(program.value), program.over), "the rebuild")
	return defined(programDescOf(value), "a program the builders made").program.desc
}

describe("page query fingerprints", () => {
	it.effect(
		"are equal exactly for one program over one schema, whatever its source locations",
		(ctx) =>
			Effect.gen(function* () {
				const side = (source: Source) => ({
					program: source.draw(element(fingerprinted)),
					form: source.draw(element<Form>(["the program", "the rebuilt program"])),
					schema: source.draw(element(schemas))
				})
				const sides = (source: Source) => [source.draw(side), source.draw(side)] as const
				type FingerprintFeature = Form | "one program" | "one program written at two lines"
				yield* searched(
					ctx,
					explore(
						{
							suite: "unit/workload/value-fingerprint",
							draw: drawn(sides),
							literal: Formatter.format,
							features: features<FingerprintFeature>([
								"the program",
								"the rebuilt program",
								"one program",
								"one program written at two lines"
							]),
							kept: [],
							runs: 200,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							steering: { kind: "none" },
							caseHang: Duration.minutes(2)
						},
						([a, b], k) =>
							Effect.sync(() => {
								const fingerprint = (s: typeof b) => {
									const desc = descOf(s.program, s.form)
									assert.ok(desc.kind === "query", "a fingerprinted program is a query")
									return succeeded(pageQueryFingerprint(desc.query, s.schema.fingerprint))
								}
								const [fa, fb] = [fingerprint(a), fingerprint(b)]
								assert.match(fa, regex("^[0-9a-f]{64}$"))
								assert.equal(
									fa === fb,
									a.program.source === b.program.source && a.schema.name === b.schema.name
								)
								k.note(a.form)
								k.note(b.form)
								if (a.program.source === b.program.source) {
									k.note("one program")
								}
								if (a.program.source === b.program.source && a.program.value !== b.program.value) {
									k.note("one program written at two lines")
								}
							})
					)
				)
			})
	)
})
