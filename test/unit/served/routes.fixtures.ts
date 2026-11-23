/** What the properties of routes.test.ts read: its spaces, models and helpers. */

import { assert, defined } from "@bjornpagen/testing/assert"
import {
	Result as Answered,
	Array as Arr,
	Effect,
	Formatter,
	Option,
	Order,
	Record as Rec
} from "effect"
import type { WorkloadForm } from "#adapter/db/workload.ts"
import { keyedBy } from "#compiler/analysis/physical/props.ts"
import type { DecoderForm } from "#compiler/core/decoder.ts"
import type { OuterRefs } from "#compiler/ir/dag.ts"
import { keySetOf } from "#compiler/lower/conservative/keys.ts"
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
	| "a set read keyed narrower than its heading"
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

/** The fields a decoder form's records read from a column, at its root, every record's in its order, each once. */
const columnFields = (form: DecoderForm): ReadonlyArray<string> => {
	switch (form.kind) {
		case "record":
			return Arr.flatMap(form.fields, ([name, field]) => (field.kind === "column" ? [name] : []))
		case "merge":
		case "oneOf":
			return Arr.dedupe([...columnFields(form.first), ...columnFields(form.second)])
		case "arm":
			return columnFields(form.parent)
		case "refused":
			return []
	}
}

/** The root of a program's DAG reads no enclosing node. */
const evaluatedOnce: OuterRefs = new Map()

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
			{ kind: "list", fields: Arr.map(member.page.order.keys, (k) => k.column) },
			`${member.name}: a page's rows are keyed by its completed order\n${printed()}`
		)
		return
	}
	const { template } = form.bound.compiled.compiled
	const { query, plan } = template.programs.optimized
	const root = query.dag.roots[0]
	if (root.kind === "OrderedResult") {
		note("an ordered read")
		assert.deepEqual(
			served,
			{ kind: "list", fields: Arr.map(root.order.keys, (k) => k.column) },
			`${member.name}: an ordered read's rows are keyed by its completed order\n${printed()}`
		)
		return
	}
	assert.equal(served.kind, "set", `${member.name}: a set read's key is a set's\n${printed()}`)
	const props = plan.analysis.of(root).props
	const heading = Arr.map(root.heading, (c) => c.name)
	const proved = keyedBy(props, heading)
	if (proved === undefined) {
		assert.deepEqual(
			Arr.sort(served.fields, Order.String),
			Arr.sort(columnFields(form.decoder().form), Order.String),
			`${member.name}: a read whose delivery proves no key is keyed by every head field\n${printed()}`
		)
		return
	}
	assert.ok(
		Arr.every(served.fields, (f) => Arr.contains(heading, f)),
		`${member.name}: its key's fields are head fields\n${printed()}`
	)
	assert.equal(
		keySetOf(served.fields, keyedBy(props, served.fields), evaluatedOnce, undefined).kind,
		"proved",
		`${member.name}: its key is a key its delivered rows prove\n${printed()}`
	)
	assert.ok(
		served.fields.length <= proved.key.length,
		`${member.name}: its key is no wider than the canonical minimal key ${Formatter.format(proved.key)}\n${printed()}`
	)
	if (served.fields.length < heading.length) {
		note("a set read keyed narrower than its heading")
	}
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
