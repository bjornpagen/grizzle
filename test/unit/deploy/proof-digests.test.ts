/**
 * The drift check's proof digests (deploy/admission/proof.ts proofDigests, replayedOver): an object's digest digests
 * its replayed statements, the digests of the objects it is created after and the environment, so a drift check
 * replays exactly what a proof no longer covers.
 *
 * - **Property:** over every pair of the shop's histories, a version and one at or after it (none before the first),
 *   the objects of the later version whose digest the earlier's digests do not hold are exactly the tainted ones the
 *   specification names (test/support/migrate/proofs.ts specifiedTainted), the replay over them is the specification's
 *   (specifiedReplay), and another environment changes every object's digest.
 * - **Oracle:** specification: the objects compared by the canonical text of their replayed statements and the objects
 *   they are created after, read off the two manifests, never digested.
 * - **Box, exhausted:** each later version of the shop's three over each earlier, the empty snapshot among them.
 * - **Features:** a first version, a changed version, an unchanged one, and the environment's change.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { finite, type Gen, int } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Order } from "effect"
import { manifestStatements } from "#compiler/deploy/admission/manifest.ts"
import { proofDigests, replayedOver } from "#compiler/deploy/admission/proof.ts"
import type { DeploySnapshot } from "#compiler/deploy/snapshot/types.ts"
import { parseIdent } from "#compiler/physical/obligations/graph.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { firstCodes } from "#test/support/compile.ts"
import { atName } from "#test/support/kernel/naming.ts"
import { draftChain, fromEmpty, noDeclarations, ownedBy } from "#test/support/migrate/kit.ts"
import { specifiedReplay, specifiedTainted } from "#test/support/migrate/proofs.ts"
import { shopV1, shopV2, shopV3, shopV3Declared } from "#test/unit/deploy/schemas.ts"

/** A pair of the shop's versions: the one the proofs were recorded at (0, none) and one at or after it. */
interface Pair {
	readonly proven: number
	readonly now: number
}

const pairGen: Gen<Pair> = (source) => {
	const now = source.draw(int(1, 3))
	return { proven: source.draw(int(0, now)), now }
}

type DigestFeature =
	| "a first version"
	| "a changed version"
	| "an unchanged version"
	| "another environment"

/** The shop's three versions drafted in one chain under one schema, each over the one before. */
const chain: ReadonlyArray<DeploySnapshot> = Arr.map(
	draftChain(
		Arr.map(
			[
				[shopV1, noDeclarations],
				[shopV2, noDeclarations],
				[shopV3, shopV3Declared]
			] as const,
			([desc, declared]) => ({
				desc,
				options: {
					schema: atName("proof_digests"),
					owner: ownedBy("proof_digests_owner"),
					extensions: [],
					codes: firstCodes
				},
				declared
			})
		),
		fromEmpty
	),
	(g) => g.snapshot
)

/** Each object's proof digest of `snapshot` under `environment`, by identity. */
const digestsOf = (snapshot: DeploySnapshot, environment: string): ReadonlyMap<string, string> =>
	new Map(
		Arr.map(
			succeeded(
				proofDigests(
					succeeded(manifestStatements(snapshot)).objects,
					snapshot.manifest.edges,
					environment
				)
			),
			(p) => [p.object.ident, p.digest] as const
		)
	)

/** The kinds of manifest identity no description names (adapter/admission/drift.ts describedKinds' complement). */
const undescribed: ReadonlyArray<string> = [
	"extension",
	"role",
	"membership",
	"privileges",
	"publication",
	"other"
]

/** The proof digests change exactly where the specification says a proof no longer covers an object. */
export const proofDigestsChangeExactlyWhereAProofNoLongerCoversAnObject = property.exhaust(
	finite(pairGen),
	{
		needs: {},
		situations: [
			"a first version",
			"a changed version",
			"an unchanged version",
			"another environment"
		] satisfies ReadonlyArray<Reached<DigestFeature>>,
		check: (_, c: Case<DigestFeature>) => (pair) =>
			Effect.sync(() => {
				const now = defined(chain[pair.now - 1], "a drafted version")
				const proven = pair.proven === 0 ? undefined : defined(chain[pair.proven - 1], "a version")
				c.note(
					proven === undefined
						? "a first version"
						: pair.proven === pair.now
							? "an unchanged version"
							: "a changed version"
				)
				const environment = "the environment"
				const after = digestsOf(now, environment)
				const before =
					proven === undefined ? new Map<string, string>() : digestsOf(proven, environment)
				const moved = new Set(
					Arr.flatMap([...after], ([ident, digest]) =>
						before.get(ident) === digest ? [] : [ident]
					)
				)
				assert.deepEqual(
					Arr.sort([...moved], Order.String),
					Arr.sort([...specifiedTainted(proven, now)], Order.String),
					"the digests that moved are exactly the objects a proof no longer covers"
				)
				const objects = succeeded(manifestStatements(now)).objects
				const unproven = new Set(
					Arr.filter([...moved], (ident) =>
						Arr.every(undescribed, (kind) => kind !== parseIdent(ident).kind)
					)
				)
				assert.deepEqual<ReadonlyArray<string>>(
					Arr.map(replayedOver(objects, now.manifest.edges, unproven), (o) => o.ident),
					specifiedReplay(proven, now),
					"the replay is every unproven object and every object one is created after"
				)
				const elsewhere = digestsOf(now, "another environment")
				assert.ok(
					Arr.every([...after], ([ident, digest]) => elsewhere.get(ident) !== digest),
					"another environment moves every digest"
				)
				c.note("another environment")
			}),
		oracle: {
			kind: "specification",
			name: "the objects a proof no longer covers, compared by the canonical text of their statements and what they are created after"
		},
		box: "each later version of the shop's three over each earlier one, the empty snapshot among them",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/deploy/admission/proof.ts",
				original: "\t\t\t\t\t\tafter: before.toSorted()",
				replacement: "\t\t\t\t\t\tafter: []",
				why: "An object's digest is blind to what it is created after, so a changed table's indexes and views keep their proofs."
			},
			{
				file: "packages/engine/src/deploy/admission/proof.ts",
				original: "\t\t\t\t\t\tstatements: o.statements,\n",
				replacement: "",
				why: "An object's digest is blind to its own statements, so a changed object keeps its proof."
			},
			{
				file: "packages/engine/src/deploy/admission/proof.ts",
				original: "\t\t\t\t\t\tenvironment,\n",
				replacement: "",
				why: "A digest is blind to the environment, so a proof another server's or another extension's description made stands."
			}
		]
	}
)
