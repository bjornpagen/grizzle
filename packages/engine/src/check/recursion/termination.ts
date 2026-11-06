import type { CheckServices } from "#compiler/check/context.ts"
import { failRecursion, unwrap } from "#compiler/check/fail.ts"
import type {
	ResolvedExpr,
	ResolvedHead,
	ResolvedMatch,
	ResolvedRecursive,
	ResolvedRule
} from "#compiler/check/params.ts"
import type { Arm, RecArm } from "#compiler/check/recursion/scan.ts"
import type { StateType } from "#compiler/check/recursion/state.ts"
import { entries } from "#compiler/check/scan.ts"
import { encode, everyProperty } from "#compiler/core/canonical.ts"
import { childLoc, type SourceLoc } from "#compiler/core/loc.ts"
import { compareStrings } from "#compiler/core/order.ts"
import { integerRanges } from "#compiler/ir/carriers.ts"
import type { LiteralDesc } from "#compiler/ir/desc.ts"
import type { RelNode, TerminationCert } from "#compiler/ir/rel.ts"
import { baseOf, contractOf, type ScalarType, typeLabel } from "#compiler/ir/scalar.ts"

/** The range of the integer carrier a counter may live in; undefined for every other carrier. */
const rangeOf = (t: ScalarType): readonly [bigint, bigint] | undefined => {
	const c = baseOf(t).carrier
	return c === "int2" || c === "int4" || c === "int8" ? integerRanges[c] : undefined
}

type Value =
	| { readonly kind: "literal"; readonly key: string; readonly int: bigint | undefined }
	| { readonly kind: "data" }
	| { readonly kind: "copy"; readonly from: ReadonlyArray<string> }
	| { readonly kind: "computed"; readonly reads: ReadonlyArray<string> }
	| {
			readonly kind: "counter"
			readonly delta: bigint
			readonly limit: bigint
			/** The integer range of the counter's column's carrier. */
			readonly range: readonly [bigint, bigint]
	  }

interface Form {
	readonly value: Value
	readonly loc: SourceLoc
}

/** An integer literal's value, when a description literal is one. */
const integer = (v: LiteralDesc): bigint | undefined => {
	if (typeof v === "bigint") {
		return v
	}
	if (typeof v === "number" && Number.isSafeInteger(v)) {
		return BigInt(v)
	}
	return undefined
}

const literalKey = (v: LiteralDesc): string => {
	const i = integer(v)
	if (i !== undefined) {
		return `int:${i}`
	}
	if (typeof v === "string") {
		return `text:${v}`
	}
	if (typeof v === "boolean") {
		return `bool:${v}`
	}
	if (typeof v === "number") {
		return `num:${v}`
	}
	return `value:${unwrap(encode(v, everyProperty))}`
}

/**
 * What a rule's variables are bound to: the state columns the `self` match binds each to, whether another match binds
 * it to a value fixed for the statement, and the state columns each variable an imported query delivers is computed
 * from when that import's bind map reads the current state.
 *
 * A match of a stored, closed or derived relation, a relation parameter, an interior or an import without a bind map
 * binds carrier data: a finite set of values that no iteration changes. An import is a complete relation for each
 * binding of its parameters, so an import bound only to parameters, parent variables, literals or carrier data is data
 * as well, the image of finitely many inputs. An import whose bind map reads the current state is not: its output is
 * recomputed from the state on every iteration, so it can deliver a value no carrier holds, and each variable it
 * binds is computed from the state columns its bind map reads. Imports chain, one bound by
 * another's output, so the computed reads are a least fixed point; a variable a data match also binds is data, since
 * its value is that match's carrier value, and a variable the `self` match also binds is its current state value.
 */
interface Bindings {
	readonly state: ReadonlyMap<string, ReadonlyArray<string>>
	readonly data: ReadonlySet<string>
	readonly derived: ReadonlyMap<string, ReadonlySet<string>>
}

const boundVars = (m: ResolvedMatch): ReadonlyArray<string> =>
	entries(m.bindings).flatMap(([, e]) => (e.kind === "var" ? [e.var] : []))

/**
 * The computed reads given the data variables, a least fixed point over the imports; then every import whose bind
 * map reads no state binds data, which can only shrink the reads, until neither changes.
 */
const bindingsOf = (rule: ResolvedRule, self: number): Bindings => {
	const state = new Map<string, ReadonlyArray<string>>()
	const selfBound = rule.matches.flatMap((m, i) =>
		i === self
			? entries(m.bindings).flatMap(([column, e]) =>
					e.kind === "var" ? [[e.var, column] as const] : []
				)
			: []
	)
	for (const [x, column] of selfBound) {
		state.set(x, [...(state.get(x) ?? []), column])
	}
	const imports: ReadonlyArray<Import> = rule.matches.flatMap((m, i) =>
		i !== self && m.source.kind === "query"
			? [
					{
						bind: entries(m.source.bind).flatMap(([, e]) =>
							e.kind === "relationParam" ? [] : [e]
						),
						vars: boundVars(m)
					}
				]
			: []
	)
	let data: ReadonlySet<string> = new Set(
		rule.matches.flatMap((m, i) => (i !== self && m.source.kind !== "query" ? boundVars(m) : []))
	)
	for (;;) {
		const derived = derivedReads(imports, state, data)
		const reading = { state, data, derived }
		const fresh = imports
			.filter((i) => importReads(i, reading).size === 0)
			.flatMap((i) => i.vars)
			.filter((x) => !data.has(x))
		if (fresh.length === 0) {
			return reading
		}
		data = new Set([...data, ...fresh])
	}
}

/** An imported query a rule matches: its bind map's scalar terms and the variables it binds. */
interface Import {
	readonly bind: ReadonlyArray<ResolvedExpr>
	readonly vars: ReadonlyArray<string>
}

/** The state columns an import's bind map reads. */
const importReads = (i: Import, b: Bindings): ReadonlySet<string> =>
	new Set(i.bind.flatMap((e) => stateReads(e, b)))

/**
 * The state columns each variable a state-correlated import binds is computed from, given the data variables: the
 * least fixed point over the imports, one import bound by another's output.
 */
const derivedReads = (
	imports: ReadonlyArray<Import>,
	state: ReadonlyMap<string, ReadonlyArray<string>>,
	data: ReadonlySet<string>
): ReadonlyMap<string, ReadonlySet<string>> => {
	let derived: ReadonlyMap<string, ReadonlySet<string>> = new Map()
	for (;;) {
		const next = new Map(derived)
		const grown = imports.flatMap((i) => {
			const reads = importReads(i, { state, data, derived })
			return reads.size === 0
				? []
				: i.vars.filter((v) => !data.has(v)).map((x) => [x, reads] as const)
		})
		for (const [x, reads] of grown) {
			next.set(x, new Set([...(next.get(x) ?? []), ...reads]))
		}
		if (readCount(next) === readCount(derived)) {
			return derived
		}
		derived = next
	}
}

/** How many state columns all variables read together: what grows while the fixed point is not reached. */
const readCount = (derived: ReadonlyMap<string, ReadonlySet<string>>): number =>
	[...derived.values()].reduce((n, columns) => n + columns.size, 0)

/**
 * The state columns a term reads: through a variable the `self` match binds, its state columns, and through a
 * variable a state-correlated import binds, the columns its bind map reads; a variable bound to data reads none.
 */
const stateReads = (e: ResolvedExpr | ResolvedHead, b: Bindings): ReadonlyArray<string> => {
	const sub = (x: ResolvedExpr): ReadonlyArray<string> => stateReads(x, b)
	switch (e.kind) {
		case "var":
			return b.data.has(e.var) ? [] : [...(b.state.get(e.var) ?? b.derived.get(e.var) ?? [])]
		case "aggregate":
			return e.fn === "count" ? [] : sub(e.arg)
		case "producer":
		case "compute":
		case "and":
		case "or":
		case "closedAt":
		case "closedRow":
			return e.args.flatMap(sub)
		case "cast":
		case "base":
		case "not":
		case "in":
			return sub(e.arg)
		case "cond":
			return [...sub(e.pred), ...sub(e.onTrue), ...sub(e.onFalse)]
		case "when":
			return [...sub(e.subject), ...sub(e.proved), ...sub(e.otherwise)]
		case "compare":
		case "allen":
			return [...sub(e.left), ...sub(e.right)]
		case "between":
			return [...sub(e.arg), ...sub(e.low), ...sub(e.high)]
		case "pointIn":
			return [...sub(e.point), ...sub(e.span)]
		case "absent":
			return entries(e.bindings).flatMap(([, x]) => sub(x))
		case "field":
		case "value":
		case "parent":
		case "param":
		case "literal":
			return []
	}
}

/** A variable that is the current value of state column `column` and nothing else. */
const isState = (e: ResolvedExpr, column: string, b: Bindings): boolean => {
	const x = e.kind === "base" ? e.arg : e
	return x.kind === "var" && (b.state.get(x.var) ?? []).includes(column)
}

const isPureState = (e: ResolvedExpr, column: string, b: Bindings): boolean => {
	const x = e.kind === "base" ? e.arg : e
	return isState(x, column, b) && x.kind === "var" && !b.data.has(x.var)
}

/**
 * A comparison's bound: an integer literal, `known`, or an operand fixed for the statement (a parameter or a parent
 * variable), whose value admission does not know (`known` undefined).
 */
interface Bound {
	readonly known: bigint | undefined
}

const boundOf = (e: ResolvedExpr): Bound | undefined => {
	if (e.kind === "literal") {
		const i = integer(e.value)
		return i === undefined ? undefined : { known: i }
	}
	if (e.kind === "param" || e.kind === "parent") {
		return { known: undefined }
	}
	return undefined
}

type GuardOp = "lt" | "le" | "eq" | "ge" | "gt"

/** The last current value a guard against `bound` lets a rising counter advance from, if the guard stops it. */
const risingLast = (op: GuardOp, bound: bigint): bigint | undefined =>
	op === "lt" ? bound - 1n : op === "le" || op === "eq" ? bound : undefined

/** The last current value a guard against `bound` lets a falling counter advance from, if the guard stops it. */
const fallingLast = (op: GuardOp, bound: bigint): bigint | undefined =>
	op === "gt" ? bound + 1n : op === "ge" || op === "eq" ? bound : undefined

const flipped: Readonly<Record<GuardOp, GuardOp>> = {
	lt: "gt",
	le: "ge",
	eq: "eq",
	ge: "le",
	gt: "lt"
}

/**
 * The bounds an arm's filter puts on the current value of `column`: its top-level conjuncts comparing a variable of
 * that column with a bound.
 */
const guards = (
	rule: ResolvedRule,
	column: string,
	b: Bindings
): ReadonlyArray<{ readonly op: GuardOp; readonly bound: Bound }> => {
	const out: Array<{ readonly op: GuardOp; readonly bound: Bound }> = []
	const visit = (e: ResolvedExpr): void => {
		if (e.kind === "and") {
			for (const a of e.args) {
				visit(a)
			}
			return
		}
		if (e.kind === "between" && isState(e.arg, column, b)) {
			const low = boundOf(e.low)
			const high = boundOf(e.high)
			if (low !== undefined) {
				out.push({ op: "ge", bound: low })
			}
			if (high !== undefined) {
				out.push({ op: "le", bound: high })
			}
			return
		}
		if (e.kind !== "compare" || e.op === "ne") {
			return
		}
		const op: GuardOp = e.op
		if (isState(e.left, column, b)) {
			const bound = boundOf(e.right)
			if (bound !== undefined) {
				out.push({ op, bound })
			}
		} else if (isState(e.right, column, b)) {
			const bound = boundOf(e.left)
			if (bound !== undefined) {
				out.push({ op: flipped[op], bound })
			}
		}
	}
	for (const w of rule.where) {
		visit(w)
	}
	return out
}

class Analysis {
	readonly def: ResolvedRecursive
	readonly row: ReadonlyMap<string, StateType>
	readonly cx: CheckServices
	readonly #forms = new Map<string, Array<Form>>()

	constructor(def: ResolvedRecursive, row: ReadonlyMap<string, StateType>, cx: CheckServices) {
		this.def = def
		this.row = row
		this.cx = cx
	}

	/** The forms an arm's head gave a state column, in arm order: none until an arm gives it one. */
	formsOf(column: string): ReadonlyArray<Form> {
		return this.#forms.get(column) ?? []
	}

	add(column: string, value: Value, loc: SourceLoc): void {
		const forms = this.#forms.get(column)
		if (forms === undefined) {
			this.#forms.set(column, [{ value, loc }])
		} else {
			forms.push({ value, loc })
		}
	}

	range(column: string): readonly [bigint, bigint] | undefined {
		const t = this.row.get(column)
		return t === undefined ? undefined : rangeOf(t)
	}

	/** A typed literal of an integer carrier, or an untyped one, as a counter's step. */
	stepOf(e: ResolvedExpr, loc: SourceLoc): bigint | undefined {
		if (e.kind !== "literal") {
			return undefined
		}
		const k = integer(e.value)
		if (k === undefined) {
			return undefined
		}
		if (e.type !== undefined) {
			const t = this.cx.fieldType(e.type, loc)
			if (rangeOf(t) === undefined) {
				return undefined
			}
		}
		return k
	}

	/** The counter a recursive arm's head term for `column` is, when it is one. */
	counter(
		rule: ResolvedRule,
		column: string,
		h: ResolvedExpr,
		b: Bindings,
		loc: SourceLoc
	): Value | undefined {
		const type = this.row.get(column)
		const range = this.range(column)
		if (type === undefined || range === undefined) {
			return undefined
		}
		const inner = h.kind === "cast" ? h.arg : h
		if (
			inner.kind !== "compute" ||
			(inner.fn !== "add" && inner.fn !== "sub") ||
			inner.args.length !== 2
		) {
			return undefined
		}
		const [a, c] = inner.args
		if (a === undefined || c === undefined) {
			return undefined
		}
		const delta = this.#delta(inner.fn, a, c, column, b, loc)
		if (delta === undefined || delta === 0n) {
			return undefined
		}
		const [min, max] = range
		/** The last current value each guard lets the counter advance from, towards the side it moves. */
		const [first, ...more] = guards(rule, column, b).flatMap((g) => {
			const v = g.bound.known
			const last = delta > 0n ? risingLast(g.op, v ?? max) : fallingLast(g.op, v ?? min)
			return last === undefined ? [] : [last]
		})
		if (first === undefined) {
			return undefined
		}
		const limit = more.reduce(
			(acc, x) => (delta > 0n ? (x < acc ? x : acc) : x > acc ? x : acc),
			first
		)
		const produced = limit + delta
		if (produced > max || produced < min) {
			failRecursion(loc, {
				kind: "carrierOverflow",
				recursion: this.def.name,
				column,
				type: typeLabel(type),
				from: limit,
				delta,
				min,
				max
			})
		}
		return { kind: "counter", delta, limit: produced, range }
	}

	/**
	 * The step a counter of `column` takes: `state + k` or `state - k`, or `k + state`, with `k` a constant step; undefined
	 * for any other term.
	 */
	#delta(
		fn: "add" | "sub",
		a: ResolvedExpr,
		c: ResolvedExpr,
		column: string,
		b: Bindings,
		loc: SourceLoc
	): bigint | undefined {
		if (isPureState(a, column, b)) {
			const k = this.stepOf(c, loc)
			return k === undefined ? undefined : fn === "add" ? k : -k
		}
		return fn === "add" && isPureState(c, column, b) ? this.stepOf(a, loc) : undefined
	}

	/** A literal, or an integer literal cast to an integer carrier, which keeps its value. */
	constant(h: ResolvedHead, loc: SourceLoc): Value | undefined {
		if (h.kind === "literal") {
			return { kind: "literal", key: literalKey(h.value), int: integer(h.value) }
		}
		if (h.kind !== "cast" && h.kind !== "base") {
			return undefined
		}
		if (h.kind === "cast" && rangeOf(this.cx.fieldType(h.to, loc)) === undefined) {
			return undefined
		}
		const inner = this.constant(h.arg, loc)
		return inner?.kind === "literal" && inner.int !== undefined ? inner : undefined
	}

	/** What a base arm delivers for one column: a constant, or data, since a base arm reads no state. */
	baseForm(h: ResolvedHead, loc: SourceLoc): Value {
		return this.constant(h, loc) ?? { kind: "data" }
	}

	/** What a recursive arm, whose matches bind `b`, delivers for one column. */
	form(arm: Arm, column: string, h: ResolvedHead, b: Bindings, loc: SourceLoc): Value {
		const constant = this.constant(h, loc)
		if (constant !== undefined) {
			return constant
		}
		if (h.kind === "param" || h.kind === "parent") {
			return { kind: "data" }
		}
		if (h.kind === "aggregate") {
			return { kind: "data" }
		}
		if (h.kind === "var") {
			if (b.data.has(h.var)) {
				return { kind: "data" }
			}
			const from = b.state.get(h.var)
			if (from !== undefined) {
				return { kind: "copy", from }
			}
			const derived = b.derived.get(h.var)
			return derived === undefined
				? { kind: "data" }
				: { kind: "computed", reads: [...derived].toSorted(compareStrings) }
		}
		const reads = new Set(stateReads(h, b))
		if (reads.size === 0) {
			return { kind: "data" }
		}
		if (h.kind !== "producer") {
			const counter = this.counter(arm.rule, column, h, b, loc)
			if (counter !== undefined) {
				return counter
			}
		}
		return { kind: "computed", reads: [...reads].toSorted(compareStrings) }
	}
}

/** The state columns a form reads: a copy's columns, a computed term's reads, none for any other. */
const formReads = (f: Form): ReadonlyArray<string> =>
	f.value.kind === "copy" ? f.value.from : f.value.kind === "computed" ? f.value.reads : []

/**
 * A state column a form reads, as the component graph places it when the reader's component closes: a column of the
 * reader's own component, or one of an earlier component, closed with its factor.
 */
type Read = { readonly kind: "own" } | { readonly kind: "earlier"; readonly factor: bigint }

/** A form with each column it reads placed (Read). */
interface PlacedForm {
	readonly form: Form
	readonly reads: ReadonlyArray<Read>
}

/**
 * A state column of the component graph, the handle Tarjan's walk visits once: its index, its low link, which its walk
 * lowers, its forms, each read resolved to the column it reads, and its state: open while its component is on the walk's
 * stack, closed with its factor once its component is counted.
 */
interface Visit {
	readonly column: string
	readonly index: number
	low: number
	readonly forms: Array<{ readonly form: Form; readonly reads: ReadonlyArray<Visit> }>
	state: { readonly kind: "open" } | { readonly kind: "closed"; readonly factor: bigint }
}

/** A computed term reading a column of its own component: its column, its place in the row and among the column's
 * forms, and what it reads. */
interface Cyclic {
	readonly column: string
	readonly rank: number
	readonly order: number
	readonly loc: SourceLoc
	readonly reads: ReadonlyArray<string>
}

const least = (first: bigint, rest: ReadonlyArray<bigint>): bigint =>
	rest.reduce((x, y) => (y < x ? y : x), first)

const greatest = (first: bigint, rest: ReadonlyArray<bigint>): bigint =>
	rest.reduce((x, y) => (y > x ? y : x), first)

/** The values a boolean column holds, which no NULL joins (ir/scalar.ts: no type is nullable). */
const booleanValues = [false, true] as const

/** A state type's base, through its contracts: no contract is over a set (ContractBase), so no base is one either. */
const stateBase = (type: StateType): StateType => {
	const contract = contractOf(type)
	return contract === undefined ? type : stateBase(contract.base)
}

/**
 * The values a state column of `type` can hold when its domain is finite: a boolean's two and a closed id's live
 * handles; undefined for an unbounded domain. No state column is a set (StateType).
 */
const domainSize = (type: StateType): bigint | undefined => {
	const base = stateBase(type)
	switch (base.carrier) {
		case "bool":
			return BigInt(booleanValues.length)
		case "code":
			return BigInt(base.roster.handles.length)
		case "int2":
		case "int4":
		case "int8":
		case "numeric":
		case "float4":
		case "float8":
		case "money":
		case "uuid":
		case "date":
		case "text":
		case "range4":
		case "range8":
		case "vector":
		case "exactInteger":
		case "exactMoney":
			return undefined
	}
}

/** A column's value count, capped at its domain's size for a boolean or closed-id column. */
const cappedByDomain = (type: StateType, count: bigint): bigint => {
	const domain = domainSize(type)
	return domain !== undefined && domain < count ? domain : count
}

/**
 * Termination certificates and the static seen-state bound.
 *
 * A recursion is admitted only with an established termination argument, and the argument is read from what each
 * arm delivers for each state column:
 *
 * - a literal: one value;
 * - data: a column of a finite carrier relation (a stored, closed or derived relation, a relation parameter, an
 *   imported completed query whose bind map reads no state), a parameter or a parent variable, all fixed for the
 *   statement;
 * - a copy of a current state column (a variable the `self` match binds and no data match does);
 * - a computed term over current state columns, which may invent new values on every iteration, including a column of
 *   an imported query whose bind map reads the state: the import recomputes it from the state on every iteration.
 *
 * Copies and data never invent a value, so a column whose every form is one of them, or a term computed over such
 * columns only, ranges over a finite set: the finiteCarrier family, projection over finite carrier relations, where a
 * cycle terminates by UNION's duplicate elimination. A term computed from the column's own current value
 * is admitted as a bounded counter only (the boundedState family, a walk's hop count): `x + k` or `x - k`
 * with k a nonzero integer literal, over an integer carrier, in an arm whose filter bounds the current x on the side
 * it moves towards (x < B, x <= B or x = B for an increasing counter; x > B, x >= B or x = B for a decreasing one),
 * B an integer literal or a parameter. A counter that only decreases towards its bound is the wellFounded family. Any
 * other computed feedback, a counter without its bound, or a cycle of computed columns, is UnsupportedOperation
 * (unboundedState): a finite graph does not bound such state.
 *
 * A bound is answer semantics, never a hidden limit, so it must also hold in the native carrier: the counter's next
 * value may not overflow before the bound is checked, since evaluation order is no safety proof.
 * The largest value an increasing counter produces is its bound's last admitted value plus its step, and the smallest a
 * decreasing one produces its bound's first admitted value plus its step; when that leaves the carrier's range, which
 * a parameter bound can always reach at the carrier's extreme, the recursion is UnsupportedOperation
 * (carrierOverflow).
 *
 * The certificate's state estimate is the static seen-state bound, the product over state columns of the number of
 * values each can take, as far as the description fixes it: a bounded counter counts every integer between its least
 * and its greatest value (a seed it cannot read is the carrier's extreme; an arm copying the counter's component
 * unchanged adds no value), a column of literals counts them, data counts once, a computed column the product of the
 * columns it reads, a copy what it copies, and a boolean or closed-id column at most its domain. Data counts once because a
 * carrier's size is data that admission does not read: the estimate is the number of states per combination of carrier
 * values, the growth a recursion's computed state adds to its data. The estimate is recorded, never refused: finite
 * state is a termination argument, not a resource bound. The states a recursion reaches are its data's, and its
 * recursive UNION holds every one of them in a seen-state hash, which PostgreSQL keeps in memory and never spills
 * (nodeRecursiveunion.c): its size is the run's to meet, never a compiler's threshold to refuse.
 *
 * The range a counter's component spans, every integer between its least and its greatest value, bounds every state
 * of its columns, so the step computes, on any state a counter column holds, the state plus one of the column's steps:
 * the column's counter interval, [least + the most negative step, greatest + the most positive step], the steps
 * taken as 0 where none is negative or none positive. It holds the value one step past the bound, which PostgreSQL
 * may compute on the working table's last rows before the step's filter drops them, and it is what proves the exact
 * step's narrowing into the column (state.ts).
 *
 * The termination verdict of a definition whose arms the scan admitted, or its refusal: UnsupportedOperation for
 * unbounded computed state or a carrier overflow.
 *
 * A computed term reading a column of its own component invents values around a cycle: unbounded.
 */
export const terminationVerdict = (input: {
	readonly def: ResolvedRecursive
	readonly row: ReadonlyMap<string, StateType>
	readonly base: ReadonlyArray<Arm>
	readonly rec: ReadonlyArray<RecArm>
	readonly cx: CheckServices
}): TerminationVerdict => {
	const { def, row } = input
	const a = new Analysis(def, row, input.cx)
	for (const arm of input.base) {
		for (const [column, h] of entries(arm.rule.head)) {
			a.add(column, a.baseForm(h, childLoc(childLoc(arm.loc, "head"), column)), arm.loc)
		}
	}
	for (const arm of input.rec) {
		const b = bindingsOf(arm.rule, arm.self.at)
		for (const [column, h] of entries(arm.rule.head)) {
			const loc = childLoc(childLoc(arm.loc, "head"), column)
			a.add(column, a.form(arm, column, h, b, loc), loc)
		}
	}
	const columns = [...row.keys()]
	const forms = (c: string): ReadonlyArray<Form> => a.formsOf(c)
	/** The values a counter's component takes: every integer between its least and its greatest. */
	const counterRange = (
		[min, max]: readonly [bigint, bigint],
		all: ReadonlyArray<PlacedForm>,
		steps: ReadonlyArray<Extract<Value, { readonly kind: "counter" }>>
	): readonly [bigint, bigint] => {
		/**
		 * What can widen the range: every form but a counter and a copy of the component's own columns, which
		 * delivers a value the component already holds.
		 */
		const inputs = all.filter(
			({ form, reads }) =>
				form.value.kind !== "counter" &&
				!(form.value.kind === "copy" && reads.every((r) => r.kind === "own"))
		)
		const known = inputs.flatMap(({ form }) =>
			form.value.kind === "literal" && form.value.int !== undefined ? [form.value.int] : []
		)
		const [first, ...rest] = known
		const falling = steps.flatMap((x) => (x.delta < 0n ? [x.limit] : []))
		const rising = steps.flatMap((x) => (x.delta > 0n ? [x.limit] : []))
		return known.length < inputs.length || first === undefined
			? [least(min, falling), greatest(max, rising)]
			: [least(first, [...rest, ...falling]), greatest(first, [...rest, ...rising])]
	}
	/**
	 * The number of values any other component takes: its literals, data once, and for each copy or computed term the
	 * factors of the columns of earlier components it reads.
	 */
	const valueCount = (all: ReadonlyArray<PlacedForm>): bigint => {
		const literals = new Set(
			all.flatMap(({ form }) => (form.value.kind === "literal" ? [form.value.key] : []))
		)
		const data = all.some(({ form }) => form.value.kind === "data")
		const earlier = (reads: ReadonlyArray<Read>): ReadonlyArray<bigint> =>
			reads.flatMap((r) => (r.kind === "earlier" ? [r.factor] : []))
		const sum = all.reduce((acc, { form, reads }) => {
			const kind = form.value.kind
			if (kind === "copy") {
				return earlier(reads).reduce((n, f) => n + f, acc)
			}
			return kind === "computed" ? acc + earlier(reads).reduce((p, f) => p * f, 1n) : acc
		}, 0n)
		const count = BigInt(literals.size) + (data ? 1n : 0n) + sum
		return count < 1n ? 1n : count
	}
	/** The computed terms reading a column of their own component, the row's factors, components in dependency order. */
	const cyclic: Array<Cyclic> = []
	const factors: Array<bigint> = []
	const intervals = new Map<string, readonly [bigint, bigint]>()
	/** Counts a closed component, `members` last pushed first: every read of an open column is of the component
	 * itself. */
	const close = (members: ReadonlyArray<Visit>): void => {
		const all = members.flatMap((m) =>
			m.forms.map(({ form, reads }): PlacedForm => ({
				form,
				reads: reads.map((r): Read =>
					r.state.kind === "open" ? { kind: "own" } : { kind: "earlier", factor: r.state.factor }
				)
			}))
		)
		for (const m of members) {
			for (const [order, { form, reads }] of m.forms.entries()) {
				if (form.value.kind === "computed" && reads.some((r) => r.state.kind === "open")) {
					cyclic.push({
						column: m.column,
						rank: columns.indexOf(m.column),
						order,
						loc: form.loc,
						reads: form.value.reads
					})
				}
			}
		}
		const steps = all.flatMap(({ form }) => (form.value.kind === "counter" ? [form.value] : []))
		/** The component's counter, where one of its columns counts: the first column's first counter form. */
		const [counter] = members.flatMap((m) =>
			m.forms.flatMap(({ form }) => (form.value.kind === "counter" ? [form.value] : []))
		)
		const range = counter === undefined ? undefined : counterRange(counter.range, all, steps)
		const count = range === undefined ? valueCount(all) : range[1] - range[0] + 1n
		for (const m of members) {
			const deltas = m.forms.flatMap(({ form }) =>
				form.value.kind === "counter" ? [form.value.delta] : []
			)
			if (range !== undefined && deltas.length > 0) {
				intervals.set(m.column, [range[0] + least(0n, deltas), range[1] + greatest(0n, deltas)])
			}
			const type = row.get(m.column)
			const factor = type === undefined ? count : cappedByDomain(type, count)
			m.state = { kind: "closed", factor }
			if (type !== undefined) {
				factors.push(factor)
			}
		}
	}
	/**
	 * The component graph, Tarjan's walk over the columns' dependency edges (a column depends on the columns its copies
	 * and computed terms read), its depth the number of state columns. A component closes after every component it reads
	 * has, so each read is of its own component, still open, or of a closed one, with its factor.
	 */
	let index = 0
	const visits = new Map<string, Visit>()
	const stack: Array<Visit> = []
	const visit = (column: string): Visit => {
		const at: Visit = { column, index, low: index, forms: [], state: { kind: "open" } }
		visits.set(column, at)
		index++
		stack.push(at)
		for (const form of forms(column)) {
			const reads = formReads(form).map((d) => {
				const seen = visits.get(d)
				if (seen === undefined) {
					const w = visit(d)
					at.low = Math.min(at.low, w.low)
					return w
				}
				if (seen.state.kind === "open") {
					at.low = Math.min(at.low, seen.index)
				}
				return seen
			})
			at.forms.push({ form, reads })
		}
		if (at.low === at.index) {
			close(stack.splice(stack.indexOf(at)).toReversed())
		}
		return at
	}
	for (const c of columns) {
		if (!visits.has(c)) {
			visit(c)
		}
	}
	const [firstCyclic] = cyclic.toSorted((x, y) => x.rank - y.rank || x.order - y.order)
	if (firstCyclic !== undefined) {
		failRecursion(firstCyclic.loc, {
			kind: "unboundedState",
			recursion: def.name,
			column: firstCyclic.column,
			reads: firstCyclic.reads
		})
	}
	const steps = columns.flatMap((c) =>
		forms(c).flatMap((f) => (f.value.kind === "counter" ? [f.value] : []))
	)
	const counting = steps.length > 0
	const increasing = steps.some((x) => x.delta > 0n)
	/** Every row column is in one component, closed with its factor. */
	const stateEstimate = factors.reduce((p, f) => p * f, 1n)
	return {
		kind: !counting ? "finiteCarrier" : increasing ? "boundedState" : "wellFounded",
		stateEstimate,
		counters: intervals
	}
}

/**
 * What termination admits a recursion by: its certificate family, its state estimate, and each counter column's
 * interval, every value its step computes from every state the column holds.
 */
export interface TerminationVerdict {
	readonly kind: TerminationCert["kind"]
	readonly stateEstimate: bigint
	readonly counters: ReadonlyMap<string, readonly [bigint, bigint]>
}

/** The certificate of a verdict over the step it proves: a counter family's premise is that step. */
export const certificate = (verdict: TerminationVerdict, step: RelNode): TerminationCert => ({
	kind: verdict.kind,
	stateEstimate: verdict.stateEstimate,
	premises: verdict.kind === "finiteCarrier" ? [] : [{ kind: "node", node: step.id }]
})
