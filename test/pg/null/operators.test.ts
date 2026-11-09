import { layer } from "@effect/vitest"
import { type Case, exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element, type Gen, int } from "@grizzle/testing/gen"
import { agree, exact } from "@grizzle/testing/oracle"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { ExprId, NodeId } from "#compiler/core/ids.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { compareOps } from "#compiler/ir/desc.ts"
import { builtExpr, predicateTable } from "#compiler/ir/expr.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { compileLaws } from "#compiler/laws/model/model.ts"
import { accumulated, Decimal, drawn, natural, pg } from "#compiler/public/fields.ts"
import {
	contained,
	fin,
	fold,
	key,
	Monoid,
	mutable,
	on,
	ordered,
	schema
} from "#compiler/public/schema.ts"
import { computeCore as C } from "#compiler/scalar/compute/builders.ts"
import { evaluateTable, sqlNull } from "#compiler/scalar/compute/evaluate.ts"
import { type NativeOp, nativeOps } from "#compiler/scalar/compute/registry.ts"
import { ProgramPatterns, tablePatterns } from "#compiler/scalar/regex/patterns.ts"
import { everySlice } from "#compiler/schema/reach.ts"
import { generatedField, generatedRelation } from "#compiler/schema/relation.ts"
import { checkBuilder, selectBuilder } from "#compiler/schema/statements.ts"
import { type ClosedRows, closedLeaf } from "#compiler/write/family/fold.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { testArtifacts, testCompile } from "#test/support/compile.ts"
import { caseHang } from "#test/support/limits.ts"
import {
	buildPred,
	buildTerm,
	closedOf,
	decimalOf,
	foldRelations,
	fromHost,
	itemFields,
	itemRelation,
	type Row
} from "#test/support/null/build.ts"
import {
	type CompareOp,
	type Decision,
	evalPred,
	evalTerm,
	type Family,
	type Item,
	type KindKey,
	type ListSort,
	type Pred,
	type PickField,
	parseAnswer,
	parseTruth,
	type Sort,
	sortOf,
	type Term,
	type Trace,
	type Truth,
	answerSql,
	truthSql,
	type Val,
	type World,
	worldSql
} from "#test/support/null/language.ts"
import { checking, owning } from "#test/support/policy.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"
import { upTo } from "#test/support/up-to.ts"

/**
 * Every operation of grizzle's scalar language over operands that are each NULL or one of two values, on PostgreSQL
 * 19rc1: grizzle's host evaluator (scalar/compute/evaluate.ts) agrees with PostgreSQL, NULL included, and so does the
 * model of language.ts.
 *
 * The box, exhausted: each operation the host evaluates in a check (each comparison over each sort, BETWEEN, IN, AND,
 * OR, NOT, arithmetic, greatest, a guarded division and remainder, concatenation and a text's prefix and suffix tests,
 * a set's algebra and tests, and a conditional), with each operand slot a closed read of Pick at k0, at k1 or at k2,
 * which Pick holds no row at: the first value, the second, or NULL. A slot of a set reads Next at the flag Pick holds,
 * a bigint casts the integer, an exact integer adds zero to it, and a truth compares the boolean with true. Each case's
 * expression stands in a row check, whose installed predicate the law model holds; the host evaluates it, and for a
 * term its first operand, over the closed rows the host's fill reads, and PostgreSQL evaluates the expression written
 * in plain SQL from its meaning alone.
 *
 * The roundings (round, trunc, ceil and floor) are a query's alone: each case of one holds that every place the host
 * evaluates an expression refuses it at compile (a row check, a generated field, a containment's and a key's
 * selection, a fold's selection and a fold stepping a generated field), and that the host's evaluator, over the
 * registry's node of it, claims no value but NULL's, where PostgreSQL's is NULL too.
 */

/** The world every case reads: Pick holds k0 and k1, two payloads apart in every field, and no row at k2. */
const world: World = {
	kinds: 3,
	flags: 2,
	pick: [
		{ flag: 0, n: 0, d: -5, t: "a", b: true, x: 0.5, y: 1.5 },
		{ flag: 1, n: 2, d: 15, t: "ab", b: false, x: Number.NaN, y: Number.POSITIVE_INFINITY },
		undefined
	],
	weight: [undefined, undefined],
	succ: [undefined, undefined],
	next: [[1], [0, 1]],
	allowed: [[], [], []]
}

/** The one row the cases are evaluated at: no case reads it. */
const row: Item = {
	kind: 0,
	flag: 0,
	flags: [],
	n: 0,
	m: 0,
	d: 0,
	t: "",
	b: false,
	x: 0,
	y: 0,
	s: [0, 1]
}

/** An operand slot: the first value, the second, or NULL. */
type Slot = 0 | 1 | 2

const slotGen: Gen<Slot> = (s) => {
	const slot = s.draw(int(0, 2))
	return slot === 0 ? 0 : slot === 1 ? 1 : 2
}

const keyOf = (slot: Slot): KindKey => ({ k: "handle", code: slot })

/** A term of a sort that reads the slot's value. */
const slotTerm = (sort: Sort, slot: Slot): Term => {
	const at = (field: PickField): Term => ({ t: "at", field, key: keyOf(slot) })
	switch (sort) {
		case "int":
			return at("n")
		case "num":
			return at("d")
		case "text":
			return at("t")
		case "code":
			return at("flag")
		case "bool":
			return at("b")
		case "set":
			return { t: "row", flag: at("flag") }
		case "big":
			return { t: "widen", e: at("n") }
		case "exact":
			return {
				t: "arith",
				op: "add",
				a: at("n"),
				b: { t: "lit", literal: { sort: "int", value: 0 } }
			}
		case "f8":
			return at("x")
		case "f4":
			return at("y")
	}
}

/** A predicate that is true, false or unknown by the slot: Pick's boolean compared with true. */
const slotTruth = (slot: Slot): Pred => ({
	p: "cmp",
	op: "eq",
	a: slotTerm("bool", slot),
	b: { t: "lit", literal: { sort: "bool", value: true } }
})

/** An operation of the box: what it builds of its operand slots. */
type Operation =
	| { readonly form: "compare"; readonly op: CompareOp; readonly sort: Sort }
	| { readonly form: "between"; readonly sort: Sort }
	| { readonly form: "in"; readonly sort: ListSort }
	| { readonly form: "connective"; readonly op: "and" | "or" }
	| { readonly form: "not" }
	| { readonly form: "arith"; readonly op: "add" | "sub" | "mul"; readonly sort: "int" | "num" }
	| { readonly form: "greatest"; readonly sort: Sort }
	| { readonly form: "divide"; readonly op: "div" | "mod" }
	| { readonly form: "concat" }
	| { readonly form: "affix"; readonly op: "startsWith" | "endsWith" }
	| { readonly form: "setop"; readonly op: "union" | "intersection" | "difference" }
	| { readonly form: "settest"; readonly op: "subset" | "disjoint" }
	| { readonly form: "cond" }
	| { readonly form: "unary"; readonly op: "neg" | "abs" | "sign"; readonly sort: Sort }
	| { readonly form: "tofloat"; readonly sort: "int" | "f4" }
	| { readonly form: "singleton" }
	| { readonly form: "rounding"; readonly op: Rounding; readonly scaled: boolean }

/**
 * The roundings, which no check, contract or generated field admits, so the host evaluates them nowhere: a case of
 * one holds that a check refuses it and that the host claims no value for it, NULL's alone.
 */
type Rounding = "round" | "trunc" | "ceil" | "floor"

/** The sorts each comparison reads, a set's by its equality alone. */
const sorts: NonEmptyReadonlyArray<Sort> = [
	"int",
	"exact",
	"big",
	"num",
	"text",
	"code",
	"set",
	"bool",
	"f8",
	"f4"
]
const orderedSorts: NonEmptyReadonlyArray<Sort> = [
	"int",
	"exact",
	"big",
	"num",
	"text",
	"code",
	"bool",
	"f8",
	"f4"
]
const listed: NonEmptyReadonlyArray<ListSort> = [
	"int",
	"exact",
	"big",
	"num",
	"text",
	"code",
	"f8",
	"f4"
]

/** The operations of the box, each the host evaluator branches on. */
const operations: NonEmptyReadonlyArray<Operation> = [
	{ form: "not" },
	{ form: "concat" },
	{ form: "cond" },
	{ form: "singleton" },
	...Arr.flatMap(compareOps, (op): ReadonlyArray<Operation> =>
		Arr.map(
			Arr.filter(sorts, (sort) => sort !== "set" || op === "eq" || op === "ne"),
			(sort) => ({ form: "compare", op, sort })
		)
	),
	...Arr.map(orderedSorts, (sort): Operation => ({ form: "between", sort })),
	...Arr.map(listed, (sort): Operation => ({ form: "in", sort })),
	...Arr.map(["and", "or"] as const, (op): Operation => ({ form: "connective", op })),
	...Arr.map(["add", "sub", "mul"] as const, (op): Operation => ({
		form: "arith",
		op,
		sort: "int"
	})),
	...Arr.map(["add", "sub"] as const, (op): Operation => ({ form: "arith", op, sort: "num" })),
	...Arr.map(["int", "num", "text", "code", "bool", "f8", "f4"] as const, (sort): Operation => ({
		form: "greatest",
		sort
	})),
	...Arr.flatMap(["int", "num", "f8", "f4"] as const, (sort): ReadonlyArray<Operation> =>
		Arr.map(
			sort === "f4" ? (["neg", "abs"] as const) : (["neg", "abs", "sign"] as const),
			(op) => ({
				form: "unary",
				op,
				sort
			})
		)
	),
	...Arr.map(["int", "f4"] as const, (sort): Operation => ({ form: "tofloat", sort })),
	...Arr.flatMap(["round", "trunc", "ceil", "floor"] as const, (op): ReadonlyArray<Operation> =>
		op === "round" || op === "trunc"
			? [
					{ form: "rounding", op, scaled: false },
					{ form: "rounding", op, scaled: true }
				]
			: [{ form: "rounding", op, scaled: false }]
	),
	...Arr.map(["div", "mod"] as const, (op): Operation => ({ form: "divide", op })),
	...Arr.map(["startsWith", "endsWith"] as const, (op): Operation => ({ form: "affix", op })),
	...Arr.map(["union", "intersection", "difference"] as const, (op): Operation => ({
		form: "setop",
		op
	})),
	...Arr.map(["subset", "disjoint"] as const, (op): Operation => ({ form: "settest", op }))
]

/** How many operand slots an operation reads. */
const arityOf = (operation: Operation): 1 | 2 | 3 => {
	switch (operation.form) {
		case "not":
		case "in":
		case "unary":
		case "tofloat":
		case "rounding":
		case "singleton":
			return 1
		case "between":
		case "cond":
			return 3
		case "compare":
		case "connective":
		case "arith":
		case "greatest":
		case "divide":
		case "concat":
		case "affix":
		case "setop":
		case "settest":
			return 2
	}
}

/** A case of the box: an operation and its operand slots. */
interface OperatorCase {
	readonly operation: Operation
	readonly slots: ReadonlyArray<Slot>
}

const caseGen: Gen<OperatorCase> = (s) => {
	const operation = s.draw(element(operations))
	return { operation, slots: upTo(arityOf(operation), () => s.draw(slotGen)) }
}

/** What a case evaluates: a predicate, a term, which a check orders against a literal, or a rounding of a slot. */
type Expression =
	| { readonly kind: "pred"; readonly pred: Pred }
	| { readonly kind: "term"; readonly term: Term }
	| {
			readonly kind: "rounding"
			readonly op: Rounding
			readonly scaled: boolean
			readonly slot: Slot
	  }

/** A case's expression over its slots. */
const expressionOf = ({ operation, slots }: OperatorCase): Expression => {
	const [a = 2, b = 2, c = 2] = slots
	const pred = (p: Pred): Expression => ({ kind: "pred", pred: p })
	const term = (t: Term): Expression => ({ kind: "term", term: t })
	switch (operation.form) {
		case "compare":
			return pred({
				p: "cmp",
				op: operation.op,
				a: slotTerm(operation.sort, a),
				b: slotTerm(operation.sort, b)
			})
		case "between":
			return pred({
				p: "between",
				a: slotTerm(operation.sort, a),
				lo: slotTerm(operation.sort, b),
				hi: slotTerm(operation.sort, c)
			})
		case "in":
			return pred({ p: "in", a: slotTerm(operation.sort, a), values: [firstValue(operation.sort)] })
		case "connective":
			return pred({ p: operation.op, args: [slotTruth(a), slotTruth(b)] })
		case "not":
			return pred({ p: "not", arg: slotTruth(a) })
		case "arith":
			return term({
				t: "arith",
				op: operation.op,
				a: slotTerm(operation.sort, a),
				b: slotTerm(operation.sort, b)
			})
		case "greatest":
			return term({
				t: "extremum",
				op: "greatest",
				a: slotTerm(operation.sort, a),
				b: slotTerm(operation.sort, b)
			})
		case "divide":
			return term({
				t: "divide",
				op: operation.op,
				a: slotTerm("int", a),
				d: slotTerm("int", b),
				o:
					operation.op === "div"
						? { t: "unary", op: "abs", a: { t: "lit", literal: { sort: "int", value: 3 } } }
						: { t: "lit", literal: { sort: "int", value: 3 } }
			})
		case "concat":
			return term({ t: "concat", a: slotTerm("text", a), b: slotTerm("text", b) })
		case "affix":
			return term({ t: "affix", op: operation.op, a: slotTerm("text", a), b: slotTerm("text", b) })
		case "setop":
			return term({ t: "setop", op: operation.op, a: slotTerm("set", a), b: slotTerm("set", b) })
		case "settest":
			return term({ t: "settest", op: operation.op, a: slotTerm("set", a), b: slotTerm("set", b) })
		case "cond":
			return term({ t: "cond", p: slotTruth(a), a: slotTerm("int", b), b: slotTerm("int", c) })
		case "unary":
			return term({ t: "unary", op: operation.op, a: slotTerm(operation.sort, a) })
		case "tofloat":
			return term({ t: "tofloat", e: slotTerm(operation.sort, a) })
		case "singleton":
			return term({ t: "singleton", a: slotTerm("code", a) })
		case "rounding":
			return { kind: "rounding", op: operation.op, scaled: operation.scaled, slot: a }
	}
}

/** The first payload's value of a list sort, as an IN list holds it. */
const firstValue = (sort: ListSort) => {
	switch (sort) {
		case "int":
		case "exact":
		case "big":
			return { sort, value: 0 } as const
		case "num":
			return { sort, tenths: -5 } as const
		case "text":
			return { sort, value: "a" } as const
		case "code":
			return { sort, code: 0 } as const
		case "f8":
			return { sort, value: 0.5 } as const
		case "f4":
			return { sort, value: 1.5 } as const
	}
}

/** A literal a term of a sort meets. */
const literalOf = (sort: Sort): Term => {
	switch (sort) {
		case "int":
		case "exact":
			return { t: "lit", literal: { sort: "int", value: 1 } }
		case "big":
			return { t: "lit", literal: { sort: "big", value: 1 } }
		case "num":
			return { t: "lit", literal: { sort: "num", tenths: 5 } }
		case "text":
			return { t: "lit", literal: { sort: "text", value: "b" } }
		case "code":
			return { t: "lit", literal: { sort: "code", code: 1 } }
		case "set":
			return { t: "lit", literal: { sort: "set", codes: [0] } }
		case "bool":
			return { t: "lit", literal: { sort: "bool", value: true } }
		case "f8":
		case "f4":
			return { t: "lit", literal: { sort, value: 0.5 } }
	}
}

/**
 * The predicate a case's check states: the expression, or a term ordered against a literal, its first operand, which
 * a set compares by equality. An equality over a concatenation is decided by its lengths, a prefix and a suffix, so
 * the term stands opposite the literal only under an order.
 */
const checkedPred = (e: Extract<Expression, { readonly kind: "pred" | "term" }>): Pred => {
	if (e.kind === "pred") {
		return e.pred
	}
	const sort = sortOf(e.term)
	return { p: "cmp", op: sort === "set" ? "eq" : "le", a: e.term, b: literalOf(sort) }
}

type Feature =
	| Family
	| Decision
	| "a NULL operand"
	| "no NULL operand"
	| `a ${RoundingPosition} refuses a rounding`
	| "the host declines a rounding"
	| "a rounding of NULL is NULL"

/** A trace noting each family and decision a case reaches. */
const tracing = (c: Case<Feature>): Trace => ({
	reached: (family) => c.note(family),
	source: () => c.note("a NULL operand"),
	decided: (decision) => c.note(decision)
})

const closedRows = (model: ReturnType<typeof modelOf>) =>
	closedLeaf(
		new Map(
			Arr.map([...model.checked.closed], ([name, c]): readonly [string, ClosedRows] => [
				name,
				{ heading: c.heading, key: c.relation.primaryFields.length, rows: c.rows }
			])
		)
	)

const closed = closedOf(world)
const Probe = itemRelation(closed, "Probe")

const modelOf = (pred: Pred) => {
	const owned = owning(
		schema("Operators", { ...closed, Probe }, [
			checkBuilder("Holds", Probe, (r: Readonly<Record<string, unknown>>) =>
				buildPred(closed, r, pred)
			)
		] as const)
	)
	return succeeded(
		compileLaws(owned, everySlice(owned), { kind: "planned" }),
		"a case's check compiles"
	)
}

/** The field types of Probe's row, as the checked schema resolves them: the numeric a rounding reads, its scale's. */
const probeField = (name: "d" | "n"): ScalarType => {
	const info = checking(schema("Types", { ...closed, Probe }, [] as const)).relations.get("Probe")
	const found = Arr.findFirst(info?.fields ?? [], (f) => f.name === name)
	return Option.isSome(found) ? found.value.type : assert.fail(`Probe holds ${name}`)
}
const numericType = probeField("d")
const scaleType = probeField("n")

/** The registry's overload of a rounding, over a numeric and, scaled, an integer scale. */
const roundingOp = (op: Rounding, scaled: boolean): NativeOp => {
	const found = Arr.findFirst(
		nativeOps,
		(native) =>
			native.fn === op &&
			native.operands.kind === "positional" &&
			native.operands.carriers.length === (scaled ? 2 : 1) &&
			native.operands.carriers[0] === "numeric"
	)
	return Option.isSome(found) ? found.value : assert.fail(`the registry holds ${op} over numeric`)
}

/** The places the host evaluates an expression in, each its own schema holding a predicate over the term there. */
const roundingPositions = [
	"check",
	"generated field",
	"containment",
	"key",
	"fold",
	"fold step"
] as const
type RoundingPosition = (typeof roundingPositions)[number]

/**
 * A schema per place the host evaluates an expression, each over `term` compared with a numeric: a row check, a
 * generated field (its integer the comparison's CASE), a containment's and a key's selection, a fold's selection, and
 * a fold stepping a generated field of its member.
 */
const roundingSchemas = (
	term: (r: Row) => unknown
): ReadonlyArray<readonly [RoundingPosition, unknown]> => {
	const pred = (r: Row): unknown => C.le(term(r), C.literal(pg.numeric(3, 1), Decimal.of("0.5")))
	const asInteger = (r: Row): unknown =>
		C.cond(pred(r), C.literal(pg.integer, 1), C.literal(pg.integer, 0))
	const { Owner, Member } = foldRelations(closed)
	const members = ordered(on(Member, "owner", "at"), fin(Owner, "members"))
	const Stepped = generatedRelation(
		"Member",
		{
			...itemFields(closed),
			owner: pg.integer,
			at: drawn(natural),
			before: accumulated(pg.integer, 0),
			after: accumulated(pg.integer, 0)
		},
		["id"],
		(r) => ({ g: generatedField(pg.integer, asInteger(r), []) }),
		[]
	)
	const stepped = ordered(on(Stepped, "owner", "at"), fin(Owner, "members"))
	const Generated = generatedRelation(
		"Generated",
		itemFields(closed),
		["id"],
		(r) => ({ g: generatedField(pg.integer, asInteger(r), []) }),
		[]
	)
	return [
		[
			"check",
			schema("Rounding", { ...closed, Probe }, [checkBuilder("Holds", Probe, pred)] as const)
		],
		["generated field", schema("Rounding", { ...closed, Generated }, [] as const)],
		[
			"containment",
			schema("Rounding", { ...closed, Probe }, [
				contained(
					on(selectBuilder(Probe, pred), "kind", "flag"),
					on(closed.Allowed, "kind", "flag")
				)
			] as const)
		],
		[
			"key",
			schema("Rounding", { ...closed, Probe }, [key(on(selectBuilder(Probe, pred), "n"))] as const)
		],
		[
			"fold",
			schema("Rounding", { ...closed, Owner, Member }, [
				members,
				fold(
					members,
					Monoid.sum,
					on(selectBuilder(Member, pred), "owner", "n", "before", "after"),
					on(Owner, "id", "total")
				),
				mutable(Owner)
			] as const)
		],
		[
			"fold step",
			schema("Rounding", { ...closed, Owner, Member: Stepped }, [
				stepped,
				fold(
					stepped,
					Monoid.sum,
					on(Stepped, "owner", "g", "before", "after"),
					on(Owner, "id", "total")
				),
				mutable(Owner)
			] as const)
		]
	]
}

/** A rounding's value in plain SQL, over Pick's numeric at the slot's kind: NULL at k2. */
const roundingSql = (op: Rounding, scaled: boolean, slot: Slot): string =>
	`((${op}((SELECT p.d FROM pick p WHERE p.kind = ${slot})${scaled ? ", 1" : ""}) * 10)::bigint)::text`

/**
 * A rounding of a slot: a check that states it is refused where the host would evaluate it, as UnsupportedOperation;
 * and the host's evaluator, over the registry's node of it at a column holding the slot's value, claims no value for
 * it but NULL's, PostgreSQL's NULL of a NULL operand.
 */
const roundingCase = (
	owner: RawSession,
	e: Extract<Expression, { readonly kind: "rounding" }>,
	c: Case<Feature>
) =>
	Effect.gen(function* () {
		const read: Term = { t: "at", field: "d", key: keyOf(e.slot) }
		const rounded = (r: Row): unknown =>
			e.scaled
				? C[e.op === "round" ? "round" : "trunc"](buildTerm(closed, r, read), 1)
				: C[e.op](buildTerm(closed, r, read))
		for (const [position, held] of roundingSchemas(rounded)) {
			const compiled = testArtifacts(held, testCompile)
			if (compiled.ok) {
				return assert.fail(
					`a ${position} over ${e.op} compiles, though the host evaluates no rounding`
				)
			}
			assert.equal(
				compiled.error.reason._tag,
				"UnsupportedOperation",
				`a ${position} over ${e.op} is refused, as the host evaluates no rounding`
			)
			c.note(`a ${position} refuses a rounding`)
		}
		const rounding = roundingOp(e.op, e.scaled)
		if (rounding.partial) {
			return assert.fail(`${e.op} is total`)
		}
		const column = builtExpr(
			{
				kind: "column",
				column: { node: NodeId("probe"), name: "d" },
				type: numericType,
				args: [],
				nonNull: "storage"
			},
			ExprId("d")
		)
		const scale = builtExpr(
			{
				kind: "literal",
				value: { kind: "int", value: 1n },
				type: scaleType,
				args: [],
				nonNull: "literal"
			},
			ExprId("scale")
		)
		const node = builtExpr(
			{
				kind: "op",
				op: rounding.id,
				args: e.scaled ? [column, scale] : [column],
				type: numericType,
				nonNull: "strict",
				volatility: "immutable"
			},
			ExprId("rounded")
		)
		const payload = world.pick[e.slot]
		const table = predicateTable(node)
		const host = evaluateTable(
			table.exprs,
			table.root,
			{
				value: undefined,
				column: (ref) =>
					ref.name !== "d" ? undefined : payload === undefined ? sqlNull : decimalOf(payload.d),
				closed: () => undefined
			},
			ProgramPatterns.of(tablePatterns(table))
		)
		const rows = yield* owner.values(
			worldSql(world, [[0, row]], [roundingSql(e.op, e.scaled, e.slot)]),
			[]
		)
		const postgres = parseAnswer("num", rows[0]?.[1])
		const hostAnswer: Val | string | null = host.ok
			? fromHost("num", host.value)
			: host.error.kind === "unsupported"
				? "declined"
				: `no value: ${Formatter.format(host.error)}`
		c.note(postgres === null ? "a rounding of NULL is NULL" : "the host declines a rounding")
		yield* agree<Val | string | null>(
			[
				[
					`the host's contract for ${Formatter.format(e)}: PostgreSQL's NULL, and no other value`,
					postgres === null ? null : "declined"
				],
				["grizzle's host evaluator", hostAnswer]
			],
			exact
		)
	})

const operatorCase = (owner: RawSession, oc: OperatorCase, c: Case<Feature>) =>
	Effect.gen(function* () {
		const e = expressionOf(oc)
		if (e.kind === "rounding") {
			return yield* roundingCase(owner, e, c)
		}
		const pred = checkedPred(e)
		const model = modelOf(pred)
		const check = Arr.findFirst(model.natives, (n) => n.object.kind === "TableCheck")
		if (check._tag === "None" || check.value.object.kind !== "TableCheck") {
			return assert.fail("the law model installs the case's check")
		}
		const table = predicateTable(check.value.object.predicate)
		const rootNode = table.exprs[table.root]
		const evaluated = e.kind === "pred" ? table.root : rootNode?.args[0]
		if (evaluated === undefined) {
			return assert.fail("the check compares the case's term")
		}
		const host = evaluateTable(
			table.exprs,
			evaluated,
			{ value: undefined, column: () => undefined, closed: closedRows(model) },
			ProgramPatterns.of(tablePatterns(table))
		)
		const sort: Sort = e.kind === "pred" ? "bool" : sortOf(e.term)
		const read = yield* owner.values(
			worldSql(
				world,
				[[0, row]],
				[e.kind === "pred" ? truthSql(world, e.pred) : answerSql(world, e.term)]
			),
			[]
		)
		const text = read[0]?.[1]
		const postgres: Val | Truth = e.kind === "pred" ? parseTruth(text) : parseAnswer(sort, text)
		const trace = tracing(c)
		const modelled =
			e.kind === "pred" ? evalPred(world, row, e.pred, trace) : evalTerm(world, row, e.term, trace)
		if (!oc.slots.includes(2)) {
			c.note("no NULL operand")
		}
		yield* agree<Val | Truth | string>(
			[
				[`PostgreSQL's ${Formatter.format(oc)}`, postgres],
				["the model of language.ts", modelled],
				[
					"grizzle's host evaluator",
					host.ok ? fromHost(sort, host.value) : `no value: ${Formatter.format(host.error)}`
				]
			],
			exact
		)
	})

layer(Substrate.layer, { excludeTestServices: true })("each operation over NULL", (it) => {
	it.effect(
		"is evaluated by the host as PostgreSQL evaluates it, at every slot NULL or a value",
		(ctx) =>
			Effect.gen(function* () {
				const s = yield* Substrate
				const owner = yield* s.session(ownerSession())
				return yield* searched(
					ctx,
					exhaust(
						{
							suite: "pg/null/operators",
							generator: caseGen,
							literal: Formatter.format,
							limit: 1200,
							coverage: requiredInSpace<Feature>([
								"compare",
								"between",
								"in",
								"connective",
								"not",
								"arith",
								"extremum",
								"cast",
								"text",
								"set",
								"cond",
								"guard",
								"a NULL operand",
								"no NULL operand",
								"NOT keeps unknown unknown",
								"OR holds over unknown",
								"AND fails over unknown",
								"a guard takes its otherwise at NULL",
								"a conditional takes its else at unknown",
								"greatest or least skips a NULL",
								"BETWEEN is false with one bound unknown",
								"IN is unknown at a NULL subject",
								"a singleton of an id read at an absent key is NULL",
								...Arr.map(
									roundingPositions,
									(position): Feature => `a ${position} refuses a rounding`
								),
								"the host declines a rounding",
								"a rounding of NULL is NULL"
							]),
							caseHang,
							box: "each operation the host evaluates in a check, and each rounding in every place the host evaluates an expression, every operand slot NULL or one of two values",
							oracle: {
								kind: "postgresql",
								name: "the expression written in plain SQL from its meaning alone, evaluated by PostgreSQL, with the model of language.ts agreeing"
							}
						},
						(oc, c) => operatorCase(owner, oc, c)
					)
				)
			}).pipe(Effect.scoped)
	)
})
