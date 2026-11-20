/**
 * The names of public/fields.ts the schema agreement's generated program reads as Fi
 * (test/support/agreement/schemas.ts), its prelude (test/support/prelude.ts): the program reads that namespace through
 * this module alone.
 */
export {
	accumulated,
	bits,
	Bits,
	closedId,
	contract,
	date,
	Decimal,
	drawn,
	generated,
	Money,
	natural,
	pg,
	slot,
	span,
	uuid,
	Uuid,
	Vector
} from "#compiler/public/fields.ts"
export type {
	AccumulatedField,
	BitsField,
	CalendarDate,
	ClosedIdField,
	Contract,
	DateField,
	DrawnField,
	Field,
	FieldBase,
	Infer,
	LiteralOf,
	NaturalField,
	NumericField,
	NumericTypmodField,
	Span,
	SpanEndpointLike,
	SpanField,
	VectorField
} from "#compiler/public/fields.ts"
export { Id } from "#test/support/ids.ts"
