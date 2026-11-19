import type { Reached } from "@bjornpagen/testing/features"
import { element, finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Exit, Option } from "effect"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { query, v } from "#compiler/public/query.ts"
import { paged } from "#compiler/public/workload.ts"
import {
	answers,
	type ArgumentFeature,
	argumentKinds,
	argumentOf,
	type Call,
	calls,
	isNonRecord,
	nonRecords,
	type Read,
	strayKey
} from "#test/pg/reads/params-argument.fixtures.ts"
import { installed } from "#test/pg/reads/support.ts"
import { assert, assertVariant, defined } from "#test/support/assert.ts"
import { answered, readOnce } from "#test/support/calls.ts"
import * as W from "#test/support/fixtures/api/work.ts"
import { a1, t1, workFacts } from "#test/support/fixtures/golden/work.ts"
import { member, openServedDb } from "#test/support/served-db.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A program's parameter argument is a record of the program's parameters: any other value is refused at encode, whether or not the program declares a parameter.
 */
export const aProgramsParameterArgumentIsARecordOfTheProgramsParametersAnyOtherValueIsRefusedAtEncodeWhetherOrNotTheProgramDeclaresAParameter =
	property.exhaust(
		finite((source) => [source.draw(element(calls)), source.draw(element(argumentKinds))] as const),
		{
			needs: { substrate: Substrate.installing },
			situations: [
				...Arr.flatMap(calls, (call): Arr.NonEmptyReadonlyArray<ArgumentFeature> => [
					`${call}: a record answered`,
					`${call}: no record refused`
				]),
				...Arr.map(nonRecords, (kind): ArgumentFeature => `${kind} refused`),
				"a stray key refused",
				"a key member: a stray key answered"
			] satisfies ReadonlyArray<Reached<ArgumentFeature>>,
			check:
				({ substrate }, c: Case<ArgumentFeature>) =>
				([call, kind]) =>
					Effect.provideServiceEffect(
						Effect.gen(function* () {
							const o = yield* installed(W.Work, workFacts, {
								label: "real",
								programs: {}
							})
							const s = o.schema
							const tasks = query(s).rule((r) => {
								const { id } = v(W.Task, "task")
								return r.match(W.Task, { id }).find({ id })
							})
							const { serve } = yield* openServedDb(o.installed, o.server.roles.app, {})
							const served = yield* serve({
								tasks,
								ordered: paged(tasks.orderBy(["id", "asc"])),
								tasksFor: W.workReads(s).automaticTasksFor,
								task: W.Task,
								unchanged: ChangeSet.empty(s),
								readBack: ChangeSet.empty(s).read("tasks", () =>
									query(s).rule((r) => {
										const { id } = v(W.Task, "task")
										return r
											.match(W.Task, { id, account: r.param("account", W.Task.fields.account) })
											.find({ id })
									})
								)
							})
							/** A read member's once with the caller's argument as its params. */
							const readCall = (name: string, argument: unknown) =>
								readOnce(member(served, name))({ params: argument, facts: {} })
							/** A change member of no array member, applied with the caller's argument as its params. */
							const applied = (name: string, argument: unknown) => {
								const change = member(served, name)
								assertVariant(
									change,
									"shape",
									"write",
									`the member ${name} takes its parameters alone`
								)
								return answered(change.once({ params: argument, facts: {} }))
							}
							const reads: { readonly [C in Call]: Read } = {
								"a read without parameters": {
									live: {},
									call: (a) => readCall("tasks", a)
								},
								"a window without parameters": {
									live: {},
									call: (a) =>
										readOnce(member(served, "ordered"))({
											params: a,
											facts: {},
											window: { anchor: { kind: "start" }, size: 2 }
										})
								},
								"a read with a parameter": {
									live: { account: a1 },
									call: (a) => readCall("tasksFor", a)
								},
								"a key member": {
									live: { id: t1 },
									call: (a) => readCall("task", a)
								},
								"a write without parameters": { live: {}, call: (a) => applied("unchanged", a) },
								"a write with a parameter": {
									live: { account: a1 },
									call: (a) => applied("readBack", a)
								}
							}

							const read = reads[call]
							const argument = argumentOf(kind, read.live)
							const what = `${call} with ${kind}`
							if (answers(call, kind)) {
								yield* read.call(argument)
								c.note(
									kind === strayKey
										? "a key member: a stray key answered"
										: `${call}: a record answered`
								)
								return
							}
							const exit = yield* Effect.exit(read.call(argument))
							if (Exit.isSuccess(exit)) {
								return assert.fail(`${what} answered`)
							}
							const refusal = defined(
								Option.getOrUndefined(Exit.findErrorOption(exit)),
								`${what} fails, not dies`
							)
							if (refusal.kind !== "input") {
								return assert.fail(`${what} is refused at encode by its codec, not ${refusal.kind}`)
							}
							if (isNonRecord(kind)) {
								c.note(`${call}: no record refused`)
								c.note(`${kind} refused`)
							} else {
								c.note("a stray key refused")
							}
						}).pipe(Effect.scoped),
						Substrate,
						substrate
					),
			oracle: {
				kind: "specification",
				name: "readParams's contract: a record of the program's parameters answers, any other argument is refused factShape naming no parameter, and a key member projects its key's fields"
			},
			box: "every call of a read and a write door, each with every argument kind built for its program",
			kept: [],
			kills: []
		}
	)
