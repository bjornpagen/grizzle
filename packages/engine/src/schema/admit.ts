import { catchRefusal, Refusal } from "#compiler/core/canonical.ts"
import { type CompileError, malformedDescription } from "#compiler/core/errors.ts"
import { childLoc, labeledChildLoc, type SourceLoc } from "#compiler/core/loc.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import * as Result from "#compiler/core/result.ts"
import {
	type AdmittedClosedRelation,
	admittedRelation,
	decodeDesc,
	decodeUnadmittedSchema,
	type RelationDesc,
	recordAdmitted,
	type SchemaDesc,
	type UnadmittedSchemaDesc
} from "#compiler/ir/desc.ts"
import { baseOf, Roster, type ScalarType, typeLabel } from "#compiler/ir/scalar.ts"
import { irLiteral } from "#compiler/scalar/compute/literal.ts"
import { type ScalarEnv, scalarTypeOf } from "#compiler/scalar/registry.ts"

type ClosedRelationOf = Extract<RelationDesc, { readonly kind: "closedRelation" }>

/** Every roster of every level of a schema, by name, its handles: the lowest level's declaration of a name. */
const rostersOf = (
	desc: UnadmittedSchemaDesc
): ReadonlyMap<string, NonEmptyReadonlyArray<string>> => {
	const below = new Map<string, NonEmptyReadonlyArray<string>>(
		desc.extends === undefined ? [] : rostersOf(desc.extends)
	)
	for (const r of desc.relations) {
		if (r.kind === "closed" && !below.has(r.name)) {
			below.set(r.name, r.handles)
		}
	}
	return below
}

/** A refusal at `at`, thrown to the admission's boundary (catchRefusal). */
const refused = (at: SourceLoc, what: string): never => {
	throw new Refusal(malformedDescription(at, what))
}

/**
 * A closed relation of a decoded schema admitted: each cell a value of its field's base type (scalar/compute/literal.ts
 * irLiteral), a closed id's one of its roster's handles, read from a set of the roster's handles built once for the
 * relation. Its rows are then registered as admitted (ir/desc.ts recordAdmitted), which no reader of the schema proves
 * again.
 */
const admitted = (r: ClosedRelationOf, env: ScalarEnv): AdmittedClosedRelation => {
	const types = new Map<string, ScalarType>()
	/** Each closed-id field's roster: its name, and a set of its handles each cell is found in. */
	const rosters = new Map<
		string,
		{ readonly name: string; readonly handles: ReadonlySet<string> }
	>()
	for (const [field, desc] of Object.entries(r.fields)) {
		const typed = scalarTypeOf(desc, env, childLoc(r.loc, "fields", field))
		if (!typed.ok) {
			throw new Refusal(typed.error)
		}
		types.set(field, typed.value)
		const base = baseOf(typed.value)
		if (base.carrier === "code") {
			rosters.set(field, { name: base.roster.closed, handles: new Set(base.roster.handles) })
		}
	}
	for (const [i, row] of r.rows.entries()) {
		for (const [field, type] of types) {
			const value = row[field]
			const roster = rosters.get(field)
			if (roster !== undefined) {
				if (typeof value !== "string" || !roster.handles.has(value)) {
					refused(
						labeledChildLoc(r.loc, field, `row ${i} of ${r.name}, field ${field}`),
						`a value of closedId(${roster.name}) field ${r.name}.${field} that is a handle of ${roster.name}; ${typeof value === "string" ? JSON.stringify(value) : `a ${typeof value}`} is not one`
					)
				}
				continue
			}
			const literal = value === undefined ? undefined : irLiteral(value, type)
			if (literal === undefined || !literal.ok) {
				refused(
					childLoc(r.loc, "rows", i, field),
					`a literal of ${typeLabel(type)}${literal === undefined ? "" : `: ${literal.error}`}`
				)
			}
		}
	}
	return recordAdmitted(r)
}

/** A schema level and the levels below it with each closed relation no admission made admitted (admitted). */
const admittedLevels = (desc: UnadmittedSchemaDesc, env: ScalarEnv): unknown => ({
	...desc,
	relations: desc.relations.map((r) =>
		r.kind === "closedRelation" ? (admittedRelation(r) ?? admitted(r, env)) : r
	),
	extends: desc.extends === undefined ? undefined : admittedLevels(desc.extends, env)
})

/**
 * A schema description from outside the builders, decoded and admitted: the one door from `unknown` to a SchemaDesc
 * whose closed relations no builder admitted (a decoded description's, an authored fixture's). Each closed relation is
 * admitted once against the schema's rosters and its fields' base types, and the schema is then decoded as one, so
 * every closed relation a SchemaDesc holds is admitted (ir/desc.ts SchemaRelationDesc). A closed relation a builder
 * admitted is taken as it stands. A refusal is MalformedDescription at the first cell that is no value of its field.
 */
export const admitSchemaDesc = (value: unknown): Result.Result<SchemaDesc, CompileError> =>
	Result.flatMap(decodeUnadmittedSchema(value), (unadmitted) => {
		const rosters = rostersOf(unadmitted)
		const env: ScalarEnv = {
			kind: "builder",
			roster: (name) => {
				const handles = rosters.get(name)
				return handles === undefined ? undefined : new Roster(name, handles)
			}
		}
		return Result.flatMap(
			catchRefusal(() => admittedLevels(unadmitted, env)),
			(levels) => decodeDesc("schema", levels)
		)
	})
