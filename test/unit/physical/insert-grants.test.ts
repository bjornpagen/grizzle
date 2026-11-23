/**
 * Roles that write by an insert list, `role(base, name, entries, { insert })` (schema/world.ts admitRole,
 * physical/ddl/roles.ts grantedPrivileges, write/program/insert-only.ts), over generated worlds: two roles, each
 * writing each relation whole, through a query entry holding every row, or not at all, by its write list or its insert
 * list, over a counted family with a fold and an ordered one, each owner mutable or not, and a ChangeSet of drawn members
 * over one of the roles.
 *
 * - **The declaration:** a role states `write` or `insert`, and an insert list names at least one entry: a role stating
 *   both is `RoleRefused` (`writeAndInsert`), an empty insert list a MalformedDescription. A role's Description holds the
 *   key it stated and its list, and the same entries stated under the other key differ in that key alone.
 * - **The grants are the declaration's:** each role's table privileges on each table, a column privilege counting as its
 *   table's, are the rule restated: on a table it writes SELECT and INSERT, and by its write list, on a mutable table,
 *   UPDATE and DELETE, a closed table's facts never changed or deleted; on the owner of a family whose member it writes,
 *   and which it does not write whole, SELECT, and UPDATE on a mutable owner by its write list. grantedPrivileges, what certification reads, is exactly the
 *   installed set.
 * - **A role stating `write` comes out byte-identical:** the installation with every insert role stated as a write role
 *   (the control) and the drawn one hold the same objects in the same order with the same DDL, the same edges, revokes,
 *   defaults and comments, save each insert role's own privileges object and the edges that name it.
 * - **A program beyond insert is refused when it compiles:** the ChangeSet compiled for the role is the control's
 *   compilation, the same role stated with `write`, wherever the control is refused, and wherever no member deletes,
 *   puts, or inserts a member of a mutable owner's family, whose count and fold the insert updates; otherwise it is
 *   `OutsideRole` at the role, naming an UPDATE or a DELETE of a relation the member reaches: its own, a member of its
 *   families or its owner. An admitted program is the control's, statement for statement.
 * - **Never a defect:** every drawn program of a role compiles or is refused with a CompileError, and never throws. The
 *   kept case is the one that found familyProgram reading a family owner from the role's own schema (CLOSED-B-00b): a
 *   role writing a mutable owner through a query entry, whose ChangeSet inserts another owner and puts the entry in one
 *   stratum.
 *
 * Oracles: the rule restated over the case, the control installation and the control compilation.
 *
 * Features: each declaration refused and admitted, each role's way of writing each relation, an owner mutable or not,
 * and each program the control admits or the insert role is refused, with the kept case's stratum.
 */

import { isNonEmpty } from "@bjornpagen/grizzle-text/base/nonempty"
import { assert, defined } from "@bjornpagen/testing/assert"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option, Result } from "effect"
import { CompileError } from "#compiler/core/errors.ts"
import type { Isolation } from "#compiler/core/isolation.ts"
import type { TablePrivilege } from "#compiler/core/privilege.ts"
import { grantedPrivileges } from "#compiler/physical/ddl/roles.ts"
import { roleDescOf } from "#compiler/schema/world.ts"
import {
	beyondInsert,
	comparable,
	compiled,
	compiledOrRefused,
	declarationRefusal,
	type InsertDeclared,
	entriesOf,
	features,
	guarded,
	holds,
	type InsertFeature,
	isOwner,
	keyed,
	type MemberCase,
	memberOf,
	mutableIn,
	privilegesIdent,
	reached,
	relaxedByRule,
	roleIn,
	type RoleName,
	roleNames,
	roleOf,
	rulePrivileges,
	schemaOf,
	sortedPrivileges,
	statementsOf,
	tablePrivileges,
	unkeyed,
	type InsertWorld,
	worldSpace,
	written
} from "#test/unit/physical/insert-grants.fixtures.ts"

/** Roles that write by an insert list the declaration, its grants, byte-identical write roles and the refusal of programs beyond insert. Its budget is its suite's before it was a property (test/unit/physical/insert-grants.test.ts at 4ca3036a): 160 runs and 160 steered cases. */
export const rolesThatWriteByAnInsertListTheDeclarationItsGrantsByteIdenticalWriteRolesAndTheRefusalOfProgramsBeyondInsert =
	property.explore(worldSpace, {
		needs: {},
		budget: { runs: 160, steered: 160 },
		situations: features,
		check: (_, c: Case<InsertFeature>) => (w: InsertWorld) =>
			Effect.sync(() => {
				const s = schemaOf(w.mutability)
				const declared = Arr.flatMap(roleNames, (name): ReadonlyArray<InsertDeclared> => {
					const rc = w.roles[name]
					const outcome = Result.try({
						try: () => roleOf(s, name, rc.writes, rc.stated),
						catch: (e) => e
					})
					const refusal = declarationRefusal(rc)
					if (Result.isFailure(outcome)) {
						const error = outcome.failure
						assert.ok(error instanceof CompileError, String(error))
						if (refusal === "writeAndInsert") {
							c.note("both keys refused")
							assert.deepEqual(
								error.reason._tag === "RoleRefused" ? error.reason.rule : error.reason,
								{ kind: "writeAndInsert" },
								error.message
							)
						} else {
							c.note("an empty insert list refused")
							assert.equal(refusal, "emptyInsert", error.message)
							assert.equal(error.reason._tag, "MalformedDescription", error.message)
						}
						return []
					}
					assert.equal(refusal, undefined, `${name} is declared, which the rule refuses`)
					const stated = rc.stated === "insert" ? "insert" : "write"
					c.note(stated === "insert" ? "a role stating insert" : "a role stating write")
					const listed = Arr.map(entriesOf(s, rc.writes).names, ([, entry]) => entry)
					const desc = defined(roleDescOf(outcome.success), "a role built by role(...)")
					assert.deepEqual(
						keyed(desc),
						{ key: stated, list: listed },
						`${name}'s Description holds the key it stated and its list`
					)
					if (isNonEmpty(listed)) {
						const other = defined(
							roleDescOf(roleOf(s, name, rc.writes, stated === "insert" ? "write" : "insert")),
							"the role under the other key"
						)
						assert.deepEqual(
							keyed(other),
							{ key: stated === "insert" ? "write" : "insert", list: listed },
							`${name} under the other key holds that key and the same list`
						)
						assert.deepEqual(
							unkeyed(desc),
							unkeyed(other),
							`${name} under the other key differs in its key alone`
						)
					}
					return [{ name, writes: rc.writes, stated }]
				})
				const result = compiled(s, declared)
				assert.ok(result.ok, result.ok ? "" : result.error.message)
				const i = result.value
				const control = compiled(
					s,
					Arr.map(declared, (d) => ({ ...d, stated: "write" as const }))
				)
				assert.ok(control.ok, control.ok ? "" : control.error.message)
				const ci = control.value
				for (const d of declared) {
					const theory = roleIn(i, d.name)
					const checked = defined(
						Option.getOrUndefined(
							Arr.findFirst(
								Arr.flatMap(i.logins, (l) => l.roles),
								(r) => r.checked.world.role.name === d.name
							)
						),
						`the checked role ${d.name}`
					).checked
					const granted = grantedPrivileges(i.laws, checked)
					for (const t of [...written, "Open"] as const) {
						const table = i.names.relation(t)
						const installed: ReadonlyArray<TablePrivilege> = Arr.filter(tablePrivileges, (p) =>
							holds(i.statements, theory, table, p)
						)
						assert.deepEqual(
							installed,
							rulePrivileges(d, w.mutability, t),
							`${d.name}'s privileges on ${t} are the rule's`
						)
						assert.deepEqual(
							sortedPrivileges(granted.get(t) ?? []),
							installed,
							`grantedPrivileges of ${d.name} on ${t} is what is installed`
						)
						if (d.stated === "insert" && t !== "Open") {
							if (isOwner(t) && d.writes[memberOf[t]] !== "none" && d.writes[t] !== "whole") {
								c.note("an insert role holding a family owner's columns")
							}
							if (d.writes[t] !== "none" && mutableIn(w.mutability, t)) {
								c.note("an insert role over a mutable table")
							}
						}
					}
					assert.ok(
						Arr.every([...granted.keys()], (k) => k !== "Open"),
						`${d.name} holds no table privilege on what it only reads`
					)
				}
				const flipped = new Set(
					Arr.flatMap(declared, (d) => (d.stated === "insert" ? [privilegesIdent(i, d.name)] : []))
				)
				assert.deepEqual(
					comparable(i, flipped),
					comparable(ci, flipped),
					"the installation is the control's but for each insert role's privileges"
				)
				assert.deepEqual(
					Arr.map(i.certification, (r) => [r.login, r.role]),
					Arr.map(declared, (d) => ["desk", d.name]),
					"the installation certifies every role, in login then role order"
				)
				const levelOf = (r: RoleName): Isolation =>
					defined(
						Option.getOrUndefined(Arr.findFirst(i.certification, (x) => x.role === r)),
						`the certificate of ${r}`
					).certificate.level
				for (const t of [...written, "Open"] as const) {
					const relaxed = relaxedByRule(declared, w.mutability, levelOf, t)
					assert.equal(
						guarded(i, t),
						!relaxed,
						`${t}'s table takes a guard exactly when some writer of it is not certified READ COMMITTED to insert`
					)
					if (relaxed) {
						c.note("a table without a guard")
					} else if (t === "Open") {
						c.note("a table no role writes keeps its guard")
					} else if (
						Arr.some(
							declared,
							(d) =>
								d.stated === "insert" &&
								Arr.some(rulePrivileges(d, w.mutability, t), (p) => p === "INSERT")
						)
					) {
						c.note("a guarded table an insert role writes")
					}
				}
				const programmed = Arr.findFirst(declared, (d) => d.name === w.program.role)
				if (Option.isNone(programmed)) {
					return
				}
				const d = programmed.value
				const { names } = entriesOf(s, d.writes)
				const targeted: Array<readonly [MemberCase, string]> = []
				for (const m of w.program.members) {
					const at = Arr.findFirst(names, ([t]) => t === m.relation)
					const repeated = Arr.some(targeted, ([x]) => x.op === m.op && x.relation === m.relation)
					if (Option.isSome(at) && !repeated) {
						targeted.push([m, at.value[1]])
					}
				}
				if (!isNonEmpty(targeted)) {
					return
				}
				const members = Arr.map(targeted, ([m]) => m)
				const value = roleOf(s, d.name, d.writes, d.stated)
				const program = compiledOrRefused(value, targeted)
				const controlProgram = compiledOrRefused(roleOf(s, d.name, d.writes, "write"), targeted)
				if (d.stated === "write") {
					assert.deepEqual(
						program.ok ? { ok: true } : { ok: false, reason: program.error.reason },
						controlProgram.ok ? { ok: true } : { ok: false, reason: controlProgram.error.reason },
						"a write role's program is its own"
					)
					return
				}
				if (!controlProgram.ok) {
					c.note("an insert program the control refuses")
					assert.ok(!program.ok, "the control's refusal stands")
					assert.deepEqual(
						program.error.reason,
						controlProgram.error.reason,
						"the control's refusal stands"
					)
					return
				}
				const beyond = Arr.filter(members, (m) => beyondInsert(m, w.mutability))
				if (!isNonEmpty(beyond)) {
					c.note("an admitted insert program")
					assert.ok(program.ok, program.ok ? "" : program.error.message)
					assert.deepEqual(
						statementsOf(program.value),
						statementsOf(controlProgram.value),
						"an admitted insert program is the control's"
					)
					return
				}
				for (const m of beyond) {
					c.note(
						m.op === "delete"
							? "a deletion refused"
							: m.op === "put"
								? "a put refused"
								: "a recount refused"
					)
				}
				assert.ok(!program.ok, `refused: ${Formatter.format(beyond)}`)
				const reason = program.error.reason
				assert.equal(reason._tag, "OutsideRole", program.error.message)
				if (reason._tag !== "OutsideRole") {
					return
				}
				assert.equal(reason.role, d.name)
				assert.equal(reason.access.kind, "insert", program.error.message)
				if (reason.access.kind !== "insert") {
					return
				}
				const access = reason.access
				assert.ok(
					Arr.some(beyond, (m) => Arr.some(reached(m.relation), (r) => r === access.relation)),
					`${access.operation} of ${access.relation} is reached by a member beyond insert`
				)
			}),
		oracle: {
			kind: "specification",
			name: "the rule restated over the world, the control installation and the control compilation"
		},
		kept: [
			{
				token: ReplayToken(
					"test/unit/physical/insert-grants.test.ts#rolesThatWriteByAnInsertListTheDeclarationItsGrantsByteIdenticalWriteRolesAndTheRefusalOfProgramsBeyondInsert:-:2.0.1.1.0.0.0.0.0.0.0.0.1.0.0.2.0.2.2.0"
				),
				reason:
					"a put through a query entry over a mutable family owner, beside an owner's insertion",
				since: "2026-11-10"
			}
		],
		kills: [
			{
				file: "packages/engine/src/physical/ddl/roles.ts",
				original: '\t\treturn ["SELECT", "INSERT"]',
				replacement: '\t\treturn ["SELECT", "INSERT", "DELETE"]',
				why: "A role writing by its insert list holds DELETE."
			}
		]
	})
