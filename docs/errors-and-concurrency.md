# Errors and concurrency reference

The reference grizzle's source and tests cite by heading (test/unit/dev/references.test.ts). A claim here that the code contradicts is a bug of this page, fixed here.

## Errors and outcomes

A call answers its value or fails with one `CallError`, the same in process and over HTTP: `{ _tag, retry, message }`
and the members its tag holds. `_tag` is one of a closed set, so `Effect.catchTag` selects it, `retry` says whether the
same call may succeed run again
(`"safe"`: nothing committed, and the failure was not the call's own) or meets the same answer (`"never"`), and
`message` is the failure's own words, the server's report where the database refused. A broken rule is a refusal of
the write, `refused`, which names the rules it broke and a row that breaks them.

**Outcomes** of a ChangeSet member's `once`, plain values a test of your code writes as they are:

- **`accepted`**: `counts`, each written table's `added`, `deleted` and `put`, and `reads`, the read-backs.
- **`unchanged`**: `reads`, the read-backs; nothing was written.

**Refusals** of a write, each a `CallError` whose `retry` is `"never"`:

- **`refused`**: `refused`, the broken rules, and `witness`. Each entry of `refused.laws` is `{ law, id,
  by }`: the rule as your schema states it, which you match directly, `law` being
  `{ kind: "check", relation: "Grant", name: "WithinGrant" }`; its identity, the one the snapshot records; and the
  installed object that refused it, a table's `constraint` or a `domain`'s by table or domain and name, a write
  `statement`, or a generated column's `notNull`.
- **`outsideWorld`**: `relation`, the role's table a row cannot belong to.

`refused.laws` is never empty where it stands: every refusal but an `above` one whose `own` is `none` or `unjudged`,
which names its laws in `refused.above` alone. `every`, `first` and `some` name only the laws of your Db's own level and the levels
below it, and a table's checks are theirs, whatever check a level above installs on the table. `refused.kind` says how
grizzle decided them:

- **`every`**: each rule is decided broken. A row check refusing a row you stated names every rule of that table's
  checks the row breaks as the write fills it (counts, ends, indexes and copies at the values grizzle draws), once
  each, in canonical order (primary keys, then statements, as the snapshot lists them, however you wrote the schema),
  whichever check PostgreSQL tried first. A domain refusing a value of a row you stated names the rule of each field of
  that row it types whose value it refuses: a pattern rule names its relation and field, so of two fields of one
  pattern it names the one you broke, or both. Any other refusal names the one rule its constraint states.
- **`some`**: one PostgreSQL object that discharges two rules or more refused the write, and nothing grizzle holds says
  which: at least one is broken, maybe more, each named once, in the order of their identities, however you wrote the
  schema. The object is a family's foreign key, which carries every containment merged into it, a key's index that
  serves several rules (a counted family's numbering under a count's fold), or a domain serving every field of one
  pattern or of one domain's definition, where grizzle
  judges no row you stated whole (a row a query computes, or a value it cannot evaluate on the host); a domain names
  the rules of the fields it types in the tables the statement writes.
- **`first`**: a row check refused a row grizzle cannot judge: one only PostgreSQL computes, which no ChangeSet states
  (a query's, or one grizzle fills on a family), a row you stated whose table has a check reading a value the host
  does not hold, such as a count or an end a put keeps from the stored row, or one of two rows you stated that grizzle
  cannot tell apart (see the witness below). It names the rules of the check PostgreSQL tried first, never more.
  PostgreSQL orders a table's checks by installed name, which no version of grizzle keeps, so the row may break others
  too, and another version may name another.
- **`above`**: PostgreSQL refused the write by an object of a level above your Db's, and `refused.above` names every
  law of those levels it serves, each `{ kind: "above", level, law }` as that level states it, which your process holds
  no predicate of: one where the object serves one, and where it serves several, such as a key's index under a count's
  fold and its family's counted law, at least one of them broken, as `some` says of your own. Nothing is said of any
  other law above. `refused.own` is what grizzle finds of your own levels' checks on the rows of that table the refused
  statement states: `every`, `refused.laws`, every rule of them the first stated row breaking one breaks, as `every`
  would name them were the level's check not installed, that row the witness; `none`, every row the statement writes
  is one you stated and holds them all, the witness `unreported`; `unjudged`, nothing is said of them, the witness
  `unreported`: a refusal at COMMIT, by a foreign key or a rule over a query of the level above, or a row grizzle
  cannot judge. Only `every` carries `refused.laws`.

**Witness**: `{ kind: "key", relation, values }`, the key of one row that breaks the rule and never another column;
`{ kind: "drawn", relation, values, drawn }`, that key where the database supplies a field of it as its statement
writes the row, `values` the key's other fields and `drawn` each such field by what supplies it, never a value guessed
for it: `"clock"`, an instant its clock stamps or a field the call computes from its reading of the clock
(transaction_timestamp, one value a call); `"place"`, a place its insert stamps; `"call"`, a field the call computes
by a term grizzle does not evaluate, which the statement does; `{ kind: "unreported" }` or `{ kind: "unreproduced" }`.
A field the call computes (`ChangeSet.insertAllComputed`) is in the key at the value its term takes over the call's
parameters wherever grizzle evaluates the term, once a call, as the statement fills it. Every insert, a family's members and a tree's nodes included, checks each key and unique of its
table in the statement that writes the rows: a declared key, a key over a side, a family's (owner, index) and a tree's
(root, start), against the stored rows and between the rows the statement writes. That is one index lookup per row and
key beside PostgreSQL's own check, the same cost on every insert. So a key (over a table or a side of one) that a row you
stated breaks, by two rows you submitted or by a stored row inside or outside your role's view, is grizzle's own
finding, witnessed by that row's values at the key's fields, an index or a start at the value grizzle drew and a
generated field at the value PostgreSQL computes. A row check, domain, pattern or generated field is refused by
PostgreSQL, which states the row only in its message, never read by grizzle: grizzle judges on the host the rows your
ChangeSet states for the refused statement (an inserted or put row, a query entry's row, a nested member) as the write
fills them, and the witness is the key of the first that breaks the rule. Either key is in the fields you wrote it in.
A foreign key grizzle installs deferred, such as a family's predecessor key, which PostgreSQL checks at COMMIT, refuses
the write once every statement ran, and PostgreSQL states the row only in its message. Only
then does grizzle send a second flight: the write's statements again, then that key's query for the least row, by its
primary key, that it leaves matching nothing, in a transaction that ends in ROLLBACK. The witness is that row's
primary key. The second flight is a write like the first, with the same admission, taking the same locks in the same
order, and it leaves nothing: no row, no drawn value, nothing a live query sees. A write that commits sends nothing
more. Where another write committed between the two flights and left no such row, the witness is
`{ kind: "unreproduced" }`, never a guess. grizzle sends the second flight only for a key on a table the write changes,
where your role writes that table and the key's target through whole entries. Otherwise the witness is `unreported`.
That covers a query entry, as PostgreSQL itself states the key to no role that cannot read it, and a key a
delete from its target breaks on a table the write leaves alone. A drawn key, such as an instant from the database clock, is the one the
second flight drew. The witness is `unreported` for a foreign key PostgreSQL checks at the statement, and where no
row you stated breaks the rule: a row only PostgreSQL computes,
a query's, or a rule reading a value the host does not hold or over what the host does not evaluate. A family member you put is such a row: its running values are PostgreSQL's, folded again in the
write's own statement from the stored members before it, and its counts and ends stay as stored, so grizzle holds none
of them, and a rule only they break is refused with the witness `unreported`. A family's owner that you insert and the
write never reads, such as one with no members in the ChangeSet or an ordered one, could be new or a stored one you
insert again, which the write leaves as it is: grizzle names it only where it is the one row of the refused statement
that can break the rule, and where two such rows can, the witness is `unreported`.

**The parse, then PostgreSQL.** grizzle checks nothing on the host that PostgreSQL enforces. A value is parsed once, as
its field's or parameter's type exactly ([Tables and types](schema.md#tables-and-types)), and a value no such type holds is an
`EncodingFailure` before any SQL. Every law over the values is PostgreSQL's: keys, containments, checks, domains,
patterns and rosters, each refusal classified into the typed outcome or error below, one round trip in, never an
earlier refusal of the host's. The one rule the host judges is a relation's rows as a set: two rows one stratum adds at
one key that differ elsewhere are `refused` on that key before any SQL, since the input is no set of its facts.

**Domains and patterns.** The encoder checks only the base type, so a value its domain or pattern refuses is refused
by its domain's CHECK as the statement casts it, before the row's constraints and row-level security. A parameter's
value is cast as PostgreSQL binds it, to its domain or to its own pattern domain, one per parameter and
pattern, which `grizzle generate` installs for every domain and every pattern a served parameter names: a value
outside them is refused
there, before the statement reads a row. A write binds every such parameter in the first statement each call sends,
and sends no statement for it: each parameter is an entry no query reads, leading every statement before the first
one the write sends wherever the parameter may hold a refused value (a scalar's in every call, a relation parameter's
where it holds a fact) and that one, its placeholders the statement's first; where no statement is sent so, the
write's first statement is sent there besides, writing nothing. So the refusal comes before any other statement of the
write runs, whichever stratum reads the parameter, and no law a stratum breaks answers first. A read binds every one
in its statement, those its query leaves unread too (a rule under the constant false `r.or([])`), so a call is refused
for the parameters it declares, never only for those its logic reads. A
domain's refusal of a parameter is `refused` on the domain's law, its
witness `unreported`, a write's and a read's (`LawRejected`) alike; a pattern's refusal of a parameter, a
`str.bytes` bound's among them, is `paramRejected` (`ParamRejected`), its `param` where: `{ kind: "scalar", name }`
for a scalar parameter, `{ kind: "field", name, field }` for a field of a relation parameter's facts. A caller names
the field it refused from that data, never from the message, which spells the place `<parameter>.<field>` with its
pattern: a parameter's name may hold a `.`, so that text can name two places. The outcome names
the domain's rule or the field's pattern rule. Fields of one pattern share a domain, as do fields whose patterns
grizzle proves match the same texts, and PostgreSQL reports the domain, never the column, so grizzle judges the row on
the host to name the field, its rule spelled as that field spells its patterns:
`{ kind: "pattern", relation: "Item", field: "slug", patterns: [{ source: "^[a-z-]{1,64}$", flags: "u" }] }`. A
`str.and` field's rule lists every pattern, in order: its domain is one CHECK, which PostgreSQL refuses as a whole, so
no outcome tells which pattern a value missed. A value PostgreSQL
generates into a refined field, or grizzle fills into a fold's accumulator or end, is refused the same way; its witness
is `unreported` where grizzle does not hold the value: where only a refill writes the row, such as a stored owner whose
family the write appends to, and at a family member you put, whose running values PostgreSQL folds again from the
stored members.

<details>
<summary>Every rule an outcome can name</summary>

| `law.kind`   | Its fields                                                                                                      |
| ------------ | --------------------------------------------------------------------------------------------------------------- |
| `primaryKey` | `relation`, `fields` (a range field makes it a no-overlap key)                                                  |
| `key`        | `side`: a key statement, a candidate key of its relation when its side reads every row and its terms are fields |
| `check`      | `relation`, `name`                                                                                              |
| `contained`  | `from`, `to`: a containment, foreign keys included; a `mirrors` is two containments                              |
| `coverage`   | `from`, `to`: a containment whose sides pair a range field                                                      |
| `family`     | `order` (`"ordered"` or `"counted"`), `member` (a side), `slots` (`{ owner, count }`)                           |
| `tree`       | `member`, `slots`, `root` (the root fields, a list)                                                             |
| `fold`       | `family` (its slots), `monoid`, `step` and `end` (sides)                                                        |
| `contract`   | `contract`                                                                                                      |
| `pattern`    | `relation`, `field`, `patterns`: each `{ source, flags }` as that field spells it, one rule per field           |
| `variant`    | `relation`, `field`, `variant`: a variant field's value is of one arm, each field of its type and its arm's check holding, one rule per field |
| `generated`  | `relation`, `field`: a generated field whose term has no value at a row, a closed read at a key its relation lacks |
| `above`      | `level`, `law`: a law of a level above the Db's, as that level states it, only ever in `refused.above` of an `above` refusal |

A side is `{ relation, terms, selection }`. `terms` are in the order the rule pairs them, each `{ kind: "field", field }`
or `{ kind: "pred", field }`.
`selection` is `{ conjuncts }`, row predicates in canonical form (a literal second, `gt` and `ge` between two terms as
`lt` and `le`, `eq` and `ne` with their terms in canonical order, an IN list's values a set, and an IN list of one value
the `eq` with it) and canonical order; a side that reads every row has none.

</details>

Every rule carries its catalog entry, `entry: { kind, name, source }`, the same shape whatever its kind and no part of
what it is: `sameLaw` reads it, but its identity, the schema's fingerprint and the installation do not, so a changed entry
drafts no migration and only rewrites the snapshot's record and the served files. Declare one with
`law({ name, source }, declaration)`, any two nonempty texts (a catalog's name for the rule and the specification
section it reads, say), at the declaration the rule comes from: a statement, for every rule it states; a relation, for
its primary key's rule; a `generated(type, term)` field, for its generated rule; a `str.regex`, `str.and` or `str.bytes`
type, for the pattern rule of every stored field it types, one entry for the type whatever field it types, a drawn,
accumulated or generated field of it included; and a domain, grizzle's own `natural` among them, for its rule. `law(...)` returns a copy of the declaration carrying the entry and leaves the declaration as it
was, so declare the copy where you use it. Every rule so declared carries `{ kind: "declared", name, source }`, in
`lawsOf`, in `lawsByStatement` and in every refusal that names it, a refusal by a rule of a level above included. A rule
nothing declares one for carries `{ kind: "derived", name, source }`: a check and a domain by their own names, any
other rule by its shape as grizzle names it (`key Grant(id)`, `Grant(owner) in Owner(id)`), and its source the statement
that states it, as grizzle spells it. One rule takes one entry: two declarations of it that declare two entries are
refused as `MalformedDescription`, and so is `law(...)` of a `mutable` or `race`, which states no rule, of a value that
declares none, or of a declaration already given one.

`lawsOf(schema)`, from `@bjornpagen/grizzle/compile` as `lawsByStatement`, `constraintNamesOf` and `rowEvaluator` are,
lists every rule the schema states, each once, as `{ law, id }`: `law` exactly as an outcome names
it, its entry included, so every rule an outcome over the schema names is one of them, and `id` the one a refusal names it by, a refused
law's own. Name the rules you handle by their ids once, then read a refusal's `laws` by `id`, with no search and no
table of ids of your own. In order, however you declared the schema: each table's primary key, by table
name; the rules of the schema's statements in canonical order, one for a key, check, containment, family, tree or fold,
two containments for a mirrors, none for `mutable`; each domain's, by
name; then each stored field's pattern rule and each generated field's rule, by table name and each table's fields in
declared order. A rule two statements state, such as a key over a table's primary key, is listed once. A pattern every
text matches, such as `"^.*$"` under `"su"`, states no rule: grizzle drops it, and the column is plain text. Neither
does a domain's pattern, whose refusal names the domain, nor a closed relation's, whose rows the schema fixes. A
domain only a login's context field names is the login's, never the schema's: PostgreSQL checks a claim against it where a
statement reads it, and no write is refused by it. Each call compiles the rules, so call it once and keep the list.

`lawsByStatement(schema)` compiles the rules once and gives a lookup: bind it once,
`const lawsOfStatement = lawsByStatement(schema)`, then `lawsOfStatement(statement)` lists the rules that statement
states, each a `law` of `lawsOf(schema)`'s list, in its order: two containments for a mirrors, none for `mutable`, and
a rule two statements state is each one's. A statement is its canonical form, so
an equal statement built again is the same one, at any level. A lookup compiles nothing, and throws `CompileError` for a
statement no level of the schema states.

`sameLaw(a, b)` says whether two rules are one: `refused.laws.some((law) => sameLaw(law, rule))` says whether a
refusal names `rule`, and a handler for each `law` of `lawsOf(schema)` handles every refusal.
`constraintNamesOf(schema)` compiles the rules once and gives a lookup of the name PostgreSQL holds each check under:
bind it once, `const constraintNameOf = constraintNamesOf(Credits)`, then
`constraintNameOf({ kind: "check", relation: "Grant", name: "WithinGrant" })` is `"within_grant"`, and a row check
declared as `E1_derived` is `"e_1_derived"`. A check over a stored derived relation is its table's CHECK, named as
declared. A check over a live derived relation is held by a trigger on each table its query reads, named from its rule (`__<readable part>_<digest>`), since its own name could be a table's check's. A direct
writer's refusal by the check names it, so take it from grizzle and never spell it. A lookup compiles nothing, and
throws `CompileError` for a rule that is no check of the schema.

`rowEvaluator(schema)` compiles the schema once and gives the host's evaluation of a row: what PostgreSQL computes of
it, by the one evaluator grizzle judges a refused write's rows by. Bind it once,
`const evaluate = rowEvaluator(Accounts)`, a `Result` whose failure is the schema's `CompileError`: every `Result`
grizzle answers, here and in `codecText`, `insertPreview` and `indexesOf`, is Effect's (`effect/Result`), read with
`Result.isSuccess`, `Result.match` or `Effect.fromResult`. A row is admitted
once, `evaluate.admit(Account, row)`, then evaluated as a row of any source of its relation, `evaluate(Account,
admitted)` or `evaluate(select(Account, (a) => a.gt(a.units, 3)), admitted)` for a selection. A source is any relation of
the schema, stored, derived or closed, a roster among the closed ones, or a selection of one. The row is typed off the
relation: every field but the generated ones, each its codec's value, so a domain's value is its host's, `toUnits(5)`,
and an instant, the database's or a stored one, the `bigint` it is: an evaluation writes nothing, so a row it judges
holds any instant, and an admitted row's instant is no `Instant`, which only a read delivers.
PostgreSQL reads each value as its column's type and holds it to its domain before anything else, which a mint does
not check, and so does admit: `{ _tag: "ValueRefused", field, fault }`, a field whose value its type's input function
refuses (an integer that is none or past its type's range, a text holding NUL, a date no calendar holds, a numeric past
its typmod), by the codec's fault, the word `codecText` refuses the value by; `{ _tag: "DomainRefused", field }`, a
field a domain refuses, its own or its pattern's; or the `AdmittedRow`, which only admit makes, `admitted.row` the
row as stated. Its domains judged once, an admitted row is evaluated as `{ generated,
checks, selected }`, each item its own `Result`, computed where it is first read and kept on the admitted row, so every
source of the relation over it shares the generated values and verdicts it reads:

- `generated`: each generated field's value, by name, or `null` where PostgreSQL computes NULL, as a closed read at a
  key no row holds does, which the column's NOT NULL refuses;
- `checks`: each row check of the relation, by name, `"holds"` or `"breaks"`, as the database judges it, NULL breaking
  it: a table's by its `CHECK ((p) IS TRUE)`, a derived relation's by its rule's violation query, `WHERE (p) IS NOT
  TRUE` over the derived row;
- `selected`: whether the source keeps the row, its predicate true, as `WHERE` reads it; a relation keeps every row,
  being `select(R, TRUE)`.

A closed relation's row is evaluated as any other: its facts are rows of its heading, and a selection of it is a side a
rule reads, by its fields' literals in a containment into it and by any predicate in one between closed relations. It
has no generated field, since `closed.relation` refuses a field grizzle writes, and no check, since the schema refuses a
row check over facts it fixes, so its evaluation is its domains and `selected`: each of `PlanLimits.rows`, admitted and
evaluated as a row of `PlanLimits`, gives no generated value, no verdict, and `selected` true.

An item whose expression the host does not lower or evaluate, such as float arithmetic in a derived relation's check,
is `{ _tag: "Unevaluated", why }`, the other items keeping theirs. Nothing is thrown, and nothing stands in for a value. Each source is read where it is first evaluated,
and once.

`codecText(field)` reads a field descriptor once and gives the one text of each value of its type, a function of the
value alone: bind `const startText = codecText(Node.fields.start)`, then `startText(row.start)` is a `Result` of the
value's text, or the `CodecFault` of a value its type does not admit. Two values have one text exactly when they are
one value: numeric 1.0 and 1.00 are one, as NaN and NaN are, and a float's -0 and +0, equal under PostgreSQL's
equality, are two, `-0` and `0`. A closed id's text
is its handle, its host value, and a set's its handles in its roster's declared order as a JSON array: a code is a
storage detail of one installation, so a text is the same in every installation, and readable in a message. Every other
carrier's is the codec's own, which PostgreSQL's input function reads as the value: an integer's digits, a numeric's
`numeric_out` text, a double's shortest round-trip decimal, `true` or `false`, a date's ISO 8601 text, a text itself.
Key a set or a map of rows by these texts, and never by `String()` of a host value. A bytea field is a type error.

`rowText(query)` reads a query's decoder once and gives the one text of each row it delivers: bind
`const text = rowText(lessons)`, a `Result` whose failure is the `CompileError` of a query no builder can decode (one
rebuilt from its Description), then `text(row)` is a `Result` of the row's text, or the `CodecFault` of a value its type
does not admit. Each column's value is written as `codecText` writes it, a set's handles in declared order as a list, a
bytea value as its SHA-256 digest, and each attachment's children in delivered order, an Option's none or one; every
piece is framed by its length and every list by its count, with no JSON, so two rows have one text exactly where they
are one row, value for value under each type's equality, attachments member by member. A digest of it keys a found row
by its content ([Records of a query](schema.md#records-of-a-query)).

`insertPreview(schema)` gives the rows `ChangeSet.empty(schema).insertAll(rows)` stores as the first write of an
installation holding no row, closed relations aside, with nothing sent: bind `const preview = insertPreview(BoxOffice)`,
a `Result` whose failure is the schema's `CompileError`, then call `preview(rows)`. `rows` is insertAll's record over
every top-level relation: a preview states every value, and PostgreSQL draws nothing in it. Binding compiles the
schema's law model, the one `rowEvaluator` and `lawsOf` read of the same schema value, and nothing else: each call
compiles, the first time a call writes them, the insert of the families its rows write (the relations it states rows
of, every relation a write of them writes, their families' owners and members, and the clock each instant they stamp by
reference is stamped from), the host half of the compile the write takes, no statement built, kept for every later call
that writes the same families. So a call's compile is the insert of what it previews, whatever else the schema holds.
Each call is the write's own binding of its rows, the one every application of it runs before any SQL, so every count,
index, interval, fold end and copy the write draws, a fresh counted group's whole among them, is the preview's. It is a
`Result` of `PreviewRows<S>`: every writable relation by name, an empty array where the write stores none of it, each
row every field the relation stores but those PostgreSQL generates, each its codec's host value, a closed id its handle,
so `rowEvaluator(schema)` admits and evaluates a row as it is, its generated fields and its checks in one place. A
relation's rows are a set, each once, in no order that means anything. Or it is the refusal the write meets before any
SQL, a tagged value, never thrown:

- `InputRefused`: `failure`, the `EncodingFailure` of a value outside its type or a fact of another shape, or the `MessageBound` or `LiteralBound` of an input past what one statement carries, which
  the write meets as `input`;
- `KeyConflict`: two rows of one relation at one key that differ, `law` the key's and `witness` its values, as the
  write's `refused` names them;
- `GeneratedNull`: a generated field with no value at a row a family's fill reads it of, `law` the field's and
  `witness` the row's key;
- `OwnerAbsent`: a counted family's member whose owner the call does not insert, which no installation holding no row
  stores, `law` the family's as `lawsOf` lists it, so `sameLaw` reads it.
- `Uncompiled`: `error`, the `CompileError` the insert of the call's families refuses as it compiles, a relation no
  insert can write, such as an instant no one clock stamps; each call that writes those families meets it.

A law PostgreSQL judges once the statements run, a check, a containment, a rule over a query, a generated field's NOT
NULL where no fill reads it, refuses no preview: its rows are the rows the write would send, which `rowEvaluator` and
the laws judge. A code is a storage detail of one installation: a preview binds under its rosters' declared order and
gives handles alone, so its rows are the same whatever codes an installation holds
(test/pg/write/preview/preview.test.ts holds them to a fresh installation's and to one migrated past a dropped handle).

**Errors**: `DbLayer.make` and `Db.open` fail with `OpenError` in the Effect's error channel; every call of a member
fails with its `CallError`, by its `_tag`:

| `_tag`          | `retry` | What happened                                                                                                   |
| --------------- | ------- | --------------------------------------------------------------------------------------------------------------- |
| `input`         | `never` | a parameter, a fact or a window the member's codecs or input boundary refuse, past a bound of its transport included |
| `paramRejected` | `never` | PostgreSQL refused a parameter's value outside its pattern, a `str.bytes` bound included, as it bound it (`param`) |
| `tokenRefused`  | `never` | no token where the role declares a token's context, a token `verify` refuses, or claims that do not decode      |
| `tokenExpired`  | `safe`  | the token expired, before the call or while it streamed                                                         |
| `refused`       | `never` | the schema's laws refused the write (`refused`, `witness`)                                                      |
| `outsideWorld`  | `never` | a row the write adds lies outside the written world relation (`relation`)                                       |
| `transient`     | `safe`  | the attempt changed nothing, refused by a concurrent transaction (`reason`)                                     |
| `credentialRefused` | `never` | no session could be had: its connection was not authenticated, either way (`reason`)                       |
| `unavailable`   | `safe`  | no session could be had for now: the network, the server, a released layer, `verify`'s verifier (`reason`)     |
| `transport`     | `safe`  | a connection broke before the call's end: a read's, which commits nothing, or a write's before COMMIT was sent |
| `stale`         | `never` | the database is not at the Db's snapshot ([Deploying](operations.md#deploying)), so the call ran nothing                     |
| `commitUnknown` | `never` | a write's COMMIT was sent and no answer came: it may have committed                                             |
| `failed`        | `never` | the server refused a statement, or answered rows grizzle cannot read                                            |
| `route`         | `never` | over HTTP, no served member at the path                                                                         |

- **`OpenError`**'s `reason` is what happened, a tagged value, so `Effect.catchReason`, `catchReasons` and
  `unwrapReason` reach it; `stage` follows from the reason, and `message` is a sentence naming it. Every error and
  reason class is exported as a value, the class grizzle builds it with, so a test of your code builds the exact value
  an open fails with, never a cast. Your `password` Effect fails with `CredentialError`, and your `verify` with
  `TokenRefused` where its verifier refuses the token, or `VerifierUnavailable` where none could judge it now (the
  verifier's service down or unreachable): `OpenError`'s `retry` is `safe` for that one reason and `never` for every
  other, and over HTTP the call's error is `unavailable`, reason `verifierUnavailable`, retried safely, so an outage of
  your verifier never reads as a refused token.
- **`transient`**: its `reason` is `SerializationFailure` (40001), `Deadlock` (40P01), or a concurrent transaction's
  work the statement met (`PutTargetConflict`, `SpanKeyChange`, `UnseenOccupant`). grizzle never
  runs a call again: running it again is the caller's (a den step runs again past one). Each refusal changed nothing
  and came of another transaction's committed work, and PostgreSQL's serializable implementation cancels an attempt
  only once a transaction it conflicts with has committed, "such that an immediate retry will not fail again on
  conflicts with the same transactions" (src/backend/storage/lmgr/README-SSI), so a call run again starts past work
  that committed. A deadline is yours to put on the call, `Effect.timeout`.
- **`commitUnknown`**: COMMIT was sent whole and no answer came, so the change may have committed. Read back before
  running it again. A write the socket failed before COMMIT's last byte left the process is `transport` instead: COMMIT
  never reached the server.
- **`credentialRefused`**: no session could be had, and the same call meets the same refusal until the connection's
  configuration changes, so it is never to retry. Its `reason`, a string:
  - `passwordFailed`: your `password` Effect failed (`CredentialError`), so no password was offered;
  - `passwordRefused`: the server refused the password, SQLSTATE 28P01;
  - `loginRefused`: the server refused the login with any other SQLSTATE of class 28, 28000 among them: no
    `pg_hba.conf` entry admits it, or its role does not exist or may not log in;
  - `tlsUnverified`: TLS did not come up verified: the server's certificate does not chain to `ca` or does not name
    the host, the handshake failed with a code no system error has, or the server offers no TLS or answered the
    SSLRequest with neither yes nor no;
  - `driverRefused`: pg ended the startup itself, with no SQLSTATE and no code: a SCRAM exchange whose server proof
    does not verify, a mechanism it does not support, a server that asks a password of a role given none; or the
    server asked for a password over its Unix socket, where grizzle sends none (`PasswordAsked`).
- **`unavailable`**: no session could be had for now, for a cause that may pass. Its `reason` is `{ _tag }`, a cause
  of a closed set read off the SQLSTATE or the socket's code, never off the message:
  - `connectionRefused`: nothing accepted the connection at its address, ECONNREFUSED or ENOENT (a Unix socket's file
    that is not there);
  - `hostUnreachable`: no route reaches the host, EHOSTUNREACH, ENETUNREACH, EHOSTDOWN or ENETDOWN;
  - `hostUnresolved`: the host's name did not resolve, ENOTFOUND or EAI_AGAIN;
  - `timedOut`: the operating system gave up on the connection, ETIMEDOUT;
  - `connectionClosed`: the connection closed before the session was ready, with no ErrorResponse
    (`ConnectionClosed`), ECONNRESET, EPIPE or ECONNABORTED, a TLS handshake's among them;
  - `serverDown`: 57P01 (admin_shutdown), 57P02 (crash_shutdown) or 57P03 (cannot_connect_now: starting, recovering
    or stopping);
  - `tooManyConnections`: 53300, the server's or the role's connection limit;
  - `layerReleased`: the `DbLayer` the Db was opened under, or a live read registered on, was released;
  - `sessionLost`: a session of a live read's source, its listener's or its leader's, was lost with no report of the
    server's (one the server ended with a report reads by its SQLSTATE, 57P01 as `serverDown`), its connection having
    ended; pg's own refusal of a query on a connection still standing is `failed`, never a lost session;
  - `slotInvalidated`: the installation's replication slot was invalidated: its live leader makes it again;
  - `leaderFailed`: the live leader's candidacy failed otherwise: an answer, a message or a secret it cannot read, a
    statement past a bound, or a replication stream the server ended;
  - `{ _tag: "otherSqlstate", sqlstate }`: the server refused with any other SQLSTATE, such as 3D000 for a database
    that does not exist;
  - `{ _tag: "otherSocketCode", code }`: the socket failed with any other code, its errno's name for a system error.
- **`credentialRefused`**, **`unavailable`** and **`transport`** change nothing. Waiting for a session never fails: a
  call waits until it has one or is interrupted. A server that reaches ReadyForQuery without a cancellation key
  (`NoCancelKey`) is `failed`: every attempt meets it.
- **The server's report** is in the `message` of every call PostgreSQL's refusal ends, `SQLSTATE <code>: <message>`, its
  message exactly as the server gave it. The server writes in the language of `lc_messages`, the database owner's
  setting; grizzle classifies a refusal by its SQLSTATE and the fields it names, never its words. A message can quote
  the values a statement was given, though never a value outside the role's view, so what you log is your choice:
  grizzle logs nothing.

<details>
<summary>Every error reason</summary>

**`OpenError`**, by stage:

| Stage        | Reason                                                                                                                                                                                                                                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config`     | `DbConfigRefused`; `ConnectionEnvironmentRefused`, a process environment that sets `PGREPLICATION`                                                                                                                                                                                                                  |
| `role`       | `RoleOutsideLayers`                                                                                                                                                                                                                                                                                                 |
| `token`      | `TokenMalformed`, a token that is no token68 (a JWT is one), refused before `verify` runs; `TokenRefused`, `verify`'s refusal or throw (the throw is its `cause`); `VerifierUnavailable`, `verify` unable to judge the token now, the one reason whose `retry` is `safe`; `ClaimRefused`, a payload that does not decode through the role's contexts; `ExpiryRefused`, an `exp` that is no number of seconds since the epoch |
| `schema`     | `CompileError`; `AttestationRefused`, attested facts that do not decode through the role's attested contexts                                                                                                                                                                                                      |

`Db.open` contacts nothing, so a connection that can't be had is the first call's failure, never the open's.

A call's `CallError` is read from the reason that failed it, each reason a class of grizzle's own
(adapter/live/call-error.ts), and a member's `explain` and `explainAnalyze` fail with the `CallError` its `once` would:

| Reason                                                                                                                                                                       | `_tag`          |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| the server's `ServerError`, 53200 and 54001 among them; `UnreadableAnswer`, rows grizzle cannot read or its compiled proof says the query cannot deliver; `CompileError`; `DriverFailure`, pg's refusal of a query on a connection still standing; `AdviceUnloaded`, a session that does not load `pg_plan_advice` ([Install](../README.md#install)) | `failed`        |
| `CredentialError`; `StartupRefused` of SQLSTATE class 28; `TlsRefused`, but a handshake's failure with a system error's code; `DriverRefused` | `credentialRefused` |
| `StartupRefused` of any other SQLSTATE, with the server's report; `SocketFailed`; `TlsRefused` of a system error's code; `ConnectionClosed`; `LayerReleased`, a layer whose scope has closed | `unavailable`   |
| `NoCancelKey`                                                                                                                                                                 | `failed`        |
| `ConnectionLost`, `CommitLost`                                                                                                                                               | `transport`     |
| `EncodingFailure`; `InputTooLarge`, below; `CallInputRefused`, below                                                                                                         | `input`         |
| `ParamRejected`, a parameter's value outside its pattern, its `param` the `CallError`'s                                                                                      | `paramRejected` |
| `LawRejected`, the laws a domain's or a pattern's domain discharges, which refused a value a statement cast to it; `InputRejected`, below                                 | `refused`       |
| `TransientFailure`, its reason the `CallError`'s `reason`                                                                                                                    | `transient`     |
| `StaleSnapshot`: `Migrating` or `Migrated` ([Deploying](operations.md#deploying))                                                                                                         | `stale`         |
| a COMMIT sent and never answered: the change may have committed                                                                                                              | `commitUnknown` |
| an `OpenError` of a call that opened its own Db, over HTTP: its token reasons `tokenRefused`, a role no layer serves `route`, the rest `failed`                                 | as listed       |

**`InputRejected`** is a ChangeSet member's `explain` of a call whose `once` would be `refused` before any SQL, by two
rows one stratum adds at one key, or a nested row's generated field with no value: its `refused` and `witness` are
that refusal's.

**`InputTooLarge`** is found on the host before the call's flight is sent. Its `bound`, which never counts rows:

- `message`: one statement's Bind message is longer than PostgreSQL reads (1,073,741,822 bytes,
  `PQ_LARGE_MESSAGE_LIMIT`), with the statement and its length. Split the input across calls. A family write's
  statement, which no execution cuts, meets it as every statement does; the largest real call, pantry's QTI publish at
  161.8 MB, is about 6 times under it.
- `literal`: one column of a relation input is an array longer than one JavaScript string holds (536,870,888 UTF-16
  code units), or for a bytea column longer than the message limit, with the input and its column. Split the input
  across calls.
- `input`: a ChangeSet member's arrays, or one row of a nested write, would make a Bind message past that limit, with
  the input and the least length its statement would take. It is counted from your values' lengths before any of
  their bytes is read or copied. Split the input across calls.
- `flight`: the call's flight, every byte the driver writes for it in its one write, is longer than one write over
  TLS carries (1,908,342,784 bytes), with its length. Nothing was sent, so nothing ran. Split the input across calls.
- `parse`: a statement's Parse message, its text with its name and fields, is longer than PostgreSQL reads
  (1,073,741,822 bytes), with its length. Nothing was sent, so nothing ran.

**`CompileError`**'s reason holds where it refused, `at`, and:

| Reason                                          | Details                                                                                                  |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `Refused`                                       | the `refusal`, a rule the type errors name too, in their words                                           |
| `MalformedDescription`                          | the rule `what` your schema or program breaks                                                            |
| `MalformedArtifact`                             | what grizzle reads back (the snapshot, a migration folder or its meta.json, the ledger's rows) malformed at the path `at` |
| `ArtifactFormat`                                | a committed snapshot or a served file, `artifact`, of another format than this grizzle's, `expected`: `recorded`, what its `format` member holds, `{ kind: "none" }` or `{ kind: "recorded", text }` |
| `UnsupportedOperation`, `UnsupportedLawFamily`  | a `capability` grizzle lacks, such as a parameter's value of a pattern no stored field declares, naming the parameter and the pattern ([Limits](limits.md#limits)) |
| `ResourceBound`                                 | its `bound`                                                                                              |
| `OutsideRole`                                   | the `role` and the `access` it doesn't hold                                                              |
| `DuplicateIdentity`                             | the `earlier` declaration                                                                                |
| `IdentifierCollision`                           | the `other` declaration and the `identifier` both convert to                                             |
| `IdentifierTooLong`                             | the `declaration` whose `identifier`, a name's conversion or a login's or role's role, takes `bytes` past PostgreSQL's `limit` |
| `DecodedColumnTooLong`                        | the `relation`'s closed-id `field` whose `conversion` takes `bytes` past `limit`, PostgreSQL's 63 less `_name`, so its decoded column `<field>_name` would not fit |
| `DigestCollision`                               | two objects, `display` and `otherDisplay`, whose hashed names share the stem and digest of `identifier`; renaming a declaration either is built from gives it another |
| `UnrepresentableKey`                            | every key the compile met whose entry no index holds, in `keys`, each with its `fault`                   |
| `PartialOperation`                              | an `operation` whose `precondition` on `operand` nothing proves, and the `guard` to write                |
| `RecursionRefused`, `DerivedRefused`            | their `cause`                                                                                            |
| `ForeignLevel`                                  | a rule over `over` (a schema or a role) reading a query written over `written`, none of `over`'s levels  |
| `RoleRefused`, `LoginRefused`, `ContextRefused` | the `rule` broken                                                                                        |
| `ScopeRefused`                                  | the `role` whose scope breaks the `rule`: `owner` (`why`), `unit`, `unitType` or `twice` |
| `GeneratedRefused`                              | the generated `field` of a `relation` and the `rule` it breaks                                           |
| `FoldOverProjection`                            | the match's `source` and the `key` it must bind for an aggregate to read each row once                   |
| `QueriedOwnerAppend`                            | an insert or put (`op`), at `at`, of the `owner` from a query beside an append of `member` to its `family` (`{ owner, count }`) |
| `CascadedCopyAppend`                            | a write (`op`) of `member` of its `family` whose `copy` reads its `owner`'s `through`, which the owner copies from `changed`, a relation the same stratum puts from a query, whose rows grizzle never sees |
| `StaleDerivedRead`                              | a write (`op`) of `member` changing a stored row's column (`changed`: `relation`, `column`, and `by`: `put`, `owner` or `member`), which the cascade carries into `copies`, read by `reader` (`{ kind, family, relation, column }`: a fold, a predecessor, a last or a tree's copy), which grizzle cannot refill for `cause`: `{ kind: "query" }`, a put from a query; `{ kind: "cycle", refills }`, refills reaching a family they refill again; `{ kind: "immutable", relation }`, a refill of a closed owner's family or a closed relation's rows; `{ kind: "tree", tree }`, a refill of the values of the tree `tree` (`{ owner, count }`), which grizzle draws only when a node is written; `{ kind: "chained", refill }`, a refill of a value that reads what the refill of the family `refill` (`{ owner, count }`) itself changes; or `{ kind: "edit", family }`, a refill of a value of `family` (`{ owner, count }`) that a family member's own put, delete or append reaches beyond the two values such a write refills |
| `UnfillableField`                               | the `relation`'s `field`, the `law` filling it, the `source` column it reads along `axis` of its `family`, and why that column is filled `later` |
| `UnwritableRelation`                            | the `relation` no write fills, and its `cause`                                                           |
| `NoReadCommittedForm`                           | the `relation`, whose primary key holds a range, that a ChangeSet compiled for READ COMMITTED inserts into: only a compile at a level no certificate gives meets it, since generate runs such a role SERIALIZABLE |
| `ReadBackCrossesStatements`                     | the read-back `read`, and `delta` (`relation`, `side`), a side of a table's delta more than one statement makes, or one a statement of another stratum nets |
| `UnorderableStratum`                            | the `cycle` of a stratum's writes (`{ relation, op }`: an insert, put or delete, or a family's insert, update or delete of its members' rows or count of its owners), each of which immediate keys order before the next and the last before the first, so no order of the stratum's statements keeps them all |
| `UnstatedKey`                                   | a put or delete (`op`) of a `relation` whose `key` (`{ kind, fields }`: its primary key, or a declared one a put compares) holds fields grizzle writes (`unstated`) |
| `UndeclaredDrop`                                | the name a migration would drop, which no `--drop` or `--rename` declares                                |
| `MissingDiscriminant`, `AttachedParentUnbound`, `AttachedPage`, `DescribedHeadingMismatch`, `ContractLiteral` | a `capability` sentence |

**`EncodingFailure`**'s reason is its codec's fault word, never the value, the word of the exact parse that refused it:
`numericScale` for a `Numeric` past its field's scale and `realInexact` for a `number` no binary32 value is among them;
its `place` is the `Slot` the value fills, by `name`, or a whole `Fact`. **`CallInputRefused`**'s `fault` names what
of a call's input it refuses: `envelope`, no record of exactly `params` and `facts` (and a paged member's `window`);
`params`, params that are no record; `{ program, parameter }`, a key of the params that names none of the member's
parameters, `assignByGradeBypassingGate declares no parameter titles`, so a parameter misspelled, or one another
member takes, is refused as itself and never binds nothing; `facts`, facts given to a member that takes none;
`window`, `size` or `anchor`, a paged member's window, a position that is no safe integer of at least 0 among its
anchor's faults.

</details>

## Transactions and concurrency

- **Every transaction grizzle opens names its level.** A write runs SERIALIZABLE unless its role is certified READ
  COMMITTED, and a read SERIALIZABLE READ ONLY; a statement grizzle sends
  outside a transaction, a `-- grizzle: no-transaction` file's among them, runs SERIALIZABLE, since every session of the
  migration identity starts with SERIALIZABLE as its default. grizzle sets no database default: a foreign session
  starts at the server's, READ COMMITTED unless the operator chose otherwise. A write below SERIALIZABLE on a grizzle
  table is refused with 25000, by the table's guard trigger, psql's included, so a direct writer says SERIALIZABLE; the
  guard, not a default, keeps every direct writer of a guarded table inside what certification proves.
- **A role's writes run READ COMMITTED only where generate proves it.** `grizzle generate` certifies each role from
  the statements its ChangeSets send, against every other writer, and the role's served file begins its writes at the
  level it proved ([READ COMMITTED writes](#read-committed-writes)). Reads are always SERIALIZABLE READ ONLY
  ([Reading](reads-and-writes.md#reading)).
- **A table whose every writer is certified READ COMMITTED has no guard.** Such a table is one some role writes, and
  every role that holds INSERT, UPDATE or DELETE on it is certified to run its writes READ COMMITTED and holds only
  INSERT and SELECT there. The installation creates no guard trigger for it, so a write below SERIALIZABLE is admitted
  there: a direct writer meets the grants of the role it writes as, which insert and read and nothing else, and the
  table's laws, each a constraint PostgreSQL checks at every level or a rule over a query no other write can help
  break ([READ COMMITTED writes](#read-committed-writes)). Every other table keeps its guard, and a table no
  role writes keeps it too. A migration that changes whether a table qualifies drops or creates its guard. A role
  that writes only by direct SQL has no ChangeSet to prove, so it is SERIALIZABLE, and a grant of INSERT, UPDATE or
  DELETE to it keeps that table's guard and makes SERIALIZABLE every role that writes the table, every role whose
  writes its grants let it read, and every role whose foreign keys check what it writes: generate cannot see its
  transactions, so it takes them as any its grants permit, which may read any relation they reach, present or absent,
  and take no fence ([READ COMMITTED writes](#read-committed-writes)).
- **One call, one transaction, one round trip or two.** A call sends BEGIN, its statements and COMMIT in one pipelined flight.
  A write that must read stored values first (a family edit of a group already stored, or a refill of a value a change
  leaves stale) sends two flights in its one transaction: one batched read per family of the stored values the edit
  continues and one per way a change reaches a refilled family's groups, then the writes filled from them with COMMIT.
  There are no interactive transactions: a read that decides a write is a query inside the ChangeSet, and reads that
  must agree are one query with nested results.
- **No retries.** A refusal from outside the call's inputs is a `transient` `CallError` (a migration's is `stale`)
  and changes nothing. Any SERIALIZABLE transaction can meet a serialization failure, even with no other transaction in
  sight, because under load PostgreSQL's SSI summarizes old committed transactions and judges conservatively: treat it
  as retryable everywhere.
- **Imports at once: one database per worker, for now.** Two large imports into one database, such as two packages
  that share no row, can still fail each other with 40001: PostgreSQL's SSI can lock more of a stored table than the
  rows a staged write reads. Until grizzle's fix for this lands, run imports that happen at the same time each in a
  database of its own, one database per worker.
- **No timeouts.** grizzle sets no `statement_timeout` or `lock_timeout`, and no connect timeout: a connection attempt
  waits for the server's own answer, or for the failure the operating system reports (a refused, reset or timed-out
  connection) and PostgreSQL's own `authentication_timeout`. Put a deadline on a call yourself, `Effect.timeout`.
  Interrupting the Effect is the only cancellation: a call interrupted while its statements run sends a
  CancelRequest, then waits on its own connection for the server to end the statement. PostgreSQL ignores a
  CancelRequest that reaches the backend before it has read the statement, so each time the server answers another
  statement of the call while it has not ended, the call sends another; a statement a CancelRequest missed runs to its
  own end, whose answer sends the next. The interruption ends only once the server has stopped the statement: its
  locks and snapshot are released, a write's COMMIT has run or never will, and a read after the interruption sees the
  outcome. The session is never used again. A CancelRequest that cannot reach the server (refused, reset or timed out,
  as the operating system reports it) counts it unreachable: the call destroys the connection and ends, and what the
  server then runs of the statement is unknown. A server that goes silent without the operating system noticing is
  found only by your transport's TCP keepalive (`open`). Treat an interrupted write like `commitUnknown`: if its
  statements had all finished, it may have committed.
- **Predicate locks are the operator's to size.** Set `max_pred_locks_per_transaction = 2048`; without room, PostgreSQL
  fails transactions with 53200, which is not retryable. Keep every transaction on the cluster short: a committed
  write's and a read's predicate locks are kept until every older transaction ends.
- **A lone writer can still meet 40001.** While a transaction that has written holds the cluster's horizon back, any
  idle-in-transaction session or long import among them, PostgreSQL keeps every SERIALIZABLE transaction that finishes
  meanwhile, and once they fill its fixed pool, ten per connection slot, it summarizes the oldest to their ids alone. A
  writer whose transaction writes a row its own earlier transaction read, and reads a version that a summarized one of
  its own wrote, is then failed as a pivot ("Canceled on identification as a pivot, with conflict out to old committed
  transaction"), though no other transaction touches its tables: the earlier reader counts as concurrent because the
  writer's snapshot starts below the held horizon (PostgreSQL 19 src/backend/storage/lmgr/predicate.c 4157 and 4170),
  and a summarized writer is looked up with no test of concurrency (3980-4012). A migration meets it as a refused file,
  a call as a `transient` `CallError`; both are safe to run again: the call changed nothing, and `grizzle migrate`
  resumes the folder where it stopped. A session waiting on a lock that has written nothing holds no horizon back. The
  experiment packages/experiments/ssi-summary reproduces it.

### READ COMMITTED writes

At SERIALIZABLE, PostgreSQL aborts one of two transactions whose reads and writes could cross, with 40001, and under
load it judges conservatively, so many callers writing at once (a class of children answering the same test) meet
40001s that no real conflict caused. grizzle never retries. Instead, `grizzle generate` proves, role by role, when a
role's writes run at READ COMMITTED and still behave as if every call ran alone, one after another, in the order they
committed. Such a role's writes never meet a serialization failure: a real conflict is a key's law, refused by the
unique check that decides it.

**When a role is certified READ COMMITTED.** generate reads every statement each ChangeSet of the role's workload can
send, in every variant and every form, its read-backs included, and judges them against every other role of every
login. A row "another call can write" is a row of a relation some role writes, other than the call's own rows and
grizzle's own key checks of what it inserts. A foreign key check counts as a read, made at a later snapshot than its
statement's. The role is certified READ COMMITTED when all of these hold, and stays SERIALIZABLE otherwise:

- **It has a ChangeSet.** A role that writes only by direct SQL has nothing to prove. Its writes are unknown, and
  generate judges every other role beside the most a transaction of its grants can do: read every relation its grants
  reach, for what it holds and what it lacks (each relation its views read, a live derived relation by the relations
  its definition reads, and each table it holds a privilege on), insert, update or delete each relation it holds that
  privilege on, and take no fence. PostgreSQL refuses any other read with 42501 before it reads a row, so a relation
  its grants do not reach is one it never sees. While a role holds INSERT, UPDATE or DELETE and has no ChangeSet, no
  role runs READ COMMITTED that writes a relation it can read (`absence`, `laws`, `writers`), or whose foreign key
  checks a relation it writes (`pivot`), since no fence orders such a check against its transactions. A role that
  only reads has nothing to bound: a transaction that writes nothing is no pivot.
- **Each of its ChangeSets has a READ COMMITTED form.** An insert into a relation whose primary key holds a range has
  none: PostgreSQL arbitrates an exclusion constraint by `ON CONFLICT ON CONSTRAINT ... DO NOTHING` alone, so no
  statement can tell a fact the insert met from one it made. A role with such an insert, or a put of such a relation,
  runs SERIALIZABLE, where the insert arbitrates every key at once and classifies what it met. An insert that stamps an
  instant or a place has one: it takes its stamp from its scope's or its group's head row at its key, which serializes
  the calls of one key and no others ([Instants](reads-and-writes.md#instants)), and reads nothing of its own relation to do it.
- **It only inserts.** It states `insert`, not `write`, so it holds INSERT and SELECT alone, and every relation it
  writes is one no role updates or deletes: by a grant, by a ChangeSet, or by an `ON UPDATE CASCADE` into it.
- **Its relations' laws hold at READ COMMITTED.** Every law over a relation it writes is one PostgreSQL checks at every
  level (a key, a CHECK, a domain, a foreign key), or a rule over a query that its writes can break only through the
  one row each inserts. A trigger checks such a rule at COMMIT, and generate reads each way the rule can be broken (a
  rule of a side's query, a key's two facts) that its write reaches: that way must read exactly one row some write can
  add or take away, a match of the row its write inserts, and beside it only rows no write adds (of a relation no role
  inserts or updates, or a closed relation) and the absence of rows no write takes away (of a relation no role
  deletes or updates). A write the trigger misses can then only take a violation away, so it
  refuses more, never less: `Live = Hold where not Freed` checked against a closed count, written by a role that
  inserts both, is one; a key over `Live`, a join of two relations roles insert, a count, sum, min or max of a relation
  a role inserts, which reads every row of its group, or a negation of a relation a role deletes is none. No
  SERIALIZABLE role's ChangeSet reads a relation it writes.
- **Nothing reads the absence or a count of what it writes.** No ChangeSet of any role asks whether a row of it is
  missing (a negation, a `NOT EXISTS`) or how many there are (a count, an aggregate). grizzle's own checks inside a
  write (a duplicate within the call, a refusal of a conflicting row) don't count when every row they look at comes
  through a whole immutable group the same statement reads positively, through one in each arm of a `UNION`, and every
  write they guard is joined with that group.
- **It reads other calls' rows in one statement, as whole groups that never change.** Each such read finds one row by a
  whole declared key of a relation every role only inserts into, all the members of a family whose closed owner
  holds their count, or a relation no role writes, keyed by values the call states once: a read keyed by each row of
  an array the call was given reads one group per row, which another call's rows can split. All of a ChangeSet's reads
  of other calls' rows are in one
  statement, beside no foreign key check that reads more of them, and each row it writes is joined with what it read,
  so a call that finds nothing writes nothing. Each foreign key check it makes finds an immutable row in the same way,
  or a row of a relation no role updates, which the check locks until the call commits, or refuses the call whole: by
  a whole key PostgreSQL enforces, a key over the columns a law adds among them, as an arm's mirrors' way back to its
  relation or a family's slot is. A
  row the call inserted, read back in a later statement by the key it was inserted at, is its own, when no statement
  up to the insert read other calls' rows.
- **No SERIALIZABLE role writes what it writes, or keeps a stored relation it keeps.** The table's guard would refuse
  every one of its writes. A write keeps a stored relation where its definition reads the relation written, directly
  or through another stored relation ([Derived tables](schema.md#derived-tables)): the judge's borrow orders two writers' upkeeps
  of one unit, but a SERIALIZABLE upkeep reads at its transaction's snapshot, which no lock moves past a READ COMMITTED
  writer's commit, so it would keep the unit as though that writer's rows were not there.
- **No SERIALIZABLE writer of what it reads can miss another call's write.** Every role that runs SERIALIZABLE and
  writes a relation the role reads (by a statement, or the judge of a rule over a query its write arms) reads no row
  another call can write, makes no foreign key check but one that finds an immutable row (of a relation every role only
  inserts into, by a whole declared key, or of a relation no role writes), and writes no relation a rule over a query
  reads. A foreign key check of the role's is no such read: a writer that may miss another call's write fences the
  relation it checks (below).

**Reading generate's report.** generate prints each role's level, and under a SERIALIZABLE role why it is, before the
files it writes:

```
login app, role learner: read committed
login app, role reader: serializable (writers 1)
  fix login author_app, role author first (writers 1)
login author_app, role author: serializable (privileges 1, absence 1)
  privileges, relation Item: holds DELETE; state insert, not write, on the relation, and let no role update or delete a relation the role writes: record each change as an inserted fact
  absence, member publish, statement 0, relation Item: author of author_app reads it negated; read no absence (NOT EXISTS, a negation) and no count of a relation the role writes, in any role's ChangeSet: state the fact as a row and read it by its key
login author_app fences PublishedVariant: its writes of it lock it in exclusive mode before their snapshot, for the read committed foreign key checks of login app, role learner
```

A SERIALIZABLE role's line counts each condition it fails, and the lines under it say where. A role that fails a
condition by itself has a line per place that fails one: the condition; where, the role, a relation, a ChangeSet's
write of a relation, or a statement of a ChangeSet by its place among the statements a call of it sends, with the
relation it reads or writes; what fails there; and the condition's fix. A role that fails none by itself, but runs
SERIALIZABLE because a role that runs SERIALIZABLE reads what it writes, writes what it writes, or writes what it reads
while that role may miss another call's write, has a line per such role in their place, `fix login L, role R first`,
with the count of each condition that role gives it: it runs READ COMMITTED once none of them does or gives it one, so
fix those first. Every count of a role's line is the number of its lines of that condition, or the sum of its givers'
counts of it. Each fence follows the roles. The conditions:

| Condition    | What fails it                                                                                                                            |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `form`       | a ChangeSet with no READ COMMITTED form: it inserts into or puts a relation whose primary key holds a range |
| `facts`      | a relation it touches that the installation states no fact of, or a table or function its statements name that no relation is         |
| `members`    | no ChangeSet in its workload                                                                                                             |
| `privileges` | it states `write`, or some role updates or deletes a relation it writes                                                                 |
| `laws`       | a rule over a query its write can break through more than the one row it inserts, or a SERIALIZABLE ChangeSet reading what it writes   |
| `absence`    | a ChangeSet that reads whether rows of a relation it writes are missing, or counts them, or a check of grizzle's own over rows no whole immutable group of its statement brings |
| `snapshot`   | a read of other calls' rows beside another one in a later statement, or beside a foreign key check                                      |
| `pivot`      | a read of other calls' rows that is no whole immutable group, a row it writes not joined with such a read, or a foreign key check of a row that can change |
| `writers`    | a SERIALIZABLE role writing what it writes, or keeping a stored relation it keeps, or writing what it reads by a statement or a rule's judge while reading other calls' rows or making a check of a row that can change |

A role's level is in its login's served file, so a change that moves it shows as a stale served file in `grizzle
check`, like any change to the workload. The served login reads it: `served<typeof Web>(webFile, "web").roles.member.isolation`
is `readCommitted` or `serializable`, for every role of the login.

**Reads stay SERIALIZABLE READ ONLY.** A query, a key and a window run SERIALIZABLE READ ONLY whatever the role's level,
each one statement. A ChangeSet's read-backs run in its own transaction, at its
level.

**compileServed compiles each role at its certified level, and refuses a role the installation does not install.** A
file `compileServed` compiles runs each role at the level the installation certified it at, which `snapshot.json`
records, as the file `grizzle generate` commits serves it. A login or a role no configuration lists has no certificate,
no grants and no views, so no file of it can run: `compileServed` refuses it, a `ServedRefusal` at the role whose error
is `UninstalledRole`, naming the login and the role. List the login with the role in the configuration's logins and run
`grizzle generate`.

**compileServed refuses a read the live source does not serve.** A watch of a read whose table the installation's
publication leaves out, or whose routing column its live source does not route by, would miss its changes, and a watch
over an installation with no live source would miss the migration that ends it `stale`, so `compileServed` refuses that
program, a `ServedRefusal` at the program whose error is `UncoveredRead`, naming the missing source, or each table and
column. Only a snapshot of a database migrated without the program's workload has one, since `grizzle generate` builds
the publication from the same workload.

**compileServed refuses a domain or a function the installation lacks.** `grizzle generate` installs the domain of
every refinement and every domain any artifact of the installation or any program of its served workload types a
value by, the pattern domain of every pattern parameter, one per parameter and pattern, and every library function they
call, and `snapshot.json` records them. A program that `compileServed` compiles names only those, so a program that
types a value by a refinement or a domain, or calls a function, that the committed workload never served is a
`ServedRefusal` at the program whose error is `UninstalledDomain` or `UninstalledFunction`, naming the domain, the
pattern, the parameter or the function, never a `type ... does not exist` from PostgreSQL. Serve the program from a
workload of the login and run `grizzle generate`, which drafts the migration that installs them.

**Direct SQL.** A direct writer, psql included, writes at SERIALIZABLE, and the guard refuses anything below it with
25000, except on a table whose every writer is certified READ COMMITTED. There it may write at any level, as the role it
writes as: it can only insert and read, and every law of the table holds at every level, a constraint PostgreSQL
checks, or a rule over a query no other write can help break. A
direct transaction of a login that fences a relation (generate's report names it) that writes the relation begins with
`LOCK TABLE ... IN EXCLUSIVE MODE` on it, before any other statement, as the fenced ChangeSets do.

**Referencing a relation another role deletes, or writes while it may miss a write: fences.** A READ COMMITTED role
may reference a relation that some role deletes, as a learner's answer references the published keys a content
replace deletes and inserts again, or that a SERIALIZABLE role inserts while it reads other calls' rows, as an import
does, when no role updates it. Its foreign key check locks the row it finds until the call commits, and every deletion
of that row waits for it. Two histories still break that check, and generate closes both by fencing the relation:

- A replace that deletes a key and inserts the same key in one transaction. A READ COMMITTED check that took its
  snapshot before the replace committed waits on the deleted row, finds it deleted, never sees the inserted one, and
  raises 23503, although the key exists before and after: a refusal no order of the calls gives. This holds for an
  identical row too: the inserted row is a new one.
- A writer that may miss another call's write (it reads other calls' rows, or writes a relation a rule over a query
  reads) inserting a key while a check looks for it. The check waits for nothing and refuses its call, which no order
  in real time explains once the writer missed a write that committed before the call began.

Every login whose roles delete such a relation fences it, and so does every login with a role that runs SERIALIZABLE,
may miss another call's write (it reads other calls' rows, makes a check of a row that can change, or writes a relation
a rule over a query reads) and writes it: each ChangeSet of the login that writes the relation begins
its transaction, as the login and before any statement takes the snapshot, with `LOCK TABLE ... IN EXCLUSIVE MODE` on
it, and `grizzle migrate` grants the login MAINTAIN on its table, the least privilege that permits the lock, and USAGE
on its schema; the drift check judges both. A READ COMMITTED check takes ROW SHARE on the table before its own
snapshot, which the lock excludes, so every check either committed before the fencing write locked, and the write's
snapshot sees the call, or takes its snapshot after the write committed. Neither history can happen, the write's check
of the rows that reference a row it deletes no longer counts against the referencing role, and generate prints each
fence it relies on. Fences cost:

- A READ COMMITTED call whose check reads the relation waits while a fencing write runs, and fencing writes of one
  relation run one at a time. Plain reads, which take no row lock, never wait.
- A deadlock, at most once per fencing write: the write locks its relations one at a time, in the order of their
  qualified names, and a READ COMMITTED call holding ROW SHARE on one of them may wait for another it locked first.
  PostgreSQL aborts one of the two with 40P01, a `TransientFailure` (`Deadlock`). No order of the lock list avoids it:
  a call takes ROW SHARE in the order its foreign key checks fire, its relation's check triggers' names, and those are
  `RI_ConstraintTrigger_c_` and the trigger's OID, compared as text, so two referencing relations can check two fenced
  relations in opposite orders.

A relation some role updates is never fenced: an update may move the key a check found, so the referencing role stays
SERIALIZABLE.

**Referencing content another role writes: publish it.** A ChangeSet that inserts rows referencing content another role
maintains (an author edits questions, a learner's answer names a question) reads that content in its foreign key
checks. If the content's writer reads other calls' rows of its own, as an import does, it runs SERIALIZABLE and its
login fences the content, so every referencing call's check waits while a content write runs, and content writes run
one at a time; a statement that reads the content keeps the referencing role SERIALIZABLE (`writers`). Publish the
keys it references instead, so the checks wait for nothing:

1. Have every role that writes the referenced content relations state `insert` on them, so a content row, once there,
   never changes.
2. Add a published relation, keyed by the content's key, with a foreign key into the content and nothing else.
3. Give it a `publisher` role of its own that states `insert` on it alone, whose ChangeSets insert published keys and
   read nothing else. It may stay SERIALIZABLE: its only reads are its foreign key checks, each of which finds an
   immutable content row.
4. Point the referencing role's foreign keys at the published relation, not at the content.

```ts
export const Question = g.relation("Question", { id: ItemIdentifier, prompt: Prose }, ["id"])
export const Bank = g.schema("Bank", [Question], [])
export const Author = g.role(Bank, "author", g.wholeEntriesOf(Bank), { insert: ["Question"] })

export const Published = g.relation("Published", { question: ItemIdentifier }, ["question"])
export const Answer = g.relation(
	"Answer",
	{ learner: ClerkUser, step: g.int8, question: ItemIdentifier },
	["learner", "step"]
)
export const Exam = g.schema.extend(
	[Bank],
	"Exam",
	[Published, Answer],
	[
		g.contained(g.on(Published, "question"), g.on(Question, "id")),
		g.contained(g.on(Answer, "question"), g.on(Published, "question"))
	]
)
export const Publisher = g.role(Exam, "publisher", g.wholeEntriesOf(Exam), {
	insert: ["Published"]
})
export const ExamLearner = g.role(Exam, "learner", g.wholeEntriesOf(Exam), { insert: ["Answer"] })
```

The learner's check now reads `Published`, which only ever gains rows, and its one writer reads nothing another call
can write, so the check finds an immutable row or refuses the call. Publish a question before a learner may answer it.

### Races

`race(R)` among a schema's rules makes R's primary key first come, first held. The first insertion at a key holds it,
and every later insertion at that key meets the row that holds it, whatever that row holds: nothing is refused, the row
it met is in `delta.met(R)`, and the call's outcome is `accepted` or `no-change` as its other members decide. Without
`race`, a row another insertion holds is an exact repeat, which changes nothing, or that key's refusal.

- **Which tables race.** An ordinary table whose primary key has a field beside it and holds no range and no field the
  database or grizzle draws, that is neither `mutable` nor a family's owner or member. generate refuses any other
  `race` as MalformedDescription, and a `race` over a table a lower level declares as LevelRefused.
- **Adding or dropping it is a migration.** `race` changes the schema's fingerprint as `mutable` does, so generate
  drafts a migration with no SQL, which moves the installation to the new fingerprint; once it is applied, a `Db` of
  the old snapshot fails with `StaleSnapshot`.
- **Its other keys stay laws.** An insertion that would hold another of R's keys that another row holds is refused by
  that key, and the whole call with it. A `put` of R asserts its row and never races. A key held by a row outside the
  role's query entry is never met, race or not.

A claim of work, keyed by the work it claims and never searched for:

```ts
const instantKey = Symbol("Instant")
export const Instant = g.domain<typeof instantKey>()("Instant", g.int8)
/** A step, by its name in its flow, and a claimer, by its own name: its host and its process. */
const StepName = g.str.regex("^[0-9A-Za-z:_-]{1,96}$")
const Worker = g.str.regex("^[0-9a-z.-]{1,64}:[0-9]{1,10}$")
export const Step = g.relation("Step", { id: StepName }, ["id"])
export const Claim = g.relation(
	"Claim",
	{ step: StepName, attempt: g.natural, holder: Worker, at: Instant, ttl: g.int8 },
	["step", "attempt"]
)
export const Finished = g.relation(
	"Finished",
	{ step: StepName, attempt: g.natural, holder: Worker },
	["step"]
)
export const Work = g.schema(
	"Work",
	[Step, Claim, Finished],
	[
		g.race(Claim),
		g.contained(g.on(Claim, "step"), g.on(Step, "id")),
		g.contained(g.on(Claim, "step", g.pred("attempt")), g.on(Claim, "step", "attempt")),
		g.contained(
			g.on(Finished, "step", "attempt", "holder"),
			g.on(Claim, "step", "attempt", "holder")
		)
	]
)
```

- **One holder per key.** A claimer names its work by key, `(step, attempt)`, from the message that woke it or a read
  that found it, and its own name as `holder`, and inserts Claim there. Exactly one claimer of a key
  holds it; every other meets the holder's row in `delta.met(Claim)`. A claimer that sends its call again after
  `commitUnknown` meets its own row, its own holder in it.
- **Only the winner goes on.** A member that runs for the winner alone reads Claim back at the key in a later statement
  of the same ChangeSet, `holder` equal to its own, and writes from that read: a loser finds no row and writes nothing.
  generate certifies that read as the row the race fixed, where the read binds the key as the insertion bound it and
  nothing before the insertion read rows another call can write.
- **Expiry is a new fact.** A claim never changes. A reclaim inserts Claim at the next attempt from the previous
  attempt's row, read by its whole key, where `at + ttl` is before `now` (Num.add over Type.base of each); a
  claim stamps `at` with `now`, and serving both `clocked(…, { now: "micros" })` judges both ends by the database's
  clock ([The database's clock](reads-and-writes.md#the-databases-clock)). Nothing revokes the earlier attempt, so two attempts' holders
  may run at once: Finished's key decides which commits, and a later commit of the step is refused by that key, nothing
  of its call written.
- **All of it is certified READ COMMITTED.** The claim, the winner's read, the reclaim and a commit fenced by
  Finished's containment into Claim each run READ COMMITTED, so none meets a serialization failure, and a lost race
  answers on its first try. Searching for work inside the claim does not: taking the next due item reads rows a
  concurrent call can add, skipping claimed items reads their absence, and allowing fewer than W running counts them,
  and each keeps its role SERIALIZABLE (`pivot`, `absence`).
- **Two races in two statements are two races.** A call that races two tables, each in its own statement, can win one
  and meet the other. It then holds the key it won, and `delta.met` says which it met. To win both or neither, put
  both keys on one row, the primary key raced and the other a key of the table, so a held other key refuses the call
  whole; or race the first and insert the second, into a table that does not race, joined with the winner's read of
  the first, so a held second key refuses the call and the first with it.
- **Deadlocks.** A call that inserts one row into each table it races never waits on another in a cycle. A call that
  inserts several rows into a table with two unique keys, or claims several keys in an order another call reverses,
  can meet a deadlock (40P01), a `transient` failure, at any isolation level.
