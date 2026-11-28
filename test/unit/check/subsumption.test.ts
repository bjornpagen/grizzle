/**
 * A value of a type stands wherever a type that subsumes it is asked for, with no node of its own (ir/scalar.ts
 * subsumes): a domain's value as its base's, a refined text's as its text's. The IR builds no up-cast (ir/expr.ts
 * builtExpr refuses one as a defect), so a stored column a head term reads through Type.base, or a law's anti-join
 * reads at the type it meets its other side at, is the column bare, which every walk of the reader's comparisons sees,
 * where a cast hid it: metis carryEnter's `stage: Type.base(number)`, joined with its input's stage, chained no key
 * through it, and every foreign key law's anti-join compared a cast child column.
 *
 * The boxes, exhausted:
 * - a head term through Type.base of a natural column, delivered by one rule or by a union of two rules (each
 *   Type.base, or one beside a bigint term), the union's arms conformed at its heading;
 * - a containment of a child column of a contract over bigint, or of a pattern text, into a parent column of its base.
 *
 * Per case: the checked DAG holds no cast whose type subsumes its argument's; the head's column, or the law's anti-join
 * operands, read the stored column bare; and the query compiles (its arms printed at their heading's base). Oracle:
 * specification. Kills: the head term's up-cast restored; the law builder's up-cast restored.
 *
 * Features: a contract column, a pattern text column; one rule, a union of two.
 */

import { assert } from "@bjornpagen/testing/assert"
import { element, finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { checkQuery } from "#compiler/check/index.ts"
import { ExprId, NodeId } from "#compiler/core/ids.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import { builtExpr, exprClosure } from "#compiler/ir/expr.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import { exprsOf, type RelNode } from "#compiler/ir/rel.ts"
import { baseOf, subsumes } from "#compiler/ir/scalar.ts"
import { queryInput } from "#compiler/program/input.ts"
import { Logic, Type } from "#compiler/public/compute.ts"
import { contract, natural, int4, int8 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { binaryCoercion } from "#compiler/scalar/compute/registry.ts"
import { naturalType } from "#compiler/scalar/natural.ts"
import { succeeded } from "#test/support/assert.ts"
import { compileTemplate, testArtifacts, testCompile } from "#test/support/compile.ts"
import { contained, f, on, relation as relationDesc } from "#test/support/fixtures/ir/desc.ts"
import { checking, checkOptions } from "#test/support/policy.ts"
import {
	lawOfShape,
	naturalDesc,
	schemaOf,
	theoryOf
} from "#test/support/unit/analysis/theory/support.ts"

type Feature = "a contract column" | "a pattern text column" | "one rule" | "a union of two"

type Column = "contract" | "pattern"
type Arms = "one rule" | "two up-casts" | "an up-cast beside a base term"

/** The casts of `nodes`' expressions, every one an expression's of the DAG. */
const castsOf = (nodes: ReadonlyArray<RelNode>) =>
	Arr.filter(exprClosure(Arr.flatMap(nodes, (node) => exprsOf(node))), (e) => e.kind === "cast")

/** No cast of the DAG is to a type that subsumes its argument's. */
const noUpCast = (dag: LogicalQuery["dag"], where: string): void => {
	for (const cast of castsOf(topoOrder(dag))) {
		const [arg] = cast.args
		assert.ok(!subsumes(cast.type, arg.type), `${where}: no up-cast, ${cast.id}`)
	}
}

const Held = relation("Held", { id: int4, number: natural, other: int8 }, ["id"])
const Subsumed = schema("Subsumed", [Held], [])

/** The case's query: a head term through Type.base of a natural column, by one rule, two, or beside a bigint term. */
const headCase = (arms: Arms) => {
	switch (arms) {
		case "one rule":
			return query(Subsumed).rule((r) => {
				const { id, number } = v(Held, "held")
				return r.match(Held, { id, number }).find({ id, stage: Type.base(number) })
			})
		case "two up-casts":
			return query(Subsumed)
				.rule((r) => {
					const { id, number } = v(Held, "held")
					return r.match(Held, { id, number }).find({ id, stage: Type.base(number) })
				})
				.rule((r) => {
					const { id, number } = v(Held, "again")
					return r.match(Held, { id, number }).find({ id, stage: Type.base(number) })
				})
		case "an up-cast beside a base term":
			return query(Subsumed)
				.rule((r) => {
					const { id, number } = v(Held, "held")
					return r.match(Held, { id, number }).find({ id, stage: Type.base(number) })
				})
				.rule((r) => {
					const { id, other } = v(Held, "plain")
					return r.match(Held, { id, other }).find({ id, stage: other })
				})
	}
}

/** The stage column of a head projection of the DAG, read bare: a column reference, never a cast of one. */
const headReadsBare = (dag: LogicalQuery["dag"], where: string): void => {
	const stages = Arr.flatMap(topoOrder(dag), (node) =>
		node.kind === "ProjectSet" ? Arr.filter(node.out, (o) => o.name === "stage") : []
	)
	assert.ok(stages.length > 0, `${where}: a head delivers stage`)
	for (const stage of stages) {
		assert.ok(
			stage.expr.kind === "column" || stage.expr.kind === "literal",
			`${where}: stage read bare, not a ${stage.expr.kind}`
		)
	}
}

/** A head term a type subsumes reads its stored column bare, in one rule or in a union's conformed arms. */
export const aHeadTermATypeSubsumesReadsItsStoredColumnBareInOneRuleOrInAUnionsConformedArms =
	property.exhaust(
		finite((source) =>
			source.draw(element<Arms>(["one rule", "two up-casts", "an up-cast beside a base term"]))
		),
		{
			needs: {},
			situations: ["one rule", "a union of two"],
			check: (_, c: Case<Feature>) => (arms) =>
				Effect.sync(() => {
					c.note(arms === "one rule" ? "one rule" : "a union of two")
					const where = arms
					const q = headCase(arms)
					const checked = succeeded(
						checkQuery(checking(Subsumed), succeeded(queryInput(q)).desc, checkOptions("query")),
						`${where}: the query checks`
					)
					noUpCast(checked.dag, where)
					headReadsBare(checked.dag, where)
					succeeded(compileTemplate(q, undefined, testCompile), `${where}: the query compiles`)
				}),
			oracle: {
				kind: "specification",
				name: "an expression of a type stands where a type that subsumes it is asked for, with no cast"
			},
			box: "a head term through Type.base of a natural column, by one rule, by two such rules, and beside a bigint term",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/check/checker.ts",
					original: "\t\treturn subsumes(term.nominal, term.expr.type)\n",
					replacement: "\t\treturn sameScalarType(term.expr.type, term.nominal)\n",
					why: "A head term through Type.base casts its stored column up to its base again, a node the walks cannot see through, which the expression constructor refuses as an up-cast."
				}
			]
		}
	)

/** A foreign key law over a refined child column builds its anti-join with no up-cast, the child column compared bare. */
export const aForeignKeyLawOverARefinedChildColumnBuildsItsAntiJoinWithNoUpCastTheChildColumnComparedBare =
	property.exhaust(
		finite((source) => source.draw(element<Column>(["contract", "pattern"]))),
		{
			needs: {},
			situations: ["a contract column", "a pattern text column"],
			check: (_, c: Case<Feature>) => (column) =>
				Effect.sync(() => {
					c.note(column === "contract" ? "a contract column" : "a pattern text column")
					const t = theoryOf(
						schemaOf(
							[
								relationDesc("P", { id: column === "contract" ? f.bigint : f.wildcard }, ["id"]),
								relationDesc(
									"C",
									{
										cid: f.uuid,
										p: column === "contract" ? naturalDesc : f.regex("^[a-z]+$", "u")
									},
									["cid"]
								)
							],
							[contained(on("C", ["p"]), on("P", ["id"]))]
						)
					)
					const law = lawOfShape(t, "contained")
					assert.ok(
						law.shape === "contained",
						`${column}: the containment law builds, its anti-join with no up-cast`
					)
				}),
			oracle: {
				kind: "specification",
				name: "a law compares a child column at the type it meets its parent's at, bare"
			},
			box: "a containment of a contract child column over bigint, and of a pattern text child column, into its base",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/analysis/theory/build.ts",
					original: "\t\tif (subsumes(type, e.type)) {\n",
					replacement: "\t\tif (e.type === type) {\n",
					why: "The law builder casts the child column up to the type it meets its parent's at, a node the law's probe reads through, which the expression constructor refuses as an up-cast."
				}
			]
		}
	)

/** The bounds a contract's predicate states of its value: a lower bound alone, an upper alone, or both. */
type UpCast = "to its base" | "to itself"

/**
 * The IR's one expression constructor refuses an up-cast where it is built (ir/expr.ts builtExpr): a cast of a natural
 * column to its base, bigint, which subsumes natural, and to natural itself, each a defect thrown. SUBMITKEY's refusal
 * built its defect and dropped it, `defect(...)` with no throw, so no up-cast was ever refused (lane REDS-PHYS,
 * 2026-11-26); a defect is thrown by its maker now (text/base/invariant.ts defect, `never`), so no statement can drop
 * one. Kill: defect returning its Error again, which every statement that calls it drops.
 */
export const anUpCastIsADefectWhereItIsBuilt = property.exhaust(
	finite((source) => source.draw(element<UpCast>(["to its base", "to itself"]))),
	{
		needs: {},
		situations: [],
		check: () => (upCast) =>
			Effect.sync(() => {
				const column = builtExpr(
					{
						kind: "column",
						column: { node: NodeId("n#0"), name: "number" },
						args: [],
						type: naturalType,
						nonNull: "storage"
					},
					ExprId("e#0")
				)
				assert.throws(
					() =>
						builtExpr(
							{
								kind: "cast",
								cast: binaryCoercion,
								args: [column],
								type: upCast === "to its base" ? baseOf(naturalType) : naturalType,
								nonNull: "strict",
								volatility: "immutable"
							},
							ExprId("e#1")
						),
					Error
				)
			}),
		oracle: {
			kind: "specification",
			name: "the IR's one expression constructor refuses a cast to a type that subsumes its operand's, a defect thrown where it is built"
		},
		box: "a cast of a natural column up to its base, bigint, and to natural itself",
		kept: [],
		kills: [
			{
				file: "packages/text/src/base/invariant.ts",
				original: `export const defect: (what: string) => never = (what) => {\n\tthrow new Error(\`grizzle internal invariant: \${what}\`)\n}\n`,
				replacement: `export const defect = (what: string): Error => new Error(\`grizzle internal invariant: \${what}\`)\n`,
				why: "defect returns the Error it builds again, and every statement that calls it drops it, as SUBMITKEY's up-cast refusal did: builtExpr builds the up-cast it refuses; the property fails."
			}
		]
	}
)

type Bounds = "lower" | "upper" | "both"

const minutesKey = Symbol("Minutes")
/**
 * A contract's predicate reads its VALUE at the contract's base, a stored value read bare (typing.ts LeafRead), so a
 * literal opposite it is a value of the base, never one its own contract judges: a schema storing the contract installs.
 */
export const aContractsPredicateReadsAStoredValueBareAtItsBaseAndALiteralOppositeItIsAValueOfTheBase =
	property.exhaust(
		finite((source) => source.draw(element<Bounds>(["lower", "upper", "both"]))),
		{
			needs: {},
			situations: [],
			check: () => (bounds) =>
				Effect.sync(() => {
					const Minutes = contract<typeof minutesKey>()("Minutes", int4, (n) =>
						bounds === "lower"
							? Logic.gt(n, 0)
							: bounds === "upper"
								? Logic.le(n, 360)
								: Logic.and([Logic.gt(n, 0), Logic.le(n, 360)])
					)
					const Granted = relation("Granted", { id: int4, minutes: Minutes }, ["id"])
					succeeded(
						testArtifacts(schema("Granted", [Granted], []), testCompile),
						`${bounds}: the schema storing the contract installs`
					)
				}),
			oracle: {
				kind: "specification",
				name: "a contract's predicate is stated over its base's values"
			},
			box: "a contract over integer bounded below by 0, above by 360, and both, each a literal its own contract refuses or admits",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/analysis/theory/laws.ts",
					original: '? Result.ok({ kind: "subsumed", spec: value, type: info.base })',
					replacement: "? Result.ok(value)",
					why: "The contract's violation query reads its VALUE at the contract itself, so a literal opposite it is a value of the contract, which the contract's own predicate refuses (ContractLiteral)."
				}
			]
		}
	)
