/**
 * A retirable statement at the schema door (schema/statements.ts admitRetirable, schema/own.ts its admission and
 * checkUnits): which units a schema may declare. A unit retires each of its header's groups whole, so its schema must
 * keep every row of a group inside the group's bodies, and keep the header's retirement field its unit's alone.
 *
 * The box: one header, Root, with one retirement field, none or two; Step keyed with or without its group; the unit's
 * bodies, a nonempty set of Step, Claim and Note; a containment of Claim's step into Step carrying the group or crossing
 * it, or none; a containment of Note's step into Step, or none; Root made mutable or not; a key over Root that reads its
 * retirement field or none; and a retirement field on Note, which heads no unit, or none.
 *
 * Oracle: the rules the statement's documentation states, restated over the box: a schema owns exactly when the header
 * has exactly one retirement field and no other relation has one; every body's key holds its group; every containment
 * into a body comes from a body of the unit, carrying the group to the group; the header is immutable; and no other
 * statement reads the retirement field. Features: owned, and each rule broken alone.
 */
import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { boolean, element, type Gen } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Result as EffectResult } from "effect"
import * as Result from "#compiler/core/result.ts"
import { pg } from "#compiler/public/fields.ts"
import { parseSchemaInput } from "#compiler/program/schema.ts"
import { relation, retirementField } from "#compiler/schema/relation.ts"
import { schema } from "#compiler/schema/schema.ts"
import {
	containedBuilder,
	keyBuilder,
	mutableBuilder,
	onBuilder,
	retirableBuilder
} from "#compiler/schema/statements.ts"
import { assert } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { ownInput } from "#test/support/policy.ts"

/** The relations a unit's bodies are drawn from. */
const bodyNames = ["Step", "Claim", "Note"] as const
type BodyName = (typeof bodyNames)[number]

/** One declaration of the box. */
interface Declared {
	readonly lifecycles: 0 | 1 | 2
	readonly stepKeyed: boolean
	readonly bodies: Arr.NonEmptyReadonlyArray<BodyName>
	readonly claimRef: "none" | "carried" | "crossed"
	readonly noteRef: boolean
	readonly mutableRoot: boolean
	readonly keyReadsLifecycle: boolean
	readonly stray: boolean
}

/** Every nonempty set of bodies, in the bodies' order. */
const bodySets: Arr.NonEmptyReadonlyArray<Arr.NonEmptyReadonlyArray<BodyName>> = [
	["Step"],
	["Claim"],
	["Note"],
	["Step", "Claim"],
	["Step", "Note"],
	["Claim", "Note"],
	["Step", "Claim", "Note"]
]

const declaredGen: Gen<Declared> = (source) => ({
	lifecycles: source.draw(element<0 | 1 | 2>([0, 1, 2])),
	stepKeyed: source.draw(boolean),
	bodies: source.draw(element(bodySets)),
	claimRef: source.draw(element<Declared["claimRef"]>(["none", "carried", "crossed"])),
	noteRef: source.draw(boolean),
	mutableRoot: source.draw(boolean),
	keyReadsLifecycle: source.draw(boolean),
	stray: source.draw(boolean)
})

/** The rule a declaration breaks first, in the order the oracle reads them; none for one that owns. */
type Broken =
	| "the header's retirement fields are not one"
	| "a relation outside every header holds a retirement field"
	| "a body's key lacks its group"
	| "a containment into a body comes from outside the unit"
	| "a containment into a body crosses the group"
	| "the header is mutable"
	| "a key reads the retirement field"

/** The rules `d` breaks, by the statement's documentation restated over the box. */
const brokenOf = (d: Declared): ReadonlyArray<Broken> => {
	const body = (name: BodyName): boolean => d.bodies.includes(name)
	return [
		...(d.lifecycles === 1 ? [] : ["the header's retirement fields are not one" as const]),
		...(d.stray ? ["a relation outside every header holds a retirement field" as const] : []),
		...(body("Step") && !d.stepKeyed ? ["a body's key lacks its group" as const] : []),
		...(d.stepKeyed && body("Step") && d.claimRef !== "none" && !body("Claim")
			? ["a containment into a body comes from outside the unit" as const]
			: []),
		...(d.stepKeyed && body("Step") && d.noteRef && !body("Note")
			? ["a containment into a body comes from outside the unit" as const]
			: []),
		...(d.stepKeyed && body("Step") && body("Claim") && d.claimRef === "crossed"
			? ["a containment into a body crosses the group" as const]
			: []),
		...(d.mutableRoot ? ["the header is mutable" as const] : []),
		...(d.keyReadsLifecycle && d.lifecycles > 0 ? ["a key reads the retirement field" as const] : [])
	]
}

/** The schema `d` declares, built through the builders; a builder's refusal is thrown. */
const declared = (d: Declared): unknown => {
	const lifecycle = retirementField(pg.boolean)
	const rootFields =
		d.lifecycles === 0
			? { id: pg.int4 }
			: d.lifecycles === 1
				? { id: pg.int4, retired: lifecycle }
				: { id: pg.int4, retired: lifecycle, closed: retirementField(pg.boolean) }
	const Root = relation("Root", rootFields, ["id"], [])
	const Step = relation(
		"Step",
		{ root: pg.int4, step: pg.int4 },
		d.stepKeyed ? ["root", "step"] : ["step"],
		[]
	)
	const Claim = relation(
		"Claim",
		{ root: pg.int4, step: pg.int4, attempt: pg.int4 },
		["root", "step", "attempt"],
		[]
	)
	const Note = relation(
		"Note",
		d.stray
			? { root: pg.int4, step: pg.int4, gone: retirementField(pg.boolean) }
			: { root: pg.int4, step: pg.int4 },
		["root", "step"],
		[]
	)
	const sides = { Step: onBuilder(Step, ["root"]), Claim: onBuilder(Claim, ["root"]), Note: onBuilder(Note, ["root"]) }
	const [first, ...rest] = Arr.map(d.bodies, (b) => sides[b])
	const stepTarget = onBuilder(Step, ["root", "step"])
	return schema(
		"Units",
		[Root, Step, Claim, Note],
		[
			retirableBuilder(Root, [first, ...rest]),
			...(d.claimRef === "none" || !d.stepKeyed
				? []
				: [
						containedBuilder(
							onBuilder(Claim, d.claimRef === "carried" ? ["root", "step"] : ["step", "root"]),
							stepTarget
						)
					]),
			...(d.noteRef && d.stepKeyed ? [containedBuilder(onBuilder(Note, ["root", "step"]), stepTarget)] : []),
			...(d.mutableRoot ? [mutableBuilder(Root)] : []),
			...(d.keyReadsLifecycle && d.lifecycles > 0 ? [keyBuilder(onBuilder(Root, ["id", "retired"]))] : [])
		],
		[]
	)
}

/** Whether ownership owns `d`'s schema: its builders admit it and own() returns it. */
const owns = (d: Declared): boolean => {
	const built = EffectResult.try(() => declared(d))
	return (
		EffectResult.isSuccess(built) &&
		Result.flatMap(parseSchemaInput(built.success), ownInput).ok
	)
}

type UnitFeature = "owned" | `refused: ${Broken}`

describe("a retirable statement at the schema door", () => {
	it.effect(
		"owns a unit exactly when its rows stay in their groups and its retirement field is its own",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/schema/retirable",
						generator: declaredGen,
						literal: Formatter.format,
						box: "Root's retirement fields, none, one or two; Step keyed with or without its group; every nonempty set of Step, Claim and Note as bodies; Claim's step into Step carried, crossed or none; Note's step into Step or none; Root mutable or not; a key reading Root's retirement field or none; a retirement field on Note or none",
						oracle: {
							kind: "specification",
							name: "the retirable statement's rules restated over the box: one retirement field, the header's; bodies keyed by their group; containments into a body from the unit carrying the group; an immutable header; no other reader of the retirement field"
						},
						coverage: requiredInSpace<UnitFeature>([
							"owned",
							"refused: the header's retirement fields are not one",
							"refused: a relation outside every header holds a retirement field",
							"refused: a body's key lacks its group",
							"refused: a containment into a body comes from outside the unit",
							"refused: a containment into a body crosses the group",
							"refused: the header is mutable",
							"refused: a key reads the retirement field"
						]),
						caseHang
					},
					(d, c) =>
						Effect.sync(() => {
							const broken = brokenOf(d)
							const owned = owns(d)
							assert.equal(
								owned,
								broken.length === 0,
								`${Formatter.format(d)} breaks ${broken.length === 0 ? "nothing" : Arr.join(broken, "; ")}`
							)
							const [only, ...more] = broken
							if (only === undefined) {
								c.note("owned")
							} else if (more.length === 0) {
								c.note(`refused: ${only}`)
							}
						})
				)
			)
	)
})
