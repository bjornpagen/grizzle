/**
 * After PostgreSQL refuses a CHECK, the host names the first row the ChangeSet states that breaks it and every law CHECK
 * that row breaks (runtime/write/witness.ts hostJudgement), each row judged as the write sends it
 * (runtime/write/bind.ts `sentRows`, StatedRows): a nested owner's counts and ends are the ones its stratum's appends
 * draw into it (`freshOwners`), never its empty families' the walk drew before them. So a nested owner holding a
 * member is judged holding it: a refusal names exactly the laws, and its witness exactly the row, PostgreSQL meets in
 * the rows the write inserts.
 *
 * The schema: T(root, start), a tree of nodes, each the owner of a counted family of M(root, start, name), its count
 * `members`. Check "Member": a node of kind 1 or 2 holds a member. Check "Child": a node of kind 2 holds a child. A case
 * draws one tree, each node of a kind and owning zero to two members, inserted nested beside its members in one
 * ChangeSet, so every node is a nested owner whose group is fresh and every member the write appends to it is drawn
 * into its row.
 *
 * The oracle, the reference evaluator (test/support/oracle/evaluate) over the rows the write sends (BoundWrite
 * `inserted`), which are the drawn tree's, each node's members and children its own: for each law CHECK of T a row
 * breaks, PostgreSQL's refusal by it is witnessed by the first such row in the tree's order (its start) and names every
 * law of every law CHECK of T that row breaks.
 *
 * Features: a row refused under Child alone that holds a member; a Member refusal past a nested owner holding a member;
 * a row breaking both laws; the root refused.
 */

import { assert, assertVariant, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { array, constant, type Gen, int, recursive } from "@bjornpagen/testing/gen"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, Order, Result } from "effect"
import { collectInputs } from "#adapter/apply/collect.ts"
import { bindFrame } from "#adapter/wire/batch.ts"
import { identifierOf } from "#compiler/core/identity.ts"
import { StoredRelationName } from "#compiler/core/ids.ts"
import type { ScalarExpr } from "#compiler/ir/expr.ts"
import { columnKeyOf } from "#compiler/ir/law.ts"
import { drawn, natural, int8 } from "#compiler/public/fields.ts"
import { check, counted, fin, on, relation, schema, tree } from "#compiler/public/schema.ts"
import { bindWrite, type InsertedRow } from "#compiler/runtime/write/bind.ts"
import { keyWitness } from "#compiler/runtime/write/outcome.ts"
import { inForce } from "#compiler/runtime/write/transport.ts"
import { hostJudgement, type LawCheckData } from "#compiler/runtime/write/witness.ts"
import { noAdvice } from "#compiler/sql/advice.ts"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"
import { compileWrite } from "#compiler/write/program/compile.ts"
import { flightOf, servableWrite } from "#compiler/write/program/served.ts"
import { succeeded } from "#test/support/assert.ts"
import { realityWrite, testArtifacts, testCompile } from "#test/support/compile.ts"
import { Id } from "#test/support/ids.ts"
import { type ModelValue, evaluate } from "#test/support/oracle/evaluate/catalog.ts"
import { patternMember } from "#test/support/oracle/reference/evaluate.ts"
import { checking } from "#test/support/policy.ts"
import { descOf, parsedOf, uuidOf } from "#test/support/unit/write/changeset/fixtures.ts"
import { withinMessage } from "#test/support/worlds/execute/offline.ts"

/** Every field is named as its column, so the reference reads a CHECK's column by its name. */
const T = relation(
	"T",
	{
		root: Id,
		parent: drawn(natural),
		at: drawn(natural),
		children: drawn(natural),
		start: drawn(natural),
		end: drawn(natural),
		members: drawn(natural),
		kind: int8
	},
	["root", "start"]
)
const M = relation("M", { root: Id, start: natural, name: int8 }, ["root", "start", "name"])
const Judged = schema(
	"Judged",
	[T, M],
	[
		tree(on(T, "parent", "at"), fin(T, "children"), { root: ["root"] }),
		counted(on(M, "root", "start"), fin(T, "members")),
		check("Member", T, (t) => t.or([t.eq(t.kind, 0n), t.ge(t.members, 1n)])),
		check("Child", T, (t) => t.or([t.ne(t.kind, 2n), t.ge(t.children, 1n)]))
	]
)
const reality = realityWrite(succeeded(testArtifacts(Judged, testCompile)))
const tName = StoredRelationName("T")
const rootId = uuidOf(1)

type Situation =
	| "a row refused under Child alone that holds a member"
	| "a Member refusal past a nested owner holding a member"
	| "a row breaking both laws"
	| "the root refused"

/** A node of a drawn tree: its kind, how many members of M it owns, and its children in order. */
interface Node {
	readonly kind: number
	readonly members: number
	readonly children: ReadonlyArray<Node>
}

const nodeOf =
	(children: Gen<ReadonlyArray<Node>>): Gen<Node> =>
	(source) => ({
		kind: source.draw(int(0, 2)),
		members: source.draw(int(0, 2)),
		children: source.draw(children)
	})

/** A tree of up to four levels: each node a leaf, or holding one to three children. */
const treeGen: Gen<Node> = recursive(
	nodeOf(constant([])),
	(inner) => nodeOf(array(inner, { min: 1, max: 3 })),
	3
)

/** A node as its tree's walk stands it: its start, the tree's order, its kind and members, and its children's count. */
interface Placed {
	readonly start: number
	readonly kind: number
	readonly members: number
	readonly children: number
}

/** A tree's nodes in its order, each at its start: the root at 0, every node before its children. */
const placed = (root: Node): ReadonlyArray<Placed> => {
	const out: Array<Placed> = []
	const visit = (node: Node): void => {
		out.push({
			start: out.length,
			kind: node.kind,
			members: node.members,
			children: node.children.length
		})
		for (const child of node.children) {
			visit(child)
		}
	}
	visit(root)
	return out
}

/** A node as the ChangeSet nests it under the root's key. */
const nestedOf = (node: Node): Readonly<Record<string, unknown>> => ({
	kind: BigInt(node.kind),
	children: Arr.map(node.children, nestedOf)
})

/** A sent row of T, as the reference reads it: its start and its cells, each column by its name. */
interface SentRow {
	readonly start: bigint
	readonly at: (column: string) => unknown
}

/** Whether PostgreSQL's CHECK of `predicate` refuses a row: the predicate false over it, by the reference evaluator. */
const refuses = (predicate: ScalarExpr, row: SentRow): boolean => {
	const value = evaluate(predicate, {
		kind: "row",
		column: (ref): ModelValue | undefined => {
			const cell = row.at(ref.name)
			return typeof cell === "bigint" || typeof cell === "string" || typeof cell === "boolean"
				? cell
				: assert.fail(`the sent row holds the column ${ref.name} the CHECK reads`)
		},
		param: () => undefined,
		regexMember: patternMember
	})
	return Result.isSuccess(value) ? value.success === false : assert.fail("the CHECK evaluates")
}

/** A refusal judged under one law CHECK of T and a case's sent rows notes what it reaches. */
const noteRefusal = (
	c: Case<Situation>,
	check: LawCheckData,
	first: SentRow,
	broken: ReadonlyArray<LawCheckData>,
	sent: ReadonlyArray<SentRow>
): void => {
	const named = (law: string): boolean =>
		Arr.some(check.laws, (l) => l.described.kind === "check" && l.described.name === law)
	/** Whether a row holds Member only by its members: a node of kind 1 or 2 holding one. */
	const ownsItsMember = (row: SentRow): boolean => row.at("kind") !== 0n && row.at("members") !== 0n
	if (named("Child") && broken.length === 1 && ownsItsMember(first)) {
		c.note("a row refused under Child alone that holds a member")
	}
	if (
		named("Member") &&
		Arr.some(sent, (row) => row.start < first.start && row.start > 0n && ownsItsMember(row))
	) {
		c.note("a Member refusal past a nested owner holding a member")
	}
	if (broken.length === 2) {
		c.note("a row breaking both laws")
	}
	if (first.start === 0n) {
		c.note("the root refused")
	}
}

/** A refused nested owner is named breaking exactly the laws, and its witness is exactly the row, the rows the write sends give. */
export const aRefusedNestedOwnerIsNamedBreakingExactlyTheLawsAndItsWitnessIsExactlyTheRowTheRowsTheWriteSendsGive =
	property.explore(treeGen, {
		needs: {},
		situations: [
			"a row refused under Child alone that holds a member",
			"a Member refusal past a nested owner holding a member",
			"a row breaking both laws",
			"the root refused"
		] satisfies ReadonlyArray<Reached<Situation>>,
		check: (_, c: Case<Situation>) => (root) =>
			Effect.gen(function* () {
				const nodes = placed(root)
				const value = ChangeSet.empty(Judged)
					.insert(T, [{ root: rootId, ...nestedOf(root) }])
					.insert(
						M,
						Arr.flatMap(nodes, (node) =>
							Array.from({ length: node.members }, (_, name) => ({
								root: rootId,
								start: BigInt(node.start),
								name: BigInt(name)
							}))
						)
					)
				const program = succeeded(compileWrite(checking(Judged), descOf(value), reality))
				const members = yield* collectInputs(program.binding.groups, parsedOf(value).inputs)
				const flight = flightOf(servableWrite(program), program.frontend.codes, noAdvice)
				const bound = succeeded(
					withinMessage(bindWrite(flight, { members, params: {}, transport: inForce(bindFrame) }))
				)
				assertVariant(bound, "kind", "bound", "the tree and its members bind")
				const [inserting, ...others] = Arr.filter(bound.inserted(), (s) => s.rows.has(tName))
				const stratum = defined(inserting, "the stratum inserting T")
				assert.equal(others.length, 0, "one stratum inserts T")
				const columns = flight.prepared.columns(tName)
				const rowOf = ({ values }: InsertedRow): SentRow => {
					const at = (column: string): unknown => values[columns.at(columnKeyOf(column))]
					const start = at("start")
					return {
						start: typeof start === "bigint" ? start : assert.fail("a sent row's start"),
						at
					}
				}
				const sent = Arr.sort(
					Arr.map(stratum.rows.get(tName) ?? [], rowOf),
					Order.mapInput(Order.BigInt, (row: SentRow) => row.start)
				)
				assert.deepEqual(
					Arr.map(sent, (row) => [
						row.start,
						row.at("kind"),
						row.at("members"),
						row.at("children")
					]),
					Arr.map(nodes, (node) => [
						BigInt(node.start),
						BigInt(node.kind),
						BigInt(node.members),
						BigInt(node.children)
					]),
					"the write sends the tree: each node's kind, members and children its own"
				)
				const w = flight.prepared.witness
				const table = defined(
					Option.getOrUndefined(Arr.findFirst(w.data.tables, (t) => t.name === tName)),
					"T's witness table"
				)
				/** A law CHECK of T's predicate, the law model's own native object. */
				const predicateOf = (lawCheck: LawCheckData): ScalarExpr =>
					defined(
						Option.getOrUndefined(
							Arr.head(
								Arr.flatMap(program.frontend.laws.natives, (n) =>
									n.namespace === "constraint" &&
									n.owner === table.ident &&
									n.object.kind === "TableCheck" &&
									identifierOf(n.named) === lawCheck.name
										? [n.object.predicate]
										: []
								)
							)
						),
						`the predicate of the CHECK ${lawCheck.name}`
					)
				const checks = Arr.map(table.checks, (k) => ({ check: k, predicate: predicateOf(k) }))
				for (const { check: refusing, predicate } of checks) {
					const row = Option.getOrUndefined(Arr.findFirst(sent, (r) => refuses(predicate, r)))
					if (row === undefined) {
						continue
					}
					const broken = Arr.filter(checks, (k) => refuses(k.predicate, row))
					noteRefusal(
						c,
						refusing,
						row,
						Arr.map(broken, (k) => k.check),
						sent
					)
					const judged = hostJudgement(
						w,
						bound.stated,
						{ kind: "write", stratum: stratum.stratum, relations: [tName] },
						{ kind: "constraint", owner: table.ident, name: refusing.name }
					)
					assert.deepEqual(
						judged.witness,
						keyWitness(tName, { root: rootId, start: row.start }),
						`the refusal by ${refusing.name} is witnessed by the first row breaking it`
					)
					assertVariant(judged.laws, "kind", "every", "the host judges every law CHECK of T")
					assert.deepEqual<ReadonlyArray<string>>(
						Arr.sort(
							Arr.map(judged.laws.laws, (l) => String(l.id)),
							Order.String
						),
						Arr.sort(
							Arr.flatMap(broken, (k) => Arr.map(k.check.laws, (l) => String(l.law))),
							Order.String
						),
						`the refusal by ${refusing.name} names every law its witness breaks`
					)
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "the reference evaluator's CHECK verdicts over the rows the write sends"
		},
		kept: [
			{
				token: ReplayToken(
					"test/unit/write/judged-rows.test.ts#aRefusedNestedOwnerIsNamedBreakingExactlyTheLawsAndItsWitnessIsExactlyTheRowTheRowsTheWriteSendsGive:-:1.0.0.1.0.2.1"
				),
				reason:
					"AL3W's first repro: a node of kind 2 holding its one member and no child, refused under Child alone, which the host named breaking Member beside it, judging the node with its counted family empty",
				since: "2026-11-19"
			},
			{
				token: ReplayToken(
					"test/unit/write/judged-rows.test.ts#aRefusedNestedOwnerIsNamedBreakingExactlyTheLawsAndItsWitnessIsExactlyTheRowTheRowsTheWriteSendsGive:-:1.0.0.2.0.1.1.0.1.0"
				),
				reason:
					"AL3W's second repro: two nodes of kind 1, the first holding a member and the second none, refused under Member, which the host witnessed by the first, judging it with its counted family empty",
				since: "2026-11-19"
			}
		],
		kills: [
			{
				file: "packages/engine/src/runtime/write/bind.ts",
				original:
					'stated: statedRowsOf({ kind: "sent", rows: sentRows, drawn: (slot) => fresh.has(slot) }),',
				replacement:
					'stated: statedRowsOf({ kind: "sent", rows: normalRows, drawn: (slot) => fresh.has(slot) }),',
				why: "The stated rows are judged at the rows normalization leaves, before the fresh fill draws a nested owner's counts: every nested owner is judged with its counted families empty, so a node of kind 2 holding a member and no child is named breaking Member beside Child, and a Member refusal is witnessed by an earlier node that holds its member."
			}
		]
	})
