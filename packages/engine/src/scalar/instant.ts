import type { Column } from "#compiler/core/decoder.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { instantName } from "#compiler/ir/instant.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import { contractParts } from "#compiler/scalar/contract.ts"
import { pgDescriptors } from "#compiler/scalar/pg.ts"
import { defineField } from "#compiler/scalar/registry.ts"

/**
 * instant's admission: the contract `instant` over pg.bigint, whose values are never below zero, natural's very
 * definition, so it is installed as natural's domain, one domain of one definition (physical/ddl/domains.ts), and its
 * columns are natural's. Its name is its own, so a term of it meets only another instant's.
 */
const parts = contractParts(instantName, pgDescriptors.bigint, [
	(v: unknown) => computeCore.ge(v, 0n),
	{ proves: ["nonnegative"] }
])

/** pg.bigint's column, which an instant's values are read by: a bigint's, unbranded. */
const column: Column<bigint> = pgDescriptors.bigint.column

/**
 * The type of `instant` fields (schema/relation.ts instantField): microseconds since the Unix epoch on the database's
 * clock, the builtin contract `instant` over pg.bigint, `CHECK (VALUE >= 0)` (ir/instant.ts instantName). It is no
 * brand constructor, and no parameter, literal, cast or contract is of it, so a term of it is a stored instant.
 */
export const instantDescriptor = defineField(
	{},
	pgDescriptors.bigint.sql,
	parts.desc,
	{
		name: parts.name,
		base: pgDescriptors.bigint,
		predicate: parts.predicate,
		column,
		instant: true
	},
	SourceLoc(instantName, []),
	parts.env
)
