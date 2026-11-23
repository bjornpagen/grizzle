/** What the properties of live-objects.test.ts read: its spaces, models and checks. */

import { appendAll } from "@bjornpagen/grizzle-text/base/array"
import { assert } from "@bjornpagen/testing/assert"
import { type Aimed, aimed, array, boolean, element, type Gen, int } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Order, Result } from "effect"
import type { DriftFound, Fact } from "#adapter/admission/drift.ts"
import { liveObjects, type UpgradeFault } from "#adapter/admission/upgrade.ts"
import type { PhysicalKind } from "#compiler/plan/migration.ts"

/**
 * The kinds of object a box's target installs, each spelled as the drift check's description spells it
 * (adapter/admission/drift.ts descriptionSelect): a function by its signature, a CHECK, a rule trigger and a table's
 * isolation trigger on a table outside the box, an index, and a table with a column of its own.
 */
type Shape = "function" | "check" | "trigger" | "isolationTrigger" | "index" | "table"

/**
 * What the database holds of one object of the target: its facts as the target's (`held`), or proven by a row of the
 * proofs, its facts compared by none (`proven`); each of its keys with a description changed (`otherwise`); none of
 * it (`absent`); its facts under another name, a format's renaming (`renamed`); or another key under its identity, a
 * function's other signature, a constraint's other name, a table's other column (`reshaped`).
 */
type Fate = "held" | "proven" | "otherwise" | "absent" | "renamed" | "reshaped"

/**
 * An object the database holds that no object of the target is: a function, an index or a generated column, which an
 * upgrade drops; and a stored column of a table outside the box or a whole table, which hold rows.
 */
type Extra = "function" | "index" | "generatedColumn" | "storedColumn" | "table"

/**
 * A box: the target's objects, each with what the database holds of it, what the database holds besides, whether it
 * holds the default an installation of format 7 or before set (drift.ts DriftFound `formerDefault`), and whether it
 * holds a slot a leader of format 7 or before made, named by its decoder login (`formerSlots`).
 */
interface Box {
	readonly objects: ReadonlyArray<{ readonly shape: Shape; readonly fate: Fate }>
	readonly extras: ReadonlyArray<Extra>
	readonly formerDefault: boolean
	readonly formerSlot: boolean
}

/** The slot a leader of format 7 or before made in a box's database, named by its decoder login. */
const formerSlot = "__live_former"

/** Each shape's kind in the target's manifest (ir/products.ts PhysicalKind). */
const kindOf: { readonly [S in Shape]: PhysicalKind } = {
	function: "lawFunction",
	check: "check",
	trigger: "lawTrigger",
	isolationTrigger: "isolationTrigger",
	index: "index",
	table: "table"
}

/** The table outside the box the constraints, triggers and indexes lie in. */
const outside = "table:s.t"

/** An object's manifest identity, by its shape and its name. */
const identOf = (shape: Shape, name: string): string => {
	switch (shape) {
		case "function":
			return `function:s.${name}`
		case "check":
			return `constraint:s.t.${name}`
		case "trigger":
		case "isolationTrigger":
			return `trigger:s.t.${name}`
		case "index":
			return `index:s.${name}`
		case "table":
			return `table:s.${name}`
	}
}

/** The facts the catalog describes an object of `shape` named `name` by, `description` its definition's. */
const factsOf = (shape: Shape, name: string, description: string): ReadonlyArray<Fact> => {
	const object = identOf(shape, name)
	switch (shape) {
		case "function":
			return [{ key: `function s.${name}(integer)`, object, within: object, description }]
		case "check":
			return [{ key: `constraint s.t.${name}`, object, within: outside, description }]
		case "trigger":
		case "isolationTrigger":
			return [{ key: `trigger s.t.${name}`, object, within: outside, description }]
		case "index":
			return [{ key: `relation s.${name}`, object, within: outside, description }]
		case "table":
			return [
				{ key: `relation s.${name}`, object, within: object, description },
				{
					key: `column s.${name}.a`,
					object: `column:s.${name}.a`,
					within: object,
					description: "integer; not null"
				}
			]
	}
}

/** The facts the database holds under an object's identity with another key than the target's (Fate reshaped). */
const reshapedOf = (shape: Shape, name: string): ReadonlyArray<Fact> => {
	const object = identOf(shape, name)
	const [first] = factsOf(shape, name, "definition")
	return shape === "table"
		? [
				...factsOf(shape, name, "definition"),
				{
					key: `column s.${name}.b`,
					object: `column:s.${name}.b`,
					within: object,
					description: "text; not null"
				}
			]
		: [
				{
					key: `${first?.key ?? object} other`,
					object,
					within: first?.within ?? object,
					description: "definition"
				}
			]
}

/** The facts of an object the database holds besides the target's, the `index`th of its extras. */
const extraFacts = (extra: Extra, index: number): ReadonlyArray<Fact> => {
	switch (extra) {
		case "function":
			return factsOf("function", `x${index}`, "definition")
		case "index":
			return factsOf("index", `xi${index}`, "definition")
		case "table":
			return factsOf("table", `xt${index}`, "kind r")
		case "generatedColumn":
			return [
				{
					key: `column s.t.g${index}`,
					object: `column:s.t.g${index}`,
					within: outside,
					description: "integer; not null; generated stored as (a + 1)"
				}
			]
		case "storedColumn":
			return [
				{
					key: `column s.t.z${index}`,
					object: `column:s.t.z${index}`,
					within: outside,
					description: "integer; not null"
				}
			]
	}
}

/** What the drift check of the box's target against its database found (adapter/admission/drift.ts DriftFound). */
const foundOf = (box: Box): DriftFound => {
	const expected: Array<Fact> = []
	const installed: Array<Fact> = []
	const proven: Array<string> = []
	for (const [index, o] of box.objects.entries()) {
		const name = `o${index}`
		const facts = factsOf(o.shape, name, "definition")
		switch (o.fate) {
			case "held":
				appendAll(expected, facts)
				appendAll(installed, facts)
				break
			case "proven":
				proven.push(identOf(o.shape, name))
				break
			case "otherwise":
				appendAll(expected, facts)
				appendAll(installed, factsOf(o.shape, name, "another definition"))
				break
			case "absent":
				appendAll(expected, facts)
				break
			case "renamed":
				appendAll(expected, facts)
				appendAll(installed, factsOf(o.shape, `${name}_old`, "definition"))
				break
			case "reshaped":
				appendAll(expected, facts)
				appendAll(installed, reshapedOf(o.shape, name))
				break
		}
	}
	for (const [index, extra] of box.extras.entries()) {
		appendAll(installed, extraFacts(extra, index))
	}
	return {
		described: new Set(Arr.map(box.objects, (o, index) => identOf(o.shape, `o${index}`))),
		proven: new Set(proven),
		expected,
		installed,
		sources: new Set(),
		privileges: [],
		policies: [],
		others: [],
		formerDefault: box.formerDefault,
		formerSlots: box.formerSlot ? [formerSlot] : []
	}
}

/** What the upgrade must find of a box: how the database holds each object, or the one fault it holds. */
type Expected =
	| {
			readonly kind: "objects"
			readonly held: ReadonlyArray<string>
			readonly stale: ReadonlyArray<string>
			readonly absent: ReadonlyArray<string>
			readonly departed: ReadonlyArray<string>
	  }
	| { readonly kind: "fault"; readonly fault: Pick<UpgradeFault, "kind" | "object"> }

/**
 * The model of a box (Expected): each object held, stale or absent by its fate alone, each renamed one's old name, each
 * dropped extra, a former database default and a former leader's slot departed; or the fault of the one object no
 * rebase may change: a table held otherwise or under another column, or departed, and a stored column, holds rows; an
 * isolation trigger held otherwise is of a kind no draft changes; any other object under another key is reshaped.
 */
const modelOf = (box: Box): Expected => {
	for (const [index, o] of box.objects.entries()) {
		const object = identOf(o.shape, `o${index}`)
		if (o.fate === "otherwise" && o.shape === "table") {
			return { kind: "fault", fault: { kind: "stored", object } }
		}
		if (o.fate === "otherwise" && o.shape === "isolationTrigger") {
			return { kind: "fault", fault: { kind: "unreplaceable", object } }
		}
		if (o.fate === "reshaped") {
			return { kind: "fault", fault: { kind: o.shape === "table" ? "stored" : "reshaped", object } }
		}
		if (o.fate === "renamed" && o.shape === "table") {
			return { kind: "fault", fault: { kind: "stored", object: identOf("table", `o${index}_old`) } }
		}
	}
	for (const [index, extra] of box.extras.entries()) {
		if (extra === "storedColumn") {
			return { kind: "fault", fault: { kind: "stored", object: outside } }
		}
		if (extra === "table") {
			return { kind: "fault", fault: { kind: "stored", object: identOf("table", `xt${index}`) } }
		}
	}
	const named = (fates: ReadonlyArray<Fate>) =>
		Arr.flatMap(box.objects, (o, index) =>
			fates.includes(o.fate) ? [identOf(o.shape, `o${index}`)] : []
		)
	return {
		kind: "objects",
		held: named(["held", "proven"]),
		stale: named(["otherwise"]),
		absent: named(["absent", "renamed"]),
		departed: [
			...Arr.flatMap(box.objects, (o, index) =>
				o.fate === "renamed" ? [identOf(o.shape, `o${index}_old`)] : []
			),
			...Arr.flatMap(box.extras, (extra, index) => {
				switch (extra) {
					case "function":
						return [identOf("function", `x${index}`)]
					case "index":
						return [identOf("index", `xi${index}`)]
					case "generatedColumn":
						return [`column:s.t.g${index}`]
					case "storedColumn":
					case "table":
						return []
				}
			}),
			...(box.formerDefault ? ["databaseDefault:default_transaction_isolation"] : []),
			...(box.formerSlot ? [`liveSlot:${formerSlot}`] : [])
		]
	}
}

const shapes = ["function", "check", "trigger", "isolationTrigger", "index", "table"] as const

/** The fates no object of `shape` is refused for. */
const rebased = (shape: Shape): readonly [Fate, ...Array<Fate>] =>
	shape === "table"
		? ["held", "proven", "absent"]
		: shape === "isolationTrigger"
			? ["held", "proven", "absent", "renamed"]
			: ["held", "proven", "otherwise", "absent", "renamed"]

/** An object of the target whose fate no rebase refuses. */
const rebasedObject: Gen<Box["objects"][number]> = (source) => {
	const shape = source.draw(element(shapes))
	return { shape, fate: source.draw(element(rebased(shape))) }
}

/** A box no part of which is refused: objects of rebased fates, and extras an upgrade drops. */
const rebasedBox: Gen<Box> = (source) => ({
	objects: source.draw(array(rebasedObject, { min: 1, max: 6 })),
	extras: source.draw(
		array(element(["function", "index", "generatedColumn"] as const), { min: 0, max: 3 })
	),
	formerDefault: source.draw(boolean),
	formerSlot: source.draw(boolean)
})

/** A box with one part no rebase may change, at a drawn place among rebased ones. */
const refusedBox: Gen<Box> = (source) => {
	const box = source.draw(rebasedBox)
	const refused = source.draw(
		element([
			{ shape: "table", fate: "otherwise" },
			{ shape: "table", fate: "reshaped" },
			{ shape: "table", fate: "renamed" },
			{ shape: "isolationTrigger", fate: "otherwise" },
			{ shape: "function", fate: "reshaped" },
			{ shape: "check", fate: "reshaped" },
			{ extra: "storedColumn" },
			{ extra: "table" }
		] as const)
	)
	if ("extra" in refused) {
		return { ...box, extras: [...box.extras, refused.extra] }
	}
	const at = source.draw(int(0, box.objects.length))
	return {
		...box,
		objects: [...box.objects.slice(0, at), refused, ...box.objects.slice(at)]
	}
}

/** A box with an object of each fate a rebase carries, each extra it drops among them, and a former database default. */
const everyFateBox: Gen<Box> = (source) => ({
	objects: [
		{ shape: "function", fate: "otherwise" },
		{ shape: "check", fate: "renamed" },
		{ shape: "index", fate: "absent" },
		{ shape: "trigger", fate: "proven" },
		...source.draw(array(rebasedObject, { min: 0, max: 2 }))
	],
	extras: [
		"generatedColumn",
		...source.draw(array(element(["function", "index"] as const), { min: 0, max: 2 }))
	],
	formerDefault: true,
	formerSlot: true
})

export type LiveFeature =
	| "an object held"
	| "an object proven by its row"
	| "an object held otherwise"
	| "an object absent"
	| "an object renamed"
	| "a departed object"
	| "a departed generated column"
	| "a former database default departed"
	| "a former leader's slot departed"
	| "a stored table refused"
	| "an unreplaceable kind refused"
	| "an object under another key refused"

/** The drawn boxes, aimed at a refused part and at every fate a rebase carries. */
export const boxSpace: Aimed<Box, LiveFeature> = aimed(rebasedBox, [
	["a stored table refused", refusedBox],
	["an unreplaceable kind refused", refusedBox],
	["an object under another key refused", refusedBox],
	["a departed generated column", everyFateBox],
	["a former database default departed", everyFateBox],
	["a former leader's slot departed", everyFateBox],
	["an object renamed", everyFateBox]
])

/** Sets as sorted lists, so a comparison reads no order. */
const sorted = (items: Iterable<string>): ReadonlyArray<string> =>
	Arr.sort([...items], Order.String)

/** liveObjects finds of each box exactly what the model says the database holds, or the model's one fault. */
export const judgedCase = (box: Box, c: Case<LiveFeature>) =>
	Effect.sync(() => {
		const kinds = new Map(
			Arr.map(box.objects, (o, index) => [identOf(o.shape, `o${index}`), kindOf[o.shape]] as const)
		)
		const judged = liveObjects(kinds, foundOf(box))
		const expected = modelOf(box)
		if (expected.kind === "fault") {
			assert.ok(
				Result.isFailure(judged),
				`refused: ${expected.fault.kind} ${expected.fault.object}`
			)
			if (Result.isFailure(judged)) {
				assert.deepEqual(
					{ kind: judged.failure.kind, object: judged.failure.object },
					expected.fault,
					"the fault the model finds"
				)
			}
			c.note(
				expected.fault.kind === "stored"
					? "a stored table refused"
					: expected.fault.kind === "unreplaceable"
						? "an unreplaceable kind refused"
						: "an object under another key refused"
			)
			return
		}
		assert.ok(Result.isSuccess(judged), "no part of the box is refused")
		if (Result.isFailure(judged)) {
			return
		}
		const found = judged.success
		assert.deepEqual(sorted(found.held), sorted(expected.held), "held")
		assert.deepEqual(sorted(found.stale), sorted(expected.stale), "stale")
		assert.deepEqual(sorted(found.absent), sorted(expected.absent), "absent")
		assert.deepEqual(
			sorted(Arr.map(found.departed, (d) => d.object)),
			sorted(expected.departed),
			"departed"
		)
		for (const o of box.objects) {
			c.note(
				(
					{
						held: "an object held",
						proven: "an object proven by its row",
						otherwise: "an object held otherwise",
						absent: "an object absent",
						renamed: "an object renamed",
						reshaped: "an object under another key refused"
					} as const
				)[o.fate]
			)
		}
		if (expected.departed.length > 0) {
			c.note("a departed object")
		}
		if (box.extras.includes("generatedColumn")) {
			c.note("a departed generated column")
		}
		if (box.formerDefault) {
			c.note("a former database default departed")
		}
		if (box.formerSlot) {
			c.note("a former leader's slot departed")
		}
	})
