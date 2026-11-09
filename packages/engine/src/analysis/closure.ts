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
 * `statements` holds, in the schema's order and each at its index, every statement whose laws read a name of the
 * slice, the laws its model plans (laws/model/model.ts plannedLaws), and the statements the normalizer and the
 * recognizer read beside them, as the whole schema states them: every key over a relation of the closure, a
 * containment's target's keys, projected or declared, and the declared key a generated UNIQUE implies; the families,
 * trees and folds of each planned family's component, the families coupled with it through a shared relation, to a
 * fixpoint, whose refills decide its axes' deferral (theory/refill.ts refillDeferral); and every containment between
 * the member and the owner of one of those families or trees, which may ride its axes. Any other statement states laws
 * between relations no compile over the slice names, writes or plans a law over, so nothing over the slice reads them.
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
	const statements = owned.statements.map((statement, index) => ({
		statement,
		index,
		reads: expanded(lawRelations(statement))
	}))
	const planned = (s: { readonly reads: ReadonlyArray<string> }): boolean =>
		s.reads.some((r) => slice.names.has(r))
	const coupling = statements.filter((s) => couples(s.statement))
	const component = new Set(coupling.filter(planned).flatMap((s) => s.reads))
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
		if (planned(s)) {
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
				return axes.some((axis) => s.reads.every((r) => axis.has(r)))
			case "check":
			case "mutable":
				return false
		}
	}
	const kept = statements.filter(
		(s) => s.reads.every((r) => relations.has(r)) && (planned(s) || readBeside(s))
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
