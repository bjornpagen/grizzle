import { type CursorSpec, cursorCodec } from "#compiler/codec/cursor/codec.ts"
import type { CursorComparator, CursorGeneration } from "#compiler/codec/cursor/identity.ts"
import { cursorMaxBytes } from "#compiler/core/policy.ts"
import type { Carrier, ScalarType } from "#compiler/ir/scalar.ts"
import { plainType, wildcardText } from "#compiler/scalar/compute/types.ts"
import { succeeded } from "#test/support/assert.ts"
import { f } from "#test/support/fixtures/ir/desc.ts"
import { scalarOf } from "#test/support/fixtures/ir/scalar.ts"

/**
 * Ordered descriptors and helpers shared by the cursor codec tests (test/unit/cursor, test/pg/cursor).
 */
const hasCarrier = <C extends Carrier>(
	t: ScalarType,
	carrier: C
): t is ScalarType & { readonly carrier: C } => t.carrier === carrier

/** A registry type with its carrier in its static type, so a comparator over it reads that carrier's host values. */
const ofCarrier = <C extends Carrier>(
	carrier: C,
	t: ScalarType
): ScalarType & { readonly carrier: C } => {
	if (!hasCarrier(t, carrier)) {
		throw new Error(`a cursor test type of carrier ${carrier} is a ${t.carrier}`)
	}
	return t
}

/**
 * The ordered types the cursor tests read, each the one the registry builds (fixtures/ir/scalar.ts): every capability
 * set a comparator meets is production's. `title` is a pattern whose analysis proves a byte bound: at most 50 code
 * points, 200 UTF-8 bytes.
 */
export const cursorCodecTypes = {
	int2: ofCarrier("int2", plainType("int2")),
	int4: ofCarrier("int4", plainType("int4")),
	int8: ofCarrier("int8", plainType("int8")),
	numeric: ofCarrier("numeric", plainType("numeric")),
	numeric72: ofCarrier("numeric", scalarOf(f.numeric(7, 2), {})),
	numericNeg: ofCarrier("numeric", scalarOf(f.numeric(5, -2), {})),
	numericSmall: ofCarrier("numeric", scalarOf(f.numeric(3, 5), {})),
	float4: ofCarrier("float4", plainType("float4")),
	float8: ofCarrier("float8", plainType("float8")),
	money: ofCarrier("money", plainType("money")),
	bool: ofCarrier("bool", plainType("bool")),
	uuid: ofCarrier("uuid", scalarOf(f.uuid, {})),
	text: ofCarrier("text", wildcardText),
	title: ofCarrier("text", scalarOf(f.regex("^.{1,50}$", "su"), {})),
	kind: ofCarrier(
		"enum",
		scalarOf(f.closedId("Kind"), { Kind: ["Manual", "Automatic", "Ünïcode"] })
	),
	range4: ofCarrier("range4", scalarOf(f.span(f.integer, undefined), {})),
	range8: ofCarrier("range8", scalarOf(f.span(f.bigint, undefined), {})),
	vector3: ofCarrier("vector", scalarOf({ kind: "vector", dimensions: 3 }, {})),
	cents: ofCarrier("int8", scalarOf(f.contract("Cents", f.bigint, undefined), {}))
} as const satisfies Readonly<Record<string, ScalarType>>

export const generation: CursorGeneration = { schema: "schema-fingerprint-1", extensions: {} }

/** orderedTasks: priority DESC completed by the retained id ASC. */
const taskComparators = [
	{ field: "priority", direction: "desc", type: cursorCodecTypes.int4 },
	{ field: "id", direction: "asc", type: cursorCodecTypes.uuid }
] as const satisfies ReadonlyArray<CursorComparator>

export const taskSpec: CursorSpec<typeof taskComparators> = {
	query: "program-fingerprint-orderedTasks",
	comparators: taskComparators,
	generation
}

export const taskCodec = succeeded(cursorCodec(taskSpec, cursorMaxBytes))

export const taskId = "3c9a8b7d-6e5f-4a3b-9c2d-1e0f9a8b7c6d"
