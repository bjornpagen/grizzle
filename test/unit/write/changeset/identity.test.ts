/**
 * A ChangeSet member's identity is its Description's identity digest (ir/desc.ts descIdentity, core/fingerprint.ts
 * identityDigest), built Merkle-style over the Description's parts, each digested once however many times the
 * Description holds it: members of one stratum are ordered by their digests and one member stands for equal ones, so
 * a member whose Description shares its imports, and whose canonical text is the size of the tree that sharing expands
 * into, is placed and deduplicated in time linear in its distinct parts.
 *
 * The box, exhausted: one insert of the top of a chain of 2, 8 or 32 bound queries, each level two rules that read the
 * level below (test/unit/write/shared-imports.fixtures.ts), unioned with the same insert built again, equal and of no
 * object in common, and with a variant reading one filter more. At 32 levels the chain's canonical text would be
 * about 2^32 times a level's, past the longest string a process holds.
 *
 * Properties, per case: the union of the insert with its rebuilt twin is one member, and with the variant two; and, at
 * the depth whose canonical texts the process can write, two members are one exactly when their canonical texts are
 * (ir/desc.ts descText, the second implementation). Kill: the identity digest over the canonical text whole, which no
 * process writes at 32 levels.
 *
 * And a ChangeSet's chain of members digests each part they share once (ir/desc.ts descIdentities, core/fingerprint.ts
 * IdentityDigests, owned by the chain): over the same chains, eight inserts each reading the top of one chain digest,
 * beyond one insert, only their own parts, as many at every depth, where each member digested the whole chain again.
 * Oracle: specification, a part one member digested is never digested again. Kill: every container's token kept for
 * one member's digest alone.
 *
 * Features: a shallow chain and a deep one.
 */

import { assert } from "@bjornpagen/testing/assert"
import { finite, type Gen, int, map } from "@bjornpagen/testing/gen"
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import type { IdentityDigests } from "#compiler/core/fingerprint.ts"
import { descText } from "#compiler/ir/desc.ts"
import {
	changeSetDesc,
	changeSetOver as ChangeSet,
	changeSetState
} from "#compiler/write/changeset/value.ts"
import {
	chainReadersOf,
	chainVariantWriteOf,
	chainWriteOf
} from "#test/unit/write/shared-imports.fixtures.ts"

/** The depths of the box: 2, 8 and 32, each four times the one before. */
const depthGen: Gen<number> = map(int(0, 2), (i) => 2 * 4 ** i)

/** The canonical text of a member's Description, at a depth whose text the process writes. */
const textOf = (member: unknown): string => {
	const text = descText(member)
	if (!text.ok) {
		throw text.error
	}
	return text.value
}

/** The members of the one stratum of `value`. */
const membersOf = (value: unknown) => changeSetDesc(value)?.strata[0]?.members ?? []

/** A member's identity is its Description's identity digest, equal members one and every other apart, however large its canonical text. */
export const aMembersIdentityIsItsDescriptionsIdentityDigestEqualMembersOneAndEveryOtherApartHoweverLargeItsCanonicalText =
	property.exhaust(finite(depthGen), {
		needs: {},
		situations: ["a shallow chain", "a deep chain"],
		check: (_, k) => (depth) =>
			Effect.sync(() => {
				k.note(depth === 2 ? "a shallow chain" : "a deep chain")
				const twins = membersOf(ChangeSet.union(chainWriteOf(depth), chainWriteOf(depth)))
				assert.equal(twins.length, 1, "an insert and its rebuilt twin are one member")
				const apart = membersOf(ChangeSet.union(chainWriteOf(depth), chainVariantWriteOf(depth)))
				assert.equal(apart.length, 2, "an insert and its variant are two members")
				if (depth !== 2) {
					return
				}
				const [one] = membersOf(chainWriteOf(depth))
				const [again] = membersOf(chainWriteOf(depth))
				const [variant] = membersOf(chainVariantWriteOf(depth))
				assert.equal(textOf(one), textOf(again), "the twins' canonical texts are one")
				assert.notEqual(textOf(one), textOf(variant), "the variant's canonical text is another")
			}),
		oracle: {
			kind: "second-implementation",
			name: "the canonical texts' equality (ir/desc.ts descText), where the process can write them"
		},
		box: "an insert of the top of a chain of 2, 8 and 32 bound queries, each level two rules reading the one below, beside its rebuilt twin and a variant",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/core/fingerprint.ts",
				original: "\t\t\t\treturn mintIdentityDigest(this.#containerDigest(read, open))\n",
				replacement:
					"\t\t\t\tunwrap(writeCanonical(this.#messages.out, value, this.#options))\n\t\t\t\treturn mintIdentityDigest(this.#messages.hex())\n",
				why: "The identity digest is the canonical text's, written whole: at 32 levels the text is past the longest string a process holds, so the member is refused where the property builds it."
			}
		]
	})

/** The containers a ChangeSet's chain of members digested for their identities. */
const digestedBy = (value: unknown): number => {
	const identities: IdentityDigests | undefined = changeSetState(value)?.identities
	return identities === undefined ? 0 : identities.digested
}

/** A ChangeSet's chain of members digests each part they share once, so members past the first digest only their own parts, as many at every depth. */
export const aChangeSetsChainOfMembersDigestsEachPartTheyShareOnceSoMembersPastTheFirstDigestOnlyTheirOwnPartsAsManyAtEveryDepth =
	property.exhaust(finite(depthGen), {
		needs: {},
		situations: ["a shallow chain", "a deep chain"],
		check: (_, k) => (depth) =>
			Effect.sync(() => {
				k.note(depth === 2 ? "a shallow chain" : "a deep chain")
				const own = (d: number) =>
					digestedBy(chainReadersOf(d, 8)) - digestedBy(chainReadersOf(d, 1))
				assert.equal(
					own(depth),
					own(2),
					`the members past the first digest as many parts at depth ${depth} as at 2`
				)
			}),
		oracle: { kind: "specification", name: "a part one member digested is never digested again" },
		box: "one and eight inserts each reading the top of one chain of 2, 8 and 32 bound queries, each level two rules reading the one below",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/core/fingerprint.ts",
				original: "\t\tconst tokens = Object.isFrozen(container) ? this.#tokens : open\n",
				replacement: "\t\tconst tokens = open\n",
				why: "Each member's digest keeps its containers' tokens for itself alone, so every member digests the whole chain again and the parts members past the first digest grow with the depth."
			}
		]
	})
