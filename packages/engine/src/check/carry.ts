import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import { mapNonEmpty } from "@bjornpagen/grizzle-text/base/nonempty"
import type {
	ResolvedMatch,
	ResolvedQuery,
	ResolvedRule,
	ResolvedSource,
	ResolvedStage
} from "#compiler/check/params.ts"
import { entries } from "#compiler/check/scan.ts"
import { compareStrings } from "#compiler/core/order.ts"
import { deepFreeze } from "#compiler/core/record.ts"

/**
 * Digests by lineage (README "Keys and indexes"). A query whose head delivers a copy of a text its stored relation
 * declares the SHA-256 of, and not that digest, carries the digest beside it wherever a reader equates the text, so the
 * reader states the digest's equality where it states the text's (check/checker.ts RuleCheck `#stateDigests`) and its
 * read seeks the digest's rows, the text rechecked on them. Only a declared digest is carried, never one grizzle
 * computes: the head's copy of the text is a variable one of the rule's matches binds at a text of its source, and the
 * carried column is the digest field that match's relation declares of it, which the match binds too, or the column a
 * query it matches carries the digest under in turn, down to the stored relation. A head that computes its text, a cast
 * or a term, copies none, so no digest is carried through it; a union carries one only where each of its arms does.
 */

/** Each text field of a stored relation by its name with the field its relation declares as its SHA-256 (ir/law.ts textDigestsOf), none of a relation that declares none. */
export type DeclaredDigests = (relation: string) => ReadonlyMap<string, string>

/**
 * A query carrying digests: itself, its head each copied text's digest delivers beside it (`carry`), and each column
 * whose digest it delivers by the column that delivers it.
 */
export interface Carrying {
	readonly query: ResolvedQuery
	readonly digests: ReadonlyMap<string, string>
}

/**
 * The carrying of `query` at one column (`carry`), once for every reader of the compile: `build`'s at the first, the
 * same object at every other, so every import of one carried query is one import (check/checker.ts importedKey, which
 * keys an import by its query object's place).
 */
export type CarryingMemo = (query: ResolvedQuery, column: string, build: () => Carrying) => Carrying

/** The column a carried query delivers the digest of its column `text` under: a name no declared name has (core/identity.ts `hashedLead`). */
const carriedColumn = (text: string): string => `__sha256_${text}`

/**
 * `query` carrying the digest of each of `columns` its every arm's head copies from a text whose relation declares one,
 * by lineage, and each such column with the column that delivers its digest: one the query delivers already, else the
 * carried column (`carriedColumn`), which each arm binds the digest to a variable of its own for and heads. The query
 * itself where it carries none of them. It carries one column at a time, in their order, each step once for the
 * compile (CarryingMemo), so a query carrying the same columns is one object whatever other columns its reader asked
 * for: a column whose digest it cannot carry leaves the query as it is.
 */
export const carry = (
	query: ResolvedQuery,
	columns: ReadonlyArray<string>,
	digests: DeclaredDigests,
	memo: CarryingMemo
): Carrying => {
	let carried: Carrying = { query, digests: new Map() }
	for (const column of [...new Set(columns)].toSorted(compareStrings)) {
		const from = carried.query
		const step = memo(from, column, () => {
			const one = carryStage(from.stage, column, digests, memo)
			return {
				query: one.stage === from.stage ? from : deepFreeze({ ...from, stage: one.stage }),
				digests: one.digests
			}
		})
		carried = { query: step.query, digests: new Map([...carried.digests, ...step.digests]) }
	}
	return carried
}

/** A stage carrying the digest of its column `column` (`carry`): its rules', or its input's through a name, which keeps its input's rows; none of any other stage. */
const carryStage = (
	stage: ResolvedStage,
	column: string,
	digests: DeclaredDigests,
	memo: CarryingMemo
): { readonly stage: ResolvedStage; readonly digests: ReadonlyMap<string, string> } => {
	switch (stage.kind) {
		case "rules": {
			const found = stage.arms.map((arm) => armDigest(arm, column, digests, memo))
			const held = found.flatMap((f) => (f === undefined ? [] : [f]))
			if (held.length < stage.arms.length) {
				return { stage, digests: new Map() }
			}
			const [first] = held
			const delivered =
				first?.kind === "headed" && held.every((h) => h.kind === "headed" && h.name === first.name)
					? first.name
					: undefined
			if (delivered !== undefined) {
				return { stage, digests: new Map([[column, delivered]]) }
			}
			const name = carriedColumn(column)
			const arms = mapNonEmpty(stage.arms, (arm, i) =>
				withCarried(arm, defined(held[i], "each arm's digest at its place"), name)
			)
			return { stage: { ...stage, arms }, digests: new Map([[column, name]]) }
		}
		case "named": {
			const input = carryStage(stage.input, column, digests, memo)
			return {
				stage: input.stage === stage.input ? stage : { ...stage, input: input.stage },
				digests: input.digests
			}
		}
		case "recursive":
		case "union":
		case "attach":
		case "order":
		case "take":
		case "approx":
			return { stage, digests: new Map() }
	}
}

/**
 * Where one arm holds the digest of the text its head delivers under a column: a variable it heads (`headed`, under
 * the head's name), a variable it binds and heads under no name (`bound`), or a column of one of its matches' sources it
 * binds to no variable (`unbound`, the source carrying it where the match reads a query, which the arm reads it from).
 */
type ArmDigest =
	| { readonly kind: "headed"; readonly name: string; readonly var: string }
	| { readonly kind: "bound"; readonly var: string }
	| {
			readonly kind: "unbound"
			readonly match: number
			readonly source: ResolvedSource
			readonly column: string
	  }

/**
 * The digest of the text `arm` heads under `column` (ArmDigest): the head a variable a match binds at a text its
 * source declares or carries the digest of (`sourceDigest`), none for a head that computes its value, or one no match
 * binds at such a text.
 */
const armDigest = (
	arm: ResolvedRule,
	column: string,
	digests: DeclaredDigests,
	memo: CarryingMemo
): ArmDigest | undefined => {
	const head = arm.head[column]
	if (head?.kind !== "var") {
		return undefined
	}
	for (const [match, m] of arm.matches.entries()) {
		for (const [text, e] of entries(m.bindings)) {
			if (e.kind !== "var" || e.var !== head.var) {
				continue
			}
			const held = sourceDigest(m.source, text, digests, memo)
			if (held === undefined) {
				continue
			}
			const bound = m.bindings[held.column]
			if (bound === undefined) {
				return { kind: "unbound", match, source: held.source, column: held.column }
			}
			if (bound.kind !== "var") {
				continue
			}
			const headed = entries(arm.head).find(([, h]) => h.kind === "var" && h.var === bound.var)
			return headed === undefined
				? { kind: "bound", var: bound.var }
				: { kind: "headed", name: headed[0], var: bound.var }
		}
	}
	return undefined
}

/**
 * The column of `source` that holds the digest of its text `text`, with the source that delivers it: a stored
 * relation's declared digest field; the column an imported query, or a navigation's step, carries it under (`carry`),
 * read from the query carrying it; none of any other source.
 */
const sourceDigest = (
	source: ResolvedSource,
	text: string,
	digests: DeclaredDigests,
	memo: CarryingMemo
): { readonly source: ResolvedSource; readonly column: string } | undefined => {
	if (source.kind === "relation") {
		const column = digests(source.name).get(text)
		return column === undefined ? undefined : { source, column }
	}
	if (source.kind !== "query" && source.kind !== "step") {
		return undefined
	}
	const carried = carry(source.query, [text], digests, memo)
	const column = carried.digests.get(text)
	return column === undefined
		? undefined
		: {
				source: carried.query === source.query ? source : { ...source, query: carried.query },
				column
			}
}

/**
 * `arm` heading the digest `held` holds under `name`: the variable that holds it, a fresh variable of the arm's, the
 * match it is read from binding the digest to it from the source that delivers it, where the arm binds it to none.
 */
const withCarried = (arm: ResolvedRule, held: ArmDigest, name: string): ResolvedRule => {
	switch (held.kind) {
		case "headed":
		case "bound":
			return { ...arm, head: { ...arm.head, [name]: { kind: "var", var: held.var } } }
		case "unbound": {
			const taken = new Set(arm.vars.map((v) => v.id))
			let id = name
			for (let n = 2; taken.has(id); n++) {
				id = `${name}_${n}`
			}
			const matches = arm.matches.map((m, i): ResolvedMatch =>
				i === held.match
					? {
							...m,
							source: held.source,
							bindings: { ...m.bindings, [held.column]: { kind: "var", var: id } }
						}
					: m
			)
			return {
				...arm,
				vars: [
					...arm.vars,
					{
						id,
						origin:
							held.source.kind === "relation"
								? { relation: held.source.name, field: held.column }
								: undefined,
						loc: arm.loc
					}
				],
				matches,
				head: { ...arm.head, [name]: { kind: "var", var: id } }
			}
		}
	}
}
