import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, Record as Rec } from "effect"
import { isList, isRecord } from "#compiler/core/record.ts"
import { flight } from "#compiler/lower/conservative/types.ts"
import { pg, uuid } from "#compiler/public/fields.ts"
import { type Relation, relation, schema } from "#compiler/public/schema.ts"
import { type QueryValue, queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import type { Select } from "#compiler/sql/ast.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { compileTemplate, testCompile } from "#test/support/compile.ts"

/**
 * A query's compiled statements grow with the query, never faster: a query attaching n relations, each its own, and the
 * same query attaching 2n, compiled as a Db compiles them, the 2n one at 200 attachments. Each artifact's statements,
 * counted as AST nodes (a structural property, never printed text), grow by at most 2 + ε from n to 2n: every
 * attachment statement computes its parent's rows again, so one that also computed its sibling attachments would grow
 * by 4 there. Exhausted over the attachment's two deliveries: a child of one field, which the optimized artifact fuses
 * into its parent statement, and one of five, past the fusion rule's bound, which it pipelines as a statement of its
 * own.
 */

/** The bound on growth from n to 2n: linear, with ε for the parts that do not grow. */
const linear = 2.5

/** How many relations the smaller query attaches; the larger attaches twice as many. */
const attachments = 100

type Child = "fused" | "pipelined"

/** A child's own fields beside its key and its parent's: one, which fuses, or five, which do not. */
const childFields = (child: Child): ReadonlyArray<string> =>
	child === "fused" ? ["a"] : ["a", "b", "c", "d", "e"]

/** A relation built at run time: its type is the widest the relation constructor gives. */
type RelationValue = Relation<
	string,
	Record<string, FieldBase>,
	readonly [string, ...Array<string>]
>

/** A relation keyed by its uuid `id`, its other fields the uuids `uuids` and the integers `integers`. */
const keyedRelation = (
	name: string,
	uuids: ReadonlyArray<string>,
	integers: ReadonlyArray<string>
): RelationValue => {
	const descriptors: Record<string, FieldBase> = { id: uuid }
	for (const f of uuids) {
		descriptors[f] = uuid
	}
	for (const f of integers) {
		descriptors[f] = pg.integer
	}
	return relation(name, descriptors, ["id"])
}

/** The rule matching `source` on its every field, each bound to its own variable or to `fixed`'s term, finding the rest. */
const matchAll = (
	r: RuleValue,
	source: RelationValue,
	fields: ReadonlyArray<string>,
	fixed: Readonly<Record<string, unknown>>
) => {
	const vars = varsOver(source, "row")
	const bindings: Record<string, unknown> = {}
	const head: Record<string, unknown> = {}
	for (const f of fields) {
		bindings[f] = Rec.has(fixed, f) ? fixed[f] : vars[f]
		if (!Rec.has(fixed, f)) {
			head[f] = vars[f]
		}
	}
	return r.match(source, bindings).find(head)
}

/** A root relation's rows with `n` relations attached, each child matching its own relation on the parent's id. */
const attached = (
	n: number,
	child: Child
): { readonly query: QueryValue; readonly schema: unknown } => {
	const fields = childFields(child)
	const root = keyedRelation("Root", [], ["rank"])
	const kids = Arr.makeBy(n, (i) => keyedRelation(`Kid${i}`, ["parent"], fields))
	const declared: Record<string, RelationValue> = { Root: root }
	for (const kid of kids) {
		declared[kid.name] = kid
	}
	const value = schema("Attached", declared, [])
	let query = queryOver(value).rule((r: RuleValue) => matchAll(r, root, ["id", "rank"], {}))
	for (const [i, kid] of kids.entries()) {
		query = query.attach(
			`kid${i}`,
			(p: unknown) => {
				if (!isRecord(p) || !Rec.has(p, "id")) {
					throw new Error(`the attachment kid${i} was given no parent id`)
				}
				return queryOver(value).rule((r: RuleValue) =>
					matchAll(r, kid, ["id", "parent", ...fields], { parent: p["id"] })
				)
			},
			"array"
		)
	}
	return { query, schema: value }
}

/** The nodes of a statement's AST: each object, list and scalar one, and an absent clause none. */
const nodes = (v: unknown): number =>
	v === undefined
		? 0
		: isList(v)
			? Arr.reduce(v, 1, (n, x) => n + nodes(x))
			: isRecord(v)
				? Arr.reduce(Rec.values(v), 1, (n, x) => n + nodes(x))
				: 1

const total = (statements: ReadonlyArray<{ readonly ast: Select }>): number =>
	Arr.reduce(statements, 0, (n, s) => n + nodes(s.ast))

/** The AST nodes of each artifact's statements, a query of `n` attachments compiled as a Db compiles it. */
const sizesOf = (n: number, child: Child) => {
	const { query, schema: value } = attached(n, child)
	const template = succeeded(
		compileTemplate(query, value, testCompile),
		`${n} ${child} attachments`
	)
	const conservative = flight(template.programs.conservative.roots)
	const optimized = flight(template.programs.optimized.roots)
	return { conservative: total(conservative), optimized: total(optimized) }
}

describe("compiled size", () => {
	it.effect(
		"a query attaching 2n relations compiles to statements at most linearly larger than one attaching n",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/program/size",
						generator: element<Child>(["fused", "pipelined"]),
						literal: Formatter.format,
						limit: 2,
						coverage: requiredInSpace<Child>(["fused", "pipelined"]),
						caseHang: Duration.minutes(4)
					},
					(child, c) =>
						Effect.sync(() => {
							const small = sizesOf(attachments, child)
							const large = sizesOf(2 * attachments, child)
							const at = `${child} children at ${attachments} against ${2 * attachments}`
							assert.ok(
								large.conservative <= linear * small.conservative,
								`${at}: the conservative artifact grows from ${small.conservative} to ${large.conservative} nodes`
							)
							assert.ok(
								large.optimized <= linear * small.optimized,
								`${at}: the optimized artifact grows from ${small.optimized} to ${large.optimized} nodes`
							)
							c.note(child)
						})
				)
			)
	)
})
