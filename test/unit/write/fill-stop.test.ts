import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { array, element, type Gen } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import type { CodecFault, CompileError, EncodingFailure } from "#compiler/core/errors.ts"
import type * as Result from "#compiler/core/result.ts"
import { TupleMap } from "#compiler/core/tuple-map.ts"
import {
	accumulated,
	closedId,
	drawn,
	generated,
	natural,
	pg,
	uuid
} from "#compiler/public/fields.ts"
import {
	closed,
	fin,
	fold,
	Monoid,
	mutable,
	on,
	ordered,
	relation,
	schema,
	select
} from "#compiler/public/schema.ts"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"
import type { MemberKey, Owner } from "#compiler/write/family/draw.ts"
import { type FillContext, ownersOf, planEdits, type Values } from "#compiler/write/family/edit.ts"
import { nestedRows, nestedSet } from "#compiler/write/family/nesting.ts"
import type { EnumeratedInput } from "#compiler/write/frontend/compile.ts"
import { compileWrite } from "#compiler/write/program/compile.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { realityWrite, testArtifacts, testCompile } from "#test/support/compile.ts"
import { caseHang } from "#test/support/limits.ts"
import { checking } from "#test/support/policy.ts"
import { descOf, uuidOf } from "#test/unit/write/changeset/fixtures.ts"

/**
 * A fill stops on a row as one refusal, whichever path fills it: the nesting's walk (write/family/fold.ts `filler`,
 * through write/family/nesting.ts `nestedRows`) and a family's edit (write/family/edit.ts `planEdits`) share the fill's
 * stop (fold.ts FillStop), a fold's selection (`selects`) and its step (`stepped`), and refuse a write by the one
 * mapping of a stop to its fault (`fillFailure`).
 *
 * The schema is an ordered family of members, each of a kind whose weight a closed relation gives, a generated field
 * that is NULL at the kind the relation lacks. One fold sums the members' quantities over a selection, another sums
 * their weights. A case is one family, written two ways: an owner inserted with its members nested, and the same
 * members put one by one into the family of an owner the stratum inserts, which the edit appends in order.
 *
 * Two oracles:
 * - The paths agree: the nested insert and the edit both accept, or both refuse with one fault.
 * - The specification: a write whose fill reads a missing weight is refused before any SQL as factShape, and every
 *   other write is accepted.
 *
 * Bound: every selection (none, the weight alone, the quantity and the weight), with and without the weight fold, over
 * every family of up to three members, each of two quantities and of the three kinds wherever a fill reads its weight,
 * of the two weighed kinds elsewhere. A fill reads a member's weight where the weight fold steps over it, or where the
 * selection reaches it in whatever order its conjuncts are evaluated, each up to the first that is not true. A missing
 * weight no fill reads is outside the box: the nesting's walk evaluates every generated field of its rows, where an
 * edit evaluates only those its fill reads and leaves the rest to PostgreSQL's NOT NULL.
 *
 * The planted bug, a selection the edit cannot evaluate refused as integerRange where the nesting refuses it as
 * factShape, is a disagreement wherever the selection reaches a missing weight; so is an edit that reads a step's
 * missing weight as no value, integerRange.
 */

const weighedKinds = ["light", "heavy"] as const

const kinds = [...weighedKinds, "unweighed"] as const

const Kind = closed("Kind", kinds)

const Weights = closed.relation(
	"Weights",
	{ kind: closedId(Kind), weight: pg.bigint },
	["kind"],
	[
		{ kind: "light", weight: 1n },
		{ kind: "heavy", weight: 2n }
	]
)

/** The step side's selection of the quantity fold: none, the weight at least 1, or the quantity and the weight. */
const selections = ["none", "weight", "quantity and weight"] as const
type Selection = (typeof selections)[number]

const Member = relation.generated(
	"Member",
	{ id: uuid, owner: uuid, at: drawn(natural), kind: closedId(Kind), qty: pg.bigint },
	["id"],
	(r) => ({ w: generated(pg.bigint, Weights.at("weight", r.kind)) })
)

/** The quantity fold's step side under a selection. */
const stepSideOf = (selection: Selection) => {
	switch (selection) {
		case "none":
			return Member
		case "weight":
			return select(Member, (m) => m.ge(m.w, 1n))
		case "quantity and weight":
			return select(Member, (m) => m.and(m.ge(m.qty, 1n), m.ge(m.w, 1n)))
	}
}

/** The schema of a selection, with the weight fold or without it, and its owner relation. */
const schemaOf = (selection: Selection, weighed: boolean) => {
	const ownerFields = { id: uuid, n: drawn(natural), total: accumulated(pg.bigint, 0n) }
	if (!weighed) {
		const Owner = relation("Owner", ownerFields, ["id"])
		const family = ordered(on(Member, "owner", "at"), fin(Owner, "n"))
		return {
			Owner,
			schema: schema("FillStop", { Kind, Weights, Owner, Member }, [
				family,
				fold(
					family,
					Monoid.sum,
					on(stepSideOf(selection), "owner", "qty"),
					on(Owner, "id", "total")
				),
				mutable(Owner),
				mutable(Member)
			])
		}
	}
	const Owner = relation("Owner", { ...ownerFields, weighed: accumulated(pg.bigint, 0n) }, ["id"])
	const family = ordered(on(Member, "owner", "at"), fin(Owner, "n"))
	return {
		Owner,
		schema: schema("FillStop", { Kind, Weights, Owner, Member }, [
			family,
			fold(family, Monoid.sum, on(stepSideOf(selection), "owner", "qty"), on(Owner, "id", "total")),
			fold(family, Monoid.sum, on(Member, "owner", "w"), on(Owner, "id", "weighed")),
			mutable(Owner),
			mutable(Member)
		])
	}
}

/** A schema's two paths, compiled once: its nesting with its member slot, and its members' edit with its context. */
interface Paths {
	readonly nest: (facts: ReadonlyArray<unknown>) => Result.Result<unknown, EncodingFailure>
	readonly edit: (
		members: ReadonlyArray<{ readonly [field: string]: unknown }>
	) => Result.Result<unknown, EncodingFailure | CompileError>
}

const pathsOf = (selection: Selection, weighed: boolean): Paths => {
	const built = schemaOf(selection, weighed)
	const artifacts = succeeded(testArtifacts(built.schema, testCompile))
	const program = succeeded(
		compileWrite(
			checking(built.schema),
			descOf(ChangeSet.empty(built.schema).insert(built.Owner, []).put(Member, [])),
			realityWrite(artifacts)
		)
	)
	const inputs = Arr.flatMap(
		program.frontend.slots,
		(g): ReadonlyArray<EnumeratedInput> => g.inputs
	)
	const [input] = Arr.flatMap(
		inputs,
		(i): ReadonlyArray<Extract<EnumeratedInput, { readonly kind: "nested" }>> =>
			i.kind === "nested" ? [i] : []
	)
	const nested = defined(input, "the owner's nested insert")
	const member = Arr.headNonEmpty(nested.members).name
	const target = defined(
		Option.getOrUndefined(Arr.findFirst(program.edits, (e) => e.target.relation.name === "Member")),
		"the members' edit"
	).target
	const ctx: FillContext = { codes: program.frontend.codes, evaluate: program.frontend.evaluate }
	const owner = { id: uuidOf(0) }
	return {
		nest: (facts) => nestedRows(nested.nesting, member, facts, nestedSet()),
		edit: (members) =>
			planEdits(
				ctx,
				target,
				{ inserts: [], puts: members, deletes: [], nested: [] },
				new Map(),
				(family) => ({
					stated: ownersOf(ctx, family, [owner]),
					plain: true,
					recounted: new TupleMap<Owner, Values>()
				}),
				{ current: new TupleMap<MemberKey, Values>(), refilled: () => false }
			)
	}
}

/** Each selection's paths, without the weight fold and with it. */
const everyPaths = Arr.map(selections, (selection) => ({
	selection,
	plain: pathsOf(selection, false),
	weighed: pathsOf(selection, true)
}))

const pathsAt = (selection: Selection, weighed: boolean): Paths => {
	const paths = defined(
		Arr.findFirst(everyPaths, (p) => p.selection === selection).pipe(Option.getOrUndefined),
		`the paths of the selection ${selection}`
	)
	return weighed ? paths.weighed : paths.plain
}

interface MemberShape {
	readonly kind: (typeof kinds)[number]
	readonly qty: bigint
}

/** A case: the schema's selection, whether it has the weight fold, and the family's members in order. */
interface StopCase {
	readonly selection: Selection
	readonly weighed: boolean
	readonly members: ReadonlyArray<MemberShape>
}

/**
 * Whether a selection reaches the weight of a member of `qty` in whatever order its conjuncts are evaluated, each up to
 * the first that is not true: the weight alone always, the quantity and the weight wherever the quantity holds.
 */
const selectionReadsWeight = (selection: Selection, qty: bigint): boolean => {
	switch (selection) {
		case "none":
			return false
		case "weight":
			return true
		case "quantity and weight":
			return qty >= 1n
	}
}

/** Whether a fill of a member of `qty` reads its weight: the weight fold steps over it, or the selection reaches it. */
const weightRead = (selection: Selection, weighed: boolean, qty: bigint): boolean =>
	weighed || selectionReadsWeight(selection, qty)

const quantities = [0n, 1n] as const

/** The kinds a member of `qty` is drawn from: every kind where a fill reads its weight, the weighed ones elsewhere. */
const kindsOf = (
	selection: Selection,
	weighed: boolean,
	qty: bigint
): Arr.NonEmptyReadonlyArray<MemberShape["kind"]> =>
	weightRead(selection, weighed, qty) ? kinds : weighedKinds

const memberGen =
	(selection: Selection, weighed: boolean): Gen<MemberShape> =>
	(source) => {
		const qty = source.draw(element(quantities))
		return { kind: source.draw(element(kindsOf(selection, weighed, qty))), qty }
	}

const caseGen: Gen<StopCase> = (source) => {
	const selection = source.draw(element(selections))
	const weighed = source.draw(element([false, true] as const))
	return {
		selection,
		weighed,
		members: source.draw(array(memberGen(selection, weighed), { min: 0, max: 3 }))
	}
}

/** The box: each selection, with and without the weight fold, and every family of up to three of its member shapes. */
const boxCases = Arr.reduce(selections, 0, (total, selection) =>
	Arr.reduce([false, true] as const, total, (sum, weighed) => {
		const shapes = Arr.reduce(
			quantities,
			0,
			(n, qty) => n + kindsOf(selection, weighed, qty).length
		)
		return sum + 1 + shapes + shapes ** 2 + shapes ** 3
	})
)

/** What a write comes to: accepted, or refused before any SQL with its fault. */
type Verdict =
	| { readonly kind: "accepted" }
	| { readonly kind: "refused"; readonly fault: CodecFault | CompileError["_tag"] }

const verdictOf = (result: Result.Result<unknown, EncodingFailure | CompileError>): Verdict =>
	result.ok
		? { kind: "accepted" }
		: {
				kind: "refused",
				fault:
					result.error._tag === "EncodingFailure" ? result.error.reason._tag : result.error._tag
			}

/** Why the specification refuses a case's write: a missing weight the selection or the weight fold reads. */
type Stop = "a selection reads a missing weight" | "a step reads a missing weight"

const stopsOf = (c: StopCase): ReadonlyArray<Stop> =>
	Arr.flatMap(c.members, (m): ReadonlyArray<Stop> =>
		m.kind === "unweighed"
			? [
					...(selectionReadsWeight(c.selection, m.qty)
						? ["a selection reads a missing weight" as const]
						: []),
					...(c.weighed ? ["a step reads a missing weight" as const] : [])
				]
			: []
	)

type StopSituation =
	| `refused: ${Stop}`
	| "accepted: a member the selection leaves out"
	| "accepted: every weight present"

describe("a fill's stop", () => {
	it.effect(
		"refuses a write as one fault whether the nesting or the edit fills it, and exactly where its fill reads a missing weight",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/write/fill-stop",
						generator: caseGen,
						literal: Formatter.format,
						limit: boxCases,
						box: "every selection of the quantity fold, with and without the weight fold, over every family of up to three members, each of two quantities and of every kind where a fill reads its weight, a weighed kind elsewhere",
						oracle: {
							kind: "specification",
							name: "the nesting's fill and the edit's agree, refusing as factShape exactly where a fill reads a missing weight"
						},
						coverage: requiredInSpace<StopSituation>([
							"refused: a selection reads a missing weight",
							"refused: a step reads a missing weight",
							"accepted: a member the selection leaves out",
							"accepted: every weight present"
						]),
						caseHang
					},
					(c, k) =>
						Effect.sync(() => {
							const paths = pathsAt(c.selection, c.weighed)
							const facts = Arr.map(c.members, (m, i) => ({
								id: uuidOf(i + 1),
								kind: m.kind,
								qty: m.qty
							}))
							const nested = verdictOf(paths.nest([{ id: uuidOf(0), n: facts }]))
							const edited = verdictOf(
								paths.edit(Arr.map(facts, (f) => ({ ...f, owner: uuidOf(0) })))
							)
							const stops = stopsOf(c)
							const specified: Verdict =
								stops.length === 0 ? { kind: "accepted" } : { kind: "refused", fault: "factShape" }
							assert.deepEqual(edited, nested, "the edit's verdict is the nesting's")
							assert.deepEqual(nested, specified, "the verdict is the specification's")
							k.noteAll(Arr.map(stops, (s): StopSituation => `refused: ${s}`))
							if (stops.length > 0) {
								return
							}
							k.note("accepted: every weight present")
							if (c.selection === "quantity and weight" && Arr.some(c.members, (m) => m.qty < 1n)) {
								k.note("accepted: a member the selection leaves out")
							}
						})
				)
			)
	)
})
