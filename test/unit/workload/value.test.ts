import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import {
	array,
	element,
	filter,
	type Gen,
	int,
	map,
	uniqueArray,
	weighted
} from "@grizzle/testing/gen"
import { type Drawn, lsw, passed, WILD_IS_DATA, WILD_KINDS, wild } from "@grizzle/testing/lsw"
import { matching } from "@grizzle/testing/pattern"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import type { Source } from "@grizzle/testing/source"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Record as Rec } from "effect"
import { catchCompileError } from "#compiler/core/canonical.ts"
import type { SchemaFingerprint } from "#compiler/core/ids.ts"
import { formatLoc } from "#compiler/core/loc.ts"
import { decodeDesc } from "#compiler/ir/desc.ts"
import { describeQuery } from "#compiler/program/describe.ts"
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
import { queryFromDescription } from "#test/support/describe.ts"
import { caseHang } from "#test/support/limits.ts"
import { pickFrom, pickGen } from "#test/support/pick.ts"
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
						coverage: required<ValueFeature>(
							["query", "changeSet", "an extension's workload", "an empty workload"],
							{ cases: 40, sense: notesOnly }
						),
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
						caseHang
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
						coverage: required<"renamed">(["renamed"], { cases: 10, sense: notesOnly }),
						kept: [],
						runs: 10,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
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
						coverage: required<"named">(["named"], { cases: 20, sense: notesOnly }),
						kept: [],
						runs: 20,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
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

/** The schemas a workload is drawn over: the worked example, its Reports level, and Board. */
type SchemaName = "Work" | "Reports" | "Board"

const schemaValue = (name: SchemaName): unknown =>
	name === "Work" ? W.Work : name === "Reports" ? W.Reports : Board

/** Each schema's own programs, every one over it. */
const ownPrograms = (name: SchemaName): Arr.NonEmptyReadonlyArray<Program> =>
	name === "Work"
		? nonEmpty(workWorkloads.programs, "Work's programs")
		: name === "Reports"
			? [namedQuery("accountBudgets", W.accountBudgets)]
			: nonEmpty(boardPrograms, "Board's programs")

/** Whether a program over `over` belongs in a workload over `schema`: over it, or over a level below it. */
const belongs = (over: SchemaName, schema: SchemaName): boolean =>
	over === schema || (over === "Work" && schema === "Reports")

const schemaNameGen: Gen<SchemaName> = (source) => {
	switch (source.draw(int(0, 2))) {
		case 0:
			return "Work"
		case 1:
			return "Reports"
		default:
			return "Board"
	}
}

/** The wild kinds whose values are data: a value no schema, record or program is, read without running code. */
const dataKinds = nonEmpty(
	Arr.filter(WILD_KINDS, (kind) => WILD_IS_DATA[kind]),
	"the data wild kinds"
)

/** A program a record holds: one over a drawn schema, by a pick among its programs, or a value that is no program. */
type ProgramArg =
	| { readonly kind: "program"; readonly over: SchemaName; readonly pick: number }
	| { readonly kind: "no program"; readonly value: Drawn<never, never> }

type ProgramsArg =
	| {
			readonly kind: "record"
			readonly entries: ReadonlyArray<{ readonly name: string; readonly program: ProgramArg }>
	  }
	| { readonly kind: "list"; readonly programs: ReadonlyArray<ProgramArg> }
	| { readonly kind: "wild"; readonly value: Drawn<never, never> }

interface SignatureCase {
	readonly schema: Drawn<SchemaName, never>
	readonly programs: ProgramsArg
	readonly extra: ReadonlyArray<Drawn<never, never>>
}

const wildData: Gen<Drawn<never, never>> = map(wild(dataKinds), (w): Drawn<never, never> => ({
	kind: "wild",
	wild: w
}))

/** A wild value that is an object or a function: what a programs argument's type admits, of no record's shape. */
const wildObject: Gen<Drawn<never, never>> = map(
	wild(["function", "anything"]),
	(w): Drawn<never, never> => ({ kind: "wild", wild: w })
)

const programArgGen: Gen<ProgramArg> = weighted<ProgramArg>([
	[4, (s) => ({ kind: "program", over: s.draw(schemaNameGen), pick: s.draw(pickGen) })],
	[1, (s) => ({ kind: "no program", value: s.draw(wildData) })]
])

/** A program name: an identifier, or the empty name. */
const programNameGen: Gen<string> = weighted<string>([
	[5, nameGen],
	[1, (): string => ""]
])

const signatureCaseGen: Gen<SignatureCase> = (source) => ({
	schema: source.draw(lsw({ live: schemaNameGen, stale: Option.none(), wild: dataKinds })),
	programs: source.draw(
		weighted<ProgramsArg>([
			[
				5,
				(s) => ({
					kind: "record",
					entries: s.draw(
						array((e) => ({ name: e.draw(programNameGen), program: e.draw(programArgGen) }), {
							min: 0,
							max: 3
						})
					)
				})
			],
			[1, (s) => ({ kind: "list", programs: s.draw(array(programArgGen, { min: 0, max: 2 })) })],
			[1, (s) => ({ kind: "wild", value: s.draw(wildObject) })]
		])
	),
	extra: source.draw(array(wildData, { min: 0, max: 1 }))
})

const programValue = (p: ProgramArg): unknown =>
	p.kind === "no program" ? passed(p.value) : pickFrom(ownPrograms(p.over), p.pick).value

/** The record a caller's entries make: a later entry of one name replaces an earlier one. */
const recordOf = (
	entries: ReadonlyArray<{ readonly name: string; readonly program: ProgramArg }>
): ReadonlyMap<string, ProgramArg> => new Map(Arr.map(entries, (e) => [e.name, e.program] as const))

/** Whether workload() admits a case: two arguments, a schema, a record of named programs over it or a level below. */
const admits = (c: SignatureCase): boolean => {
	if (c.extra.length > 0 || c.schema.kind !== "live" || c.programs.kind !== "record") {
		return false
	}
	const schema = c.schema.value
	return Arr.every(
		[...recordOf(c.programs.entries)],
		([name, p]) => name !== "" && p.kind === "program" && belongs(p.over, schema)
	)
}

/**
 * The value a case passes as workload()'s programs, which its type asks to be an object: a record, a list, or a wild
 * object or function; a wild value of another kind no typed caller can pass.
 */
const programsValue = (p: ProgramsArg): Option.Option<object> => {
	switch (p.kind) {
		case "record":
			return Option.some(
				Rec.fromEntries(Arr.map(p.entries, (e) => [e.name, programValue(e.program)] as const))
			)
		case "list":
			return Option.some(Arr.map(p.programs, programValue))
		case "wild": {
			const value = passed(p.value)
			return (typeof value === "object" && value !== null) || typeof value === "function"
				? Option.some(value)
				: Option.none()
		}
	}
}

type SignatureFeature =
	| "admitted"
	| "a wild schema"
	| "programs as a list"
	| "wild programs"
	| "an empty program name"
	| "a value that is no program"
	| "a program over another schema"
	| "a program over a level below"
	| "a program over an extension"
	| "a third argument"

const signatureFeatures = (c: SignatureCase): ReadonlyArray<SignatureFeature> => {
	const schema = c.schema.kind === "live" ? Option.some(c.schema.value) : Option.none()
	const programs = c.programs.kind === "record" ? [...recordOf(c.programs.entries)] : []
	const over = (test: (p: SchemaName, s: SchemaName) => boolean) =>
		Option.exists(schema, (s) =>
			Arr.some(programs, ([, p]) => p.kind === "program" && test(p.over, s))
		)
	return [
		...(admits(c) ? ["admitted" as const] : []),
		...(c.schema.kind === "wild" ? ["a wild schema" as const] : []),
		...(c.programs.kind === "list" ? ["programs as a list" as const] : []),
		...(c.programs.kind === "wild" ? ["wild programs" as const] : []),
		...(Arr.some(programs, ([name]) => name === "") ? ["an empty program name" as const] : []),
		...(Arr.some(programs, ([, p]) => p.kind === "no program")
			? ["a value that is no program" as const]
			: []),
		...(over((p, s) => !belongs(p, s) && !(p === "Reports" && s === "Work"))
			? ["a program over another schema" as const]
			: []),
		...(over((p, s) => p !== s && belongs(p, s)) ? ["a program over a level below" as const] : []),
		...(over((p, s) => p === "Reports" && s === "Work")
			? ["a program over an extension" as const]
			: []),
		...(c.extra.length > 0 ? ["a third argument" as const] : [])
	]
}

/**
 * Where a JavaScript caller hands workload() a value whose reading runs the caller's code: as the programs record, or as
 * one program in it beside a live one.
 */
type UnreadableSite = "programs record" | "program"

type UnreadableFeature = `${UnreadableSite} ${"proxy" | "throwing getter"}`

describe("workload()'s signature", () => {
	it.effect(
		"admits a schema and a record of named programs over it or a level below, and refuses any other call with MalformedDescription",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/workload/value-signature",
						draw: drawn(signatureCaseGen),
						literal: Formatter.format,
						oracle: {
							kind: "specification",
							name: "workload(schema, programs): a schema, a plain record of named programs over it or a level below, nothing more"
						},
						coverage: required<SignatureFeature>(
							[
								"admitted",
								"a wild schema",
								"programs as a list",
								"wild programs",
								"an empty program name",
								"a value that is no program",
								"a program over another schema",
								"a program over a level below",
								"a program over an extension",
								"a third argument"
							],
							{ cases: 200, sense: notesOnly }
						),
						kept: [],
						runs: 100,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(c, k) =>
						Effect.gen(function* () {
							const programs = programsValue(c.programs)
							yield* k.assume(Option.isSome(programs))
							if (Option.isNone(programs)) {
								return
							}
							k.noteAll(signatureFeatures(c))
							const schema =
								c.schema.kind === "live" ? schemaValue(c.schema.value) : passed(c.schema)
							const [third] = c.extra
							const result = catchCompileError(() =>
								third === undefined
									? admitWorkload(schema, programs.value)
									: admitWorkload(schema, programs.value, passed(third))
							)
							if (admits(c)) {
								succeeded(result, "workload() admits a schema and its programs")
								return
							}
							refused(result, "MalformedDescription")
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
						coverage: required<UnreadableFeature>(
							[
								"programs record proxy",
								"programs record throwing getter",
								"program proxy",
								"program throwing getter"
							],
							{ cases: 40, sense: notesOnly }
						),
						kept: [],
						runs: 40,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
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
	const { id, account } = v(W.Task, "task")
	return r
		.match(W.Task, { id, account })
		.where(r.eq(account, r.param("account", uuid)))
		.find({ id })
})

const writtenTwice = query(W.Work).rule((r) => {
	const { id, account } = v(W.Task, "task")
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
							coverage: required<FingerprintFeature>(
								[
									"the program",
									"the rebuilt program",
									"one program",
									"one program written at two lines"
								],
								{ cases: 200, sense: notesOnly }
							),
							kept: [],
							runs: 200,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						([a, b], k) =>
							Effect.sync(() => {
								const fingerprint = (s: typeof b) => {
									const desc = descOf(s.program, s.form)
									assert.ok(desc.kind === "query", "a fingerprinted program is a query")
									return succeeded(pageQueryFingerprint(desc.query, s.schema.fingerprint))
								}
								const [fa, fb] = [fingerprint(a), fingerprint(b)]
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
