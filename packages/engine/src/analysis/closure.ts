import { closedReadNames } from "#compiler/check/generated.ts"
import { nominal } from "#compiler/core/brand.ts"
import type { SelectionDesc } from "#compiler/ir/desc.ts"
import type { Owned, OwnedStatement, SideScope } from "#compiler/schema/own.ts"
import type { Slice } from "#compiler/schema/reach.ts"

declare const closureBrand: unique symbol

/** A statement of an owned schema with its index in Owned.statements, which its laws' sources name. */
interface IndexedStatement {
	readonly statement: OwnedStatement
	readonly index: number
}

/** A closure's three parts, before closure.ts mints them as one (`Closure`). */
interface ClosureParts {
	readonly relations: ReadonlySet<string>
	readonly statements: ReadonlyArray<IndexedStatement>
	readonly filled: ReadonlySet<string>
}

/**
 * The part of an owned schema a compile over a slice (schema/reach.ts Slice) reads: the relations its checked schema
 * holds and the statements its theory normalizes. No other relation or statement of the schema is in it.
 *
 * `statements` holds, in the schema's order and each at its index, every statement a law of which its model plans
 * (readBySlice: a law reading a written relation, one reading only named relations, and one whose foreign key
 * references a named relation's selected side; `plansOver`), and the statements the normalizer and the
 * recognizer read beside them, as the whole schema states them: every key over a relation of the closure, a
 * containment's target's keys, projected or declared, and the declared key a generated UNIQUE implies; the families,
 * trees and folds of each planned family's component, the families coupled with it through a shared relation, to a
 * fixpoint, whose refills decide its axes' deferral (theory/refill.ts refillDeferral); and every containment between
 * the member and the owner of one of those families or trees, which may ride its axes. Any other statement states only
 * laws no compile over the slice reads.
 *
 * `relations` holds the slice's names, every relation a planned statement reads, a foreign key's target or source, a
 * family's owner and members, a rule's sides, every relation of a planned family's component, each derived relation's
 * reads, and the closed relations its ordinary relations' generated fields and its statements' predicates and
 * selections apply. `filled` holds those of them no family, tree or fold the closure leaves out reads: the relations
 * whose drawn and accumulated fields its statements name as the whole schema does, which normalization holds to be
 * named once (theory/laws.ts Normalizer.finish).
 *
 * The closure of everySlice is the whole schema, every relation filled: an installation's compile reads every relation
 * and statement.
 */
export type Closure = ClosureParts & { readonly [closureBrand]: true }

const closure = nominal<ClosureParts, Closure>()

/** The closed relations a selection's conjuncts apply. */
const selectionReads = (selection: SelectionDesc): ReadonlyArray<string> =>
	selection.conjuncts.flatMap(closedReadNames)

/** A statement's relations as its laws read them: each side's relation, a family's owner, an alternatives' arms. */
const lawRelations = (s: OwnedStatement): ReadonlyArray<string> => {
	switch (s.kind) {
		case "mutable":
		case "check":
			return [s.relation]
		case "key":
			return [s.side.relation]
		case "contained":
			return [s.left.relation, s.right.relation]
		case "family":
		case "tree":
			return [s.member.relation, s.slots.owner]
		case "fold":
			return [s.family.owner, s.step.relation, s.end.relation]
		case "alternatives":
			return [s.parent.relation, ...s.arms.map((a) => a.arm.relation)]
		case "retirable":
			return [s.header.relation, ...s.bodies.map((b) => b.relation)]
	}
}

/** The closed relations a statement's predicates and selections apply, and an alternatives' roster. */
const appliedRelations = (s: OwnedStatement): ReadonlyArray<string> => {
	const sides = (scopes: ReadonlyArray<SideScope>): ReadonlyArray<string> =>
		scopes.flatMap((scope) => selectionReads(scope.selection))
	switch (s.kind) {
		case "mutable":
			return []
		case "check":
			return closedReadNames(s.predicate)
		case "key":
			return sides([s.side])
		case "contained":
			return sides([s.left, s.right])
		case "family":
		case "tree":
			return sides([s.member])
		case "fold":
			return sides([s.step, s.end])
		case "alternatives":
			return [s.roster, ...sides([s.parent, ...s.arms.map((a) => a.arm)])]
		case "retirable":
			return sides([s.header, ...s.bodies])
	}
}

/**
 * The relations a statement's laws read, as a law model over a slice plans them (readBySlice):
 * `exact`, every law of it reading exactly these, for a key, a row check, a containment, a family or tree, a fold, whose
 * law reads its step's and its end's relations, and a mutable statement, which states none; `within`, each law of it
 * reading some of these, for an alternatives', whose arms are laws of their own, and for a statement reading a derived
 * relation, a rule over a query, whose arms read what the definition's live arms read.
 */
interface LawReads {
	readonly kind: "exact" | "within"
	readonly reads: ReadonlyArray<string>
}

const lawReadsOf = (owned: Owned, s: OwnedStatement, expanded: ReadonlyArray<string>): LawReads =>
	s.kind === "alternatives" ||
	s.kind === "retirable" ||
	expanded.some((r) => owned.relations[r]?.kind === "derived")
		? { kind: "within", reads: expanded }
		: { kind: "exact", reads: s.kind === "fold" ? [s.step.relation, s.end.relation] : expanded }

/** A side a foreign key references, as a statement and a law both state it: its relation and its selection. */
interface ReferencedSide {
	readonly relation: string
	readonly selection: { readonly conjuncts: ReadonlyArray<unknown> }
}

/**
 * Whether a compile over `slice` reads a law that reads `reads` and whose foreign keys reference `sides`: one reading a
 * relation the slice writes, whose natives a write of it can break, is ordered by or refuses by; one every relation of
 * which the slice names, whose evidence a query over them relies on; or one whose foreign key references a selected
 * side of a named relation, whose UNIQUE over the side's law columns is a selection key a query's probe of that relation
 * reads (physical/ddl/names.ts selectionKeysOf). Any other law reads a relation the slice neither names nor writes
 * beside the ones it names: no write of the slice meets its natives, and no query over the slice reads its evidence.
 * The one rule of a slice's planning: the law model reads it of each law, its foreign keys' sides a containment's
 * target or a rule's lowered parts' (laws/model/model.ts plannedLaws), and the closure of each statement (plansOver).
 */
export const readBySlice = (
	reads: ReadonlyArray<string>,
	sides: ReadonlyArray<ReferencedSide>,
	slice: Slice
): boolean =>
	reads.some((r) => slice.writes.has(r)) ||
	reads.every((r) => slice.names.has(r)) ||
	sides.some((side) => slice.names.has(side.relation) && side.selection.conjuncts.length > 0)

/**
 * Whether a model over `slice` plans a law of a statement (readBySlice): an exact statement's laws by the one rule, a
 * contained statement's foreign key referencing its right side; a within statement's, none of which is planned unless
 * its relations meet the names, whenever they do, a rule over a query's lowered parts among them.
 */
const plansOver = (s: OwnedStatement, reads: LawReads, slice: Slice): boolean => {
	switch (reads.kind) {
		case "within":
			return reads.reads.some((r) => slice.names.has(r))
		case "exact":
			return readBySlice(reads.reads, s.kind === "contained" ? [s.right] : [], slice)
	}
}

/** Whether a statement couples its relations: a family's, a tree's or a fold's, which name and fill their fields. */
const couples = (s: OwnedStatement): boolean =>
	s.kind === "family" || s.kind === "tree" || s.kind === "fold"

/** The closure of `slice` over `owned` (`Closure`). */
export const closureOf = (owned: Owned, slice: Slice): Closure => {
	const relations = new Set<string>()
	const add = (name: string): void => {
		if (relations.has(name)) {
			return
		}
		relations.add(name)
		const r = owned.relations[name]
		if (r?.kind === "derived") {
			for (const read of r.reads) {
				add(read)
			}
		} else if (r?.kind === "relation") {
			for (const f of Object.values(r.fields)) {
				if (f.writing.kind === "generated") {
					for (const read of closedReadNames(f.writing.expr)) {
						add(read)
					}
				}
			}
		}
	}
	const expanded = (names: ReadonlyArray<string>): ReadonlyArray<string> => {
		const out = new Set<string>()
		const visit = (name: string): void => {
			if (out.has(name)) {
				return
			}
			out.add(name)
			const r = owned.relations[name]
			if (r?.kind === "derived") {
				for (const read of r.reads) {
					visit(read)
				}
			}
		}
		for (const name of names) {
			visit(name)
		}
		return [...out]
	}
	const statements = owned.statements.map((statement, index) => {
		const reads = expanded(lawRelations(statement))
		return {
			statement,
			index,
			reads,
			planned: plansOver(statement, lawReadsOf(owned, statement, reads), slice)
		}
	})
	const coupling = statements.filter((s) => couples(s.statement))
	const component = new Set(coupling.flatMap((s) => (s.planned ? s.reads : [])))
	for (let grown = true; grown;) {
		grown = false
		for (const s of coupling) {
			if (s.reads.some((r) => component.has(r)) && s.reads.some((r) => !component.has(r))) {
				for (const r of s.reads) {
					component.add(r)
				}
				grown = true
			}
		}
	}
	const inComponent = (s: { readonly reads: ReadonlyArray<string> }): boolean =>
		s.reads.every((r) => component.has(r))
	const axes = coupling.flatMap((s) =>
		s.statement.kind !== "fold" && inComponent(s) ? [new Set(s.reads)] : []
	)
	for (const name of slice.names) {
		add(name)
	}
	for (const s of statements) {
		if (s.planned) {
			for (const r of s.reads) {
				add(r)
			}
		}
	}
	for (const r of component) {
		add(r)
	}
	const readBeside = (s: (typeof statements)[number]): boolean => {
		switch (s.statement.kind) {
			case "key":
				return true
			case "family":
			case "tree":
			case "fold":
				return inComponent(s)
			case "contained":
			case "alternatives":
			case "retirable":
				return axes.some((axis) => s.reads.every((r) => axis.has(r)))
			case "check":
			case "mutable":
				return false
		}
	}
	const kept = statements.filter(
		(s) => s.reads.every((r) => relations.has(r)) && (s.planned || readBeside(s))
	)
	for (const s of kept) {
		for (const r of appliedRelations(s.statement)) {
			add(r)
		}
	}
	const unfilled = new Set(coupling.flatMap((s) => (inComponent(s) ? [] : s.reads)))
	return closure({
		relations,
		statements: kept.map((s) => ({ statement: s.statement, index: s.index })),
		filled: new Set([...relations].filter((r) => !unfilled.has(r)))
	})
}
