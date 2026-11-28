import { assert } from "@bjornpagen/testing/assert"
import { Array as Arr, String as Str } from "effect"
import { maxStringLength } from "#compiler/core/canonical.ts"
import { isRecord } from "#compiler/core/record.ts"
import { int4 } from "#compiler/public/fields.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { queryOver as query, varsOver as v } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { changeSetOver as ChangeSet, type ChangeSetValue } from "#compiler/write/changeset/value.ts"

/** Note(id, body): a body of a's and b's, keyed by id. */
const Note = relation("Note", { id: int4, body: str.regex("^[ab]*$") }, ["id"])

const Notes = schema("BoundNotes", [Note], [])

/** The notes inserted as the relation parameter `notes` binds them. */
export const inserted = (): ChangeSetValue =>
	ChangeSet.empty(Notes).insert(
		Note,
		query(Notes).rule((r: RuleValue) => {
			const { id, body } = v(Note, "note")
			return r.match(r.relation("notes", Note), { id, body }).find({ id, body })
		})
	)

/** The notes' count, each body's length, and the box's lengths: one small, and the least whose seven bodies pass the
 * longest string. */
export const count = 7

export const lengths = [4, Math.floor(maxStringLength / count) + 1] as const

/**
 * How long one case of the past-the-longest-string property may run: its four cases past V8's longest string build
 * seven bodies of 76,695,842 units each and key two ChangeSets' bindings by their canonical tokens, honest work the
 * bound itself sets (core/canonical.ts maxStringLength), which a full suite's load stretches past the runner's minute.
 *
 * @limitKind measured
 * @owner test/unit/write/changeset/bound-identity.test.ts, the past-the-longest-string property's cases
 * @unit milliseconds of a case's CPU, and of its stall window
 * @scope one case of that property, on one small-stack worker of toolchain-test's pool
 * @evidence alone: `toolchain-test run` of the property by id (~/.cache/grizzle/unitreds-logs/bound1.log), its eight
 *   cases; under the full suite: trunk@grizzle's runs at f6182478 (the case held its worker 105 s of wall time) and at
 *   52ab3f572 (its guard read 60.7 s of CPU against the 60 s budget), ~/.local/state/trunk/grizzle/runs/
 * @observed 2026-11-21: alone 18:1x UTC; trunk 17:0x and 21:3x UTC
 * @environment cassowary, Ubuntu 26.04 arm64, 64 cores, every other session's runs on the machine; Node 26.13.1,
 *   toolchain 620084d (alone) and b15c24f (the 52ab3f572 run, whose watchdog names the leg it ends a case by)
 * @workload the property's eight cases, four at a body of 4 units and four past the longest string
 * @result alone 3.0 s of CPU a case on average, about 6 s for each case past the longest string, 1.2 GB of memory at
 *   most; under the full suite one such case spent 60.7 s of CPU, about ten times its own. Contention for cores alone
 *   stretches a case's wall time, not its CPU: a tenfold CPU points at memory pressure in that worker, its collector
 *   thrashing over the bodies' half gigabyte or its pages faulted back in, which TOOLCHAIN6's memory-pressure item
 *   carries (~/.cache/grizzle-release/handoff/TOOLCHAIN6/HANDOVER.md)
 * @decision five minutes: fifty times the 6 s a case past the longest string spends alone and five times the most a
 *   full suite was seen to stretch it to, so a case still running at five minutes is hung, not slow
 * @revalidate a change to a ChangeSet's binding or keying of bound values (write/changeset/value.ts), to canonical
 *   tokens (core/canonical.ts), or to the length bound; a different machine; a run that loses this property's worker
 */
export const pastLongestStringDeadline = 300_000

export interface BoundCase {
	readonly length: (typeof lengths)[number]
	readonly values: "equal" | "different"
	readonly order: "a-ending first" | "b-ending first"
}

/** Seven notes at `length`, the last ending in `last`, every other body one shared string of a's. */
export const notesOf = (
	shared: string,
	last: "a" | "b"
): ReadonlyArray<{ readonly id: number; readonly body: string }> =>
	Arr.makeBy(count, (i) => ({
		id: i + 1,
		body: i === count - 1 ? `${Str.slice(1)(shared)}${last}` : shared
	}))

/** The last letter of the last note's body of a bound relation input. */
export const lastLetter = (value: unknown): string => {
	if (!Arr.isArray(value)) {
		return assert.fail("a relation input's notes")
	}
	const last: unknown = value.at(-1)
	const body = isRecord(last) ? last["body"] : undefined
	return typeof body === "string" ? Str.slice(-1)(body) : assert.fail("a note's body")
}

export type BoundFeature =
	| "past the longest string"
	| "equal values"
	| "different values"
	| "either order"
