/**
 * Field descriptors as a JavaScript caller builds them: the public contract and span over the admission cores
 * (scalar/contract.ts contractParts, scalar/span.ts spanParts), every argument unknown, so a test passes what the
 * public types forbid and meets the refusals the admission cores raise. Each defines its descriptor through the
 * registry (scalar/registry.ts defineField), so the schema builders admit it as a builder-made descriptor.
 */
import { brandColumn } from "#compiler/core/decoder.ts"
import { type CompileError, malformedDescription } from "#compiler/core/errors.ts"
import { captureLoc, SourceLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"
import { descText, type ExprDesc } from "#compiler/ir/desc.ts"
import { contractParts } from "#compiler/scalar/contract.ts"
import {
	bareEnv,
	carrierSql,
	type Descriptor,
	defineField,
	describeField
} from "#compiler/scalar/registry.ts"
import { spanColumn, spanParts } from "#compiler/scalar/span.ts"

interface ContractDescriptor extends Descriptor {
	readonly name: string
	/** The descriptor the caller passed, unchanged: a str.regex field keeps its pattern. */
	readonly base: object
	readonly predicate: ExprDesc | undefined
	(value: unknown): unknown
}

/**
 * A contract's descriptor from its admitted parts: a fresh unchecked brand constructor, one function per contract,
 * which is the plain identity, with the contract's members; its column is the base's, branded. `rest` is what follows
 * the base. describeField admitted `base`, so it is an object or a function: the public `base` member is the caller's
 * descriptor itself, and an unowned str.regex field keeps its pattern.
 */
export const admitContract = (
	name: unknown,
	base: unknown,
	rest: ReadonlyArray<unknown>
): ContractDescriptor => {
	const parts = contractParts(name, base, rest)
	if (base === null || (typeof base !== "object" && typeof base !== "function")) {
		throw malformedDescription(captureLoc(`contract ${parts.name} base`, []), "a field descriptor")
	}
	const brand = (value: unknown): unknown => value
	const column = brandColumn(parts.base.column, brand)
	return defineField(
		brand,
		parts.sql,
		parts.desc,
		{ name: parts.name, base, predicate: parts.predicate, column },
		parts.loc,
		parts.env
	)
}

/** contract(name, base) or contract(name, base, predicate), as a JavaScript caller calls it. */
export const contractDescriptor = (
	name: unknown,
	base: unknown,
	...rest: ReadonlyArray<unknown>
): ContractDescriptor => admitContract(name, base, rest)

/**
 * span(endpoint) or span(endpoint, width), as a JavaScript caller calls it: the descriptor holds the width it was
 * given, as given, and its Description the normalized width. Its column converts endpoints with the admitted
 * endpoint's column.
 */
export const spanDescriptor = (endpoint: unknown, ...rest: ReadonlyArray<unknown>) => {
	const parts = spanParts(endpoint, rest)
	const column = spanColumn(parts.endpoint.column)
	return defineField(
		{},
		carrierSql.range4,
		parts.desc,
		{ endpoint: parts.endpoint, width: parts.width, column },
		parts.loc,
		bareEnv
	)
}

/**
 * Descriptor identity is Description identity: aliases normalize at construction, so two descriptors are the same
 * declaration exactly when their FieldDescs are canonically equal.
 */
export const fieldIdentity = (value: unknown): Result.Result<string, CompileError> =>
	Result.flatMap(describeField(value, SourceLoc("field identity", [])), (d) => descText(d.desc))
