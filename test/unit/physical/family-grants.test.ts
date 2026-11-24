/**
 * What a role that writes a family's member holds on the family's owner O (physical/ddl/roles.ts, rows-first), over
 * generated worlds: two roles, each writing each relation whole, through a query entry that holds every row, through
 * one narrowed by a literal or by a join, or not at all, over a counted family with a fold and a copy and an ordered
 * one, each owner mutable or not.
 *
 * - **Declaration refusals:** a role is refused when it is declared exactly when it writes through a query entry over a
 *   relation whose key holds a field the relation's family draws, judged from the schema's declarations: a Slot is keyed
 *   by its shelf and its drawn index, which no fact through an entry states. The refusal is `keyHoldsFamily`, naming the
 *   entry and the field; every other property below holds over the roles that are declared.
 * - **Exact grants:** a role's grants on an owner are exactly its grants there with no member written (the control:
 *   the same world, every member write dropped) together with the rule: column SELECT on O's key, count, ends and
 *   copies, and, when O is mutable, column UPDATE on its count and ends, exactly what its recount sets; nothing when the role writes O whole, and no INSERT, DELETE or UPDATE on any
 *   other field of O.
 * - **The owner rows a member writer reaches:** for a role that writes a member and not its owner, the owner rows its
 *   policy on O admits (every row where O has no row security) are exactly those whose groups its policy on the member
 *   admits: evaluated on the host, each owner row against the member row it is the owner of, which agrees with it at
 *   the group and every copy. A role that also writes O admits at least those. Row security stands on exactly the
 *   tables some writer narrows, a member writer's translated membership among O's writers, one policy per role there.
 * - **Refusals:** a world is refused exactly when a role writes a member, not its owner whole, through a filter reading
 *   a field that is neither its group nor a copy, or writes the owner through a narrowed entry whose filter is not the
 *   members' translated; the refusal names the role and the family.
 * - **The audit naming rule:** every installed statement, a translated policy's included, passes the SQL audit.
 *
 * Oracles: the rule restated over the case, the control installation for the grants the role's own entries make, and a
 * host evaluator of the policies' predicates over literal rows that shares no code with the installer's rendering.
 *
 * Features: each way a member writer's filter is translated or refused, a narrowed owner entry refused, a member writer
 * under its owner's row security, and a writable entry whose key holds a drawn index refused when declared.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import { property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Result } from "effect"
import { CompileError } from "#compiler/core/errors.ts"
import type { Expr } from "#compiler/sql/ast.ts"
import { lit } from "#compiler/sql/build.ts"
import { checkedStatements } from "#test/support/oracle/verify/index.ts"
import {
	columnsOf,
	compiled,
	countSets,
	declarationRefusal,
	evaluate,
	expectedRefusals,
	features,
	held,
	memberOf,
	narrows,
	noteWriters,
	ownerRows,
	owners,
	readFlight,
	roleIn,
	roleNames,
	roleOf,
	schemaOf,
	security,
	sorted,
	tablePrivileges,
	withoutMembers,
	worldGen,
	type Writer
} from "#test/unit/physical/family-grants.fixtures.ts"

/** A member writer's hold on its family's owner exact column grants, the owner rows its policy admits, and translation refusals. Its budget is its suite's before it was a property (test/unit/physical/family-grants.test.ts at 4ca3036a): 160 runs and 160 steered cases. */
export const aMemberWritersHoldOnItsFamilysOwnerExactColumnGrantsTheOwnerRowsItsPolicyAdmitsTranslationRefusalsAndTheAdvanceClosure =
	property.explore(worldGen, {
		needs: {},
		budget: { runs: 160, steered: 160 },
		situations: features,
		check: (_, c) => (w) =>
			Effect.sync(() => {
				const s = schemaOf(w.mutability)
				const declared = Arr.flatMap(roleNames, (name): ReadonlyArray<Writer> => {
					const writer = { name, writes: w.writes[name] }
					const outcome = Result.try({
						try: () => roleOf(s, name, writer.writes),
						catch: (e) => e
					})
					const refusal = declarationRefusal(s, writer)
					if (Result.isSuccess(outcome)) {
						assert.equal(refusal, undefined, `${name} is declared, which the rule refuses`)
						return [writer]
					}
					const error = outcome.failure
					assert.ok(error instanceof CompileError, String(error))
					assert.deepEqual(
						error.reason._tag === "RoleRefused"
							? { role: error.reason.role, rule: error.reason.rule }
							: error.reason,
						defined(refusal, `${name} is refused, which the rule declares: ${error.message}`)
					)
					c.note("a writable entry whose key holds a drawn index refused when declared")
					return []
				})
				noteWriters(declared, w.mutability, c)
				const result = compiled(w.mutability, declared)
				const refusals = expectedRefusals(declared)
				if (!result.ok) {
					assert.equal(result.error.reason._tag, "UnsupportedOperation", result.error.message)
					assert.ok(
						Arr.isReadonlyArrayNonEmpty(refusals),
						`refused where the rule refuses nothing: ${result.error.message}`
					)
					return
				}
				assert.deepEqual(refusals, [], "a world the rule refuses is refused")
				const i = result.value
				checkedStatements(i.statements, "installation statement")
				const control = compiled(w.mutability, Arr.map(declared, withoutMembers))
				assert.ok(control.ok, "the control with no member written installs")
				const ci = control.value
				for (const { name: r, writes: ws } of declared) {
					const theory = roleIn(i, r)
					for (const o of owners) {
						const table = i.names.relation(o).name
						const all = columnsOf(i, o)
						const member: string = ws[memberOf[o]]
						const own: string = ws[o]
						const holds = member !== "none" && own !== "whole"
						for (const p of tablePrivileges) {
							const rule = new Set(
								holds
									? Arr.map(
											p === "SELECT"
												? readFlight[o]
												: p === "UPDATE" && w.mutability[o]
													? countSets[o]
													: [],
											(f) => i.names.column(o, f)
										)
									: []
							)
							const expected = new Set([
								...held(
									ci.statements,
									roleIn(ci, r),
									ci.names.relation(o).name,
									p,
									columnsOf(ci, o)
								),
								...rule
							])
							assert.deepEqual(
								sorted(held(i.statements, theory, table, p, all)),
								sorted(expected),
								`${r}'s ${p} on ${o} is its own entries' and the family rule's`
							)
						}
					}
				}
				const { secured, policies } = security(i)
				const policyOf = (table: string, role: string): Expr | undefined => {
					const on = Arr.filter(policies, (p) => p.table === table && p.role === role)
					assert.ok(on.length <= 1, `at most one policy of ${role} on ${table}`)
					return on[0]?.filter
				}
				for (const o of owners) {
					const ownerTable = i.names.relation(o).name
					const memberTable = i.names.relation(memberOf[o]).name
					const familyNarrows = Arr.some(declared, ({ writes: ws }) => {
						const member: string = ws[memberOf[o]]
						const own: string = ws[o]
						return own === "none" && narrows(member)
					})
					const ownNarrows = Arr.some(declared, ({ writes: ws }) => narrows(ws[o]))
					assert.equal(
						secured.has(ownerTable),
						familyNarrows || ownNarrows,
						`${o} has row security exactly when an entry or a member writer narrows it`
					)
					assert.equal(
						secured.has(memberTable),
						Arr.some(declared, ({ writes: ws }) => narrows(ws[memberOf[o]])),
						`${memberOf[o]} has row security exactly when a writer narrows it`
					)
					if (secured.has(ownerTable)) {
						c.note("a member writer under its owner's row security")
					}
					for (const { name: r, writes: ws } of declared) {
						const member: string = ws[memberOf[o]]
						const own: string = ws[o]
						if (member === "none" || own === "whole") {
							continue
						}
						const theory = roleIn(i, r)
						const truth = lit.bool(true)
						const ownerPolicy = secured.has(ownerTable)
							? defined(policyOf(ownerTable, theory), `${r}'s policy on ${o}`)
							: truth
						const memberPolicy = secured.has(memberTable)
							? defined(policyOf(memberTable, theory), `${r}'s policy on ${memberOf[o]}`)
							: truth
						for (const row of ownerRows(i, o)) {
							const owner = evaluate(ownerPolicy, ownerTable, row.owner)
							const admitted = evaluate(memberPolicy, memberTable, row.member)
							if (own === "none") {
								assert.equal(
									owner,
									admitted,
									`${r} reaches exactly the ${o} rows whose groups its ${memberOf[o]} policy admits`
								)
							} else {
								assert.ok(
									owner === admitted || owner === "true",
									`${r}'s own entry on ${o} admits every owner its members name: ${owner} for ${admitted}`
								)
							}
						}
					}
				}
			}),
		oracle: {
			kind: "specification",
			name: "the rule restated over the world, the control installation, and a host evaluator of policies"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/ddl/roles.ts",
				original:
					"\t\t\t\t\tfull.has(f.member.name) ? [f.count.name, ...endColumns(f).map((c) => c.name)] : []",
				replacement: "\t\t\t\t\tfull.has(f.member.name) ? [f.count.name] : []",
				why: "A member writer of a mutable owner may update the owner's count but not its ends."
			}
		]
	})
