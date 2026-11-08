import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { noCoverage } from "@grizzle/testing/features"
import { int } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Record as Rec } from "effect"
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
import { caseHang } from "#test/support/limits.ts"

/**
 * A query's compiled statements grow with the query, never faster: a query attaching n relations, each its own, and the
 * same query attaching 2n, compiled as a Db compiles them, the 2n one at 200 attachments. Each artifact's statements,
 * counted as AST nodes (a structural property, never printed text), grow by at most 2 + ε from n to 2n: every
 * attachment statement computes its parent's rows again, so one that also computed its sibling attachments would grow
 * by 4 there. Every attachment over exact parents is a statement of its own in both artifacts (shapes/index.ts
 * rowsStatement), so the space is the children's own fields, one to three, which widen every statement alike.
 */

/** The bound on growth from n to 2n: linear, with ε for the parts that do not grow. */
const linear = 2.5

/** How many relations the smaller query attaches; the larger attaches twice as many. */
const attachments = 100

/** A child's `width` own fields beside its key and its parent's. */
const childFields = (width: number): ReadonlyArray<string> => Arr.makeBy(width, (i) => `f${i}`)

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
	width: number
): { readonly query: QueryValue; readonly schema: unknown } => {
	const fields = childFields(width)
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

/**
 * The AST nodes of each artifact's statements, a query of `n` attachments of `width` fields compiled as a Db compiles
 * it.
 */
const sizesOf = (n: number, width: number) => {
	const { query, schema: value } = attached(n, width)
	const template = succeeded(
		compileTemplate(query, value, testCompile),
		`${n} attachments of ${width} fields`
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
						box: { kind: "unstated" },
						oracle: { kind: "unstated" },
						suite: "unit/program/size",
						generator: int(1, 3),
						literal: Formatter.format,
						limit: 3,
						coverage: noCoverage,
						caseHang
					},
					(width) =>
						Effect.sync(() => {
							const small = sizesOf(attachments, width)
							const large = sizesOf(2 * attachments, width)
							const at = `children of ${width} fields at ${attachments} against ${2 * attachments}`
							assert.ok(
								large.conservative <= linear * small.conservative,
								`${at}: the conservative artifact grows from ${small.conservative} to ${large.conservative} nodes`
							)
							assert.ok(
								large.optimized <= linear * small.optimized,
								`${at}: the optimized artifact grows from ${small.optimized} to ${large.optimized} nodes`
							)
						})
				)
			)
	)
})
