import { Array as Arr, Formatter, Option, Record as Rec } from "effect"
import { checkedSchema } from "#compiler/analysis/schema.ts"
import { buildTheory, type Theory, type TheoryOptions } from "#compiler/analysis/theory/theory.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import type { LawId } from "#compiler/core/ids.ts"
import * as Result from "#compiler/core/result.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import { literalDescShape } from "#compiler/ir/desc.ts"
import { classMembers, type KeyProof, keyWith } from "#compiler/ir/keys.ts"

import type { Case } from "@grizzle/testing/explore"
import type {
	Heading,
	KeySet,
	NodeOf,
	RelDag,
	RelKind,
	RelNode,
	ValidDag
} from "#compiler/ir/rel.ts"
import * as S from "#compiler/ir/shape.ts"
import { analyzeLogical, checkerEvidence, type LogicalEnv } from "#compiler/logical/annotate.ts"
import { irLiteral } from "#compiler/scalar/compute/literal.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import type { SchemaDesc } from "#test/support/fixtures/ir/desc.ts"
import { Identities, type Interned } from "#test/support/kernel/identity.ts"
import { type KernelEnv, KeyKernel } from "#test/support/keys/kernel.ts"
import { canonicallySpelled } from "#test/support/oracle/gen/domain.ts"
import type { GenFacts, StoredRow } from "#test/support/oracle/gen/facts.ts"
import type { GenSchema } from "#test/support/oracle/gen/schema.ts"
import {
	noBindings,
	Reference,
	type ReferenceInput,
	unobserved
} from "#test/support/oracle/reference/evaluate.ts"
import { RecordingReference } from "#test/support/oracle/reference/evaluations.ts"
import { equal, type Row, valueIdentity } from "#test/support/oracle/reference/values.ts"
import { ownedInput } from "#test/support/policy.ts"
import type { HostFacts } from "#test/unit/analysis/theory/support.ts"

/** The theory of a schema, provisional unless the test states the options law specialization would. */
export const theoryUnder = (desc: SchemaDesc, options: TheoryOptions): Theory =>
	succeeded(buildTheory(succeeded(Result.flatMap(ownedInput(desc), checkedSchema)), options))

export const theoryResultUnder = (
	desc: SchemaDesc,
	options: TheoryOptions
): Result.Result<Theory, CompileError> =>
	Result.flatMap(Result.flatMap(ownedInput(desc), checkedSchema), (c) => buildTheory(c, options))

/** The schema as the reference evaluator reads it. */
const genSchemaOf = (t: Theory): GenSchema => ({
	name: t.name,
	relations: Arr.map(
		Arr.filter(Rec.values(t.relations), (r) => r.kind === "relation"),
		(r) => ({
			name: r.name,
			columns: Arr.map(r.heading, (c) => ({ name: c.name, type: c.type })),
			primaryKey: r.primaryKey,
			keys: r.keys,
			mutable: r.mutable
		})
	),
	closed: [],
	containments: []
})

/**
 * Host facts as typed rows in heading order, every stored relation present. Each host value is admitted as the
 * Description literal it is (ir/desc.ts literalDescShape), then typed at its column.
 */
const genFactsOf = (t: Theory, facts: HostFacts): GenFacts => {
	const out: Record<string, ReadonlyArray<StoredRow>> = {}
	for (const r of Rec.values(t.relations)) {
		if (r.kind !== "relation") {
			continue
		}
		out[r.name] = Arr.map(facts[r.name] ?? [], (fact) =>
			Arr.map(r.heading, (c) => {
				const literal = succeeded(
					S.decodeWith(literalDescShape, fact[c.name], `${r.name}.${c.name}`),
					`${r.name}.${c.name} holds a Description literal`
				)
				return canonicallySpelled(
					succeeded(irLiteral(literal, c.type), `${r.name}.${c.name} holds a literal of its type`)
						.literal
				)
			})
		)
	}
	return out
}

/** The violating witnesses of every law over `facts`, by law id, as JSON-ish rows. */
const violations = (
	t: Theory,
	facts: HostFacts
): ReadonlyMap<LawId, ReadonlyArray<ReadonlyArray<unknown>>> => {
	const ref = Reference.of(t.dag, {
		schema: genSchemaOf(t),
		facts: genFactsOf(t, facts),
		params: {},
		observer: unobserved
	})
	return new Map(
		Arr.map(t.laws, (law) => {
			const forbid = law.violation
			assert.ok(forbid.kind === "Forbid", `${law.id} names a Forbid node`)
			const rows = ref.eval(forbid.violation, noBindings).rows
			return [
				law.id,
				Arr.map(rows, (row) =>
					Arr.map(row, (v) => (typeof v === "object" ? Formatter.format(v) : v))
				)
			]
		})
	)
}

/** The nonempty violations only. */
export const violated = (
	t: Theory,
	facts: HostFacts
): ReadonlyMap<LawId, ReadonlyArray<ReadonlyArray<unknown>>> =>
	new Map(Arr.filter([...violations(t, facts)], ([, rows]) => rows.length > 0))

/**
 * The logical environment a theory gives a query.
 *
 * Shared helpers for the logical analysis tests: owning a fixture schema, building its theory, and evaluating violation
 * queries and query DAGs with the brute-force reference evaluator (test/support/oracle/reference).
 */
export const logicalEnv = (t: Theory): LogicalEnv => ({
	...checkerEvidence,
	containments: t.evidence.containments
})

/** The DAG annotated under `env` (checkerEvidence, the checker's own evidence). */
export const analyze = (dag: ValidDag, env: LogicalEnv): ValidDag =>
	succeeded(analyzeLogical(dag, env)).dag

/** A row's identity on `key`'s columns, interned in `identities`, so rows equal on the key share it. */
const keyOf = (identities: Identities, heading: Heading, row: Row, key: KeySet): Interned =>
	identities.of(
		Arr.flatMap(key, (name) => {
			const i = Option.getOrThrowWith(
				Arr.findFirstIndex(heading, (h) => h.name === name),
				() => new Error("a column the case's own heading holds")
			)
			return valueIdentity(defined(row[i]), defined(heading[i]).type)
		})
	)

const columnAt = (heading: Heading, row: Row, name: string) => {
	const i = Option.getOrThrowWith(
		Arr.findFirstIndex(heading, (h) => h.name === name),
		() => new Error("a column the case's own heading holds")
	)
	return { value: defined(row[i]), type: defined(heading[i]).type }
}

/**
 * Whether the logical claims of one analyzed DAG hold on the facts, and why not when they fail. Every closed node but an
 * attachment's child is evaluated, and with it every correlated node beneath, once per outer tuple: on every relation a
 * node denoted, its claimed cardinality bounds its rows and no two rows agree on a claimed key; and the children each
 * parent row of an attachment receives respect the
 * child's claims relative to the parent and the delivered type. Every key the metadata claims is a proof the key kernel
 * (test/support/keys/kernel.ts) accepts under `env`, the environment the DAG was analyzed under. `note` receives the
 * features the evaluation reached.
 */
export type LogicalFeature =
	| "claimed at most one row"
	| "claimed one row"
	| `a correlated ${RelKind} evaluated per outer tuple`
	| "a filter over one row"
	| "an approximate search"
	| `delivered ${NodeOf<"Attach">["delivered"]}`

export type Soundness =
	| { readonly kind: "sound" }
	| { readonly kind: "unsound"; readonly why: string }

const unsound = (why: string): Soundness => ({ kind: "unsound", why })

/**
 * The keys a proof states one step from its columns: its columns, each of its members put in place of the column it
 * stands for, which is a key of the same class, and each alternative of a factor put in place of that factor's
 * columns. Every other key it states is such steps taken together, each sound when every step is, which the key
 * kernel checks of each.
 */
const claimedVariants = (k: KeyProof): ReadonlyArray<KeySet> => {
	const swapped = (columns: KeySet) =>
		Arr.flatMap(classMembers(k), (m) =>
			columns.includes(m.of) ? [Arr.map(columns, (c) => (c === m.of ? m.column : c))] : []
		)
	const alternatives = Arr.map(k.alternatives, (a) => keyWith(k, a))
	return [k.key, ...swapped(k.key), ...alternatives, ...Arr.flatMap(alternatives, swapped)]
}

/**
 * Every closed node but an attachment's child, whose claims are relative to its parent; with them, every correlated
 * node beneath them, once per outer tuple.
 *
 * Every attachment, an array's included: the children each parent row receives respect the child's evidence,
 * recorded relative to the parent's variables, and the delivered type.
 */
export const logicalUnsound = (
	dag: RelDag,
	input: ReferenceInput,
	note: Case<LogicalFeature>["note"],
	env: KernelEnv
): Soundness => {
	/** Every proof the analysis emits passes the key kernel, independent of the search that found it. */
	const kernel = new KeyKernel(dag, env)
	const nodes = topoOrder(dag)
	for (const node of nodes) {
		for (const proof of node.meta.logicalKeys) {
			const [fault] = kernel.check(proof)
			if (fault !== undefined) {
				return unsound(
					`${node.id} (${node.kind}) proves [${Arr.join(proof.key, ", ")}], which the kernel refuses: ${fault}`
				)
			}
		}
	}
	const ref = RecordingReference.recording(dag, input)
	const attachments = Arr.filter(nodes, (n): n is NodeOf<"Attach"> => n.kind === "Attach")
	const children = new Set<RelNode>(Arr.map(attachments, (a) => a.child))
	for (const node of nodes) {
		if (!children.has(node) && ref.closed(node)) {
			ref.eval(node, noBindings)
		}
	}
	for (const node of Arr.filter(nodes, (n) => ref.evaluations.of(n).length > 0)) {
		const card = node.meta.card
		if (card !== "many") {
			note("claimed at most one row")
		}
		if (card === "one") {
			note("claimed one row")
		}
		if (ref.evaluations.correlated(node)) {
			note(`a correlated ${node.kind} evaluated per outer tuple`)
		}
		if (node.kind === "Filter" && node.input.meta.card === "one") {
			note("a filter over one row")
		}
		if (node.kind === "ApproximateNearest") {
			note("an approximate search")
		}
		const logicalKeys = Arr.flatMap(node.meta.logicalKeys, claimedVariants)
		for (const { heading, rows } of ref.evaluations.of(node)) {
			if (card !== "many" && rows.length > 1) {
				return unsound(`${node.id} (${node.kind}) claims ${card} and has ${rows.length} rows`)
			}
			if (card === "one" && rows.length !== 1) {
				return unsound(`${node.id} (${node.kind}) claims one and has ${rows.length} rows`)
			}
			for (const key of logicalKeys) {
				const identities = new Identities()
				if (
					new Set(Arr.map(rows, (row) => keyOf(identities, heading, row, key))).size !== rows.length
				) {
					return unsound(`${node.id} (${node.kind}) claims the key [${Arr.join(key, ", ")}]`)
				}
			}
		}
	}
	for (const a of attachments) {
		if (!ref.closed(a.parent) || !ref.closed(a.child)) {
			continue
		}
		const parent = ref.eval(a.parent, noBindings)
		const child = ref.eval(a.child, noBindings)
		const meta = a.child.meta
		const childKeys = Arr.flatMap(meta.logicalKeys, claimedVariants)
		note(`delivered ${a.delivered}`)
		for (const prow of parent.rows) {
			const matched = Arr.filter(child.rows, (crow) =>
				Arr.every(a.correlation, (pair) => {
					const p = columnAt(parent.heading, prow, pair.parent)
					return equal(p.value, columnAt(child.heading, crow, pair.child).value, p.type)
				})
			)
			if (a.delivered !== "array" && matched.length > 1) {
				return unsound(
					`${a.id} (${a.name}) delivers ${a.delivered} and a parent has ${matched.length}`
				)
			}
			if (a.delivered === "one" && matched.length === 0) {
				return unsound(`${a.id} (${a.name}) delivers one and a parent has none`)
			}
			if (meta.card !== "many" && matched.length > 1) {
				return unsound(
					`${a.child.id}, the child of ${a.name}, claims ${meta.card} per parent and a parent has ${matched.length}`
				)
			}
			if (meta.card === "one" && matched.length !== 1) {
				return unsound(
					`${a.child.id}, the child of ${a.name}, claims one per parent and a parent has ${matched.length}`
				)
			}
			for (const key of childKeys) {
				const identities = new Identities()
				if (
					new Set(Arr.map(matched, (row) => keyOf(identities, child.heading, row, key))).size !==
					matched.length
				) {
					return unsound(
						`${a.child.id}, the child of ${a.name}, claims the key [${Arr.join(key, ", ")}] per parent`
					)
				}
			}
		}
	}
	return { kind: "sound" }
}

/**
 * Whether the key kernel refuses every corruption of the proofs the analysis emits: a derivation missing its last step,
 * a proof stripped of its premises, and a proof moved to another node. A kernel that accepted everything would pass
 * logicalUnsound; this is its other half. A proof the corruption leaves valid (no step, no premise, one node) is passed
 * over for that corruption.
 */
export const kernelRefusesCorruptions = (dag: RelDag, env: KernelEnv): Soundness => {
	const kernel = new KeyKernel(dag, env)
	const nodes = topoOrder(dag)
	for (const node of nodes) {
		for (const proof of node.meta.logicalKeys) {
			const basis = proof.basis
			if (basis.kind !== "rows") {
				continue
			}
			const steps = basis.implication.steps
			const other = Arr.findFirst(nodes, (n) => n.id !== proof.node)
			const corrupted: ReadonlyArray<readonly [string, KeyProof]> = [
				...(steps.length > 0
					? [
							[
								"a derivation missing its last step",
								{
									...proof,
									basis: {
										...basis,
										implication: { ...basis.implication, steps: steps.slice(0, -1) }
									}
								}
							] as const
						]
					: []),
				...(proof.premises.length > 0
					? [["a proof stripped of its premises", { ...proof, premises: [] }] as const]
					: []),
				...(Option.isSome(other)
					? [["a proof moved to another node", { ...proof, node: other.value.id }] as const]
					: [])
			]
			for (const [what, bad] of corrupted) {
				if (kernel.check(bad).length === 0) {
					return unsound(
						`the kernel accepts ${what}: ${node.id} (${node.kind}) [${Arr.join(proof.key, ", ")}]`
					)
				}
			}
		}
	}
	return { kind: "sound" }
}
