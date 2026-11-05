import { Array as Arr, Effect } from "effect"
import type { LawId } from "#compiler/core/ids.ts"
import { type AnyRelation, contained } from "#compiler/public/schema.ts"
import {
	Assignment,
	Badge,
	Batch,
	type BatchesParams,
	batchesOf,
	batchesRelations,
	Desk,
	englishTickets,
	Escalation,
	escalationTicket,
	issued,
	Line,
	levelTickets,
	Node,
	Note,
	nodeParent,
	noteBatch,
	noteKey,
	offCycleLines,
	oneShift,
	Page,
	pageTicket,
	priorities,
	Reason,
	type ReasonsParams,
	reasonKey,
	reasonLine,
	reasonsOf,
	reasonsRelations,
	type RotaParams,
	rotaOf,
	rotaRelations,
	Sheet,
	type SignalsParams,
	shiftSheet,
	signalsOf,
	signalsRelations,
	type StaffingParams,
	staffed,
	staffingOf,
	staffingRelations,
	statuses,
	Ticket,
	Translation,
	type TreeParams,
	translationTicket,
	treeOf,
	urgentBatches,
	urgentTickets,
	Watch,
	Worker,
	watchedTickets,
	watchTicket
} from "#test/pg/laws/projections/schemas.ts"
import { type LawNames, lawNamesOf } from "#test/support/kernel/naming.ts"
import { booleans, type Family, hostRelation, noTraits } from "#test/support/laws/boxes.ts"
import {
	everyFact,
	fieldsEqual,
	type HostLaw,
	type HostSchema,
	type HostSelection,
	type HostSide
} from "#test/support/laws/model.ts"
import { openWriter, runtimeSession } from "#test/support/laws/support.ts"

/**
 * The partial-projection families of the projection suites (source.test.ts, mirrors.test.ts), over the schemas
 * schemas.ts owns.
 *
 * Each family states its schemas to the host (model.ts), as laws/boxes.ts does: a selected side is a HostSide whose
 * `where` holds exactly the facts its predicate holds of over the family's domains, and every law is native, so a
 * refusal names no violator. PostgreSQL refuses a key's violation with 23505 at its statement, and a foreign key's with
 * 23503, at its statement or, deferred, at COMMIT.
 *
 * - a selected source into a relation with a payload, and one into a relation that is all key (projectedSource);
 * - a selected source over a composite text and uuid projection, its selection a closed handle, with or without a key
 *   over the same side, and a selected source into its own relation (sourceShapes);
 * - a selected side's mirrors into a candidate key of its child (projectedMirrors);
 * - mirrors over a composite projection out of the parent's key order, and a ticket's four mirrors, selected by an
 *   integer, a refined text, a closed handle and a predicate no literal record states (mirrorShapes).
 *
 * mirrors is sugar for its two containments: each half's law is the law of the containment it states, read through the
 * naming door from `contained(…)` over the same sides.
 */

/** A schema's mutability as its description names it. */
const describeMutable = (mutable: boolean): string => (mutable ? "mutable" : "immutable")

/** A relation's primary key, as the host states it. */
const primaryKey = (
	laws: LawNames,
	relation: AnyRelation & { readonly name: string },
	fields: ReadonlyArray<string>
): HostLaw => ({
	kind: "key",
	law: laws.primaryKeyLaw(relation),
	relation: relation.name,
	fields,
	selection: everyFact
})

/** A native containment of one side into another, as the host states it. */
const containment = (law: LawId, source: HostSide, target: HostSide): HostLaw => ({
	kind: "contained",
	law,
	source,
	target
})

const staffingHost = (p: StaffingParams): HostSchema => {
	const laws = lawNamesOf(staffingOf(p)("families"))
	return {
		relations: [
			hostRelation("Worker", ["id", "name"], ["id"], p.mutable),
			hostRelation("Assignment", ["id", "worker", "active"], ["id"], p.mutable),
			hostRelation("Desk", ["id"], ["id"], p.mutable),
			hostRelation("Badge", ["id", "desk", "issued"], ["id"], p.mutable)
		],
		laws: [
			primaryKey(laws, Worker, ["id"]),
			primaryKey(laws, Assignment, ["id"]),
			primaryKey(laws, Desk, ["id"]),
			primaryKey(laws, Badge, ["id"]),
			containment(
				laws.lawOf(staffed(p.selector)),
				{
					relation: "Assignment",
					fields: ["worker"],
					selection: fieldsEqual({ active: p.selector })
				},
				{ relation: "Worker", fields: ["id"], selection: everyFact }
			),
			containment(
				laws.lawOf(issued(p.selector)),
				{ relation: "Badge", fields: ["desk"], selection: fieldsEqual({ issued: p.selector }) },
				{ relation: "Desk", fields: ["id"], selection: everyFact }
			)
		]
	}
}

export const projectedSource: Family<StaffingParams> = {
	label: "a selected source's containment",
	variants: Arr.flatMap(booleans, (mutable) =>
		Arr.map(booleans, (selector): StaffingParams => ({ mutable, selector }))
	),
	describe: (p) =>
		`${describeMutable(p.mutable)}, Assignment selected by active and Badge by issued = ${p.selector}`,
	traits: noTraits,
	domains: {
		Worker: { id: [1, 2, 3], name: ["a", "b"] },
		Assignment: { id: [1, 2, 3, 4], worker: [1, 2, 3, 4], active: [true, false] },
		Desk: { id: [1, 2] },
		Badge: { id: [1, 2, 3], desk: [1, 2, 3], issued: [true, false] }
	},
	host: staffingHost,
	schema: staffingOf,
	connect: (p, installed) =>
		Effect.flatMap(openWriter({ installed, schema: staffingOf(p)(installed.declared) }), (o) =>
			runtimeSession(staffingHost(p), o, staffingRelations)
		)
}

/** A source shape: the rota's composite projection, or the tree's into its own relation. */
export type SourceShape =
	| ({ readonly kind: "rota" } & RotaParams)
	| ({ readonly kind: "tree" } & TreeParams)

const rotaHost = (p: RotaParams): HostSchema => {
	const laws = lawNamesOf(rotaOf(p)("families"))
	const selected: HostSide = {
		relation: "Shift",
		fields: ["employee", "week"],
		selection: fieldsEqual({ status: p.status })
	}
	return {
		relations: [
			hostRelation("Sheet", ["employee", "week", "ceiling"], ["employee", "week"], p.mutable),
			hostRelation("Shift", ["id", "employee", "week", "status"], ["id"], p.mutable)
		],
		laws: [
			primaryKey(laws, Sheet, ["employee", "week"]),
			primaryKey(laws, rotaRelations.Shift, ["id"]),
			containment(laws.lawOf(shiftSheet(p.status)), selected, {
				relation: "Sheet",
				fields: ["employee", "week"],
				selection: everyFact
			}),
			...(p.keyed
				? [
						{
							kind: "key",
							law: laws.lawOf(oneShift(p.status)),
							relation: selected.relation,
							fields: selected.fields,
							selection: selected.selection
						} satisfies HostLaw
					]
				: [])
		]
	}
}

const treeHost = (p: TreeParams): HostSchema => {
	const laws = lawNamesOf(treeOf(p)("families"))
	return {
		relations: [hostRelation("Node", ["id", "parent", "live"], ["id"], p.mutable)],
		laws: [
			primaryKey(laws, Node, ["id"]),
			containment(
				laws.lawOf(nodeParent(p.live)),
				{ relation: "Node", fields: ["parent"], selection: fieldsEqual({ live: p.live }) },
				{ relation: "Node", fields: ["id"], selection: everyFact }
			)
		]
	}
}

const sourceShapesHost = (shape: SourceShape): HostSchema => {
	switch (shape.kind) {
		case "rota":
			return rotaHost(shape)
		case "tree":
			return treeHost(shape)
	}
}

const describeSource = (shape: SourceShape): string => {
	switch (shape.kind) {
		case "rota":
			return `Shift selected by status = ${shape.status} into Sheet (employee, week)${shape.keyed ? ", at most one per sheet" : ""}`
		case "tree":
			return `Node selected by live = ${shape.live} into its own id`
	}
}

/**
 * Two employees, three weeks and four shifts: a shift's sheet is present as often as not, and two shifts of one sheet's
 * week meet as often.
 */
export const employees = [
	"00000000-0000-4000-8000-000000000001",
	"00000000-0000-4000-8000-0000000000a2"
] as const
export const weeks = ['W\'1 "q"', "\\ [x],", "W2"] as const
export const shifts = [
	"00000000-0000-4000-8000-00000000000b",
	"00000000-0000-4000-8000-00000000000c",
	"00000000-0000-4000-8000-0000000000d0",
	"00000000-0000-4000-8000-0000000000e0"
] as const

export const sourceShapes: Family<SourceShape> = {
	label:
		"a selected source and key over a composite text and uuid projection, and into its own relation",
	variants: Arr.flatMap(booleans, (mutable) =>
		Arr.appendAll(
			Arr.flatMap(statuses, (status) =>
				Arr.map(booleans, (keyed): SourceShape => ({ kind: "rota", mutable, status, keyed }))
			),
			Arr.map(booleans, (live): SourceShape => ({ kind: "tree", mutable, live }))
		)
	),
	describe: (shape) => `${describeMutable(shape.mutable)}, ${describeSource(shape)}`,
	traits: noTraits,
	domains: {
		Sheet: { employee: employees, week: weeks, ceiling: [1, 2] },
		Shift: { id: shifts, employee: employees, week: weeks, status: statuses },
		Node: { id: [1, 2, 3], parent: [1, 2, 3], live: [true, false] }
	},
	host: sourceShapesHost,
	schema: (shape) => {
		switch (shape.kind) {
			case "rota":
				return rotaOf(shape)
			case "tree":
				return treeOf(shape)
		}
	},
	connect: (shape, installed) => {
		const host = sourceShapesHost(shape)
		switch (shape.kind) {
			case "rota":
				return Effect.flatMap(
					openWriter({ installed, schema: rotaOf(shape)(installed.declared) }),
					(o) => runtimeSession(host, o, rotaRelations)
				)
			case "tree":
				return Effect.flatMap(
					openWriter({ installed, schema: treeOf(shape)(installed.declared) }),
					(o) => runtimeSession(host, o, { Node })
				)
		}
	}
}

const reasonsHost = (p: ReasonsParams): HostSchema => {
	const laws = lawNamesOf(reasonsOf(p)("families"))
	const lines = offCycleLines(p.selector)
	const offCycle: HostSide = {
		relation: "Line",
		fields: ["id"],
		selection: fieldsEqual({ offCycle: p.selector })
	}
	const explained: HostSide = { relation: "Reason", fields: ["line"], selection: everyFact }
	return {
		relations: [
			hostRelation("Line", ["id", "offCycle", "note"], ["id"], p.mutable),
			hostRelation("Reason", ["id", "line", "text"], ["id"], p.mutable)
		],
		laws: [
			primaryKey(laws, Line, ["id"]),
			primaryKey(laws, Reason, ["id"]),
			{
				kind: "key",
				law: laws.lawOf(reasonKey),
				relation: "Reason",
				fields: ["line"],
				selection: everyFact
			},
			containment(laws.lawOf(contained(lines, reasonLine)), offCycle, explained),
			containment(laws.lawOf(contained(reasonLine, lines)), explained, offCycle)
		]
	}
}

export const projectedMirrors: Family<ReasonsParams> = {
	label: "a selected side's mirrors",
	variants: Arr.flatMap(booleans, (mutable) =>
		Arr.map(booleans, (selector): ReasonsParams => ({ mutable, selector }))
	),
	describe: (p) => `${describeMutable(p.mutable)}, Line selected by offCycle = ${p.selector}`,
	traits: noTraits,
	domains: {
		Line: { id: [1, 2, 3], offCycle: [true, false], note: ["a", "b"] },
		Reason: { id: [1, 2, 3, 4], line: [1, 2, 3], text: ["x", "y"] }
	},
	host: reasonsHost,
	schema: reasonsOf,
	connect: (p, installed) =>
		Effect.flatMap(openWriter({ installed, schema: reasonsOf(p)(installed.declared) }), (o) =>
			runtimeSession(reasonsHost(p), o, reasonsRelations)
		)
}

/** A mirror shape: the batches' composite projection, or the ticket's four mirrors. */
export type MirrorShape =
	| ({ readonly kind: "batches" } & BatchesParams)
	| ({ readonly kind: "signals" } & SignalsParams)

const batchesHost = (p: BatchesParams): HostSchema => {
	const laws = lawNamesOf(batchesOf(p)("families"))
	const urgent = urgentBatches(p.selector)
	const urgentSide: HostSide = {
		relation: "Batch",
		fields: ["id", "tenant"],
		selection: fieldsEqual({ urgent: p.selector })
	}
	const notes: HostSide = { relation: "Note", fields: ["batch", "account"], selection: everyFact }
	return {
		relations: [
			hostRelation("Batch", ["tenant", "id", "urgent"], ["tenant", "id"], p.mutable),
			hostRelation("Note", ["id", "account", "batch", "text"], ["id"], p.mutable)
		],
		laws: [
			primaryKey(laws, Batch, ["tenant", "id"]),
			primaryKey(laws, Note, ["id"]),
			{
				kind: "key",
				law: laws.lawOf(noteKey),
				relation: "Note",
				fields: ["batch", "account"],
				selection: everyFact
			},
			containment(laws.lawOf(contained(urgent, noteBatch)), urgentSide, notes),
			containment(laws.lawOf(contained(noteBatch, urgent)), notes, urgentSide)
		]
	}
}

/** A ticket's side: the tickets a selection holds of. */
const ticketSide = (selection: HostSelection): HostSide => ({
	relation: "Ticket",
	fields: ["id"],
	selection
})

/** A follow-up's side: every fact of it, by its ticket. */
const followUp = (relation: string): HostSide => ({
	relation,
	fields: ["ticket"],
	selection: everyFact
})

/** The ticket's four mirrors, each host selection the predicate its grizzle side selects by. */
const signalsHost = (p: SignalsParams): HostSchema => {
	const laws = lawNamesOf(signalsOf(p)("families"))
	const levelled = ticketSide(fieldsEqual({ level: 3 }))
	const english = ticketSide(fieldsEqual({ lang: "en" }))
	const urgent = ticketSide(fieldsEqual({ priority: "high" }))
	const watched = ticketSide({
		kind: "where",
		holds: (t) => {
			const level = t["level"]
			return typeof level === "number" && level >= 2 && t["priority"] !== "low"
		},
		pinned: { level: 2, priority: "high" }
	})
	const escalated = followUp("Escalation")
	const translated = followUp("Translation")
	const paged = followUp("Page")
	const watching = followUp("Watch")
	return {
		relations: [
			hostRelation("Ticket", ["id", "level", "lang", "priority"], ["id"], p.mutable),
			hostRelation("Escalation", ["ticket"], ["ticket"], p.mutable),
			hostRelation("Translation", ["ticket", "text"], ["ticket"], p.mutable),
			hostRelation("Page", ["ticket"], ["ticket"], p.mutable),
			hostRelation("Watch", ["ticket"], ["ticket"], p.mutable)
		],
		laws: [
			primaryKey(laws, Ticket, ["id"]),
			primaryKey(laws, Escalation, ["ticket"]),
			primaryKey(laws, Translation, ["ticket"]),
			primaryKey(laws, Page, ["ticket"]),
			primaryKey(laws, Watch, ["ticket"]),
			containment(laws.lawOf(contained(levelTickets, escalationTicket)), levelled, escalated),
			containment(laws.lawOf(contained(escalationTicket, levelTickets)), escalated, levelled),
			containment(laws.lawOf(contained(englishTickets, translationTicket)), english, translated),
			containment(laws.lawOf(contained(translationTicket, englishTickets)), translated, english),
			containment(laws.lawOf(contained(urgentTickets, pageTicket)), urgent, paged),
			containment(laws.lawOf(contained(pageTicket, urgentTickets)), paged, urgent),
			containment(laws.lawOf(contained(watchedTickets, watchTicket)), watched, watching),
			containment(laws.lawOf(contained(watchTicket, watchedTickets)), watching, watched)
		]
	}
}

const mirrorShapesHost = (shape: MirrorShape): HostSchema => {
	switch (shape.kind) {
		case "batches":
			return batchesHost(shape)
		case "signals":
			return signalsHost(shape)
	}
}

const describeMirrors = (shape: MirrorShape): string => {
	switch (shape.kind) {
		case "batches":
			return `Batch selected by urgent = ${shape.selector}, projected (id, tenant) onto Note (batch, account)`
		case "signals":
			return "Ticket mirrored by a follow-up of each of its four selections"
	}
}

/** Three tickets; with the domain's levels, each selection by level admits one and refuses another. */
export const tickets = [
	"00000000-0000-4000-8000-000000000101",
	"00000000-0000-4000-8000-000000000102",
	"00000000-0000-4000-8000-000000000103"
] as const

export const mirrorShapes: Family<MirrorShape> = {
	label: "mirrors over a composite projection and selections of every kind",
	variants: Arr.flatMap(booleans, (mutable) =>
		Arr.append(
			Arr.map(booleans, (selector): MirrorShape => ({ kind: "batches", mutable, selector })),
			{ kind: "signals", mutable }
		)
	),
	describe: (shape) => `${describeMutable(shape.mutable)}, ${describeMirrors(shape)}`,
	traits: noTraits,
	/**
	 * Batch ids and tenants range over the same values, so a projection paired in the wrong order meets another batch.
	 */
	domains: {
		Batch: { tenant: [1, 2], id: [1, 2], urgent: [true, false] },
		Note: { id: [1, 2, 3, 4], account: [1, 2], batch: [1, 2], text: ["x", "y"] },
		Ticket: { id: tickets, level: [1, 2, 3], lang: ["en", "de"], priority: priorities },
		Escalation: { ticket: tickets },
		Translation: { ticket: tickets, text: ["x", "y"] },
		Page: { ticket: tickets },
		Watch: { ticket: tickets }
	},
	host: mirrorShapesHost,
	schema: (shape) => {
		switch (shape.kind) {
			case "batches":
				return batchesOf(shape)
			case "signals":
				return signalsOf(shape)
		}
	},
	connect: (shape, installed) => {
		const host = mirrorShapesHost(shape)
		switch (shape.kind) {
			case "batches":
				return Effect.flatMap(
					openWriter({ installed, schema: batchesOf(shape)(installed.declared) }),
					(o) => runtimeSession(host, o, batchesRelations)
				)
			case "signals":
				return Effect.flatMap(
					openWriter({ installed, schema: signalsOf(shape)(installed.declared) }),
					(o) => runtimeSession(host, o, signalsRelations)
				)
		}
	}
}
