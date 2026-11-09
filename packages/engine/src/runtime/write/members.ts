/**
 * The facts a served change's call gives (adapter/db/workload.ts): its array members' facts, keyed by the op that adds
 * each member and then the relation it writes, read once at the boundary into the facts of the member slots the
 * compiled write binds (write/normalize/normalize.ts MemberFacts).
 */
import { encodeFailure, factPlace, slotPlace } from "#compiler/codec/fault.ts"
import type { EncodingFailure } from "#compiler/core/errors.ts"
import { hostRead } from "#compiler/core/host.ts"
import { isList, isPlainRecord } from "#compiler/core/record.ts"
import * as Result from "#compiler/core/result.ts"
import type { MemberAt } from "#compiler/runtime/write/binding.ts"

/** An array member of a served change: the name of the member slot its facts travel in, the op that adds it and the
 * relation it writes as the ChangeSet names it, the keys a call gives its facts under. No two of a served change's array
 * members are of one op and one relation (write/program/served-members.ts servedMembers). */
export interface ArrayMember {
	readonly slot: string
	readonly op: MemberAt["op"]
	readonly relation: string
}

/** The facts each member slot of a served change's call supplies, by the slot's name. */
export type CallFacts = ReadonlyMap<string, ReadonlyArray<unknown>>

const unshaped = (): EncodingFailure => encodeFailure("factShape", factPlace)

/** The relations of `members` under each op that adds one. */
const relationsByOp = (
	members: ReadonlyArray<ArrayMember>
): ReadonlyMap<string, ReadonlySet<string>> => {
	const out = new Map<string, Set<string>>()
	for (const member of members) {
		const relations = out.get(member.op) ?? new Set<string>()
		relations.add(member.relation)
		out.set(member.op, relations)
	}
	return out
}

/** Whether `record` holds a key outside `keys`. */
const strayKey = (record: Readonly<Record<string, unknown>>, keys: ReadonlySet<string>): boolean =>
	Object.keys(record).some((key) => !keys.has(key))

/**
 * The member facts of a served change's call, read once at the boundary: a plain record holding, under each op of an
 * array member, a plain record holding under each relation of that op's members an array of that member's facts, and no
 * other key at either level. A value that is no plain record, an op's value that is none, or a key that names no array
 * member's op or no relation of its op's members, is refused as factShape at the facts; a member's relation its op holds
 * no array under, at the member's slot; a getter that throws as it is read, at the facts. Each op's record is read once.
 * Each fact is admitted later, by its slot's normalizer, as every write's is.
 */
export const memberFactsOf = (
	facts: unknown,
	members: ReadonlyArray<ArrayMember>
): Result.Result<CallFacts, EncodingFailure> =>
	hostRead(unshaped, () => {
		if (!isPlainRecord(facts)) {
			return Result.err(unshaped())
		}
		const ops = relationsByOp(members)
		if (strayKey(facts, new Set(ops.keys()))) {
			return Result.err(unshaped())
		}
		const byOp = new Map<string, Readonly<Record<string, unknown>>>()
		for (const [op, relations] of ops) {
			const given = facts[op]
			if (!isPlainRecord(given) || strayKey(given, relations)) {
				return Result.err(unshaped())
			}
			byOp.set(op, given)
		}
		const out = new Map<string, ReadonlyArray<unknown>>()
		for (const member of members) {
			const given = byOp.get(member.op)?.[member.relation]
			if (!isList(given)) {
				return Result.err(encodeFailure("factShape", slotPlace(member.slot)))
			}
			out.set(member.slot, given)
		}
		return Result.ok(out)
	})
