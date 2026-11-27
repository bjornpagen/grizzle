/**
 * The conservative lowering (lower/conservative): the dispatch over every kind, the delivery of heading groups and its
 * refusals. What a lowered statement computes is checked on PostgreSQL against the reference evaluator
 * (test/pg/oracle/conservative), and its SQL by the structural audit over every lowered case
 * (test/unit/sql/audit.test.ts); a statement's text is asserted nowhere. The rules here, each an exhaustive property
 * over a planted space no generator draws, but the last:
 *
 * - every kind lowers, statements passing both audits and each one's text its AST printed, unless the node reads what
 *   the lowering refuses: a feedback reference outside its recursion (MalformedDescription), a rewrite's internal node
 *   or an approximate search the catalogue cannot resolve (UnsupportedOperation, both subjects), or a delta in a
 *   query, which has no carrier;
 * - a heterogeneous union delivered to the host is one statement per heading group, merged by the take's order and
 *   then the delivery's where they differ, each group bounded by its take; matched inside a statement it is one
 *   statement's UNION over the common columns; any other node over it, and an attachment on an arm of a group of
 *   several, is refused;
 * - an outer reference resolves only to a node in scope that one occurrence reads;
 * - over generated queries whose takes are frequent, a take's bound parameter binds at its declared type, and one the
 *   query does not declare is refused (MalformedDescription).
 *
 * Oracle: each rule's statement turned into a checker (a specification): the refusal a node's reads call for, read by
 * walking its inputs; the delivery and merge a consumer of the union calls for; the occurrences reading a referenced
 * source; the parameter's declaration.
 *
 * Features: every outcome under each subject; every consumer of the union; a lone arm, an arm of several, or none
 * attached; a reference resolved and one refused; a bound parameter.
 */

import { assert, nonEmpty } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { element, finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Record as Rec } from "effect"
import { conservativeMeta } from "#compiler/ir/rel.ts"
import { sameScalarType, type ScalarType } from "#compiler/ir/scalar.ts"
import { lowerConservative } from "#compiler/lower/conservative/index.ts"
import { flight } from "#compiler/lower/conservative/types.ts"
import { printStatement } from "#compiler/sql/print.ts"
import { refused, succeeded } from "#test/support/assert.ts"
import { featureCount, has, shapeOf } from "#test/support/kernel/shape.ts"
import { genParamDecls } from "#test/support/oracle/gen/query.ts"
import {
	auditStatementViolations,
	auditTextViolations,
	guardedTermsOf
} from "#test/support/oracle/verify/sql.ts"
import { upTo } from "#test/support/up-to.ts"
import {
	Account,
	Posting,
	Q,
	type RelationSpec,
	Task
} from "#test/unit/lower/conservative/fixtures.ts"
import {
	type ArmFeature,
	attachedArms,
	bounded,
	boundedQueries,
	boundParams,
	type Consumer,
	consumers,
	dag,
	heterogeneousRead,
	type KindOutcome,
	kindOutcome,
	lowered,
	lowerGenerated,
	nodes,
	optionsFor,
	orderBy,
	params,
	readsOf,
	regionReads,
	type Resolution,
	type Subject
} from "#test/unit/lower/conservative/lowering.fixtures.ts"
import { present } from "#test/unit/lower/support.ts"

/** The kind table lowers every node of the every-kind fixture, audited, unless it reads what the lowering refuses. */
export const theKindTableLowersEveryNodeOfTheEveryKindFixtureAuditedUnlessItReadsWhatTheLoweringRefuses =
	property.exhaust(
		finite(
			(source) =>
				[
					source.draw(element(nonEmpty(Rec.toEntries(nodes), "the every-kind fixture's nodes"))),
					source.draw(element<Subject>(["query", "readBack"]))
				] as const
		),
		{
			needs: {},
			situations: [
				"lowered query",
				"lowered readBack",
				"MalformedDescription query",
				"UnsupportedOperation query",
				"UnsupportedOperation readBack"
			] satisfies ReadonlyArray<Reached<`${KindOutcome} ${Subject}`>>,
			check:
				(_, c: Case<`${KindOutcome} ${Subject}`>) =>
				([[key, root], subject]) =>
					Effect.sync(() => {
						const expected = kindOutcome(readsOf(root), subject)
						const r = lowerConservative({ dag, root }, optionsFor(params, subject))
						c.note(`${expected} ${subject}`)
						if (expected !== "lowered") {
							refused(r, expected, key)
							return
						}
						for (const statement of flight(succeeded(r, key).roots)) {
							assert.deepEqual(auditStatementViolations(statement.ast), [], key)
							assert.deepEqual(
								auditTextViolations(statement.sql.text, guardedTermsOf(statement.ast)),
								[],
								key
							)
							assert.equal(printStatement(statement.ast), statement.sql.text, key)
						}
					}),
			oracle: {
				kind: "specification",
				name: "the refusal a node's reads call for: a feedback reference outside its recursion, a rewrite's node, an unresolved search, a delta in a query"
			},
			box: "every node of the every-kind fixture as a root, under a query and a read back",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/lower/conservative/delta/index.ts",
					original: `\t\treturn refuse(\n\t\t\t"UnsupportedOperation",\n\t\t\tat,\n\t\t\t\`delta.\${node.side}(\${node.relation}) outside a write program that supplies its delta relation\`\n\t\t)`,
					replacement: "\t\treturn emptyRelation(cx, node.heading, node.id)",
					why: "A delta read in a query is lowered as the empty relation instead of refused; the kind table's search fails."
				},
				{
					file: "packages/engine/src/lower/conservative/context.ts",
					original: '\t\tif (p === undefined || p.kind === "relation") {',
					replacement:
						'\t\tif (p === undefined || p.kind === "relation" || (p.kind === "scalar" && p.type.carrier === "vector")) {',
					why: "A declared vector parameter is refused as undeclared; the kind table's search fails at its scored projection, whose fixture declares every parameter its nodes read."
				}
			]
		}
	)

/** Heterogeneous unions are delivered per heading group, merged under the take's order and then the delivery's, or read as a UNION inside a statement, and refused under any other node. */
export const heterogeneousUnionsAreDeliveredPerHeadingGroupMergedUnderTheTakesOrderAndThenTheDeliverysOrReadAsAUNIONInsideAStatementAndRefusedUnderAnyOtherNode =
	property.exhaust(finite(consumers), {
		needs: {},
		situations: [
			"delivered",
			"filtered",
			"bounded",
			"bounded and reordered",
			"matched in a region",
			"semi-joined",
			"filtered above a bound",
			"attached"
		] satisfies ReadonlyArray<Reached<Consumer["kind"]>>,
		check: (_, c: Case<Consumer["kind"]>) => (consumer) =>
			Effect.sync(() => {
				const r = lowered(heterogeneousRead(consumer))
				c.note(consumer.kind)
				switch (consumer.kind) {
					case "semi-joined":
					case "filtered above a bound":
					case "attached":
						refused(r, "UnsupportedOperation", consumer.kind)
						return
					case "matched in a region": {
						const p = succeeded(r)
						assert.equal(p.delivery.kind, "rows")
						assert.equal(flight(p.roots).length, 1)
						const shape = shapeOf(flight(p.roots)[0].ast)
						assert.ok(has(shape, "union"))
						assert.equal(featureCount(shape, "union all"), 0)
						return
					}
					case "delivered":
					case "filtered":
					case "bounded":
					case "bounded and reordered": {
						const p = succeeded(r)
						const delivery = p.delivery
						assert.ok(delivery.kind === "headingGroups", consumer.kind)
						assert.deepEqual(delivery.discriminant, ["kind"])
						assert.equal(flight(p.roots).length, 2, "one statement per heading group")
						assert.deepEqual(
							delivery.merge,
							consumer.kind === "bounded"
								? {
										kind: "take",
										bound: { kind: "literal" as const, k: consumer.k },
										take: [orderBy(consumer.take), orderBy(consumer.take)]
									}
								: consumer.kind === "bounded and reordered"
									? consumer.delivery === consumer.take
										? {
												kind: "take",
												bound: { kind: "literal" as const, k: 1n },
												take: [orderBy(consumer.take), orderBy(consumer.take)]
											}
										: {
												kind: "takeThenOrder",
												bound: { kind: "literal" as const, k: 1n },
												take: [orderBy(consumer.take), orderBy(consumer.take)],
												orders: [orderBy(consumer.delivery), orderBy(consumer.delivery)]
											}
									: { kind: "concat" }
						)
						if (consumer.kind === "bounded" || consumer.kind === "bounded and reordered") {
							for (const s of flight(p.roots)) {
								/** Each group keeps its first k under the take's order. */
								const bounded = boundedQueries(s.ast)
								assert.ok(bounded.length > 0)
								for (const b of bounded) {
									assert.equal(b.orderBy[0]?.direction === "DESC", consumer.take === "desc")
								}
							}
						}
					}
				}
			}),
		oracle: {
			kind: "specification",
			name: "the delivery and merge each consumer of a heterogeneous union calls for"
		},
		box: "every consumer of one heterogeneous union of two heading groups: delivered, filtered, bounded by either direction and one or two, bounded and reordered, matched, semi-joined, filtered above a bound, attached",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/conservative/deliver.ts",
				original:
					'\t\t\t\tkind: "takeThenOrder",\n\t\t\t\tbound: b.take.bound,\n\t\t\t\ttake: b.take.orders,\n\t\t\t\torders: b.orders\n\t\t\t}',
				replacement:
					'\t\t\t\tkind: "take",\n\t\t\t\tbound: b.take.bound,\n\t\t\t\ttake: b.take.orders\n\t\t\t}',
				why: "A take delivered in another order is merged by its take alone; the heterogeneous unions' delivery and merge search fails."
			}
		]
	})

/** Heterogeneous unions refuse an attachment on an arm of a group of several arms, and deliver one on a lone arm. */
export const heterogeneousUnionsRefuseAnAttachmentOnAnArmOfAGroupOfSeveralArmsAndDeliverOneOnALoneArm =
	property.exhaust(attachedArms, {
		needs: {},
		situations: [
			"a lone arm attached",
			"an arm of several attached",
			"no arm attached"
		] satisfies ReadonlyArray<Reached<ArmFeature>>,
		check:
			(_, c: Case<ArmFeature>) =>
			({ arms, attached }) =>
				Effect.sync(() => {
					const q = new Q()
					const ids = (relation: RelationSpec, column: string) =>
						q.project(
							q.region([
								{
									source: q.base(relation, conservativeMeta),
									bind: { [column]: "id" },
									constants: {}
								}
							]),
							[["id", "id"]],
							conservativeMeta
						)
					const isAttached = (arm: number) => (attached & (1 << arm)) !== 0
					const built = upTo(arms, (arm) =>
						isAttached(arm)
							? q.attach(
									ids(Account, "id"),
									q.project(
										q.region([
											{
												source: q.base(Task, conservativeMeta),
												bind: { account: "account" },
												constants: {}
											}
										]),
										[["account", "account"]],
										conservativeMeta
									),
									"tasks",
									[["id", "account"]],
									"array",
									undefined
								)
							: ids(Posting, "account")
					)
					const r = lowered(q.build(q.union(built, [])))
					const carrying = Arr.filter(
						upTo(arms, (arm) => arm),
						isAttached
					).length
					if (carrying === 0) {
						c.note("no arm attached")
					} else {
						c.note(arms === 1 ? "a lone arm attached" : "an arm of several attached")
					}
					if (carrying > 0 && arms > 1) {
						refused(r, "UnsupportedOperation")
						return
					}
					assert.equal(
						Arr.filter(flight(succeeded(r).roots), (s) => s.role.kind === "attachment").length,
						carrying
					)
				}),
		oracle: {
			kind: "specification",
			name: "an attachment statement per attached lone arm, a refusal for an attached arm of several"
		},
		box: "one to three arms of one heading group, every subset of them attached",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/conservative/deliver.ts",
				original:
					"\t\tthis.#refuseArmAttachments(s)\n\t\treturn { nodes: s.nodes, attachments: s.attachments.map((a) => a.attach) }",
				replacement:
					"\t\tconst armed = [...s.attachments, ...(s.arms?.spines.flatMap((arm) => arm.attachments) ?? [])]\n\t\treturn { nodes: s.nodes, attachments: armed.map((a) => a.attach) }",
				why: "An attachment on an arm of a union of several arms is delivered instead of refused; the union attachments search fails."
			}
		]
	})

/** Regions resolve an outer reference only to a source one occurrence reads. */
export const regionsResolveAnOuterReferenceOnlyToASourceOneOccurrenceReads = property.exhaust(
	regionReads,
	{
		needs: {},
		situations: ["resolved", "refused"] satisfies ReadonlyArray<Reached<Resolution>>,
		check:
			(_, c: Case<Resolution>) =>
			({ sources, read }) =>
				Effect.sync(() => {
					const q = new Q()
					const projected = (relation: RelationSpec) =>
						q.project(
							q.region([
								{
									source: q.base(relation, conservativeMeta),
									bind: { account: "account", amount: "amount" },
									constants: {}
								}
							]),
							[
								["account", "account"],
								["amount", "amount"]
							],
							conservativeMeta
						)
					const projections = [projected(Posting), projected(Task)] as const
					const sourceOf = (pick: number) => (pick === 0 ? projections[0] : projections[1])
					const target = sourceOf(present(sources[read], "the read occurrence's source"))
					const last = sources.length - 1
					const r = lowered(
						q.build(
							q.region(
								Arr.map(sources, (pick, i) => ({
									source: sourceOf(pick),
									bind: { account: `a${i}` },
									constants: i === last ? { amount: q.col(target, "amount") } : {}
								}))
							)
						)
					)
					const readers = Arr.filter(sources, (pick) => sourceOf(pick) === target).length
					if (readers === 1) {
						succeeded(r)
						c.note("resolved")
					} else {
						refused(r, "MalformedDescription")
						c.note("refused")
					}
				}),
		oracle: {
			kind: "specification",
			name: "the occurrences that read the referenced source: one resolves, several are ambiguous"
		},
		box: "two or three occurrences over two sources, the last fixing its amount to every earlier occurrence's source",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/conservative/match-region/index.ts",
				original: "\treturn shared",
				replacement: "\treturn new Set<NodeId>()",
				why: "A reference to a source several occurrences share is resolved instead of refused; the regions search fails."
			}
		]
	}
)

/**
 * Take bound parameters binds a bound parameter at its declared type, and refuses one the query does not declare.
 *
 * Budget: 60 runs and 60 steered cases, what its suite stated before it became a property
 * (test/unit/lower/conservative/lowering.test.ts:685 at 8cad5bce, its runs and its coverage's cases).
 */
export const takeBoundParametersBindsABoundParameterAtItsDeclaredTypeAndRefusesOneTheQueryDoesNotDeclare =
	property.explore(bounded, {
		needs: {},
		budget: { runs: 60, steered: 60 },
		situations: ["a bound parameter"] satisfies ReadonlyArray<Reached<"a bound parameter">>,
		check: (_, notes: Case<"a bound parameter">) => (c) =>
			Effect.sync(() => {
				const params = genParamDecls(c.query)
				const program = succeeded(lowerGenerated(c, params), "a generated query lowers")
				for (const p of boundParams(c)) {
					notes.note("a bound parameter")
					const declared = present(
						Arr.flatMap(params, (d) => (d.id === p && d.kind === "scalar" ? [d.type] : []))[0],
						`the declaration of ${p}`
					)
					const bound: ReadonlyArray<ScalarType> = Arr.flatMap(flight(program.roots), (s) =>
						Arr.flatMap(s.params, (slot) =>
							slot.kind === "scalar" && slot.param === p ? [slot.type] : []
						)
					)
					assert.ok(bound.length > 0, `a placeholder of ${p}`)
					for (const type of bound) {
						assert.ok(sameScalarType(type, declared), p)
					}
					refused(
						lowerGenerated(
							c,
							Arr.filter(params, (d) => d.id !== p)
						),
						"MalformedDescription",
						p
					)
				}
			}),
		oracle: {
			kind: "specification",
			name: "the declared type of each take's bound parameter, and MalformedDescription for an undeclared one"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/conservative/context.ts",
				original:
					"\t\t\t\treturn this.params.scalar(bound.param, p.type, this.baseTypeRef(p.type))",
				replacement:
					'\t\t\t\treturn this.params.scalar(bound.param, { carrier: "int4", caps: p.type.caps, contract: undefined }, types.integer)',
				why: "A take's bound parameter is bound as int4 whatever its declaration; the bound parameter search fails."
			}
		]
	})
