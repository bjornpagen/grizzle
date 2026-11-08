/**
 * The host write models judge a fact stated twice by the relation's key, never by its multiplicity: a ChangeSet's facts
 * are a set by identity, and a stored relation holds each fact once because its primary key's law refuses a second
 * fact at one key.
 *
 * The space is exhaustive over a box: a fact is an id of two and a name of two, so two facts share a key, are one
 * fact, or neither; Worker holds at most one fact at each id; a write is one or two members, each inserting one or two
 * facts, repeats included, through a grizzle writer or a direct one; and the host states Worker's primary key's law
 * or does not. The oracle is the rule written naively:
 *
 * - a grizzle write's facts are one set by identity, so an identical fact stated twice, in one member or across two, is
 *   one fact; two facts at one key with different identities, or a fact at a stored fact's key with another identity,
 *   are refused by the key's law; otherwise the state is S ∪ A, unchanged when S holds A already;
 * - a direct writer inserts row by row, so a row at an occupied key, an exact repeat of a stored or an earlier row
 *   included, is refused by the key's law, as PostgreSQL's unique index refuses it;
 * - a host that states no law for Worker's primary key is refused by both models before they judge anything, so no
 *   state holding a fact twice ever passes its laws.
 */

import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { array, boolean, codePoint, type Gen, int } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Order, Result } from "effect"
import { assert } from "#test/support/assert.ts"
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
import { caseHang } from "#test/support/limits.ts"

/** The host model's own label for Worker's primary key's law, never compared with a production name. */
const law = wild.lawId("the Worker key")

const worker: HostRelation = {
	name: "Worker",
	table: "worker",
	fields: [
		{ name: "id", column: "id" },
		{ name: "name", column: "name" }
	],
	key: ["id"],
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
const stateTexts = (s: HostState): ReadonlyArray<string> =>
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
const caseGen: Gen<RepeatCase> = (source) => ({
	writer: source.draw(boolean) ? "direct" : "grizzle",
	schema: source.draw(boolean) ? "unkeyed" : "keyed",
	stored: source.draw(storedGen),
	members: source.draw(array(array(factGen, { min: 1, max: 2 }), { min: 1, max: 2 }))
})

/** What the naive rule expects: the key's refusal, or the state after with whether it changed. */
type Naive =
	| { readonly kind: "refused" }
	| { readonly kind: "accepted" | "no-change"; readonly state: ReadonlyArray<string> }

const naive = (c: RepeatCase): Naive => {
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

type RepeatFeature =
	| "an identical fact folded"
	| "a shared key refused"
	| "an exact repeat refused"
	| "an unkeyed host refused"

const featuresOf = (c: RepeatCase, expected: Naive): ReadonlyArray<RepeatFeature> => {
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

const outcomeOf = (c: RepeatCase): Expected =>
	expectFor(
		c.writer,
		c.schema === "keyed" ? keyed : unkeyed,
		new Map([["Worker", c.stored]]),
		Arr.map(c.members, (member): HostOp => ({ relation: "Worker", kind: "insert", facts: member }))
	)

describe("the host write models judge a repeated fact by its key", () => {
	it.effect(
		"over every write of up to two members of up to two Worker facts, from each state, through each writer",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/history/repeats",
						generator: caseGen,
						literal: Formatter.format,
						/**
						 * The space holds 15,120 cases (2 writers, 2 hosts, 9 states, 420 writes); the limit is the cap against a
						 * space grown by mistake.
						 */
						limit: 16_000,
						box: "every write of one or two members of one or two Worker facts over two ids and two names, from every state the key admits, through each writer, under each host",
						oracle: {
							kind: "specification",
							name: "the identity-set and key rule, written naively (naive)"
						},
						coverage: requiredInSpace<RepeatFeature>([
							"an identical fact folded",
							"a shared key refused",
							"an exact repeat refused",
							"an unkeyed host refused"
						]),
						caseHang
					},
					(c, k) =>
						Effect.sync(() => {
							const outcome = Result.try(() => outcomeOf(c))
							if (c.schema === "unkeyed") {
								assert.ok(
									Result.isFailure(outcome),
									"a host without its primary key's law is refused"
								)
								k.note("an unkeyed host refused")
								return
							}
							const expected = naive(c)
							const got = Result.getOrThrow(outcome)
							if (expected.kind === "refused") {
								assert.ok(
									got.kind === "invariant-rejected" &&
										Arr.some(got.violations, (v) => v.law === law),
									`refused by the key's law, not ${got.kind}`
								)
							} else {
								assert.equal(got.kind, expected.kind)
								if (got.kind === "accepted" || got.kind === "no-change") {
									assert.deepEqual(stateTexts(got.state), expected.state)
								}
							}
							k.noteAll(featuresOf(c, expected))
						})
				)
			)
	)
})
