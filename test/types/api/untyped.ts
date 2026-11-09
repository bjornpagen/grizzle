import { Array as Arr, Effect, Option, Record as Rec } from "effect"
import { jsonText } from "#compiler/core/trusted.ts"
import type { TypeRefusal } from "#compiler/types/core/phantom.ts"
import { type PreludeAt, preludeAt, preludeFrom, preludeProgram } from "#test/support/prelude.ts"

/**
 * The untyped-member program: every builder that captures a list or a record as a type (schema, schema.extend, role,
 * login, workload), called once with every member typed and once for each way a list or record it captures holds a
 * member typed `any`, generated over an exhaustive box. A list or record holds one beside its typed members, or, for a
 * statement list, as a library overload types it when it gives up: `Object.values` over a union of law records yields
 * `any[]`, the leak that left a schema's insert types without its families' nestings.
 *
 * The oracle: a call is refused exactly when a list or record it captures holds a member typed `any`, at that
 * argument, by MembersTyped (through UnderOwnNames and StatementsWithin for a schema's). Every call it admits keeps its
 * types: a schema's insert types nest each family's members at their owner's count field.
 */

/** How a list or record a builder captures holds a member typed `any`. */
export type Leak = "member" | "values"

/** A list or record a builder captures: the parameter it is written at, its source typed, and leaked each way it can be. */
interface Captured {
	readonly at: number
	readonly typed: string
	readonly leaked: Arr.NonEmptyReadonlyArray<readonly [Leak, string]>
}

/**
 * A builder of the box over the lists and records it captures, K: its callee, its arguments' sources by parameter, each
 * written with the lists and records it holds as `spelled` spells them, and the types its typed call keeps: a schema's
 * nesting of each family's members at their owner's count field, which a statement list typed `any[]` loses. A typed
 * role, login or workload keeps its types where its call typechecks.
 */
interface Builder<K extends string> {
	readonly callee: string
	readonly captured: { readonly [A in K]: Captured }
	readonly params: (name: string, spelled: { readonly [A in K]: string }) => ReadonlyArray<string>
	readonly kept: (value: string) => ReadonlyArray<string>
}

const memberRefusal: TypeRefusal =
	"a member typed any, which every check admits: type each member of the list or record"

/** One case: its builder, the list or record it leaks and how, its call's parameters, and its refusal or what it keeps. */
export interface UntypedCase {
	readonly builder: string
	readonly leak: Option.Option<readonly [argument: string, leak: Leak]>
	readonly callee: string
	readonly params: (name: string) => ReadonlyArray<string>
	readonly verdict:
		| { readonly kind: "refused"; readonly at: number }
		| { readonly kind: "admitted"; readonly kept: (value: string) => ReadonlyArray<string> }
}

/** A builder's cases: its call with every member typed, and with each list or record leaked each way it can be. */
const casesOf = <K extends string>(
	builder: string,
	spec: Builder<K>
): ReadonlyArray<UntypedCase> => {
	const typed = Rec.map(spec.captured, (captured) => captured.typed)
	return [
		{
			builder,
			leak: Option.none(),
			callee: spec.callee,
			params: (name) => spec.params(name, typed),
			verdict: { kind: "admitted", kept: spec.kept }
		},
		...Arr.flatMap(Rec.toEntries(spec.captured), ([argument, captured]) =>
			Arr.map(captured.leaked, ([leak, source]): UntypedCase => ({
				builder,
				leak: Option.some([argument, leak]),
				callee: spec.callee,
				params: (name) => spec.params(name, { ...typed, [argument]: source }),
				verdict: { kind: "refused", at: captured.at }
			}))
		)
	]
}

/** Every case of the box: each builder typed, and each list or record it captures leaked each way it can be. */
export const untypedCases: ReadonlyArray<UntypedCase> = [
	...casesOf("schema", {
		callee: "schema",
		captured: {
			relations: {
				at: 1,
				typed: "{ Parent, Kid }",
				leaked: [["member", "{ Parent, Kid, Other: untyped }"]]
			},
			statements: {
				at: 2,
				typed: "[nesting]",
				leaked: [
					["member", "[nesting, untyped]"],
					["values", "lawValues"]
				]
			}
		},
		params: (name, spelled) => [jsonText(name), spelled.relations, spelled.statements],
		kept: (value) => [`InsertAllRowsOf<typeof ${value}>["Parent"][number]["kids"]`]
	}),
	...casesOf("schema.extend", {
		callee: "schema.extend",
		captured: {
			relations: {
				at: 2,
				typed: "{ Bag, Item }",
				leaked: [["member", "{ Bag, Item, Other: untyped }"]]
			},
			statements: {
				at: 3,
				typed: "[bagging]",
				leaked: [
					["member", "[bagging, untyped]"],
					["values", "lawValues"]
				]
			}
		},
		params: (name, spelled) => ["Root", jsonText(name), spelled.relations, spelled.statements],
		kept: (value) => [
			`InsertAllRowsOf<typeof ${value}>["Parent"][number]["kids"]`,
			`InsertAllRowsOf<typeof ${value}>["Bag"][number]["items"]`
		]
	}),
	...casesOf("role", {
		callee: "role",
		captured: {
			relations: {
				at: 2,
				typed: "{ Parent, Labels }",
				leaked: [["member", "{ Parent, Labels, Other: untyped }"]]
			},
			write: { at: 3, typed: '["Parent"]', leaked: [["member", '["Parent", untyped]']] },
			refresh: { at: 3, typed: '["Labels"]', leaked: [["member", '["Labels", untyped]']] }
		},
		params: (name, spelled) => [
			"Up",
			jsonText(name),
			spelled.relations,
			`{ write: ${spelled.write}, refresh: ${spelled.refresh} }`
		],
		kept: () => []
	}),
	...casesOf("login", {
		callee: "login",
		captured: {
			roles: { at: 2, typed: "[member]", leaked: [["member", "[member, untyped]"]] },
			workloads: { at: 3, typed: "[names]", leaked: [["member", "[names, untyped]"]] }
		},
		params: (name, spelled) => [
			"Root",
			jsonText(name),
			spelled.roles,
			`{ workload: ${spelled.workloads} }`
		],
		kept: () => []
	}),
	...casesOf("workload", {
		callee: "workload",
		captured: {
			programs: { at: 1, typed: "{ ids }", leaked: [["member", "{ ids, other: untyped }"]] }
		},
		params: (_name, spelled) => ["Root", spelled.programs],
		kept: () => []
	})
]

/** Whether a case's call is refused: a list or record it captures holds a member typed `any`. */
export const untypedRefused = (c: UntypedCase): boolean => c.verdict.kind === "refused"

const leakText = (leak: Leak): string => {
	switch (leak) {
		case "member":
			return "beside its typed members"
		case "values":
			return "by Object.values over a union of law records"
	}
}

const caseBlock = (c: UntypedCase, index: number): string => {
	const value = `c${index}`
	const lines = Arr.map(c.params(`n${index}`), (param, at) =>
		c.verdict.kind === "refused" && c.verdict.at === at
			? `\t// @ts-expect-error -- TS2345 refusal: ${memberRefusal}\n\t${param}`
			: `\t${param}`
	)
	const kept =
		c.verdict.kind === "admitted"
			? Arr.map(c.verdict.kept(value), (type, k) => `export type Kept${index}_${k} = ${type}\n`)
			: []
	const said = Option.match(c.leak, {
		onNone: () => "every member typed",
		onSome: ([argument, leak]) => `${argument} holding a member typed any ${leakText(leak)}`
	})
	return `// ${c.builder}, ${said}
export const ${value} = ${c.callee}(
${Arr.join(lines, ",\n")}
)
${Arr.join(kept, "")}`
}

/** The program's prelude (test/support/programs/untyped.ts). */
const prelude = await Effect.runPromise(preludeAt("test/support/programs/untyped.ts"))

/** The program's prelude as its directory reaches it, `entry` spelling a repository path from there. */
export const untypedEntriesFrom = (entry: (path: string) => string): PreludeAt =>
	preludeFrom(prelude, entry)

/** The program over the box, its imports read through its prelude as `entries` reaches it. */
export const untypedSource = (entries: PreludeAt): string =>
	preludeProgram(
		`// Generated by test/types/api/untyped.ts over ${untypedCases.length} cases.`,
		entries,
		`export const Parent = relation("Parent", { id: uuid, kids: drawn(natural) }, ["id"])
export const Kid = relation("Kid", { parent: uuid, at: drawn(natural), label: pg.integer }, ["parent", "at"])
export const nesting = ordered(on(Kid, "parent", "at"), fin(Parent, "kids"))
export const Root = schema("Root", { Parent, Kid }, [nesting])
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
export const Up = schema.extend(Root, "Up", { Labels }, [])
export const member = role(Root, "member", { Parent })
export const ids = query(Root).rule((r) => {
	const { id } = v(Parent, "parent")
	return r.match(Parent, { id }).find({ id })
})
export const names = workload(Root, { ids })
declare const untyped: any
const lawGroups = [{ nesting: [nesting] }, { mutable: [mutable(Parent)], bagging: [bagging] }] as const
export const lawValues = lawGroups.flatMap((group) => Object.values(group).flat())

${Arr.join(Arr.map(untypedCases, caseBlock), "\n")}`
	)
