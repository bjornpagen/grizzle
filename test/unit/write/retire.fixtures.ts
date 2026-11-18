/** What the properties of retire.test.ts read: its spaces, models and helpers. */

import { array, constant, element, type Gen, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, Stream } from "effect"
import { pg, retirement } from "#compiler/public/fields.ts"
import { contained, on, relation, retirable, role, schema } from "#compiler/public/schema.ts"
import { queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { FinishedValue, RuleValue } from "#compiler/query/build/rule.ts"
import { changeSetOver as ChangeSet, type ChangeSetValue } from "#compiler/write/changeset/value.ts"
import type { DeltaValue } from "#compiler/write/delta/source.ts"
import { compileWrite } from "#compiler/write/program/compile.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { realityWrite, testArtifacts, testCompile } from "#test/support/compile.ts"
import { checking } from "#test/support/policy.ts"
import { descOf } from "#test/unit/write/changeset/fixtures.ts"

const Root = relation("Root", { id: pg.integer, retired: retirement }, ["id"])

const Step = relation("Step", { root: pg.integer, step: pg.integer }, ["root", "step"])

const Claim = relation("Claim", { root: pg.integer, step: pg.integer, attempt: pg.integer }, [
	"root",
	"step",
	"attempt"
])

const Other = relation("Other", { id: pg.integer, v: pg.integer }, ["id"])

const Units = schema(
	"retire_units",
	[Root, Step, Claim, Other],
	[
		retirable(Root, [on(Step, "root"), on(Claim, "root")]),
		contained(on(Claim, "root", "step"), on(Step, "root", "step"))
	]
)

const entries = Object.freeze({ Root, Step, Claim, Other })

/** A role that inserts Other alone and retires Root's groups. */
const Retirer = role(Units, "retirer", entries, { insert: ["Other"], retire: ["Root"] })

/** A role that inserts every relation of the units' schema and retires nothing. */
const Writer = role(Units, "writer", entries, { insert: ["Root", "Step", "Claim", "Other"] })

/** What a drawn ChangeSet is built over: the schema itself, the retirer role, or the writer role. */
export type World = "reality" | "retirer" | "writer"

/**
 * A member of a drawn stratum: a retirement of Root's groups from an array or a Stream; an insert of Other, which
 * touches no unit; an insert of Step or of Root from an array, a write of the unit; an insert of Other from a query
 * matching Step at `g`, a read of a body; or from a query matching Root's retirement field at `g`, a read of the
 * header's group state.
 */
export type Member =
	| { readonly kind: "retire"; readonly source: "array" | "stream" }
	| { readonly kind: "other" }
	| { readonly kind: "write"; readonly relation: "Step" | "Root" }
	| { readonly kind: "read"; readonly relation: "Step" | "Root" }

/** The read-back: Other's state, Step at `g`, Other's or Step's added delta, Root's, or none. */
export type ReadBack = "other" | "step" | "otherDelta" | "stepDelta" | "rootDelta" | "none"

/** A drawn ChangeSet: its world, its strata, each of up to three members, and its read-back. */
export interface Drawn {
	readonly world: World
	readonly strata: Arr.NonEmptyReadonlyArray<ReadonlyArray<Member>>
	readonly readBack: ReadBack
}

/** The members a world may draw: the retirer writes Other alone; the schema and the writer write every relation. */
const memberGen =
	(world: World): Gen<Member> =>
	(source) => {
		const kind = source.draw(
			weighted<Member["kind"]>([
				[2, constant("retire")],
				[1, constant("other")],
				[1, constant("read")],
				...(world === "retirer" ? [] : [[1, constant<Member["kind"]>("write")] as const])
			])
		)
		switch (kind) {
			case "retire":
				return { kind, source: source.draw(element(["array", "stream"] as const)) }
			case "other":
				return { kind }
			case "write":
			case "read":
				return { kind, relation: source.draw(element(["Step", "Root"] as const)) }
		}
	}

/** Whether a member writes Other: a delta of Other two statements make is no read-back's to read
 * (ReadBackCrossesStatements), so the read-back of Other's added delta is drawn only beside one such member. */
const writesOther = (m: Member): boolean => m.kind === "other" || m.kind === "read"

/** The read-backs drawn, none twice as often as any other, Other's delta only where `delta`. */
const readBackGen = (delta: boolean): Gen<ReadBack> =>
	weighted<ReadBack>([
		[1, constant("other")],
		[1, constant("step")],
		[1, constant("stepDelta")],
		[1, constant("rootDelta")],
		[2, constant("none")],
		...(delta ? [[1, constant<ReadBack>("otherDelta")] as const] : [])
	])

export const drawnGen: Gen<Drawn> = (source) => {
	const world = source.draw(
		weighted<World>([
			[2, constant("reality")],
			[1, constant("retirer")],
			[1, constant("writer")]
		])
	)
	const stratum = array(memberGen(world), { min: 0, max: 3 })
	const [first, ...rest] = source.draw(array(stratum, { min: 1, max: 2 }))
	const strata: Arr.NonEmptyReadonlyArray<ReadonlyArray<Member>> = [
		defined(first, "a stratum"),
		...rest
	]
	return {
		world,
		strata,
		readBack: source.draw(readBackGen(Arr.filter(strata.flat(), writesOther).length === 1))
	}
}

/** The variables of `relation` under one scope `name`, a rule's one scope of that name: each field's, by its name. */
const scopeOf = (over: unknown, name: string) => {
	const vars = varsOver(over, name)
	return (field: string) => defined(vars[field], `the variable ${name}.${field}`)
}

/** A rule over the world's schema, built through the untyped core since its matches are drawn. */
const ruleOver = (over: unknown, rule: (r: RuleValue) => FinishedValue) =>
	queryOver(over).rule(rule)

/** Other's rows from a query reading `read` at the group `g`: Step's steps there, or Root's retirement field. */
const readQuery = (over: unknown, read: "Step" | "Root") =>
	ruleOver(over, (r) => {
		if (read === "Step") {
			const step = scopeOf(Step, "step")("step")
			return r.match(Step, { root: r.param("g", pg.integer), step }).find({ id: step, v: step })
		}
		const retired = scopeOf(Root, "root")("retired")
		return r
			.match(Root, { id: r.param("g", pg.integer), retired })
			.find({ id: r.param("g", pg.integer), v: r.param("g", pg.integer) })
	})

/** The read-back's query over the post-change state or a delta. */
const readBackQuery =
	(over: unknown, readBack: Exclude<ReadBack, "none">) =>
	(d: DeltaValue): unknown =>
		ruleOver(over, (r) => {
			const other = scopeOf(Other, "other")
			const stepOf = scopeOf(Step, "step")
			const rootOf = scopeOf(Root, "root")
			switch (readBack) {
				case "other":
					return r.match(Other, { id: other("id"), v: other("v") }).find({ id: other("id") })
				case "step":
					return r
						.match(Step, { root: r.param("g", pg.integer), step: stepOf("step") })
						.find({ step: stepOf("step") })
				case "otherDelta":
					return r
						.match(d.added(Other), { id: other("id"), v: other("v") })
						.find({ id: other("id") })
				case "stepDelta":
					return r
						.match(d.added(Step), { root: stepOf("root"), step: stepOf("step") })
						.find({ step: stepOf("step") })
				case "rootDelta":
					return r
						.match(d.added(Root), { id: rootOf("id"), retired: rootOf("retired") })
						.find({ id: rootOf("id") })
			}
		})

/** The value the drawn ChangeSet is built over. */
const overOf = (world: World): unknown =>
	world === "reality" ? Units : world === "retirer" ? Retirer : Writer

/** One member added to a ChangeSet, built through the untyped core since its members are drawn. */
const withMember = (over: unknown, cs: ChangeSetValue, m: Member): ChangeSetValue => {
	switch (m.kind) {
		case "retire":
			return cs.retire(Root, m.source === "array" ? [] : Stream.empty)
		case "other":
			return cs.insert(Other, [])
		case "write":
			return cs.insert(m.relation === "Step" ? Step : Root, [])
		case "read":
			return cs.insert(Other, readQuery(over, m.relation))
	}
}

/** The drawn ChangeSet: each stratum's members, the strata in sequence, then its read-back. */
const changeOf = (d: Drawn): ChangeSetValue => {
	const over = overOf(d.world)
	const stratumOf = (members: ReadonlyArray<Member>): ChangeSetValue =>
		Arr.reduce(members, ChangeSet.empty(over), (cs, m) => withMember(over, cs, m))
	const [first, ...rest] = d.strata
	const written = Arr.reduce(rest, stratumOf(first), (cs, members) =>
		ChangeSet.sequence(cs, stratumOf(members))
	)
	return d.readBack === "none" ? written : written.read("r", readBackQuery(over, d.readBack))
}

/** A touch of the unit beside a retirement: the relation and how, as RetiredUnitTouched names it. */
export interface Touch {
	readonly relation: "Root" | "Step"
	readonly how: "written" | "read" | "delta"
}

/** The model of a drawing: what it retires, at which drawn strata, and every touch of the unit beside that. */
export interface Model {
	/** The drawn strata holding a retire member, by their index among the drawn strata. */
	readonly retiring: ReadonlyArray<number>
	readonly touches: ReadonlyArray<Touch>
}

export const modelOf = (d: Drawn): Model => {
	const touches: Array<Touch> = []
	for (const m of d.strata.flat()) {
		if (m.kind === "write") {
			touches.push({ relation: m.relation, how: "written" })
		}
		if (m.kind === "read") {
			touches.push({ relation: m.relation, how: "read" })
		}
	}
	if (d.readBack === "step") {
		touches.push({ relation: "Step", how: "read" })
	}
	if (d.readBack === "stepDelta") {
		touches.push({ relation: "Step", how: "delta" })
	}
	if (d.readBack === "rootDelta") {
		touches.push({ relation: "Root", how: "delta" })
	}
	return {
		retiring: Arr.flatMap(d.strata, (members, s) =>
			Arr.some(members, (m) => m.kind === "retire") ? [s] : []
		),
		touches
	}
}

/** What a ChangeSet over each world compiles against: the schema's reality, or a role's world. */
const compileOptions = (() => {
	const reality = succeeded(testArtifacts(Units, testCompile))
	const roleOf = (over: typeof Retirer | typeof Writer) => {
		const artifacts = succeeded(testArtifacts(over, testCompile))
		const world = artifacts.world
		if (world.kind !== "role") {
			return assert.fail("a role's artifacts hold its world")
		}
		return {
			checked: world.checked,
			options: {
				names: artifacts.names,
				reads: artifacts.reads,
				claims: { kind: "every" } as const,
				world: { kind: "role", names: world.names } as const,
				laws: artifacts.laws,
				derived: artifacts.derived,
				level: "readCommitted" as const
			}
		}
	}
	return {
		reality: { checked: checking(Units), options: realityWrite(reality) },
		retirer: roleOf(Retirer),
		writer: roleOf(Writer)
	}
})()

/** The drawn ChangeSet compiled over its world. */
export const compiledOf = (d: Drawn) => {
	const { checked, options } = compileOptions[d.world]
	return compileWrite(checked, descOf(changeOf(d)), options)
}

/** The drawn stratum `s`'s position among the strata that hold a member, which is its statements' stratum: a ChangeSet
 * drops a stratum of no member. */
export const occupiedIndex = (d: Drawn, s: number): number =>
	Arr.filter(Arr.take(d.strata, s), (members) => members.length > 0).length

/** The slot of the drawn stratum `s`'s retirement, as the front end spells it (write/frontend/compile.ts). */
export const retireSlot = (s: number): string => `slot:${s}:retire:none:Root`

export type RetireFeature =
	| "refused: outside the role"
	| "refused: a write of the unit"
	| "refused: a read of the unit"
	| "refused: a delta of the unit"
	| "retired from an array"
	| "retired from a Stream"
	| "retired beside a write of Other"
	| "retired in two strata"
	| "retired over the retirer role"
	| "nothing retired"
