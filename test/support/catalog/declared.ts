import { Array as Arr, Record as Rec } from "effect"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { decodeDesc, type RelationDesc, type SchemaDesc } from "#compiler/ir/desc.ts"
import { schemaDescOf } from "#compiler/schema/schema.ts"
import type {
	ErasureExpectation,
	InstalledFunction,
	InstalledTrigger
} from "#test/support/catalog/verify.ts"
import { parsedName } from "#test/support/kernel/naming.ts"

interface Declared {
	readonly relations: ReadonlyArray<RelationDesc>
	/** The relations a mutable(R) statement names. */
	readonly mutable: ReadonlySet<string>
}

/**
 * The declaration of `schema`: a schema value's own description, or a description itself. Anything else is a defect of
 * the caller.
 */
const descOf = (schema: unknown): SchemaDesc => {
	const built = schemaDescOf(schema)
	if (built !== undefined) {
		return built
	}
	const decoded = decodeDesc("schema", schema)
	if (!decoded.ok) {
		throw new Error(
			`declared: neither a schema value nor a schema description: ${decoded.error.message}`
		)
	}
	return decoded.value
}

/** Every level of the declaration, an extended schema's base included. */
const levels = (desc: SchemaDesc): Declared => {
	const base: Declared =
		desc.extends === undefined ? { relations: [], mutable: new Set() } : levels(desc.extends)
	const known = new Set(Arr.map(desc.relations, (r) => r.name))
	return {
		relations: [...Arr.filter(base.relations, (r) => !known.has(r.name)), ...desc.relations],
		mutable: new Set([
			...base.mutable,
			...Arr.flatMap(desc.statements, (s) => (s.kind === "mutable" ? [s.relation] : []))
		])
	}
}

/**
 * What a catalog must hold, read from the schema's declaration rather than from the compiler's manifest, so an audit
 * that compares an installed catalog with it does not trust the compiler to describe its own output.
 *
 * The rules applied to the declared values:
 * - every declared relation of kind "relation" is one authored table, and every derived relation one materialized view,
 *   each named by the production identifier of its declared name (`AutomaticTask` is `automatic_task`);
 * - a serial field's identity sequence moves through its advance function (identity.advance);
 * - every installation holds the naming door's per-schema singletons: the refusal function, the isolation guard and
 *   its trigger on every table, the snapshot guard and the migrations ledger;
 * - a relation is immutable unless a `mutable(R)` statement names it, and only a mutable relation's table may be
 *   updated by a non-owner role;
 * - a closed relation is an enum whose labels are its declared handles, in declared order.
 *
 * The authored tables, the mutable ones among them, the derived relations' views and the serial fields' advance
 * functions a schema declares, beside the singletons; no law function, law trigger, world or membership: the schema's
 * declaration alone, installed with no login.
 */
export const declaredErasure = (schema: unknown): ErasureExpectation => {
	const { relations, mutable } = levels(descOf(schema))
	const tables = (keep: (r: RelationDesc) => boolean): ReadonlySet<string> =>
		new Set(
			Arr.map(Arr.filter(relations, keep), (r) => identifierOf(identity.table(parsedName(r.name))))
		)
	return {
		tables: tables((r) => r.kind === "relation"),
		mutable: tables((r) => r.kind === "relation" && mutable.has(r.name)),
		views: new Set(
			Arr.map(
				Arr.filter(relations, (r) => r.kind === "derived"),
				(r) => identifierOf(identity.view(parsedName(r.name)))
			)
		),
		ledger: identifierOf(identity.ledger()),
		functions: new Map<string, InstalledFunction>([
			[identifierOf(identity.refusal()), { kind: "refusal" }],
			[identifierOf(identity.isolationGuard()), { kind: "isolationGuard" }],
			[identifierOf(identity.snapshotGuard()), { kind: "snapshotGuard" }],
			...Arr.flatMap(relations, (r) =>
				r.kind === "relation"
					? Arr.flatMap(Rec.toEntries(r.fields), ([field, type]) =>
							type.kind === "serial"
								? [
										[
											identifierOf(identity.advance(r.name, field)),
											{ kind: "advance", table: identifierOf(identity.table(parsedName(r.name))) }
										] as const
									]
								: []
						)
					: []
			)
		]),
		triggers: new Map<string, InstalledTrigger>([
			[identifierOf(identity.isolationTrigger()), "isolation"]
		]),
		rowSecure: new Set(),
		logins: new Map(),
		refreshes: new Map(),
		barrierViews: new Set()
	}
}

/** Each closed relation's enum, by its type name, with its declared handles in order. */
export const declaredEnums = (schema: unknown): ReadonlyMap<string, ReadonlyArray<string>> =>
	new Map(
		Arr.flatMap(levels(descOf(schema)).relations, (r) =>
			r.kind === "closed"
				? [[identifierOf(identity.enumType(parsedName(r.name))), r.handles] as const]
				: []
		)
	)
