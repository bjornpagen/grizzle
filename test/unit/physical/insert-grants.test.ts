/**
 * Roles that write each relation under the list its mode names, `role(base, name, entries, { insert, write })`
 * (schema/world.ts admitRole, physical/ddl/roles.ts grantedPrivileges, write/program/insert-only.ts), over generated
 * worlds: two roles, each writing each relation whole, through a query entry holding every row, or not at all, each
 * written relation under its insert list or its write list, over a counted family with a fold and an ordered one, each
 * owner and the counted member mutable or not, and a ChangeSet of drawn members over one of the roles.
 *
 * - **The declaration:** a role names a closed relation under its write list exactly when its ownership refuses it,
 *   `RoleRefused` (`writeClosed`) naming the relation, by the closedness the owned base states; otherwise its
 *   Description holds each entry under its list.
 * - **The grants are the declaration's, relation by relation:** each role's table privileges on each table, a column
 *   privilege counting as its table's, are the rule restated: on a table it writes SELECT and INSERT, and UPDATE and
 *   DELETE exactly where its write list names it; on the owner of a family whose member it writes, and which it does
 *   not write whole, SELECT, and UPDATE on a mutable owner whose member its write list names. No UPDATE or DELETE stands
 *   on a relation under the insert list. grantedPrivileges, what certification reads, is exactly the installed set.
 * - **A role's grants are its own:** the installation with every role stated as its control, each open relation it
 *   writes under its write list and each closed one under its insert list, holds the same objects in the same order
 *   with the same DDL, the same edges, revokes, defaults and comments, save each role's own privileges object, where
 *   its lists differ from its control's, and the edges that name it.
 * - **A program beyond its grants is refused when it compiles:** the ChangeSet compiled for the role is the control's
 *   compilation wherever the control is refused, and wherever no statement of the control's program updates or
 *   deletes from a table the rule grants the role no UPDATE or DELETE on; otherwise it is `OutsideRole` at the role,
 *   naming such a table's relation and operation. An admitted program is the control's, statement for statement, save
 *   each UPDATE's anchor (sql/generation.ts), a column it assigns its own value, chosen among the columns its updater
 *   may assign, which the role's grants decide and grizzle widens none for.
 * - **Never a defect:** every drawn program of a role compiles or is refused with a CompileError, and never throws. The
 *   kept case is the one that found familyProgram reading a family owner from the role's own schema (CLOSED-B-00b): a
 *   role writing a mutable owner through a query entry, whose ChangeSet inserts another owner and puts the entry in one
 *   stratum.
 *
 * Oracles: the rule restated over the case, the control installation and the control compilation.
 *
 * Features: each declaration refused and admitted, each role's way and list of writing each relation, an owner's
 * recount granted and refused, and each program the control admits or the role is refused, with the kept case's
 * stratum.
 */

import { isNonEmpty } from "@bjornpagen/grizzle-text/base/nonempty"
import { assert, defined } from "@bjornpagen/testing/assert"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import type { Isolation } from "#compiler/core/isolation.ts"
import type { TablePrivilege } from "#compiler/core/privilege.ts"
import { grantedPrivileges } from "#compiler/physical/ddl/roles.ts"
import { ownRole } from "#compiler/schema/own.ts"
import { roleDescOf } from "#compiler/schema/world.ts"
import {
	comparable,
	compiled,
	compiledOrRefused,
	controlOf,
	declarationRefusal,
	type InsertDeclared,
	entriesOf,
	features,
	guarded,
	holds,
	type InsertFeature,
	isOwner,
	type MemberCase,
	memberOf,
	modificationsOf,
	mutableIn,
	privilegesIdent,
	relaxedByRule,
	roleIn,
	type RoleName,
	roleNames,
	roleOf,
	rulePrivileges,
	schemaOf,
	sortedPrivileges,
	anchorlessStatementsOf,
	statementsOf,
	tablePrivileges,
	type InsertWorld,
	worldSpace,
	written
} from "#test/unit/physical/insert-grants.fixtures.ts"

/** Roles that write each relation under its list: the declaration, its grants relation by relation, roles stated as their controls and the refusal of programs beyond the grants. */
export const rolesThatWriteEachRelationUnderItsListTheDeclarationItsGrantsAndTheRefusalOfProgramsBeyondThem =
	property.explore(worldSpace, {
		needs: {},
		budget: { runs: 160, steered: 160 },
		situations: features,
		check: (_, c: Case<InsertFeature>) => (w: InsertWorld) =>
			Effect.sync(() => {
				const s = schemaOf(w.mutability, "Shops")
				const declared = Arr.flatMap(roleNames, (name): ReadonlyArray<InsertDeclared> => {
					const rc = w.roles[name]
					const desc = defined(roleDescOf(roleOf(s, name, rc)), "a role built by role(...)")
					const owned = ownRole(desc)
					const refusal = declarationRefusal(s, rc, w.mutability)
					if (!owned.ok) {
						const error = owned.error
						c.note("a closed relation under write refused")
						assert.ok(
							refusal !== undefined,
							`${name} is refused, which the rule admits: ${error.message}`
						)
						const reason = error.reason
						assert.equal(reason._tag, "RoleRefused", error.message)
						if (reason._tag === "RoleRefused") {
							assert.equal(reason.rule.kind, "writeClosed", error.message)
							assert.equal(
								reason.rule.kind === "writeClosed" ? reason.rule.relation : undefined,
								refusal,
								error.message
							)
						}
						return []
					}
					assert.equal(refusal, undefined, `${name} is owned, which the rule refuses`)
					const { names } = entriesOf(s, rc.writes)
					for (const mode of ["insert", "write"] as const) {
						assert.deepEqual(
							desc[mode],
							Arr.flatMap(names, ([t, entry]) => (rc.modes[t] === mode ? [entry] : [])),
							`${name}'s Description holds each entry under its list`
						)
					}
					c.note(
						Arr.some(names, ([t]) => rc.modes[t] === "write")
							? "a role writing an open relation"
							: "a role inserting alone"
					)
					return [{ name, role: rc }]
				})
				const result = compiled(s, declared)
				assert.ok(result.ok, result.ok ? "" : result.error.message)
				const i = result.value
				const controls = Arr.map(declared, (d) => ({ ...d, role: controlOf(d.role, w.mutability) }))
				const control = compiled(s, controls)
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
					const { writes, modes } = d.role
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
						if (t === "Open") {
							continue
						}
						if (writes[t] !== "none" && modes[t] === "insert") {
							const recounts = isOwner(t) && writes[memberOf[t]] !== "none"
							assert.ok(
								Arr.every(
									installed,
									(p) => p === "SELECT" || p === "INSERT" || (recounts && p === "UPDATE")
								),
								`${d.name} holds no DELETE on ${t}, which its insert list names, and no UPDATE but a recount's`
							)
							if (mutableIn(w.mutability, t)) {
								c.note("an open relation inserted into alone")
							}
						}
						if (
							isOwner(t) &&
							writes[memberOf[t]] !== "none" &&
							(writes[t] !== "whole" || modes[t] === "insert")
						) {
							c.note(
								Arr.some(installed, (p) => p === "UPDATE")
									? "an owner's recount granted"
									: "an inserting role holding a family owner's columns"
							)
						}
					}
					assert.ok(
						Arr.every([...granted.keys()], (k) => k !== "Open"),
						`${d.name} holds no table privilege on what it only reads`
					)
				}
				const differing = new Set(
					Arr.flatMap(declared, (d) => {
						const ctl = controlOf(d.role, w.mutability)
						return Arr.some(
							written,
							(t) => d.role.writes[t] !== "none" && d.role.modes[t] !== ctl.modes[t]
						)
							? [privilegesIdent(i, d.name)]
							: []
					})
				)
				assert.deepEqual(
					comparable(i, differing),
					comparable(ci, differing),
					"the installation is the control's but for each role's privileges where its lists differ"
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
								d.role.writes[t] !== "none" &&
								d.role.modes[t] === "insert" &&
								Arr.some(rulePrivileges(d, w.mutability, t), (p) => p === "INSERT")
						)
					) {
						c.note("a guarded table an inserting role writes")
					}
				}
				const programmed = Arr.findFirst(declared, (d) => d.name === w.program.role)
				if (Option.isNone(programmed)) {
					return
				}
				const d = programmed.value
				const { names } = entriesOf(s, d.role.writes)
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
				const program = compiledOrRefused(roleOf(s, d.name, d.role), targeted)
				const controlProgram = compiledOrRefused(
					roleOf(s, d.name, controlOf(d.role, w.mutability)),
					targeted
				)
				if (!controlProgram.ok) {
					c.note("a program the control refuses")
					assert.ok(!program.ok, "the control's refusal stands")
					assert.deepEqual(
						program.error.reason,
						controlProgram.error.reason,
						"the control's refusal stands"
					)
					return
				}
				const relationOf = (table: string): Option.Option<(typeof written)[number]> =>
					Arr.findFirst(written, (t) => i.names.relation(t).name === table)
				const beyond = Arr.flatMap(modificationsOf(statementsOf(controlProgram.value)), (m) =>
					Option.match(relationOf(m.table), {
						onNone: () => [],
						onSome: (t) =>
							Arr.some(rulePrivileges(d, w.mutability, t), (p) => p === m.operation)
								? []
								: [{ relation: t, operation: m.operation }]
					})
				)
				if (!isNonEmpty(beyond)) {
					c.note("an admitted program")
					assert.ok(program.ok, program.ok ? "" : program.error.message)
					assert.deepEqual(
						anchorlessStatementsOf(program.value),
						anchorlessStatementsOf(controlProgram.value),
						"an admitted program is the control's"
					)
					return
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
					Arr.some(
						beyond,
						(b) => b.relation === access.relation && b.operation === access.operation
					),
					`${access.operation} of ${access.relation} is one the control's program makes beyond the role's grants`
				)
				const recounted = Arr.some(
					written,
					(t) => t === access.relation && isOwner(t) && d.role.writes[t] === "none"
				)
				c.note(
					access.operation === "DELETE"
						? "a DELETE refused"
						: recounted
							? "a recount refused"
							: "an UPDATE refused"
				)
			}),
		oracle: {
			kind: "specification",
			name: "the rule restated over the world, the control installation and the control compilation"
		},
		kept: [
			{
				token: ReplayToken(
					"test/unit/physical/insert-grants.test.ts#rolesThatWriteEachRelationUnderItsListTheDeclarationItsGrantsAndTheRefusalOfProgramsBeyondThem:-:2.0.1.1.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.2.0.2.2.0"
				),
				reason:
					"a put through a query entry over a mutable family owner under the write list, beside an owner's insertion",
				since: "2026-11-10"
			},
			{
				token: ReplayToken(
					"test/unit/physical/insert-grants.test.ts#rolesThatWriteEachRelationUnderItsListTheDeclarationItsGrantsAndTheRefusalOfProgramsBeyondThem:-:0.0.0.0.0.0.0.0.0.0.2.1.0.0.0.1.0.0.0.0.1.1.0.1.1.2.0"
				),
				reason:
					"TOOLTRUST's sync at faa39c3c1: a put of a mutable owner whose counted member the role inserts, whose UPDATE carries the control's anchor on the count and none of the role's",
				since: "2026-11-25"
			}
		],
		kills: [
			{
				file: "packages/engine/src/sql/generation.ts",
				original:
					"\t\t: brand([...set, { column: anchor.column, value: col(target, anchor.column) }])\n",
				replacement:
					"\t\t: brand([...set, { column: anchor.column, value: col(target, set[0].column) }])\n",
				why: "An UPDATE's anchor assigns another column's value, not its own (sql/generation.ts assignments), so it changes the row: the control's put of the owner differs from the role's, which carries no anchor."
			},
			{
				file: "packages/engine/src/physical/ddl/roles.ts",
				original: '\t\t\treturn ["SELECT", "INSERT"]',
				replacement: '\t\t\treturn ["SELECT", "INSERT", "UPDATE", "DELETE"]',
				why: "An entry of the insert list holds the write list's privileges: its role's UPDATE and DELETE on the table differ from the rule's."
			},
			{
				file: "packages/engine/src/schema/own.ts",
				original: '\t\tif (mode === "write" && base.relations[relation]?.mutable !== true) {',
				replacement: "\t\tif (false) {",
				why: "Ownership admits a closed relation under the write list: the declaration the rule refuses is owned."
			}
		]
	})
