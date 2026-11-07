import { type Column, convertColumn } from "#compiler/core/decoder.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { serialCarriers } from "#compiler/ir/scalar.ts"
import { bareEnv, carrierSql, type Descriptor, defineField } from "#compiler/scalar/registry.ts"
import { convertByCarrier } from "#compiler/scalar/values/convert.ts"

type SerialName = keyof typeof serialCarriers

/**
 * A serial's descriptor: its integer's Description, and its column its integer's conversion, whose field is written by
 * its sequence. `writing` is the member a field's writing is read from: a relation records the field's type as the
 * integer's, and how it is written as serial.
 */
const serialDescriptor = <const N extends SerialName, A>(
	name: N,
	column: Column<A>
): Descriptor<(typeof carrierSql)[(typeof serialCarriers)[N]]> & {
	readonly writing: "serial"
	readonly column: Column<A>
} => {
	const sql = carrierSql[serialCarriers[name]]
	return defineField(
		{},
		sql,
		{ kind: "pg", type: sql },
		{ writing: "serial", column },
		SourceLoc(`pg.${name}`, []),
		bareEnv
	)
}

const smallserial = serialDescriptor(
	"smallserial",
	convertColumn(convertByCarrier.int2({ carrier: "int2" }))
)

/**
 * The serial family: pg.smallserial, pg.serial and pg.bigserial, with the serial2, serial4 and serial8 aliases.
 *
 * A serial is a field of smallint, integer or bigint written by its sequence: it lowers to an identity column GENERATED
 * ALWAYS AS IDENTITY whose sequence the column owns, and its type and host values are the integer's. It is no separate
 * scalar type and no automatic UNIQUE. How a field is written is the field's, never its type's, so its type is the
 * integer's and its descriptor says it is serial by `writing`, which the type level (types/fields) and the relation
 * builder read.
 */
const serial = serialDescriptor("serial", convertColumn(convertByCarrier.int4({ carrier: "int4" })))

const bigserial = serialDescriptor(
	"bigserial",
	convertColumn(convertByCarrier.int8({ carrier: "int8" }))
)

/** PostgreSQL's spellings of the family, each the one descriptor it names. */
export const serialAliases = {
	smallserial,
	serial2: smallserial,
	serial,
	serial4: serial,
	bigserial,
	serial8: bigserial
} as const
