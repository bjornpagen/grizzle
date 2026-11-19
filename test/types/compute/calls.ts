import { Array as Arr, Effect, String as Str } from "effect"
import { defined } from "#test/support/assert.ts"
import { preludeAt, preludeFrom, preludeModule } from "#test/support/prelude.ts"
import { batchOwned, caseOwned, type Entry, type Program } from "#test/types/batch/batch.ts"

/**
 * The declared-call program: the box of what a call of a declared function passes at an argument of a closed id, a
 * value argument of Kind's ids and a rows argument whose heading holds one, each argument form once, exhausted and
 * printed as one program the type batch checks.
 *
 * The oracle is the rule every term meets by: a closed id stands only where a value of its own roster does, as a term
 * of its roster's ids or as a name a handle of the roster has, so an argument of Kind's ids takes Kind's and no other
 * roster's, and a rows argument takes a query whose facts hold Kind's ids at the field.
 */

/** What an argument of Kind's ids is passed: a term, a handle, a name, a code, or rows of a query. */
const forms = [
	"a variable of its roster",
	"a variable of another roster",
	"a handle of its roster",
	"a handle of another roster",
	"a name of its roster's handles",
	"a name no handle of its roster has",
	"an integer code",
	"rows of its roster's ids",
	"rows of another roster's ids"
] as const

type Form = (typeof forms)[number]

/** Whether the types admit the form: a value of Kind's own ids alone. */
const admitted: { readonly [F in Form]: boolean } = {
	"a variable of its roster": true,
	"a variable of another roster": false,
	"a handle of its roster": true,
	"a handle of another roster": false,
	"a name of its roster's handles": true,
	"a name no handle of its roster has": false,
	"an integer code": false,
	"rows of its roster's ids": true,
	"rows of another roster's ids": false
}

/** The cells of callsBox, minted as a dictionary in its door (test/types/compute/calls.dictionary.ts). */
export const callsBoxItems: Arr.NonEmptyReadonlyArray<Form> = [
	defined(forms[0], "a form of the calls box"),
	...Arr.drop(forms, 1)
]

/** A value argument's cell: the call of `kindOf` at the form, in a query over Thing. */
const valueCell = (argument: string, index: number): string =>
	`export const c${index} = query(Root).rule((r) => r.match(Thing, { kind, other }).find({ called: Compute.call(kindOf, { k: ${argument} }) }))`

/** A rows argument's cell: the rows of `kindsOf` at a query of Thing's `field`. */
const rowsCell = (field: "kind" | "other", index: number): string =>
	`export const c${index} = Compute.rowsOf(kindsOf, { ks: ${field === "kind" ? "kinds" : "others"} })`

const statementOf = (form: Form, index: number): string => {
	switch (form) {
		case "a variable of its roster":
			return valueCell("kind", index)
		case "a variable of another roster":
			return valueCell("other", index)
		case "a handle of its roster":
			return valueCell('Kind.handle("a")', index)
		case "a handle of another roster":
			return valueCell('Other.handle("x")', index)
		case "a name of its roster's handles":
			return valueCell('"b"', index)
		case "a name no handle of its roster has":
			return valueCell('"x"', index)
		case "an integer code":
			return valueCell("1", index)
		case "rows of its roster's ids":
			return rowsCell("kind", index)
		case "rows of another roster's ids":
			return rowsCell("other", index)
	}
}

const caseBlock = (form: Form, index: number): ReadonlyArray<string> => [
	`// ${form}`,
	...(admitted[form]
		? []
		: [
				`// @ts-expect-error -- refused: an argument of Kind's ids takes ${form} of no other roster`
			]),
	...Str.split(statementOf(form, index), "\n"),
	""
]

/** The program's prelude (test/support/programs/calls.ts). */
const prelude = await Effect.runPromise(preludeAt("test/support/programs/calls.ts"))

/** Kind and Other, two rosters; Thing, of an id of each; kindOf of a Kind, kindsOf of rows of one; and their schema. */
const callsHeader = `export const Kind = closed.ordered("Kind", ["a", "b"])
export const Other = closed.ordered("Other", ["x", "y"])
export const Thing = relation("Thing", { id: Id, kind: closedId(Kind), other: closedId(Other) }, ["id"])
export const kindOf = fn("kindOf", { calls: [], args: { k: closedId(Kind) }, returns: closedId(Kind), volatility: "immutable", language: "sql", body: "SELECT k" })
const Kinds = rows({ k: closedId(Kind) })
export const kindsOf = fn("kindsOf", { calls: [], args: { ks: Kinds }, returns: Kinds, volatility: "immutable", language: "sql", body: "SELECT * FROM unnest(ks)" })
export const Root = schema("Root", [Kind, Other, Thing, kindOf, kindsOf], [])
const { kind, other } = v(Thing, "thing")
export const kinds = query(Root).rule((r) => r.match(Thing, { kind }).find({ k: kind }))
export const others = query(Root).rule((r) => r.match(Thing, { other }).find({ k: other }))
`

/** The program over a batch's cells, its imports read through its prelude as `entry` reaches it. */
export const callsProgram = (cells: Arr.NonEmptyReadonlyArray<Form>, entry: Entry): Program => [
	preludeModule(
		"index.ts",
		"// Generated by test/types/compute/calls.ts: each argument form a call of a declared function passes a closed id by.",
		preludeFrom(prelude, entry),
		[
			{ owner: batchOwned, lines: Str.split(callsHeader, "\n") },
			...Arr.map(cells, (c, at) => ({ owner: caseOwned(at), lines: caseBlock(c, at) }))
		]
	)
]
