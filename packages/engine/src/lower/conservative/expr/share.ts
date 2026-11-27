import { defect } from "@bjornpagen/grizzle-text/base/invariant"
import { canonicalEquals, canonicalTextOf } from "#compiler/core/canonical.ts"
import { ExprId } from "#compiler/core/ids.ts"
import { compareStrings } from "#compiler/core/order.ts"
import {
	builtExpr,
	type EqualityKey,
	type ExprOf,
	type ExprSpec,
	type LiveArgs,
	mapArgs,
	nativeEqualityKey,
	outsideSpec,
	predicateTable,
	type ScalarExpr,
	type TypedLiteral,
	withArgs
} from "#compiler/ir/expr.ts"
import type { ClosedTheoryRelation } from "#compiler/ir/law.ts"
import { baseOf } from "#compiler/ir/scalar.ts"
import {
	compiledExpr,
	type EvalLeaves,
	noParamLeaf,
	sqlNull
} from "#compiler/scalar/compute/evaluate.ts"
import { literalOfHost } from "#compiler/scalar/compute/literal.ts"
import { connectiveOps, definedIdOf, overloadOf } from "#compiler/scalar/compute/registry.ts"
import { plainType } from "#compiler/scalar/native.ts"
import { ProgramPatterns, tablePatterns } from "#compiler/scalar/regex/patterns.ts"

/**
 * Sharing inside one scalar expression: the rewrite, before a term lowers, that evaluates a subterm it reads more than
 * once once on every path, through the one construct PostgreSQL evaluates once inside a scalar expression, a simple
 * CASE's subject. A term is a DAG, and its SQL a tree: no binding construct exists in a generated column, a CHECK or a
 * query's scalar, and a SQL function that took the subterm as its argument either is inlined, its argument copied
 * again at every use of its parameter, or is not, and then every row runs its executor (clauses.c inline_function, at
 * a parameter read more than once of an argument costing more than ten operators), so the sharing is the lowering's.
 *
 * Two rewrites, each taken only where the SQL text the site prints does not grow (ShareScope.size), and each keeping
 * the term's value on every row, NULL and refusal included (a declared function's call, the one expression that raises,
 * is never moved or dropped), a split taken only where it makes no operation over literals that raises, which
 * PostgreSQL's planner evaluates wherever it stands, a CASE arm no row reaches included (#raisesAsPlanned):
 *
 * - a split of `e` on a subterm `s` that `e` reads more than once, that is evaluated on every evaluation of `e`
 *   (#anticipates), that is never NULL there (#nonNullAt), that raises nothing, and whose values the compiler knows,
 *   finitely many (#valuesOf): a boolean, a closed relation's payload read at a key (its column's values over the
 *   relation's rows), a literal, or a conditional of them. `e` is then `CASE s WHEN v THEN e[s:=v] ... END`, each arm `e`
 *   with `s` replaced by a value and folded (#substituted), the arm most values share the ELSE: as a conditional chain
 *   of equalities of `s` to a literal, which lowerScalar prints as one simple CASE over `s` (equalityChain), or, for a
 *   boolean, the conditional on `s` itself. A test of `s = v` holds at every value of v's class under `=`, so the chain
 *   has one arm per class, and a split is taken only where every value of a class gives one arm: a float's -0 and 0,
 *   which `=` holds equal, give two where `e` tells them apart, `greatest(s, s)` among them, and no split takes them;
 * - arm factoring: `cond(c, C[a], C[b])` is `C[cond(c, a, b)]` where the two arms differ at one pair of subterms
 *   (anti-unification), and where one arm is the other with a subterm of known values at one of its values, as
 *   `lexical` is `sw(preserve)` of `sw(x) = CASE x WHEN collapse THEN … WHEN replace THEN … ELSE lexical END`.
 *   Every part of C is evaluated as it was, and `c` with it.
 *
 * Every conditional either rewrite builds, and every one the term holds, is built in one place (#cond), which reduces a
 * boolean conditional over a condition never NULL with an arm that is a constant to its connective (`constantArms`):
 * a check's refusal `cond(p, false, true)` is `NOT p`, and a split whose arm where its subterm fails is false is the
 * conjunction, so an equality stays where PostgreSQL reads an index condition.
 *
 * Structurally equal subterms are one subterm (`Interned`), so a term its author built twice is shared as one built
 * once. The IR's meaning is unchanged: the rewrite is a term the host evaluates to the same value, and only its SQL
 * differs.
 */

/** What the rewrite reads where the expression stands. */
export interface ShareScope {
	/**
	 * The closed relations by their declared names (ir/physical.ts PhysicalNames closedRelations): the values a read of
	 * one takes.
	 */
	readonly closed: ReadonlyMap<string, ClosedTheoryRelation>
	/**
	 * The host's reads of the closed relations (runtime/write/fill.ts closedLeaf), over the installation's index of them
	 * (ir/physical.ts PhysicalNames closedIndex): the facts a subterm of constants is evaluated over, so no rewrite reads a
	 * relation's rows.
	 */
	readonly host: EvalLeaves["closed"]
	/**
	 * The length of the SQL text the site prints `expr` as, measured without printing anything of a statement; undefined
	 * where the site refuses to print it.
	 */
	readonly size: (expr: ScalarExpr) => number | undefined
	/** The texts its interning reads, made once for the statement it lowers (FieldTexts). */
	readonly texts: FieldTexts
}

/**
 * The values a closed payload read takes, its field's over its relation's facts (ir/law.ts ClosedTheoryRelation
 * `values`), worked out where the relation was read, never here.
 */
const closedReadValues = (
	closed: ReadonlyMap<string, ClosedTheoryRelation>,
	read: ExprOf<"closedAt">
): ReadonlyArray<TypedLiteral> => {
	const relation = closed.get(read.relation)
	const field = relation?.heading.find((f) => f.name === read.field)
	const values = field === undefined ? undefined : relation?.values[field.position]
	if (values === undefined) {
		defect(`a closed relation ${read.relation} of the site's names with a field ${read.field}`)
	}
	return values
}

/** The closed relations' facts a path knows: the membership tests that hold wherever the path is evaluated. */
type Facts = ReadonlySet<ExprOf<"closedHas">>

const noFacts: Facts = new Set()

/** Which boolean connective `e` is, if any: AND or OR, PostgreSQL's evaluated operand by operand, in order. */
const connectiveOf = (e: ScalarExpr): "and" | "or" | undefined =>
	e.kind !== "op"
		? undefined
		: e.op === connectiveOps.and
			? "and"
			: e.op === connectiveOps.or
				? "or"
				: undefined

/** Whether `e` is a boolean. */
const isBoolean = (e: ScalarExpr): boolean => baseOf(e.type).carrier === "bool"

/** The boolean a literal is, or undefined for any other expression. */
const truthOf = (e: ScalarExpr): boolean | undefined =>
	e.kind === "literal" && e.value.kind === "bool" ? e.value.value : undefined

/**
 * What a boolean conditional `cond(s, t, f)` over a condition `s` never NULL is where one of its arms is a constant,
 * keyed by that arm and its value: `s`, or `NOT s`, joined to the other arm by AND or OR. The four are exact on every
 * row: `s` is true or false there, never NULL, and each connective's value at either is the arm the conditional takes.
 *
 * - `cond(s, true, e)` is `s OR e`;
 * - `cond(s, false, e)` is `NOT s AND e`;
 * - `cond(s, t, false)` is `s AND t`;
 * - `cond(s, t, true)` is `NOT s OR t`.
 */
const constantArms = {
	holds: {
		true: { negated: false, connective: "or" },
		false: { negated: true, connective: "and" }
	},
	fails: {
		true: { negated: true, connective: "or" },
		false: { negated: false, connective: "and" }
	}
} as const satisfies {
	readonly [Arm in "holds" | "fails"]: {
		readonly [Value in "true" | "false"]: {
			readonly negated: boolean
			readonly connective: "and" | "or"
		}
	}
}

/**
 * The canonical texts of the values expressions' own fields hold, and of each expression's own fields, made once for a
 * statement: a type, an operator's proof or a literal is one frozen value its expressions share, a name one string many
 * hold, and an expression's own fields are its own, whichever rewrite of the statement interns it. One store serves
 * every rewrite of one statement's lowering (conservative/context.ts LowerContext fieldTexts).
 */
export class FieldTexts {
	readonly #objects = new Map<object, string>()
	readonly #strings = new Map<string, string>()
	readonly #fields = new Map<ScalarExpr, string>()

	/** The canonical text of one field's value, an object's or a string's made once. */
	#text(value: unknown): string {
		if (typeof value === "string") {
			return this.#strings.getOrInsertComputed(value, canonicalTextOf)
		}
		if (typeof value !== "object" || value === null) {
			return canonicalTextOf(value)
		}
		return this.#objects.getOrInsertComputed(value, canonicalTextOf)
	}

	/**
	 * The canonical text of an expression's own fields but its volatility: every one but its arguments, its label and the
	 * derived ones, each by its name in code-unit order. Its volatility, which builtExpr joins from its own and its
	 * arguments', stands beside it in its structure.
	 */
	fieldsText(e: ScalarExpr): string {
		return this.#fields.getOrInsertComputed(e, () => {
			const {
				args: _args,
				id: _id,
				deps: _deps,
				pgType: _pgType,
				volatility: _volatility,
				...own
			} = e
			const fields: ReadonlyArray<readonly [string, unknown]> = Object.entries(own)
			return fields
				.toSorted(([a], [b]) => compareStrings(a, b))
				.map(([key, value]) => `${key}=${this.#text(value)}`)
				.join(";")
		})
	}
}

/**
 * One expression per structure: each expression rebuilt over its arguments' representatives, and the first of every
 * structurally equal set its representative, so a subterm read twice is one object however its author built it.
 * The structure of an expression is its own fields, every field but its arguments, its label and what builtExpr
 * derives, and its arguments' representatives.
 */
class Interned {
	readonly #byKey = new Map<string, ScalarExpr>()
	/** Each representative's own fields but its volatility (FieldTexts fieldsText). */
	readonly #fieldsOf = new Map<ScalarExpr, string>()
	readonly #numberOf = new Map<ScalarExpr, number>()
	readonly #representative = new Map<ScalarExpr, ScalarExpr>()
	readonly #texts: FieldTexts

	constructor(texts: FieldTexts) {
		this.#texts = texts
	}

	/** The representative of `e`. */
	of(e: ScalarExpr): ScalarExpr {
		if (this.#numberOf.has(e)) {
			return e
		}
		const known = this.#representative.get(e)
		if (known !== undefined) {
			return known
		}
		const made = this.#made(e)
		this.#representative.set(e, made)
		return made
	}

	/** The representative of `e`, which is none yet: the one of its structure, or itself over its arguments' ones. */
	#made(e: ScalarExpr): ScalarExpr {
		const args = e.args.map((a) => this.of(a))
		const same = args.every((a, i) => a === e.args[i])
		const fields = this.#texts.fieldsText(e)
		const key = `${fields};volatility=${e.volatility}(${args.map((a) => this.number(a)).join(",")})`
		const held = this.#byKey.get(key)
		if (held !== undefined) {
			return held
		}
		const rebuilt = same
			? e
			: builtExpr(
					withArgs<LiveArgs, LiveArgs>(outsideSpec(e), (a) => this.of(a)),
					e.id
				)
		this.#byKey.set(key, rebuilt)
		this.#fieldsOf.set(rebuilt, fields)
		this.#numberOf.set(rebuilt, this.#numberOf.size)
		return rebuilt
	}

	/** The number of a representative, in the order representatives were met: the rewrite's deterministic order. */
	number(e: ScalarExpr): number {
		const n = this.#numberOf.get(e)
		if (n === undefined) {
			return this.number(this.of(e))
		}
		return n
	}

	/** Whether two representatives have the same own fields and arity, so they differ, if at all, in an argument. */
	sameShape(a: ScalarExpr, b: ScalarExpr): boolean {
		return this.sameFields(a, b) && a.volatility === b.volatility
	}

	/**
	 * Whether two representatives have the same own fields but their volatilities, and the same arity: whether `a` may
	 * be `b` rebuilt over other arguments (Sharing #over), whose volatility builtExpr joins from its own and the
	 * arguments' (ir/expr.ts exprEffects).
	 */
	sameFields(a: ScalarExpr, b: ScalarExpr): boolean {
		return a.args.length === b.args.length && this.#fieldsOf.get(a) === this.#fieldsOf.get(b)
	}
}

/** The rewrite of one expression in one scope (sharedExpr). */
class Sharing {
	readonly #interned: Interned
	readonly #anticipated = new Map<ScalarExpr, Map<ScalarExpr, boolean>>()
	readonly #raises = new Map<ScalarExpr, boolean>()
	readonly #plannedRaise = new Map<ScalarExpr, boolean>()
	readonly #constantForms = new Map<ScalarExpr, boolean>()
	readonly #values = new Map<ScalarExpr, ReadonlyArray<TypedLiteral> | undefined>()
	readonly #rewritten = new Map<Facts, Map<ScalarExpr, ScalarExpr>>()
	readonly #nonNull = new Map<Facts, Map<ScalarExpr, boolean>>()
	readonly #facts = new Map<string, Facts>()
	readonly #scope: ShareScope
	#minted = 0
	/** Whether a split may apply: some subterm of the expression occurs twice in it. */
	#splits = true

	constructor(scope: ShareScope) {
		this.#scope = scope
		this.#interned = new Interned(scope.texts)
	}

	/**
	 * `expr` rewritten: no split is sought where no subterm of it occurs twice, so a term that reads nothing twice is
	 * walked once for its factorings alone.
	 */
	run(expr: ScalarExpr): ScalarExpr {
		const root = this.#interned.of(expr)
		this.#splits = [...this.#occurrences(root).values()].some((n) => n > 1)
		return this.#rewrite(root, noFacts)
	}

	/** A fresh label derived from `e`'s, for an expression the rewrite builds. */
	#label(e: ScalarExpr): ExprId {
		this.#minted += 1
		return ExprId(`${e.id}~${this.#minted}`)
	}

	/** The representative of the expression of `spec`, labelled after `like`. */
	#built(spec: ExprSpec, like: ScalarExpr): ScalarExpr {
		return this.#interned.of(builtExpr(spec, this.#label(like)))
	}

	/** The literal `value` of `type`, as the representative of its expression. */
	#literal(value: TypedLiteral, like: ScalarExpr): ScalarExpr {
		return this.#built(
			{ kind: "literal", value, args: [], type: like.type, nonNull: "literal" },
			like
		)
	}

	/** The boolean literal `value`, typed as `like`. */
	#truth(value: boolean, like: ScalarExpr): ScalarExpr {
		return this.#literal({ kind: "bool", value }, like)
	}

	/** `e` over `args`, one per operand in operand order, its own fields kept: itself where no argument changed. */
	#over(e: ScalarExpr, args: ReadonlyArray<ScalarExpr>): ScalarExpr {
		if (args.length === e.args.length && args.every((a, i) => a === e.args[i])) {
			return e
		}
		const operands = mapArgs<LiveArgs, LiveArgs>(outsideSpec(e))
		let step = operands.next()
		for (const a of args) {
			if (step.done === true) {
				defect(`an expression of ${e.kind} over as many arguments as it has operands`)
			}
			step = operands.next(a)
		}
		if (step.done !== true) {
			defect(`an expression of ${e.kind} over an argument per operand`)
		}
		return this.#built(step.value, e)
	}

	/** Whether `e` may raise: it reads a declared function's call, which refuses a NULL it returns. */
	#raisesAt(e: ScalarExpr): boolean {
		const known = this.#raises.get(e)
		if (known !== undefined) {
			return known
		}
		const raises = e.kind === "call" || e.args.some((a) => this.#raisesAt(a))
		this.#raises.set(e, raises)
		return raises
	}

	/**
	 * Whether `e` holds a subterm PostgreSQL evaluates as it plans the statement and that raises there: an operation or a
	 * cast of constants, reading no column, VALUE or parameter (#constantForm), which its planner folds to a constant
	 * wherever it stands (clauses.c eval_const_expressions), inside a CASE arm no row ever reaches included, and whose
	 * operands fail its precondition (scalar/compute/evaluate.ts EvalStop `undefined`), as a division or a remainder by
	 * zero does (22012). A CASE guards such an operation at run time alone, so a statement that holds one raises whatever
	 * rows it reads: a split that substitutes a value into a guarded operation (#split) may make one,
	 * `(0::numeric)::numeric % (0::numeric)::numeric` in the arm the guard keeps every row from, where the term held none.
	 */
	#raisesAsPlanned(e: ScalarExpr): boolean {
		const known = this.#plannedRaise.get(e)
		if (known !== undefined) {
			return known
		}
		const raises =
			(e.kind !== "literal" && this.#constantForm(e) && this.#stops(e)) ||
			e.args.some((a) => this.#raisesAsPlanned(a))
		this.#plannedRaise.set(e, raises)
		return raises
	}

	/**
	 * Whether `e` reads only constants: a literal, or an operation, a cast, a conditional or a closed read of constants;
	 * not a column, the VALUE, a parameter or a declared function's call.
	 */
	#constantForm(e: ScalarExpr): boolean {
		const known = this.#constantForms.get(e)
		if (known !== undefined) {
			return known
		}
		const constant =
			e.kind === "literal" ||
			(e.kind !== "column" &&
				e.kind !== "value" &&
				e.kind !== "param" &&
				e.kind !== "call" &&
				e.args.every((a) => this.#constantForm(a)))
		this.#constantForms.set(e, constant)
		return constant
	}

	/** Whether the host's evaluation of `form`, which reads no row, stops at a precondition its operands fail. */
	#stops(form: ScalarExpr): boolean {
		const table = predicateTable(form)
		const value = compiledExpr(table)(
			{ value: undefined, column: () => undefined, closed: this.#scope.host, param: noParamLeaf },
			ProgramPatterns.of(tablePatterns(table))
		)
		return !value.ok && value.error.kind === "undefined"
	}

	/**
	 * Whether `s` is evaluated on every evaluation of `e`: `e` is `s`; an operation, a cast or a read, which evaluates
	 * every argument, has an argument that evaluates it; a connective's first operand does, the one PostgreSQL always
	 * evaluates; a conditional's condition does, or both its arms do.
	 */
	#anticipates(e: ScalarExpr, s: ScalarExpr): boolean {
		if (e === s) {
			return true
		}
		const memo = this.#anticipated.getOrInsertComputed(s, () => new Map())
		const known = memo.get(e)
		if (known !== undefined) {
			return known
		}
		const evaluated = ((): boolean => {
			if (e.kind === "cond") {
				const [c, t, f] = e.args
				return this.#anticipates(c, s) || (this.#anticipates(t, s) && this.#anticipates(f, s))
			}
			if (connectiveOf(e) !== undefined) {
				const first = e.args[0]
				return first !== undefined && this.#anticipates(first, s)
			}
			return e.args.some((a) => this.#anticipates(a, s))
		})()
		memo.set(e, evaluated)
		return evaluated
	}

	/** How many times each subterm of `e` occurs in `e` written as a tree. */
	#occurrences(e: ScalarExpr): ReadonlyMap<ScalarExpr, number> {
		const order: Array<ScalarExpr> = []
		const seen = new Set<ScalarExpr>()
		const visit = (x: ScalarExpr): void => {
			if (seen.has(x)) {
				return
			}
			seen.add(x)
			for (const a of x.args) {
				visit(a)
			}
			order.push(x)
		}
		visit(e)
		const counts = new Map<ScalarExpr, number>([[e, 1]])
		for (const x of order.toReversed()) {
			const n = counts.get(x) ?? 0
			for (const a of x.args) {
				counts.set(a, (counts.get(a) ?? 0) + n)
			}
		}
		return counts
	}

	/**
	 * The values `e` takes, where the compiler knows them, finitely many, in a fixed order, each once: a literal's own,
	 * a closed payload read's its field's over the relation's facts (ir/law.ts ClosedTheoryRelation `values`), a
	 * conditional's its arms'.
	 * A boolean's are true and false, which the split reads of its type.
	 */
	#valuesOf(e: ScalarExpr): ReadonlyArray<TypedLiteral> | undefined {
		if (this.#values.has(e)) {
			return this.#values.get(e)
		}
		const values = ((): ReadonlyArray<TypedLiteral> | undefined => {
			switch (e.kind) {
				case "literal":
					return [e.value]
				case "closedAt":
					return closedReadValues(this.#scope.closed, e)
				case "cond": {
					const [, t, f] = e.args
					const a = this.#valuesOf(t)
					const b = this.#valuesOf(f)
					return a === undefined || b === undefined
						? undefined
						: [...a, ...b.filter((v) => !a.some((u) => canonicalEquals(u, v)))]
				}
				case "column":
				case "value":
				case "param":
				case "op":
				case "cast":
				case "domainCast":
				case "closedRow":
				case "closedHas":
				case "call":
				case "variant":
					return undefined
			}
		})()
		this.#values.set(e, values)
		return values
	}

	/** The facts of `facts` and those `c` holding proves: every membership test a conjunction holding holds. */
	#withTruths(facts: Facts, c: ScalarExpr): Facts {
		const truths = (x: ScalarExpr): ReadonlyArray<ExprOf<"closedHas">> =>
			x.kind === "closedHas" ? [x] : connectiveOf(x) === "and" ? x.args.flatMap(truths) : []
		const added = truths(c).filter((t) => !facts.has(t))
		if (added.length === 0) {
			return facts
		}
		const all = [...facts, ...added]
		const key = all
			.map((t) => this.#interned.number(t))
			.toSorted((a, b) => a - b)
			.join(",")
		const held = this.#facts.get(key)
		if (held !== undefined) {
			return held
		}
		const made: Facts = new Set(all)
		this.#facts.set(key, made)
		return made
	}

	/**
	 * Whether `e` is never NULL wherever `facts` hold: a closed payload read only at a key a fact holds the relation
	 * at, a conjunction's later operand where its earlier ones hold, a conditional's THEN arm where its condition holds
	 * (a NULL condition takes the ELSE arm), a variant's arm's field where its subject is never NULL, since only the
	 * branch of its arm reads it (scalar/compute/typing.ts), and every other expression where its arguments are never NULL, a
	 * declared function's call called on NULL input always (its NULL is refused), a strict one's as every strict
	 * operation's.
	 */
	#nonNullAt(e: ScalarExpr, facts: Facts): boolean {
		const memo = this.#nonNull.getOrInsertComputed(facts, () => new Map())
		const known = memo.get(e)
		if (known !== undefined) {
			return known
		}
		const never = ((): boolean => {
			switch (e.kind) {
				case "column":
				case "value":
				case "param":
				case "literal":
					return true
				case "call":
					return e.nonNull === "returned" || e.args.every((a) => this.#nonNullAt(a, facts))
				case "variant":
					return e.args.every((a) => this.#nonNullAt(a, facts))
				case "closedAt":
					return (
						e.args.every((a) => this.#nonNullAt(a, facts)) &&
						[...facts].some(
							(h) =>
								h.relation === e.relation &&
								h.args.length === e.args.length &&
								h.args.every((a, i) => a === e.args[i])
						)
					)
				case "cond": {
					const [c, t, f] = e.args
					return this.#nonNullAt(t, this.#withTruths(facts, c)) && this.#nonNullAt(f, facts)
				}
				case "op": {
					if (connectiveOf(e) === "and") {
						let holding = facts
						for (const a of e.args) {
							if (!this.#nonNullAt(a, holding)) {
								return false
							}
							holding = this.#withTruths(holding, a)
						}
						return true
					}
					return e.args.every((a) => this.#nonNullAt(a, facts))
				}
				case "cast":
				case "domainCast":
				case "closedRow":
				case "closedHas":
					return e.args.every((a) => this.#nonNullAt(a, facts))
			}
		})()
		memo.set(e, never)
		return never
	}

	/**
	 * The host's value of `form`, which reads no row, its closed reads applied (scalar/compute/evaluate.ts): what
	 * PostgreSQL computes under pg_c_utf8, or undefined where the host has none, or the value is NULL.
	 */
	#constant(form: ScalarExpr): ScalarExpr | undefined {
		if (
			form.kind === "literal" ||
			this.#raisesAt(form) ||
			form.args.some((a) => a.kind !== "literal")
		) {
			return undefined
		}
		const table = predicateTable(form)
		const value = compiledExpr(table)(
			{ value: undefined, column: () => undefined, closed: this.#scope.host, param: noParamLeaf },
			ProgramPatterns.of(tablePatterns(table))
		)
		return !value.ok || value.value === sqlNull
			? undefined
			: this.#literal(literalOfHost(value.value, form.type), form)
	}

	/**
	 * `e` over `args`, folded as PostgreSQL's value of it is: a conditional of a known condition its arm, of equal arms
	 * that arm; a connective one of whose operands decides it that value, an operand that decides nothing dropped; an
	 * expression of constants its value. Nothing that raises is dropped.
	 */
	#simplified(e: ScalarExpr, args: ReadonlyArray<ScalarExpr>): ScalarExpr {
		if (e.kind === "cond") {
			const [c, t, f] = args
			if (c !== undefined && t !== undefined && f !== undefined) {
				const truth = truthOf(c)
				if (truth !== undefined) {
					return truth ? t : f
				}
				if (t === f && !this.#raisesAt(c)) {
					return t
				}
			}
			return this.#over(e, args)
		}
		const connective = connectiveOf(e)
		if (connective !== undefined) {
			const deciding = connective === "or"
			if (args.some((a) => truthOf(a) === deciding) && !args.some((a) => this.#raisesAt(a))) {
				return this.#truth(deciding, e)
			}
			const rest = args.filter((a) => truthOf(a) !== !deciding)
			const [only, ...more] = rest
			if (only === undefined) {
				return this.#truth(!deciding, e)
			}
			if (more.length === 0) {
				return only
			}
			return this.#over(e, args)
		}
		const over = this.#over(e, args)
		return this.#constant(over) ?? over
	}

	/** `e` with each key of `substitution` replaced by its value, folded (`simplified`) wherever it changed. */
	#substituted(e: ScalarExpr, substitution: ReadonlyMap<ScalarExpr, ScalarExpr>): ScalarExpr {
		const memo = new Map<ScalarExpr, ScalarExpr>()
		const fold = (x: ScalarExpr): ScalarExpr => {
			const replaced = substitution.get(x)
			if (replaced !== undefined) {
				return replaced
			}
			const known = memo.get(x)
			if (known !== undefined) {
				return known
			}
			const args = x.args.map(fold)
			const folded = args.every((a, i) => a === x.args[i]) ? x : this.#simplified(x, args)
			memo.set(x, folded)
			return folded
		}
		return fold(e)
	}

	/** `s = value`, the equality of the split's subject to one of its values, where its carrier has one. */
	#equality(s: ScalarExpr, value: ScalarExpr): ScalarExpr | undefined {
		const carrier = baseOf(s.type).carrier
		const eq = overloadOf("eq", [carrier, carrier])
		const op = eq === undefined ? undefined : definedIdOf(eq)
		return op === undefined
			? undefined
			: this.#built(
					{
						kind: "op",
						op,
						args: [s, value],
						type: plainType("bool"),
						nonNull: "strict",
						volatility: "immutable"
					},
					s
				)
	}

	/** `NOT c`: the operand of a negation, a boolean literal flipped, or the negation built, labelled after `c`. */
	#negated(c: ScalarExpr): ScalarExpr {
		const truth = truthOf(c)
		if (truth !== undefined) {
			return this.#truth(!truth, c)
		}
		const [operand] = c.args
		return c.kind === "op" && c.op === connectiveOps.not && operand !== undefined
			? operand
			: this.#built(
					{
						kind: "op",
						op: connectiveOps.not,
						args: [c],
						type: c.type,
						nonNull: "strict",
						volatility: "immutable"
					},
					c
				)
	}

	/**
	 * `a` and `b` joined by `connective`, labelled after `like`: an operand that is the connective's unit dropped, and an
	 * operand that decides it its value, so a reduced conditional prints no `AND true`; neither operand raises.
	 */
	#joined(connective: "and" | "or", a: ScalarExpr, b: ScalarExpr, like: ScalarExpr): ScalarExpr {
		const unit = connective === "and"
		if (truthOf(a) === unit) {
			return b
		}
		if (truthOf(b) === unit) {
			return a
		}
		if (truthOf(a) === !unit || truthOf(b) === !unit) {
			return this.#truth(!unit, like)
		}
		return this.#built(
			{
				kind: "op",
				op: connectiveOps[connective],
				args: [a, b],
				type: like.type,
				nonNull: "strict",
				volatility: "immutable"
			},
			like
		)
	}

	/**
	 * The conditional `cond(c, t, f)`, labelled after `like`, built here alone: one of equal arms, where its condition
	 * raises nothing; a boolean one an arm of which is a constant, over a condition never NULL where `facts` hold, the
	 * connective `constantArms` reduces it to, where neither the condition nor the other arm raises; the conditional
	 * otherwise. So a check's refusal of a predicate never NULL, `cond(p, false, true)` (ir/desc.ts refusalCondition), is
	 * `NOT p`, and a split on a subterm whose arm where it fails is false is `subterm AND (the rest where it holds)`: a
	 * selection an equality decides keeps the equality where PostgreSQL reads an index condition, `c = 633 AND (...)`,
	 * never hidden in `CASE WHEN c = 633 THEN ... ELSE false END`. The condition is never NULL, so the connective is the
	 * conditional's value on every row, NULL included; and nothing it reads raises, so AND and OR, whose operands
	 * PostgreSQL may evaluate in any order, evaluate the other arm as safely as CASE does.
	 */
	#cond(c: ScalarExpr, t: ScalarExpr, f: ScalarExpr, like: ScalarExpr, facts: Facts): ScalarExpr {
		if (t === f && !this.#raisesAt(c)) {
			return t
		}
		if (isBoolean(like) && !this.#raisesAt(c) && this.#nonNullAt(c, facts)) {
			for (const [arm, constant, other] of [
				["holds", t, f],
				["fails", f, t]
			] as const) {
				const value = truthOf(constant)
				if (value !== undefined && !this.#raisesAt(other)) {
					const { negated, connective } = constantArms[arm][value ? "true" : "false"]
					return this.#joined(connective, negated ? this.#negated(c) : c, other, like)
				}
			}
		}
		return this.#built({ kind: "cond", args: [c, t, f], type: like.type, nonNull: "cond" }, like)
	}

	/**
	 * `e` split on `s` (the module's first rewrite), `s` itself rewritten where it is evaluated, each arm rewritten where
	 * its value holds; undefined where `s`'s values are unknown, its carrier has no equality, or two of its values that
	 * `=` holds equal give two arms.
	 */
	#split(e: ScalarExpr, s: ScalarExpr, facts: Facts): ScalarExpr | undefined {
		const subject = this.#rewrite(s, facts)
		if (isBoolean(s)) {
			const holds = this.#rewrite(
				this.#substituted(e, new Map([[s, this.#truth(true, s)]])),
				this.#withTruths(facts, s)
			)
			const fails = this.#rewrite(
				this.#substituted(e, new Map([[s, this.#truth(false, s)]])),
				facts
			)
			return this.#cond(subject, holds, fails, e, facts)
		}
		const values = this.#valuesOf(s)
		if (values === undefined) {
			return undefined
		}
		/** The arm of each class of `=`, by its first value: the chain tests `s = v`, which every value of v's class meets. */
		const classes = new Map<
			EqualityKey,
			{ readonly literal: ScalarExpr; readonly arm: ScalarExpr }
		>()
		for (const v of values) {
			const literal = this.#literal(v, s)
			const arm = this.#rewrite(this.#substituted(e, new Map([[s, literal]])), facts)
			const key = nativeEqualityKey(v)
			const held = classes.get(key)
			if (held === undefined) {
				classes.set(key, { literal, arm })
			} else if (held.arm !== arm) {
				return undefined
			}
		}
		const arms = [...classes.values()]
		const shared = new Map<ScalarExpr, number>()
		for (const a of arms) {
			shared.set(a.arm, (shared.get(a.arm) ?? 0) + 1)
		}
		let otherwise: ScalarExpr | undefined
		let most = 0
		for (const a of arms) {
			const n = shared.get(a.arm) ?? 0
			if (n >= most) {
				most = n
				otherwise = a.arm
			}
		}
		if (otherwise === undefined) {
			return undefined
		}
		let chain = otherwise
		for (const a of arms.toReversed()) {
			if (a.arm === otherwise) {
				continue
			}
			const test = this.#equality(subject, a.literal)
			if (test === undefined) {
				return undefined
			}
			chain = this.#cond(test, a.arm, chain, e, facts)
		}
		return chain
	}

	/**
	 * The one pair of subterms two representatives differ at, if they differ at exactly one: "same" for one
	 * representative, undefined where they differ at more than one pair or have different shapes at a pair that would
	 * make the whole of them the pair.
	 */
	#differing(
		a: ScalarExpr,
		b: ScalarExpr,
		memo: Map<ScalarExpr, Map<ScalarExpr, Differing>>
	): Differing {
		if (a === b) {
			return "same"
		}
		const known = memo.get(a)?.get(b)
		if (known !== undefined) {
			return known
		}
		const found = ((): Differing => {
			if (!this.#interned.sameShape(a, b)) {
				return { a, b }
			}
			let pair: Differing = "same"
			for (const [i, x] of a.args.entries()) {
				const y = b.args[i]
				if (y === undefined) {
					return "conflict"
				}
				const at = this.#differing(x, y, memo)
				if (at === "conflict") {
					return "conflict"
				}
				if (at === "same") {
					continue
				}
				if (pair === "same") {
					pair = at
				} else if (pair.a !== at.a || pair.b !== at.b) {
					return "conflict"
				}
			}
			return pair
		})()
		const row = memo.getOrInsertComputed(a, () => new Map<ScalarExpr, Differing>())
		row.set(b, found)
		return found
	}

	/** `a` and `b` generalized at their one differing pair `pair`, `hole` in its place (#differing). */
	#generalized(
		a: ScalarExpr,
		b: ScalarExpr,
		pair: { readonly a: ScalarExpr; readonly b: ScalarExpr },
		hole: ScalarExpr
	): ScalarExpr {
		if (a === pair.a && b === pair.b) {
			return hole
		}
		if (a === b) {
			return a
		}
		return this.#over(
			a,
			a.args.map((x, i) => {
				const y = b.args[i]
				return y === undefined ? x : this.#generalized(x, y, pair, hole)
			})
		)
	}

	/**
	 * Whether `other` may be `whole` with its subterm `x` replaced by a literal and folded (#substituted), at some
	 * literal: false only where none makes it, so the factoring that would try each of `x`'s values tries none. It reads
	 * the shapes the fold can build, never a value. The fold keeps each subterm that does not read `x`, makes `x` the
	 * literal, and makes each subterm that reads `x` a literal (a constant evaluated, a connective decided), the fold of
	 * one of its arguments (a conditional decided or of equal arms, a connective's one operand left), or the subterm over
	 * its arguments' folds, its own fields but its volatility kept (#simplified, #over). A literal is made only where
	 * every argument of an operation, or some argument of a conditional or a connective, may fold to one.
	 */
	#foldsTo(whole: ScalarExpr, x: ScalarExpr, other: ScalarExpr): boolean {
		const reading = new Map<ScalarExpr, boolean>()
		const reads = (n: ScalarExpr): boolean => {
			if (n === x) {
				return true
			}
			const known = reading.get(n)
			if (known !== undefined) {
				return known
			}
			const read = n.args.some(reads)
			reading.set(n, read)
			return read
		}
		const literal = new Map<ScalarExpr, boolean>()
		/** Whether the fold of `n` may be a literal. */
		const toLiteral = (n: ScalarExpr): boolean => {
			if (n === x) {
				return true
			}
			if (!reads(n)) {
				return n.kind === "literal"
			}
			const known = literal.get(n)
			if (known !== undefined) {
				return known
			}
			const may =
				n.kind === "cond"
					? toLiteral(n.args[1]) || toLiteral(n.args[2])
					: connectiveOf(n) !== undefined
						? n.args.some(toLiteral)
						: n.args.every(toLiteral)
			literal.set(n, may)
			return may
		}
		const made = new Map<ScalarExpr, Map<ScalarExpr, boolean>>()
		/** Whether the fold of `n` may be `o`. */
		const folds = (n: ScalarExpr, o: ScalarExpr): boolean => {
			if (n === x) {
				return o.kind === "literal"
			}
			if (!reads(n)) {
				return n === o
			}
			const row = made.getOrInsertComputed(n, () => new Map<ScalarExpr, boolean>())
			const known = row.get(o)
			if (known !== undefined) {
				return known
			}
			const rebuilt =
				this.#interned.sameFields(n, o) &&
				n.args.every((a, i) => {
					const b = o.args[i]
					return b !== undefined && folds(a, b)
				})
			const may =
				rebuilt ||
				(n.kind === "cond"
					? folds(n.args[1], o) || folds(n.args[2], o)
					: connectiveOf(n) !== undefined
						? (o.kind === "literal" && n.args.some(toLiteral)) || n.args.some((a) => folds(a, o))
						: o.kind === "literal" && n.args.every(toLiteral))
			row.set(o, may)
			return may
		}
		return folds(whole, other)
	}

	/**
	 * The arms of a conditional factored (the module's second rewrite): `cond(c, C[a], C[b])` as `C[cond(c, a, b)]`,
	 * where the arms differ at one pair, or where one arm is the other at one of the values of a subterm of it; the
	 * conditional itself where neither holds, or where it may raise. A subterm's values are tried only where the other
	 * arm may be the arm at some literal at all (#foldsTo).
	 */
	#factored(e: ScalarExpr, facts: Facts): ScalarExpr {
		if (e.kind !== "cond" || this.#raisesAt(e)) {
			return e
		}
		const [c, t, f] = e.args
		const pair = this.#differing(t, f, new Map())
		const candidates: Array<() => ScalarExpr> = []
		if (pair !== "same" && pair !== "conflict" && !(pair.a === t && pair.b === f)) {
			candidates.push(() => {
				const hole = this.#factored(this.#cond(c, pair.a, pair.b, pair.a, facts), facts)
				return this.#generalized(t, f, pair, hole)
			})
		}
		for (const [whole, other, holdsFirst] of [
			[t, f, true],
			[f, t, false]
		] as const) {
			for (const x of this.#occurrences(whole).keys()) {
				const values = x === whole || x.kind === "literal" ? undefined : this.#valuesOf(x)
				if (values === undefined || !this.#foldsTo(whole, x, other)) {
					continue
				}
				for (const v of values) {
					const k = this.#literal(v, x)
					if (this.#substituted(whole, new Map([[x, k]])) !== other) {
						continue
					}
					candidates.push(() => {
						const hole = this.#factored(
							holdsFirst ? this.#cond(c, x, k, x, facts) : this.#cond(c, k, x, x, facts),
							facts
						)
						return this.#substituted(whole, new Map([[x, hole]]))
					})
				}
			}
		}
		const size = candidates.length === 0 ? undefined : this.#scope.size(e)
		if (size === undefined) {
			return e
		}
		for (const candidate of candidates) {
			const made = candidate()
			if (fits(this.#scope.size(made), size)) {
				return made
			}
		}
		return e
	}

	/**
	 * `e`'s arguments rewritten, each where the facts of its place hold, and the result factored. A chain of equalities
	 * (equalityChain) is rewritten as one: its subject once, each WHEN's result and its ELSE, its links kept, since
	 * factoring a link apart would print its subject again.
	 */
	#rewrittenArgs(e: ScalarExpr, facts: Facts): ScalarExpr {
		const chain = equalityChain(e)
		if (chain !== undefined) {
			const subject = this.#rewrite(chain.subject, facts)
			let rebuilt = this.#rewrite(chain.otherwise, facts)
			for (const w of chain.whens.toReversed()) {
				const test = this.#over(w.condition, [subject, w.value])
				rebuilt = this.#cond(
					test,
					this.#rewrite(w.result, this.#withTruths(facts, w.condition)),
					rebuilt,
					e,
					facts
				)
			}
			return rebuilt
		}
		if (e.kind === "cond") {
			const [c, t, f] = e.args
			const condition = this.#rewrite(c, facts)
			return this.#factored(
				this.#cond(
					condition,
					this.#rewrite(t, this.#withTruths(facts, c)),
					this.#rewrite(f, facts),
					e,
					facts
				),
				facts
			)
		}
		if (connectiveOf(e) === "and") {
			let holding = facts
			const args: Array<ScalarExpr> = []
			for (const a of e.args) {
				args.push(this.#rewrite(a, holding))
				holding = this.#withTruths(holding, a)
			}
			return this.#over(e, args)
		}
		return this.#over(
			e,
			e.args.map((a) => this.#rewrite(a, facts))
		)
	}

	/**
	 * `e` rewritten where `facts` hold: split on its first subterm a split may take (#split), by the most occurrences,
	 * then the largest, then the first met, whose split does not make the text longer than `e`'s with its arguments
	 * rewritten and holds no subterm PostgreSQL raises at as it plans where that does not (#raisesAsPlanned); and that
	 * otherwise. A subterm that is the subject of a chain `e` already is never split again.
	 */
	#rewrite(e: ScalarExpr, facts: Facts): ScalarExpr {
		const memo = this.#rewritten.getOrInsertComputed(facts, () => new Map())
		const known = memo.get(e)
		if (known !== undefined) {
			return known
		}
		const occurrences = this.#splits ? this.#occurrences(e) : new Map<ScalarExpr, number>()
		const subject = chainSubject(e)
		const candidates = [...occurrences.keys()]
			.filter(
				(s) =>
					s !== e &&
					s !== subject &&
					s.kind !== "literal" &&
					(occurrences.get(s) ?? 0) > 1 &&
					!this.#raisesAt(s) &&
					this.#nonNullAt(s, facts) &&
					(isBoolean(s) || this.#valuesOf(s) !== undefined) &&
					this.#anticipates(e, s)
			)
			.map((s) => ({ s, n: occurrences.get(s) ?? 0, size: this.#occurrences(s).size }))
			.toSorted(
				(a, b) =>
					b.n - a.n || b.size - a.size || this.#interned.number(a.s) - this.#interned.number(b.s)
			)
		const unsplit = this.#rewrittenArgs(e, facts)
		const limit = candidates.length === 0 ? undefined : this.#scope.size(unsplit)
		let chosen = unsplit
		if (limit !== undefined) {
			for (const { s } of candidates) {
				const split = this.#split(e, s, facts)
				if (
					split !== undefined &&
					fits(this.#scope.size(split), limit) &&
					(!this.#raisesAsPlanned(split) || this.#raisesAsPlanned(unsplit))
				) {
					chosen = split
					break
				}
			}
		}
		memo.set(e, chosen)
		return chosen
	}
}

/** Whether a rewrite's text, of `size` where the site prints it, is no longer than the `limit` it replaces. */
const fits = (size: number | undefined, limit: number): boolean =>
	size !== undefined && size <= limit

/** What #differing finds of two representatives. */
type Differing = "same" | "conflict" | { readonly a: ScalarExpr; readonly b: ScalarExpr }

/**
 * The subject of the chain `e` is, if it is one: the expression every condition of a conditional chain of at least two
 * equalities compares to a literal, the chain lowerScalar prints as a simple CASE over it (equalityChain).
 */
const chainSubject = (e: ScalarExpr): ScalarExpr | undefined => equalityChain(e)?.subject

/**
 * A conditional chain of equalities of one subject to literals, `cond(s = v1, a1, cond(s = v2, a2, … otherwise))`, of
 * at least two, as lowerScalar prints it, `CASE s WHEN v1 THEN a1 WHEN v2 THEN a2 … ELSE otherwise END`, `s` evaluated
 * once; undefined for any other expression.
 */
export const equalityChain = (
	e: ScalarExpr
):
	| {
			readonly subject: ScalarExpr
			readonly whens: ReadonlyArray<{
				readonly condition: ScalarExpr
				readonly value: ScalarExpr
				readonly result: ScalarExpr
			}>
			readonly otherwise: ScalarExpr
	  }
	| undefined => {
	const whens: Array<{
		readonly condition: ScalarExpr
		readonly value: ScalarExpr
		readonly result: ScalarExpr
	}> = []
	let subject: ScalarExpr | undefined
	let at = e
	for (;;) {
		if (at.kind !== "cond") {
			break
		}
		const [test, result, otherwise] = at.args
		const compared = equalityOperands(test)
		if (compared === undefined || (subject !== undefined && compared.subject !== subject)) {
			break
		}
		subject = compared.subject
		whens.push({ condition: test, value: compared.value, result })
		at = otherwise
	}
	return subject === undefined || whens.length < 2 ? undefined : { subject, whens, otherwise: at }
}

/** The subject and literal of an equality `s = v` of a non-literal to a literal, or undefined for another expression. */
const equalityOperands = (
	test: ScalarExpr
): { readonly subject: ScalarExpr; readonly value: ScalarExpr } | undefined => {
	if (test.kind !== "op" || test.args.length !== 2) {
		return undefined
	}
	const [s, v] = test.args
	if (s === undefined || v === undefined || s.kind === "literal" || v.kind !== "literal") {
		return undefined
	}
	const carrier = baseOf(s.type).carrier
	const eq = overloadOf("eq", [carrier, carrier])
	return eq !== undefined && definedIdOf(eq) === test.op ? { subject: s, value: v } : undefined
}

/**
 * `expr` with its shared subterms evaluated once on every path (the module's rewrites), where that does not lengthen
 * its SQL at the site `scope` measures: the expression every site lowers (lowerScalar), a query's and a persistent
 * one's alike.
 */
export const sharedExpr = (expr: ScalarExpr, scope: ShareScope): ScalarExpr =>
	new Sharing(scope).run(expr)
