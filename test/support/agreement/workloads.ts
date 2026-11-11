import { floorPopulation, type Situations } from "@grizzle/testing/features"
import { element, type Gen, int } from "@grizzle/testing/gen"
import { floorSeed, rotatingSeed } from "@grizzle/testing/random"
import { sample } from "@grizzle/testing/source"
import { Array as Arr, Effect, Record as Rec } from "effect"
import { catchCompileError } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import * as Result from "#compiler/core/result.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import { workload, workloadState } from "#compiler/program/workload/value.ts"
import { keyQuery } from "#compiler/query/build/key.ts"
import {
	Account,
	addTask,
	addTaskAbove,
	addThing,
	byName,
	Clerk,
	clerkAccount,
	clerkAccounts,
	clerkNewest,
	Kind,
	newestTasks,
	Other,
	Reader,
	Reports,
	Tally,
	Task,
	tallies,
	tasks,
	Thing,
	things,
	twins,
	Work,
	Writer,
	writerTasks
} from "#test/support/agreement/workload-schema.ts"
import { compileTemplate, compileTestWorkload, testCompile } from "#test/support/compile.ts"
import {
	identifiers,
	preludeAt,
	preludeImports,
	type PreludeAt,
	preludeFrom
} from "#test/support/prelude.ts"

/**
 * The workload agreement: workloads drawn over the values of ./workload-schema.ts, each with the engine's verdict on
 * it, and the one TypeScript program that states every verdict as types, which the type tier checks
 * (test/types/api/workload.test.ts). The engine is the oracle, as every caller meets it: workload() builds the value,
 * the workload compiler plans it as `grizzle generate` does (program/workload/compile.ts), and a workload over a role
 * has each of its reads compiled for the role as a login's compile does (adapter/served/login.ts compileRoleWorkload:
 * a query over the role, a key through its lookup query over the role). A drawn workload
 * typechecks exactly when the engine admits it; an admitted one's type is Workload over its schema and its programs
 * record, each program's own type under its name, exactly as the value keeps them.
 *
 * A case draws its schema (Work, its extension Reports, a writer, a reader and a clerk of Work, and Other, a schema
 * no level of Work reaches), and one to three programs, each a query, an ordered query, a ChangeSet or a key over any
 * of those schemas or Twin, a schema of Work's name and other content, or a value that is no program (a schema). The
 * programs are a record, or, as a planted fault, a list. A refusal stands under its directive, on the workload's one
 * line.
 *
 * An admitted workload over Work or a role of it, owned by a login over Work holding every role of Work, is also opened
 * through the login served as its type, `served<typeof L>(file, name)`: Db.open of a served role is exactly the Db the
 * login's own role types, its workload's handles among it, and a role the login does not hold is no member of the served
 * login's roles.
 *
 * One class of workloads the types accept and the engine refuses is declared (declaredClasses) and drawn with no
 * directive, its refusal asserted by its reason: a program under the empty name, which the record's string keys admit
 * and the builder refuses (MalformedDescription), a program's name being the handle a Db reaches it by.
 */
const schemaNames = ["Work", "Reports", "Writer", "Reader", "Clerk", "Other"] as const
type SchemaName = (typeof schemaNames)[number]

const workloadSchemas: { readonly [S in SchemaName]: object } = {
	Work,
	Reports,
	Writer,
	Reader,
	Clerk,
	Other
}

/** The schema a workload over each of the drawn schemas is planned over: a role's base, or the schema itself. */
const plannedOver: { readonly [S in SchemaName]: object } = {
	Work,
	Reports,
	Writer: Work,
	Reader: Work,
	Clerk: Work,
	Other
}

/** The roles among the drawn schemas: a workload over one has its reads compiled for it. */
const roleSchemas: { readonly [S in SchemaName]: boolean } = {
	Work: false,
	Reports: false,
	Writer: true,
	Reader: true,
	Clerk: true,
	Other: false
}

/**
 * The role of `login(Work, ..., [Writer, Reader, Clerk], { workload: [w] })` a Db opened through the login's served
 * workload runs a workload over each schema the login holds on: over a role, that role; over the base, a full role.
 */
const servedRoles: ReadonlyMap<SchemaName, string> = new Map([
	["Work", "writer"],
	["Writer", "writer"],
	["Reader", "reader"],
	["Clerk", "clerk"]
])

type ProgramKind = "query" | "ordered" | "changeSet" | "key" | "noProgram"

/** Every value a workload's record may name, by the name the program imports it under. */
const programNames = [
	"tasks",
	"tallies",
	"things",
	"twins",
	"writerTasks",
	"clerkAccounts",
	"newestTasks",
	"clerkNewest",
	"addTask",
	"addTaskAbove",
	"addThing",
	"Account",
	"Task",
	"Kind",
	"byName",
	"Thing",
	"Tally",
	"clerkAccount",
	"Work"
] as const
type ProgramName = (typeof programNames)[number]

/** Each program's value, and the kind of program it is. */
const workloadPrograms: {
	readonly [P in ProgramName]: { readonly value: object; readonly kind: ProgramKind }
} = {
	tasks: { value: tasks, kind: "query" },
	tallies: { value: tallies, kind: "query" },
	things: { value: things, kind: "query" },
	twins: { value: twins, kind: "query" },
	writerTasks: { value: writerTasks, kind: "query" },
	clerkAccounts: { value: clerkAccounts, kind: "query" },
	newestTasks: { value: newestTasks, kind: "ordered" },
	clerkNewest: { value: clerkNewest, kind: "ordered" },
	addTask: { value: addTask, kind: "changeSet" },
	addTaskAbove: { value: addTaskAbove, kind: "changeSet" },
	addThing: { value: addThing, kind: "changeSet" },
	Account: { value: Account, kind: "key" },
	Task: { value: Task, kind: "key" },
	Kind: { value: Kind, kind: "key" },
	byName: { value: byName, kind: "key" },
	Thing: { value: Thing, kind: "key" },
	Tally: { value: Tally, kind: "key" },
	clerkAccount: { value: clerkAccount, kind: "key" },
	Work: { value: Work, kind: "noProgram" }
}

/**
 * A fault a case may plant into a workload the engine admits, so it is the case's one fault: a list of the programs
 * in place of their record, which both refuse; or the declared class, a program under the empty name, which the
 * record's string keys admit and the builder refuses.
 */
type Planted = "a list of programs" | "a program under the empty name"

/** Each planted fault's refusal by the engine, by its tag. */
const plantedRefusal: { readonly [P in Planted]: CompileError["reason"]["_tag"] } = {
	"a list of programs": "MalformedDescription",
	"a program under the empty name": "MalformedDescription"
}

/** One case: its schema, its programs by name, and the fault it plants. */
interface WorkloadSpec {
	readonly schema: SchemaName
	readonly programs: Arr.NonEmptyReadonlyArray<readonly [string, ProgramName]>
	readonly planted: Planted | undefined
}

/** What a case reached: its schema's kind, each program's kind under the verdict, and its fault. */
export type WorkloadNote =
	| `${ProgramKind} ${"admitted" | "refused"}`
	| "over an extension"
	| "over a role"
	| "over a partial role"
	| "several programs"
	| "opened through a served login"
	| Planted

type Verdict =
	| { readonly kind: "admitted" }
	| { readonly kind: "refused"; readonly tag: CompileError["reason"]["_tag"] }

interface WorkloadCase {
	readonly spec: WorkloadSpec
	readonly verdict: Verdict
	/** The role a Db opened through the served workload of a login owning the workload runs it on, where one does. */
	readonly served: string | undefined
	readonly notes: ReadonlySet<WorkloadNote>
}

/** A drawn case's schema and programs, and the fault it would plant were its workload admitted. */
const specGen: Gen<WorkloadSpec> = (source) => {
	const schema = source.draw(element(schemaNames))
	const first = source.draw(element(programNames))
	const extra = source.draw(int(0, 2))
	const rest =
		extra === 0 ? [] : Arr.map(Arr.range(1, extra), () => source.draw(element(programNames)))
	const planted = source.draw(
		element<Planted | undefined>([
			undefined,
			undefined,
			undefined,
			undefined,
			"a list of programs",
			"a program under the empty name"
		])
	)
	return {
		schema,
		programs: [
			["p0", first],
			...Arr.map(rest, (program, at): readonly [string, ProgramName] => [`p${at + 1}`, program])
		],
		planted
	}
}

/** The programs argument as the engine is given it: a record of the drawn names, or a list of the programs. */
const programsValue = (spec: WorkloadSpec): object =>
	spec.planted === "a list of programs"
		? Arr.map(spec.programs, ([, p]) => workloadPrograms[p].value)
		: Rec.fromEntries(
				Arr.map(namedPrograms(spec), ([name, p]) => [name, workloadPrograms[p].value])
			)

/** The programs under their names: the first under the empty name where the case plants it. */
const namedPrograms = (spec: WorkloadSpec): ReadonlyArray<readonly [string, ProgramName]> =>
	spec.planted === "a program under the empty name"
		? Arr.map(spec.programs, ([name, p], at) => [at === 0 ? "" : name, p] as const)
		: spec.programs

/**
 * Each read of a workload over a role, compiled for the role as a login's compile does: a query or ordered query over
 * the role, a key through its lookup query over the role. A ChangeSet's writes the workload compiler already holds to
 * the role's write list.
 */
const roleReads = (built: unknown, roleValue: object): Result.Result<unknown, CompileError> => {
	const state = workloadState(built)
	if (state === undefined) {
		throw new Error("workload() keeps the state of every value it builds")
	}
	for (const program of state.programs) {
		const compiled =
			program.kind === "query" || program.kind === "ordered"
				? compileTemplate(program.value, roleValue, testCompile)
				: program.kind === "key"
					? Result.flatMap(
							catchCompileError(() => keyQuery(roleValue, program.target)),
							(q) => compileTemplate(q, undefined, testCompile)
						)
					: Result.ok(undefined)
		if (!compiled.ok) {
			return compiled
		}
	}
	return Result.ok(undefined)
}

/** The engine's verdict on a case: the builder's, the workload compiler's, and a role's compilation of its reads. */
const verdictOf = (spec: WorkloadSpec): Verdict => {
	const value = workloadSchemas[spec.schema]
	const judged = Result.flatMap(
		catchCompileError(() => workload(value, programsValue(spec))),
		(built) =>
			Result.flatMap(
				compileTestWorkload(
					[{ login: "agreement", workloads: [built] }],
					plannedOver[spec.schema],
					testCompile
				),
				() => (roleSchemas[spec.schema] ? roleReads(built, value) : Result.ok(undefined))
			)
	)
	return judged.ok ? { kind: "admitted" } : { kind: "refused", tag: judged.error.reason._tag }
}

/**
 * A case: its drawn workload, with its fault planted where the engine admits the workload clean, so the planted fault
 * is its one refusal, which must be the fault's own.
 */
const caseGen: Gen<WorkloadCase> = (source) => {
	const drawn = specGen(source)
	const clean: WorkloadSpec = { ...drawn, planted: undefined }
	const cleanVerdict = verdictOf(clean)
	const spec = cleanVerdict.kind === "admitted" ? drawn : clean
	const verdict = spec.planted === undefined ? cleanVerdict : verdictOf(spec)
	if (spec.planted !== undefined) {
		const expected = plantedRefusal[spec.planted]
		if (verdict.kind !== "refused" || verdict.tag !== expected) {
			throw new Error(
				`the engine refuses ${spec.planted} by ${expected}, not ${verdict.kind === "refused" ? verdict.tag : "admitting it"}: ${sourceOf(spec, 0)}`
			)
		}
	}
	const notes = new Set<WorkloadNote>()
	if (spec.planted === undefined) {
		for (const [, program] of spec.programs) {
			if (spec.programs.length === 1 || verdict.kind === "admitted") {
				notes.add(`${workloadPrograms[program].kind} ${verdict.kind}`)
			}
		}
	} else {
		notes.add(spec.planted)
	}
	if (spec.schema === "Reports") {
		notes.add("over an extension")
	}
	if (roleSchemas[spec.schema]) {
		notes.add(spec.schema === "Clerk" ? "over a partial role" : "over a role")
	}
	if (spec.programs.length > 1) {
		notes.add("several programs")
	}
	const served = verdict.kind === "admitted" ? servedRoles.get(spec.schema) : undefined
	if (served !== undefined) {
		notes.add("opened through a served login")
	}
	return { spec, verdict, served, notes }
}

/** The programs argument, in the program: a record of the drawn names, or a list. */
const programsSource = (spec: WorkloadSpec): string =>
	spec.planted === "a list of programs"
		? `[${Arr.join(
				Arr.map(spec.programs, ([, p]) => p),
				", "
			)}]`
		: `{ ${Arr.join(
				Arr.map(namedPrograms(spec), ([name, p]) => `${jsonText(name)}: ${p}`),
				", "
			)} }`

const sourceOf = (spec: WorkloadSpec, i: number): string =>
	`export const w${i} = workload(${spec.schema}, ${programsSource(spec)})`

/** The type an admitted workload must have: Workload over its schema, each program's own type under its name. */
const workloadType = (spec: WorkloadSpec): string =>
	`Workload<typeof ${spec.schema}, { ${Arr.join(
		Arr.map(namedPrograms(spec), ([name, p]) => `readonly ${jsonText(name)}: typeof ${p}`),
		"; "
	)} }>`

/**
 * A login over Work owning an admitted workload, served as its type: a Db opened through the served login's role is
 * exactly the Db the login's own role types, its workload's handles among it, and a role the login does not hold is no
 * role of the served login.
 */
const servedLines = (role: string, i: number): ReadonlyArray<string> => [
	`export const l${i} = login(Work, "l${i}", [Writer, Reader, Clerk], { workload: [w${i}] })`,
	`export const s${i} = served<typeof l${i}>(file, "l${i}")`,
	`export const o${i} = Db.open(s${i}.roles.${role}, { token: "token" })`,
	`export type d${i} = Expect<Equals<Effect.Success<typeof o${i}>, OpenedAs<(typeof l${i})["roles"]["${role}"]>>>`,
	"// @ts-expect-error -- refused: a served login holds its login's roles alone",
	`export const z${i} = s${i}.roles.stranger`
]

/** One case's statements: its workload, under its refusal's directive, or its type asserted. */
const blockOf = (c: WorkloadCase, i: number): ReadonlyArray<string> => {
	const statement = sourceOf(c.spec, i)
	if (c.verdict.kind === "admitted") {
		return [
			statement,
			`export type t${i} = Expect<Equals<typeof w${i}, ${workloadType(c.spec)}>>`,
			...(c.served === undefined ? [] : servedLines(c.served, i))
		]
	}
	switch (c.spec.planted) {
		case "a program under the empty name":
			return [
				`/** Declared: the types admit the empty name, the engine refuses it, ${c.verdict.tag}. */`,
				statement
			]
		case "a list of programs":
			return [
				"// @ts-expect-error -- refused: the programs are a record of named programs, never a list",
				statement
			]
		case undefined:
			return [
				"// @ts-expect-error -- refused: a program over a level of the workload's schema, or a key of a relation of one",
				statement
			]
	}
}

/** The situations the floor's witnesses reach: every kind of program under both verdicts, and every shape of case. */
export const workloadRequired: Situations<WorkloadNote> = [
	"query admitted",
	"query refused",
	"ordered admitted",
	"ordered refused",
	"changeSet admitted",
	"changeSet refused",
	"key admitted",
	"key refused",
	"noProgram refused",
	"over an extension",
	"over a role",
	"over a partial role",
	"several programs",
	"opened through a served login",
	"a list of programs",
	"a program under the empty name"
]

/** The workloads the run's own stream draws, beside the floor's witnesses. */
const workloadCount = 120

const workloadLabel = "types/api workload agreement"

export const workloadWitnesses = () =>
	floorPopulation(workloadLabel, caseGen, workloadCount, (c) => [...c.notes])

const workloadCases = (seed: number): ReadonlyArray<WorkloadCase> => [
	...workloadWitnesses().values,
	...sample(caseGen, rotatingSeed(seed, floorSeed(workloadLabel)), workloadCount)
]

/** The workload program's prelude (test/support/programs/workloads.ts), every name it reads. */
const prelude = await Effect.runPromise(preludeAt("test/support/programs/workloads.ts"))

export const workloadEntriesFrom = (entry: (path: string) => string): PreludeAt =>
	preludeFrom(prelude, entry)

/** The program over the run's cases: one module, each case a statement and its assertion, its imports what it reads. */
export const workloadModule = (entries: PreludeAt, seed: number): string => {
	const body = Arr.join(Arr.flatMap(workloadCases(seed), blockOf), "\n")
	const cases = identifiers(body)
	const declarations = [
		...(cases.has("Expect")
			? [
					"type Equals<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false",
					"type Expect<T extends true> = T"
				]
			: []),
		...(cases.has("served")
			? [
					"type OpenedAs<X> = X extends LoginRole<infer R, infer P> ? DbOf<R, P> : never",
					"declare const file: unknown"
				]
			: [])
	]
	const read = identifiers(Arr.join([...declarations, body], "\n"))
	return Arr.join(
		[
			"// Generated by test/support/agreement/workloads.ts: the workload type/engine agreement.",
			...preludeImports(entries, read),
			"",
			...declarations,
			"",
			body,
			""
		],
		"\n"
	)
}
