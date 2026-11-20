import type * as Result from "@bjornpagen/grizzle-text/base/result"
import { nominal } from "#compiler/core/brand.ts"
import { catchRefusal, everyProperty, Refusal } from "#compiler/core/canonical.ts"
import { type CompileError, malformedArtifact } from "#compiler/core/errors.ts"
import { ownedDigest } from "#compiler/core/fingerprint.ts"
import type { ReplayedObject } from "#compiler/deploy/admission/manifest.ts"
import type { InstallationManifest } from "#compiler/ir/products.ts"

/**
 * The drift check's proofs (adapter/admission/drift.ts, deploy/ledger/ledger.ts proofsTable).
 *
 * The drift check judges an installed object by what PostgreSQL describes of it, the facts it reads of the catalog:
 * its relation, its columns, its constraint, its function's header. That description is what PostgreSQL deparses of
 * the catalog the object's statements leave over the objects they are created after: a view's definition reads its
 * tables' columns, a foreign key its target's key, a column its domain. So an object's proof digest digests its
 * replayed statements (manifest.ts ReplayedObject) and the proof digests of every object the manifest's edges create
 * it after, every object its statements name among them (physical/obligations/graph.ts namedEdges), under the environment, everything else a description is a function of: the server, the role the replay
 * runs as, every extension's version, the description statement's own text and the installation's names (drift.ts
 * proofEnvironment). Two objects of one digest are described alike by any server of that environment, so a description
 * a drift check verified once stands proven for every later installation whose object has its digest, and a change of
 * the object, of anything it is created after, or of the environment is a new digest, which proves nothing.
 *
 * Neither the objects created after it nor its place in the install order enter it: an index a migration adds over a
 * table leaves the table's digest as it was.
 */

/** A proof digest (proofDigests): 64 lowercase hex digits. */
export type ProofDigest = string & { readonly [proofDigestBrand]: true }
declare const proofDigestBrand: unique symbol

const proofDigest = nominal<string, ProofDigest>()

/** The manifest's edges by the object each creates after another: each object's own `from`s. */
const createdAfter = (
	edges: InstallationManifest["edges"]
): ReadonlyMap<string, ReadonlyArray<string>> => {
	const after = new Map<string, Array<string>>()
	for (const edge of edges) {
		const known = after.get(edge.to)
		if (known === undefined) {
			after.set(edge.to, [edge.from])
		} else {
			known.push(edge.from)
		}
	}
	return after
}

/** A manifest whose edge names an object it does not hold before the object created after it. */
const unordered = (ident: string, from: string): Refusal =>
	new Refusal(
		malformedArtifact(
			"manifest",
			["edges", ident],
			`objects in install order, each after ${from}, which it is created after`
		)
	)

/** An object of the manifest with its proof digest. */
export interface ProvedObject {
	readonly object: ReplayedObject
	readonly digest: ProofDigest
}

/**
 * Each object with its proof digest, in install order (see the header): SHA-256 in the domain `drift-proof` over its
 * identity, its replayed statements, the environment and the digests of the objects it is created after, in code point
 * order, computed in install order, so every object it is created after has its digest first. A manifest whose edge
 * names an object it does not hold before the object created after it is refused as MalformedArtifact.
 */
export const proofDigests = (
	objects: ReadonlyArray<ReplayedObject>,
	edges: InstallationManifest["edges"],
	environment: string
): Result.Result<ReadonlyArray<ProvedObject>, CompileError> =>
	catchRefusal(() => {
		const after = createdAfter(edges)
		const digests = new Map<string, ProofDigest>()
		return objects.map((o): ProvedObject => {
			const before = (after.get(o.ident) ?? []).map((from) => {
				const digest = digests.get(from)
				if (digest === undefined) {
					throw unordered(o.ident, from)
				}
				return digest
			})
			const digest = proofDigest(
				ownedDigest(
					"drift-proof",
					{
						environment,
						ident: o.ident,
						statements: o.statements,
						after: before.toSorted()
					},
					everyProperty
				)
			)
			digests.set(o.ident, digest)
			return { object: o, digest }
		})
	})

/**
 * What the drift check replays to describe `unproven` (drift.ts): every object it names and every object one of them is
 * created after, transitively, by the manifest's edges, in install order, which is what PostgreSQL needs to create each
 * and all its description reads. Nothing else: an object no unproven one is created after stays unreplayed.
 */
export const replayedOver = (
	objects: ReadonlyArray<ReplayedObject>,
	edges: InstallationManifest["edges"],
	unproven: ReadonlySet<string>
): ReadonlyArray<ReplayedObject> => {
	const after = createdAfter(edges)
	const needed = new Set<string>()
	const pending = [...unproven]
	for (let ident = pending.pop(); ident !== undefined; ident = pending.pop()) {
		if (needed.has(ident)) {
			continue
		}
		needed.add(ident)
		for (const from of after.get(ident) ?? []) {
			pending.push(from)
		}
	}
	return objects.filter((o) => needed.has(o.ident))
}
