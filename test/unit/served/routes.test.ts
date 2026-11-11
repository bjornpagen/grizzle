/**
 * Every read a login serves carries exactly the footprint its program reads and the key its delivered rows prove:
 * what generate records so that no runtime, HTTP layer, client or OpenAPI document derives either again.
 *
 * Over generated public schemas (test/support/oracle/public), each extended by a drawn law level (laws.ts), and logins
 * drawn over them (test/support/served-login.ts), each login compiled as generate compiles it (adapter/served/compile.ts
 * snapshotCompiled, then servedEntryOf) and its file read back from the JSON value its text parses to:
 *
 * - Footprint: each read member's served footprint is the one the program's base-level IR climbs to
 *   (test/support/served-routes.ts climbedFootprint), named as installed under its role's names. The program's IR is
 *   the one its plan reads (program/workload/compile.ts workloadQueryRead), and the oracle is a second implementation
 *   over the same logical analysis's fixed facts: from each Base up every path to a root, the column carrying each
 *   field climbs through the nodes that keep its value, and a field routes by a parameter that ties it on every path;
 *   logical/routes.ts footprintOf pushes what each node's consumers read down from the roots instead.
 * - Key: a set read's served key is a KeySetProof over the physical analysis of its optimized root
 *   (lower/conservative/keys.ts keySetOf, its root evaluated once), within its heading and no wider than the canonical
 *   minimal key the analysis proves among it, or, where it proves none, every head field its decoder reads; an ordered
 *   read's is the fields of the completed order its root delivers in, and a paged read's the fields of its page's.
 *
 * Plants (~/.cache/grizzle-release/LIVE-ROUTES/plants): route-dropped.patch drops each table's last routed field
 * (footprint red); route-narrowed.patch routes a table its program reads table-wide by its first column, under the
 * program's first parameter (footprint red; the soundness suite, routes-sound.test.ts, red too); key-whole-row.patch
 * keys a set read by every head field where a narrower key is proved (key red).
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Result as Answered, Array as Arr, Effect, Formatter, Option, Order } from "effect"
import type { WorkloadForm } from "#adapter/db/workload.ts"
import { keyedBy } from "#compiler/analysis/physical/props.ts"
import type { DecoderForm } from "#compiler/core/decoder.ts"
import type { OuterRefs } from "#compiler/ir/dag.ts"
import { keySetOf } from "#compiler/lower/conservative/keys.ts"
import { workloadQueryRead } from "#compiler/program/workload/compile.ts"
import type { ServedKey, ServedMember, ServedRead } from "#compiler/served/forms.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { caseSketchGen, resolveCase } from "#test/support/oracle/public/generate.ts"
import { type LawLevel, lawLevelGen } from "#test/support/oracle/public/laws.ts"
import { printCase } from "#test/support/oracle/public/print.ts"
import {
	compiledLogin,
	drawnLogin,
	drawnSchema,
	type DrawnSchema,
	loginGen,
	type RoleShape,
	rolesOf
} from "#test/support/served-login.ts"
import { climbedFootprint, installedFootprint } from "#test/support/served-routes.ts"

type Feature =
	| "a table a read routes by a parameter"
	| "a table a read reads table-wide"
	| "a set read keyed narrower than its heading"
	| "an ordered read"
	| "a paged read"

/** A served member that reads, with its read; none for a ChangeSet or a refresh. */
const readOf = (member: ServedMember): ServedRead | undefined => {
	switch (member.kind) {
		case "read":
		case "paged":
		case "key":
			return member.read
		case "change":
		case "refresh":
			return undefined
	}
}

/** A compiled workload member's rows form, where it reads. */
const formOf = (member: WorkloadForm) => {
	switch (member.kind) {
		case "read":
		case "paged":
		case "key":
			return member.form
		case "change":
		case "refresh":
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

const routesAndKeys = (
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
				assert.deepEqual(
					read.footprint,
					installedFootprint(climbed, role.compiled.artifacts.names),
					`${member.name}: its footprint is the tables it reads, each routed by the fields its parameters fix\n${printed()}`
				)
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

describe("a login's served reads", () => {
	it.effect(
		"carry the footprint their program reads, routed by the fields its parameters fix, and the key their rows prove",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "second-implementation",
							name: "the footprint climbed from each Base up the program's fixed facts (test/support/served-routes.ts), and the KeySetProof of the optimized root"
						},
						suite: "unit/served/routes",
						draw: drawn(
							(source) => [source.draw(caseSketchGen), source.draw(lawLevelGen)] as const
						),
						literal: Formatter.format,
						coverage: required<Feature>(
							[
								"a table a read routes by a parameter",
								"a table a read reads table-wide",
								"a set read keyed narrower than its heading",
								"an ordered read",
								"a paged read"
							],
							{ cases: 60, sense: notesOnly }
						),
						kept: [],
						runs: 60,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					([sketch, level], notes) =>
						Effect.suspend(() => {
							const schema = drawnSchema(notes.draw(resolveCase(sketch)), level)
							return routesAndKeys(schema, level, notes.draw(loginGen(schema)), notes.note)
						})
				)
			)
	)
})
