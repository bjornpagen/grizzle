import type {
	IsolationReason,
	RoleCertificate,
	RoleIsolation
} from "#compiler/analysis/isolation/certify.ts"

/**
 * The flawed certifiers the oracle must catch, each stated by hand over a counterexample shape (shapes.ts): the
 * certificates it would give and the flaw it stands for. The installation holds them as it holds generate's (race.ts
 * installShape), and generate's own must refuse every role the flaw passes.
 */

/** The shapes a sound certifier keeps SERIALIZABLE, each with the flaw that would pass it (shapes.ts). */
export type CounterShape =
	| "partial"
	| "copies"
	| "pointCopies"
	| "spanning"
	| "extended"
	| "single"
	| "listed"
	| "fk"
	| "deferred"
	| "carrier"
	| "fallback"

const readCommitted: RoleCertificate = { level: "readCommitted" }

const refused = (reason: IsolationReason): RoleCertificate => ({
	level: "serializable",
	reasons: [reason]
})

/** A writer of A and B: SERIALIZABLE, its m1 reading the absence of B, which the role writes. */
const writerAbsence: RoleCertificate = refused({
	condition: "absence",
	member: "m1",
	statement: 0,
	relation: "B",
	detail: "m1 reads the absence of B, which the role writes"
})

const app = (role: string, certificate: RoleCertificate): RoleIsolation => ({
	login: "app",
	role,
	certificate
})

/**
 * A counterexample shape's certificates under the flaw that passes it, which the oracle must catch with a run no serial
 * order explains, and the flaw's name.
 *
 * - partial: `join` reads every Child of a parent, a group many calls write under a parent that may be a no-change,
 *   after writing a Child that `join` reads: a pivot, passed by a seal admitting a part of a key.
 * - copies, pointCopies: each member writes the relation the other reads and then reads the other's, a pivot whose
 *   first write no read derives, passed by a per-statement derivation (B-01's condition 5, and seal (iii)).
 * - spanning: the readers shape's `spanning` reads A(v) and B(v), rows of two SERIALIZABLE writer calls that pivot through the absence of
 *   B, anomaly (b), passed by a certifier without condition 5c.
 * - extended: `start` reads a Doc's group in two statements while `extend` adds a Pool to a stored Doc in a call of its
 *   own, so the group is not written whole by one call, passed by a seal admitting it.
 * - single, listed, fk, deferred: NEGATION's four histories, each of which ARTIFACTS2-B-02 certifies. single: a READ
 *   COMMITTED point read of a row a SERIALIZABLE pivot writer wrote, exempt from 5c as sealed, which sees the pivot's
 *   later reader's write and misses the pivot's, an order only a serial order against real time explains. listed: a
 *   read of several keys sealed as a point. fk: a native foreign key's check, counted as no read, missing a row in
 *   flight. deferred: a foreign key PostgreSQL checks at COMMIT, a second snapshot of a member counted as one. carrier:
 *   a later statement's join through the call's input rows taken as a join with a row its own call wrote, which B-02
 *   admits where those rows arrive by a carrier read (stated `own`) and refuses here, where they arrive inline as a
 *   relation parameter's arrays: the race shows the rule unsound, not B-02's verdict on this form. fallback:
 *   NEGATION's B-03c negative, a W written from G's row where it holds k and from G's absence where it does not, read
 *   beside G by an observer: a probe neutral in one rule and negated in its sibling, judged per statement.
 */
/**
 * A flawed certifier over a counterexample shape: the flaw it stands for, every role's certificate under it, and the
 * roles it wrongly passes, which generate must keep SERIALIZABLE; a role it admits READ COMMITTED that a sound
 * certifier may admit too is no part of the flaw.
 */
export interface Flawed {
	readonly flaw: string
	readonly roles: ReadonlyArray<RoleIsolation>
	readonly passes: ReadonlyArray<string>
}

export const flawedCertificates = (shape: CounterShape): Flawed => {
	switch (shape) {
		case "partial":
			return {
				flaw: "a seal admitting a read of part of a key under a no-change-able parent",
				roles: [app("joiner", readCommitted)],
				passes: ["joiner"]
			}
		case "copies":
			return {
				flaw: "condition 5 without the pivot rule: each copy's statement derives its writes from its read",
				roles: [app("copier", readCommitted)],
				passes: ["copier"]
			}
		case "pointCopies":
			return {
				flaw: "seal (iii) with a per-statement derivation",
				roles: [app("copier", readCommitted)],
				passes: ["copier"]
			}
		case "spanning":
			return {
				flaw: "no condition 5c: a READ COMMITTED reader of two SERIALIZABLE writer calls that pivot",
				roles: [
					app("writer", writerAbsence),
					app("single", readCommitted),
					app("spanning", readCommitted)
				],
				passes: ["spanning", "single"]
			}
		case "extended":
			return {
				flaw: "a seal admitting a group another call extends",
				roles: [app("learner", readCommitted), app("importer", readCommitted)],
				passes: ["learner"]
			}
		case "single":
			return {
				flaw: "5c's exemption of a sealed read of a SERIALIZABLE pivot writer's rows (B-02)",
				roles: [
					app("writer", writerAbsence),
					app("single", readCommitted),
					app("spanning", readCommitted)
				],
				passes: ["single", "spanning"]
			}
		case "listed":
			return {
				flaw: "a read of several keys sealed as a point (B-02)",
				roles: [app("writer", writerAbsence), app("listed", readCommitted)],
				passes: ["listed"]
			}
		case "fk":
			return {
				flaw: "a native foreign key's check counted as no read (B-02)",
				roles: [app("writer", writerAbsence), app("checker", readCommitted)],
				passes: ["checker"]
			}
		case "deferred":
			return {
				flaw: "a foreign key checked at COMMIT, a second snapshot, counted as no read (B-02)",
				roles: [
					app("copier", readCommitted),
					app("adder", readCommitted),
					app("holder", readCommitted)
				],
				passes: ["copier"]
			}
		case "fallback":
			return {
				flaw: "a probe judged neutral across rules: one rule reads G positively, another its absence, and W's write follows either (B-03c checked per statement, not per core)",
				roles: [
					app("fallback", readCommitted),
					app("inserter", readCommitted),
					app("observer", readCommitted)
				],
				passes: ["fallback"]
			}
		case "carrier":
			return {
				flaw: "5b's own-row clause met by a join with the call's input rows, a carrier's read stated as its own (B-02's facts); B-02 refuses this compiled form, whose input travels inline as arrays",
				roles: [app("twice", readCommitted), app("grower", readCommitted)],
				passes: ["twice"]
			}
	}
}
