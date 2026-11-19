/** What the properties of laws.test.ts read: its focus, its requirements and its leads. */
import type { Situations } from "@bjornpagen/testing/features"

import { Array as Arr, Option } from "effect"
import { assert } from "#test/support/assert.ts"
import { isImmediate } from "#test/support/laws/model.ts"
import { witnessesShowTheirOwn } from "#test/support/worlds/drive/acting.ts"
import {
	everyWriter,
	type Focus,
	invalidFeatures,
	opIn,
	requiredWhere,
	type StepCheck
} from "#test/support/worlds/drive/suite.ts"
import type { WorldFeature } from "#test/support/worlds/model/types.ts"

/**
 * Every law of the documents base (a foreign key, a candidate key, a row check, a contract's domain CHECK, and every
 * relation's primary key, each a native constraint) under every writer: grizzle's Db through whole and query entries, and direct SQL writers that took on a
 * role. Programs draw writes, live, stale and wild, with laws broken by the facts they submit, by facts outside the
 * writer's world, by references to hidden or deleted facts and by duplicates within one input; the worlds model judges
 * each outcome, and the driver holds every committed state, read as the owner, to the model's lawful
 * reality.
 *
 * Beside the model, two rules of the README are held directly: a refusal's shown witness carries only keys the writer
 * submitted (in its transaction, or through its claims) and keys of relations its role holds whole; and a law a direct
 * writer breaks at COMMIT is one checked at COMMIT, never an immediate law (a key, a span key, a row check), which
 * refuses at its statement.
 */
export const writes: Focus = [
	"open-db",
	"apply",
	"read",
	"close",
	"direct-begin",
	"direct",
	"direct-end"
]

/** The invalid inputs a law meets: facts that break it, outside the world, colliding with or naming hidden facts. */
const lawInputs = invalidFeatures([
	"fact:law-broken",
	"fact:outside-world",
	"fact:hidden-key-collision",
	"fact:hidden-reference",
	"fact:deleted-reference",
	"fact:duplicate-in-input",
	"fact:domain-refused"
])

const refusedByLaw = opIn({
	kinds: ["apply", "direct", "direct-end"],
	writers: everyWriter,
	observations: ["invariant-rejected", "law-refused"]
})

const committed = opIn({
	kinds: ["apply", "direct-end"],
	writers: everyWriter,
	observations: ["applied", "ok"]
})

/**
 * A law a direct writer breaks at COMMIT is checked at COMMIT: never a key, a span key, a row check or a containment
 * whose foreign key is immediate.
 */
const deferredAtCommit: StepCheck = ({ seen }) => {
	const o = seen.observation
	if (seen.action.kind !== "direct-end" || o.kind !== "law-refused") {
		return
	}
	Option.match(
		Arr.findFirst(seen.before.host.laws, (l) => l.law === o.law),
		{
			onNone: () =>
				assert.fail(`action ${seen.index}: the COMMIT names ${o.law}, no law of the installation`),
			onSome: (law) => {
				assert.ok(
					!isImmediate(seen.before.host, law),
					`action ${seen.index}: the COMMIT names ${o.law}, a law checked at its statement`
				)
			}
		}
	)
}

export const required: Situations<WorldFeature> = [
	...requiredWhere((f: WorldFeature) => refusedByLaw(f) || committed(f)),
	...lawInputs
]

/** Both rules the README states beside the model, held over every action of the suite. */
export const besideTheModel: StepCheck = (checked) => {
	witnessesShowTheirOwn(checked)
	deferredAtCommit(checked)
}
