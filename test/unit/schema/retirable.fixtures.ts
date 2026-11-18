/** What the properties of retirable.test.ts read: its spaces, models and helpers. */

import { boolean, element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Result as EffectResult } from "effect"
import * as Result from "#compiler/core/result.ts"
import { parseSchemaInput } from "#compiler/program/schema.ts"
import { pg } from "#compiler/public/fields.ts"
import { relationBuilder as relation, retirementField } from "#compiler/schema/relation.ts"
import { schemaBuilder as schema } from "#compiler/schema/schema.ts"
import {
	containedBuilder,
	keyBuilder,
	mutableBuilder,
	onBuilder,
	retirableBuilder
} from "#compiler/schema/statements.ts"
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

export const declaredGen: Gen<Declared> = (source) => ({
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
	| "the header is mutable"
	| "a key reads the retirement field"

/** The rules `d` breaks, by the statement's documentation restated over the box. */
export const brokenOf = (d: Declared): ReadonlyArray<Broken> => {
	const body = (name: BodyName): boolean => d.bodies.includes(name)
	return [
		...(d.lifecycles === 1 ? [] : ["the header's retirement fields are not one" as const]),
		...(d.stray ? ["a relation outside every header holds a retirement field" as const] : []),
		...(body("Step") && !d.stepKeyed ? ["a body's key lacks its group" as const] : []),
		...(d.mutableRoot ? ["the header is mutable" as const] : []),
		...(d.keyReadsLifecycle && d.lifecycles > 0
			? ["a key reads the retirement field" as const]
			: [])
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
	const sides = {
		Step: onBuilder(Step, ["root"]),
		Claim: onBuilder(Claim, ["root"]),
		Note: onBuilder(Note, ["root"])
	}
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
			...(d.noteRef && d.stepKeyed
				? [containedBuilder(onBuilder(Note, ["root", "step"]), stepTarget)]
				: []),
			...(d.mutableRoot ? [mutableBuilder(Root)] : []),
			...(d.keyReadsLifecycle && d.lifecycles > 0
				? [keyBuilder(onBuilder(Root, ["id", "retired"]))]
				: [])
		],
		[]
	)
}

/** Whether ownership owns `d`'s schema: its builders admit it and own() returns it. */
export const owns = (d: Declared): boolean => {
	const built = EffectResult.try(() => declared(d))
	return (
		EffectResult.isSuccess(built) && Result.flatMap(parseSchemaInput(built.success), ownInput).ok
	)
}

export type UnitFeature =
	| "owned"
	| "owned: a containment into a body from outside the unit"
	| "owned: a containment into a body crossing the group"
	| `refused: ${Broken}`

/** How a declaration contains rows into a body beyond its unit's own carried groups: from a relation outside the unit,
 * or crossing the group; each owns, and refuses only a retirement of a group its rows reference. */
export const containedBeyond = (
	d: Declared
): ReadonlyArray<Extract<UnitFeature, `owned: ${string}`>> => {
	const body = (name: BodyName): boolean => d.bodies.includes(name)
	return [
		...(d.stepKeyed &&
		body("Step") &&
		((d.claimRef !== "none" && !body("Claim")) || (d.noteRef && !body("Note")))
			? ["owned: a containment into a body from outside the unit" as const]
			: []),
		...(d.stepKeyed && body("Step") && body("Claim") && d.claimRef === "crossed"
			? ["owned: a containment into a body crossing the group" as const]
			: [])
	]
}
