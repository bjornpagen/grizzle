/**
 * Keys over generated fields, against PostgreSQL 19.
 *
 * README, "How a field is written": a key other than the primary key may hold a generated field. PostgreSQL computes
 * the field, and the statement that writes a row compares it there, at its term over the row's written fields, against
 * every other row it writes and every stored row: a write that would store two rows of one value at the key is
 * `refused` on the key, its witness the key's values as PostgreSQL stores them; a deletion compares only at
 * keys whose fields it states; a new owner's nested members meet such a key at its index, refused on the key with an
 * `unreported` witness, and a member a put appends to a stored owner meets it at its gate's probe of the stored members
 * (write/family/statements.ts candidateGate), refused on the key, witnessed by the appended row's key (README "Errors
 * and outcomes", Witness).
 *
 * Keys holds a typed map key, MapKey (mapping, text), mutable, primary key both, whose `value` and `negative`
 * PostgreSQL generates from its text, the integer it spells and whether it is spelled with a minus, keyed by (mapping,
 * value, negative): two spellings of one value in one mapping, "1" and "01", are one key, and "0" and "-0" are two. Use
 * names a typed key by a containment into it. Tag (id, text), mutable, keeps at most one tag of each positive value, a
 * key over a selected side whose term and selection read its generated `value`. Mapping, mutable, owns an ordered
 * family of Entry rows, mutable, primary key (mapping, text), each a typed key of its own, keyed by (mapping, value,
 * negative), written nested under a new mapping or appended to a stored one by a put of Entry: a put at a key the
 * mapping stores repeats its entry exactly, and any other takes the next slot, its gate (write/family/statements.ts
 * candidateGate) probing the stored entries under the statement's snapshot at the appended row's generated fields. Each
 * mutable relation sits in its unit: a mapping's (MapKey, Entry) by its id, and the rest by their own id.
 *
 * Each case stores a lawful state, then applies one stratum of up to three writes: inserts, puts and deletes of MapKey
 * and Tag from an array or a query over a relation parameter, inserts of Use, inserts of new mappings with their
 * entries nested, and appends of entries to the stored mapping, near its entries: one of them, another spelling of one,
 * or a fresh text. The stratum is the one member of a served workload of its own, its array writes of one op and one
 * relation one array member whose call's facts are their rows. Texts are drawn from three values, both signs and two
 * paddings, so writes meet stored rows and each other at every key.
 *
 * The oracle is the law model (test/support/laws/model.ts): the add-wins transition of the stratum over the stored
 * state, its facts' generated values computed from their texts apart from grizzle, an append's rows at keys its
 * mapping does not store at its slots after the stored ones in key order, put with the mapping's new count (README
 * "Writing a family": an append takes the slots after the last; write/family/additions.ts), and every law's violation
 * over the result, a key's naming its violators by the key's own fields; two facts a stratum deletes at one key are no
 * refusal, since a deletion names its fact exactly (README "A relation's rows are a set"), so at most one of them is
 * stored and the other changes nothing (model.ts expect). A refused write names a violated law, every immediate one
 * before a deferred one, with a witness naming one of its violators, or `unreported` for a containment and for the
 * entry key where a new mapping's nested entries break it, and changes nothing; any other write stores exactly the
 * model's state, accepted where it changed a row and unchanged otherwise.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Effect, Formatter } from "effect"
import {
	type Feature,
	keyCases,
	keysCase,
	keysTemplate
} from "#test/pg/write/generated-key/generated-key.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A write meets a key over generated fields at the values PostgreSQL stores, inside it and against every stored row,
 * each case on a clone of Keys of its own, opening its own Db.
 *
 * Its pre-conversion budget: runs 80, coverage cases 120 (test/pg/write/generated-key/generated-key.test.ts at d43931162).
 * The search's case of two deletions at one tag's id beside two additions at another's goes: it was the oracles' red
 * alone (c6646141f: three oracles judged a deletion at a key, which the engine has not since 5728de93), and the
 * situation it reached, two deletions at one key, is aimed at (deletedTwiceGen).
 */
export const aWriteMeetsAKeyOverGeneratedFieldsAtTheValuesPostgreSQLStoresInsideItAndAgainstEveryStoredRow =
	property.explore(keyCases, {
		needs: { keys: Substrate.fresh(keysTemplate) },
		situations: [
			"typed key refused against a stored row",
			"typed key refused within the write",
			"typed key refused for a query's row",
			"typed key refused for a put",
			"positive tag refused",
			"entry key refused within the write",
			"entry key refused against a stored entry spelled with a minus",
			"an entry appended to a stored mapping",
			"a reference refused",
			"two signs of zero held apart",
			"a typed key freed and taken again",
			"two deletions at one key",
			"accepted",
			"unchanged"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check:
			({ keys }, c: Case<Feature>) =>
			(k) =>
				Effect.scoped(
					Effect.flatMap(keys, (taken) =>
						Effect.provideService(keysCase(taken, k, c), Substrate, taken.substrate)
					)
				),
		oracle: {
			kind: "specification",
			name: "the law model's add-wins transition over facts whose generated fields the model computes from their texts"
		},
		show: Formatter.format,
		budget: { runs: 80, steered: 120 },
		kept: [
			{
				token: ReplayToken(
					"test/pg/write/generated-key/generated-key.test.ts#aWriteMeetsAKeyOverGeneratedFieldsAtTheValuesPostgreSQLStoresInsideItAndAgainstEveryStoredRow:-:1.0.0.0.1.0.0.0.0.0.0.1.0.0.0.1.1.0"
				),
				reason:
					"qti-pie's typed map key: two spellings of one integer in one mapping, the second against the stored first",
				since: "2026-11-07"
			}
		],
		kills: []
	})
