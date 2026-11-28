import { nonEmpty } from "@bjornpagen/testing/assert"
import { Array as Arr, Effect, String as Str } from "effect"
import type { Built } from "#compiler/core/phantom.ts"
import type { Refused } from "#compiler/core/refusals.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import { Fn } from "#compiler/public/compute.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, type Rule, v } from "#compiler/public/query.ts"
import {
	attached,
	Bound,
	f,
	g,
	Item,
	none,
	relational,
	scalar,
	taken,
	union
} from "#test/support/agreement/bound-arguments-schema.ts"
import { compileTemplate, testCompile } from "#test/support/compile.ts"
import { preludeAt, preludeFrom, preludeModule } from "#test/support/prelude.ts"
import { batchOwned, caseOwned, type Entry, type Program } from "#test/support/types/batch/batch.ts"

/**
 * The bound-argument agreement: every form of rows argument a call of a declared function passes, by Fn.rows and by
 * Fn.row, the types admitting exactly the calls the engine compiles. The engine binds an imported query's parameters
 * by its bind map alone (check/checker.ts #resolveParam), never by name from the calling rule's, so a rows argument
 * that is a query of parameters passed unbound is refused, whatever kind of parameter it reads and wherever it reads
 * one, and the types refuse it by RequireBound (types/core/phantom.ts), the rule a match of a query is held to. Where
 * the engine compiles a cell, the query's parameters as its types state them are the ones the engine declares, so a
 * call's parameters are what its bound arguments' bind maps and its value arguments read, and nothing more.
 *
 * Each cell is one query, its call matched in its one rule, written twice: as the program states it, and as the
 * runtime builders build it, where a rows argument passes through `Built`, the type every source's JavaScript view
 * has, so a cell the types refuse is built as a JavaScript caller builds it. Forms and calls are closed rosters read by
 * exhaustive switches, so a new one is a compile error until it has its cells.
 */

/** What a call passes as its rows argument `a`, and as its value argument `x`. */
const forms = [
	"a query of no parameters",
	"a query of a parameter, unbound",
	"a query of a parameter, unbound, its caller reading a parameter of its name",
	"a query of a parameter, bound to the caller's parameter",
	"a query of a parameter, bound to the caller's variable",
	"a query of a parameter, bound to a constant",
	"a query of a relation parameter, unbound",
	"a query of a relation parameter, bound to the caller's",
	"a union whose second arm reads a parameter, unbound",
	"a union whose second arm reads a parameter, bound",
	"a take of a parameter's count, unbound",
	"a take of a parameter's count, bound",
	"an attachment whose child reads a parameter, unbound",
	"an attachment whose child reads a parameter, bound",
	"a query of no parameters, the value argument the caller's parameter"
] as const

type Form = (typeof forms)[number]

/** The call a cell matches: the rows of f, or the rows of the field `out` of g's one row. */
const calls = ["Fn.rows", "Fn.row"] as const

type Call = (typeof calls)[number]

/** One cell of the box: a form of argument, passed by a call. */
export interface BoundCell {
	readonly form: Form
	readonly call: Call
}

/** The cells of boundBox, minted as a dictionary in its door (test/types/compute/bound-arguments.dictionary.ts). */
export const boundBoxItems: Arr.NonEmptyReadonlyArray<BoundCell> = nonEmpty(
	Arr.flatMap(forms, (form) => Arr.map(calls, (call): BoundCell => ({ form, call }))),
	"every form passed by every call"
)

/**
 * What a cell's rule reads beside its call: nothing; the item it matches, whose variable `s` its argument is bound to;
 * or a parameter `s` of its own, which its head finds.
 */
type Caller = "call alone" | "an item" | "a parameter"

const callerOf = (form: Form): Caller => {
	switch (form) {
		case "a query of a parameter, bound to the caller's variable":
			return "an item"
		case "a query of a parameter, unbound, its caller reading a parameter of its name":
			return "a parameter"
		case "a query of no parameters":
		case "a query of a parameter, unbound":
		case "a query of a parameter, bound to the caller's parameter":
		case "a query of a parameter, bound to a constant":
		case "a query of a relation parameter, unbound":
		case "a query of a relation parameter, bound to the caller's":
		case "a union whose second arm reads a parameter, unbound":
		case "a union whose second arm reads a parameter, bound":
		case "a take of a parameter's count, unbound":
		case "a take of a parameter's count, bound":
		case "an attachment whose child reads a parameter, unbound":
		case "an attachment whose child reads a parameter, bound":
		case "a query of no parameters, the value argument the caller's parameter":
			return "call alone"
	}
}

/** Whether a form's value argument is the caller's parameter `x`, or the constant 1n. */
const readsX = (form: Form): boolean =>
	form === "a query of no parameters, the value argument the caller's parameter"

/** Item's variables in the scope a cell's rule matches it in, minted inside that rule, as v is. */
const itemOf = () => v(Item, "item")
type ItemVars = ReturnType<typeof itemOf>

/** A form's rows argument, as the program writes it, in a rule whose variable `s` is Item's. */
const argumentText = (form: Form): string => {
	switch (form) {
		case "a query of no parameters":
		case "a query of no parameters, the value argument the caller's parameter":
			return "none"
		case "a query of a parameter, unbound":
		case "a query of a parameter, unbound, its caller reading a parameter of its name":
			return "scalar"
		case "a query of a parameter, bound to the caller's parameter":
			return 'scalar.bind({ s: r.param("s", pg.integer) })'
		case "a query of a parameter, bound to the caller's variable":
			return "scalar.bind({ s })"
		case "a query of a parameter, bound to a constant":
			return "scalar.bind({ s: 1 })"
		case "a query of a relation parameter, unbound":
			return "relational"
		case "a query of a relation parameter, bound to the caller's":
			return 'relational.bind({ rel: r.relation("rel", { k: pg.bigint }) })'
		case "a union whose second arm reads a parameter, unbound":
			return "union"
		case "a union whose second arm reads a parameter, bound":
			return "union.bind({ s: 1 })"
		case "a take of a parameter's count, unbound":
			return "taken"
		case "a take of a parameter's count, bound":
			return "taken.bind({ n: 3 })"
		case "an attachment whose child reads a parameter, unbound":
			return "attached"
		case "an attachment whose child reads a parameter, bound":
			return "attached.bind({ m: 1 })"
	}
}

/** A form's rows argument, as the runtime builders build it in a rule `r` of Item's variables `item` (argumentText). */
const argumentBuilt = (form: Form, r: Rule<typeof Bound>, item: ItemVars): Built => {
	switch (form) {
		case "a query of no parameters":
		case "a query of no parameters, the value argument the caller's parameter":
			return none
		case "a query of a parameter, unbound":
		case "a query of a parameter, unbound, its caller reading a parameter of its name":
			return scalar
		case "a query of a parameter, bound to the caller's parameter":
			return scalar.bind({ s: r.param("s", pg.integer) })
		case "a query of a parameter, bound to the caller's variable":
			return scalar.bind({ s: item.s })
		case "a query of a parameter, bound to a constant":
			return scalar.bind({ s: 1 })
		case "a query of a relation parameter, unbound":
			return relational
		case "a query of a relation parameter, bound to the caller's":
			return relational.bind({ rel: r.relation("rel", { k: pg.bigint }) })
		case "a union whose second arm reads a parameter, unbound":
			return union
		case "a union whose second arm reads a parameter, bound":
			return union.bind({ s: 1 })
		case "a take of a parameter's count, unbound":
			return taken
		case "a take of a parameter's count, bound":
			return taken.bind({ n: 3 })
		case "an attachment whose child reads a parameter, unbound":
			return attached
		case "an attachment whose child reads a parameter, bound":
			return attached.bind({ m: 1 })
	}
}

/** A cell's call, as the program writes it: its rows a source. */
const callText = (cell: BoundCell): string => {
	const args = `{ a: ${argumentText(cell.form)}, x: ${readsX(cell.form) ? 'r.param("x", pg.bigint)' : "1n"} }`
	switch (cell.call) {
		case "Fn.rows":
			return `Fn.rows(f, ${args})`
		case "Fn.row":
			return `Fn.row(g, ${args}).out`
	}
}

/** A cell's query, as the program writes it: its call matched in its one rule, beside what its caller reads. */
const cellText = (cell: BoundCell): string => {
	const run = `const run = ${callText(cell)}; const { k } = v(run, "run");`
	switch (callerOf(cell.form)) {
		case "call alone":
			return `query(Bound).rule((r) => { ${run} return r.match(run, { k }).find({ k }) })`
		case "an item":
			return `query(Bound).rule((r) => { const { s } = v(Item, "item"); ${run} return r.match(Item, { s }).match(run, { k }).find({ s, k }) })`
		case "a parameter":
			return `query(Bound).rule((r) => { ${run} return r.match(run, { k }).find({ s: r.param("s", pg.integer), k }) })`
	}
}

/** A cell's call, as the runtime builders build it in a rule `r` of Item's variables `item` (callText). */
const callBuilt = (cell: BoundCell, r: Rule<typeof Bound>, item: ItemVars) => {
	const a = argumentBuilt(cell.form, r, item)
	const x = readsX(cell.form) ? r.param("x", pg.bigint) : 1n
	switch (cell.call) {
		case "Fn.rows":
			return Fn.rows(f, { a, x })
		case "Fn.row":
			return Fn.row(g, { a, x }).out
	}
}

/** A cell's query, as the runtime builders build it (cellText). */
const cellBuilt = (cell: BoundCell): unknown => {
	switch (callerOf(cell.form)) {
		case "call alone":
			return query(Bound).rule((r) => {
				const run = callBuilt(cell, r, itemOf())
				const { k } = v(run, "run")
				return r.match(run, { k }).find({ k })
			})
		case "an item":
			return query(Bound).rule((r) => {
				const item = itemOf()
				const run = callBuilt(cell, r, item)
				const { k } = v(run, "run")
				return r.match(Item, { s: item.s }).match(run, { k }).find({ s: item.s, k })
			})
		case "a parameter":
			return query(Bound).rule((r) => {
				const run = callBuilt(cell, r, itemOf())
				const { k } = v(run, "run")
				return r.match(run, { k }).find({ s: r.param("s", pg.integer), k })
			})
	}
}

/** The refusal the types name where the engine refuses a cell: its rows argument's parameters unbound. */
const unbound: Refused =
	"bind the query's parameters before matching it or passing it as rows: Q.bind({ ... })"

/** How the engine refuses an imported query whose bind map leaves a parameter unbound (check/checker.ts #resolveParam). */
const unboundReason = ": an imported query's parameters are bound completely with bind"

/** The engine's verdict on a cell: the parameters its compiled query declares, or its refusal of the argument. */
type Verdict =
	| { readonly kind: "admitted"; readonly params: ReadonlyArray<string> }
	| { readonly kind: "refused" }

/**
 * The engine's verdict on a cell's query: admitted with the parameters it declares, or refused for an unbound
 * parameter of its rows argument. A refusal for any other reason is the box's defect, which fails the run.
 */
const verdictOf = (cell: BoundCell): Verdict => {
	const template = compileTemplate(cellBuilt(cell), undefined, testCompile)
	if (template.ok) {
		return {
			kind: "admitted",
			params: Arr.map(template.value.params, (p) => p.name)
		}
	}
	const reason = template.error.reason
	if (reason._tag === "MalformedDescription" && Str.endsWith(unboundReason)(reason.what)) {
		return { kind: "refused" }
	}
	throw new Error(
		`the engine refuses ${cell.call} of ${cell.form} for another reason: ${template.error.message}`
	)
}

/** A union of the names the engine declares, as a type: never for none. */
const namesType = (params: ReadonlyArray<string>): string =>
	Arr.match(params, {
		onEmpty: () => "never",
		onNonEmpty: (names) =>
			Arr.join(
				Arr.map(names, (n) => jsonText(n)),
				" | "
			)
	})

/**
 * A cell's lines: its query, under the refusal's directive where the engine refuses it, and where it admits it, the
 * query's parameters held to the ones the engine declares.
 */
const cellLines = (cell: BoundCell, i: number): ReadonlyArray<string> => {
	const verdict = verdictOf(cell)
	const statement = `export const c${i} = ${cellText(cell)}`
	switch (verdict.kind) {
		case "refused":
			return [
				`/** ${cell.call} of ${cell.form}: the engine refuses it. */`,
				`// @ts-expect-error -- refusal: ${unbound}`,
				statement,
				""
			]
		case "admitted":
			return [
				`/** ${cell.call} of ${cell.form}: the engine compiles it. */`,
				statement,
				`export type p${i} = Expect<Equals<keyof ParamsOf<typeof c${i}>, ${namesType(verdict.params)}>>`,
				""
			]
	}
}

/** The program's prelude (test/support/programs/bound-arguments.ts). */
const prelude = await Effect.runPromise(preludeAt("test/support/programs/bound-arguments.ts"))

/** The program over a batch's cells, its imports read through its prelude as `entry` reaches it. */
export const boundProgram = (
	cells: Arr.NonEmptyReadonlyArray<BoundCell>,
	entry: Entry
): Program => [
	preludeModule(
		"index.ts",
		"// Generated by test/support/agreement/bound-arguments.ts: each form of rows argument a call passes.",
		preludeFrom(prelude, entry),
		[
			{
				owner: batchOwned,
				lines: [
					"export type Equals<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false",
					"export type Expect<T extends true> = T",
					""
				]
			},
			...Arr.map(cells, (cell, at) => ({ owner: caseOwned(at), lines: cellLines(cell, at) }))
		]
	)
]
