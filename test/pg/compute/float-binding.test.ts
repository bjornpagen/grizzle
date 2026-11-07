/**
 * A guarded float form binds its compound operands once per row, never in a SubPlan PostgreSQL runs again for every
 * row (lower/conservative/expr/lateral.ts), and computes what the reference evaluator computes.
 *
 * Each case draws a tree of IEEE 754 arithmetic over the double precision and real columns of a ledger, nested so an
 * operand is itself an operation, with casts between the two widths, and reads it where a statement evaluates it for
 * every row: delivered per entry, summed and averaged per group, filtered on, and grouped by. Two fact sets run it:
 *
 * - the edge classes of each float type, NaN and the infinities among them, through the conservative and the optimized
 *   lowering against the reference evaluator, which must agree exactly;
 * - moderate values, small dyadic fractions none of whose operations leaves the native range of its type
 *   (scalar/compute/native.ts nativeRange), so every guarded form takes its fast path: each statement both lowerings
 *   send is planned under EXPLAIN ANALYZE, and no SubPlan or InitPlan of it runs, since the exact paths, the only
 *   bindings left in a branch, are never taken. A binding a statement evaluated per row in a scalar subquery shows as
 *   a SubPlan that ran once per row.
 */
import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, element, type Gen, int, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Record as Rec } from "effect"
import {
	explainStatementWith,
	parsePlan,
	type PlanNode,
	planNodes
} from "#bench/harness/explain.ts"
import { checkQuery } from "#compiler/check/index.ts"
import { identity } from "#compiler/core/identity.ts"
import type { FieldDesc } from "#compiler/ir/desc.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import { flight } from "#compiler/lower/conservative/types.ts"
import { plainType } from "#compiler/scalar/compute/types.ts"
import { canonicalZero } from "#compiler/scalar/values/float.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import { optimizedLowering } from "#test/pg/recursion/lowering/support.ts"
import { assert, defined } from "#test/support/assert.ts"
import type {
	AuthoredExprDesc as ExprDesc,
	HeadTermDesc,
	QueryDesc
} from "#test/support/fixtures/ir/desc.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { valueClasses } from "#test/support/oracle/gen/domain.ts"
import { canonicalFacts } from "#test/support/oracle/gen/facts.ts"
import { type GenSchema, schemaCodes, schemaDesc } from "#test/support/oracle/gen/schema.ts"
import { factStatements } from "#test/support/oracle/install/load.ts"
import { oraclePlanUnder } from "#test/support/oracle/install/real.ts"
import { nonEmptyList } from "#test/support/oracle/pick.ts"
import {
	comparisonFailed,
	conservative,
	defaultRunOptions,
	factSet,
	type LabelledCase,
	type Lowering,
	reference,
	runLabelledOracle,
	type RunOptions
} from "#test/support/oracle/runner.ts"
import { checking, checkOptions } from "#test/support/policy.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import * as D from "#test/unit/check/dsl.ts"

type Width = "float8" | "float4"

type Op = "add" | "sub" | "mul" | "div"

/** A float term: a column, a literal, an operation of one width, or a cast of the other width's term into this one. */
type Term =
	| { readonly tag: "column"; readonly width: Width; readonly pick: number }
	| { readonly tag: "literal"; readonly width: Width; readonly eighths: number }
	| {
			readonly tag: "op"
			readonly width: Width
			readonly op: Op
			readonly left: Term
			readonly right: Term
	  }
	| { readonly tag: "cast"; readonly width: Width; readonly arg: Term }

/** Where a statement evaluates the term for every row. */
type Position = "delivered" | "summed" | "averaged" | "filtered" | "grouped"

type Feature =
	| `position:${Position}`
	| `width:${Width}`
	| "an operand that is an operation"
	| "a cast of an operation"
	| "a division"

const positions: Arr.NonEmptyReadonlyArray<Position> = [
	"delivered",
	"summed",
	"averaged",
	"filtered",
	"grouped"
]

const columnsOf: { readonly [W in Width]: Arr.NonEmptyReadonlyArray<string> } = {
	float8: ["x", "y", "z"],
	float4: ["r", "s"]
}

const other: { readonly [W in Width]: Width } = { float8: "float4", float4: "float8" }

const fieldOf: { readonly [W in Width]: FieldDesc } = {
	float8: { kind: "pg", type: "double precision" },
	float4: { kind: "pg", type: "real" }
}

const ops: Arr.NonEmptyReadonlyArray<Op> = ["add", "sub", "mul", "div"]

const termGen = (width: Width, depth: number): Gen<Term> => {
	const leaf: Gen<Term> = weighted<Term>([
		[4, (source) => ({ tag: "column", width, pick: source.draw(int(0, 15)) })],
		[1, (source) => ({ tag: "literal", width, eighths: source.draw(int(1, 64)) })]
	])
	if (depth === 0) {
		return leaf
	}
	return weighted<Term>([
		[1, leaf],
		[
			3,
			(source) => ({
				tag: "op",
				width,
				op: source.draw(element(ops)),
				left: source.draw(termGen(width, depth - 1)),
				right: source.draw(termGen(width, depth - 1))
			})
		],
		[1, (source) => ({ tag: "cast", width, arg: source.draw(termGen(other[width], depth - 1)) })]
	])
}

/** A drawn case: its term, where it is read, and the two fact sets' rows. */
interface BindingCase {
	readonly term: Term
	readonly position: Position
	readonly edge: ReadonlyArray<Row>
	readonly moderate: ReadonlyArray<Row>
}

/** One entry: its group, and a value per float column, x y z double precision and r s real. */
interface Row {
	readonly grp: number
	readonly values: { readonly [C in "x" | "y" | "z" | "r" | "s"]: TypedLiteral }
}

const float8 = plainType("float8")
const float4 = plainType("float4")

/** A float type's edge classes, specials among them, as accumulation draws them. */
const edgeOf = (width: Width): Gen<TypedLiteral> =>
	element(nonEmptyList(valueClasses(width === "float8" ? float8 : float4, true), "float classes"))

/** A moderate value: a dyadic fraction in [1/8, 1000], exact in either width. */
const moderateOf: Gen<TypedLiteral> = (source) => ({
	kind: "float",
	value: canonicalZero(source.draw(int(1, 8000)) / 8)
})

const rowGen =
	(value: (width: Width) => Gen<TypedLiteral>): Gen<Row> =>
	(source) => ({
		grp: source.draw(int(1, 3)),
		values: {
			x: source.draw(value("float8")),
			y: source.draw(value("float8")),
			z: source.draw(value("float8")),
			r: source.draw(value("float4")),
			s: source.draw(value("float4"))
		}
	})

const caseGen: Gen<BindingCase> = (source) => {
	const width = source.draw(element<Width>(["float8", "float4"]))
	return {
		term: source.draw(termGen(width, 3)),
		position: source.draw(element(positions)),
		edge: source.draw(array(rowGen(edgeOf), { min: 1, max: 24 })),
		moderate: source.draw(
			array(
				rowGen(() => moderateOf),
				{ min: 1, max: 24 }
			)
		)
	}
}

const ledger: GenSchema = {
	name: "Ledger",
	relations: [
		{
			name: "Entry",
			columns: [
				{ name: "id", type: plainType("int8") },
				{ name: "grp", type: plainType("int4") },
				{ name: "x", type: float8 },
				{ name: "y", type: float8 },
				{ name: "z", type: float8 },
				{ name: "r", type: float4 },
				{ name: "s", type: float4 }
			],
			primaryKey: ["id"],
			keys: [],
			mutable: false
		}
	],
	closed: [],
	containments: []
}

const entry = (field: string): ExprDesc => D.ref("Entry", field)

const exprOf = (t: Term): ExprDesc => {
	switch (t.tag) {
		case "column": {
			const columns = columnsOf[t.width]
			return entry(defined(columns[t.pick % columns.length], "a column of the width"))
		}
		case "literal":
			return D.typedLit(t.eighths / 8, fieldOf[t.width])
		case "op":
			return D.compute(t.op, exprOf(t.left), exprOf(t.right))
		case "cast":
			return D.cast(exprOf(t.arg), fieldOf[t.width])
	}
}

/** What a term exercises. */
const featuresOf = (c: BindingCase): ReadonlyArray<Feature> => {
	const out = new Set<Feature>([`position:${c.position}`, `width:${c.term.width}`])
	const walk = (t: Term): void => {
		switch (t.tag) {
			case "column":
			case "literal":
				return
			case "op":
				if (t.op === "div") {
					out.add("a division")
				}
				if (t.left.tag === "op" || t.right.tag === "op") {
					out.add("an operand that is an operation")
				}
				walk(t.left)
				walk(t.right)
				return
			case "cast":
				if (t.arg.tag === "op") {
					out.add("a cast of an operation")
				}
				walk(t.arg)
				return
		}
	}
	walk(c.term)
	return Arr.fromIterable(out)
}

const mean = (arg: ExprDesc): HeadTermDesc => ({ kind: "aggregate", fn: "mean", arg })

/** The query reading the term at its position. */
const queryOf = (term: ExprDesc, width: Width, position: Position): QueryDesc => {
	const head = (h: Readonly<Record<string, HeadTermDesc>>, where: ReadonlyArray<ExprDesc>) =>
		D.queryDesc(
			D.rule({
				vars: D.vars("Entry", "id", "grp", "x", "y", "z", "r", "s"),
				matches: [
					D.match(D.relationSource("Entry"), {
						id: entry("id"),
						grp: entry("grp"),
						x: entry("x"),
						y: entry("y"),
						z: entry("z"),
						r: entry("r"),
						s: entry("s")
					})
				],
				head: h,
				where,
				interiors: [],
				attach: []
			})
		)
	switch (position) {
		case "delivered":
			return head({ id: entry("id"), v: term }, [])
		case "summed":
			return head({ grp: entry("grp"), v: D.sum(term) }, [])
		case "averaged":
			return head({ grp: entry("grp"), v: mean(term) }, [])
		case "filtered":
			return head({ id: entry("id") }, [D.gt(term, D.typedLit(1, fieldOf[width]))])
		case "grouped":
			return head({ v: term, n: D.count() }, [])
	}
}

const rowLiterals = (row: Row, id: number): ReadonlyArray<TypedLiteral> => [
	{ kind: "int", value: BigInt(id) },
	{ kind: "int", value: BigInt(row.grp) },
	row.values.x,
	row.values.y,
	row.values.z,
	row.values.r,
	row.values.s
]

const ledgerCase = (label: string, desc: QueryDesc, rows: ReadonlyArray<Row>): LabelledCase => {
	const checked = checkQuery(checking(schemaDesc(ledger)), desc, checkOptions("query"))
	if (!checked.ok) {
		throw new Error(`${label} does not check: ${checked.error.message}`)
	}
	return {
		label,
		schema: ledger,
		facts: canonicalFacts({ Entry: Arr.map(rows, (row, k) => rowLiterals(row, k + 1)) }),
		query: { dag: checked.value.dag, params: {} },
		spelling: { mode: "drawn", edge: true }
	}
}

const lowerings: ReadonlyArray<Lowering> = [conservative, optimizedLowering("optimized")]

/** The roots of every SubPlan and InitPlan of a plan that ran. */
const subplansRun = (plan: PlanNode): ReadonlyArray<PlanNode> =>
	Arr.filter(
		Arr.fromIterable(planNodes(plan)),
		(n) =>
			Option.exists(n.parentRelationship, (r) => r === "SubPlan" || r === "InitPlan") &&
			n.actualLoops > 0
	)

/**
 * Each statement of `lowering` over the case, installed and filled in one rolled-back transaction, planned under
 * EXPLAIN ANALYZE: the SubPlans and InitPlans that ran, by statement.
 */
const subplansOf = (c: LabelledCase, lowering: Lowering, schema: string) =>
	Effect.scoped(
		Effect.gen(function* () {
			const substrate = yield* Substrate
			const planned = oraclePlanUnder(
				schemaDesc(c.schema),
				identity.schema(parsedSchemaName(schema)),
				substrate.owner.role,
				schemaCodes(c.schema)
			)
			if (!planned.ok) {
				return yield* Effect.die(new Error(planned.error.message))
			}
			const plan = planned.value
			const facts = factStatements(plan, factSet(c))
			if (!facts.ok) {
				return yield* Effect.die(new Error(facts.error.message))
			}
			const lowered = lowering.lower({ case: c, names: plan.installation.names })
			if (!lowered.ok) {
				return yield* Effect.die(new Error(lowered.error.message))
			}
			const session = yield* substrate.admin.pin
			yield* session.query("BEGIN", [])
			return yield* Effect.gen(function* () {
				for (const sql of [...plan.sql, ...facts.value]) {
					yield* session.query(sql, [])
				}
				const tables = Arr.map(Rec.values(plan.tables), (t) => printObjectName(t.name))
				yield* session.query(`ANALYZE ${Arr.join(tables, ", ")}`, [])
				const ran: Array<string> = []
				for (const [i, statement] of flight(lowered.value.roots).entries()) {
					const rows = yield* session.queryValues(
						explainStatementWith(statement.sql.text, { serialize: { kind: "off" }, wal: false }),
						[]
					)
					const explained = yield* Effect.fromResult(parsePlan(rows[0]?.[0]))
					for (const n of subplansRun(explained.plan)) {
						ran.push(
							`${lowering.name} statement ${i}: a subplan's ${n.nodeType} ran ${n.actualLoops} times\n${statement.sql.text}`
						)
					}
				}
				return ran
			}).pipe(Effect.ensuring(Effect.ignore(session.query("ROLLBACK", []))))
		})
	)

const runs = 60

layer(Substrate.layer)("guarded float forms on PostgreSQL 19", (it) => {
	it.effect(
		`bind their operands once per row and compute the reference's values, over ${runs} generated terms`,
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					const schema = yield* s.schema({ create: false, label: "floatbinding" })
					const options: RunOptions = {
						...defaultRunOptions,
						schema: { kind: "named", name: schema }
					}
					return yield* explore(
						{
							oracle: { kind: "unstated" },
							suite: "pg/compute/float-binding",
							draw: drawn(caseGen),
							literal: Formatter.format,
							coverage: required<Feature>(
								[
									"width:float8",
									"width:float4",
									"an operand that is an operation",
									"a cast of an operation",
									"a division",
									...Arr.map(positions, (p): Feature => `position:${p}`)
								],
								{ cases: runs, sense: notesOnly }
							),
							kept: [],
							runs,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						(k, cx) =>
							Effect.gen(function* () {
								cx.noteAll(featuresOf(k))
								const desc = queryOf(exprOf(k.term), k.term.width, k.position)
								const edge = ledgerCase("edge classes", desc, k.edge)
								const moderate = ledgerCase("moderate values", desc, k.moderate)
								for (const lowering of lowerings) {
									for (const c of [edge, moderate]) {
										const outcome = yield* runLabelledOracle(c, lowering, reference, options)
										if (!outcome.comparison.equal) {
											return yield* comparisonFailed(outcome)
										}
									}
									const ran = yield* subplansOf(moderate, lowering, schema)
									assert.deepEqual(
										ran,
										[],
										"no SubPlan or InitPlan runs over values every guarded form computes natively"
									)
								}
							})
					)
				})
			)
	)
})
