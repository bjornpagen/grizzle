import type { CheckedEntry } from "#compiler/analysis/schema.ts"
import type { MemberRelation } from "#compiler/check/schema.ts"
import { compareText } from "#compiler/core/canonical.ts"
import { ParamId } from "#compiler/core/ids.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
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
import type { WritableEntry } from "#compiler/schema/entry.ts"
import { isSerialField } from "#compiler/write/insert/statement.ts"

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

/** A serial field of a target an addition may leave out, for its identity to draw it: the member's field that carries
 * it (a head field of a query entry, or the field itself), and the target's field. */
export interface SerialDraw {
	readonly carried: string
	readonly field: string
}

/** The serial fields an addition into E may leave out, the ones its identity draws: the head fields writing a serial
 * field of T the entry's filter does not read. An addition is checked against the filter before its insert, and the
 * identity default draws a serial value only at the insert, so a generated value cannot be checked: a serial field the
 * filter reads is one every fact carries, and a fact omitting it is refused where any fact missing a field is (the
 * host's encoder, or checkMember's heading check for a described member). A serial field the fill fixes is never a
 * head field, and the fill writes its value. Every head field may be drawn, so a generated addition may carry no field:
 * the unit relation, one new fact of T's fixed fields with its drawn fields generated. */
export const entryDraws = (entry: CheckedEntry): ReadonlyArray<SerialDraw> => {
	const checked = new Set(entry.filter.kind === "query" ? entry.filter.fields : [])
	return [...entry.head].flatMap(([head, { field }]) =>
		isSerialField(field) && !checked.has(field) ? [{ carried: head, field: field.name }] : []
	)
}

/** E's facts as a member relation: each head field typed as the field of T it writes, in E's field order, and written
 * as serial exactly where an addition may omit it for its identity to draw it (`entryDraws`), as the caller's where
 * it writes a serial field the filter reads, and otherwise as that field is written. */
export const entryRelation = (entry: CheckedEntry): MemberRelation => {
	const drawn = new Set(entryDraws(entry).map((d) => d.carried))
	return {
		name: entry.entry,
		heading: [...entry.head].map(([head, { field }]) => ({
			name: head,
			type: field.type,
			writing: drawn.has(head)
				? { kind: "serial" }
				: field.writing.kind === "serial"
					? { kind: "caller" }
					: field.writing
		}))
	}
}

const varOf = (id: string): ExprDesc => ({ kind: "var", var: id })

/** The fill of `entry` over a relation parameter carrying `input`, the head fields its source delivers (every one, or
 * every one but those writing a serial field of T for a generated addition), as a query over the base (see `entryFacts`).
 * A generated fill may declare `entryRows` of no field, the unit relation, when every head field writes such a serial
 * field. */
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
			head[fixed.field.name] = { kind: "literal", value: value.value, type: undefined }
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
			.toSorted(([a], [b]) => compareText(a, b))
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

/** A key of the target written through `entry` in the entry's own vocabulary: each head-mapped field under its head
 * field's name, a fixed field, which the entry does not expose, left out. A program over a role never sees the target's
 * name or a field the entry hides, so every witness of a write through the entry names the entry. */
export const entryKey = <V>(
	entry: CheckedEntry,
	values: Readonly<Record<string, V>>
): Readonly<Record<string, V>> => {
	const out: Record<string, V> = {}
	for (const [head, { field }] of entry.head) {
		const value = values[field.name]
		if (value !== undefined) {
			out[head] = value
		}
	}
	return Object.freeze(out)
}

/** The host's view of a query entry's facts (`SlotFacts`): the entry by its name, and each same-key check of the target
 * over the head fields that write it. A fixed field holds one value in every fact of one Db, so a key leaves it out
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
export const entryFacts = (
	entry: CheckedEntry,
	target: HostChecks
): { readonly name: string; readonly host: HostChecks } => {
	const headOf = new Map([...entry.head].map(([head, { field }]) => [field.name, head] as const))
	const mapped = (fields: ReadonlyArray<HostKeyField>): ReadonlyArray<HostKeyField> =>
		fields.flatMap((f) => {
			const head = headOf.get(f.field)
			return head === undefined ? [] : [{ field: head, type: f.type }]
		})
	return {
		name: entry.entry,
		host: {
			keys: target.keys.map((k) => ({
				law: k.law,
				described: k.described,
				fields: mapped(k.fields),
				stated: k.stated
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
 * read, by name, each once in code point order (entryFillable reads exactly these). A ChangeSet compiled once, ahead of
 * the Dbs it runs on (a workload's, at startup), is compiled for each set of them that may hold a fact.
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
	return [...new Set(names)].toSorted(compareText)
}
