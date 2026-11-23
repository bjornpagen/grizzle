/** What the properties of entry-box.test.ts read: its spaces, models and helpers. */

import { defined } from "@bjornpagen/testing/assert"
import { boolean, element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Record as Rec } from "effect"
import type { CompileError, EncodingFailure } from "#compiler/core/errors.ts"
import type { UnservedMember } from "#compiler/served/unserved.ts"
import { knownNonEmpty, pooled } from "#test/support/worlds/generate/domain.ts"
import { relationSpecOf } from "#test/support/worlds/model/session/state.ts"
import type { Written } from "#test/support/worlds/model/session/writes.ts"
import type {
	BaseSpec,
	Comparison,
	EntrySpec,
	FieldSpec,
	HostFact,
	InstallSpec,
	RelationSpec,
	Rule,
	Term
} from "#test/support/worlds/model/types.ts"

/** How a query entry's head uses a field: carried, carried and read by its filter, fixed by a literal, or unnamed. */
type Use = "carried" | "read" | "fixed" | "unnamed"

interface BoxField {
	readonly key: boolean
}

type BoxEntry =
	| { readonly kind: "whole" }
	| { readonly kind: "query"; readonly uses: Arr.NonEmptyReadonlyArray<Use> }

interface BoxPoint {
	readonly fields: Arr.NonEmptyReadonlyArray<BoxField>
	readonly entry: BoxEntry
}

export type BoxFeature =
	| "refused at build"
	| "compiled whole"
	| "compiled entry"
	| "a field the filter reads"
	| "facts refused at their shape"

/** The uses of a field that leave it out of the head. */
const uncarried: ReadonlyArray<Use> = ["fixed", "unnamed"]

/**
 * A point of the box. The key is the fields marked keyed, the first marked whenever no other is, and the last field of
 * an entry whose earlier fields carry none is carried: each relation and entry the box holds is drawn once.
 */
export const pointGen: Gen<BoxPoint> = (source) => {
	const count = source.draw(int(1, 3))
	const restKeys: Array<boolean> = []
	for (let i = 1; i < count; i += 1) {
		restKeys.push(source.draw(boolean))
	}
	const firstKey = Arr.some(restKeys, (k) => k) ? source.draw(boolean) : true
	const keys = [firstKey, ...restKeys]
	const fields = knownNonEmpty(
		Arr.map(keys, (key): BoxField => ({ key })),
		"the box's fields"
	)
	if (source.draw(boolean)) {
		return { fields, entry: { kind: "whole" } }
	}
	const uses: Array<Use> = []
	const carrying: Arr.NonEmptyReadonlyArray<Use> = ["carried", "read"]
	for (const i of fields.keys()) {
		const carried = Arr.some(uses, (u) => u === "carried" || u === "read")
		uses.push(
			source.draw(
				element(i < fields.length - 1 || carried ? Arr.appendAll(carrying, uncarried) : carrying)
			)
		)
	}
	return { fields, entry: { kind: "query", uses: knownNonEmpty(uses, "the entry's uses") } }
}

const relationOf = (point: BoxPoint): RelationSpec => {
	const fields = Arr.map(point.fields, (_, i): FieldSpec => ({
		name: `f${i}`,
		domain: { kind: "integer", bits: 32 }
	}))
	return {
		name: "Cell",
		fields,
		key: knownNonEmpty(
			Arr.flatMap(fields, (f, i) => (point.fields[i]?.key === true ? [f.name] : [])),
			"the box's key"
		),
		mutability: "immutable"
	}
}

/** A literal of a field's domain, the first of its pool. */
const literalOf = (f: FieldSpec): Term => ({ kind: "literal", value: pooled(f.domain, 0) })

/** The entry's one rule over the relation: each field's term by its use, the head its carried fields under their names. */
const ruleOf = (relation: RelationSpec, uses: Arr.NonEmptyReadonlyArray<Use>): Rule => {
	const used = Arr.zip(relation.fields, uses)
	const variable = (f: FieldSpec): Term => ({ kind: "var", name: `x_${f.name}` })
	const carried = Arr.filter(used, ([, use]) => use === "carried" || use === "read")
	return {
		matches: [
			{
				source: { kind: "ordinary", name: relation.name },
				fields: Rec.fromEntries(
					Arr.flatMap(used, ([f, use]): ReadonlyArray<readonly [string, Term]> => {
						switch (use) {
							case "carried":
							case "read":
								return [[f.name, variable(f)]]
							case "fixed":
								return [[f.name, literalOf(f)]]
							case "unnamed":
								return []
						}
					})
				)
			}
		],
		negations: [],
		comparisons: Arr.flatMap(used, ([f, use]): ReadonlyArray<Comparison> =>
			use === "read" ? [{ left: variable(f), op: ">=", right: literalOf(f) }] : []
		),
		head: Rec.fromEntries(Arr.map(carried, ([f]) => [f.name, variable(f)] as const))
	}
}

/** The installation of a point: one role writing the relation through its one entry, in one login. */
export const installOf = (
	point: BoxPoint
): { readonly install: InstallSpec; readonly entry: string } => {
	const relation = relationOf(point)
	const base: BaseSpec = {
		name: "Box",
		closed: [],
		relations: [relation],
		laws: [],
		contexts: []
	}
	const [entry, spec]: readonly [string, EntrySpec] =
		point.entry.kind === "whole"
			? [relation.name, { kind: "whole", relation: relation.name }]
			: ["View0", { kind: "query", rules: [ruleOf(relation, point.entry.uses)] }]
	return {
		install: {
			base,
			roles: [{ name: "alpha", entries: { [entry]: spec }, write: [entry] }],
			logins: [{ name: "web", roles: ["alpha"] }]
		},
		entry
	}
}

/** A fact without some of its fields. */
const without = (fact: HostFact, fields: ReadonlyArray<string>): HostFact =>
	Rec.filter(fact, (_, field) => !fields.includes(field))

/**
 * The facts an insert through a written relation tries: complete, each carried field at the first value of its pool,
 * and partial, leaving out its first carried field, which no insert states: a fact is the whole fact.
 */
export const factKinds = (base: BaseSpec, w: Written): Arr.NonEmptyReadonlyArray<HostFact> => {
	const fields = defined(relationSpecOf(base, w.target), `the relation ${w.target}`).fields
	const domainOf = (field: string): FieldSpec["domain"] =>
		defined(
			Option.getOrUndefined(Arr.findFirst(fields, (f) => f.name === field)),
			`the field ${field}`
		).domain
	const carried =
		w.kind === "whole"
			? Arr.map(fields, (f) => [f.name, f.name] as const)
			: Arr.map(Rec.toEntries(w.head), ([head, h]) => [head, h.field] as const)
	const complete: HostFact = Rec.fromEntries(
		Arr.map(carried, ([head, field]) => [head, pooled(domainOf(field), 0)] as const)
	)
	const [first] = carried
	return first === undefined ? [complete] : [complete, without(complete, [first[0]])]
}

/** Whether a refusal of a write's inputs before any SQL is an encoder's. */
export const atEncoder = (
	refusal: EncodingFailure | "ResourceBound" | CompileError | UnservedMember
): boolean => refusal !== "ResourceBound" && refusal._tag === "EncodingFailure"

/** Every list of up to two of the facts, each pair once in either order. */
export const factLists = (
	facts: Arr.NonEmptyReadonlyArray<HostFact>
): ReadonlyArray<ReadonlyArray<HostFact>> => [
	[],
	...Arr.map(facts, (f) => [f]),
	...Arr.flatMap(facts, (f, i) => Arr.map(facts.slice(i), (g) => [f, g]))
]
