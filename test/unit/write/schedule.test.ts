/**
 * A stratum's schedule holds an immediate foreign key at every statement, or names a cycle no order keeps. A stratum's
 * actions are over a relation C and a relation P that C references immediately at every field of P, the foreign key
 * grizzle makes immediate only into a relation it references whole: at most one action of each operation on P, and one
 * on C or none. Its shape is which actions it holds, with C named first or second, and each of C and P with a payload,
 * every fact of it at its one key, or a pure set, each fact its own key, whose id is serial and which also takes a
 * generated insertion, drawing its id; its instances are every lawful state of a small box, with every position of P's
 * sequence at or past its stored ids, and every lawful write of that shape.
 *
 * The oracle is a model of the statements each action sends, not of the schedule's rule: a deletion removes its facts;
 * an insertion adds them; a put of a relation with a payload displaces the occupant of its key, then inserts; a pure
 * set's put inserts alone, since its fact at a key is the key; an explicit P id advances P's sequence past it, and a
 * generated insertion adds the next id the sequence draws; and, as the host's normalization does, a fact both deleted
 * and added explicitly is only added, and one both put and inserted only put, while a drawn fact, whose id no write is
 * given, nets nothing. A stratum's one final state is its writes' in phase order: its deletions on the state before,
 * then its additions, the draw past every explicit id, so a fact it both deletes and draws stays. The schedule decides
 * the states between its statements, after each of which every C fact references a P fact and a relation with a payload
 * holds one fact at its key, and must reach that final state.
 *
 * - Where the schedule orders a shape, its order keeps every instance after each statement and reaches its final state.
 * - Where it names a cycle, the cycle's actions are the shape's, and every order of the shape's actions that runs each
 *   relation with a payload's deletion before its put and its put before its insertion, as immediate keys whose
 *   occupants the schedule cannot see require, fails some instance: no order keeps the stratum, and the front end
 *   refuses it (UnorderableStratum) where it used to drop an edge and fail at the server. A pure set's actions are
 *   tried in every order: no fact one adds meets a fact another removes but itself, save a drawn fact, which a deletion
 *   run after the draw removes at an id it names.
 *
 * Features: the schedule orders a stratum, no order keeps one, a pure set's deletion after its addition, both put
 * under either name order, a generated insertion beside a deletion; each stratum shape of the generated strata.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { canonicalActionOrder, scheduleStratum } from "#compiler/write/frontend/schedule.ts"
import { assert, defined } from "#test/support/assert.ts"
import {
	actionOf,
	edgeKey,
	edgeOf,
	hasCycle,
	instancesOf,
	keeps,
	nameOf,
	noRefills,
	orders,
	phase,
	requiredEdges,
	shapeGen,
	type Situation,
	strataDraw,
	stratumShapes,
	type StratumSituation,
	stratumSituations,
	writeId,
	writtenInPlace
} from "#test/unit/write/schedule.fixtures.ts"

/** A stratum's schedule keeps an immediate foreign key into a relation it references whole, and both keys, at every statement, and reaches the stratum's final state, or names a cycle no order keeps. */
export const aStratumsScheduleKeepsAnImmediateForeignKeyIntoARelationItReferencesWholeAndBothKeysAtEveryStatementAndReachesTheStratumsFinalStateOrNamesACycleNoOrderKeeps =
	property.exhaust(finite(shapeGen), {
		needs: {},
		situations: [
			"the schedule orders a stratum",
			"no order keeps a stratum",
			"a pure set's deletion after its addition",
			"both put, the source named first",
			"both put, the target named first",
			"a generated insertion beside its relation's deletion"
		] satisfies ReadonlyArray<Reached<Situation>>,
		check: (_, c: Case<Situation>) => (shape) =>
			Effect.sync(() => {
				const actions = [
					...Arr.map(shape.onP, (op) => ({ relation: "P" as const, op })),
					...Arr.map(shape.onC, (op) => ({ relation: "C" as const, op }))
				]
				const instances = instancesOf(shape)
				if (actions.length === 0 || instances.length === 0) {
					return
				}
				const schedule = scheduleStratum(
					canonicalActionOrder(
						Arr.map(actions, ({ relation, op }) => ({
							action: actionOf(shape, relation, op),
							meeting: (relation === "P" ? shape.targetKeyed : shape.keyed)
								? ("key" as const)
								: ("nowhere" as const),
							relation,
							op
						})),
						new Set()
					),
					[],
					[],
					[
						{
							from: nameOf(shape, "C"),
							to: nameOf(shape, "P"),
							cascade: false,
							fromColumns: ["field:p"],
							toColumns: ["field:id"]
						}
					],
					noRefills,
					[]
				)
				if (schedule.kind === "ordered") {
					const order = Arr.map(schedule.actions, ({ scheduled }) => scheduled)
					for (const instance of instances) {
						assert.ok(
							keeps(shape, instance, order),
							`the order ${Formatter.format(order)} leaves a C fact referencing no P fact, or misses the stratum's final state, in ${Formatter.format(instance)}`
						)
					}
					c.note("the schedule orders a stratum")
					const deleted = Arr.findFirstIndex(order, (a) => a.relation === "P" && a.op === "delete")
					if (
						!shape.targetKeyed &&
						Option.isSome(deleted) &&
						Arr.some(order.slice(0, deleted.value), (a) => a.relation === "P" && a.op !== "delete")
					) {
						c.note("a pure set's deletion after its addition")
					}
				} else {
					assert.ok(
						Arr.every(
							schedule.cycle,
							(w) =>
								w.kind === "action" &&
								Arr.some(actions, (b) => b.relation === w.action.relation && b.op === w.action.op)
						),
						"the cycle's actions are the stratum's"
					)
					const phased = Arr.filter(orders(actions), (order) =>
						Arr.every(order, (a, i) =>
							Arr.every(
								order.slice(i + 1),
								(b) =>
									b.relation !== a.relation ||
									!(a.relation === "P" ? shape.targetKeyed : shape.keyed) ||
									phase[a.op] < phase[b.op]
							)
						)
					)
					for (const order of phased) {
						assert.ok(
							Arr.some(instances, (instance) => !keeps(shape, instance, order)),
							`the order ${Formatter.format(order)} keeps every instance of a stratum the schedule names a cycle of`
						)
					}
					c.note("no order keeps a stratum")
				}
				if (shape.onC.includes("put") && shape.onP.includes("put")) {
					c.note(
						shape.sourceFirst
							? "both put, the source named first"
							: "both put, the target named first"
					)
				}
				if (shape.onP.includes("delete") && shape.onP.includes("generated")) {
					c.note("a generated insertion beside its relation's deletion")
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "the statements each action sends, over every lawful instance and every order"
		},
		box: "C named first or second; C and P each with a payload or a pure set; any set of P's deletion, put and insertion, and of a pure set's generated insertion; one action of C or none; every lawful state over two ids, at every position of P's sequence",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/write/frontend/schedule.ts",
				original: '\ta.op === "delete" ? 0 : a.op === "put" ? 1 : isGenerated(a) ? 3 : 2',
				replacement: '\tisGenerated(a) ? 0 : a.op === "delete" ? 1 : a.op === "put" ? 2 : 3',
				why: "A generated insertion's phase is before a deletion's (write/frontend/schedule.ts phaseOf), so a deletion run after the draw removes a drawn fact."
			},
			{
				file: "packages/engine/src/write/frontend/schedule.ts",
				original:
					'\tphaseOf(a.action) < phaseOf(b.action) &&\n\t!(a.meeting === "nowhere" && a.action.op === "delete" && !isGenerated(b.action))',
				replacement: "\tphaseOf(a.action) < phaseOf(b.action)",
				why: "a30d00af's bug: a deletion of a relation whose facts meet nowhere held before its stratum's puts and inserts, so a put referencing it between them leaves no order."
			},
			{
				file: "packages/engine/src/write/frontend/schedule.ts",
				original:
					'const followsOnRelation = (a: Scheduled, b: Scheduled): boolean =>\n\tphaseOf(a.action) < phaseOf(b.action) &&\n\t!(a.meeting === "nowhere" && a.action.op === "delete" && !isGenerated(b.action))',
				replacement: "const followsOnRelation = (a: Scheduled, b: Scheduled): boolean => false",
				why: "Two actions of one relation are left unordered by their phases (write/frontend/schedule.ts followsOnRelation)."
			}
		]
	})

/** A stratum's schedule orders every generated stratum exactly when the writes' required order holds no cycle, and keeps every required order. */
export const aStratumsScheduleOrdersEveryGeneratedStratumExactlyWhenTheWritesRequiredOrderHoldsNoCycleAndKeepsEveryRequiredOrder =
	property.explore(strataDraw, {
		needs: {},
		situations: stratumSituations satisfies ReadonlyArray<Reached<StratumSituation>>,
		check: (_, c: Case<StratumSituation>) => (stratum) =>
			Effect.sync(() => {
				c.noteAll(stratumShapes(stratum))
				for (const { relation, edit } of stratum.edits) {
					const update = Arr.findFirst(
						stratum.family,
						(f) => f.kind === "rows" && f.relation === relation && f.statement === "update"
					).pipe(Option.getOrUndefined)
					const expected = writtenInPlace(edit)
					assert.ok(
						update?.kind === "rows" &&
							update.statement === "update" &&
							update.changes.length === expected.size &&
							Arr.every(update.changes, (c) => expected.has(c)),
						`the update in place of ${relation} changes exactly what its edits ${Formatter.format(edit.ops)} write, ${Formatter.format([...expected])}`
					)
				}
				const required = requiredEdges(stratum)
				const cyclic = hasCycle(stratum, required)
				const schedule = scheduleStratum(
					canonicalActionOrder(stratum.actions, new Set()),
					stratum.family,
					stratum.pairs,
					stratum.references,
					stratum.refills,
					[]
				)
				if (schedule.kind === "cycle") {
					assert.ok(cyclic, "the schedule refuses only a stratum whose required order has a cycle")
					const cycle = Arr.map(schedule.cycle, (w) => writeId(stratum, w))
					for (const [i, at] of cycle.entries()) {
						const next = defined(cycle[(i + 1) % cycle.length], "a cycle's next write")
						assert.ok(
							required.has(edgeKey(at, next)),
							`the cycle's ${String(at)} before ${String(next)} is required`
						)
					}
					c.note("refused: a required cycle")
					return
				}
				assert.ok(!cyclic, "the schedule orders every stratum whose required order has no cycle")
				const position = new Map<number, number>()
				let next = 0
				for (let i = 0; i <= schedule.actions.length; i += 1) {
					for (const f of schedule.family) {
						if (f.at === i) {
							position.set(writeId(stratum, { kind: "family", node: f.node }), next)
							next += 1
						}
					}
					const action = schedule.actions[i]
					if (action !== undefined) {
						position.set(writeId(stratum, { kind: "action", action: action.scheduled }), next)
						next += 1
					}
				}
				for (const edge of required) {
					const [from, to] = edgeOf(edge)
					assert.ok(
						defined(position.get(from), "a placed write") <
							defined(position.get(to), "a placed write"),
						`the required order ${String(from)} before ${String(to)} holds`
					)
				}
				c.note("ordered")
			}),
		oracle: {
			kind: "second-implementation",
			name: "the required order of a stratum's writes, stated edge by edge from the keys and the family planner's rules, and what each update in place writes, stated operation by operation"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/write/frontend/schedule.ts",
				original:
					'\tfor (const { node, vertex } of statements) {\n\t\tif (node.kind === "unit") {\n',
				replacement:
					'\tfor (const [at, { node, vertex }] of statements.entries()) {\n\t\tbefore(statements[at - 1]?.vertex, vertex)\n\t\tif (node.kind === "unit") {\n',
				why: "A stratum's family statements are chained into one total order, which no key requires (write/frontend/schedule.ts scheduleStratum, e9227af's chain before 8310ede1), so an import's shape of a plain owner inserted beside its family's member updated and another owner's count closes a cycle and is refused as UnorderableStratum; the kept case of the import's shape pinned it."
			},
			{
				file: "packages/engine/src/write/frontend/schedule.ts",
				original:
					'\tfor (const pair of pairs) {\n\t\tconst member = nodeOf(pair.member, "update")\n',
				replacement:
					'\tfor (const pair of pairs) {\n\t\tif (pair.owner !== pair.member) {\n\t\t\tbefore(rowsOf(pair.member, "delete"), rowsOf(pair.owner, "delete"))\n\t\t\tbefore(rowsOf(pair.owner, "insert"), rowsOf(pair.member, "insert"))\n\t\t}\n\t\tconst member = nodeOf(pair.member, "update")\n',
				why: "Every family's owner insertion is ordered before its member's, and the member's deletion before the owner's, whether or not the owner axis is immediate (write/frontend/schedule.ts, 8310ede1's pair edges before 75fed883), so a cycle of families with both axes deferred is refused; the kept case of a cycle of families pinned it."
			},
			{
				file: "packages/engine/src/write/frontend/schedule.ts",
				original:
					"\t\t[...(put ? edit.own : []), ...(moves ? [...edit.placed, ...edit.refreshed] : [])],\n",
				replacement: "\t\t[...edit.own, ...(moves ? [...edit.placed, ...edit.refreshed] : [])],\n",
				why: "A member's update in place counts as changing its caller fields whatever its edits write (write/frontend/schedule.ts updateChanges, before 73360caa), so a deletion of an ordered member or an insertion of a counted one meets a key over a it never writes; the kept case of edits beside a pure set pinned it."
			}
		]
	})
