/** What the properties of grounds.test.ts read: its space of derivations and proofs, and its oracle. */

import { defined } from "@bjornpagen/testing/assert"
import { array, element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, String as Str } from "effect"
import { NodeId, ParamId } from "#compiler/core/ids.ts"
import {
	type EvidenceContext,
	evidenceContexts,
	type Premise,
	premiseText,
	strongest
} from "#compiler/ir/evidence.ts"
import {
	armsAgree,
	declaredKey,
	type Dependency,
	fixedColumn,
	groupKeeps,
	type Implication,
	implication,
	type KeyProof,
	keyAlternative,
	keyFactor,
	keyMember,
	pairedKeeps,
	producedFact,
	projectionCloses,
	rightKeeps,
	rowsKeep,
	rowsKey,
	type Rule,
	unionKeyDetermines
} from "#compiler/ir/keys.ts"

/** The premises a declared step may state: two nodes' and a parameter's. */
const premisePool: ReadonlyArray<Premise> = [
	{ kind: "node", node: NodeId("n1") },
	{ kind: "node", node: NodeId("n2") },
	{ kind: "param", param: ParamId("p1") }
]

/** One step of a derivation, by what it carries: an earlier item by its index, among the items built before it. */
export type StepRecipe =
	| {
			readonly rule: "declared"
			readonly premises: ReadonlyArray<number>
			readonly context: EvidenceContext
	  }
	| { readonly rule: "kept" | "projection" | "grouped" | "intersected"; readonly input: number }
	| { readonly rule: "agreed"; readonly arms: readonly [number, ...Array<number>] }
	| { readonly rule: "paired"; readonly input: number }
	| { readonly rule: "closedValue" }
	| { readonly rule: "unionKey" | "produced"; readonly proof: number }

/** A derivation of its steps, or a proof whose basis, member and alternative each derive by an earlier derivation. */
export type ItemRecipe =
	| { readonly kind: "derivation"; readonly steps: ReadonlyArray<StepRecipe> }
	| {
			readonly kind: "proof"
			readonly determines: number
			readonly member: number | undefined
			readonly alternative: number | undefined
	  }

/**
 * A sequence of derivations and proofs, each item reading only items before it: derivations of every rule that carries
 * a derivation or a proof, and of rules that state premises and contexts, and proofs over them, several over one
 * derivation, so derivations are carried by many proofs.
 */
export const recipes: Gen<ReadonlyArray<ItemRecipe>> = (source) => {
	const items: Array<ItemRecipe> = []
	const count = source.draw(int(2, 12))
	for (let i = 0; i < count; i++) {
		const indexed = Arr.map(items, (item, at) => [item, at] as const)
		const derivations = Arr.map(
			Arr.filter(indexed, ([item]) => item.kind === "derivation"),
			([, at]) => at
		)
		const proofs = Arr.map(
			Arr.filter(indexed, ([item]) => item.kind === "proof"),
			([, at]) => at
		)
		const [first, ...rest] = derivations
		if (first !== undefined && source.draw(int(0, 2)) === 0) {
			const any = element([first, ...rest])
			items.push({
				kind: "proof",
				determines: source.draw(any),
				member: source.draw(int(0, 1)) === 0 ? undefined : source.draw(any),
				alternative: source.draw(int(0, 1)) === 0 ? undefined : source.draw(any)
			})
			continue
		}
		const step: Gen<StepRecipe> = (s) => {
			const choice = s.draw(int(0, 6))
			if (first !== undefined && choice <= 2) {
				const any = element([first, ...rest])
				const kinds = ["kept", "projection", "grouped", "intersected"] as const
				return choice === 0
					? { rule: s.draw(element(kinds)), input: s.draw(any) }
					: choice === 1
						? { rule: "agreed", arms: [s.draw(any), ...s.draw(array(any, { min: 0, max: 1 }))] }
						: { rule: "paired", input: s.draw(any) }
			}
			const [proof, ...more] = proofs
			if (proof !== undefined && choice === 3) {
				return {
					rule: s.draw(element(["unionKey", "produced"] as const)),
					proof: s.draw(element([proof, ...more]))
				}
			}
			return choice === 4
				? { rule: "closedValue" }
				: {
						rule: "declared",
						premises: s.draw(array(int(0, premisePool.length - 1), { min: 0, max: 2 })),
						context: s.draw(element(evidenceContexts))
					}
		}
		items.push({ kind: "derivation", steps: source.draw(array(step, { min: 1, max: 3 })) })
	}
	return items
}

/** The built items of a recipe: each derivation by implication, each proof by rowsKey, over the items before it. */
export const built = (
	recipe: ReadonlyArray<ItemRecipe>
): ReadonlyArray<
	| { readonly kind: "derivation"; readonly value: Implication }
	| { readonly kind: "proof"; readonly value: KeyProof }
> => {
	const out: Array<
		| { readonly kind: "derivation"; readonly value: Implication }
		| { readonly kind: "proof"; readonly value: KeyProof }
	> = []
	const derivation = (at: number): Implication => {
		const item = out[at]
		if (item?.kind !== "derivation") {
			throw new Error(`item ${at} is a derivation`)
		}
		return item.value
	}
	const proof = (at: number): KeyProof => {
		const item = out[at]
		if (item?.kind !== "proof") {
			throw new Error(`item ${at} is a proof`)
		}
		return item.value
	}
	const dependencyOf = (step: StepRecipe): Dependency => {
		switch (step.rule) {
			case "declared":
				return declaredKey(
					["a"],
					["a", "b"],
					Arr.map(step.premises, (i) => defined(premisePool[i], "a premise of the pool")),
					step.context
				)
			case "kept":
				return rowsKeep(["a"], ["b"], derivation(step.input))
			case "projection":
				return projectionCloses(["a"], ["b"], derivation(step.input))
			case "grouped":
				return groupKeeps(["a"], ["b"], derivation(step.input))
			case "intersected":
				return rightKeeps(["a"], ["b"], derivation(step.input))
			case "agreed":
				return armsAgree("a", [
					derivation(step.arms[0]),
					...Arr.map(step.arms.slice(1), derivation)
				])
			case "paired":
				return pairedKeeps(["a"], ["b"], derivation(step.input))
			case "closedValue":
				return fixedColumn("a", { kind: "closedValue" })
			case "unionKey":
				return unionKeyDetermines(proof(step.proof), ["a", "b"])
			case "produced":
				return producedFact(["a"], ["a", "b"], proof(step.proof))
		}
	}
	for (const item of recipe) {
		if (item.kind === "derivation") {
			out.push({ kind: "derivation", value: implication(["a"], Arr.map(item.steps, dependencyOf)) })
		} else {
			out.push({
				kind: "proof",
				value: rowsKey(
					["a"],
					derivation(item.determines),
					item.member === undefined ? [] : [keyMember("a", "b", derivation(item.member))],
					item.alternative === undefined
						? []
						: [keyFactor(["a"], [keyAlternative(["c"], derivation(item.alternative))])]
				)
			})
		}
	}
	return out
}

/** What the oracle walked of one proof: its premises in canonical order, its context, and the derivations it reached. */
export interface OracleGrounds {
	readonly premises: ReadonlyArray<string>
	readonly context: EvidenceContext
	readonly reached: ReadonlySet<Implication>
}

/**
 * The oracle: a proof's grounds by the walk every proof made before derivations kept theirs, every derivation below it
 * walked again for each proof, each object once within the proof.
 */
export const walkedGrounds = (proof: KeyProof): OracleGrounds => {
	const premises = new Map<string, Premise>()
	const contexts: Array<EvidenceContext> = []
	const seen = new Set<object>()
	const reached = new Set<Implication>()
	const ofProof = (p: KeyProof): void => {
		if (seen.has(p)) {
			return
		}
		seen.add(p)
		for (const premise of p.premises) {
			premises.set(premiseText(premise), premise)
		}
		contexts.push(p.context)
	}
	const ofRule = (rule: Rule): void => {
		switch (rule.rule) {
			case "declared":
			case "viewAlternative":
				contexts.push(rule.context)
				for (const premise of rule.premises) {
					premises.set(premiseText(premise), premise)
				}
				return
			case "fixed":
				if (rule.witness.kind === "closedValue") {
					contexts.push("queryLocal")
				}
				return
			case "projection":
			case "grouped":
			case "kept":
			case "intersected":
			case "paired":
				ofImplication(rule.input)
				return
			case "agreed":
				for (const arm of rule.arms) {
					ofImplication(arm)
				}
				return
			case "produced":
				ofProof(rule.input)
				return
			case "unionKey":
				ofProof(rule.proof)
				return
			case "equal":
			case "match":
			case "separated":
			case "correlated":
			case "generated":
			case "group":
			case "atMostOne":
			case "distinct":
			case "ranked":
			case "numbered":
				throw new Error(`a rule the space builds, not ${rule.rule}`)
		}
	}
	const ofImplication = (at: Implication): void => {
		if (seen.has(at)) {
			return
		}
		seen.add(at)
		reached.add(at)
		for (const step of at.steps) {
			ofRule(step.rule)
		}
	}
	for (const m of proof.members) {
		ofImplication(m.determines)
	}
	for (const f of proof.factors) {
		for (const a of f.alternatives) {
			ofImplication(a.determines)
		}
	}
	if (proof.basis.kind === "rows") {
		ofImplication(proof.basis.implication)
	}
	return {
		premises: Arr.sort([...premises.keys()], Str.Order),
		context: strongest(contexts),
		reached
	}
}

/** Whether the oracle's walk of a derivation alone finds a premise below it: its grounds hold one. */
export const derivationHoldsPremise = (at: Implication): boolean => {
	const seen = new Set<object>()
	const pending: Array<Implication | KeyProof> = [at]
	for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
		if (seen.has(next)) {
			continue
		}
		seen.add(next)
		if ("basis" in next) {
			if (next.premises.length > 0) {
				return true
			}
			continue
		}
		for (const step of next.steps) {
			const rule = step.rule
			switch (rule.rule) {
				case "declared":
				case "viewAlternative":
					if (rule.premises.length > 0) {
						return true
					}
					break
				case "projection":
				case "grouped":
				case "kept":
				case "intersected":
				case "paired":
					pending.push(rule.input)
					break
				case "agreed":
					for (const arm of rule.arms) {
						pending.push(arm)
					}
					break
				case "produced":
					pending.push(rule.input)
					break
				case "unionKey":
					pending.push(rule.proof)
					break
				case "fixed":
				case "equal":
				case "match":
				case "separated":
				case "correlated":
				case "generated":
				case "group":
				case "atMostOne":
				case "distinct":
				case "ranked":
				case "numbered":
					break
			}
		}
	}
	return false
}
