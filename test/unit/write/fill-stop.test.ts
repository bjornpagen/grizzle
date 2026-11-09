import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { array, element, type Gen } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { collectInputs } from "#adapter/apply/collect.ts"
import { bindFrame } from "#adapter/wire/batch.ts"
import { generatedLaw } from "#compiler/ir/law.ts"
import type { StratumAt } from "#compiler/ir/stratum.ts"
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
import { bindWrite } from "#compiler/runtime/write/bind.ts"
import { prepareBinding } from "#compiler/runtime/write/binding.ts"
import { inForce } from "#compiler/runtime/write/transport.ts"
import { hostJudgement, type StatedRows } from "#compiler/runtime/write/witness.ts"
import type { Law, Witness } from "#compiler/types/changeset/changeset.ts"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"
import { runnableWrite } from "#compiler/write/program/bind.ts"
import { type CompiledWrite, compileWrite } from "#compiler/write/program/compile.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { realityWrite, testArtifacts, testCompile } from "#test/support/compile.ts"
import { caseHang } from "#test/support/limits.ts"
import { checking } from "#test/support/policy.ts"
import { descOf, parsedOf, uuidOf } from "#test/unit/write/changeset/fixtures.ts"

/**
 * A generated field with no value refuses its write as one outcome, `invariant-rejected` on the field's law
 * (analysis/theory/description.ts generatedLaw) witnessed by the key of the first stated row whose term has no value,
 * whatever the write's shape and whoever finds the NULL: the nesting's walk, which evaluates every generated field of
 * each row it fills (runtime/write/fill.ts `filler`); a family's edit, which evaluates those its fill reads, a fold's
 * selection or step (write/family/edit.ts `planEdits`); or PostgreSQL, whose NOT NULL refuses a row whose field no fill
 * reads (23502), judged by the host as the shell judges it (runtime/write/witness.ts hostJudgement).
 *
 * The schema is an ordered family of members, each of a kind whose weight a closed relation gives, a generated field
 * that is NULL at the kind the relation lacks. One fold sums the members' quantities over a selection, another sums
 * their weights. A case is one family, written two ways through bindWrite: an owner inserted with its members nested,
 * and an owner inserted with none beside its members put one by one, which the edit appends in order. A write the host
 * binds is planned over reads that find nothing stored; where one of its rows has a missing weight, PostgreSQL's NOT
 * NULL refuses the family statement that writes them, and the outcome is the host's judgement of that statement.
 *
 * The oracle, the specification: a write with a member of a missing weight is `invariant-rejected` on Member.w's law,
 * witnessed by the first such member's id, whichever path wrote it; every other write is accepted.
 *
 * Bound: every selection (none, the weight alone, the quantity and the weight), with and without the weight fold, over
 * every family of up to three members, each of three kinds and two quantities.
 *
 * Planted bugs: an edit whose selection cannot evaluate a missing weight refused as integerRange, or one reading a
 * step's missing weight as no value, refuses where the specification does not say so; an edit that witnesses the row
 * its fill stopped at names a later member than the first of a missing weight where an earlier one no fill reads.
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

/** A path's program and the stratum whose family statement writes Member's rows. */
interface Path {
	readonly program: CompiledWrite
	readonly stratum: StratumAt
}

/** A schema's two paths, each compiled once: the nested insert, and the owner's insert beside its members' puts. */
interface Paths {
	readonly nested: Path
	readonly edited: Path
	readonly Owner: unknown
	readonly schema: unknown
}

const pathsOf = (selection: Selection, weighed: boolean): Paths => {
	const built = schemaOf(selection, weighed)
	const reality = realityWrite(succeeded(testArtifacts(built.schema, testCompile)))
	const compiled = (value: unknown): CompiledWrite =>
		succeeded(compileWrite(checking(built.schema), descOf(value), reality))
	const nested = compiled(shapeOf(built, "nested", []))
	const edited = compiled(shapeOf(built, "edited", []))
	return {
		nested: {
			program: nested,
			stratum: defined(
				Arr.head(nested.frontend.nested).pipe(Option.getOrUndefined),
				"the nested write"
			).stratum
		},
		edited: {
			program: edited,
			stratum: defined(
				Option.getOrUndefined(
					Arr.findFirst(edited.frontend.edits, (e) => e.relation.name === "Member")
				),
				"the members' edit"
			).stratum
		},
		Owner: built.Owner,
		schema: built.schema
	}
}

/** A member as a case states it: its kind and its quantity. */
interface MemberShape {
	readonly kind: (typeof kinds)[number]
	readonly qty: bigint
}

/** A case's ChangeSet on a path: owner 0 inserted with the members nested, or with none beside their puts. */
const shapeOf = (
	built: { readonly Owner: unknown; readonly schema: unknown },
	path: "nested" | "edited",
	members: ReadonlyArray<MemberShape>
): unknown => {
	const facts = Arr.map(members, (m, i) => ({ id: uuidOf(i + 1), kind: m.kind, qty: m.qty }))
	const changes = ChangeSet.empty(built.schema)
	return path === "nested"
		? changes.insert(built.Owner, [{ id: uuidOf(0), n: facts }])
		: changes.insert(built.Owner, [{ id: uuidOf(0), n: [] }]).put(
				Member,
				Arr.map(facts, (f) => ({ ...f, owner: uuidOf(0) }))
			)
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

/** A case: the schema's selection, whether it has the weight fold, and the family's members in order. */
interface StopCase {
	readonly selection: Selection
	readonly weighed: boolean
	readonly members: ReadonlyArray<MemberShape>
}

const memberGen: Gen<MemberShape> = (source) => ({
	kind: source.draw(element(kinds)),
	qty: source.draw(element([0n, 1n] as const))
})

const caseGen: Gen<StopCase> = (source) => ({
	selection: source.draw(element(selections)),
	weighed: source.draw(element([false, true] as const)),
	members: source.draw(array(memberGen, { min: 0, max: 3 }))
})

/** The box: each selection, with and without the weight fold, and every family of up to three of six member shapes. */
const boxCases = selections.length * 2 * (1 + 6 + 36 + 216)

/** What a write comes to: accepted, refused on a law with its witness, or anything else, by what it is. */
type Outcome =
	| { readonly kind: "accepted" }
	| { readonly kind: "invariant-rejected"; readonly law: Law; readonly witness: Witness }
	| { readonly kind: "other"; readonly what: string }

const accepted: Outcome = { kind: "accepted" }

/** Member.w's law, which a member of a missing weight breaks. */
const weightLaw = generatedLaw("Member", "w")

/**
 * The outcome of a write PostgreSQL runs once the host has bound and planned it: refused on Member.w's law where a
 * member has a missing weight, NOT NULL refusing the family statement of `stratum` that writes Member's rows, which the
 * host judges as the shell judges it; accepted otherwise.
 */
const statementOutcome = (path: Path, stated: StatedRows, missing: boolean): Outcome => {
	if (!missing) {
		return accepted
	}
	const member = defined(
		Option.getOrUndefined(Arr.findFirst(path.program.frontend.written, (r) => r.name === "Member")),
		"Member, which the write writes"
	)
	const w = defined(
		Option.getOrUndefined(Arr.findFirst(member.fields, (f) => f.name === "w")),
		"Member's generated weight"
	)
	return {
		kind: "invariant-rejected",
		law: weightLaw,
		witness: hostJudgement(
			prepareBinding(path.program.binding, path.program.frontend.codes).witness,
			stated,
			{ kind: "write", stratum: path.stratum, relations: [member.name] },
			{ kind: "generated", table: member.ident, column: w.column }
		).witness
	}
}

/** The outcome of a case's ChangeSet on a path: the host's refusal, or PostgreSQL's of what the host binds. */
const outcomeOn = (path: Path, value: unknown, missing: boolean) =>
	Effect.map(
		collectInputs(path.program.binding.groups, parsedOf(value).inputs),
		(members): Outcome => {
			const bound = bindWrite(runnableWrite(path.program, path.program.frontend.codes), {
				members,
				params: {},
				transport: inForce(bindFrame)
			})
			if (!bound.ok) {
				return { kind: "other", what: bound.error._tag }
			}
			const b = bound.value
			switch (b.kind) {
				case "invariant-rejected":
					return { kind: "other", what: "a key law" }
				case "generated-rejected":
					return { kind: "invariant-rejected", law: b.rejection.law, witness: b.rejection.witness }
				case "bound": {
					const flights = b.flights
					if (flights.kind === "write") {
						return statementOutcome(path, flights.stated, missing)
					}
					const planned = flights.writes(Arr.map(flights.reads, () => []))
					if (planned.ok) {
						return statementOutcome(path, planned.value.stated, missing)
					}
					return planned.error._tag === "GeneratedRejection"
						? { kind: "invariant-rejected", law: planned.error.law, witness: planned.error.witness }
						: { kind: "other", what: planned.error._tag }
				}
			}
		}
	)

/** Whether a member's fill reads its weight: the weight fold steps over it, or the selection reaches the weight. */
const weightRead = (c: StopCase, m: MemberShape): boolean =>
	c.weighed || c.selection === "weight" || (c.selection === "quantity and weight" && m.qty >= 1n)

type StopSituation =
	| "refused: an edit's fill reads the first missing weight"
	| "refused: a missing weight no fill reads"
	| "refused: a missing weight no fill reads before one a fill reads"
	| "accepted"

describe("a generated field with no value", () => {
	it.effect(
		"refuses its write on the field's law, witnessed by the first such member, whether the nesting, an edit or PostgreSQL finds it",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/write/fill-stop",
						generator: caseGen,
						literal: Formatter.format,
						limit: boxCases,
						box: "every selection of the quantity fold, with and without the weight fold, over every family of up to three members, each of three kinds and two quantities",
						oracle: {
							kind: "specification",
							name: "invariant-rejected on Member.w's law, witnessed by the first member of a missing weight, on every path"
						},
						coverage: requiredInSpace<StopSituation>([
							"refused: an edit's fill reads the first missing weight",
							"refused: a missing weight no fill reads",
							"refused: a missing weight no fill reads before one a fill reads",
							"accepted"
						]),
						caseHang
					},
					(c, k) =>
						Effect.gen(function* () {
							const paths = pathsAt(c.selection, c.weighed)
							const missing = Arr.findFirstIndex(c.members, (m) => m.kind === "unweighed")
							const specified: Outcome = Option.match(missing, {
								onNone: () => accepted,
								onSome: (i) => ({
									kind: "invariant-rejected",
									law: weightLaw,
									witness: { kind: "key", relation: "Member", values: { id: uuidOf(i + 1) } }
								})
							})
							const nested = yield* outcomeOn(
								paths.nested,
								shapeOf(paths, "nested", c.members),
								Option.isSome(missing)
							)
							const edited = yield* outcomeOn(
								paths.edited,
								shapeOf(paths, "edited", c.members),
								Option.isSome(missing)
							)
							assert.deepEqual(nested, specified, "the nested insert's outcome")
							assert.deepEqual(edited, specified, "the edit's outcome")
							const unweighed = Arr.filter(c.members, (m) => m.kind === "unweighed")
							const [first] = unweighed
							if (first === undefined) {
								k.note("accepted")
								return
							}
							k.note(
								weightRead(c, first)
									? "refused: an edit's fill reads the first missing weight"
									: "refused: a missing weight no fill reads"
							)
							if (!weightRead(c, first) && Arr.some(unweighed, (m) => weightRead(c, m))) {
								k.note("refused: a missing weight no fill reads before one a fill reads")
							}
						})
				)
			)
	)
})
