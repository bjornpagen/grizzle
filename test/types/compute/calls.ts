import { defined } from "@bjornpagen/testing/assert"
import { Array as Arr, Effect, String as Str } from "effect"
import { preludeAt, preludeFrom, preludeModule } from "#test/support/prelude.ts"
import { batchOwned, caseOwned, type Entry, type Program } from "#test/support/types/batch/batch.ts"

/**
 * The declared-call program: the box of what a call of a declared function passes at an argument of a closed id, a
 * value argument of Kind's ids and a rows argument whose heading holds one, each argument form once, and the functions
 * a query calls none of, one that returns one row, one whose rows hold rows and one that takes one row, and the fields
 * of a function's one row a query reads, of rows of values alone and of an immutable or stable function, each typed by
 * its heading; and a function's declaration by its null input, strict, called, unstated or of another spelling, read
 * back as the null input its type carries, and a strict function's value as a term; exhausted and printed as one
 * program the type batch checks.
 *
 * The oracle is the rule every term meets by: a closed id stands only where a value of its own roster does, as a term
 * of its roster's ids or as a name a handle of the roster has, so an argument of Kind's ids takes Kind's and no other
 * roster's, and a rows argument takes a query whose facts hold Kind's ids at the field; and the rule of what a query
 * calls: a function of values and rows of values alone, since a query's sources and terms hold fields and no field
 * holds a composite or an array of them; and the rule of a declaration: it states its null input, `called` or
 * `strict`, neither a default (schema/function.ts fn), which its type carries as it states it, and a strict function's
 * value is a term of its result's type as a called one's is.
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
	"rows of another roster's ids",
	"rows of a function of one row",
	"rows of a function whose rows hold rows",
	"a value of a function taking one row",
	"a field of one row's of its roster's ids",
	"a field of one row's read where another roster's id is taken",
	"a field of one row of a value",
	"a field of one row of one row",
	"a field of one row of rows that hold rows",
	"the fields of a volatile function's one row",
	"the fields of a function of rows",
	"a strict function's value, a term of its result",
	"a declaration stating it strict",
	"a declaration stating it called",
	"a declaration stating no null input",
	"a declaration stating another null input"
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
	"rows of another roster's ids": false,
	"rows of a function of one row": false,
	"rows of a function whose rows hold rows": false,
	"a value of a function taking one row": false,
	"a field of one row's of its roster's ids": true,
	"a field of one row's read where another roster's id is taken": false,
	"a field of one row of a value": false,
	"a field of one row of one row": false,
	"a field of one row of rows that hold rows": false,
	"the fields of a volatile function's one row": false,
	"the fields of a function of rows": false,
	"a strict function's value, a term of its result": true,
	"a declaration stating it strict": true,
	"a declaration stating it called": true,
	"a declaration stating no null input": false,
	"a declaration stating another null input": false
}

/** The cells of callsBox, minted as a dictionary in its door (test/types/compute/calls.dictionary.ts). */
export const callsBoxItems: Arr.NonEmptyReadonlyArray<Form> = [
	defined(forms[0], "a form of the calls box"),
	...Arr.drop(forms, 1)
]

/** A value argument's cell: the call of `kindOf` at the form, in a query over Thing. */
const valueCell = (argument: string, index: number): string =>
	`export const c${index} = query(Root).rule((r) => r.match(Thing, { kind, other }).find({ called: Fn.call(kindOf, { k: ${argument} }) }))`

/**
 * A field read's cell: the rows of field `ks` of kindRow's one row, its variable `k` passed to `call`, kindOf of Kind's
 * ids or otherOf of Other's, in a query that matches them.
 */
const fieldCell = (call: "kindOf" | "otherOf", index: number): string =>
	`export const c${index} = query(Root).rule((r) => { const read = Fn.row(kindRow, {}).ks; const { k } = v(read, "read"); return r.match(read, { k }).find({ called: Fn.call(${call}, { ${call === "kindOf" ? "k" : "o"}: k }) }) })`

/**
 * A declaration's cell: a function of a Kind declared with the null input `stated`, none where it is undefined, read
 * back as the null input its type carries, which the cell holds to `expected`, the literal it states.
 */
const declarationCell = (stated: string | undefined, expected: string, index: number): string =>
	`export const c${index}: ${expected} = fn("declared${index}", { calls: [], args: { k: closedId(Kind) }, returns: closedId(Kind), volatility: "immutable", ${stated === undefined ? "" : `nullInput: ${stated}, `}language: "sql", body: fn.body\`SELECT k\` }).nullInput`

/** A rows argument's cell: the rows of `kindsOf` at a query of Thing's `field`. */
const rowsCell = (field: "kind" | "other", index: number): string =>
	`export const c${index} = Fn.rows(kindsOf, { ks: ${field === "kind" ? "kinds" : "others"} })`

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
		case "rows of a function of one row":
			return `export const c${index} = Fn.rows(oneKind, {})`
		case "rows of a function whose rows hold rows":
			return `export const c${index} = Fn.rows(kindLists, {})`
		case "a value of a function taking one row":
			return `export const c${index} = query(Root).rule((r) => r.match(Thing, { kind, other }).find({ called: Fn.call(kindIn, { s: kind }) }))`
		case "a field of one row's of its roster's ids":
			return fieldCell("kindOf", index)
		case "a field of one row's read where another roster's id is taken":
			return fieldCell("otherOf", index)
		case "a field of one row of a value":
			return `export const c${index} = Fn.row(kindRow, {}).k`
		case "a field of one row of one row":
			return `export const c${index} = Fn.row(kindRow, {}).one`
		case "a field of one row of rows that hold rows":
			return `export const c${index} = Fn.row(kindRow, {}).lists`
		case "the fields of a volatile function's one row":
			return `export const c${index} = Fn.row(kindRowVolatile, {})`
		case "the fields of a function of rows":
			return `export const c${index} = Fn.row(kindsOf, { ks: kinds })`
		case "a strict function's value, a term of its result":
			return `export const c${index} = query(Root).rule((r) => r.match(Thing, { kind, other }).find({ called: Fn.call(strictKindOf, { k: kind }) }))`
		case "a declaration stating it strict":
			return declarationCell('"strict"', '"strict"', index)
		case "a declaration stating it called":
			return declarationCell('"called"', '"called"', index)
		case "a declaration stating no null input":
			return declarationCell(undefined, '"called"', index)
		case "a declaration stating another null input":
			return declarationCell('"returnsNull"', '"called"', index)
	}
}

/** Why the types refuse a form: another roster's value, a function a query calls none of, whose signature holds one
 * row or rows that hold rows, which only another function's body passes or reads, or a field of one row a query reads
 * none of. */
const refusedBecause = (form: Form): string => {
	switch (form) {
		case "rows of a function of one row":
		case "rows of a function whose rows hold rows":
		case "a value of a function taking one row":
			return "a query calls a function of values and rows of values alone"
		case "a field of one row of a value":
		case "a field of one row of one row":
		case "a field of one row of rows that hold rows":
			return "a query reads the fields of one row that hold rows of values alone"
		case "the fields of a volatile function's one row":
		case "the fields of a function of rows":
			return "a query reads the fields of an immutable or stable function's one row alone"
		case "a field of one row's read where another roster's id is taken":
			return "a field's rows are of their heading's types, Kind's ids no other roster's"
		case "a declaration stating no null input":
		case "a declaration stating another null input":
			return "a declaration states its null input, called or strict, neither a default"
		case "a strict function's value, a term of its result":
		case "a declaration stating it strict":
		case "a declaration stating it called":
			return "a declaration states its null input, and its type carries it"
		case "a variable of its roster":
		case "a variable of another roster":
		case "a handle of its roster":
		case "a handle of another roster":
		case "a name of its roster's handles":
		case "a name no handle of its roster has":
		case "an integer code":
		case "rows of its roster's ids":
		case "rows of another roster's ids":
		case "a field of one row's of its roster's ids":
			return `an argument of Kind's ids takes ${form} of no other roster`
	}
}

const caseBlock = (form: Form, index: number): ReadonlyArray<string> => [
	`// ${form}`,
	...(admitted[form] ? [] : [`// @ts-expect-error -- refused: ${refusedBecause(form)}`]),
	...Str.split(statementOf(form, index), "\n"),
	""
]

/** The program's prelude (test/support/programs/calls.ts). */
const prelude = await Effect.runPromise(preludeAt("test/support/programs/calls.ts"))

/** Kind and Other, two rosters; Thing, of an id of each; kindOf of a Kind, kindsOf of rows of one; oneKind of one row
 * of one, kindLists of rows that hold rows of one, kindIn taking one row of one; otherOf of an Other; kindRow of one row
 * whose fields hold rows of Kinds, a Kind, one row of Kinds and rows that hold rows, and kindRowVolatile, the same
 * volatile; and their schema. */
const callsHeader = `export const Kind = closed.ordered("Kind", ["a", "b"])
export const Other = closed.ordered("Other", ["x", "y"])
export const Thing = relation("Thing", { id: Id, kind: closedId(Kind), other: closedId(Other) }, ["id"])
export const kindOf = fn("kindOf", { calls: [], args: { k: closedId(Kind) }, returns: closedId(Kind), volatility: "immutable", nullInput: "called", language: "sql", body: fn.body\`SELECT k\` })
const Kinds = rows({ k: closedId(Kind) })
export const kindsOf = fn("kindsOf", { calls: [], args: { ks: Kinds }, returns: Kinds, volatility: "immutable", nullInput: "called", language: "sql", body: fn.body\`SELECT * FROM unnest(ks)\` })
export const oneKind = fn("oneKind", { calls: [], args: {}, returns: row(Kinds), volatility: "immutable", nullInput: "called", language: "sql", body: fn.body\`SELECT ROW(1)::\${Kinds}\` })
const KindLists = rows({ ks: Kinds })
export const kindLists = fn("kindLists", { calls: [], args: {}, returns: KindLists, volatility: "immutable", nullInput: "called", language: "sql", body: fn.body\`SELECT ARRAY[ROW(1)::\${Kinds}]\` })
export const kindIn = fn("kindIn", { calls: [], args: { s: row(Kinds) }, returns: closedId(Kind), volatility: "immutable", nullInput: "called", language: "sql", body: fn.body\`SELECT (s).k\` })
export const strictKindOf = fn("strictKindOf", { calls: [], args: { k: closedId(Kind) }, returns: closedId(Kind), volatility: "immutable", nullInput: "strict", language: "sql", body: fn.body\`SELECT k\` })
export const otherOf = fn("otherOf", { calls: [], args: { o: closedId(Other) }, returns: closedId(Other), volatility: "immutable", nullInput: "called", language: "sql", body: fn.body\`SELECT o\` })
const KindOut = rows({ ks: Kinds, k: closedId(Kind), one: row(Kinds), lists: KindLists })
export const kindRow = fn("kindRow", { calls: [], args: {}, returns: row(KindOut), volatility: "immutable", nullInput: "called", language: "sql", body: fn.body\`SELECT NULL::\${KindOut}\` })
export const kindRowVolatile = fn("kindRowVolatile", { calls: [], args: {}, returns: row(KindOut), volatility: "volatile", nullInput: "called", language: "sql", body: fn.body\`SELECT NULL::\${KindOut}\` })
export const Root = schema("Root", [Kind, Other, Thing, kindOf, strictKindOf, kindsOf, oneKind, kindLists, kindIn, otherOf, kindRow, kindRowVolatile], [])
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
