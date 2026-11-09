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

/** A closure's two parts, before closure.ts mints them as one (`Closure`). */
interface ClosureParts {
	readonly relations: ReadonlySet<string>
	readonly statements: ReadonlyArray<IndexedStatement>
}

/**
 * The part of an owned schema a compile over a slice (schema/reach.ts Slice) reads: the relations its checked schema
 * holds and the statements its theory normalizes. No other relation or statement of the schema is in it.
 *
 * `relations` holds the slice's names; every relation a law reading one of them reads, a foreign key's target, a
 * family's owner and members, a rule's sides; every relation a family, a tree or a fold couples with one of them, to a
 * fixpoint, so each of its relations' drawn and accumulated fields is named and filled as in the whole schema; each
 * derived relation's reads; and the closed relations its ordinary relations' generated fields and its statements'
 * predicates and selections apply. `statements` holds, in the schema's order and each at its index, every statement
 * whose laws read only relations of `relations`: each law whose reads meet the slice's names, and every law the
 * recognizer finds beside one, a target's keys and the family a containment rides, as the whole schema states them.
 *
 * The closure of everySlice is the whole schema: an installation's compile reads every relation and statement.
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
	const sides = (...scopes: ReadonlyArray<SideScope>): ReadonlyArray<string> =>
		scopes.flatMap((scope) => selectionReads(scope.selection))
	switch (s.kind) {
		case "mutable":
			return []
		case "check":
			return closedReadNames(s.predicate)
		case "key":
			return sides(s.side)
		case "contained":
			return sides(s.left, s.right)
		case "family":
		case "tree":
			return sides(s.member)
		case "fold":
			return sides(s.step, s.end)
		case "alternatives":
			return [s.roster, ...sides(s.parent, ...s.arms.map((a) => a.arm))]
	}
}

/**
 * Whether a statement's laws are read beside the laws they meet: a key's by a containment into it and by the unique
 * objects it implies, a family's, a tree's and a fold's by the containments riding it, its fill and its namings, and a
 * containment's by the family it rides. A row check's law is read by no other law, nor a mutable statement, which
 * states none.
 */
const supports = (s: OwnedStatement): boolean => s.kind !== "check" && s.kind !== "mutable"

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
	for (const name of slice.names) {
		add(name)
	}
	for (const s of statements) {
		if (s.reads.some((r) => slice.names.has(r))) {
			for (const r of s.reads) {
				add(r)
			}
		}
	}
	const coupling = statements.filter((s) => couples(s.statement))
	for (let grown = true; grown;) {
		grown = false
		for (const s of coupling) {
			if (s.reads.some((r) => relations.has(r)) && s.reads.some((r) => !relations.has(r))) {
				for (const r of s.reads) {
					add(r)
				}
				grown = true
			}
		}
	}
	const kept = statements.filter(
		(s) =>
			s.reads.every((r) => relations.has(r)) &&
			(s.reads.some((r) => slice.names.has(r)) || supports(s.statement))
	)
	for (const s of kept) {
		for (const r of appliedRelations(s.statement)) {
			add(r)
		}
	}
	return closure({
		relations,
		statements: kept.map((s) => ({ statement: s.statement, index: s.index }))
	})
}
