import { Array as Arr, Effect, Option, Order } from "effect"
import type { Refused } from "#compiler/core/refusals.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import { type PreludeAt, preludeAt, preludeFrom, preludeProgram } from "#test/support/prelude.ts"

/**
 * The untyped-member program: the box of every builder that captures a list or a record as a type (schema,
 * schema.extend, role, login, workload) by every typing of the lists and records it captures, each one holding typed
 * members only or a member typed `any` beside them, exhausted and printed as one program the type batch checks. Beside
 * the box stands one kept case: a statement list that `Object.values` over a union of law records types `any[]`, the
 * leak that left a schema's insert types without its families' nestings.
 *
 * The oracle: a call is refused exactly when a list or record it captures holds a member typed `any` (MembersTyped,
 * through DeclaredOnce and StatementsWithin for a schema's), at the first argument that holds one, since a call
 * reports the first argument its parameter refuses. Every call it admits keeps its types: a schema's insert types nest
 * each family's members at their owner's count field.
 */

/** The builders that capture a list or a record as a type. */
const builderNames = ["schema", "schema.extend", "role", "login", "workload"] as const

type BuilderName = (typeof builderNames)[number]

/** How a list or record a builder captures types its members: each typed, or one typed `any` beside them. */
const memberTypings = ["typed", "any"] as const

type MemberTyping = (typeof memberTypings)[number]

/** A list or record a builder captures: the parameter it is written at, whether it is a list, and its typed members. */
interface Captured {
	readonly param: number
	readonly holder: "list" | "record"
	readonly members: Arr.NonEmptyReadonlyArray<string>
}

/**
 * A builder's call: its callee, the lists and records it captures, and its parameters' sources, each written with the
 * captured lists and records it holds as `spell` writes them.
 */
interface Shape {
	readonly callee: string
	readonly captured: Arr.NonEmptyReadonlyArray<Captured>
	readonly params: (name: string, spell: (captured: Captured) => string) => ReadonlyArray<string>
}

/** The program's member typed `any`, which a list holds as an element and a record as a shorthand property. */
const untyped = "untyped"

const list = (param: number, ...members: Arr.NonEmptyReadonlyArray<string>): Captured => ({
	param,
	holder: "list",
	members
})
const record = (param: number, ...members: Arr.NonEmptyReadonlyArray<string>): Captured => ({
	param,
	holder: "record",
	members
})

/** A captured list or record as its call writes it, its members typed or one typed `any` beside them. */
const spelledOf = (captured: Captured, typing: MemberTyping): string => {
	const members = Arr.join(
		typing === "any" ? [...captured.members, untyped] : captured.members,
		", "
	)
	return captured.holder === "list" ? `[${members}]` : `{ ${members} }`
}

const schemaRelations = list(1, "Parent", "Kid")
const schemaStatements = list(2, "nesting")
const levelRelations = list(2, "Bag", "Item")
const levelStatements = list(3, "bagging")
const roleEntries = record(2, "Parent", "Labels")
const roleWrites = list(3, '"Parent"')
const roleRefreshes = list(3, '"Labels"')
const loginRoles = list(2, "member")
const loginWorkloads = list(3, "names")
const workloadPrograms = record(1, "ids")

/** Each builder's call over the program's relations, roles and workloads. */
const shapes: { readonly [B in BuilderName]: Shape } = {
	schema: {
		callee: "schema",
		captured: [schemaRelations, schemaStatements],
		params: (name, spell) => [jsonText(name), spell(schemaRelations), spell(schemaStatements)]
	},
	"schema.extend": {
		callee: "schema.extend",
		captured: [levelRelations, levelStatements],
		params: (name, spell) => ["Root", jsonText(name), spell(levelRelations), spell(levelStatements)]
	},
	role: {
		callee: "role",
		captured: [roleEntries, roleWrites, roleRefreshes],
		params: (name, spell) => [
			"Up",
			jsonText(name),
			spell(roleEntries),
			`{ write: ${spell(roleWrites)}, refresh: ${spell(roleRefreshes)} }`
		]
	},
	login: {
		callee: "login",
		captured: [loginRoles, loginWorkloads],
		params: (name, spell) => [
			"Root",
			jsonText(name),
			spell(loginRoles),
			`{ workload: ${spell(loginWorkloads)} }`
		]
	},
	workload: {
		callee: "workload",
		captured: [workloadPrograms],
		params: (_name, spell) => ["Root", spell(workloadPrograms)]
	}
}

/**
 * One case: its builder, what its comment says of it, its call's parameters, and the parameters of the lists and
 * records that hold a member typed `any`.
 */
interface UntypedCase {
	readonly builder: BuilderName
	readonly said: string
	readonly params: (name: string) => ReadonlyArray<string>
	readonly holdingAny: ReadonlyArray<number>
}

/** Every typing of the captured lists and records: the box's product of memberTypings over them. */
const typingsOf = (
	captured: ReadonlyArray<Captured>
): ReadonlyArray<ReadonlyArray<readonly [Captured, MemberTyping]>> =>
	Arr.reduce(
		captured,
		[[]],
		(rows: ReadonlyArray<ReadonlyArray<readonly [Captured, MemberTyping]>>, c) =>
			Arr.flatMap(rows, (row) => Arr.map(memberTypings, (typing) => [...row, [c, typing] as const]))
	)

/** The box: every builder by every typing of the lists and records it captures. */
const boxCases: ReadonlyArray<UntypedCase> = Arr.flatMap(builderNames, (builder) => {
	const shape = shapes[builder]
	return Arr.map(typingsOf(shape.captured), (typings): UntypedCase => {
		const holders = new Set(Arr.flatMap(typings, ([c, typing]) => (typing === "any" ? [c] : [])))
		return {
			builder,
			said: Arr.join(
				Arr.map(typings, ([c, typing]) => `the ${c.holder} at ${c.param} ${typing}`),
				", "
			),
			params: (name) => shape.params(name, (c) => spelledOf(c, holders.has(c) ? "any" : "typed")),
			holdingAny: Arr.map([...holders], (c) => c.param)
		}
	})
})

/** The kept case: schema.extend's statement list as `Object.values` over a union of law records types it, `any[]`. */
const keptCase: UntypedCase = {
	builder: "schema.extend",
	said: "the statement list typed any[] by Object.values over a union of law records",
	params: (name) => ["Root", jsonText(name), spelledOf(levelRelations, "typed"), "lawValues"],
	holdingAny: [levelStatements.param]
}

/** Every case: the box, and the kept case beside it. */
const untypedCases: ReadonlyArray<UntypedCase> = [...boxCases, keptCase]

/** The parameter a case's call is refused at: the first argument that holds a member typed `any`, none if none does. */
const untypedRefusalAt = (c: UntypedCase): Option.Option<number> =>
	Arr.head(Arr.sort(c.holdingAny, Order.Number))

const memberRefusal: Refused =
	"a member typed any, which every check admits: type each member of the list or record"

/** What a schema's admitted call keeps: each family's members nested at their owner's count field. */
const keptOf = (builder: BuilderName, value: string): ReadonlyArray<string> => {
	switch (builder) {
		case "schema":
			return [`InsertAllRowsOf<typeof ${value}>["Parent"][number]["kids"]`]
		case "schema.extend":
			return [
				`InsertAllRowsOf<typeof ${value}>["Parent"][number]["kids"]`,
				`InsertAllRowsOf<typeof ${value}>["Bag"][number]["items"]`
			]
		case "role":
		case "login":
		case "workload":
			return []
	}
}

const caseBlock = (c: UntypedCase, index: number): string => {
	const value = `c${index}`
	const at = untypedRefusalAt(c)
	const lines = Arr.map(c.params(`n${index}`), (param, p) =>
		Option.contains(at, p)
			? `\t// @ts-expect-error -- refusal: ${memberRefusal}\n\t${param}`
			: `\t${param}`
	)
	const kept = Option.isNone(at)
		? Arr.map(keptOf(c.builder, value), (type, k) => `export type Kept${index}_${k} = ${type}\n`)
		: []
	return `// ${c.builder}, ${c.said}
export const ${value} = ${shapes[c.builder].callee}(
${Arr.join(lines, ",\n")}
)
${Arr.join(kept, "")}`
}

/** The program's prelude (test/support/programs/untyped.ts). */
const prelude = await Effect.runPromise(preludeAt("test/support/programs/untyped.ts"))

/** The program's prelude as its directory reaches it, `entry` spelling a repository path from there. */
export const untypedEntriesFrom = (entry: (path: string) => string): PreludeAt =>
	preludeFrom(prelude, entry)

/** The program over every case, its imports read through its prelude as `entries` reaches it. */
export const untypedSource = (entries: PreludeAt): string =>
	preludeProgram(
		`// Generated by test/types/api/untyped.ts over ${untypedCases.length} cases.`,
		entries,
		`export const Parent = relation("Parent", { id: uuid, kids: drawn(natural) }, ["id"])
export const Kid = relation("Kid", { parent: uuid, at: drawn(natural), label: pg.integer }, ["parent", "at"])
export const nesting = ordered(on(Kid, "parent", "at"), fin(Parent, "kids"))
export const Root = schema("Root", [Parent, Kid], [nesting])
export const Bag = relation("Bag", { id: uuid, items: drawn(natural) }, ["id"])
export const Item = relation("Item", { bag: uuid, at: drawn(natural), label: pg.integer }, ["bag", "at"])
export const bagging = ordered(on(Item, "bag", "at"), fin(Bag, "items"))
export const Labels = derived.materialized(
	"Labels",
	query(Root).rule((r) => {
		const { parent, label } = v(Kid, "kid")
		return r.match(Kid, { parent, label }).find({ parent, label })
	})
)
export const Up = schema.extend(Root, "Up", [Labels], [])
export const member = role(Root, "member", { Parent })
export const ids = query(Root).rule((r) => {
	const { id } = v(Parent, "parent")
	return r.match(Parent, { id }).find({ id })
})
export const names = workload(Root, { ids })
declare const ${untyped}: any
const lawGroups = [{ nesting: [nesting] }, { mutable: [mutable(Parent)], bagging: [bagging] }] as const
export const lawValues = lawGroups.flatMap((group) => Object.values(group).flat())

${Arr.join(Arr.map(untypedCases, caseBlock), "\n")}`
	)
