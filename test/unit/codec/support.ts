import type { Result } from "effect"
import { type ScalarCodec, scalarCodec } from "#compiler/codec/scalar.ts"
import type { Carrier, ScalarType } from "#compiler/ir/scalar.ts"
import { plainType, wildcardText } from "#compiler/scalar/compute/types.ts"
import type { CarrierHost } from "#compiler/scalar/values/identity.ts"
import { f } from "#test/support/fixtures/ir/desc.ts"
import { scalarOf } from "#test/support/fixtures/ir/scalar.ts"
import { type StrictFault, strictReader } from "#test/support/kernel/strict.ts"

/**
 * Descriptors and helpers shared by the codec tests (test/unit/codec and test/pg/codec).
 */
const hasCarrier = <C extends Carrier>(
	t: ScalarType,
	carrier: C
): t is ScalarType & { readonly carrier: C } => t.carrier === carrier

/** A registry type with its carrier in its static type, so a codec over it reads that carrier's host values. */
const ofCarrier = <C extends Carrier>(
	carrier: C,
	t: ScalarType
): ScalarType & { readonly carrier: C } => {
	if (!hasCarrier(t, carrier)) {
		throw new Error(`a codec test type of carrier ${carrier} is a ${t.carrier}`)
	}
	return t
}

/**
 * The scalar types the codec tests read, each the one the registry builds (fixtures/ir/scalar.ts): every capability set
 * a codec meets is production's.
 */
export const types = {
	int2: ofCarrier("int2", plainType("int2")),
	int4: ofCarrier("int4", plainType("int4")),
	int8: ofCarrier("int8", plainType("int8")),
	numeric: ofCarrier("numeric", plainType("numeric")),
	numeric72: ofCarrier("numeric", scalarOf(f.numeric(7, 2), {})),
	numeric52: ofCarrier("numeric", scalarOf(f.numeric(5, 2), {})),
	numericNeg: ofCarrier("numeric", scalarOf(f.numeric(5, -2), {})),
	float4: ofCarrier("float4", plainType("float4")),
	float8: ofCarrier("float8", plainType("float8")),
	money: ofCarrier("money", plainType("money")),
	bool: ofCarrier("bool", plainType("bool")),
	uuid: ofCarrier("uuid", scalarOf(f.uuid, {})),
	text: ofCarrier("text", wildcardText),
	kind: ofCarrier(
		"enum",
		scalarOf(f.closedId("Kind"), { Kind: ["Manual", "Automatic", "Ünïcode"] })
	),
	range4: ofCarrier("range4", scalarOf(f.span(f.integer, undefined), {})),
	range8: ofCarrier("range8", scalarOf(f.span(f.bigint, undefined), {})),
	vector3: ofCarrier("vector", scalarOf({ kind: "vector", dimensions: 3 }, {})),
	embedding: ofCarrier("vector", scalarOf({ kind: "vector", dimensions: 4 }, {})),
	cents: ofCarrier("int8", scalarOf(f.contract("Cents", f.bigint, undefined), {})),
	serial8: ofCarrier("int8", scalarOf({ kind: "serial", type: "bigserial" }, {}))
} as const satisfies Readonly<Record<string, ScalarType>>

/**
 * A type's codec beside the kernel's strict reader of its output texts (test/support/kernel/strict.ts): `read` is what
 * PostgreSQL's output grammar admits, `convert` the library's trusting conversion of it.
 */
export interface TestCodec extends ScalarCodec {
	readonly read: (text: string) => Result.Result<CarrierHost[Carrier], StrictFault>
}

export const codecOf = (type: ScalarType): TestCodec =>
	Object.freeze({ ...scalarCodec(type), read: strictReader(type) })
