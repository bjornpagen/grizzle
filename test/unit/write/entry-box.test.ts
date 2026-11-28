/**
 * The write front end over its small box, every point of it (docs/reads-and-writes.md "Writes", "Writing through a role"): a relation of
 * one to three fields, each in the key or not (the key never empty); written whole, or through a query entry of one
 * rule over it, each field carried in the head, carried and read by a comparison of the filter, fixed by a literal, or
 * unnamed, the head never empty. Every point is built as an application builds it and compiled as db.apply compiles an
 * insert through it, then bound with every list of up to two facts drawn from the entry's fact kinds: complete, and
 * partial (its first carried field left out).
 *
 * The worlds model is the oracle, each verdict its own: grizzle refuses to build the role exactly where refusedAtBuild
 * does; a built role's insert compiles exactly where compileRefused admits it, so a compile refusal over a write the
 * model admits fails here, whatever its kind; and an input is refused at its encoder exactly where the model's opFault
 * is an encoding fault.
 *
 * Features: refused at build; compiled whole and through an entry; a field the filter reads; facts refused at their
 * shape.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Formatter, Result } from "effect"
import { messageOf } from "#test/support/message.ts"
import { buildInstall } from "#test/support/worlds/execute/build.ts"
import {
	offlineCompile,
	offlineServedBind,
	parsedChange
} from "#test/support/worlds/execute/offline.ts"
import { plannedWrite, type WritingRole } from "#test/support/worlds/execute/session.ts"
import { compileRefused, opFault } from "#test/support/worlds/model/session/apply.ts"
import { refusedAtBuild, writtenNamed } from "#test/support/worlds/model/session/writes.ts"
import type { EntryOp, HostFact } from "#test/support/worlds/model/types.ts"
import {
	atEncoder,
	type BoxFeature,
	factKinds,
	factLists,
	installOf,
	pointGen
} from "#test/unit/write/entry-box.fixtures.ts"

/** The write front end over its small box builds, compiles and binds every insert of the box exactly where the worlds model says. */
export const theWriteFrontEndOverItsSmallBoxBuildsCompilesAndBindsEveryInsertOfTheBoxExactlyWhereTheWorldsModelSays =
	property.exhaust(finite(pointGen), {
		needs: {},
		situations: [
			"refused at build",
			"compiled whole",
			"compiled entry",
			"a field the filter reads",
			"facts refused at their shape"
		] satisfies ReadonlyArray<Reached<BoxFeature>>,
		check: (_, c: Case<BoxFeature>) => (point) =>
			Effect.gen(function* () {
				const { install, entry } = installOf(point)
				const base = install.base
				const built = yield* Effect.result(buildInstall(install, base.name))
				const refused = refusedAtBuild(install)
				if (Result.isFailure(built)) {
					assert.ok(
						refused,
						`grizzle refuses to build a role the model builds: ${messageOf(built.failure.refusal)}`
					)
					c.note("refused at build")
					return
				}
				assert.ok(!refused, "grizzle builds a role the model refuses to build")
				const [role] = install.roles
				const written = defined(writtenNamed(base, role, entry), `the written entry ${entry}`)
				const writer: WritingRole = {
					role,
					value: defined(built.success.roles[role.name], "the role as built")
				}
				const insert = (facts: ReadonlyArray<HostFact>): EntryOp => ({
					relation: entry,
					kind: "insert",
					facts
				})
				const changeOf = (facts: ReadonlyArray<HostFact>) =>
					Effect.flatMap(plannedWrite(base, writer, [[insert(facts)]], []), (write) =>
						Result.isFailure(write)
							? Effect.die(
									new Error(`the builder refuses an insert of facts: ${messageOf(write.failure)}`)
								)
							: Effect.succeed({
									change: parsedChange(write.success.changes),
									facts: write.success.facts
								})
					)
				const { change } = yield* changeOf([])
				const compiled = offlineCompile(writer.value, change, new Set())
				assert.ok(
					!compileRefused(base, role, [[insert([])]], []),
					"the model refuses an insert through the role's one written entry"
				)
				if (!compiled.ok) {
					return assert.fail(
						`the model admits the insert, and grizzle refuses it when it compiles: ${messageOf(compiled.error)}`
					)
				}
				c.note(written.kind === "whole" ? "compiled whole" : "compiled entry")
				if (point.entry.kind === "query" && point.entry.uses.includes("read")) {
					c.note("a field the filter reads")
				}
				for (const facts of factLists(factKinds(base, written))) {
					const predicted = opFault(base, written, insert(facts))?.kind === "encoding"
					const call = yield* changeOf(facts)
					const bound = offlineServedBind(compiled.value, call.change, call.facts)
					const refusal = bound.ok ? undefined : bound.error
					if (refusal !== undefined && !atEncoder(refusal)) {
						return assert.fail(
							`binding ${Formatter.format(facts)} is refused before any SQL, not at its encoder: ${messageOf(refusal)}`
						)
					}
					const encoding = refusal !== undefined
					assert.equal(
						encoding,
						predicted,
						`binding ${Formatter.format(facts)}: the model ${predicted ? "refuses" : "admits"} it at its encoder`
					)
					if (encoding) {
						c.note("facts refused at their shape")
					}
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "the worlds model's refusedAtBuild, compileRefused and opFault"
		},
		box: "a relation of one to three fields, each keyed or not, written whole or through a query entry of one rule carrying, reading, fixing or leaving out each field, each insert bound with every list of up to two of its fact kinds",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/schema/entry.ts",
				original:
					'\t\tif (binding === undefined) {\n\t\t\tif (family(target, field)) {\n\t\t\t\tcontinue\n\t\t\t}\n\t\t\treturn refused(name, { kind: "fieldNotFixed", field })\n\t\t}',
				replacement: "\t\tif (binding === undefined) {\n\t\t\tcontinue\n\t\t}",
				why: "A field the entry's head leaves unnamed is no longer refused at build, where the model refuses the role (fieldNotFixed)."
			}
		]
	})
