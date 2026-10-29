import { SourceLoc } from "#compiler/core/loc.ts"
import type { FieldDesc } from "#compiler/ir/desc.ts"
import type { SchemaInfo } from "#compiler/query/build/scope.ts"
import { type Typing, typed, untyped } from "#compiler/scalar/compute/term.ts"
import { commonType, compatible } from "#compiler/scalar/compute/types.ts"
import { describeField, type ScalarEnv, scalarTypeOf } from "#compiler/scalar/registry.ts"
import { malformed } from "#compiler/schema/protocol.ts"
import { schemaDescOf } from "#compiler/schema/schema.ts"
import { roleDescOf } from "#compiler/schema/world.ts"
import { textLookup } from "#compiler/text/refinement.ts"

/**
 * Headings as the builder knows them.
 *
 * The builder records Descriptions; typing is the checker's. It still needs each heading field's scalar
 * type where it can know it, for two reasons: a literal written against a field is a value of that field's base and
 * is checked for its host representation at construction, and Compute types the terms it
 * builds over a variable from the variable's type. A heading is therefore its field names, each with
 * what the builder knows of its type (Typing: the ScalarType it resolved, or untyped), and the names of its
 * attachments, which are nested sets and no scalar.
 *
 * Types come from the field descriptors of relations, closed relations, relation parameters and recursive rows, and
 * from the head terms of finished rules: a variable's or Compute term's type, an aggregate's native result type. A
 * parameter or a bare literal in a head has no type until the checker unifies it, nor does a field of a query rebuilt
 * from its Description alone. A union's field keeps a type only when every arm that has it agrees on a compatible one
 * (a union retains only guarantees shared by every arm).
 */
export interface Heading {
	/** Every scalar field, in heading order, with what the builder knows of its type. */
	readonly fields: ReadonlyMap<string, Typing>
	/** The attachment names. */
	readonly attached: ReadonlySet<string>
}

export const heading = (
	fields: Iterable<readonly [string, Typing]>,
	attached: Iterable<string>
): Heading => Object.freeze({ fields: new Map(fields), attached: new Set(attached) })

export const hasName = (h: Heading, name: string): boolean =>
	h.fields.has(name) || h.attached.has(name)

/**
 * What the builder knows of the type of `field`, which a caller names as a field of `h`'s heading: refused when `h`
 * has no such field.
 */
export const headingField = (h: Heading, field: string, label: string): Typing => {
	const typing = h.fields.get(field)
	if (typing === undefined) {
		throw malformed(label, `a field of the source's heading; ${JSON.stringify(field)} is not one`)
	}
	return typing
}

export const withAttachment = (h: Heading, name: string): Heading =>
	heading(h.fields, [...h.attached, name])

/**
 * What two arms agree on of one field's type: their common type when both are typed and compatible, nothing
 * otherwise.
 */
const agreed = (a: Typing, b: Typing): Typing =>
	a.kind === "typed" && b.kind === "typed" && compatible(a.type, b.type)
		? typed(commonType(a.type, b.type))
		: untyped

/**
 * The heading of several arms: every name of every arm, in order of first appearance, a field typed only where the
 * arms that have it agree.
 */
export const unionHeading = (arms: ReadonlyArray<Heading>): Heading => {
	const fields = new Map<string, Typing>()
	for (const arm of arms) {
		for (const [name, typing] of arm.fields) {
			const before = fields.get(name)
			fields.set(name, before === undefined ? typing : agreed(before, typing))
		}
	}
	return heading(
		fields,
		arms.flatMap((a) => [...a.attached])
	)
}

/**
 * The roster environment of a schema or role: every closed relation of the schema, or of the role's base, and of the
 * levels below it, by name, so a closedId field described only by its Description still resolves its handles.
 */
export const schemaInfo = (value: unknown): SchemaInfo => {
	const desc = schemaDescOf(value) ?? roleDescOf(value)?.base
	const rosters = new Map<string, ReadonlyArray<string>>()
	for (let at = desc; at !== undefined; at = at.extends) {
		for (const r of at.relations) {
			if (r.kind === "closed" && !rosters.has(r.name)) {
				rosters.set(r.name, r.handles)
			}
		}
	}
	return Object.freeze({
		value,
		env: Object.freeze({
			kind: "builder",
			roster: (name: string) => rosters.get(name),
			text: textLookup
		})
	})
}

/**
 * What the builder knows of a field's type: the descriptor registry's own reading of a descriptor it defined,
 * otherwise its reading of the field's Description under the schema's rosters, otherwise nothing.
 */
export const fieldTyping = (descriptor: unknown, desc: FieldDesc, env: ScalarEnv): Typing => {
	if (descriptor !== undefined) {
		const described = describeField(descriptor, SourceLoc("field", []))
		if (described.ok) {
			return typed(described.value.scalar)
		}
	}
	const scalar = scalarTypeOf(desc, env, SourceLoc("field", []))
	return scalar.ok ? typed(scalar.value) : untyped
}

export const fieldsHeading = (
	descs: Readonly<Record<string, FieldDesc>>,
	descriptors: Readonly<Record<string, unknown>>,
	env: ScalarEnv
): Heading =>
	heading(
		Object.entries(descs).map(
			([name, desc]) => [name, fieldTyping(descriptors[name], desc, env)] as const
		),
		[]
	)
