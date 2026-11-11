import { sameMembers } from "#compiler/core/array.ts"
import type { NodeId, OccurrenceId } from "#compiler/core/ids.ts"
import { TupleMap } from "#compiler/core/tuple-map.ts"
import {
	contextAdmits,
	type EvidenceContext,
	strongest,
	type TemplateContext
} from "#compiler/ir/evidence.ts"
import {
	type EqualityKey,
	nativeEqualityKey,
	type ScalarExpr,
	type TypedLiteral
} from "#compiler/ir/expr.ts"
import type { EvidenceSide } from "#compiler/ir/law.ts"
import {
	closedCell,
	edgesOf,
	type KindOver,
	type NodeOf,
	type OccurrenceOver,
	type RelNode,
	type ValueRefs,
	type VarDecl
} from "#compiler/ir/rel.ts"

import {
	fixedNames,
	type Props,
	type PropsReading,
	type Provenance,
	provenanceOf,
	relativeProps
} from "#compiler/logical/props.ts"
import { nativeOp } from "#compiler/scalar/compute/registry.ts"

/** A containment as the attachment rule reads it (theory/theory.ts ContainmentEvidence). */
export interface ContainmentFact {
	readonly from: EvidenceSide
	readonly to: EvidenceSide
	readonly coverage: boolean
	readonly statement: "contained" | "alternatives"
	readonly context: EvidenceContext
}

interface AttachEnv {
	readonly context: TemplateContext
	readonly containments: ReadonlyArray<ContainmentFact>
}

interface Delivery {
	readonly delivered: "array" | "option" | "one"
	/** The child's properties relative to the parent's variables. */
	readonly relative: Props
}

/**
 * The parent's fact a set of parent columns was read from: a scan of `relation` whose `fields` the columns hold, in
 * order, every column read from that one scan.
 */
const commonScan = (
	parent: Props,
	columns: ReadonlyArray<string>,
	relation: string,
	fields: ReadonlyArray<string>
): ReadonlyArray<OccurrenceId> => {
	const [first, ...rest] = columns.map((c, i) =>
		provenanceOf(parent, c)
			.filter((p: Provenance) => p.relation === relation && p.field === fields[i])
			.map((p) => p.scan)
	)
	return first === undefined
		? []
		: rest.reduce((scans, here) => scans.filter((s) => here.includes(s)), first)
}

/**
 * The region whose occurrence `scan` is, with that occurrence, among the nodes `from` is computed from: a provenance a
 * node's properties carry names a scan of a region its rows were read through, so the walk down the analysis's readings
 * (Props reading) meets it. Undefined where none of them holds the scan, such as a Base's own occurrence.
 */
const scanOf = (
	from: Props,
	scan: OccurrenceId
):
	| { readonly region: Props; readonly occurrence: OccurrenceOver<Props, ScalarExpr, VarDecl> }
	| undefined => {
	const seen = new Set<Props>([from])
	const queue: Array<Props> = [from]
	for (const props of queue) {
		const reading: PropsReading = props.reading
		if (reading.kind === "MatchRegion") {
			const occurrence = reading.occurrences.find((o) => o.id === scan)
			if (occurrence !== undefined) {
				return { region: props, occurrence }
			}
		}
		for (const input of edgesOf<Props>(reading)) {
			if (!seen.has(input)) {
				seen.add(input)
				queue.push(input)
			}
		}
	}
	return undefined
}

/**
 * The nodes every row of `parent` passes through on its way up from the scan's region: the parent, each node it reads
 * as its one input, down to the region holding `scan`, and that region, whose every row of the scan holds what it fixes.
 */
const throughScan = (parent: Props, region: Props): ReadonlyArray<Props> => {
	const chain: Array<Props> = [parent]
	for (let at = parent; at !== region;) {
		const [only, ...more] = edgesOf<Props>(at.reading)
		if (only === undefined || more.length > 0 || chain.includes(only)) {
			break
		}
		chain.push(only)
		at = only
	}
	return chain.includes(region) ? chain : [...chain, region]
}

/**
 * Whether a scan of the rows `parent` is read from fixes `column` of its source to `value`: a literal constant of the
 * occurrence, or a column read from that field of the scan which a node every row of the parent passes through fixes to
 * that literal, whether the scan's region fixes it or a filter above the region does (throughScan).
 */
const scanSelects = (
	parent: Props,
	scan: OccurrenceId,
	column: string,
	value: TypedLiteral
): boolean => {
	const found = scanOf(parent, scan)
	if (found === undefined) {
		return false
	}
	const want = nativeEqualityKey(value)
	const constant = found.occurrence.constants.find((c) => c.column === column)
	if (constant !== undefined) {
		const e = constant.expr
		return e.kind === "literal" && nativeEqualityKey(e.value) === want
	}
	return throughScan(parent, found.region).some((props) =>
		props.columns.some(
			(c) =>
				provenanceOf(props, c).some((p) => p.scan === scan && p.field === column) &&
				(fixedNames(props, c) ?? []).some((v) => v.name.kind === "literal" && v.name.key === want)
		)
	)
}

/**
 * Whether `fields` are a key of a closed relation's facts: its facts are constants the node holds, so the fields are
 * one where no two facts agree at all of them.
 */
const closedKey = (source: NodeOf<"Closed">, fields: ReadonlyArray<string>): boolean => {
	const positions = fields.map((f) => source.heading.findIndex((c) => c.name === f))
	if (positions.some((at) => at < 0)) {
		return false
	}
	const tuples = new TupleMap<ReadonlyArray<EqualityKey>, ReadonlyArray<TypedLiteral>>()
	for (const row of source.rows) {
		tuples.set(
			positions.map((at) => nativeEqualityKey(closedCell(row, at))),
			row
		)
	}
	return tuples.size === source.rows.length
}

/**
 * The child's plain scan: an optional projection over a region with one occurrence over a stored relation or the facts
 * of a closed relation, with no constant, correlation or equality. Returns the relation, whether a set of its fields is
 * a key (a stored relation's declared keys, which its Base carries, or for a closed relation, which holds its facts as
 * constants, fields its facts never agree at), and the child root column to source column map.
 *
 * One variable bound to two columns of the scan is the predicate that they are equal: no plain scan.
 */
const plainScan = (child: RelNode) => {
	let root = child
	let rename: ReadonlyMap<string, string> = new Map(child.heading.map((c) => [c.name, c.name]))
	if (root.kind === "ProjectSet") {
		const input = root.input
		rename = new Map(
			root.out.flatMap((o) => {
				const e = o.expr
				return e.kind === "column" && e.column.node === input.id
					? [[o.name, e.column.name] as const]
					: []
			})
		)
		root = input
	}
	if (root.kind !== "MatchRegion" || root.occurrences.length !== 1 || root.correlated.length > 0) {
		return undefined
	}
	if (root.equalities.length > 0) {
		return undefined
	}
	const [o] = root.occurrences
	if (o === undefined || o.constants.length > 0) {
		return undefined
	}
	const source = o.source
	const scanned =
		source.kind === "Base" && source.relationKind === "relation"
			? {
					relation: source.relation,
					isKey: (fields: ReadonlyArray<string>) =>
						[source.primaryKey, ...source.keys].some((k) => sameMembers(k, fields))
				}
			: source.kind === "Closed"
				? {
						relation: source.closed,
						isKey: (fields: ReadonlyArray<string>) => closedKey(source, fields)
					}
				: undefined
	if (scanned === undefined) {
		return undefined
	}
	const columnOfVar = new Map<string, string>()
	for (const b of o.bindings) {
		const v = b.var.name
		if (columnOfVar.has(v) && columnOfVar.get(v) !== b.column) {
			return undefined
		}
		columnOfVar.set(v, b.column)
	}
	const toSource = new Map<string, string>()
	for (const [out, v] of rename) {
		const c = columnOfVar.get(v)
		if (c !== undefined) {
			toSource.set(out, c)
		}
	}
	return { ...scanned, toSource }
}

/** Each of the distinct `fields` with what `of` maps it to, when `of` maps exactly those fields; undefined otherwise. */
const mappedExactly = (
	fields: ReadonlyArray<string>,
	of: ReadonlyMap<string, string>
): ReadonlyArray<{ readonly field: string; readonly to: string }> | undefined => {
	if (fields.length !== of.size) {
		return undefined
	}
	const out: Array<{ readonly field: string; readonly to: string }> = []
	for (const field of fields) {
		const to = of.get(field)
		if (to === undefined) {
			return undefined
		}
		out.push({ field, to })
	}
	return out
}

/**
 * The containment proof of exactly one child row per parent.
 *
 * A second pair onto the same source column constrains the child by another parent column too: the child is
 * empty unless both parent columns agree, which no containment proves.
 *
 * Only a declared `contained` types a bare child, each of a mirrors' two among them: an alternatives arm proves the
 * same existence, but the API states bare delivery from containments alone, and the delivered shape is the one
 * the public type promises.
 *
 * The fields are a key's, so distinct; the correlation covers exactly them.
 */
const containmentOne = (
	attach: NodeOf<"Attach">,
	parent: Props,
	child: RelNode,
	env: AttachEnv
): EvidenceContext | undefined => {
	const scan = plainScan(child)
	if (scan === undefined) {
		return undefined
	}
	/** Child source column -> the parent column it is correlated with. */
	const parentOf = new Map<string, string>()
	for (const pair of attach.correlation) {
		const c = scan.toSource.get(pair.child)
		if (c === undefined || parentOf.has(c)) {
			return undefined
		}
		parentOf.set(c, pair.parent)
	}
	for (const fact of env.containments) {
		if (fact.statement !== "contained") {
			continue
		}
		if (fact.coverage || fact.to.relation !== scan.relation || fact.to.selection.length > 0) {
			continue
		}
		if (!contextAdmits(env.context, fact.context)) {
			continue
		}
		if (!scan.isKey(fact.to.fields)) {
			continue
		}
		const correlated = mappedExactly(fact.to.fields, parentOf)
		if (correlated === undefined) {
			continue
		}
		const scans = commonScan(
			parent,
			correlated.map((c) => c.to),
			fact.from.relation,
			fact.from.fields
		)
		const selected = scans.some((s) =>
			fact.from.selection.every((sel) => scanSelects(parent, s, sel.column, sel.value))
		)
		if (selected) {
			return fact.context
		}
	}
	return undefined
}

/**
 * A symbolic value under the substitution of the parent's fact for the child's scan: a parent fact's field, or a
 * literal.
 */
type Sym =
	| { readonly kind: "field"; readonly scan: OccurrenceId; readonly field: string }
	| { readonly kind: "literal"; readonly key: string }

const symKey = (s: Sym): string =>
	s.kind === "field" ? `f\u0000${s.scan}\u0000${s.field}` : `l\u0000${s.key}`

/**
 * Evaluates a predicate under a substitution of column symbols: true, false, or unknown (undefined).
 *
 * Any other operator's value is unknown here.
 */
const evaluate = (
	e: ScalarExpr,
	column: (name: string) => Sym | undefined,
	node: NodeId
): boolean | undefined => {
	const sym = (a: ScalarExpr): Sym | undefined => {
		if (a.kind === "column" && a.column.node === node) {
			return column(a.column.name)
		}
		if (a.kind === "literal") {
			return { kind: "literal", key: nativeEqualityKey(a.value) }
		}
		return undefined
	}
	if (e.kind === "literal" && e.value.kind === "bool") {
		return e.value.value
	}
	if (e.kind !== "op") {
		return undefined
	}
	const fn = nativeOp(e.op)?.fn
	if (fn === "and") {
		const vs = e.args.map((a) => evaluate(a, column, node))
		if (vs.some((v) => v === false)) {
			return false
		}
		return vs.every((v) => v === true) ? true : undefined
	}
	if (fn === "or") {
		const vs = e.args.map((a) => evaluate(a, column, node))
		if (vs.some((v) => v === true)) {
			return true
		}
		return vs.every((v) => v === false) ? false : undefined
	}
	if (fn === "not") {
		const [arg] = e.args
		const v = arg === undefined ? undefined : evaluate(arg, column, node)
		return v === undefined ? undefined : !v
	}
	if (fn !== "eq" && fn !== "le" && fn !== "ge" && fn !== "ne" && fn !== "lt" && fn !== "gt") {
		return undefined
	}
	const [x, y] = e.args.map((a) => sym(a))
	if (x === undefined || y === undefined || symKey(x) !== symKey(y)) {
		return undefined
	}
	return fn === "eq" || fn === "le" || fn === "ge"
}

/**
 * The reflexive self-match proof of a nonempty aggregate group per parent.
 *
 * The correlation pairs exactly the group key, each key column once: a pair on an aggregate output filters the
 * group by its value, and a key paired twice by the agreement of two parent columns, either of which can leave the
 * child empty for a parent.
 *
 * The child's scan, read as the parent's own fact: every bound variable is that fact's field.
 *
 * Every variable read from the parent agrees with the substitution, or is that fact's field when unbound.
 */
const reflexiveOne = (attach: NodeOf<"Attach">, parent: Props, child: RelNode): boolean => {
	if (child.kind !== "Group") {
		return false
	}
	const correlatedChild = new Map(attach.correlation.map((p) => [p.child, p.parent]))
	if (correlatedChild.size !== attach.correlation.length) {
		return false
	}
	const keyParents = mappedExactly(child.keys, correlatedChild)
	if (keyParents === undefined) {
		return false
	}
	/** The filters between the group and its region. */
	const filters: Array<NodeOf<"Filter">> = []
	let at = child.input
	while (at.kind === "Filter") {
		filters.push(at)
		at = at.input
	}
	if (at.kind !== "MatchRegion" || at.equalities.length > 0) {
		return false
	}
	const region = at
	const [o, ...others] = region.occurrences
	if (o === undefined || others.length > 0) {
		return false
	}
	const source = o.source
	if (source.kind !== "Base") {
		return false
	}
	/**
	 * What the child's region reads from the parent: a correlated variable or constant naming a parent column, and a
	 * group key correlated with one.
	 */
	const parentColumnOf = (x: ScalarExpr): string | undefined =>
		x.kind === "column" && x.column.node === attach.parent.id ? x.column.name : undefined
	const fromParent = new Map<string, string>()
	for (const c of region.correlated) {
		const pc = parentColumnOf(c.expr)
		if (pc === undefined) {
			return false
		}
		fromParent.set(c.var.name, pc)
	}
	for (const k of keyParents) {
		fromParent.set(k.field, k.to)
	}
	/** Each candidate parent fact of the source relation. */
	const candidates = new Set(
		[...fromParent.values()].flatMap((pc) =>
			provenanceOf(parent, pc)
				.filter((p) => p.relation === source.relation)
				.map((p) => p.scan)
		)
	)
	const fieldOfParent = (pc: string, scan: OccurrenceId): string | undefined =>
		provenanceOf(parent, pc).find((p) => p.scan === scan && p.relation === source.relation)?.field
	/** Each variable's parent field when `scan` is the parent fact, or none when the fact cannot be it. */
	const symsOf = (scan: OccurrenceId): ReadonlyMap<string, Sym> | undefined => {
		const sym = new Map<string, Sym>()
		const bind = (v: string, s: Sym): boolean => {
			const prior = sym.get(v)
			sym.set(v, s)
			return prior === undefined || symKey(prior) === symKey(s)
		}
		for (const b of o.bindings) {
			if (!bind(b.var.name, { kind: "field", scan, field: b.column })) {
				return undefined
			}
		}
		const constantsHold = o.constants.every((c) => {
			const pc = parentColumnOf(c.expr)
			return pc !== undefined && fieldOfParent(pc, scan) === c.column
		})
		if (!constantsHold) {
			return undefined
		}
		for (const [v, pc] of fromParent) {
			const field = fieldOfParent(pc, scan)
			if (field === undefined || !bind(v, { kind: "field", scan, field })) {
				return undefined
			}
		}
		return sym
	}
	return [...candidates].some((scan) => {
		const sym = symsOf(scan)
		return (
			sym !== undefined &&
			filters.every((f) => evaluate(f.pred, (name) => sym.get(name), f.input.id) === true)
		)
	})
}

/**
 * The node whose rows a child delivers: an Attach delivers exactly its parent's rows under the same heading, so a
 * chain of attachments is read through to the node beneath it.
 */
const rowsNode = (node: RelNode): RelNode => (node.kind === "Attach" ? rowsNode(node.parent) : node)

/**
 * The delivered type of an attachment, and its child's properties relative to the parent.
 *
 * The delivered type of an attachment.
 *
 * The child's evidence is judged relative to the parent's variables: every child column correlated with a parent
 * column is fixed per parent, so the child's keys are reduced by them. The delivered type is the widest sound one,
 * narrowed only by proof:
 *
 * - Option<Child> when the child has at most one row per parent: its correlated columns cover one of its keys, it is a
 *   take(1), or it is an aggregate whose group key lies within the parent-bound columns, an aggregate-only child
 *   included;
 * - the bare Child when, beyond that, the child is exactly one row per parent, by one of two proofs:
 *   - a declared `contained` maps the parent's bound fields onto the child's key: the child is a plain scan of the
 *     key's relation with no further predicate, its correlated columns are exactly a declared key of it, and the
 *     parent's correlated columns were read from one fact of the containment's source relation, the fields in order,
 *     satisfying the source's selection; the containment must be valid in the reading context, so a
 *     deferred law is used only under committed-snapshot evidence. An alternatives arm proves the same
 *     existence, but the public type states bare delivery from containments alone, and the
 *     delivered shape is the one the type promises: its arms are Some or None by the handle,
 *     an Option here;
 *   - a reflexive self-match: the child is an aggregate over one scan of the relation the parent's fact was read from,
 *     whose filter the parent's own fact satisfies, so its group is never empty;
 * - ReadonlyArray<Child> otherwise.
 */
export const delivery = (
	attach: NodeOf<"Attach">,
	reading: KindOver<"Attach", ValueRefs<Props>>,
	env: AttachEnv
): Delivery => {
	const childNode = rowsNode(attach.child)
	const relative = relativeProps(reading.child, attach)
	if (relative.card === "many") {
		return { delivered: "array", relative }
	}
	if (relative.card === "one") {
		return { delivered: "one", relative }
	}
	if (reflexiveOne(attach, reading.parent, childNode)) {
		return { delivered: "one", relative: { ...relative, card: "one" } }
	}
	const context = containmentOne(attach, reading.parent, childNode, env)
	if (context !== undefined) {
		return {
			delivered: "one",
			relative: { ...relative, card: "one", context: strongest([relative.context, context]) }
		}
	}
	return { delivered: "option", relative }
}
