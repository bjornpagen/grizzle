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
import { defined, succeeded } from "#test/support/assert.ts"
import {
	compileTemplate,
	type FixtureSchema,
	programAsts,
	testCompile
} from "#test/support/compile.ts"
import { affine } from "#test/support/growth.ts"
import { caseHang } from "#test/support/limits.ts"
import { upTo } from "#test/support/up-to.ts"

/**
 * A query's compiled statements grow exactly linearly with its attachments: a root relation keyed by its id attaching n
 * relations, each its own and each correlated on that id, compiled as a Db compiles it, each artifact's statements
 * counted as AST nodes (a structural property, never printed text), f(n), at n, 2n and 3n: f(3n) − f(2n) = f(2n) − f(n),
 * every attachment adding the same nodes.
 *
 * In the optimized artifact each attachment is one part of the one statement, which reads its parent key set from the
 * root's rows the statement holds once: the root is keyed by the id each child correlates on, so the set is proved and
 * read as it is (lower/conservative/keys.ts). In the conservative artifact each attachment is one statement of its own,
 * which computes its parent's rows again. No attachment reads a sibling's rows, and the children's own fields, one to
 * three, widen every attachment alike. Exact linearity at one n fails wherever any term grows faster than linearly, so
 * the families are small.
 *
 * Oracle: the universal relation of an affine size (test/support/growth.ts affine), exhausted over every width and size
 * of one to three.
 *
 * Plants (~/.cache/grizzle-release/BR02/plants): size-parts-padded-per-sibling, every part of a statement padded by one
 * column per part (lower/parts.ts taggedParts), a part that grows with its siblings, which fails it at every n.
 */

/** A family's width, its children's own fields, and its size n: each one to three. */
const extent = int(1, 3)

/** A child's `width` own fields beside its key and its parent's. */
const childFields = (width: number): ReadonlyArray<string> => upTo(width, (i) => `f${i}`)

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
): { readonly query: QueryValue; readonly schema: FixtureSchema } => {
	const fields = childFields(width)
	const root = keyedRelation("Root", [], ["rank"])
	const kids = upTo(n, (i) => keyedRelation(`Kid${i}`, ["parent"], fields))
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

const total = (asts: ReadonlyArray<Select>): number =>
	Arr.reduce(asts, 0, (n, ast) => n + nodes(ast))

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
	const conservative = Arr.map(flight(template.programs.conservative.roots), (s) => s.ast)
	return {
		conservative: total(conservative),
		optimized: total(programAsts(template.programs.optimized))
	}
}

describe("compiled size", () => {
	it.effect(
		"a query attaching n, 2n and 3n relations compiles to statements that grow by the same nodes from each to the next",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						box: "every width and size of one to three",
						oracle: { kind: "universal", name: "f(3n) − f(2n) = f(2n) − f(n)" },
						suite: "unit/program/size",
						generator: (source) => [source.draw(extent), source.draw(extent)] as const,
						literal: Formatter.format,
						limit: 9,
						coverage: noCoverage,
						caseHang
					},
					([width, n]) =>
						Effect.sync(() => {
							const measured = new Map(
								Arr.map([n, 2 * n, 3 * n], (k) => [k, sizesOf(k, width)] as const)
							)
							for (const artifact of ["conservative", "optimized"] as const) {
								affine(
									(k) => defined(measured.get(k), `the sizes at ${k} attachments`)[artifact],
									n,
									`the ${artifact} artifact's nodes over children of ${width} fields`
								)
							}
						})
				)
			)
	)
})
