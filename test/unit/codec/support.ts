import type { Result } from "effect"
import { scalarReader } from "#compiler/codec/read.ts"
import type { RelationNormalizer } from "#compiler/codec/recordset.ts"
import { type ScalarCodec, scalarCodec } from "#compiler/codec/scalar.ts"
import * as Engine from "#compiler/core/result.ts"
import { type Codebook, firstCodebook } from "#compiler/ir/codes.ts"
import type { Carrier, ScalarType } from "#compiler/ir/scalar.ts"
import { anyNumeric, wildcardText } from "#compiler/scalar/compute/types.ts"
import { plainType } from "#compiler/scalar/native.ts"
import { DigestBook } from "#compiler/scalar/values/bytes.ts"
import type { CarrierHost } from "#compiler/scalar/values/identity.ts"
import { f } from "#test/support/fixtures/ir/desc.ts"
import { scalarOf } from "#test/support/fixtures/ir/scalar.ts"
import { type StrictFault, strictReader } from "#test/support/kernel/strict.ts"
import { outputText } from "#test/support/wire.ts"

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
	numeric: ofCarrier("numeric", anyNumeric),
	numeric72: ofCarrier("numeric", scalarOf(f.numeric(7, 2), {})),
	numeric52: ofCarrier("numeric", scalarOf(f.numeric(5, 2), {})),
	numericNeg: ofCarrier("numeric", scalarOf(f.numeric(5, -2), {})),
	float4: ofCarrier("float4", plainType("float4")),
	float8: ofCarrier("float8", plainType("float8")),
	money: ofCarrier("money", plainType("money")),
	bool: ofCarrier("bool", plainType("bool")),
	uuid: ofCarrier("uuid", scalarOf(f.uuid, {})),
	text: ofCarrier("text", wildcardText),
	bytes: ofCarrier("bytes", scalarOf({ kind: "bytes" }, {})),
	kind: ofCarrier(
		"code",
		scalarOf(f.closedId("Kind"), { Kind: ["Manual", "Automatic", "Ünïcode"] })
	),
	kinds: ofCarrier(
		"bits",
		scalarOf({ kind: "bits", roster: "Kind" }, { Kind: ["Manual", "Automatic", "Ünïcode"] })
	),
	range4: ofCarrier("range4", scalarOf(f.span(f.integer, undefined), {})),
	range8: ofCarrier("range8", scalarOf(f.span(f.bigint, undefined), {})),
	rangeDate: ofCarrier("rangeDate", scalarOf(f.span(f.pg("date"), undefined), {})),
	vector3: ofCarrier("vector", scalarOf({ kind: "vector", dimensions: 3 }, {})),
	embedding: ofCarrier("vector", scalarOf({ kind: "vector", dimensions: 4 }, {})),
	cents: ofCarrier("int8", scalarOf(f.contract("Cents", f.bigint, undefined), {}))
} as const satisfies Readonly<Record<string, ScalarType>>

/** The codes a fresh installation gives the codec tests' one roster, Kind: Manual 0, Automatic 1, Ünïcode 2. */
export const kindCodes: Codebook = firstCodebook([types.kind.roster])

/**
 * A type's codec beside its reader and the kernel's strict reader of its output texts (test/support/kernel/strict.ts):
 * `read` is what PostgreSQL's output grammar admits, `convert` and `cellText` the library's trusting reading of it, each
 * over a text the test states PostgreSQL wrote (test/support/wire.ts outputText).
 */
export interface TestCodec extends ScalarCodec {
	readonly read: (text: string) => Result.Result<CarrierHost[Carrier], StrictFault>
	readonly convert: (text: string) => CarrierHost[Carrier]
	readonly cellText: (text: string) => string
}

/** The codec of `type` under the installation's codes `codes`, which a closed id or a set encodes against. */
export const codecOf = (type: ScalarType, codes: Codebook): TestCodec => {
	const reader = scalarReader(type, codes)
	return Object.freeze({
		...scalarCodec(type, codes),
		read: strictReader(type, codes),
		convert: (text: string) => reader.convert(outputText(text)),
		cellText: (text: string) => reader.cellText(outputText(text))
	})
}

/**
 * A relation input admitted whole by its normalizer: read, then admitted with a book of its own (codec/recordset.ts
 * RelationNormalizer), as a write admits a member past its measure.
 */
export const normalizedBy = (normalizer: RelationNormalizer, facts: Iterable<unknown>) =>
	Engine.flatMap(normalizer.read(facts), (read) => normalizer.admit(read, new DigestBook()))
