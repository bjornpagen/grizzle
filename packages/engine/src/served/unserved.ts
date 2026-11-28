import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import type { ArrayMember } from "#compiler/runtime/write/members.ts"

/**
 * Why a served file holds no ChangeSet: a member no served call can supply (write/program/served-members.ts
 * servedMembers): a value ChangeSet.bind closed with no canonical text, whose
 * private name follows the order the ChangeSet was built in, not its declaration; or two array members of one op and
 * one relation, in two strata, whose facts one call keys alike.
 */
export type UnservedReason =
	| { readonly kind: "opaqueBinding"; readonly name: string }
	| {
			readonly kind: "repeated"
			readonly op: ArrayMember["op"]
			readonly relation: string
			readonly slots: readonly [string, string]
	  }

/** A ChangeSet no served file holds, with every reason it holds none (`UnservedReason`). */
export interface UnservedMember {
	readonly _tag: "UnservedMember"
	readonly reasons: NonEmptyReadonlyArray<UnservedReason>
}
