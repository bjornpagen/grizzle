import type { MemberDesc } from "#compiler/ir/desc.ts"

type SlotSpace = "member" | "slot"

/** A slot's kind: a ChangeSet member input's transport, `array` or `stream<n>`, or `none`, a compiled write's slot. */
type SlotKind = "array" | `stream${number}` | "none"

/**
 * The one spelling of a write's slot identifiers: `<space>:<stratum>:<op>:<kind>:<relation>`, for a ChangeSet's member
 * inputs (space "member", kind "array" or `stream<n>`, write/changeset/value.ts) and for the parameters the compiled
 * write's member slots bind (space "slot", kind "none", write/frontend/compile.ts writeSlotId).
 *
 * The join is injective. The space and the kind are closed words, the stratum a non-negative integer's decimal digits,
 * and the op a closed word (insert, delete, put), none of which holds a colon, so the first four colons end those four
 * fields and the relation name is the whole remainder, whatever it holds. Two slots with one spelling therefore agree in
 * every part.
 */
export const slotSpelling = (
	space: SlotSpace,
	stratum: number,
	op: MemberDesc["op"],
	kind: SlotKind,
	relation: string
): string => `${space}:${stratum}:${op}:${kind}:${relation}`

/**
 * Whether `name` is spelled in the space of a compiled write's member slots (`reservedSlot`), so may be one of them:
 * every such slot's spelling begins with its space and the first colon.
 */
export const inReservedSpace = (name: string): boolean => name.startsWith("slot:")

/** The name a compiled write's member slot for the enumerated members of `op` on `relation` in `stratum` takes. */
export const reservedSlot = (stratum: number, op: MemberDesc["op"], relation: string): string =>
	slotSpelling("slot", stratum, op, "none", relation)
