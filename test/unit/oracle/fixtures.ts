import { Array as Arr } from "effect"
import { rosterCodec } from "#compiler/ir/codes.ts"
import { parsedName, wild } from "#test/support/kernel/naming.ts"
import { argumentsOf } from "#test/support/list.ts"
import { OracleChangeSet, type OracleSchema } from "#test/support/oracle/addwins.ts"

export const kinds = ["a", "b"] as const

/** The codes a fresh installation gives the roster of kinds: a is 0 and b is 1. */
const kindCodec = rosterCodec(
	parsedName("Kind"),
	Arr.map(kinds, (handle) => ({ kind: "live" as const, handle }))
)

/**
 * A small schema for the add-wins and delta oracle tests: keyed, pure-set, candidate-keyed and serial relations. The
 * add-wins oracle reports a law as an opaque label, so each is a name no production rule produces.
 */
export const schema: OracleSchema = {
	relations: [
		{
			name: "Task",
			heading: [
				{ name: "id", spec: { carrier: "int4" } },
				{ name: "account", spec: { carrier: "int4" } },
				{ name: "kind", spec: { carrier: "code", roster: kindCodec } }
			],
			primaryKey: { law: wild.lawId("task_pk"), fields: ["id"] },
			keys: [],
			projectedKeys: [],
			serial: []
		},
		{
			name: "Account",
			heading: [
				{ name: "id", spec: { carrier: "int4" } },
				{ name: "name", spec: { carrier: "text" } }
			],
			primaryKey: { law: wild.lawId("account_pk"), fields: ["id"] },
			keys: [{ law: wild.lawId("account_key_name"), fields: ["name"] }],
			projectedKeys: [],
			serial: []
		},
		{
			name: "Label",
			heading: [
				{ name: "account", spec: { carrier: "int4" } },
				{ name: "label", spec: { carrier: "text" } }
			],
			primaryKey: { law: wild.lawId("label_pk"), fields: ["account", "label"] },
			keys: [],
			projectedKeys: [],
			serial: []
		},
		{
			name: "Ticket",
			heading: [
				{ name: "id", spec: { carrier: "int8" } },
				{ name: "title", spec: { carrier: "text" } }
			],
			primaryKey: { law: wild.lawId("ticket_pk"), fields: ["id"] },
			keys: [{ law: wild.lawId("ticket_key_title"), fields: ["title"] }],
			serial: ["id"],
			projectedKeys: []
		}
	]
}

export const task = (
	id: number,
	account: number,
	kind: (typeof kinds)[number]
): { id: number; account: number; kind: "a" | "b" } => ({
	id,
	account,
	kind
})

/** One ChangeSet of strata, each stratum the given members in order: OracleChangeSet.sequence takes at least one. */
export const sequenceOf = <M>(
	layers: ReadonlyArray<ReadonlyArray<M>>,
	add: (changes: OracleChangeSet, member: M) => OracleChangeSet
): OracleChangeSet => {
	const [first, ...rest] = Arr.map(layers, (members) =>
		Arr.reduce(members, OracleChangeSet.empty(), add)
	)
	if (first === undefined) {
		throw new Error("a sequence of at least one stratum")
	}
	return OracleChangeSet.sequence(first, ...argumentsOf(rest))
}
