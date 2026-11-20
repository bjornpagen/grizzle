import type { Need } from "@bjornpagen/testing/property"
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { Context, Effect, Layer } from "effect"
import { Digest } from "effect/crypto"

/**
 * Node's Digest service (the sha256 every document set and written package records), built once per worker: a check
 * provides it to what it runs with Effect.provideService(Digest.Digest, digest).
 */
export const digestService: Need<Digest.Digest["Service"]> = {
	key: "test/support/digest.ts digestService",
	open: Effect.map(
		Effect.map(Layer.build(NodeCrypto.layerDigest), Context.get(Digest.Digest)),
		(digest) => Effect.succeed(digest)
	)
}
