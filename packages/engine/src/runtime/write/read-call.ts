/**
 * A call's member facts read once, by the write's own readers, before any share of the call is drawn (packages/grizzle
 * adapter/apply/shares.ts): each slot's facts as normalization reads them, a flat slot's by its member's normalizer
 * (codec/recordset.ts RelationNormalizer `read`), a nested slot's each by the nesting's reader (nesting.ts nestedReader),
 * the slots in the order normalization meets them (normalize.ts normalizeChangeSet), so the first refusal is the one
 * the bind would meet, placed at its slot. A caller's value is read once, and what the read returns is all of the value
 * anything after it sees (core/host.ts): a share's bytes and its groups are the read's, never the caller's facts'.
 *
 * A share's facts, and the whole call's where it is bound whole after all, are taken as an array of the read's own,
 * frozen, holding the caller's facts and recording their reads, as decode records a decoded array's (decoded.ts), so the
 * bind of the array takes the reads and reads no fact again (normalize.ts admit, nesting.ts nestedRows). A slot whose
 * facts decode admitted is read off decode's reads, as its bind would take them.
 */

import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import { encodeFailure, slotPlace } from "#compiler/codec/fault.ts"
import type { RelationNormalizer } from "#compiler/codec/recordset.ts"
import type { EncodingFailure } from "#compiler/core/errors.ts"
import { hostRead } from "#compiler/core/host.ts"
import { isRecord } from "#compiler/core/record.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import {
	additionSplitter,
	levelOrder,
	type NestedReading,
	type NestingLevels
} from "#compiler/runtime/write/addition.ts"
import type { PreparedBinding } from "#compiler/runtime/write/binding.ts"
import {
	type DecodedInput,
	keptReadings,
	keptReads,
	recordDecoded
} from "#compiler/runtime/write/decoded.ts"
import {
	type NestingData,
	nestedReader,
	nestingLevels,
	type ReadLevel
} from "#compiler/runtime/write/nesting.ts"
import type { MemberFacts } from "#compiler/runtime/write/normalize.ts"
import type { HeadingPlan, ReadFact } from "#compiler/scalar/values/identity.ts"

/**
 * The bytes a value takes on the host, as a share counts them: a text's code units, a binary value's bytes, a scalar's
 * eight, and a container's elements, each field's name with it. A share counts a read value (`SlotReads` bytes), which
 * runs none of the caller's code.
 */
export const valueBytes = (value: unknown): number => {
	if (typeof value === "string") {
		return value.length + 1
	}
	if (value instanceof Uint8Array) {
		return value.byteLength + 1
	}
	if (Array.isArray(value)) {
		let sum = 1
		for (const element of value) {
			sum += valueBytes(element)
		}
		return sum
	}
	if (value instanceof Set) {
		let sum = 1
		for (const element of value) {
			sum += valueBytes(element)
		}
		return sum
	}
	if (isRecord(value)) {
		let sum = 1
		for (const [name, field] of Object.entries(value)) {
			sum += name.length + valueBytes(field)
		}
		return sum
	}
	return 8
}

/** One slot's facts as the call's one read found them (see the header), each by its position in the slot. */
export interface SlotReads {
	/** How many facts the slot holds. */
	readonly count: number
	/** The bytes fact `at` takes as it was read: each of its levels' fields' names and read values (`valueBytes`). */
	readonly bytes: (at: number) => number
	/**
	 * The value fact `at` was read to hold at field `name` of its own heading, a nested fact's top level, as its field's
	 * carrier admitted it; undefined where its heading holds no such field.
	 */
	readonly field: (at: number, name: string) => unknown
	/**
	 * The facts at positions `ats`, in that order, as the write takes them: the caller's facts in an array of the read's
	 * own, frozen, recording their reads (decoded.ts), whose bind takes the reads and reads no fact again.
	 */
	readonly take: (ats: ReadonlyArray<number>) => ReadonlyArray<unknown>
}

/** The bytes one read fact takes under the plan it was read by: its fields' names and values, and its container's. */
const readBytes = (plan: HeadingPlan, read: ReadFact): number => {
	let sum = 1
	for (const [at, entry] of plan.entries.entries()) {
		sum += entry.name.length + valueBytes(read.values[at])
	}
	return sum
}

/** Each field's position among a plan's read values, by name. */
const positions = (plan: HeadingPlan): ReadonlyMap<string, number> =>
	new Map(plan.entries.map((entry, at) => [entry.name, at] as const))

/** The facts at `ats` of `facts`, as the write takes them (`SlotReads` take), their reads `input`. */
const taken = (
	facts: ReadonlyArray<unknown>,
	ats: ReadonlyArray<number>,
	input: DecodedInput
): ReadonlyArray<unknown> => {
	const rows = Object.freeze(ats.map((at) => facts[at]))
	recordDecoded(rows, input)
	return rows
}

/**
 * The caller's facts of a slot as an array of the read's own, its iteration the one read of the caller's list, or the
 * slot's shape refusal where iterating it throws.
 */
const listed = (
	slot: string,
	given: Iterable<unknown>
): Result.Result<ReadonlyArray<unknown>, EncodingFailure> =>
	hostRead(
		() => encodeFailure("factShape", slotPlace(slot)),
		() => Result.ok(Array.from(given))
	)

/** A flat slot's facts read by its member's normalizer, or decode's reads of them where decode admitted them. */
const flatReads = (
	slot: string,
	normalize: RelationNormalizer,
	given: Iterable<unknown>
): Result.Result<SlotReads, EncodingFailure> => {
	const plan = normalize.plan
	const kept = keptReads(given, plan)
	const read: Result.Result<
		{ readonly facts: ReadonlyArray<unknown>; readonly reads: ReadonlyArray<ReadFact> },
		EncodingFailure
	> =
		kept !== undefined && Array.isArray(given)
			? Result.ok({ facts: given, reads: kept })
			: Result.flatMap(listed(slot, given), (facts) =>
					Result.map(normalize.read(facts), (relation) => ({ facts, reads: relation.reads }))
				)
	return Result.map(read, ({ facts, reads }) => {
		const at = positions(plan)
		const one = (i: number): ReadFact => defined(reads[i], "a read of each fact of the slot")
		return {
			count: reads.length,
			bytes: (i) => readBytes(plan, one(i)),
			field: (i, name) => {
				const k = at.get(name)
				return k === undefined ? undefined : one(i).values[k]
			},
			take: (ats) => taken(facts, ats, { kind: "flat", plan, reads: ats.map(one) })
		}
	})
}

/**
 * A nested slot's facts each read by the nesting's reader over its levels (nesting.ts nestingLevels), or decode's
 * readings of them where decode admitted them, which stand at decode's levels.
 */
const nestedReads = (
	slot: string,
	nesting: NestingData,
	codes: Codebook,
	given: Iterable<unknown>
): Result.Result<SlotReads, EncodingFailure> => {
	const levels = nestingLevels(nesting, slot, codes)
	const kept = keptReadings(given, levels)
	const found: Result.Result<
		{
			readonly facts: ReadonlyArray<unknown>
			readonly readings: ReadonlyArray<NestedReading<unknown>>
			readonly levels: NestingLevels<ReadLevel>
		},
		EncodingFailure
	> =
		kept !== undefined && Array.isArray(given)
			? Result.ok({ facts: given, readings: kept.readings, levels: kept.levels })
			: Result.flatMap(listed(slot, given), (facts) => {
					const reader = nestedReader(nesting.relation, levels, additionSplitter(nesting.sequences))
					const readings: Array<NestedReading<unknown>> = []
					for (const fact of facts) {
						const one = reader(fact)
						if (!one.ok) {
							return Result.err(levels.own.normalize.place(one.error))
						}
						readings.push(one.value)
					}
					return Result.ok({ facts, readings, levels })
				})
	return Result.map(found, ({ facts, readings, levels: at }) => {
		const plans: NestingLevels<HeadingPlan> = {
			own: at.own.normalize.plan,
			members: new Map([...at.members].map(([id, level]) => [id, level.normalize.plan] as const))
		}
		const ownAt = positions(plans.own)
		const one = (i: number): NestedReading<unknown> =>
			defined(readings[i], "a reading of each fact of the slot")
		return {
			count: readings.length,
			bytes: (i) => {
				const reading = one(i)
				const order = levelOrder(plans, reading.shape)
				let sum = 0
				for (const [k, { read }] of reading.reads.entries()) {
					const { level } = defined(order[order.length - 1 - k], "a level of each read")
					sum += readBytes(level, read)
				}
				return sum
			},
			field: (i, name) => {
				const k = ownAt.get(name)
				const reads = one(i).reads
				return k === undefined ? undefined : reads[reads.length - 1]?.read.values[k]
			},
			take: (ats) => taken(facts, ats, { kind: "nested", plans, readings: ats.map(one) })
		}
	})
}

/**
 * Every member slot's facts of a call of the write `prepared` binds, read once (see the header), in normalization's
 * order of its groups, their inputs and their members; or the first refusal, at its slot. A slot the call holds no facts
 * for is refused at its shape, as normalization refuses it.
 */
export const readCall = (
	prepared: PreparedBinding,
	codes: Codebook,
	members: MemberFacts
): Result.Result<ReadonlyMap<string, SlotReads>, EncodingFailure> => {
	const out = new Map<string, SlotReads>()
	for (const group of prepared.groups) {
		for (const input of group.inputs) {
			for (const member of input.members) {
				const given = members.get(member.name)
				if (given === undefined) {
					return Result.err(encodeFailure("factShape", slotPlace(member.name)))
				}
				const read =
					input.kind === "single"
						? flatReads(member.name, member.normalize, given)
						: nestedReads(member.name, input.nesting, codes, given)
				if (!read.ok) {
					return read
				}
				out.set(member.name, read.value)
			}
		}
	}
	return Result.ok(out)
}
