/** What borrows.test.ts reads: its drawn members and installations, and the borrow rules restated over them. */

import { maxOf } from "@bjornpagen/grizzle-text/base/array"
import { boolean, constant, element, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import {
	type BorrowFault,
	type BorrowInstallation,
	borrowInstallation,
	type UnitPlace
} from "#compiler/analysis/isolation/borrows.ts"
import type {
	Binding,
	MemberFacts,
	ReadFact,
	ReadMode,
	RelationFacts,
	StatementFacts,
	WriteFact
} from "#compiler/analysis/isolation/facts.ts"
import type { Borrow } from "#compiler/core/certificate.ts"
import type { TablePrivilege } from "#compiler/core/privilege.ts"

/** The box's relations: L and M, each keyed (k, n), under the unit Learner at k where drawn so; F, a fact keyed (k). */
export type Rel = "L" | "M" | "F"

const RELS: Arr.NonEmptyReadonlyArray<Rel> = ["L", "M", "F"]

/** What a read binds its relation's fields to: the call's parameter :k or :n, a column no binding names, or nothing. */
type By = ":k" | ":n" | "row.c"

interface DrawnRead {
	readonly rel: Rel
	readonly mode: ReadMode
	readonly k: By | undefined
	readonly n: By | undefined
}

interface DrawnWrite {
	readonly rel: Rel
	readonly op: WriteFact["op"]
	/** Whether the write's rows are joined with its statement's first read. */
	readonly joined: boolean
}

interface DrawnStatement {
	readonly reads: ReadonlyArray<DrawnRead>
	readonly write: DrawnWrite | undefined
}

/** A case: which of L and M sit in Learner, what roles may do to each relation, and one member's statements. */
export interface Drawn {
	readonly inUnit: ReadonlySet<Rel>
	readonly grants: ReadonlyMap<Rel, ReadonlySet<TablePrivilege>>
	readonly statements: Arr.NonEmptyReadonlyArray<DrawnStatement>
}

const byGen: Gen<By | undefined> = element([":k", ":n", "row.c", undefined] as const)

const readGen: Gen<DrawnRead> = (s) => ({
	rel: s.draw(element(RELS)),
	mode: s.draw(element(["positive", "negated", "counted", "arbiter"] as const)),
	k: s.draw(byGen),
	n: s.draw(byGen)
})

const writeGen: Gen<DrawnWrite> = (s) => ({
	rel: s.draw(element(RELS)),
	op: s.draw(
		weighted<WriteFact["op"]>([
			[2, constant("insert")],
			[1, constant("update")],
			[1, constant("delete")]
		])
	),
	joined: s.draw(boolean)
})

const statementGen: Gen<DrawnStatement> = (s) => {
	const reads = Array.from({ length: s.draw(int(0, 2)) }, () => s.draw(readGen))
	return { reads, write: s.draw(boolean) ? s.draw(writeGen) : undefined }
}

const grantGen: Gen<ReadonlySet<TablePrivilege>> = (s) =>
	new Set(
		s.draw(element([[], ["SELECT", "INSERT"], ["SELECT", "INSERT", "UPDATE", "DELETE"]] as const))
	)

export const drawnGen: Gen<Drawn> = (s) => {
	const first = s.draw(statementGen)
	const rest = Array.from({ length: s.draw(int(0, 1)) }, () => s.draw(statementGen))
	return {
		inUnit: new Set(Arr.filter(["L", "M"] as const, () => s.draw(boolean))),
		grants: new Map(Arr.map(RELS, (rel) => [rel, s.draw(grantGen)] as const)),
		statements: [first, ...rest]
	}
}

/** What a drawn binding is (facts.ts Binding): the parameter :k or :n, or a column of the call's own rows, one per row. */
const bindingOf = (by: By): Binding => {
	switch (by) {
		case ":k":
			return { kind: "param", name: "k" }
		case ":n":
			return { kind: "param", name: "n" }
		case "row.c":
			return { kind: "own", alias: "row", column: "c", rows: "many" }
	}
}

const relationFacts = (rel: Rel): RelationFacts => ({
	triggerLaws: [],
	keys: [rel === "F" ? ["k"] : ["k", "n"]],
	countedGroups: [],
	references: [],
	inserts: { kind: "repeatable" }
})

/** A case's installation: each relation's facts, Learner's members at k, and one role's grants. */
export const installationOf = (d: Drawn): BorrowInstallation =>
	borrowInstallation(
		new Map(Arr.map(RELS, (rel) => [rel, relationFacts(rel)] as const)),
		[new Map(Arr.map([...d.grants], ([rel, held]) => [rel, held] as const))],
		new Map(
			Arr.map([...d.inUnit], (rel): readonly [string, UnitPlace] => [
				rel,
				{ unit: "Learner", fields: [{ key: "child", field: "k" }] }
			])
		),
		new Set()
	)

const readOf = (r: DrawnRead): ReadFact => {
	const bound = [
		...(r.k === undefined ? [] : [{ field: "k", by: bindingOf(r.k) }]),
		...(r.n === undefined ? [] : [{ field: "n", by: bindingOf(r.n) }])
	]
	return {
		relation: r.rel,
		mode: r.mode,
		base: r.mode,
		probes: [],
		own: false,
		group: Arr.isReadonlyArrayNonEmpty(bound) ? { bound } : undefined
	}
}

const statementOf = (s: DrawnStatement): StatementFacts => ({
	writes:
		s.write === undefined
			? []
			: [
					{
						relation: s.write.rel,
						op: s.write.op,
						from:
							s.write.joined && s.reads.length > 0 && s.reads[0]?.mode === "positive"
								? [{ cte: undefined, read: 0 }]
								: []
					}
				],
	reads: Arr.map(s.reads, readOf),
	probes: [],
	cores: [],
	uses: [],
	ctes: []
})

export const memberOf = (d: Drawn): MemberFacts => ({
	name: "m",
	statements: Arr.map(d.statements, statementOf)
})

/** What a fault says, as the comparison reads it. */
export const faultKey = (f: BorrowFault): string => `${f.statement}|${f.relation}|${f.kind}`

/** What a borrow says, as the comparison reads it: its unit, mode, place and how many keys it locks. */
export const borrowKey = (b: Borrow): string =>
	`${b.lock.kind === "unit" ? b.lock.unit : b.lock.relation}|${b.mode}|${b.at}|${b.keys.length}`

/** The rules restated over a case (the oracle): the faults by their keys, the borrows, and what it reached. */
export interface Expected {
	readonly faults: ReadonlySet<string>
	readonly borrows: ReadonlyArray<string>
	readonly features: ReadonlySet<BorrowFeature>
}

/** What a case reaches, as the oracle reads it off the drawn shape. */
export type BorrowFeature =
	| "a unit written under its exclusive borrow"
	| "a unit written at no key"
	| "a held positive read"
	| "a held absence read"
	| "a unit read at no key"
	| "a change outside every unit"
	| "an insert into a relation a role changes"
	| "a read of a relation no role writes"
	| "a read of a relation a role changes"
	| "an arbitration a unique check decides"
	| "an absence outside every unit"
	| "an immutable fact"
	| "an unborrowed read"
	| "a write not joined with a fact its statement reads"
	| "a write after a fact, joined with no held row"
	| "a write before a fact read only later"

/** The text of a read's group, as two reads of one group share it. */
const groupText = (r: DrawnRead): string =>
	`${r.rel}(${r.k === undefined ? "" : `k=${r.k}`},${r.n === undefined ? "" : `n=${r.n}`})`

/**
 * The borrow rules over the drawn case, apart from the code (analysis/isolation/borrows.ts's doc): a read of a unit's
 * relation binding k to a parameter is held, shared, and any other a fault; a write of a unit's relation is exclusive
 * at the key its statement's arbitration (an insert) or other read (an update or delete) binds, else a fault; outside
 * the unit, an update or delete is a fault, an insert into a relation a role changes too; a read of a relation no role
 * writes is sealed, an arbitration binding a whole key of an insert-only relation too; a read of a changed relation
 * is unborrowed; a negated, counted or arbitration read of an inserted one is an absence; a positive read binding a
 * whole key to parameters is an immutable fact, which the gate holds: each write joined with every such fact its
 * statement reads, joined with a held row after a statement that read one, and before no statement that first reads
 * one; any other read is unborrowed.
 */
export const expectedOf = (d: Drawn): Expected => {
	const faults = new Set<string>()
	const features = new Set<BorrowFeature>()
	const keys = new Set<string>()
	let mode: "shared" | "exclusive" | undefined
	const changed = (rel: Rel): boolean => d.grants.get(rel)?.has("UPDATE") ?? false
	const written = (rel: Rel): boolean => (d.grants.get(rel)?.size ?? 0) > 0
	const param = (by: By | undefined): boolean => by === ":k" || by === ":n"
	const take = (r: DrawnRead, as: "shared" | "exclusive"): void => {
		mode = mode === "exclusive" ? "exclusive" : as
		keys.add(r.k ?? "")
	}
	const present = (r: DrawnRead): boolean =>
		r.k !== undefined && (r.rel === "F" || r.n !== undefined)
	/** A whole key read once for the call: no field it binds is bound per own row (ReadGroup `one`). */
	const point = (r: DrawnRead): boolean => present(r) && r.k !== "row.c" && r.n !== "row.c"
	const fact = (r: DrawnRead): boolean =>
		!d.inUnit.has(r.rel) && written(r.rel) && !changed(r.rel) && r.mode === "positive" && point(r)
	const firsts = new Map<string, number>()
	for (const [statement, s] of d.statements.entries()) {
		for (const r of s.reads) {
			if (fact(r) && !firsts.has(groupText(r))) {
				firsts.set(groupText(r), statement)
			}
		}
	}
	const firstFact = Arr.reduce([...firsts.values()], Number.POSITIVE_INFINITY, (least, s) =>
		Math.min(least, s)
	)
	const lastFirst = maxOf(firsts.values(), Number.NEGATIVE_INFINITY)
	for (const [statement, s] of d.statements.entries()) {
		const w = s.write
		if (w !== undefined) {
			if (d.inUnit.has(w.rel)) {
				const at = Arr.filter(
					s.reads,
					(r) =>
						r.rel === w.rel && (w.op === "insert" ? r.mode === "arbiter" : r.mode !== "arbiter")
				)
				const bound = Arr.filter(at, (r) => param(r.k))
				if (Arr.isReadonlyArrayNonEmpty(bound)) {
					for (const r of bound) {
						take(r, "exclusive")
					}
					features.add("a unit written under its exclusive borrow")
				} else {
					faults.add(`${statement}|${w.rel}|key`)
					features.add("a unit written at no key")
				}
			} else if (w.op === "update" || w.op === "delete") {
				faults.add(`${statement}|${w.rel}|${w.op}`)
				features.add("a change outside every unit")
			} else if (changed(w.rel)) {
				faults.add(`${statement}|${w.rel}|insert`)
				features.add("an insert into a relation a role changes")
			}
			const [first] = s.reads
			const joined = w.joined && first?.mode === "positive" ? first : undefined
			const own = joined !== undefined && d.inUnit.has(joined.rel) && param(joined.k)
			if (
				Arr.some(
					s.reads,
					(r) => fact(r) && (joined === undefined || groupText(joined) !== groupText(r))
				)
			) {
				faults.add(`${statement}|${w.rel}|gate`)
				features.add("a write not joined with a fact its statement reads")
			}
			if (statement > firstFact && !own) {
				faults.add(`${statement}|${w.rel}|gate`)
				features.add("a write after a fact, joined with no held row")
			}
			if (lastFirst > statement) {
				faults.add(`${statement}|${w.rel}|gate`)
				features.add("a write before a fact read only later")
			}
		}
		for (const r of s.reads) {
			const site = `${statement}|${r.rel}`
			if (d.inUnit.has(r.rel)) {
				if (param(r.k)) {
					take(r, "shared")
					features.add(r.mode === "positive" ? "a held positive read" : "a held absence read")
				} else {
					faults.add(`${site}|key`)
					features.add("a unit read at no key")
				}
			} else if (!written(r.rel)) {
				features.add("a read of a relation no role writes")
			} else if (changed(r.rel)) {
				faults.add(`${site}|borrow`)
				features.add("a read of a relation a role changes")
			} else if (r.mode === "arbiter" && present(r)) {
				features.add("an arbitration a unique check decides")
			} else if (r.mode !== "positive") {
				faults.add(`${site}|absence`)
				features.add("an absence outside every unit")
			} else if (point(r)) {
				features.add("an immutable fact")
			} else {
				faults.add(`${site}|borrow`)
				features.add("an unborrowed read")
			}
		}
	}
	return {
		faults,
		borrows: mode === undefined ? [] : [`Learner|${mode}|flight|${keys.size}`],
		features
	}
}

/** A case aimed at the gate: an immutable fact of F read beside a write of M not joined with it, in one statement or
 * the statement after, M in Learner or not. */
export const gateGen: Gen<Drawn> = (s) => {
	const fact: DrawnRead = { rel: "F", mode: "positive", k: ":k", n: undefined }
	const write: DrawnWrite = { rel: "M", op: "insert", joined: s.draw(boolean) }
	const arbiter: DrawnRead = { rel: "M", mode: "arbiter", k: ":k", n: ":n" }
	const together = s.draw(boolean)
	return {
		inUnit: new Set(s.draw(boolean) ? ["M" as const] : []),
		grants: new Map([
			["L", new Set<TablePrivilege>()],
			["M", new Set<TablePrivilege>(["SELECT", "INSERT"])],
			["F", new Set<TablePrivilege>(["SELECT", "INSERT"])]
		]),
		statements: together
			? [{ reads: [fact, arbiter], write }]
			: [
					{ reads: s.draw(boolean) ? [fact] : [], write: s.draw(boolean) ? write : undefined },
					{ reads: [arbiter, fact], write }
				]
	}
}
