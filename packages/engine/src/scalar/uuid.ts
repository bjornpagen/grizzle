import { convertColumn } from "#compiler/core/decoder.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { bareEnv, carrierSql, defineField } from "#compiler/scalar/registry.ts"
import { convertByCarrier } from "#compiler/scalar/values/convert.ts"

/**
 * The uuid descriptor: PostgreSQL uuid, a JavaScript string in its canonical lowercase
 * hyphenated spelling (scalar/values/uuid.ts). Two bare uuid fields are one type whatever relations they belong to;
 * compatibility between them comes from laws, not from names.
 */
export const uuidDescriptor = defineField(
	{},
	carrierSql.uuid,
	{ kind: "uuid" },
	{ column: convertColumn(convertByCarrier.uuid({ carrier: "uuid" })) },
	SourceLoc("uuid", []),
	bareEnv
)
