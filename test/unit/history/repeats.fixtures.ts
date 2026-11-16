/** What the properties of repeats.test.ts read: its spaces, models and helpers. */

import { array, boolean, codePoint, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Order } from "effect"
import { expectFor, type WriterKind } from "#test/support/history/model.ts"
import { wild } from "#test/support/kernel/naming.ts"
import {
	everyFact,
	type Expected,
	type HostFact,
	type HostOp,
	type HostRelation,
	type HostSchema,
	type HostState,
	valueText
} from "#test/support/laws/model.ts"

/** The host model's own label for Worker's primary key's law, never compared with a production name. */
export const law = wild.lawId("the Worker key")

const worker: HostRelation = {
	name: "Worker",
	table: "worker",
	fields: [
		{ name: "id", column: "id" },
		{ name: "name", column: "name" }
	],
	key: ["id"],
	serial: [],
	mutable: false
}

const keyed: HostSchema = {
	relations: [worker],
	laws: [{ kind: "key", law, relation: "Worker", fields: ["id"], selection: everyFact }]
}

const unkeyed: HostSchema = { relations: [worker], laws: [] }

const factText = (f: HostFact): string =>
	`${valueText(f["id"] ?? "")}/${valueText(f["name"] ?? "")}`

/** A state's facts as text, sorted: a keyed set of them is this list with no text twice. */
export const stateTexts = (s: HostState): ReadonlyArray<string> =>
	Arr.sort(Arr.map(s.get("Worker") ?? [], factText), Order.String)

interface RepeatCase {
	readonly writer: WriterKind
	readonly schema: "keyed" | "unkeyed"
	readonly stored: ReadonlyArray<HostFact>
	/** The write's members, each a list of facts inserted into Worker. */
	readonly members: ReadonlyArray<ReadonlyArray<HostFact>>
}

/** The box's bound on Worker's ids and on its names. */
const keys = 2

/** A name of the box: `a` or `b`. */
const nameGen: Gen<string> = codePoint(0x61, 0x61 + keys - 1)

/** A fact of the box: an id and a name, each of two. */
const factGen: Gen<HostFact> = (source) => ({
	id: source.draw(int(1, keys)),
	name: source.draw(nameGen)
})

/** A stored state Worker's key admits: at each id, no fact or one of a drawn name. */
const storedGen: Gen<ReadonlyArray<HostFact>> = (source) =>
	Arr.flatMap(Arr.range(1, keys), (id) =>
		source.draw(boolean) ? [{ id, name: source.draw(nameGen) }] : []
	)

/** Every case of the box: a writer, a host, a stored state, and a write of one or two members of one or two facts. */
export const caseGen: Gen<RepeatCase> = (source) => ({
	writer: source.draw(boolean) ? "direct" : "grizzle",
	schema: source.draw(boolean) ? "unkeyed" : "keyed",
	stored: source.draw(storedGen),
	members: source.draw(array(array(factGen, { min: 1, max: 2 }), { min: 1, max: 2 }))
})

/** What the naive rule expects: the key's refusal, or the state after with whether it changed. */
type Naive =
	| { readonly kind: "refused" }
	| { readonly kind: "accepted" | "no-change"; readonly state: ReadonlyArray<string> }

export const naive = (c: RepeatCase): Naive => {
	const written = Arr.flatten(c.members)
	const storedTexts = new Set(Arr.map(c.stored, factText))
	if (c.writer === "direct") {
		const met: Array<HostFact> = [...c.stored]
		for (const row of written) {
			if (Arr.some(met, (m) => m["id"] === row["id"])) {
				return { kind: "refused" }
			}
			met.push(row)
		}
		return { kind: "accepted", state: Arr.sort(Arr.map(met, factText), Order.String) }
	}
	const after = [...new Set([...storedTexts, ...Arr.map(written, factText)])]
	const keys = new Set(
		Arr.map(
			Arr.filter([...c.stored, ...written], (f) => after.includes(factText(f))),
			(f) => valueText(f["id"] ?? "")
		)
	)
	if (keys.size < after.length) {
		return { kind: "refused" }
	}
	return {
		kind: after.length === storedTexts.size ? "no-change" : "accepted",
		state: Arr.sort(after, Order.String)
	}
}

export type RepeatFeature =
	| "an identical fact folded"
	| "a shared key refused"
	| "an exact repeat refused"
	| "an unkeyed host refused"

export const featuresOf = (c: RepeatCase, expected: Naive): ReadonlyArray<RepeatFeature> => {
	const texts = Arr.map(Arr.flatten(c.members), factText)
	const repeated =
		new Set(texts).size < texts.length || Arr.some(c.stored, (f) => texts.includes(factText(f)))
	if (c.writer === "grizzle") {
		return expected.kind === "refused"
			? ["a shared key refused"]
			: repeated
				? ["an identical fact folded"]
				: []
	}
	return expected.kind === "refused" && repeated ? ["an exact repeat refused"] : []
}

export const outcomeOf = (c: RepeatCase): Expected =>
	expectFor(
		c.writer,
		c.schema === "keyed" ? keyed : unkeyed,
		new Map([["Worker", c.stored]]),
		Arr.map(c.members, (member): HostOp => ({ relation: "Worker", kind: "insert", facts: member }))
	)
