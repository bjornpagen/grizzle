import { bytesColumn } from "#compiler/core/decoder.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { bareEnv, carrierSql, defineField } from "#compiler/scalar/registry.ts"

/**
 * bytes: PostgreSQL's bytea, its host value a Uint8Array over an ArrayBuffer of its own (scalar/values/bytes.ts). A value
 * is written and read back whole, and that is all: its one capability is storage, so no key, unique or containment
 * holds a bytes field, and no rule, selection, filter, computation, parameter, generated field, fold or check reads one.
 * It is written in binary and delivered in chunks, which the statement's delivery assembles into the value
 * (codec/delivery.ts); a write returns only its SHA-256 digest, its identity (scalar/values/bytes.ts BytesDigest). A
 * value is at most core/limits.ts bytesMaxLength bytes, the longest bytea, so its column needs no CHECK.
 */
export const bytesDescriptor = defineField(
	{},
	carrierSql.bytes,
	{ kind: "bytes" },
	{ column: bytesColumn },
	SourceLoc("bytes", []),
	bareEnv
)
