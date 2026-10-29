import type { RecursiveStage } from "#compiler/check/context.ts"
import { failRecursion } from "#compiler/check/fail.ts"
import type { ResolvedExpr, ResolvedRule } from "#compiler/check/params.ts"
import { freshColumnName, parentUse } from "#compiler/check/scan.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import { compareStrings } from "#compiler/core/order.ts"

/**
 * The correlation columns of a recursive stage read in an attachment's child, each with the parent variable behind
 * it, named as the checker names them (checker.ts attach): the head key that delivers the parent variable unchanged,
 * else the first source column it is bound to, else its own name, kept clear of the head keys and attachment names. A
 * column named after a head key is a declared row column; every other one is delivered beside the head.
 */
export const correlationColumns = (stage: RecursiveStage): ReadonlyMap<string, string> => {
	const use = parentUse({ stage })
	const taken = new Set<string>()
	const named = new Map<string, string>()
	for (const parent of [...use.columns].toSorted(compareStrings)) {
		const name =
			use.headAlias.get(parent) ?? freshColumnName(use, use.firstBound.get(parent) ?? parent, taken)
		taken.add(name)
		named.set(name, parent)
	}
	return named
}

/** The parent variable behind each correlation column of `columns`. */
export const originParents = (
	stage: RecursiveStage,
	columns: ReadonlyArray<string>,
	loc: SourceLoc
): ReadonlyMap<string, string> => {
	const named = correlationColumns(stage)
	const out = new Map<string, string>()
	for (const column of columns) {
		const parent = named.get(column)
		if (parent === undefined) {
			failRecursion(loc, {
				kind: "unnamedOrigin",
				recursion: stage.recursive.name,
				column
			})
		}
		out.set(column, parent)
	}
	return out
}

/**
 * The origin of an attached recursive child: the parent identity carried through the recursive state.
 *
 * An attachment's child delivers, beside its heading, one correlation column per parent variable it reads, and the
 * Attach equates those columns with the parent's. In a recursive child that column is part of the state:
 * the base delivers it for every seed, and a recursive arm must carry it from the state it extends, so a state reached
 * from one parent's seed never answers for another parent. A recursive arm that reads the parent variable only through
 * its correlation would deliver the outer parent instead, merging every parent's traversal with every other's
 * (batched traversal cannot merge roots and later guess which result belongs to which root). So each
 * recursive arm's `self` match binds the correlation column to the parent variable: the parent variable is then bound
 * by the feedback, every state keeps the parent of the seed it came from, and the recursion is one relation over all
 * parents, seeded by every parent at once and correlated by the Attach.
 *
 * The correlation columns are named by the checker from the child's description, the head key that delivers a parent
 * variable unchanged, else the first source column it is bound to, else its own name, kept clear of the child's head
 * keys and attachment names (checker.ts attach). The same rule, read over the recursive stage, names the parent
 * variable behind each correlation column the base delivered. A correlation column the rule cannot name is refused
 * rather than guessed.
 *
 * A recursive arm whose `self` match also binds each correlation column to its parent variable, unless it already
 * binds that column.
 */
export const carryOrigin = (
	rule: ResolvedRule,
	parents: ReadonlyMap<string, string>
): ResolvedRule => {
	if (parents.size === 0) {
		return rule
	}
	return {
		...rule,
		matches: rule.matches.map((m) => {
			if (m.source.kind !== "self") {
				return m
			}
			const bindings: Record<string, ResolvedExpr> = { ...m.bindings }
			for (const [column, parent] of parents) {
				bindings[column] ??= { kind: "parent", column: parent }
			}
			return { ...m, bindings }
		})
	}
}
