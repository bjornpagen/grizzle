import type { MemberDesc } from "#compiler/ir/desc.ts"

type SlotSpace = "member" | "slot"

/** The kinds of a compiled write's member slot: the serial class of the facts it binds. */
const serialKinds = ["none", "explicit", "generated"] as const

type SlotKind = "array" | `stream${number}` | (typeof serialKinds)[number]

/**
 * The one spelling of a write's slot identifiers: `<space>:<stratum>:<op>:<kind>:<relation>`, for a ChangeSet's member
 * inputs (space "member", kind "array" or `stream<n>`, write/changeset/value.ts) and for the parameters the compiled
 * write's member slots bind (space "slot", kind the serial class, write/frontend/compile.ts writeSlotId).
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
 * Whether `name` is spelled in the space of a compiled write's member slots (`reservedSlots`), so may be one of them:
 * every such slot's spelling begins with its space and the first colon.
 */
export const inReservedSpace = (name: string): boolean => name.startsWith("slot:")

/**
 * Every name a compiled write's member slot for the enumerated members of `op` on `relation` in `stratum` can take, one
 * per serial class: which it takes is the relation's to say (its serial fields), so a Description, which holds no
 * schema, reserves them all.
 */
export const reservedSlots = (
	stratum: number,
	op: MemberDesc["op"],
	relation: string
): ReadonlyArray<string> =>
	serialKinds.map((kind) => slotSpelling("slot", stratum, op, kind, relation))
