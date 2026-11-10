/**
 * What the isolation certifier reads of an installation (certify.ts): plain facts, drawn from the representation by
 * those who own it (each role's grant plan, the law model's discharge of each relation's laws, each compiled change
 * member's statements), so the certifier reads no compiled artifact and a search can draw the facts themselves.
 */
import type { TablePrivilege } from "#compiler/core/privilege.ts"

/**
 * One relation of the installation: whether every law over it is discharged natively (a CHECK, a primary key, a
 * UNIQUE, a foreign key or a roster domain), whether a rule over a query's trigger reads it, and its counted groups,
 * each by its key's fields: the members, under one value of the key, of a family whose immutable owner holds their
 * count (a counted, ordered or fin family), a set the count law fixes once the owner is written.
 */
export interface RelationFacts {
	readonly nativeLaws: boolean
	readonly ruleRead: boolean
	readonly countedGroups: ReadonlyArray<ReadonlyArray<string>>
}

/**
 * One relation a statement writes and how. `fresh` lists the keys, each by its fields, whose values in every row the
 * statement writes are fresh to the call: made by a default the call evaluates on a row it inserts (a uuidv7() id), or
 * copied from such a value within the call.
 */
export interface WriteFact {
	readonly relation: string
	readonly op: "insert" | "update" | "delete"
	readonly fresh: ReadonlyArray<ReadonlyArray<string>>
}

/**
 * One relation a statement reads and how:
 *
 * - `mode`: `positive` where the rows it finds feed the statement, `negated` where their absence does (an anti-join,
 *   NOT EXISTS, r.not), `counted` where their number or an aggregate over them does, and `arbiter` where it is
 *   grizzle's own key arbitration of the relation the statement writes (a key probe, EXISTS or NOT EXISTS at a key of
 *   it, or ON CONFLICT DO SELECT), which PostgreSQL's unique check decides whatever the call reads;
 * - `own`: whether the read can see only rows the call's own earlier statements wrote;
 * - `group`: the fields of a native key the read binds to one value that comes from the call (a parameter, a row the
 *   call wrote, or a group another such read found), or none where it reads the relation otherwise;
 * - `feeds`: whether rows the statement writes are derived from what it reads, or it only feeds what the call returns.
 *
 * A read of a derived relation is the reads of the stored relations its definition reads, each in the mode it has
 * there composed with the outer one.
 */
export interface ReadFact {
	readonly relation: string
	readonly mode: "positive" | "negated" | "counted" | "arbiter"
	readonly own: boolean
	readonly group: ReadonlyArray<string> | undefined
	readonly feeds: "write" | "readBack"
}

/** One statement of a change member's flight: what it writes and what it reads. */
export interface StatementFacts {
	readonly writes: ReadonlyArray<WriteFact>
	readonly reads: ReadonlyArray<ReadFact>
}

/** One change member of a role, by its name, with its statements in flight order. */
export interface MemberFacts {
	readonly name: string
	readonly statements: ReadonlyArray<StatementFacts>
}

/**
 * One role of one login: the privileges its grant plan holds, by relation, and its change members. Its read members
 * run SERIALIZABLE READ ONLY whatever its verdict, so no fact of theirs is read.
 */
export interface RoleFacts {
	readonly login: string
	readonly role: string
	readonly privileges: ReadonlyMap<string, ReadonlySet<TablePrivilege>>
	readonly members: ReadonlyArray<MemberFacts>
}

/** Every relation's facts by name, and every role of every login over the installation's base. */
export interface IsolationInput {
	readonly relations: ReadonlyMap<string, RelationFacts>
	readonly roles: ReadonlyArray<RoleFacts>
}
