import { textColumn } from "#compiler/core/decoder.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { bareEnv, carrierSql, defineField } from "#compiler/scalar/registry.ts"
import type { Uuid } from "#compiler/scalar/values/uuid.ts"

/**
 * The uuid descriptor: PostgreSQL uuid, a JavaScript string in its canonical lowercase hyphenated spelling
 * (scalar/values/uuid.ts), whose host type, domain and language are Uuid. Its column is a text column over Uuid: every
 * cell is uuid_out's canonical text, so the text is the value, read without a check (decode is conversion only). Two
 * bare uuid fields are one type whatever relations they belong to; compatibility between them comes from laws, not
 * from names.
 */
export const uuidDescriptor = defineField(
	{},
	carrierSql.uuid,
	{ kind: "uuid" },
	{ column: textColumn<Uuid>() },
	SourceLoc("uuid", []),
	bareEnv
)
