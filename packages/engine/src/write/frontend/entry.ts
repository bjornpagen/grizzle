import type { CheckedEntry, ClaimsMembership } from "#compiler/analysis/schema.ts"
import type { MemberRelation } from "#compiler/check/schema.ts"
import { EntryName, ParamId } from "#compiler/core/ids.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import { compareStrings } from "#compiler/core/order.ts"
import type {
	ChangeSetDesc,
	ContextDesc,
	ExprDesc,
	FieldDesc,
	HeadTermDesc,
	MatchDesc,
	QueryDesc,
	VarDesc
} from "#compiler/ir/desc.ts"
import type { Heading } from "#compiler/ir/rel.ts"
import type { HostChecks, HostKeyField } from "#compiler/runtime/write/normalize.ts"
import type { EntryKey, WitnessEntry } from "#compiler/runtime/write/witness.ts"
import { irLiteral } from "#compiler/scalar/compute/literal.ts"
import type { WritableEntry } from "#compiler/schema/entry.ts"
import type { SlotFacts } from "#compiler/write/frontend/compile.ts"

/** A fill's relation parameter, its declared name: the front end substitutes the sources that fill the fill for it
 * before the DAG is built (dag.ts substitute). */
export const entryRowsParam = ParamId("entryRows")

/** Which contexts a compilation's Db holds a fact of: every one, for a compilation that serves no Db (a workload, which
 * plans indexes for any claims), or those its claims hold. */
export type EntryClaims =
	| { readonly kind: "every" }
	| { readonly kind: "facts"; readonly present: ReadonlySet<string> }

/** The contexts an entry's fixed fields read, by name, each once. */
const fixedContexts = <Target, F>(
	entry: WritableEntry<Target, F>
): ReadonlyMap<string, ContextDesc> => {
	const out = new Map<string, ContextDesc>()
	for (const f of entry.fixed) {
		if (f.value.kind === "context") {
			out.set(f.value.context.name, f.value.context)
		}
	}
	return out
}

/** Whether every context an entry's fixed fields read holds a fact under `claims`. */
export const entryFillable = (entry: CheckedEntry, claims: EntryClaims): boolean =>
	claims.kind === "every" ||
	[...fixedContexts(entry).keys()].every((name) => claims.present.has(name))

/** E's facts as a member relation: each head field typed and written as the field of T it writes, in E's field
 * order. */
export const entryRelation = (entry: CheckedEntry): MemberRelation => ({
	name: entry.entry,
	heading: [...entry.head].map(([head, { field }]) => ({
		name: head,
		type: field.type,
		writing: field.writing
	}))
})

const varOf = (id: string): ExprDesc => ({ kind: "var", var: id })

/** The fill of `entry` over a relation parameter carrying `input`, the head fields its source delivers, as a query
 * over the base (see `entryFacts`). An entry of no head field declares `entryRows` of no field, the unit relation. */
export const fillQuery = (entry: CheckedEntry, input: Heading, loc: SourceLoc): QueryDesc => {
	const carried = new Set(input.map((c) => c.name))
	const heading: Record<string, FieldDesc> = {}
	const rowBindings: Record<string, ExprDesc> = {}
	const vars: Array<VarDesc> = []
	const head: Record<string, HeadTermDesc> = {}
	for (const [headField, { field }] of entry.head) {
		if (!carried.has(headField)) {
			continue
		}
		const id = `entry_${headField}`
		heading[headField] = field.desc
		rowBindings[headField] = varOf(id)
		vars.push({ loc, id, origin: undefined })
		head[field.name] = varOf(id)
	}
	/** Each context the fixed fields read, by name, with the variables its match binds. */
	const contextBindings = new Map<
		string,
		{ readonly context: ContextDesc; readonly bindings: Record<string, ExprDesc> }
	>()
	for (const fixed of entry.fixed) {
		const value = fixed.value
		if (value.kind === "literal") {
			head[fixed.field.name] = { kind: "literal", value: value.value }
			continue
		}
		const id = `entry_${value.context.name}_${value.field}`
		const bindings = contextBindings.get(value.context.name)?.bindings ?? {}
		if (bindings[value.field] === undefined) {
			bindings[value.field] = varOf(id)
			vars.push({ loc, id, origin: undefined })
		}
		contextBindings.set(value.context.name, { context: value.context, bindings })
		head[fixed.field.name] = varOf(id)
	}
	const matches: Array<MatchDesc> = [
		{ loc, source: { kind: "param", name: entryRowsParam, heading }, bindings: rowBindings },
		...[...contextBindings]
			.toSorted(([a], [b]) => compareStrings(a, b))
			.map(([, { context, bindings }]): MatchDesc => ({
				loc,
				source: { kind: "context", context },
				bindings
			}))
	]
	return {
		stage: {
			kind: "rules",
			loc,
			arms: [{ loc, vars, matches, where: [], head, interiors: [], attach: [] }]
		}
	}
}

/** A query entry's key in its own words (runtime/write/witness.ts EntryKey): its name, and each head field to the
 * target field it writes. */
export const entryKeyOf = (entry: CheckedEntry): EntryKey => ({
	entry: entry.entry,
	head: new Map([...entry.head].map(([head, { field }]) => [head, field.name] as const))
})

/**
 * The key a write held to its role's claims states its facts by (analysis/schema.ts ClaimsMembership): the relation's
 * own, under its name, each field its own, so a precheck's refusal names the relation and its witness the relation's
 * fields as the write stated them.
 */
export const claimsKeyOf = (membership: ClaimsMembership): EntryKey => ({
	entry: EntryName(membership.target.name),
	head: new Map(membership.target.heading.map((f) => [f.name, f.name] as const))
})

/** A query entry as the host reads its facts back into facts of its target (runtime/write/witness.ts WitnessEntry): its
 * key (`entryKeyOf`), and each literal-fixed target field with its literal. */
const witnessEntry = (entry: CheckedEntry): WitnessEntry => ({
	...entryKeyOf(entry),
	fixed: entry.fixed.flatMap((fixed) => {
		if (fixed.value.kind !== "literal") {
			return []
		}
		const literal = irLiteral(fixed.value.value, fixed.field.type)
		return literal.ok
			? [{ field: fixed.field.name, type: fixed.field.type, literal: literal.value }]
			: []
	})
})

/** The host's view of a query entry's facts (`SlotFacts`): stated in the entry's words, and each same-key check of the
 * target over the head fields that write it. A fixed field holds one value in every fact of one Db, so a key leaves it out
 * and still holds two facts apart exactly when the target's key does; a span check whose span field is fixed is left
 * to the statement, which probes it.
 *
 * A write into a writable query entry, as the write front end lowers it.
 *
 * A member of a role's query entry E writes E's facts, whose fields are E's head. The front end
 * lowers it to a described member of E's target T: the member's own source, E's facts, read through E's fill, the query
 * over a relation parameter of E's heading that maps each head field to the field of T it writes and fills each fixed
 * field of T from its literal or from the context field it is fixed to:
 *
 *   rule: match(entryRows, { <head field>: x, ... }), match(<Context>, { <field>: y, ... }), ...
 *         find({ <head-mapped field of T>: x, <literal-fixed field>: <literal>, <context-fixed field>: y, ... })
 *
 * The front end checks the fill against the base as a member of T, so the checker types every head term by T's field,
 * literals included, and then replaces its relation parameter with the source that fills it: the InputSet of the
 * member's enumerated slot, or the root of its described query, conformed to E's heading (`replace`). Every
 * statement downstream reads T's facts, exactly as a write of T's own.
 *
 * The fill joins the contexts its fixed fields read, so a context with no fact fills no row. A Db's claims are known
 * before its ChangeSet compiles, so the front end compiles for the contexts that hold a fact (EntryClaims): an addition
 * into an entry whose fixed fields read an absent context fills no fact, and every fact it requests is outside the
 * world, so it is no action at all but a refusal of its source, raised when the source holds any row; a deletion there is
 * a no-op and is dropped. With every context present, an addition is prechecked against the entry's membership before
 * it writes. */
export const entryFacts = (entry: CheckedEntry, target: HostChecks): SlotFacts => {
	const headOf = new Map([...entry.head].map(([head, { field }]) => [field.name, head] as const))
	const mapped = (fields: ReadonlyArray<HostKeyField>): ReadonlyArray<HostKeyField> =>
		fields.flatMap((f) => {
			const head = headOf.get(f.field)
			return head === undefined ? [] : [{ field: head, type: f.type }]
		})
	return {
		stated: { kind: "entry", entry: witnessEntry(entry) },
		generations: [],
		host: {
			keys: target.keys.map((k) => ({
				law: k.law,
				described: k.described,
				fields: mapped(k.fields)
			})),
			spans: target.spans.flatMap((check) => {
				const span = headOf.get(check.span.field)
				return span === undefined
					? []
					: [
							{
								law: check.law,
								described: check.described,
								equal: mapped(check.equal),
								span: { field: span, type: check.span.type }
							}
						]
			})
		}
	}
}

/**
 * The contexts a ChangeSet's compilation depends on for a role: those the fixed fields of every query entry it writes
 * read, by name, each once in code point order (entryFillable reads exactly these); a whole entry fixes no field. A
 * ChangeSet compiled once, ahead of the Dbs it runs on (a workload's, at startup), is compiled for each set of them that
 * may hold a fact.
 */
export const fillContexts = <Target, F>(
	writes: ReadonlyMap<
		string,
		| { readonly kind: "whole" }
		| { readonly kind: "rows"; readonly writable: WritableEntry<Target, F> }
	>,
	changeSet: ChangeSetDesc
): ReadonlyArray<string> => {
	const names = changeSet.strata.flatMap((stratum) =>
		stratum.members.flatMap((member) => {
			const write = writes.get(member.relation)
			return write?.kind !== "rows" ? [] : [...fixedContexts(write.writable).keys()]
		})
	)
	return [...new Set(names)].toSorted(compareStrings)
}
