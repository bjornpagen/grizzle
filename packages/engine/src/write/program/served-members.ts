/**
 * Which members of a workload's ChangeSet a served call can supply (runtime/write/members.ts): `grizzle generate` serves
 * a change only where every input its members read outside their Description is the call's to give, and refuses the
 * rest by name.
 */
import { isNonEmpty } from "#compiler/core/nonempty.ts"
import * as Result from "#compiler/core/result.ts"
import type { MemberAt } from "#compiler/runtime/write/binding.ts"
import type { ArrayMember } from "#compiler/runtime/write/members.ts"
import type { UnservedMember, UnservedReason } from "#compiler/served/unserved.ts"

/**
 * The array members a served call of a workload's ChangeSet supplies (`ArrayMember`), its members as its binding holds
 * them (binding.ts MemberAt) and the private names of the values its bind read with no canonical text, in their order
 * (write/changeset/value.ts ParsedChangeSet opaque), or every reason a call cannot supply one (`UnservedMember`): its
 * members' in their strata's order, then those bound values'.
 */
export const servedMembers = (
	members: ReadonlyArray<MemberAt>,
	opaque: ReadonlyArray<string>
): Result.Result<ReadonlyArray<ArrayMember>, UnservedMember> => {
	const slots = new Map<MemberAt["op"], Map<string, string>>()
	const served: Array<ArrayMember> = []
	const reasons: Array<UnservedReason> = []
	for (const member of members) {
		if (member.kind === "stream") {
			reasons.push({ kind: "stream", slot: member.slot, relation: member.relation })
			continue
		}
		const byRelation = slots.get(member.op) ?? new Map<string, string>()
		slots.set(member.op, byRelation)
		const earlier = byRelation.get(member.relation)
		if (earlier !== undefined) {
			reasons.push({
				kind: "repeated",
				op: member.op,
				relation: member.relation,
				slots: [earlier, member.slot]
			})
			continue
		}
		byRelation.set(member.relation, member.slot)
		served.push({ slot: member.slot, op: member.op, relation: member.relation })
	}
	for (const name of opaque) {
		reasons.push({ kind: "opaqueBinding", name })
	}
	return isNonEmpty(reasons) ? Result.err({ _tag: "UnservedMember", reasons }) : Result.ok(served)
}
