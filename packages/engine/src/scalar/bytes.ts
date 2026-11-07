import { type Column, convertColumn } from "#compiler/core/decoder.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { bareEnv, carrierSql, defineField } from "#compiler/scalar/registry.ts"
import type { Bytes } from "#compiler/scalar/values/bytes.ts"
import { convertByCarrier } from "#compiler/scalar/values/convert.ts"

/** PostgreSQL's bytea's column, which bytes values are read by: byteaout under bytea_output = hex. */
const column: Column<Bytes> = convertColumn(convertByCarrier.bytes({ carrier: "bytes" }))

/**
 * bytes: PostgreSQL's bytea, its host value a Uint8Array over an ArrayBuffer of its own (scalar/values/bytes.ts). A value
 * is written and read back whole, and that is all: its one capability is storage, so no key, unique or containment
 * holds a bytes field, and no rule, selection, filter, computation, parameter, generated field, fold or check reads one.
 * It is written in binary and read as byteaout's hex text, and a value is at most core/limits.ts bytesMaxLength bytes,
 * whose hex text one string holds; every stored bytes column carries the CHECK of that bound (physical/bytes/storage.ts).
 */
export const bytesDescriptor = defineField(
	{},
	carrierSql.bytes,
	{ kind: "bytes" },
	{ column },
	SourceLoc("bytes", []),
	bareEnv
)
