import { everyProperty } from "#compiler/core/canonical.ts"
import { constantDigest } from "#compiler/core/fingerprint.ts"
import { type Identity, identity } from "#compiler/core/identity.ts"
import type { RosterCodec } from "#compiler/ir/codes.ts"

/**
 * A roster's names constant's identity, as the oracle predicts the real installer names it: the naming door's
 * rosterConstant over the digest of the roster's names in code order, a hole the empty name, under the fingerprint
 * domain "roster-names" with every property hashed. A changed name, a new handle or a new hole is a new digest, so a
 * new function.
 */
export const rosterNamesIdentity = (codes: RosterCodec): Identity<"rosterConstant"> =>
	identity.rosterConstant(codes.roster, constantDigest("roster-names", codes.names, everyProperty))
