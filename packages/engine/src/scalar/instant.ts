import type { Brand } from "effect"
import { type Column, hostColumn } from "#compiler/core/decoder.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { instantName } from "#compiler/ir/instant.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import { contractParts } from "#compiler/scalar/contract.ts"
import { int8 } from "#compiler/scalar/pg.ts"
import { defineField } from "#compiler/scalar/registry.ts"

/**
 * instant's admission: the contract `instant` over int8, whose values are never below zero, natural's very
 * definition, so it is installed as natural's domain, one domain of one definition (physical/ddl/domains.ts), and its
 * columns are natural's. Its name is its own, so a term of it meets only another instant's.
 */
const parts = contractParts(instantName, int8, [
	(v: unknown) => computeCore.ge(v, 0n),
	{ proves: ["nonnegative"] }
])

/**
 * An instant as the host holds it: microseconds since the Unix epoch on the database's clock, a bigint under the brand
 * "instant", which a read's column alone claims (`column`). So a host holds an instant only where a read of one
 * delivered it, and writes one only as it read it, into a stored instant (instant.stored), never one its own clock or
 * arithmetic made: a bigint is no Instant.
 */
export type Instant = bigint & Brand.Brand<"instant">

/** int8's column, its values claimed Instant (core/decoder.ts hostColumn): what an instant's values are read by. */
const column: Column<Instant> = hostColumn<bigint, Instant>(int8.column)

/** The members every instant descriptor has: the builtin contract's name, base and predicate, and its column. */
const members = Object.freeze({
	name: parts.name,
	base: int8,
	predicate: parts.predicate,
	column
})

/**
 * instant.stored: a field of instant's type its caller writes as it is, a copy of an instant a read delivered, the
 * database drawing nothing (ir/desc.ts Writing `caller` over instant's type): microseconds since the Unix epoch on the
 * database's clock, the builtin contract `instant` over int8, `CHECK (VALUE >= 0)` (ir/instant.ts instantName).
 * Its host values are Instant, so a host stores only an instant it read; it is no brand constructor, and no parameter,
 * literal, cast or contract is of its type.
 */
const storedInstantDescriptor = defineField(
	{},
	int8.sql,
	parts.desc,
	members,
	SourceLoc(`${instantName}.stored`, []),
	parts.env
)

/**
 * The type of `instant` fields (schema/relation.ts clockInstant): an instant of instant's type the database's clock
 * writes (ir/desc.ts Writing `instant`), stamped by its insert or carried from a stored one as the schema's laws make it
 * (analysis/theory/instants.ts), so a term of it is a stored instant. `instant: true` is the member its type is told
 * apart by, and `stored` is the field of its type its caller writes (storedInstantDescriptor).
 */
export const instantDescriptor = defineField(
	{},
	int8.sql,
	parts.desc,
	{ ...members, instant: true, stored: storedInstantDescriptor },
	SourceLoc(instantName, []),
	parts.env
)
