/** What the properties of value.test.ts read: its spaces, models and helpers. */

import { defined, nonEmpty } from "@bjornpagen/testing/assert"
import {
	array,
	constant,
	element,
	type Gen,
	map,
	uniqueKeys,
	weighted
} from "@bjornpagen/testing/gen"
import { type Drawn, lsw, passed, WILD_IS_DATA, WILD_KINDS, wild } from "@bjornpagen/testing/lsw"
import { matching } from "@bjornpagen/testing/pattern"
import type { Source } from "@bjornpagen/testing/source"
import { regex } from "arkregex"
import { Array as Arr, Option, Record as Rec } from "effect"
import { workloadState } from "#compiler/program/workload/value.ts"
import { workload } from "#compiler/public/workload.ts"
import type { FixtureSchema } from "#test/support/compile.ts"
import * as W from "#test/support/fixtures/api/work.ts"
import { schemaNameGenOtherThan } from "#test/support/kernel/dict.ts"
import { pickFrom, pickGen } from "#test/support/pick.ts"
import {
	Board,
	orderedTasks,
	planOf,
	switchToManualDescribed,
	tasksForAccount,
	titlesByPrefix,
	topThree,
	urgentAtLeast
} from "#test/support/unit/workload/fixtures.ts"

type Kind = "query" | "changeSet"

/** A program of a workload: the fixture it is, its value, and whether it is a query or a ChangeSet. */
interface Program {
	readonly source: string
	readonly value: unknown
	readonly kind: Kind
}

/**
 * A schema value, the name its WorkloadDesc records (an extension's own), and programs over it or one of its levels.
 */
interface Workloads {
	readonly schema: FixtureSchema
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
		name: "Reports",
		programs: [namedQuery("tasksById", W.tasksById), namedQuery("accountBudgets", W.accountBudgets)]
	}
]

/** A program's name, as a caller names it in a workload. */
export const nameGen = matching(regex("^[a-z][a-zA-Z0-9]{0,6}$"))

/** A schema's workload of drawn programs under drawn names, and another schema. */
type WorkloadSketch = readonly [
	Workloads,
	ReadonlyArray<{ readonly name: string; readonly p: Program }>,
	Workloads
]

/** A schema's workload of drawn programs under drawn names, Work's one ChangeSet program among them a few times a run. */
export const workloadGen: Gen<WorkloadSketch> = (source) => {
	const c = source.draw(element(workloads))
	const names = source.draw(uniqueKeys(nameGen, { min: 0, max: 4 }))
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

/** What a workload value held: a query, a ChangeSet, an extension's schema, or nothing. */
export type ValueFeature = Kind | "an extension's workload" | "an empty workload"

/** A schema name of the dictionary other than Work's own, which a renamed Work takes. */
export const renamedNameGen = map(
	schemaNameGenOtherThan(new Set(["Work"])),
	(name) => name.declared
)

/** The plan of Work's ChangeSet program over Work itself. */
export const own = planOf(W.Work, { switchToManual: switchToManualDescribed })

/** A Description reaches past the builder's level check: a query over Work's Account in Board's workload. */
export const board = defined(workloadState(workload(Board, {}))?.desc, "Board's workload")

/** Work's accountsByPrefix as its workload's Description holds it: a program over Work, not Board. */
export const foreign = defined(
	defined(
		workloadState(workload(W.Work, { accountsByPrefix: W.accountsByPrefix }))?.desc,
		"Work's workload"
	).programs["accountsByPrefix"],
	"accountsByPrefix's Description"
)

/** The schemas a workload is drawn over: the worked example, its Reports level, and Board. */
type SchemaName = "Work" | "Reports" | "Board"

/** The schema value of a name. */
export const schemaValue = (name: SchemaName): unknown =>
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

const schemaNameGen: Gen<SchemaName> = element(["Work", "Reports", "Board"] as const)

/** The wild kinds whose values are data: a value no schema, record or program is, read without running code. */
const dataKinds = nonEmpty(
	Arr.filter(WILD_KINDS, (kind) => WILD_IS_DATA[kind]),
	"the data wild kinds"
)

/** A program a record holds: one over a drawn schema, by a pick among its programs, or a value that is no program. */
type ProgramArg =
	| { readonly kind: "program"; readonly over: SchemaName; readonly pick: number }
	| { readonly kind: "no program"; readonly value: Drawn<never, never> }

/**
 * A programs argument by what it is, each an object as workload()'s type asks: a plain record, a list, or a function. No
 * value is two of them, so a case's verdict is its arm's: an empty record is a record, never a wild value.
 */
type ProgramsArg =
	| {
			readonly kind: "record"
			readonly entries: ReadonlyArray<{ readonly name: string; readonly program: ProgramArg }>
	  }
	| { readonly kind: "list"; readonly programs: ReadonlyArray<ProgramArg> }
	| { readonly kind: "function" }

/** A call of workload(): its schema, its programs, and any argument past them. */
interface SignatureCase {
	readonly schema: Drawn<SchemaName, never>
	readonly programs: ProgramsArg
	readonly extra: ReadonlyArray<Drawn<never, never>>
}

const wildData: Gen<Drawn<never, never>> = map(wild(dataKinds), (w): Drawn<never, never> => ({
	kind: "wild",
	wild: w
}))

const programArgGen: Gen<ProgramArg> = weighted<ProgramArg>([
	[4, (s) => ({ kind: "program", over: s.draw(schemaNameGen), pick: s.draw(pickGen) })],
	[1, (s) => ({ kind: "no program", value: s.draw(wildData) })]
])

/** A program name: an identifier, or the empty name. */
const programNameGen: Gen<string> = weighted<string>([
	[5, nameGen],
	[1, (): string => ""]
])

/** A call of workload(): a live or wild schema, a programs argument of each shape, and at most one argument past it. */
export const signatureCaseGen: Gen<SignatureCase> = (source) => ({
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
			[1, constant<ProgramsArg>({ kind: "function" })]
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
export const admits = (c: SignatureCase): boolean => {
	if (c.extra.length > 0 || c.schema.kind !== "live" || c.programs.kind !== "record") {
		return false
	}
	const schema = c.schema.value
	return Arr.every(
		[...recordOf(c.programs.entries)],
		([name, p]) => name !== "" && p.kind === "program" && belongs(p.over, schema)
	)
}

/** The value a case passes as workload()'s programs. */
export const programsValue = (p: ProgramsArg): object => {
	switch (p.kind) {
		case "record":
			return Rec.fromEntries(Arr.map(p.entries, (e) => [e.name, programValue(e.program)] as const))
		case "list":
			return Arr.map(p.programs, programValue)
		case "function":
			return () => undefined
	}
}

/** What a call of workload() was: admitted, or each way it leaves the signature. */
export type SignatureFeature =
	| "admitted"
	| "a wild schema"
	| "an empty programs record"
	| "programs as a list"
	| "programs as a function"
	| "an empty program name"
	| "a value that is no program"
	| "a program over another schema"
	| "a program over a level below"
	| "a program over an extension"
	| "a third argument"

/** The features a call of workload() names. */
export const signatureFeatures = (c: SignatureCase): ReadonlyArray<SignatureFeature> => {
	const schema = c.schema.kind === "live" ? Option.some(c.schema.value) : Option.none()
	const programs = c.programs.kind === "record" ? [...recordOf(c.programs.entries)] : []
	const over = (test: (p: SchemaName, s: SchemaName) => boolean) =>
		Option.exists(schema, (s) =>
			Arr.some(programs, ([, p]) => p.kind === "program" && test(p.over, s))
		)
	return [
		...(admits(c) ? ["admitted" as const] : []),
		...(c.schema.kind === "wild" ? ["a wild schema" as const] : []),
		...(c.programs.kind === "record" && c.programs.entries.length === 0
			? ["an empty programs record" as const]
			: []),
		...(c.programs.kind === "list" ? ["programs as a list" as const] : []),
		...(c.programs.kind === "function" ? ["programs as a function" as const] : []),
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

/** Where an unreadable value sat, and what it was. */
export type UnreadableFeature = `${UnreadableSite} ${"proxy" | "throwing getter"}`

/** An unreadable value at a site: a proxy or an object with a throwing getter, as the programs record or one program. */
export const unreadableGen = (source: Source) => ({
	site: source.draw(element<UnreadableSite>(["programs record", "program"])),
	wild: source.draw(
		map(wild(["proxy", "throwing-getter"]), (w): Drawn<never, never> => ({
			kind: "wild",
			wild: w
		}))
	)
})
