import { Predicate, Schema, SchemaGetter } from "effect"
import { admittedIdentifier } from "#compiler/core/identity.ts"
import {
	type ColumnIdent,
	type ConstraintName,
	type DomainName,
	type Identifier,
	type IndexName,
	type LawFunctionName,
	type LawId,
	type RelationIdent,
	SchemaFingerprint,
	type TriggerName
} from "#compiler/core/ids.ts"
import type { Sqlstate } from "#compiler/core/sqlstate.ts"

/**
 * The Schema of one string brand of the engine: a string, admitted as the brand through the engine's own minting
 * function (the naming door's admitting function for a name), which mints it unchecked, as the brands themselves are
 * unchecked. Its type side is a refinement of String that every string meets, so a name is also a record's key (the
 * snapshot's constraint-to-law map).
 */
const minted = <B extends string>(admit: (text: string) => B, expected: string) =>
	Schema.String.pipe(
		Schema.decodeTo(
			Schema.String.pipe(
				Schema.refine((text: string): text is B => Predicate.isString(text), { expected })
			),
			{
				decode: SchemaGetter.transform(admit),
				encode: SchemaGetter.passthrough()
			}
		)
	)

/**
 * The installed names as Effect Schemas, each typed against the engine's brand (core/ids.ts) and admitted through the
 * naming door's admitting function (core/identity.ts admittedIdentifier): for the shell's decoders that admit a name
 * (the snapshot, a server's ErrorResponse) and the error classes that carry one, and on the test side the door
 * (kernel/naming.ts), the catalog reader (catalog/read.ts) and the pg error reader (substrate/errors.ts).
 */
export const nameSchemas = Object.freeze({
	schema: minted(
		(text): Identifier<"schema" | "roleSchema"> => admittedIdentifier(text),
		"SchemaIdent"
	),
	lawId: minted((text): LawId => admittedIdentifier(text), "LawId"),
	relation: minted((text): RelationIdent => admittedIdentifier(text), "RelationIdent"),
	column: minted((text): ColumnIdent => admittedIdentifier(text), "ColumnIdent"),
	constraint: minted((text): ConstraintName => admittedIdentifier(text), "ConstraintName"),
	index: minted((text): IndexName => admittedIdentifier(text), "IndexName"),
	domain: minted((text): DomainName => admittedIdentifier(text), "DomainName"),
	trigger: minted((text): TriggerName => admittedIdentifier(text), "TriggerName"),
	lawFunction: minted((text): LawFunctionName => admittedIdentifier(text), "LawFunctionName")
})

/** The content digest the snapshot, its meta and the ledger record, typed against the engine's brand. */
export const fingerprintSchemas = Object.freeze({
	schema: minted(SchemaFingerprint, "SchemaFingerprint")
})

/**
 * A SQLSTATE as a field of the shell's error classes, typed against the engine's brand (core/sqlstate.ts): a value
 * reaches it already parsed by parseSqlstate, where the wire reads PostgreSQL's ErrorResponse.
 */
export const SqlstateSchema = Schema.declare((u: unknown): u is Sqlstate => typeof u === "string", {
	expected: "Sqlstate"
})
