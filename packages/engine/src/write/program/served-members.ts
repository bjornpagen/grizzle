/**
 * Which members of a workload's ChangeSet a served call can supply (runtime/write/members.ts): `grizzle generate` serves
 * a change only where every input its members read outside their Description is the call's to give, and refuses the
 * rest by name.
 */
import { canonicalTokens, everyProperty } from "#compiler/core/canonical.ts"
import { isNonEmpty } from "#compiler/core/nonempty.ts"
import * as Result from "#compiler/core/result.ts"
import type { ArrayMember } from "#compiler/runtime/write/members.ts"
import type { ParamValue } from "#compiler/types/core/phantom.ts"
import type { MemberAt } from "#compiler/write/program/binding.ts"
import type { UnservedMember, UnservedReason } from "#compiler/write/program/served.ts"

/**
 * The array members a served call of a workload's ChangeSet supplies (`ArrayMember`), its members as its binding holds
 * them (binding.ts MemberAt) and its bound values by their private names, or every reason a call cannot supply one
 * (`UnservedMember`): its members' in their strata's order, then its bound values' in their names' order.
 */
export const servedMembers = (
	members: ReadonlyArray<MemberAt>,
	bound: ReadonlyMap<string, ParamValue>
): Result.Result<ReadonlyArray<ArrayMember>, UnservedMember> => {
	const byRelation = new Map<string, string>()
	const served: Array<ArrayMember> = []
	const reasons: Array<UnservedReason> = []
	for (const member of members) {
		if (member.kind === "stream") {
			reasons.push({ kind: "stream", slot: member.slot, relation: member.relation })
			continue
		}
		const earlier = byRelation.get(member.relation)
		if (earlier !== undefined) {
			reasons.push({ kind: "repeated", relation: member.relation, slots: [earlier, member.slot] })
			continue
		}
		byRelation.set(member.relation, member.slot)
		served.push({ slot: member.slot, relation: member.relation })
	}
	for (const name of [...bound.keys()].toSorted()) {
		if (!canonicalTokens(bound.get(name), everyProperty).ok) {
			reasons.push({ kind: "opaqueBinding", name })
		}
	}
	return isNonEmpty(reasons) ? Result.err({ _tag: "UnservedMember", reasons }) : Result.ok(served)
}
