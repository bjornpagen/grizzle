/**
 * The facts a served change's call gives (adapter/db/workload.ts): its array members' facts, keyed by the relation each
 * member writes, as a ChangeSet's insertAll takes them, read once at the boundary into the facts of the member slots the
 * compiled write binds (write/normalize/normalize.ts MemberFacts).
 */
import { encodeFailure, factPlace, slotPlace } from "#compiler/codec/fault.ts"
import type { EncodingFailure } from "#compiler/core/errors.ts"
import { hostRead } from "#compiler/core/host.ts"
import { isList, isPlainRecord } from "#compiler/core/record.ts"
import * as Result from "#compiler/core/result.ts"

/** An array member of a served change: the name of the member slot its facts travel in, and the relation it writes as
 * the ChangeSet names it, the key a call gives its facts under. No two of a served change's array members write one
 * relation (write/program/served-members.ts servedMembers). */
export interface ArrayMember {
	readonly slot: string
	readonly relation: string
}

/** The facts each member slot of a served change's call supplies, by the slot's name. */
export type CallFacts = ReadonlyMap<string, ReadonlyArray<unknown>>

const unshaped = (): EncodingFailure => encodeFailure("factShape", factPlace)

/**
 * The member facts of a served change's call, read once at the boundary: a plain record holding, under each array
 * member's relation, an array of that member's facts, and no other key. A value that is no plain record, or a key that
 * names no array member, is refused as factShape at the facts; a member's relation the record holds no array under, at
 * the member's slot; a getter that throws as it is read, at the facts. Each fact is admitted later, by its slot's
 * normalizer, as every write's is.
 */
export const memberFactsOf = (
	facts: unknown,
	members: ReadonlyArray<ArrayMember>
): Result.Result<CallFacts, EncodingFailure> =>
	hostRead(unshaped, () => {
		if (!isPlainRecord(facts)) {
			return Result.err(unshaped())
		}
		const relations = new Set(members.map((m) => m.relation))
		if (Object.keys(facts).some((key) => !relations.has(key))) {
			return Result.err(unshaped())
		}
		const out = new Map<string, ReadonlyArray<unknown>>()
		for (const member of members) {
			const given = facts[member.relation]
			if (!isList(given)) {
				return Result.err(encodeFailure("factShape", slotPlace(member.slot)))
			}
			out.set(member.slot, given)
		}
		return Result.ok(out)
	})
