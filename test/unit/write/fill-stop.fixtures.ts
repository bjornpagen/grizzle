/** What the properties of fill-stop.test.ts read: its spaces, models and helpers. */

import { defined } from "@bjornpagen/testing/assert"
import { array, element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Option } from "effect"
import { collectInputs } from "#adapter/apply/collect.ts"
import { bindFrame } from "#adapter/wire/batch.ts"
import { closedTableOf } from "#compiler/analysis/schema.ts"
import { StoredRelationName } from "#compiler/core/ids.ts"
import { generatedLaw } from "#compiler/ir/law.ts"
import type { StratumAt } from "#compiler/ir/stratum.ts"
import { accumulated, closedId, drawn, generated, natural, int8 } from "#compiler/public/fields.ts"
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
	select,
	unit
} from "#compiler/public/schema.ts"
import { bindWrite } from "#compiler/runtime/write/bind.ts"
import { prepareBinding } from "#compiler/runtime/write/binding.ts"
import { inForce } from "#compiler/runtime/write/transport.ts"
import { hostJudgement, type StatedRows } from "#compiler/runtime/write/witness.ts"
import { CompilePatterns } from "#compiler/scalar/regex/patterns.ts"
import { noAdvice } from "#compiler/sql/advice.ts"
import type { StatedLaw, Witness } from "#compiler/types/changeset/changeset.ts"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"
import { type CompiledWrite, compileWrite } from "#compiler/write/program/compile.ts"
import { flightOf, servableWrite } from "#compiler/write/program/served.ts"
import { succeeded } from "#test/support/assert.ts"
import { realityWrite, testArtifacts, testCompile } from "#test/support/compile.ts"
import { Id } from "#test/support/ids.ts"
import { checking } from "#test/support/policy.ts"
import { descOf, parsedOf, uuidOf } from "#test/support/unit/write/changeset/fixtures.ts"

/** The kinds Weights gives a weight; `unweighed` is the kind it lacks. */
const weighedKinds = ["light", "heavy"] as const

const kinds = [...weighedKinds, "unweighed"] as const

const Kind = closed.ordered("Kind", kinds)

const Weights = closed.relation(
	"Weights",
	{ kind: closedId(Kind), weight: int8 },
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
	{ id: Id, owner: Id, at: drawn(natural), kind: closedId(Kind), qty: int8 },
	["id"],
	(r) => ({ w: generated(int8, Weights.at("weight", r.kind)) })
)

/** The quantity fold's step side under a selection. */
const stepSideOf = (selection: Selection) => {
	switch (selection) {
		case "none":
			return Member
		case "weight":
			return select(Member, (m) => m.ge(m.w, 1n))
		case "quantity and weight":
			return select(Member, (m) => m.and([m.ge(m.qty, 1n), m.ge(m.w, 1n)]))
	}
}

/** The schema of a selection, with the weight fold or without it, and its owner relation. */
const schemaOf = (selection: Selection, weighed: boolean) => {
	const ownerFields = { id: Id, n: drawn(natural), total: accumulated(int8, 0n) }
	if (!weighed) {
		const Owner = relation("Owner", ownerFields, ["id"])
		const family = ordered(on(Member, "owner", "at"), fin(Owner, "n"))
		return {
			Owner,
			schema: schema(
				"FillStop",
				[Kind, Weights, Owner, Member],
				[
					family,
					fold(
						family,
						Monoid.sum,
						on(stepSideOf(selection), "owner", "qty"),
						on(Owner, "id", "total")
					),
					unit("Row", { id: Id }),
					mutable(Owner),
					mutable(Member)
				]
			)
		}
	}
	const Owner = relation("Owner", { ...ownerFields, weighed: accumulated(int8, 0n) }, ["id"])
	const family = ordered(on(Member, "owner", "at"), fin(Owner, "n"))
	return {
		Owner,
		schema: schema(
			"FillStop",
			[Kind, Weights, Owner, Member],
			[
				family,
				fold(
					family,
					Monoid.sum,
					on(stepSideOf(selection), "owner", "qty"),
					on(Owner, "id", "total")
				),
				fold(family, Monoid.sum, on(Member, "owner", "w"), on(Owner, "id", "weighed")),
				unit("Row", { id: Id }),
				mutable(Owner),
				mutable(Member)
			]
		)
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
export const shapeOf = (
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
const everyPaths = Object.freeze(
	Arr.map(selections, (selection) => ({
		selection,
		plain: pathsOf(selection, false),
		weighed: pathsOf(selection, true)
	}))
)

export const pathsAt = (selection: Selection, weighed: boolean): Paths => {
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

export const caseGen: Gen<StopCase> = (source) => ({
	selection: source.draw(element(selections)),
	weighed: source.draw(element([false, true] as const)),
	members: source.draw(array(memberGen, { min: 0, max: 3 }))
})

/** What a write comes to: accepted, refused on a law with its witness, or anything else, by what it is. */
export type Outcome =
	| { readonly kind: "accepted" }
	| { readonly kind: "invariant-rejected"; readonly law: StatedLaw; readonly witness: Witness }
	| { readonly kind: "other"; readonly what: string }

export const accepted: Outcome = { kind: "accepted" }

/** Member.w's law, which a member of a missing weight breaks. */
export const weightLaw = generatedLaw(StoredRelationName("Member"), "w")

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
			prepareBinding(
				path.program.binding,
				path.program.frontend.codes,
				closedTableOf(path.program.frontend.schema),
				new CompilePatterns()
			).witness,
			stated,
			{ kind: "write", stratum: path.stratum, relations: [member.name] },
			{ kind: "generated", table: member.ident, column: w.column }
		).witness
	}
}

/** The outcome of a case's ChangeSet on a path: the host's refusal, or PostgreSQL's of what the host binds. */
export const outcomeOn = (path: Path, value: unknown, missing: boolean) =>
	Effect.sync((): Outcome => {
		const members = collectInputs(path.program.binding.groups, parsedOf(value).inputs)
		const bound = bindWrite(
			flightOf(servableWrite(path.program), path.program.frontend.codes, noAdvice),
			{
				members,
				params: {},
				transport: inForce(bindFrame)
			}
		)
		if (!bound.ok) {
			return { kind: "other", what: bound.error._tag }
		}
		const b = bound.value
		switch (b.kind) {
			case "invariant-rejected":
				return { kind: "other", what: "a key law" }
			case "generated-rejected":
				return { kind: "invariant-rejected", law: b.rejection.law, witness: b.rejection.witness }
			case "bound":
				return statementOutcome(path, b.stated, missing)
		}
	})

/** Whether a member's fill reads its weight: the weight fold steps over it, or the selection reaches the weight. */
export const weightRead = (c: StopCase, m: MemberShape): boolean =>
	c.weighed || c.selection === "weight" || (c.selection === "quantity and weight" && m.qty >= 1n)

export type StopSituation =
	| "refused: an edit's fill reads the first missing weight"
	| "refused: a missing weight no fill reads"
	| "refused: a missing weight no fill reads before one a fill reads"
	| "accepted"
