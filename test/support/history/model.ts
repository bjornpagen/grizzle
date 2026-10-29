import { Array as Arr } from "effect"
import {
	collide,
	type Expected,
	expect,
	type HostFact,
	type HostSchema,
	type HostState,
	type HostOp,
	projection,
	relationOf,
	transition,
	type Violation,
	violations,
	violatorsOf
} from "#test/pg/laws/families/model.ts"

/**
 * Who runs an operation: a grizzle writer, whose every write is one db.apply, or a direct SQL writer; both
 * SERIALIZABLE.
 */
export type Writer = { readonly kind: "grizzle" } | { readonly kind: "direct" }
export type WriterKind = Writer["kind"]

/**
 * What a direct writer makes immediate after its last statement: nothing, every constraint (SET CONSTRAINTS ALL
 * IMMEDIATE), or its schema's law triggers by their schema-qualified names, which leaves its deferred foreign keys to
 * COMMIT.
 */
export type Immediacy = "deferred" | "every constraint" | "law triggers"

const identity = (host: HostSchema, relation: string, fact: HostOp["facts"][number]): string =>
	projection(
		fact,
		Arr.map(relationOf(host, relation).fields, (f) => f.name)
	)

/** Whether a relation has a span key, which no ON CONFLICT DO UPDATE arbitrates on. */
const hasSpanKey = (host: HostSchema, relation: string): boolean =>
	Arr.some(host.laws, (l) => l.kind === "spanKey" && l.relation === relation)

/**
 * A direct writer's replacement of a stored fact: its deletion, then the insertion of `next` at its key, a fact of
 * another payload, in one transaction, as any psql writer replaces a fact and as grizzle's own put does on an immutable
 * relation.
 */
export interface Replacement {
	readonly relation: string
	readonly old: HostFact
	readonly next: HostFact
}

/**
 * The direct writer's form of drawn operations and stated replacements: puts only on a mutable relation without a span
 * key (an immutable relation grants no UPDATE, and no upsert arbitrates on an exclusion constraint, so a put there
 * becomes an insertion), each key at most once among a relation's insertions and puts, and deletions deduplicated and
 * kept off the keys the transaction writes, so each key is one statement of the transaction. A stated replacement is
 * the one exception: its deletion of the old fact and its insertion at that key are both kept, as two statements, and
 * nothing else of the transaction writes or deletes at that key. The replacements' deletions come first, so a
 * transaction that states one runs its first replacement's deletion as its first statement.
 */
export const directOps = (
	host: HostSchema,
	ops: ReadonlyArray<HostOp>,
	replacements: ReadonlyArray<Replacement>,
	isMutable: boolean
): ReadonlyArray<HostOp> => {
	const written = new Set<string>()
	const deleted = new Set<string>()
	const keyOf = (relation: string, fact: HostFact): string =>
		`${relation} ${projection(fact, relationOf(host, relation).key)}`
	const replaced = Arr.filter(replacements, (r) => {
		const at = keyOf(r.relation, r.old)
		if (keyOf(r.relation, r.next) !== at) {
			throw new Error(`a replacement of ${at} inserts at another key`)
		}
		if (written.has(at)) {
			return false
		}
		written.add(at)
		deleted.add(`${r.relation} ${identity(host, r.relation, r.old)}`)
		return true
	})
	const writes = Arr.flatMap(ops, (o): ReadonlyArray<HostOp> => {
		if (o.kind === "delete") {
			return []
		}
		const facts = Arr.filter(o.facts, (f) => {
			const id = keyOf(o.relation, f)
			if (written.has(id)) {
				return false
			}
			written.add(id)
			return true
		})
		const upsert = o.kind === "put" && isMutable && !hasSpanKey(host, o.relation)
		return facts.length === 0
			? []
			: [{ relation: o.relation, kind: upsert ? "put" : "insert", facts }]
	})
	const deletes = Arr.flatMap(ops, (o): ReadonlyArray<HostOp> => {
		if (o.kind !== "delete") {
			return []
		}
		const facts = Arr.filter(o.facts, (f) => {
			const id = `${o.relation} ${identity(host, o.relation, f)}`
			if (deleted.has(id) || written.has(keyOf(o.relation, f))) {
				return false
			}
			deleted.add(id)
			return true
		})
		return facts.length === 0 ? [] : [{ relation: o.relation, kind: "delete", facts }]
	})
	return [
		...Arr.map(replaced, (r): HostOp => ({
			relation: r.relation,
			kind: "delete",
			facts: [r.old]
		})),
		...deletes,
		...Arr.map(replaced, (r): HostOp => ({
			relation: r.relation,
			kind: "insert",
			facts: [r.next]
		})),
		...writes
	]
}

/** The immediate laws one written row of `relation` breaks against the rows `others` it meets (see the header). */
const rowViolations = (
	host: HostSchema,
	relation: string,
	others: ReadonlyArray<HostOp["facts"][number]>,
	fact: HostOp["facts"][number]
): ReadonlyArray<Violation> =>
	Arr.flatMap(host.laws, (law): ReadonlyArray<Violation> => {
		if ((law.kind === "key" || law.kind === "spanKey") && law.relation === relation) {
			return Arr.some(others, (g) => collide(law, fact, g))
				? [{ law: law.law, immediate: true, violators: violatorsOf(host, law, [fact]) }]
				: []
		}
		if (law.kind === "check" && law.relation === relation) {
			return law.holds(fact) ? [] : [{ law: law.law, immediate: true, violators: [] }]
		}
		return []
	})

/** What a direct writer's transaction of `ops` must do from the lawful `state`. */
export const expectDirect = (
	host: HostSchema,
	state: HostState,
	ops: ReadonlyArray<HostOp>
): Expected => {
	let current = transition(
		host,
		state,
		Arr.filter(ops, (o) => o.kind === "delete")
	)
	/** Each written row in statement order: an insertion's or an upsert's, one fact at a time. */
	const rows = Arr.flatMap(ops, (o) =>
		o.kind === "delete" ? [] : Arr.map(o.facts, (fact) => ({ op: o, fact }))
	)
	for (const { op, fact } of rows) {
		const key = relationOf(host, op.relation).key
		/** An upsert replaces the occupant at its arbiter key; an insertion meets every stored row. */
		const others = Arr.filter(
			current.get(op.relation) ?? [],
			(g) => op.kind === "insert" || projection(g, key) !== projection(fact, key)
		)
		const broken = rowViolations(host, op.relation, others, fact)
		if (broken.length > 0) {
			return { kind: "invariant-rejected", violations: broken }
		}
		current = transition(host, current, [{ relation: op.relation, kind: op.kind, facts: [fact] }])
	}
	const all = violations(host, current)
	if (all.length > 0) {
		return { kind: "invariant-rejected", violations: all }
	}
	return { kind: "accepted", state: current }
}

/**
 * What one operation of a history must do from a state, for each kind of writer.
 *
 * Every writer runs SERIALIZABLE. A grizzle writer applies the ChangeSet of its host operations, an add-wins transition
 * judged by its final state: model.ts `expect`, unchanged. A direct SQL writer runs the same operations as plain SQL in
 * one SERIALIZABLE transaction (writeSteps): every deletion first, a DELETE of each exact fact, then each insertion as
 * an INSERT and each put, on a mutable relation without a span key only, as an INSERT ... ON CONFLICT (key) DO UPDATE.
 * It sees PostgreSQL's native outcomes instead of grizzle's:
 *
 * - every immediate law is checked row by row, as PostgreSQL checks a non-deferrable unique index, an exclusion
 *   constraint and a CHECK as each row is written: an inserted row at an occupied value of a key, even an exact repeat
 *   of a stored fact, is a unique violation; one overlapping a stored span at a span key's scalars an exclusion
 *   violation; one a row check refuses a check violation; an upserted row meets the same keys, apart from the occupant
 *   its arbiter key replaces. Each is raised at its statement, before any deferred law;
 * - otherwise the final state (S \ D) ∪ A, with each put replacing the occupant at its key, is judged by every law's
 *   violation query, as a grizzle writer's is; an unchanged state is simply a commit.
 *
 * A transaction's deletions and writes are drawn on distinct keys, except a stated replacement, which deletes then
 * inserts at one key (directOps). The model applies a replacement as exactly that deletion and that insertion at the
 * transaction's place in the serial order: the old fact goes with every other deletion, and the new one meets the keys
 * as every other insertion does.
 */
export const expectFor = (
	kind: WriterKind,
	host: HostSchema,
	state: HostState,
	ops: ReadonlyArray<HostOp>
): Expected => (kind === "grizzle" ? expect(host, state, ops) : expectDirect(host, state, ops))
