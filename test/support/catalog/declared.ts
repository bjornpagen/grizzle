import { Array as Arr, Record as Rec } from "effect"
import { everyProperty } from "#compiler/core/canonical.ts"
import { constantDigest } from "#compiler/core/fingerprint.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { type RelationDesc, type SchemaDesc, serialDraw } from "#compiler/ir/desc.ts"
import { admitSchemaDesc } from "#compiler/schema/admit.ts"
import { schemaDescOf } from "#compiler/schema/schema.ts"
import {
	type ErasureExpectation,
	type InstalledFunction,
	type InstalledTrigger,
	unitFunctions
} from "#test/support/catalog/verify.ts"
import { wholeDigits } from "#test/support/closed/bit-text.ts"
import { parsedName } from "#test/support/kernel/naming.ts"

interface Declared {
	readonly relations: ReadonlyArray<RelationDesc>
	/** The relations a mutable(R) statement names. */
	readonly mutable: ReadonlySet<string>
	/** The headers a retirable statement names, each unit's once. */
	readonly headers: ReadonlyArray<string>
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
	const decoded = admitSchemaDesc(schema)
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
		desc.extends === undefined
			? { relations: [], mutable: new Set(), headers: [] }
			: levels(desc.extends)
	const known = new Set(Arr.map(desc.relations, (r) => r.name))
	return {
		relations: [...Arr.filter(base.relations, (r) => !known.has(r.name)), ...desc.relations],
		mutable: new Set([
			...base.mutable,
			...Arr.flatMap(desc.statements, (s) => (s.kind === "mutable" ? [s.relation] : []))
		]),
		headers: [
			...base.headers,
			...Arr.flatMap(desc.statements, (s) => (s.kind === "retirable" ? [s.header.relation] : []))
		]
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
 * - a roster is its domain and its names constant, named by the digest of its handles in code order, which a first
 *   installation numbers by declared position, so the constant holds the declared handles in order and no hole; a
 *   roster a set field is typed over also installs its live-codes constant, named by the same digest, and its bits
 *   domain at its size, the handles' count;
 * - a closed relation installs constants named by their content's digest (`closedConstants`);
 * - a retirable unit installs its hold and its retirement, named by their identities for its header.
 *
 * The authored tables, the mutable ones among them, the derived relations' views, the serial fields' advance functions,
 * the rosters' constants and the retirable units' functions a schema declares, beside the singletons; no law function, law trigger, world or
 * membership: the schema's declaration alone, installed with no login, as a first installation.
 */
export const declaredErasure = (schema: unknown): ErasureExpectation => {
	const { relations, mutable, headers } = levels(descOf(schema))
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
		guarded: new Set([...tables((r) => r.kind === "relation"), identifierOf(identity.ledger())]),
		functions: new Map<string, InstalledFunction>([
			[identifierOf(identity.refusal()), { kind: "refusal" }],
			[identifierOf(identity.isolationGuard()), { kind: "isolationGuard" }],
			[identifierOf(identity.snapshotGuard()), { kind: "snapshotGuard" }],
			...unitFunctions(headers),
			...Arr.flatMap(relations, (r): ReadonlyArray<readonly [string, InstalledFunction]> => {
				if (r.kind !== "closed") {
					return []
				}
				const roster = parsedName(r.name)
				const digest = constantDigest("roster-names", r.handles, everyProperty)
				const names = identifierOf(identity.rosterConstant(roster, digest))
				const sets = Arr.some(relations, (o) =>
					o.kind === "relation"
						? Arr.some(
								Rec.values(o.fields),
								(f) => f.type.kind === "bits" && f.type.roster === r.name
							)
						: false
				)
				return [
					[names, { kind: "names", domain: identifierOf(identity.rosterDomain(roster)) }],
					...(sets
						? [
								[
									identifierOf(identity.rosterLive(roster, digest)),
									{
										kind: "live",
										domain: identifierOf(identity.bitsDomain(roster, wholeDigits(r.handles.length)))
									}
								] as const
							]
						: [])
				]
			}),
			...Arr.flatMap(relations, (r) =>
				r.kind === "relation"
					? Arr.flatMap(Rec.toEntries(r.fields), ([field, decl]) =>
							decl.writing.kind === "serial" && serialDraw(decl.type) === "identity"
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
		barrierViews: new Set(),
		closedConstants: Arr.some(relations, (r) => r.kind === "closedRelation"),
		liveSource: { kind: "none" }
	}
}
