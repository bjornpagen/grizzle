/** What the properties of routes.test.ts read: its spaces, models and helpers. */

import { assert, defined } from "@bjornpagen/testing/assert"
import { Result as Answered, Array as Arr, Effect, Formatter, Option, Record as Rec } from "effect"
import type { WorkloadForm } from "#adapter/db/workload.ts"
import { workloadQueryRead } from "#compiler/program/workload/compile.ts"
import type { ServedKey, ServedMember, ServedRead } from "#compiler/served/forms.ts"
import { succeeded } from "#test/support/assert.ts"
import { type LawLevel } from "#test/support/oracle/public/laws.ts"
import { printCase } from "#test/support/oracle/public/print.ts"
import {
	compiledLogin,
	drawnLogin,
	type DrawnSchema,
	type RoleShape,
	rolesOf,
	worldReadName
} from "#test/support/served-login.ts"
import { climbedFootprint, installedFootprint } from "#test/support/served-routes.ts"

export type Feature =
	| "a table a read routes by a parameter"
	| "a table a read reads table-wide"
	| "a read through a query entry"
	| "an ordered read"
	| "a paged read"

/** A served member that reads live, with its read; none for a ChangeSet or an answered read. */
const readOf = (member: ServedMember): ServedRead | undefined => {
	switch (member.kind) {
		case "read":
		case "paged":
		case "key":
			return member.read.live.kind === "answered" ? undefined : member.read
		case "change":
			return undefined
	}
}

/** A compiled workload member's rows form, where it reads live. */
const formOf = (member: WorkloadForm) => {
	switch (member.kind) {
		case "read":
		case "paged":
		case "key":
			return member.called === "live" ? member.form : undefined
		case "change":
			return undefined
	}
}

/** The key a read's rows are delivered under, as its compiled template and its page say it (see the header). */
const keyHolds = (
	served: ServedKey,
	member: ServedMember,
	form: NonNullable<ReturnType<typeof formOf>>,
	note: (feature: Feature) => void,
	printed: () => string
): void => {
	if (member.kind === "paged") {
		note("a paged read")
		assert.deepEqual(
			served,
			{ fields: Arr.map(member.page.order.keys, (k) => k.column) },
			`${member.name}: a page's rows are keyed by its completed order\n${printed()}`
		)
		return
	}
	const { template } = form.bound.compiled.compiled
	const { query } = template.programs.optimized
	const root = query.dag.roots[0]
	assert.ok(
		root.kind === "OrderedResult",
		`${member.name}: a served read's root is its ordered result\n${printed()}`
	)
	note("an ordered read")
	assert.deepEqual(
		served,
		{ fields: Arr.dedupe(Arr.flatMap(root.orders, (o) => Arr.map(o.keys, (k) => k.column))) },
		`${member.name}: a read's rows are keyed by its completed order\n${printed()}`
	)
}

export const routesAndKeys = (
	drawnSchemaCase: DrawnSchema,
	level: LawLevel,
	shapes: Arr.NonEmptyReadonlyArray<RoleShape>,
	note: (feature: Feature) => void
) =>
	Effect.gen(function* () {
		const printed = () =>
			`${printCase(drawnSchemaCase.case)}\n${Formatter.format(level)}\n${Formatter.format(shapes)}`
		const compiled = yield* Effect.result(
			compiledLogin(drawnLogin(drawnSchemaCase, shapes), drawnSchemaCase.laws.codes)
		)
		if (Answered.isFailure(compiled)) {
			return
		}
		for (const role of rolesOf(compiled.success)) {
			for (const member of role.served.members) {
				const read = readOf(member)
				if (read === undefined) {
					continue
				}
				const form = defined(
					Arr.findFirst(role.compiled.workload, (w) => w.name === member.name).pipe(
						Option.flatMap((w) => Option.fromNullishOr(formOf(w))),
						Option.getOrUndefined
					),
					`the compiled read ${member.name} of role ${role.served.name}`
				)
				const ir = succeeded(
					workloadQueryRead(
						form.bound.compiled.compiled.desc,
						role.compiled.schema,
						role.compiled.artifacts
					),
					`read ${member.name}'s base-level IR`
				)
				const climbed = climbedFootprint(ir)
				const installed = installedFootprint(climbed, role.compiled.artifacts.names)
				assert.deepEqual(
					read.live,
					Rec.isEmptyRecord(installed)
						? { kind: "constant" }
						: { kind: "routed", footprint: installed },
					`${member.name}: its footprint is the tables it reads, each routed by the fields its parameters fix, a read of none constant\n${printed()}`
				)
				if (member.name === worldReadName(0, "entry")) {
					note("a read through a query entry")
				}
				for (const routes of climbed.tables.values()) {
					note(
						routes.size > 0
							? "a table a read routes by a parameter"
							: "a table a read reads table-wide"
					)
				}
				keyHolds(read.key, member, form, note, printed)
			}
		}
	})
