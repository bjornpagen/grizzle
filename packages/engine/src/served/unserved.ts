import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { FamilyId } from "#compiler/ir/law.ts"
import type { StratumAt } from "#compiler/ir/stratum.ts"

/**
 * Why a served file holds no ChangeSet. A family write of it the host fills from a read flight, which no served write
 * holds (write/program/served.ts servedWrite): a stratum's edit of a member relation, with the families it is a member
 * of; a stratum's refill, with the families it draws again, whether a path of it reads a tree, and the most owner axes
 * one path of it rides; or a stratum's nested writes, with every family they reach. Or a member no served call can
 * supply (write/program/served-members.ts servedMembers): a Stream member, whose facts are code; a value ChangeSet.bind
 * closed with no canonical text, whose private name follows the order the ChangeSet was built in, not its declaration;
 * or two array members of one relation, whose facts one call keys alike.
 */
export type UnservedReason =
	| {
			readonly kind: "edit"
			readonly stratum: StratumAt
			readonly relation: string
			readonly families: ReadonlyArray<FamilyId>
	  }
	| {
			readonly kind: "refill"
			readonly stratum: StratumAt
			readonly families: ReadonlyArray<FamilyId>
			readonly tree: boolean
			readonly hops: number
	  }
	| {
			readonly kind: "nested"
			readonly stratum: StratumAt
			readonly families: ReadonlyArray<FamilyId>
	  }
	| { readonly kind: "stream"; readonly slot: string; readonly relation: string }
	| { readonly kind: "opaqueBinding"; readonly name: string }
	| {
			readonly kind: "repeated"
			readonly relation: string
			readonly slots: readonly [string, string]
	  }

/** A ChangeSet no served file holds, with every reason it holds none (`UnservedReason`). */
export interface UnservedMember {
	readonly _tag: "UnservedMember"
	readonly reasons: NonEmptyReadonlyArray<UnservedReason>
}
