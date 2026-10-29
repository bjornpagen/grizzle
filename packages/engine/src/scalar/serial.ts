import { type Column, convertColumn } from "#compiler/core/decoder.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { serialCarriers } from "#compiler/ir/scalar.ts"
import {
	bareEnv,
	carrierSql,
	type Descriptor,
	defineField,
	type SqlTag
} from "#compiler/scalar/registry.ts"
import { convertByCarrier } from "#compiler/scalar/values/convert.ts"

type SerialName = keyof typeof serialCarriers

export interface SerialDescriptor<
	Sql extends SqlTag = SqlTag,
	A = unknown
> extends Descriptor<Sql> {
	readonly generated: "always"
	readonly column: Column<A>
}

/** A serial's column is its integer's conversion. */
const serialDescriptor = <const N extends SerialName, A>(
	name: N,
	column: Column<A>
): SerialDescriptor<(typeof carrierSql)[(typeof serialCarriers)[N]], A> =>
	defineField(
		{},
		carrierSql[serialCarriers[name]],
		{ kind: "serial", type: name },
		{ generated: "always", column },
		SourceLoc(`pg.${name}`, []),
		bareEnv
	)

export const smallserial: SerialDescriptor<"smallint", number> = serialDescriptor(
	"smallserial",
	convertColumn(convertByCarrier.int2({ carrier: "int2" }))
)

/**
 * The serial family: pg.smallserial, pg.serial and pg.bigserial, with the serial2, serial4 and serial8 aliases.
 *
 * A serial is a column generation declaration over smallint, integer or bigint, not a value domain: it lowers to an
 * identity column GENERATED ALWAYS AS IDENTITY whose sequence the column owns, and its host values are the integer's.
 * It is no separate scalar type and no automatic UNIQUE. Being a generation declaration, it is neither a span endpoint
 * nor a contract base (a domain is a value domain, and PostgreSQL has no identity column over a domain),
 * so its capability set is its integer's without spanEndpoint, and it is discriminated from IntegerLike at the type
 * level (types/fields) and here at run time.
 */
export const serial: SerialDescriptor<"integer", number> = serialDescriptor(
	"serial",
	convertColumn(convertByCarrier.int4({ carrier: "int4" }))
)

export const bigserial: SerialDescriptor<"bigint", bigint> = serialDescriptor(
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
