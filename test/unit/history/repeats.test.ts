/**
 * The host write models judge a fact stated twice by the relation's key, never by its multiplicity: a ChangeSet's facts
 * are a set by identity, and a stored relation holds each fact once because its primary key's law refuses a second
 * fact at one key.
 *
 * The space is exhaustive: Worker holds nothing or (1, a); a write inserts one or two facts drawn from (1, a), (1, b)
 * and (2, a), repeats included, the two in one member or in two, through a grizzle writer or a direct one; and the
 * host states Worker's primary key's law or does not. The oracle is the rule written naively:
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
import { element, type Gen } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Order, Result } from "effect"
import { assert, nonEmpty } from "#test/support/assert.ts"
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

const facts: Arr.NonEmptyReadonlyArray<HostFact> = [
	{ id: 1, name: "a" },
	{ id: 1, name: "b" },
	{ id: 2, name: "a" }
]

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
	readonly members: Arr.NonEmptyReadonlyArray<Arr.NonEmptyReadonlyArray<HostFact>>
}

/** Every write of one or two facts, the two in one member or in two. */
const writes: ReadonlyArray<Arr.NonEmptyReadonlyArray<Arr.NonEmptyReadonlyArray<HostFact>>> = [
	...Arr.map(facts, (f): Arr.NonEmptyReadonlyArray<Arr.NonEmptyReadonlyArray<HostFact>> => [[f]]),
	...Arr.flatMap(facts, (f) =>
		Arr.flatMap(
			facts,
			(g): ReadonlyArray<Arr.NonEmptyReadonlyArray<Arr.NonEmptyReadonlyArray<HostFact>>> => [
				[[f, g]],
				[[f], [g]]
			]
		)
	)
]

const cases: ReadonlyArray<RepeatCase> = [
	...Arr.flatMap(["grizzle", "direct"] as const, (writer) =>
		Arr.flatMap(["keyed", "unkeyed"] as const, (schema) =>
			Arr.flatMap([[], [facts[0]]], (stored) =>
				Arr.map(writes, (members): RepeatCase => ({ writer, schema, stored, members }))
			)
		)
	)
]

const caseGen: Gen<RepeatCase> = element(nonEmpty(cases, "the repeat cases"))

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
	const ids = Arr.map(after, (t) => t.split("/")[0])
	if (new Set(ids).size < ids.length) {
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
		"over every write of up to two Worker facts, from each state, through each writer",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/history/repeats",
						generator: caseGen,
						literal: Formatter.format,
						/**
						 * The space holds 168 cases (2 writers, 2 hosts, 2 states, 21 writes); the limit is the cap against a
						 * space grown by mistake.
						 */
						limit: 300,
						box: "every write of one or two Worker facts from three, each split, state, writer and host",
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
								if (got.kind !== "invariant-rejected") {
									assert.deepEqual(stateTexts(got.state), expected.state)
								}
							}
							k.noteAll(featuresOf(c, expected))
						})
				)
			)
	)
})
