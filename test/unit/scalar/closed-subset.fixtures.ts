import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import { defined, nonEmpty } from "@bjornpagen/testing/assert"
import { constant, type Gen, int, map, oneOf, shuffled } from "@bjornpagen/testing/gen"
import { Array as Arr, Option } from "effect"
import { checkQuery } from "#compiler/check/index.ts"
import { identifierOf, identity, parseDeclaredName } from "#compiler/core/identity.ts"
import { codeOf, firstCodebook } from "#compiler/ir/codes.ts"
import type { FieldDesc } from "#compiler/ir/desc.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { queryInput } from "#compiler/program/input.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { type ClosedIdField, type ClosedSubset, pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { closed, relation, schema } from "#compiler/public/schema.ts"
import { own, rostersOf } from "#compiler/schema/own.ts"
import { schemaDescOf } from "#compiler/schema/schema.ts"
import type { Expr } from "#compiler/sql/ast.ts"
import { isIn, lit, tableCol, types } from "#compiler/sql/build.ts"
import { succeeded } from "#test/support/assert.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { checking, checkOptions } from "#test/support/policy.ts"

/** The roster's handles, in its order. */
export const handles = ["p", "q", "r", "s"] as const

/** A handle of the roster. */
export type Handle = (typeof handles)[number]

/** The roster every case's field is a closed id of. */
export const Mark = closed.ordered("Mark", handles)

/** A subset's two keys (types/fields/field.ts ClosedSubset): the handles it lists, or every one but those. */
const keys = ["only", "except"] as const

type Key = (typeof keys)[number]

/**
 * What a case states after the roster:
 * - `typed`: what a caller's TypeScript passes, no subset or `{ only }` or `{ except }` of a nonempty list of the
 *   roster's handles, each written once or one of them twice, which closedId's type takes;
 * - `untyped`: the arguments after the roster as a JavaScript caller can write them, which no type of closedId takes.
 */
export type Statement =
	| { readonly door: "typed"; readonly subset: ClosedSubset<typeof Mark> | undefined }
	| { readonly door: "untyped"; readonly rest: ReadonlyArray<unknown> }

const key: Gen<Key> = map(int(0, keys.length - 1), (at) => Arr.getUnsafe(keys, at))

const handle: Gen<Handle> = map(int(0, handles.length - 1), (at) => Arr.getUnsafe(handles, at))

/** An ordered list of distinct handles of the roster, of `least` handles or more. */
const listedOf = (least: number): Gen<ReadonlyArray<Handle>> =>
	shuffled(handles, { min: least, max: handles.length })

/** A typed subset: a key over an ordered list of distinct handles, written as drawn or with one of them again after it. */
const typed: Gen<ClosedSubset<typeof Mark>> = (s) => {
	const k = s.draw(key)
	const listed = nonEmpty(s.draw(listedOf(1)), "a typed list holds a handle")
	const written = s.draw(
		oneOf<NonEmptyReadonlyArray<Handle>>([
			constant(listed),
			map(int(0, listed.length - 1), (at) => Arr.append(listed, Arr.getUnsafe(listed, at)))
		])
	)
	return k === "only" ? { only: written } : { except: written }
}

/** A handle of no roster of the case's. */
const foreign = "t"

/**
 * The arguments after the roster no type of closedId takes: a key over an ordered list of distinct handles with a handle
 * off the roster written among them, a key over an empty list, both keys, a list with no key, a key over a handle that
 * is no list, and two subsets.
 */
const untyped: Gen<ReadonlyArray<unknown>> = oneOf<ReadonlyArray<unknown>>([
	(s) => {
		const k = s.draw(key)
		const listed = s.draw(listedOf(0))
		const at = s.draw(int(0, listed.length))
		return [{ [k]: [...Arr.take(listed, at), foreign, ...Arr.drop(listed, at)] }]
	},
	map(key, (k) => [{ [k]: [] }]),
	map(handle, (h) => [{ only: [h], except: [h] }]),
	map(handle, (h) => [[h]]),
	(s) => [{ [s.draw(key)]: s.draw(handle) }],
	(s) => {
		const k = s.draw(key)
		const h = s.draw(handle)
		return [{ [k]: [h] }, { [k]: [h] }]
	}
])

/**
 * The box: no subset, every typed subset of the four handles and every untyped value above, each list of handles in
 * every order.
 */
export const statements: Gen<Statement> = oneOf<Statement>([
	constant({ door: "typed", subset: undefined }),
	map(typed, (subset): Statement => ({ door: "typed", subset })),
	map(untyped, (rest): Statement => ({ door: "untyped", rest }))
])

/** A subset's key and the handles its list writes. */
const listedBy = (
	subset: ClosedSubset<typeof Mark>
): readonly [Key, NonEmptyReadonlyArray<Handle>] =>
	"only" in subset ? ["only", subset.only] : ["except", subset.except]

/**
 * The subset a typed statement states, as the specification reads it apart from the engine: every handle, the handles
 * it holds in the roster's order and whether it lists them otherwise, or the rule's refusal.
 */
export type Stated =
	| { readonly kind: "every" }
	| {
			readonly kind: "subset"
			readonly held: NonEmptyReadonlyArray<Handle>
			/** Whether the statement lists its `only` handles in an order other than the roster's. */
			readonly reordered: boolean
	  }
	| { readonly kind: "refused" }

/**
 * What `subset` states: none is every handle; a list that writes a handle twice, or an `except` of every handle, is
 * refused; and otherwise the subset is `only`'s handles or every handle but `except`'s, in the roster's order, every
 * handle being the whole roster's.
 */
export const statedBy = (subset: ClosedSubset<typeof Mark> | undefined): Stated => {
	if (subset === undefined) {
		return { kind: "every" }
	}
	const [k, listed] = listedBy(subset)
	if (Arr.dedupe(listed).length !== listed.length) {
		return { kind: "refused" }
	}
	const held = Arr.filter(handles, (h) => Arr.contains(listed, h) === (k === "only"))
	return Arr.match(held, {
		onEmpty: (): Stated => ({ kind: "refused" }),
		onNonEmpty: (some): Stated =>
			some.length === handles.length
				? { kind: "every" }
				: {
						kind: "subset",
						held: some,
						reordered: k === "only" && !Arr.every(Arr.zip(listed, some), ([a, b]) => a === b)
					}
	})
}

/**
 * What the installation of a relation T keyed by an integer `k` with `field` as its column `mark` holds of it: the
 * field's description, the predicate of each CHECK T's CREATE TABLE declares under mark's subsetCheck name, the
 * predicate a CHECK holding mark to `held` is, in the roster's codes the installation drafted, and the roster's handles
 * a query over T may equate mark to, as its check admits them.
 */
export const installedOf = (field: ClosedIdField<typeof Mark, Handle>) => {
	const T = relation("T", { k: pg.integer, mark: field }, ["k"])
	const S = schema("Subsets", [Mark, T], [])
	const desc = defined(schemaDescOf(S), "the case's description")
	const fields = Option.getOrThrow(
		Arr.findFirst(desc.relations, (r) =>
			r.kind === "relation" && r.name === "T" ? Option.some(r.fields) : Option.none()
		)
	)
	const described: FieldDesc = defined(fields["mark"], "T's field mark").type
	const owned = succeeded(own(desc))
	const codes = firstCodebook(rostersOf(owned))
	const installation = succeeded(
		compileInstallation(
			owned,
			completeInstallOptions(owned, [identity.schema(parsedSchemaName("subsets"))], [], [], codes)
		)
	)
	const codec = defined(
		installation.names.codes.rosters.get(succeeded(parseDeclaredName("Mark"))),
		"Mark's codes"
	)
	const name = identifierOf(identity.subsetCheck("T", "mark"))
	const checks = Arr.flatMap(installation.manifest.objects, (o) =>
		o.kind === "table"
			? Arr.flatMap(o.ddl, (statement) =>
					statement.kind === "createTable"
						? Arr.flatMap(statement.secondary, (c) =>
								c.kind === "check" && c.name === name ? [c.predicate] : []
							)
						: []
				)
			: []
	)
	const column = tableCol(installation.names.column("T", "mark"))
	/** Whether a query equating mark to `handle` checks, as a template's compile checks it. */
	const compares = (handle: Handle): boolean =>
		checkQuery(
			checking(S),
			succeeded(
				queryInput(
					query(S).rule((r) => {
						const { k, mark } = v(T, "t")
						return r.match(T, { k, mark }).where(r.eq(mark, handle)).find({ k })
					})
				),
				"the query's input"
			).desc,
			checkOptions("query")
		).ok
	const compared: ReadonlyArray<Handle> = Arr.filter(handles, compares)
	return {
		described,
		checks,
		compared,
		checkOf: (held: NonEmptyReadonlyArray<Handle>): Expr =>
			isIn(
				column,
				Arr.map(held, (h) => lit.int(codeOf(codec, h), types.smallint))
			)
	}
}
