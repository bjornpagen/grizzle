import { convertColumn } from "#compiler/core/decoder.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { bareEnv, carrierSql, defineField } from "#compiler/scalar/registry.ts"
import type { Sha256 } from "#compiler/scalar/values/sha256.ts"

/**
 * sha256: a SHA-256 digest, exactly 32 bytes, its host value a Sha256 (scalar/values/sha256.ts), stored as bytea under
 * the installation's digest domain, whose CHECK holds its length (physical/ddl/context.ts digestDomain). It is what
 * Crypto.sha256 yields, so `generated(sha256, Crypto.sha256(row.text))` is a digest field PostgreSQL computes from the
 * text it stores; and, unlike bytes, a value of one bounded length that bytea's B-tree and hash classes compare by its
 * bytes, so a key, a unique, a family axis and a reference hold one, and a rule, a filter and a parameter compare it. A
 * read delivers its bytes' wire text, the one text bytes travel in (core/wire.ts bytesWireAlphabet), which its column
 * converts into a fresh Sha256.
 */
export const sha256Descriptor = defineField(
	{},
	carrierSql.sha256,
	{ kind: "sha256" },
	{ column: convertColumn<Sha256>({ carrier: "sha256" }) },
	SourceLoc("sha256", []),
	bareEnv
)
