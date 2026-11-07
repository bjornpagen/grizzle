# Changelog

## Unreleased (since 1.0.0-beta.0)

Every change below is a hard cutover. No release keeps an old API, an alias, a deprecation period or a compatibility
flag. Upgrade with one sweeping codemod that applies every entry at once, then regenerate your migrations and
re-create your databases. Each entry gives the codemod's rule, before and after.

How to upgrade:

1. Run every codemod rule below over your code in one pass.
2. Typecheck. Every remaining error is a site the rules could not rewrite mechanically, and the error names what to
   write. The type system rejects every old form, so a clean typecheck means nothing old is left.
3. Delete your `migrations/` folders and re-create every database, then run `grizzle generate <config>`. snapshot.json
   and meta.json changed format, and the previous files are refused, never read.

### Breaking changes

#### A rule matches only a query over a level of its schema, and a query's types keep every parameter any branch needs

- **A rule that matches a query, or a bound import of one, written over a schema that is none of the rule's levels is
  `ForeignLevel` when it is built**, with the schema the query is written over (`written`) and the rule's (`over`).
  The types already refused it ("the query is not over a level of this query's schema"); the engine admitted it where
  the two schemas shared the relations the query reads. Write the query over a level of the rule's schema, or extend
  that schema from the query's. No codemod.
- **`Q.bind` binds a relation parameter only to a relation parameter of the importing rule, `r.relation(name,
  heading)`**, the one binding a Description holds. The types admitted a query, a bound import or an interior stage
  there, refused only over another schema; the engine refused every one with `UnsupportedOperation`. The type now
  names it: "a relation parameter binds a relation parameter of the importing rule, r.relation(name, heading)". No
  codemod.
- **A query's parameters hold every parameter any branch of a conditional or an array literal may need.**
  `flag ? r.eq(x, r.param("p", f)) : Compute.eq(x, "…")` left `p` out of `ParamsOf`, since TypeScript reduced the
  union to the branch that needed less; a term's parameters are now contravariant in its type, so the branch that
  needs more is the one kept. A call that omitted such a parameter is now a type error naming it. A position that takes
  a term whatever parameters it needs is written `AnyParams` (`Predicate<AnyParams>`, `Aggregate<unknown,
  AnyParams>`); `Predicate` alone is one that needs none. No codemod.
- **A union's keys no longer count a field a flag fixes to a literal under one branch and to a parameter under the
  other as telling its arms apart**, so `db.get` and a stated Option or one child refuse a query whose arms may both
  deliver that value. No codemod.

#### A delete that names two facts at one key is refused, a nested insert writes only members its role writes, and a family write the engine can't plan is a type error

- **A delete listing two facts of one relation that share a key and differ elsewhere is `invariant-rejected` on that
  key's law before any SQL is sent**, as an insert's and a put's already were. Its witness is the key values. The types
  already refused such an array literal with literal keys. The engine judged deletions by identity alone, so it took
  both facts as requests, though a key names one stored fact. Every declared key judges a stratum's deletions,
  the primary key first, a span compared as a value, apart from its additions: a delete and an insert at one key are
  still a replacement. No codemod.
- **An insert of a sequence's owner, through a role whose write list leaves out a member relation its nesting reaches,
  is `OutsideRole` on that member when it compiles.** The types already refused it at `db.apply`. The engine checked
  only the owner, so the apply reached PostgreSQL and failed there, since a role holds nothing of a member relation it
  does not write. List each nested member relation in `write`. No codemod.
- **A put or a delete of a family's relation that the engine refuses when it compiles is a type error too.** These are
  a put or delete of a tree's row; one of a row whose key holds a field grizzle writes, such as a sequence's member
  keyed by its drawn index; a delete of a member of an immutable owner's family; and a put of an immutable family
  owner. Each typechecked and failed at compile with `UnsupportedOperation` or `UnstatedKey`. Now the relation
  argument names the engine's reason in a `Refusal`. An insert of a counted member of an immutable owner, in a stratum
  that inserts no owner, stays the engine's alone, since the types see no strata. No codemod.

#### A concurrent change outside the installation, and a refined claim admission can't judge, fail closed

- **A 40Z01 whose DETAIL names a relation the installation doesn't store is an `ExecutionFailure`.** The witness
  classifier read a write statement's concurrent change as a `TransientFailure` at whatever relation its DETAIL named;
  now only one of the installation's stored relations is a concurrent change, and any other (a closed relation,
  another installation's relation, a name of none) is the operational failure carrying the server's report, as every
  other DETAIL the installation's encoding does not read is. No codemod.
- **`Db.open` refuses a refined claim whose domain the installation doesn't name with an `OpenError` at stage
  `admission`.** Admission skipped such a claim of a pattern, admitting it unjudged, and died with a defect on such a
  claim of a contract; now both are `AdmissionFailed`, before admission sends anything. A Db's own claims always have
  their domains, so a correct installation never meets it. No codemod.

#### A pattern whose anchors leave no match is refused, and a role's types cost linear time

- **A pattern no text matches is refused wherever it is written**, through its anchors as well as its classes: a
  `^` after a character or a `$` before one, as in `^$a` or `a^`, leaves no match. Before, only a pattern whose classes
  were empty was refused, and `Compute.matches(x, "^$a")` compiled to a test that never holds, and a `str.regex` field
  of such a pattern past the DFA bounds installed a CHECK no value passes. Now each is `UnsupportedOperation` naming the
  pattern, in `Compute.matches` and `str.regex` alike, decided exactly for the admitted grammar. No codemod.
- **A cast into a regex-refined text that isn't proved is `PartialOperation` with the new precondition `language`**,
  where it was `contract`, and its message suggests a `Compute.matches` guard by the target's pattern rather than
  `Compute.within`, which can't prove a text. A contract keeps `contract`. Code that reads a refusal's precondition kind
  reads `language` for such a cast.
- **Format and state:** a `str.regex` pattern past the DFA bounds whose IR held an arm no text matches, such as
  `(?:x[xy]{11})(?:b|$c)`, drops that arm, so its `ir:` key and its domain's digest change and its migration rebuilds
  the domain once. Keys of patterns within the DFA bounds don't change.
- **`ChangeSet.empty(role)` and `query(role)` typecheck over a role of any size.** A role's kept laws and its full base
  are read by name, one lookup a relation, where they compared every law with every entry and failed with TS2589 past
  about 1.2 million pairs (1,107 relations with a law each). No codemod.
- **A rule's types cost time linear in what it reads.** Its evidence reads a schema's keys, containments,
  alternatives laws and sequences, and a head's and a match's fields by origin, through indexes built once. Before, it
  passed over every containment, key or sequence of the schema, and over its own fields once per field, so a head's
  cost grew with the square of its fields. No codemod.
- **A tree insert typed by a member type of any depth typechecks**: a member type that nests itself,
  `children: ReadonlyArray<Member>`, directly or through others, is checked once for each pair of member type and
  nesting, where it unfolded forever (TS2615) and refused the member. A field its nesting does not take is still
  refused at every depth. No codemod.

#### Hex is the one spelling of bit data
- **`closed.relation` takes four arguments; its `{ pack }` option is gone.** Every closed constant is drafted as one
  hex literal under its row count and content digest, which `grizzle check` decodes and holds to the digest. The rows
  form, a DO block packing 0/1 cells with string_agg, is deleted, and with it the statement-size bounds that chose
  between the forms. Codemod: `closed.relation(name, fields, key, rows, { pack: … })` → `closed.relation(name, fields,
  key, rows)`; drop imports of `ClosedRelationOptions` and `ClosedRelationOptionRecord`, and reads of a closed
  relation value's `.pack`.
- **A set is `bit(n)` with n its roster's codes rounded up to whole hex digits**, the bits past the last code held at 0
  by the bits domain's CHECK. Every bit literal grizzle writes is one `X'…'` cast to its type, never a binary `B'…'`
  and never two strings joined by `||`; a set's parameter text is `X` and its hex digits; a roster's live-codes
  constant is its hex literal rather than a string_agg over its names constant, so a role that writes a set needs
  EXECUTE on the live constant alone. A bits domain is named by its width, so a roster that grows within a hex digit
  keeps its domain and re-points its CHECK. No codemod.
- **`grizzle check` refuses a lowercase hex digit and a 1 in a literal's padding**, besides any digit that changes a
  cell. No codemod.
- Format: migration files, snapshot.json (a pack's `hex`, a set literal's `bits` kind) and bits domain names change;
  regenerate migrations.

#### A contract's facts are the ones it declares

- **A precondition a fact discharges is proved by declared facts alone.** A contract's facts are exactly its
  `proves`, which grizzle verifies against its predicate when the contract is built; a fact its predicate implies but
  it does not declare no longer discharges a precondition, and the refusal names the `proves` entry to add
  ("declare it:") rather than a guard. Codemod: add the fact to the contract's `proves`, as `contract("Rate",
  pg.numeric(7, 6), (x) => x.between(0n, 1n), { proves: ["finite"] })`.
- **`width_bucket` requires its operand and both bounds finite**, besides its domain. No codemod.
- **A conditional (`Compute.cond`, `Compute.when`), LEAST, GREATEST and every operation's result have only their SQL
  type's facts**, as their types state: a conditional of two nonzero branches is no proved divisor. An integer, money
  or exact result stays finite, through `Compute.numeric` too. A refusal names the `proves` entry to add only where the
  operand is a column, a parameter, a literal or a cast, whose facts are its type's; over a conditional or an
  operation's result it names the guard. No codemod: a refused divisor or radicand over a conditional takes the guard
  its refusal names.

#### A query's types no longer cost the size of its schema

- **A schema's type holds its statements by name**: the third type argument of `Schema<Name, Relations, Named, Base>`
  spells each relation the record holds under its name as that name, and `statements` reads every statement back
  whole, so `typeof S.statements` is the tuple the call wrote, as before. Every generic call over a schema used to walk
  every statement's relations again, so a program whose schema and queries grew together cost the square of its size:
  139 million instantiations at 200 relations with their queries, 13.5 million now. Codemod: a hand-written
  `Schema<N, R, St>` over a statement tuple becomes `Schema<N, R, StatementsByName<St, R>>`, the type `schema(...)`
  returns; the old spelling describes the same value and is assignable both ways. A wrapper that passes a schema's
  statements back to `schema(...)` states them as `St & StatementsWithin<St, R> & StatementsReadBack<St, R>`, and one
  that passes a base to `schema.extend` states `Base & { readonly statements: StatementsBelow<Base> }`; all three types
  are exported.
- **`db.page` is typed by the query passed**: `page<Q, A>(query, params, request)` returns `Page<A, Q>`, the cursors
  typed by that very query, and an unordered query is refused as "page needs an ordered query". No codemod.

#### A schema no write can fill is refused when it compiles

- **A field grizzle fills that reads a column its source fills after it is `UnfillableField`** (new reason), at the
  law that states it, naming the field, the law, the column it reads, the axis and why that column is later
  (`afterMembers`, `countedFill`, `cycle`, `unreached`). `grizzle generate` used to accept such a schema, and every
  nested insert then failed with `UnsupportedOperation at ChangeSet.insert`. No codemod: copy a column the owner fills
  before its members.
- **A relation no write fills is `UnwritableRelation`** (new reason): a counted family's member that is also a
  sequence's member, a tree's relation or a sequence's owner (`countedAndSequence`); ordered families that nest each
  other (`nestingCycle`); a key holding a generated field (`generatedKey`). Each used to compile, and its writes were
  refused.
- **Now written, where the first write used to be refused:** a counted family's copy of its owner's tree `end` or any
  other column a nested insert fills; a copy of a tree node's `end` along any owner axis; an insert of a tree that owns
  an ordered family; a predecessor or last copy of a generated field; appends to an immutable owner that is a tree
  node or a sequence member inserted in the same ChangeSet.
- A put or delete of a family's member that owns a sequence is still refused at the write.
- **A ChangeSet that would leave a family's derived value stale is `StaleDerivedRead`** (new reason) when it
  compiles: a put that changes a stored row's column, or an edit of a family that changes its owner's count or a
  column its last axis carries, or draws its members' index and copies again, where a fold step or filter, a
  predecessor or last copy, or a tree's copy of its parent reads that column, directly or through a cascade of copies,
  in a family the write doesn't redraw: a value of a family the owner is itself a member of, or one drawn from a copy
  the change reaches by cascade. It used to fail at execution when the per-row check or key fired before the value was
  refilled. The reason names the changed column and how it changed (`put`, `owner`, `member`), the copies it travels
  through and the reader. The refusal is decided from the schema, so it holds whether or not the owner has members
  yet. No codemod: derive the value from a column that is fixed once its row is written, such as the member's own
  caller field rather than its copy of the owner's, or a column of an immutable owner, which no put changes in place
  and whose families are fixed when it is inserted.
- **A ChangeSet that puts an owner, or edits one of its families, and appends members to another family whose copies
  read that owner's columns writes the owner's new values into the new members**, where it used to fail at execution.
  A copy that reads its owner's column through that owner's own copies is refused when the ChangeSet compiles
  (`CascadedCopyAppend`) if the same stratum changes the relation further up: apply that change in an earlier
  ChangeSet.

#### A schema compiles once, a pattern is analyzed once, and key text is bounded by bytes

- **A text pattern is analyzed once, where `str.regex` admits it**, and every later reader uses the language the
  descriptor carries: a schema with one long pattern in 300 keys compiles in under a second, where it took 131 s.
  ScalarType digests change; regenerate. No codemod.
- **`Compute.octetLength(text)`** bounds a contract's text in UTF-8 bytes (`octet_length`, IMMUTABLE). A key text is
  bounded by its pattern, its charLength (4 bytes a code point) or its octetLength, exactly, so a contract
  `(v) => Compute.octetLength(v).le(N)` makes any pattern a key. **`keyTextBytes(fields)`** gives the most bytes a text
  holds beside a key's other fields in one B-tree entry. A key's entry is counted at exact offsets through its
  fixed-width prefix, so a key refused just past the limit may now be accepted, and an entry that may hold a NULL
  counts its null bitmap. `UnrepresentableKey`'s `btreeEntry` fault gains `datums`. `keyTextBytes` leaves room for
  the null bitmap, 8 bytes, so a text at its result fits every index planned over those fields, a key over a
  selection, whose hidden columns may be NULL, and a family's axis included; for an axis, `fields` are its group
  fields, its natural index, the other values it carries and a tree's `end`. No codemod.
- **`str.bytes(n, pattern)`**: text of the pattern's language of at most `n` UTF-8 bytes. The bound is a refinement,
  not a type, so the field has its pattern's host type and meets every text its pattern meets, where an
  `octetLength` contract is a type of its own and refused a containment with an unbounded document text ("the sides'
  field types differ"). Its domain checks `octet_length(VALUE) <= n` before the pattern; a key reads `n` as its bytes
  exactly, so `str.bytes(keyTextBytes(fields), str.regex("^.*$", "su"))` is a key's text beside `fields`. A cast into
  it is proved only by an operand whose own bound is within `n`. A text Description gains `bytes` where the bound
  cuts the pattern's language; every existing schema's fingerprint and DDL is unchanged. The `language` premise of a
  proof gains `bytes`. No codemod; the octet contract stays for a branded type.
- **Every index the law model plans is bounded**: a containment's UNIQUE into a superkey, keys over selections,
  family UNIQUEs, WITHOUT OVERLAPS. Before, a containment into a superkey over an unbounded text installed a UNIQUE
  that failed at insert with 54000; now it is `UnrepresentableKey` when the schema compiles. A containment's reverse
  index never refuses free text: it is a B-tree over the longest leading run of its bounded referencing columns whose
  entry fits, PostgreSQL rechecking the rest, else a hash index on one column (`USING hash`), so free text among the
  referencing columns compiles as it did; referencing columns that leave no run that fits, each money, a set's
  `bit(n)` or a vector, which no hash index takes, are `UnrepresentableKey`. A PERIOD reference's GiST holds the
  leading bounded scalars that fit a GiST page, then its span, bounded by the GiST page where it was held to the
  B-tree limit. No codemod.
- **`grizzle migrate`, `drift` and `names` compile nothing.** Before connecting, migrate runs only `grizzle check`'s
  committed-file checks (names, meta.json and the chain, markers, losses, transaction control, literal packs against
  their digest). `grizzle check` and DbLayer.make still refuse a schema or login that does not compile. No codemod.
- **A schema compiles once per command**: DbLayer.make compiles the base's installation once for all roles, generate
  and check compile the law model and closed constants once, and `role()`, `workload()` and `login()` never encode a
  schema. At 150 relations with 20,000- and 200,000-row closed relations, check takes 11.8 s of CPU where it took
  81.3 s, DbLayer.make 8.0 s where 43.7 s, and workload() 30 ms where 13 s. No codemod.
- **Schema identity is a content digest taken at build**, used by every level check. Equal contents compare equal.
- **A closed relation's cells are admitted once, where they enter**: by `closed.relation()`, or, for a schema
  description from outside the builders, by one admission when it is decoded, so a cell outside its field's base type
  or roster is refused there. No compile re-validates a cell. A closed relation built over another roster of the same
  name as the schema's is refused by `schema(...)`. No codemod.
- **Fix:** a role holding every relation of a base that has closed relations is full for ChangeSets.
- **Generate:** a schema whose laws or closed constants don't compile is refused at step `schema` (it was `workload`
  when the schema had logins).

#### lcm's bound, an attached take's order, a role's EXECUTE, and a guard fit for its operand

- **`Compute.lcm` over numerics with fraction digits declares the integer digits it can reach**, `da + db + max(sa,
  sb)` where it was `da + db`: lcm(999.99, 999.98) is 99997000.02. A narrowing of such an lcm that compiled before may
  now be `PartialOperation` (fits). No codemod.
- **A query that ends in `.orderBy(...).take(k)` arrives in the take's order**, ties broken by its key, at the root
  (`db.query`, `db.compile`, a ChangeSet read-back) and as an attachment alike; before, a root take was delivered as a
  set and an attachment's children came in the child key's order. A take is still a set to whatever composes with it,
  and a derived relation or a role's query entry over a take is a set whose view is unchanged. No codemod.
- **A role holds EXECUTE on every constant its writes evaluate**, including a roster's or a set's domain constant
  reached only through a cast in a CHECK or a generated column. Before, such a role's plain insert failed with 42501.
  Regenerate migrations.
- **`PartialOperation.guard` is `{ remedy, text }`.** Its remedy is one Compute can write over the operand's type:
  a contract cast over a text, boolean, uuid or date names `typed` rather than `Compute.within`. Codemod:
  `reason.guard` → `reason.guard.text`.
- **A numeric whose scale exceeds its precision is bounded**: numeric(1, 1000) holds values below 10^-999, and
  arithmetic, sums and means over it carry that bound, where compiling such a field threw RangeError. `ceil`, `floor`
  and `round` of a value below one unit get a bound that holds, and a mean over an argument of more than 1000
  fraction digits gets one more integer digit, since its rounding can carry. No codemod.
- **Two bounds at one value meet at the open one**: `x.ge(0).and(x.gt(0))` proves `nonzero`. No codemod.
- **`Compute.numeric` refuses a text operand** (`UnsupportedOperation`, naming `Compute.cast` and the lexical form):
  it used to compile in the engine where the types refused it. No codemod: cast the text through its lexical form.
- **A span's `lower`, `upper` and `width` take the span's own endpoint descriptor**, and a cast between spans whose
  endpoints are different types or contracts is refused, in the types as in the engine. No codemod.
- **Fix:** a concurrent-change abort (40Z01) is classified only when its DETAIL names a stored relation of the
  installation; any other relation is no witness of it.
- **`min`, `max`, `least` and `greatest` over a contract are that contract**, in the engine as in the types; before,
  the engine typed the result as the contract's base type. No codemod.

#### One canonical form for a comparison and an IN list

- **A check's predicate and a selection state each comparison in one orientation**: a bare literal second, `gt` and
  `ge` between two terms as `lt` and `le` with the terms swapped, `eq` and `ne` with their terms in canonical order; an
  IN list's values are a set, in canonical order, each once. Statements that differ only so are one statement and one
  law: `select(T, (t) => t.gt(t.a, t.b))` and `select(T, (t) => t.lt(t.b, t.a))` install one generated column and one
  constraint, where they installed two. Each mirror is PostgreSQL's commutator of its operator, so the two
  orientations agree on every value, NULL and NaN included. A reported `Law`'s selection conjuncts appear in this form.
  A description that states a comparison literal first now compiles. No codemod.
- **Format and state:** schema fingerprints, and the installed names of laws, law columns and constraints over such
  predicates, change. Regenerate migrations and re-create databases, as every entry here asks.

#### Text translates and collapses: `Compute.translate`, `.lowerAscii`, `.replaceWhitespace` and `.collapse`, casts into a refined text by language inclusion

- **`Compute.translate(x, from, to)`** is PostgreSQL's `translate` (IMMUTABLE), by characters: each character of `x`
  that `from` holds becomes the character of `to` at its position. `from` and `to` are strings of one length, `from`
  holding each character once; PostgreSQL would delete a character `to` has no counterpart for and map a repeated one
  by its first occurrence, so either is `MalformedDescription` where the call is written, and so is a term as either.
  **`Compute.lowerAscii(x)`** is `translate` from `A` to `Z` onto `a` to `z`, ASCII's case fold, which lowers no other
  letter, so it is one map whatever the collation. The term is text of the image of `x`'s language under the map: its
  pattern with every class and character rewritten, prefixed and suffixed by the image of every admitted character
  where it is unanchored, so a bounded pattern stays bounded and keeps its key representable; where that pattern
  passes grizzle's measures of PostgreSQL's regex compile space, the rewrite of `x`'s pattern alone, which holds every
  value of the image. The host translates by code points and agrees with PostgreSQL exactly. It stands in checks,
  contract predicates and generated fields, and in a query over a text whose pattern bounds it within 268,435,454
  bytes, since PostgreSQL's translate allocates four bytes for each byte of its operand and past `MaxAllocSize` raises
  54000 (`UnsupportedOperation` otherwise). No codemod.
- **`Compute.cast(x, T)` into a regex-refined text `T`** compiles where `x`'s language lies inside `T`'s, proved on the
  two languages' minimal automata as a parse's lexical form is; before, a text term other than a literal or a parameter
  never did. A pair of languages whose comparison passes grizzle's bounds, 2,048 DFA states or 2,097,152 NFA-state
  visits, is now `ResourceBound` with the new bound `regexInclusion`, naming both patterns and the bounds, where a
  parse's was `PartialOperation`. No codemod.
- **A key or containment over a selected side whose term or selection reads a generated field** installs: each law
  column reads such a field as the field's own generation, since PostgreSQL refuses a generation expression that reads
  a generated column (42P17); before, the installation's `ALTER TABLE ... ADD COLUMN` failed. No codemod.
- **`Compute.collapse(x)`** is XML Schema's whiteSpace collapse, `btrim(regexp_replace(x, '[ \t\n\r]+', ' ', 'g'))`,
  both IMMUTABLE (pg_proc), the bracket of four literal characters reading no collation: each run of tab, LF, CR and
  space one space, none at either end, and every other character, a no-break space included, as it is. The host
  collapses by code points and agrees with PostgreSQL exactly. The term is text within `x`'s length bound: exactly the
  image of `x`'s language for a pattern with no white space (its own) and for a class repeated freely, `^[...]*$`
  (every collapsed text over its other characters); and more than the image otherwise, every text of at most n
  characters beginning and ending with another character for a pattern bounded within n ≤ 257, and every collapsed
  text over its characters for any other. **`Compute.replaceWhitespace(x)`** is whiteSpace replace,
  `Compute.translate(x, "\t\n\r", "   ")`. No codemod.
- **A query matches or collapses only a text whose pattern bounds it within 268,435,454 bytes** (the new limit
  `regexTextMaxBytes`): PostgreSQL's regex engine widens its subject to four bytes a byte before `~` or `regexp_replace`
  reads it and raises "invalid memory alloc request size" past `MaxAllocSize`. A `Compute.matches` in a query, a match
  guard's included, over a text of no such bound is now `UnsupportedOperation`; before, the read raised on such a value.
  A check, a law's selection and a generated field match any text, and a write of a longer one fails. Bound the
  subject's pattern, such as `str.regex("^.{0,255}$", "su")`. No codemod.
- **Format and state:** a snapshot names the compute functions `translate` and `collapse` where a schema uses them; the
  law column of a selected side over a generated field prints its generation in place of the field. No other change.

#### Text parses into a typed value: `Compute.cast` from text, `lexical(T)` and `lexicalForm(T)`, and a `date` type

- **`Compute.cast(x, T)` over a text `x`** is a parse: PostgreSQL's cast from text into an integer type,
  `pg.numeric(p, s)`, `pg["double precision"]`, `pg.boolean` or `date`, read as XML Schema reads `xs:integer`,
  `xs:decimal`, `xs:double`, `xs:boolean` and `xs:date`. Each type has one lexical form, `lexicalForm(T)`, a pattern
  under `"u"`, and `lexical(T)` is the text field of it: XML Schema's lexical space cut to the values `T` holds
  exactly, so the cast never raises and never rounds (a bigint's 19th digit, numeric(p, s)'s digits either side of its
  point, a double's 15 significant digits and an exponent of at most 293, the Gregorian leap days, no timezone). The
  cast compiles exactly when every value of its operand is a member: the operand's pattern's language inside the
  form, which compilation proves on the two languages' minimal automata, or a `Compute.matches` guard by the form.
  Otherwise it is `PartialOperation` with the new precondition `lexical`. It prints as `::T`, numeric's typmod
  included, and a date's as `make_date` over the text's parts, since `text::date` is STABLE; every part is IMMUTABLE,
  so a typed value derived from its lexical form is an ordinary generated field. A type with no form, uuid and money
  among them, has no cast from text, by type and at compile time. No codemod.
- **`date`** is a new field type: PostgreSQL's date under the builtin contract `date`, whose domain admits
  0001-01-01 to 9999-12-31, its host value `CalendarDate`, the ISO 8601 text, its one form. It compares, takes `min`
  and `max`, and keys and indexes. It has no span yet, though PostgreSQL has `daterange`: `span(date)` is refused, by
  the types and with `UnsupportedOperation` (`spanEndpoint`), a limit the README states. No codemod.
- **Every login pins `DateStyle = 'ISO, YMD'`** beside `extra_float_digits = 1`, stored as its default and sent in its
  startup options, so PostgreSQL writes a date as its host text. A login of an existing database lacks the default
  and `Db.open`'s admission refuses it until a migration stores it: regenerate and re-create as every entry here asks.
- **Format and state:** a snapshot names the carrier `date` and the literal kind `date` where a schema declares one;
  no other installation, snapshot.json or meta.json changes, but each login's stored defaults, which gain `DateStyle`.

#### Text has terms: `Compute.matches` over a pattern term, `.concat`, `.startsWith` and `.endsWith`, and `Monoid.concat` folds a sequence

- **`Compute.matches(x, pattern)`** is PostgreSQL's `~` (textregexeq) over text, in a check, a selection, a generated
  field, a law column and a query's `where`. Its pattern is in `str.regex`'s grammar under the flags `"u"`: a string,
  checked at the type level as `str.regex` checks its own and admitted where the call is written, or a text term whose
  every value the schema holds, a closed relation's text payload (`ValueDomain.at("pattern", domain)`) or a
  `Compute.cond` of such terms. Every value is admitted when the schema compiles, by the one admission a `str.regex`
  pattern passes, its grammar and grizzle's measures of PostgreSQL's regex compile space, and refused with its reason
  naming it (`ResourceBound` `regexCompileSpace` with `pattern: "/<source>/u"`); a field, a parameter or a computed
  pattern is `UnsupportedOperation`. The SQL holds each value's ARE in its place: a literal's as a literal, a
  dictionary's as `CASE <pattern> WHEN '<source>' THEN '<ARE>' … ELSE <pattern> END`, whose ELSE keeps an absent
  key's NULL. The host evaluates it by the pattern's own automaton. A match is a guard too: `Compute.when`'s branch
  reads its subject as text of a literal pattern's language. No codemod.
- **`Compute.concat(a, b)`** is `a || b`, text of no pattern, in checks, contract predicates, generated fields and
  folds; a query holds one only as a side of `Compute.eq` or `Compute.ne`, which lowers to
  `char_length(t) = char_length(a) + char_length(b) AND starts_with(t, a) AND right(t, char_length(b)) = b` and never
  builds it. **`Compute.startsWith(a, b)`** is `starts_with`, and **`Compute.endsWith(a, b)`** is
  `right(a, char_length(b)) = b`, since PostgreSQL has no `ends_with`. No codemod.
- **`Monoid.concat`** is text's free monoid: the empty text, then each step after the running text. It folds an
  ordered family or a tree by its named `(before, after)` pair, its combine the CHECK `(after = before || x) IS TRUE`,
  decided as the equation above; a counted family, whose order is hidden, and a hidden pair are refused, by type and at
  compile time. A separator belongs to the step: a member's token with the separator before it, but at index 0. A
  migration that adds one backfills its running text as `string_agg(x, '')` over the family's window in slot order,
  ROWS from the first slot.
  - Codemod: a type test naming the refusal "the monoid admits the step value's type: …, max an ordered value with a
    least one" → "…, max an ordered value with a least one, concat a text".
- **Format and state:** none. No existing schema's installation, snapshot.json or meta.json changes.

#### Closed relations are erased into constants, a family is a law over the rows you write, a tree is an interval tiling, and every rename and drop is declared

- **A roster's handles are smallint codes.** `closed(name, handles)` installs no enum. A closed id is a `smallint`
  under the roster's domain, whose one CHECK reads the roster's names constant, an IMMUTABLE function returning its
  handles as `name[]` in code order: `((names())[VALUE + 1] <> ''::name) IS TRUE`. Codes are given in declared order
  and recorded in snapshot.json: a new handle takes the next code, a renamed one keeps its own, a removed one leaves a
  hole no handle takes again, and a roster declared out of its codes' order is refused (`generate` at the stage
  `codes`). The API still reads and writes names. Each role's view adds a decoded column `<field>_name` beside each
  closed id; a roster among a role's entries has no view of its own. A closed id's claim in `grizzle.claims` holds its
  handle's code.
  - Codemod: `EnumClosed<N, H>` → `Roster<N, H>`; `Closed<N, H, P>` → `Roster` for its handles and `ClosedRelation`
    for a payload (below); `AnyClosed`, which now holds closed relations too, → `AnyRoster` where a roster is meant; a
    psql reader of a closed-id column reads `<field>_name` in a role's view; a direct writer writes the handle's code,
    `array_position(<names constant>(), '<handle>') - 1`.
- **`closed.relation(name, fields, key, rows)` is the one closed relation, and a roster's `.with(payload, facts)` is
  gone.** Its rows are fixed when the schema compiles, its key is a required list of closed-id fields (a set lists every
  field), and no two rows share a key, a type error for a literal list of them. It installs no table, enum or VALUES
  template: each closed relation or side a rule or query reads is a content-addressed IMMUTABLE constant, a bit string
  indexed by its key's codes in mixed radix, which PostgreSQL folds into each statement. Every rule that reads one from
  an open row is a table CHECK on that row's table, named by its rule, and a query's membership test is one cell read.
  `C.at(field, …key)` reads a payload field, NULL where no row holds the key, and `C.row(…prefix)` the set of the last
  key field's completions, in a row check, a selection or a generated field. A rule over closed relations alone is
  checked once, by PostgreSQL, at the start of the migration that installs them, as a DO block raising 23000 named by
  the rule, when it is new or its closed rows changed. A containment from a closed relation into an open one is
  refused.
  - Codemod: `closed("K", hs).with(payload, facts)` → the roster `closed("K", hs)` beside
    `closed.relation("KPayload", { k: closedId(K), ...payload }, ["k"], rows)`, one row per fact with its handle at
    `k`; a row check that read the payload reads `KPayload.at("<field>", r.k)`.
- **A closed relation's key field may hold slots: `slot(closedId(R), fin(O, "n"))`.** `fin(O, "n")` takes a closed
  relation `O` and a natural field `n` of it beside its key, as well as an ordinary relation's drawn count. A slot
  field's codes, for each owner, run from 0 below the owner's count, `O`'s key pairing with the key's first fields,
  roster for roster, and the relation's constant is a dependent sum: each owner's block, at its own counts, after the
  blocks before it, so a key over each model's positions holds Σ n² cells instead of the product of the widest. The
  installation adds two owner functions over the prefix, each owner's first cell and each count, and every read
  computes the cell in SQL, a slot code at or past its owner's count reading absent. A row past its owner's count, a
  count past the slot roster's codes, an owner key that does not pair, a slot inside the owner prefix, two owner
  prefixes, a slot in a payload or in an ordinary relation, and a family over a closed relation's fin are refused. A
  changed count replaces every constant of the space; a grown or renamed slot roster replaces none.
  - Codemod: none needed; a key with no slot is the product it was.
- **A closed relation's pack lists each row at its cell, and a cell holds at most 2,147,483,647 payload codes.** The
  migration's DO block joins `(cell, payload code)` rows, the cell the host's encoder gives the key, where it joined the
  key's codes in mixed radix, so every read's index, which PostgreSQL computes, is checked against the host's on every
  read. A relation whose payload fields' codes multiply past 2,147,483,647, the most a cell read as an integer holds, is
  refused when the schema is compiled, with `ResourceBound` (`cellCodes`), where its reads used to fail at run time with
  22003.
  - Codemod: none; regenerate the migrations.
- **A closed relation's rows are a set: a row written twice is one row.** `closed.relation` refused an identical
  repeated row as a second row of its key; it now states it once, in its value's `rows`, its description and its
  constant, whose digest and row count are the set's, so a repeat installs nothing more. Two rows of one key with other
  payloads are still refused (MalformedDescription), naming the key and both payloads, as the type checker refuses them
  where the rows are literals.
  - Codemod: none.
- **A family axis's key is held to the key representability rule.** The UNIQUE a family's owner, predecessor or
  last axis references, over the family's key and the copies it carries (a fold's running values among them), is
  bounded as a declared key is: its B-tree entry counted from each column's type within BTMaxItemSize, beside the
  INDEX_MAX_KEYS bound it already met. An axis past it is refused with `UnrepresentableKey` when the schema is
  compiled, naming the UNIQUE, the family and the fold whose accumulator it carries, where a `Monoid.concat` fold over
  unbounded text used to compile and fail its first long write with 54000 (ExecutionFailure). A set it carries is
  counted by the law model at its roster's live handles and by the installation at its roster's codes, removed
  handles' included, which only the installation's codebook holds, so a roster pruned past the entry refuses the UNIQUE
  when the installation is compiled.
  - Codemod: none; type a concat fold's step and accumulators by a bounded pattern, such as
    `str.regex("^.{0,64}$", "su")`, or a `charLength` contract.
- **A closed relation declares how its migration packs it: `closed.relation(name, fields, key, rows, { pack: "hex" })`.**
  `pack: "rows"`, the default, lists its rows, a line each with the handles it holds, for a person to review;
  `pack: "hex"`, for rows a machine builds, states each of its constants as one statement,
  `CREATE FUNCTION f() RETURNS bit varying … RETURN X'…'::bit varying || B'…'::bit varying`, the binary part only for
  the zero to three bits past the last hex digit, under a comment of its row count, cells, width and content digest. A
  pack whose statement of rows would pass 536,870,888 bytes (`rowsPackMaxBytes`, the lesser of PostgreSQL's longest
  message and V8's longest string, which the migration file is built as), or whose DO block would EXECUTE a statement
  past 1,073,741,822 bytes (`stringBufferMaxBytes`, one PostgreSQL string buffer, past which the pack failed as it ran),
  is hex whatever is declared. A constant two relations share is listed as rows where either declares rows, and a side a
  containment reads is stated as its relation declares. The form is no part of a constant's identity: either form
  installs the same string, so a change of form drafts a folder of no file that records it, and replaces no constant
  and none of its readers. `grizzle check` decodes every literal pack and refuses one whose literal does not digest to
  its comment's content and its function's name, or holds other than the rows its comment counts, naming the file, the
  statement, the closed relation, and the first cell where it parts from the schema's rows with that cell's key
  (`literalPack`). Follow over 1,217,966 rows drafts 507,520 bytes and installs in 35 ms as hex, 65,419,623 bytes and
  7 s as rows. A closed relation's value states its `pack`; options of another property or form, or a sixth argument,
  are refused (MalformedDescription), and by type.
  - Format: a closed relation's description holds its `pack`, and a snapshot's pack its `form`, its rows or its
    literal.
  - Codemod: none; a relation without options lists its rows, as it did. Regenerate the migrations.
- **A set of handles is `bits(R)`.** A `bit(n)` column, one bit per code, under a bits domain whose CHECK,
  `((VALUE & live()) = VALUE) IS TRUE`, admits only live handles, `live()` derived from the names constant. Its host
  value is `Bits<typeof R>`, a frozen `ReadonlySet` of handles that `Bits.of(R, handles)` makes. `Compute.union`,
  `.intersection`, `.difference`, `.cardinality`, `.subset` and `.disjoint` are its algebra, with no complement; the
  second operand of a binary one is a set term of the first's roster or a set value, `Bits.of(R, handles)`, a literal
  that takes the first operand's type, so its bits are its handles' codes. A key holds no set. A roster that grows
  converts its set columns to the wider domain in place, the new handles absent. No codemod.
- **Every field says how it is written.** `relation.generated(name, written, primaryKey, (r) => ({ f: generated(type,
  term) }))` declares STORED generated fields, `r` holding the fields its caller writes alone, no generated, drawn or
  accumulated one, by type and, for a JavaScript caller, by `GeneratedRefused` (`readsUnwritten`) when the schema is
  compiled, where reading one failed in the builder as a literal standing first; `drawn(natural)` is a count, an
  index or a tree's interval that grizzle draws; `accumulated(type, start)` is a fold's end or accumulator, or a copy
  along a family's axis. An insert and a put take `Written<R>`, the fields the caller writes, never a generated, drawn
  or accumulated one; a fact and a query's row hold every field. A primary key holds no set, generated or accumulated
  field. No codemod.
- **`capacity`, `within`, `weigh`, `ref` and `duration` are deleted, with the residual capacity family.** A count is a
  drawn field of its owner, and its bounds are row checks:
  - `fin(O, "n")` is the slots of O's drawn count; `ordered(on(F, g…, "at"), fin(O, "n"))` indexes each owner's
    members by their drawn `at` exactly 0 … n − 1; `counted(on(F, g…), fin(O, "n"))` is each owner's n members, an
    unordered set of rows one per member key, their index a hidden coordinate the proof counts by, never a
    multiplicity.
  - `fold(family, Monoid.m, step, end)` combines the members' step values into the owner's accumulated end fields,
    over `Monoid.count`, `.sum` (an integer type or a numeric, never a float or money), `.or`, `.twos` and `.max`.
    Every fold's running value is a drawn column grizzle fills and PostgreSQL proves,
    `CHECK ((after = combine(before, x)) IS TRUE)` in exact arithmetic, and each starts at its monoid's identity. A
    fold over a counted family names no running value: it would show the hidden order.
  - A relation is a member of at most one ordered family or tree, and of any number of counted families, each with its
    own hidden columns and foreign keys.
  - Codemod (`n: drawn(natural)` added to the target, and `mutable(T)` where its rows' count changes after it is
    inserted): `capacity(on(T, k…), { from: on(S, f…), within: within(0n, 1n) })` → `key(on(S, f…))`, or over a
    selected source `key(on(select(S, φ), f…))`; at least one, a count in bounds, or a count against a field →
    `counted(on(S, f…), fin(T, "n"))` and `check(T, (t) => …)` over `t.n`; `weigh("w")` →
    `fold(family, Monoid.sum, on(S, f…, "w"), on(T, k…, "total"))` with `total: accumulated(type, 0)` on T, and the
    bound a check over `total`; a count of a selection → `fold(family, Monoid.count, on(select(S, φ), f…), …)`; a
    `duration` → a generated field `upper − lower`, then weighed; a program that switches over `Law["kind"]`
    exhaustively drops `"capacity"`.
- **`tree(on(T, "parent", "at"), fin(T, "children"), { root: r })` is a tree as an interval tiling.** T is an ordered
  family over itself, every row but its self-parented root a member, with drawn `at`, `children`, `start` and `end`.
  Seven native laws, T0 to T6 (the root copy, `UNIQUE (r, start)`, the one root at start 0, a first child at its
  parent's start + 1, a next sibling at its predecessor's end, a last child closing its parent, non-empty intervals),
  make each value of r one tree in pre-order: every row reachable, none on a cycle, and `[start, end)` exactly its
  pre-order interval. A tree in order is one index scan by `start`, and a row's descendants are a range of `start`,
  with no recursion. No codemod: a rank (`depth` and its `pred(depth)` containment) proves nothing the intervals don't.
- **Rows first: a family is never a write shape.** A sequence's members (an ordered family's or a tree's) are nested
  under their owner, in order, at its count field, each without its group and drawn fields, which a nested member at
  any depth may not state, nor a field its relation lacks: a type error, checked through every nesting, and from
  JavaScript an `EncodingFailure` (`factShape`) before any SQL, where a stated drawn or accumulated value used to be
  dropped unsaid; an insert of an ordered member alone is a type error. A counted member is a row whose group key
  names its owner, inserted, put and deleted like any row. A family's member is written from an array or a Stream,
  never a query or a query entry. A tree is written whole, by inserting its root with the tree nested; a put or delete
  of a tree's row is refused. An immutable owner's family is fixed when the owner is inserted: a delete of its
  member is refused before any SQL. Every change to one owner's family is one edit, which grizzle refills from the
  first slot it touches, and an edit of a stored
  group reads its stored values first: the apply sends two flights in its one transaction, the reads and then the
  writes, and a 40001 at either is a `TransientFailure` grizzle never retries. A role that writes a family's member
  holds column SELECT on what the read reads of the owner and, when the owner is mutable, column UPDATE on that
  family's drawn count and accumulated ends on it, and nothing else of the owner.
  - Codemod: a capacity's target and source written as two inserts stay two inserts for a counted family; an ordered
    family's members move under their owner's insert, `insert(O, [{ …o, n: [m₁, m₂] }])`, each member without its
    group or index.
- **An insert or a put of an owner from a query is refused beside an append to its family: `QueriedOwnerAppend`.** An
  owner the ChangeSet inserts and appends members to holds its final count and ends in its own row, which grizzle
  draws on the host from the facts the ChangeSet states, since PostgreSQL checks a row's CHECKs as it inserts the row.
  An insert or a put whose facts come from a query states none, so it inserted the owner at its starts, its count 0 and
  each end at its monoid's identity, and a row check over an end, such as an invoice's lines summing to its amount,
  refused a lawful final state as `invariant-rejected`. Such a write, in a ChangeSet that inserts or puts a member of a
  counted family the owner owns, is now a `CompileError` when the ChangeSet is compiled, whose reason
  `QueriedOwnerAppend` names the write (`at`, and `op`, `insert` or `put`), the `owner`, the `family`
  (`{ owner, count }`) and the appended `member`. A write whose every fact carries a stored owner's key inserts no owner
  and compiles, as does every other.
  - Codemod: none; state the owner's facts from an array or a `Stream`, or write the owner in a ChangeSet that
    `ChangeSet.sequence` runs before the one that appends.
- **A put or a delete of a relation whose primary key holds a field grizzle writes is refused: `UnstatedKey`.** A put
  names each row by its primary key, and a family's edit names each member by it, so a sequence's member keyed by its
  owner and its drawn index, `["owner", "at"]`, names no row its caller can state; its put or delete reached the host's
  same-key check and the family's edit without the index and failed as an internal invariant. A put's same-key check
  compares its facts at every declared key too, the primary key's first, so a key declared over the index beside an id
  failed there the same way. Each is now a `CompileError` when the ChangeSet is compiled, whose reason `UnstatedKey`
  names the write (`at`, `op`), the `relation`, the `key` (`{ kind: "primary" | "declared", fields }`) and the fields no
  fact states (`unstated`). A delete compares no declared key, so only its primary key is read.
  - Codemod: none; key such a member by fields its caller writes, such as an id, to put or delete it, declare no key
    over a field grizzle writes, and insert a sequence nested under its owner.
- **No residual law remains.** grizzle installs no law function and no constraint trigger, and the residual-law
  engine, the `lawFunction` and `lawTrigger` snapshot objects and the law trigger names are deleted. `alternatives` is
  its containments: one from each arm into its parent at its handle, and one from each handle's parent rows into its
  arm, a generated column `CASE WHEN tag = h THEN id END` and a foreign key deferred to commit. Coverage from a
  selected side is a native PERIOD foreign key over generated range columns, and coverage into a target with no
  `WITHOUT OVERLAPS` key over its span is refused. A foreign key over spans, or an arm's, is no longer always
  deferred: one is deferred when its target has a field it does not reference or it lies on a cycle, and a family's
  axes as its proof needs (a counted predecessor and every last-slot key). SQLSTATE 23000 at COMMIT is gone.
  - Codemod: a program that switches over `Law["kind"]` exhaustively drops `"alternatives"` and `"alternativesArm"`
    and gains `"family"`, `"tree"` and `"fold"`; a match on `alternatives` or `alternativesArm` matches `contained` by
    its `from` side.
- **An outcome names its laws: `invariant-rejected` carries `laws: NonEmptyReadonlyArray<Law>`.** It is the one law
  the failing constraint states, or, where one PostgreSQL object discharges several and its report does not say which
  failed, each of them: a family's foreign key carries every containment merged into it, and one domain serves every
  contract and pattern of one definition. The new law kinds are `family` (`order`, `member`, `slots`), `tree`
  (`member`, `slots`, `root`) and `fold` (`family`, `monoid`, `step`, `end`).
  - Codemod: `outcome.law` → `outcome.laws`, a match on one law → `outcome.laws.some((law) => …)`.
- **A ChangeSet's facts of one relation are a set.** Identical facts are one fact, nested ones included; two of one
  key that differ elsewhere are `invariant-rejected` on that key before any SQL, and a literal list of them is a type
  error (exact up to 1,024 literal facts). An aggregate reads each row its rule matches once, by its key: every match
  of a rule with an aggregate binds a whole key of its source, or the query is refused with the new CompileError
  reason `FoldOverProjection`, naming the match and the key to bind. To aggregate distinct values, match a query of
  them.
  - Codemod: a rule that aggregates over a match binding no key binds the key (`v(Comment, "c").id` in the match), or
    matches a query of the distinct values as its source.
- **A contract's and a pattern's domain is named by its definition**, `__domain_<digest>` and `__text_<digest>`, so
  identical definitions share one domain. No codemod.
- **Every rename and drop is declared.** `grizzle generate` takes `--rename <old>=<new>` and `--drop <old>`, once per
  name, each side a relation or roster (`Task`), a field (`Task.title`), a roster's handle (`Status#done`) or a login
  (`@web`). A draft guesses no rename: a name the snapshot holds and the schema does not, which no declaration names,
  is refused as the new CompileError reason `UndeclaredDrop`, naming it, and `check` refuses it the same way. A
  generated, drawn or accumulated field, a derived relation and a role need no declaration. A renamed relation or field
  is renamed in place, through an aside name, so swaps and chains are free; a renamed handle keeps its code; a renamed
  login is its PostgreSQL role renamed in place, `ALTER ROLE ... RENAME TO`, keeping its OID, password and grants. A
  declared drop is drafted live. The rename candidates, their `-- grizzle: rename candidate` markers, and every data
  loss but a schema's first migration beside an abandoned schema are deleted; a holder set aside is a
  `-- grizzle: confirm` group. `--schema` is required beside `--rename` or `--drop` where the configuration lists
  several schemas.
  - Codemod: a reviewer's chosen rename → `--rename <old>=<new>` on the `generate` that drafts it; an uncommented
    drop → `--drop <old>`.
- **A family added to stored rows is backfilled** in the migration that adds it, from SQL over those rows: each index
  in member-key order, each count, each fold's running values and each tree's intervals, under placeholder defaults,
  before its constraints are added `NOT VALID` and validated. A family whose values the stored rows alone don't give
  is refused, naming it. No codemod.
- **A role holds EXECUTE on every constant its statements call**, PostgreSQL checking EXECUTE as the invoker: the names
  constants its domains and decoded columns read, and the closed constants its tables' CHECKs, generated fields and
  queries read. USAGE covers roster and set domains. No codemod.
- **Format and state:** snapshot.json changes: a roster records its codes, a closed relation leaves no theory record, a
  law over closed relations alone is a migration law with its digest, the law functions and triggers are gone, and
  every family's hidden columns, constraints and constants are new objects; meta.json records the folder's
  declarations and no candidates; every fingerprint changes. A previous snapshot.json or meta.json is refused, never
  read: re-create every database (step 3 above).

#### A side is a partial projection: `select` takes a predicate, `key` takes a side, `pred` reads a `natural` count, and `mirrors` is two containments

- **`select(R, (r) => φ)` is the one spelling of a selection.** φ is a row check's condition over R's own fields, any
  condition `check` takes, where a selection held only equalities of fields to literals. The record form is gone, and
  so is `Selection`'s second parameter: `Selection<R>` holds no bindings, and an `alternatives` arm's attachment is
  typed Some or None from the `alternatives` law it reads. Both sides of a containment may be selected.
  - Codemod: `select(R, { f: v })` → `select(R, (r) => r.eq(r.f, v))`; `select(R, { f: v, g: w })` →
    `select(R, (r) => r.and(r.eq(r.f, v), r.eq(r.g, w)))`, a closed id compared with its handle's name
    (`r.eq(r.kind, "Manual")`); `Selection<R, B>` → `Selection<R>`.
- **`key(side)` states a key over a side.** Over a table's own fields it is a candidate key, as `key(R, fields)` was.
  Over a selected side or a `pred` term it holds apart only the rows its side reads: it is no key of the table, so
  `KeysOf` leaves it out, and an outcome names it as the new law kind `{ kind: "projectedKey", side }`. `Key<R, F>` is `Key<S>`, whose `side` replaces `relation` and `fields`, and a key
  in key position is `KeyRef<R> = R | Key<Side<R, ReadonlyArray<string>>>`.
  - Codemod: `key(R, ["a", "b"])` → `key(on(R, "a", "b"))`, a template-built call included; `Key<R, F>` →
    `Key<Side<R, F>>`; `k.relation` → `k.side.source` and `k.fields` → `k.side.terms`; a program that switches over
    `Law["kind"]` exhaustively gains `"projectedKey"`.
- **`natural` is a count.** A field type: the builtin contract `natural` over `pg.bigint`, `CHECK (VALUE >= 0)`, whose
  host type is `bigint`, unbranded. Its domain refuses a negative value as the law
  `{ kind: "contract", contract: "natural" }`, and another contract under its name is DuplicateIdentity.
  - Codemod: a count declared `pg.bigint` under a row check `(r) => r.n.ge(0n)` → `natural`, deleting the check; a
    count declared as a contract `contract("Count", pg.bigint, (c) => c.ge(0n))` → `natural`, writing its values as
    plain `bigint`s (`Count(3n)` → `3n`) and matching the outcome on `contract: "natural"` where it matched
    `"Count"`.
- **`pred(n)` is ℕ's predecessor, a side's term.** Over a `natural` field n it reads n − 1 and is defined only where
  n > 0, so a row whose n is 0 has no tuple on the side: `contained(on(Place, "show", pred("at")), on(Place, "show",
  "at"))` gives every place after the first the place before it. `pred` of any other field is a type error, and
  MalformedDescription for a caller the types don't reach. A side's terms are `Side`'s `terms`, each a field's name
  or a `Pred`, where its `fields` held names alone.
  - Codemod: `side.fields` → `side.terms`; `Side<R, F>` keeps its parameters, F now a tuple of terms.
- **`mirrors(a, b)` is sugar for `contained(a, b)` and `contained(b, a)`.** The schema states the two containments in
  its place, so `LawsOf` and `ContainmentsOf` read two containments and each lowers as any containment does; one stated
  beside it is the same law stated twice. The law kind `mirrors` is gone: an outcome names the broken half as
  `contained`, and `coverage` loses its `statement`.
  - Codemod: a match on `law.kind === "mirrors"` → `law.kind === "contained"`, by its `from` and `to`; drop
    `statement` from a match on `coverage`; a program that switches over `Law["kind"]` exhaustively drops `"mirrors"`.
- **A law side's `selection` is `{ kind: "all" }` or `{ kind: "where", predicate }`**, the predicate as its canonical
  text, equal for equal predicates; `fields` names a `pred` term as `pred(<field>)`.
  - Codemod: `selection: []` → `selection: { kind: "all" }` in a match; a match on `selection[i].field` and
    `selection[i].value` → a match on `selection.predicate`.
- **Every side lowers to PostgreSQL's own constraints.** Each term of a selected side, and each `pred` term, is a
  STORED generated column, `CASE WHEN φ THEN t END`, where `pred(x)` is x − 1 under x > 0. A key is
  `UNIQUE NULLS DISTINCT` over its side's columns, and a containment `FOREIGN KEY … MATCH SIMPLE` from its source's
  columns, which are indexed, into a UNIQUE over exactly its target's: a row whose side reads no tuple holds nulls
  there, which both pass. A containment's target holds a key, a candidate key among its fields or a key over the same
  selection among its terms; any other target is UnsupportedLawFamily. Every generated statement spells `STORED`,
  `NULLS DISTINCT` and `MATCH SIMPLE` out. A foreign key is deferred when it is an `alternatives` arm's or over spans,
  or when its target has a field that is not one of the columns it references, or it lies on a cycle of foreign keys.
  No codemod; constraint, column and index names change.
- **The selected-source containment and conditional mirrors residual families are deleted**, with their law functions
  and constraint triggers. Such a containment, a mirrors with a selected side among them, is a foreign key: PostgreSQL
  refuses its violation as 23503, at the statement or, deferred, at COMMIT, where its trigger raised 23000 at COMMIT.
  Three residual laws remain: a capacity, a coverage from a selected source, and an `alternatives` law's reverse
  obligation. A capacity's or a coverage's selection is a conjunction of `field = literal`; any other predicate there
  is UnsupportedLawFamily. No codemod.
- **An at-most-one capacity is no longer a unique index.** A capacity counting at most one source row per target,
  `within(0n, 1n)`, lowered to a unique index over its source, partial where the source was selected. That lowering is
  deleted: such a capacity is a residual law, checked at COMMIT by its triggers. A key states the rule natively.
  - Codemod: `capacity(on(T, k…), { from: on(S, f…), within: within(0n, 1n) })` → `key(on(S, f…))`, and over a
    selected source `on(select(S, φ), f…)` → `key(on(select(S, φ), f…))`. The two agree where
    `contained(on(S, f…), on(T, k…))` holds; without it, the key also holds apart the source rows no target names.
- **Format and state:** snapshot.json changes: a stored tag's object is a `lawColumn`, the law column of a constant, a
  selected term or a `pred` term; the deleted families' functions and triggers and the at-most-one unique indexes are
  gone; and every UNIQUE and FOREIGN KEY text changes. A previous snapshot.json is refused, never read: re-create
  every database (step 3 above).

#### A table no role writes through a query entry that leaves rows out has no row-level security and no policy

- **Row security stands on exactly the tables some role writes through a query entry that leaves rows out.** Each
  role that writes such a table holds a policy on it, `FOR ALL TO <role> USING (m) WITH CHECK (m)`: the entry's
  filter, or `true` for a role that writes the table whole or through a query entry that holds every row. Any other
  table has no policy and no `ENABLE ROW LEVEL SECURITY`: each of its policies would be `true`, which admits exactly
  what the role's grants admit, so the grants alone decide its writes. Before, every writable entry installed a policy,
  `USING (true) WITH CHECK (true)` for a whole entry, also on a table whose row security was never enabled. `Db.open`
  requires row security enabled and not forced on each table a role writes through a query entry that leaves rows
  out, and the drift check compares the policies that remain. A direct writer meets the same rows and the same
  refusals. No codemod.
- **Format and state:** snapshot.json holds no policy for a table every writer writes whole, so its fingerprint
  changes. Re-create every database (step 3 above).

#### A connection is pure mechanism: the driver, transport, connect timeout and pool are yours

- **`DbConnection` is `{ driver, transport, database, password, connectTimeoutMs }`, and `DbConfig` adds `pool`.**
  grizzle imports nothing of node-postgres: `pg` (`^8.23.1`) is a peer dependency, passed as `driver`, and `@types/pg`
  an optional one; a `pg` without pipeline mode is a type error. `host`, `port` and `tls` move into
  `transport: { kind: "sslRequest", host, port, open, ca, servername }`, where `open` makes each connection's
  unconnected socket (`() => new net.Socket()`), and `servername`, the name the server's certificate must carry, is
  required where it defaulted to the host. `connectTimeoutMs` (1 to 2,147,483,647) bounds each connection attempt and
  each CancelRequest, and `ConnectTimedOut.millis` is it. `pool: { max, min, idleTimeoutMs }` sizes the login's pool.
  Codemod: `host: H, port: P, tls: { ca: C, servername: S }` → `driver: pgDriver, transport: { kind: "sslRequest",
  host: H, port: P, open: () => new net.Socket(), ca: C, servername: S ?? H }, connectTimeoutMs: 5_000`, plus
  `pool: { max: 10, min: 1, idleTimeoutMs: 5_000 }` on a DbConfig, which were the former fixed values, with
  `import net from "node:net"` and `import pgDriver from "pg"`.
- **A host that is a path is refused at stage config, and `TlsFault` loses `noAuthority`.** `transport.host` is a name
  or an IP address: node-postgres reads a host starting with `/` as a Unix socket's directory, and PostgreSQL offers no
  TLS over a Unix socket, so `DbLayer.make` fails with `DbConfigRefused` and `grizzle migrate` with
  `ConnectionRefused`, naming `transport.host`, before any connection. An empty CA bundle is refused the same way, so no
  connection attempt ever fails for it, and the `noAuthority` fault of `TlsRefused` is gone. Fix: connect over TCP; a
  program that switches over `TlsFault` exhaustively drops the case.
- **A lease's wait has no deadline, and `AcquisitionBudgetExceeded` and the stage `wait` are removed.** The wait is
  interruptible and holds nothing: a client that arrives for an interrupted lease goes straight back to the pool. The
  error, its `millis`, `sessions`, `leased` and `max` and its `saturated` getter go with it. Fix: bound the call with
  your own timeout (the former wait was 15,000 ms), and handle its failure where you handled
  `AcquisitionBudgetExceeded`; a program that switches over `AcquireRefusal` or the stage exhaustively drops the case.
- **An interrupted statement sends one CancelRequest and destroys its session.** The request goes over a connection
  the transport opens, with SSLRequest and verify-full TLS as a session's, within `connectTimeoutMs`; the session is
  then retired and its connection destroyed at once, never reused. No codemod.
- **Releasing a layer destroys every connection at once.** It writes at most a Terminate and awaits nothing from the
  network, so a server or transport that stops answering cannot hold a release. No codemod.
- **grizzle names no session.** The application names `grizzle` and `grizzle migrate` are gone: a session's
  `application_name` is `PGAPPNAME`'s, the deployment's own label. No codemod.

#### The command line is pure mechanism: it reads the config file you name, and no environment

- **Every command names its config file.** `grizzle generate grizzle.config.ts [--name …] [--schema …]`, `grizzle
  check <config>`, `grizzle migrate <config>`, `grizzle drift <config>` and `grizzle names <config>`, the path absolute
  or relative to the directory grizzle runs in; no `./grizzle.config.ts` is read implicitly, and a command without its
  config is a usage error. Codemod: append ` grizzle.config.ts` after the command in every script and CI step.
- **`migrations` and `connection` are required in the config.** The default directory `migrations` is gone, and a
  config without either is refused at stage config. `connection` is the migration role's `DbConnection` with its
  `role`. Codemod: add `migrations: "migrations"` and a `connection` block to `defineConfig({ ... })`.
- **migrate and drift read no environment.** `DATABASE_URL`, `PGPASSWORD` and `PGSSLROOTCERT` are no longer read, and
  there is no default port 5432 and no system trust store as a CA: the config's `connection` is the only place a
  migration connects to. The refusal of `PGOPTIONS` and `PGREPLICATION`, which node-postgres would send at a migration
  session's startup, stays. Codemod: move a `DATABASE_URL`'s parts into `connection`, reading the password in the config
  (for instance `Config.Redacted("MIGRATION_PASSWORD").pipe(Effect.mapError((cause) => new CredentialError({ cause
  })))`, as the README's config does). The repository's `scripts/pg/ctl.sh env`, which printed a `DATABASE_URL`, is
  gone with it.
- **`--custom` needs `--name`.** A custom folder is no longer named `custom` by default. Codemod: `grizzle generate
  <config> --custom` → `grizzle generate <config> --custom --name <data step>`.
- **migrate refuses its connection first.** A connection or a process environment migrate and drift cannot use is
  refused before any check runs or any directory is read; an environment's refusal is at stage `environment`, whose
  fix is to unset the variable, no longer at stage `config`. No codemod.
- **`grizzle skill` is removed.** The package still ships `skills/grizzle/SKILL.md`; copy it to where your agent reads
  skills. No codemod.
- **A migration's name holds up to 240 characters**, the bytes NAME_MAX (255) leaves after the folder's
  `<timestamp>_` prefix, where it held 100. No codemod.
- **migrate and check print the whole snapshot fingerprint**, not its first 16 characters. No codemod.

#### Reads and settings are pure mechanism: a page of any size, a cursor bounded by its layout, and only the settings a guarantee rests on

- **A page size has no upper bound.** `db.page` takes as its `first` or `last` any safe integer of at least 1, where
  it took 1 to 1,000, and `PageRequestRefused` with fault `requestSize` refuses only what is no such integer. A page's
  statements bind the size, and the size plus one they read ahead, as `bigint` parameters (`$n::bigint`, where they
  were `integer`). No codemod.
- **A cursor is bounded by its own layout.** A token held at most 1,024 bytes: a page one of whose cursors would be
  longer failed with `CursorError` `cursorTupleOversized`, and an order whose shortest token was longer was refused
  with `UnsupportedOperation`. A token now holds at most 268,435,455 characters (2^28 − 1), the largest length its
  four-byte varints write, so a page ordered by long text values pages; a longer token sent back is `cursorOversized`,
  refused before any of it is decoded. The reader compares each length and count with the bytes that follow it before
  it reads anything for it, and reads each field as a view of the token's bytes, so a token allocates nothing in
  proportion to what it claims. No codemod.
- **A login pins only the settings a grizzle guarantee rests on.** Its role's defaults, which `Db.open` requires
  exactly and every session of its pool also sends as startup options, are `search_path = pg_catalog, pg_temp`,
  `extra_float_digits = 1`, and `lc_monetary`, `lc_numeric` and `lc_time` at `C.UTF-8`, and for a login whose roles
  search vectors `hnsw.iterative_scan = strict_order`, on which an approximate read's order and its cursors rest.
  `jit = off`, `lc_messages = C.UTF-8`, `hnsw.ef_search = 40`, `hnsw.max_scan_tuples = 20000` and
  `hnsw.scan_mem_multiplier = 1` are no longer stored, sent or expected. Each is the database owner's, set on the
  database or the server; a login's role that holds one is refused at stage `settings`, as any default the snapshot
  does not install is. So on a server built with LLVM, `jit_above_cost` can make a large statement compile its plan
  first; a server error's message, detail and hint come in the server's `lc_messages` language, and grizzle reads an
  error by its SQLSTATE and the fields it names, never by its words; and the owner's pgvector settings decide which
  rows an `approximateNearest` read returns and how many. No codemod.
- **The migration role needs no SET on `lc_messages`.** It held the grant to store `lc_messages` as every login's
  default; it now needs only to own the schema and the database and to have CREATEROLE. No codemod.
- **Every advisory lock key is derived on the host.** The installation sets the database's default isolation in a
  block that takes a transaction-level advisory lock, so concurrent installations into one database set it one at a
  time, and `grizzle migrate` takes a session-level advisory lock per schema, so two applies of one schema never
  interleave. The database default's key was the number 7385900293, and the apply lock's was computed by the server,
  `hashtextextended('grizzle migrate <schema>', 0)`. Each is now the first 64 bits of the SHA-256 of its name,
  `grizzle advisory lock: database default` or `grizzle advisory lock: apply <schema>`, read as a signed bigint and
  printed as a literal, which the application's own locks in the database's one key space meet only by a 64-bit
  collision. An apply by an earlier grizzle does not exclude one by this one. No codemod.
- **Format and state:** snapshot.json changes: a login's defaults no longer hold `jit`, `lc_messages` or the three
  `hnsw.*` settings, so every fingerprint changes. A database installed before stores them as its logins' defaults,
  which `Db.open` refuses: re-create it (step 3 above). A drafted Setup file's database-default block holds the new
  key.

#### The compiler's reasoning has no caps: keys by closure, orders by decision diagram, every walk once per node, every rewrite pass to its fixed point

- **Keys are proved by closure, with no cap.** The physical analysis kept at most 8 keys per fragment, passed at most
  64 dependencies to its consumers and tried at most 64 combinations of its occurrences' keys for a rule region; a key
  past them was forgotten, which kept a DISTINCT the query did not need. A fragment's dependencies are now one table
  whose closure is linear in its size (Beeri and Bernstein), and a start is a key exactly when its closure reaches the
  fragment's row, so every key the declared keys and the query's structure prove is found. No codemod.
- **No proof gives up at a depth.** The walks that stopped after 8 nodes (a take's row bound, a bound parent set above
  a region) or after 256 (the proof that a put's rows carry the keys of stored facts) now fold over the query's DAG,
  answering each node once with their frames on the heap, so a deep query is proved as a shallow one is: a put into a
  mutable relation that reads only existing keys runs as `UPDATE … FROM` at any depth, where past 256 it fell back to
  the DELETE-then-insert pair. No codemod.
- **A lexicographic comparison of any number of fields is recognized.** The rewrites of a self-match restricted by a
  tuple comparison into window functions (an ordinal or a running fold, R26 and R41, and a neighbor, R27) recognized a
  comparison of at most 6 field pairs, by evaluating all 3^pairs sign vectors; a longer one kept its self-join. The
  recognizer now builds the predicate's reduced ordered decision diagram over the pairs' signs and reads the order off
  it, a few tests per pair for the nested expansion and its disjunctive normal form, in any arrangement. Whether an
  arbitrary predicate is lexicographic is coNP-hard, so a pathological arrangement of comparisons can take compile time
  exponential in its pairs. No codemod.
- **A finite text pattern's domain CHECK is the shorter of its two forms.** A pattern whose language has at most 64
  members was enforced as `VALUE IN (...)`, a larger one as `VALUE ~ '<ARE>'`; the 64 is gone, and the domain's CHECK
  is whichever form prints in fewer UTF-8 bytes, the IN list on a tie, with members counted only until the list
  outgrows the pattern. Both forms admit exactly the same values. Snapshots change. No codemod.
- **A recursion is always one recursive CTE.** A recursion whose counter proved a depth of at most 4 was unrolled into
  a union of joins, one `NOT MATERIALIZED` CTE per level; every recursion is now `WITH RECURSIVE … UNION`, whatever
  its proved depth. A recursion is no longer refused for its static estimate of the states it reaches, past 1,000,000
  (`RecursionRefused`, cause `stateEstimate`): the estimate is recorded, and the states its seen-state hash holds are
  the program's own to bound, by its data or its filters, since PostgreSQL 19's RecursiveUnion keeps that hash in
  memory and never spills it. Fix: a program that switches over
  `RecursionRefusal["kind"]` exhaustively drops the case `"stateEstimate"`.
- **An attachment is pipelined unless its parent reads an approximate search.** An attachment of at most 4 fields was
  fused into its parent's statement; every attachment is now a statement of its own in the call's one round trip, and
  only a parent whose rows read an approximate search fuses its children, so the search runs once. A read sends one
  statement more for each attachment it fused, and `db.explain` returns a plan for it. Answers do not change. No
  codemod.
- **A one-column membership of declared closed facts is rewritten at any size.** It becomes `v IN (l1, …, ln)`
  whatever its number of facts, where it kept its VALUES join past 64 terms; PostgreSQL hashes a long constant list. A
  tuple membership becomes its disjunction while that holds at most 64 equalities, its distinct tuples times its
  tested columns. No codemod.
- **A discrete percentile at any multiple of 1/128 is rewritten to `PERCENTILE_DISC`.** The rewrite (R29) admits a
  dyadic fraction m / 2^j, at which the composition and the native aggregate provably select one value, for j at most
  7, where it was 6: the exponent is now derived from the most rows a stored relation holds and the 15 digits a
  double keeps through numeric. No codemod.
- **A rewrite pass runs to its fixed point.** A pass was metered in steps and refused past its budget with
  `ResourceBound` (`{ kind: "rewriteSteps", rewrite, limit, needed }`); each now runs over a worklist and ends because
  every rewrite lowers a potential the query bounds, such as the occurrences left to rewrite or the regions left to
  fuse. Fix: a program that switches over `CompileBound["kind"]` exhaustively drops the case `"rewriteSteps"`.
- **Two operating thresholds remain, at their former values and unmeasured.** A bound parent set of at most 256
  groups takes a take's correlated LATERAL form (R20), and a tuple membership of at most 64 equalities is rewritten
  into its disjunction (R07). Each chooses between two plans of one answer, and its gate measures both:
  `bench/query/take.bench.ts` for R20 and `bench/query/finite.bench.ts` for R07. No codemod.
- **Format and state:** answers are unchanged, but the SQL a read, a write or a law check sends may change shape, and
  with it a snapshot.json that records such a statement: regenerate (step 3 above).

#### Every number grizzle bounds something by carries its evidence, and `core/policy.ts` is gone

- **A limit is a value with its evidence.** Every bound the library compares, loops, sizes or waits by is a Limit,
  minted only by `published`, `measured` or `derived` of `packages/engine/src/core/limits.ts`, or a value its caller
  passes, but for the two unmeasured thresholds of the entry above. A published limit is a number a source states,
  with the source's URL, a quote of it, what kind of constraint it is and the day it was checked: PostgreSQL's 1,600
  columns, 1,664 select-list entries, 65,535 parameters, NAMEDATALEN and regex repetition bound, V8's longest string,
  Node's longest timer, TCP's largest port, NAME_MAX, and pgvector's 2,000 indexed dimensions. A measured one is an
  operating value with the record of its measurement, its environment and workload, and what invalidates it: the
  regex compile-space measures, the bounds of the pattern analysis's DFA construction, and the PostgreSQL major
  `Db.open` admits. A derived one is computed from others by the arithmetic it states: PostgreSQL's longest message
  from MaxAllocSize, the longest identifier from NAMEDATALEN, a migration name's 240 bytes from NAME_MAX. No codemod.
- **A float quotient's exact path rounds every tie as IEEE 754 does.** The guarded form of `/` over `real` and
  `double precision`, which divides the operands' exact values where the native operation could overflow or
  underflow, scaled the quotient by an invented 10^700, at which half the subnormal ties of a double quotient rounded
  the wrong way (`5e-324 / 2` was `5e-324`, not `0`). The scale is now derived from the format, 10^(p - emin)
  (10^1075 for double precision, 10^150 for real), at which every point where the format's rounding changes is exact.
  The ranges inside which an IEEE operation runs natively are derived from the formats' exponents too: a product's or
  a quotient's operands within 2^±510 for double precision and 2^±62 for real, where they were 2^±500 and 2^±60, and
  a rounding into double precision within 2^±1021, where it was 2^±1022. Generated SQL and fingerprints change. No
  codemod.
- **The fixed choices `core/policy.ts` made for its caller are gone.** Its pool bounds, page limit, cursor bytes,
  attachment width, recursion unrolling depth and state-estimate bound are deleted with the decisions they made (the
  entries above): what was a choice is the caller's input, or is no longer made. No codemod.

#### Two gates hold the library to pure mechanism: superlint's `limit-evidence` and `no-environment`

- **`limit-evidence`: a bound is a Limit or a caller's input.** In `packages/engine/src` and `packages/grizzle/src`, a
  bare number (a literal, a number constant that is no Limit's value, or arithmetic of only those) is refused where it
  bounds something: a comparison's operand, a loop's condition, an argument of `Math.min` or `Math.max`, and a value
  that sets a length or a count, a time, a concurrency, a retry count or a size, read off the parameter or the
  property it sets; so is a module-level number constant whose name says it bounds something (`max`, `limit`,
  `timeout`, `depth`, `budget` and the rest). 0 is an identity everywhere, 1 and −1 everywhere but in a time, and 2 in
  `n < 2` and `n >= 2`, and a hexadecimal, octal or binary literal compared is a code unit or a bit pattern. A bound is
  a Limit's `.value` or a value the caller passes; a format's defining width is a named constant documented with
  `@formatConstant`. In `test/`, `bench/` and `scripts/` the rule checks times, concurrencies and retry counts only,
  and a generator builder's arguments are a test's inputs, never a bound.
- **`no-environment`: the library reads no environment.** In `packages/engine/src` and `packages/grizzle/src`, a use
  of `process.env`, `argv`, `execArgv`, `cwd`, `chdir` or `loadEnvFile`, of `node:os`'s `homedir`, `tmpdir`,
  `hostname`, `userInfo`, `availableParallelism` or `cpus`, or of any value of Effect's `Config` or `ConfigProvider`
  is refused however it is spelled: a property read, an imported name, a destructuring. The one sanctioned reader is
  `packages/grizzle/src/adapter/connection/environment.ts`, which refuses `PGOPTIONS` and `PGREPLICATION`; a
  program's entry module, one that tests `import.meta.main` as the `grizzle` command's does, reads its own `argv` and
  `cwd`.
- **Both are in the gate.** They read their settings from the `superlint` field of the root `package.json`
  (`limitEvidence`, `noEnvironment`), run in `pnpm superlint` and `pnpm check`, and are proved on their fixtures
  (`packages/devtools/src/lint/fixtures/`) by `fixtures:superlint`. No codemod: they lint grizzle's own sources, never
  an application's.

#### A relation input of any number of rows travels as one array per column; `InputTooLarge` names its byte bound

- **A ChangeSet input and a relation parameter hold any number of rows.** The 100,000-row limit is gone, and so is the
  transport it stood for: an input traveled as one `jsonb_to_recordset` parameter, which PostgreSQL caps at 268,435,455
  bytes, or below 17 rows as a VALUES list rewritten into each execution's text. Now every input, an empty one and one
  of no column included, travels as its arrays, one text-format array literal per column read by `unnest` in one
  select list (one `generate_series` count for an input of no column), in every read, write, page and `db.explain`. A
  Stream member or parameter is collected whole before any SQL. No codemod.
- **The planner estimates an input as its length.** Each array is a constant of the execution's custom plan, so a
  join against an input plans for its true size where `jsonb_to_recordset` was always 100 rows; a statement of a
  compiled program the plan cache serves generically is estimated at 10 rows. No codemod.
- **`InputTooLarge` carries its `bound`.** It is raised only for a real transport bound, before anything is sent:
  `{ kind: "message", statement, bytes, limit }`, one statement's Bind message past PostgreSQL's longest message,
  1,073,741,822 bytes (`PQ_LARGE_MESSAGE_LIMIT`), which the server would answer by closing the connection; or
  `{ kind: "literal", input, column, limit }`, one column's array literal past JavaScript's longest string. Its stage is
  still `resource`. No codemod; a handler that matched `InputTooLarge` keeps matching and may read `error.bound`.

#### Every numeric field declares its precision and scale; a computed numeric carries its proved bound

- **`pg.numeric` is a constructor only: `pg.numeric(p, s)`, both declared.** The bare `pg.numeric` field, its
  invented bound of 1,000 integer digits and the CHECK `__<table>_bound_<column>_<digest>` that installed it are
  gone, and so is `numeric(p)` with its implied scale 0. `pg.decimal` is the same constructor. A bare numeric in an
  authored Description, `{ kind: "numeric" }`, is refused. Codemod: `pg.numeric(p)` → `pg.numeric(p, 0)`; a bare
  numeric field → `pg.numeric(p, s)` with the precision and scale of what it stores; a parameter or typed literal
  likewise.
- **`Compute.numeric(x)` is the numeric of a value.** It is PostgreSQL's `x::numeric` of an integer, money, an exact
  value, a numeric or a float (a float's as float4_numeric and float8_numeric write it, with 6 or 15 significant
  digits), lowered exactly as the cast to bare numeric was. Codemod: `Compute.cast(x, pg.numeric)` →
  `Compute.numeric(x)`.
- **A computed numeric carries its bound.** A sum, a mean, an operation's numeric result and a derived relation's
  numeric field are typed with the integer and fraction digits their making proves: a sum its argument's integer
  digits widened by the rows' (a bigint's 19), a mean its argument's with PostgreSQL's display scale. A bound past
  131,072 integer digits is `ResourceBound` (`numericDigits`) where the value is made, so arithmetic over a sum is
  admitted without a cast, and a derived relation keyed by a numeric sum is representable. Fingerprints and
  snapshots change. No codemod.
- **`DatumUnbounded` is removed, `KeyFault`'s `unbounded` becomes `unboundedText`, the Law loses `numericBound`, and
  `CompileReason` gains `DigestCollision`.** Text whose pattern proves no byte bound is the one datum with no bound, so
  the fault names only its field: `{ kind: "unbounded", field, datum: "textBytes" }` →
  `{ kind: "unboundedText", field }`. Two distinct objects of one installation whose hashed names share a stem and a 50-bit digest are
  refused with `DigestCollision`, naming both, never installed, and so is a migration's temporary name (a holder set
  aside, an index's swap name, an enum's rebuild name) that a name standing while it runs or another temporary has,
  before `grizzle generate` drafts it; renaming a declaration either is built from resolves it. Fix: a program that
  switches over these exhaustively drops or gains the case.
- **A vector's cosine domain is derived: norms from 2^-68 to 2^63.** The bounds were 2^-16 and 2^16. They are now the
  widest powers of two for which pgvector's `cosine_distance`, which sums in single precision, is a number in [0, 2]
  for every pair of vectors of up to 16,000 dimensions: past the upper one a square or a dot product overflows to
  infinity, below the lower one every square rounds to zero. Every vector a column holds stays admitted. No codemod.

#### A value is only its value: `Decimal` has no display scale; float and money sums are exact (#3)

- **`Decimal` is value-only.** `1`, `1.0` and `1.00` are one `Decimal`, written `"1"`; every constructor, the decoder of
  query results included, yields that one form. `d.scale`, `d.identityText()`, `d.kind`, `d.negative` and
  `d.coefficient` are removed; `d.parts` (`{ kind: "finite", negative, coefficient, minScale }` or `{ kind: "nan" |
  "infinity" | "-infinity" }`) and `d.text` are new. `d.toString()` is the shortest exact text: a `pg.numeric(10, 2)`
  field delivers `12.5`, not `12.50`.
  - Codemod: `d.identityText()` → `d.toString()`; `d.scale` → `d.parts.minScale` after `d.isFinite()` (the least scale
    that writes the value; there is no display scale to read); `d.kind` → `d.parts.kind`; `d.negative` /
    `d.coefficient` → `d.parts.negative` / `d.parts.coefficient` after `d.isFinite()`.
  - Fix for display: print at the field's scale with
    `new Intl.NumberFormat(undefined, { minimumFractionDigits: s }).format(d.toString())`.
- **`Money.toDecimal()` returns the one form** (`"12.5"` for 1250 minor units); `Money.toString()` still writes two
  fixed digits (`"12.50"`). No codemod; a caller that printed `toDecimal().toString()` prints `toString()` instead.
- **`Compute.scale` and `Compute.trimScale` are removed.** Codemod: `Compute.scale(x)` → `Compute.minScale(x)`;
  `Compute.trimScale(x)` → `x`.
- **Quotients, powers, square roots and numeric means are computed from operand values.** `Compute.div`,
  `Compute.power` and `Compute.sqrt` over numeric, and `r.mean` over numeric, read each operand as if written without
  trailing zeros (the SQL passes it through `trim_scale`). Only results over operands stored with display scales beyond
  their significant digits change. No codemod.
- **`r.sum` over real, double precision and money, and `r.mean` over real and double precision, are exact.** A float
  sum is the double (real) nearest the exact total, ±Infinity past the largest finite value, a float mean that total
  over the count rounded once, a money sum the exact total as exact money; none depends on row order or plan, and none
  fails.
  Results change in the last digits where rounding used to accumulate. No codemod.
- **A closed-form slope over double-precision sums is no longer rewritten to `REGR_SLOPE`** (rewrite R32 is removed);
  it is computed as written, from exact sums. No codemod.
- **A float's zero is `0`.** No query delivers `-0`. No codemod.
- **`Compute.cosineDistance` is a declared exception, beside `.approximateNearest`.** It is pgvector's own float
  arithmetic: the same for the same vectors on every evaluation by one server, possibly different in the last place
  between pgvector builds or CPUs. Every other answer is a function of the facts alone. No codemod.
- **A vector field may be a key field.** A primary key or `key(...)` over a `pg.vector(n)` field is admitted where its
  B-tree entry fits: every vector has one form, its components finite and its zero `0`, so pgvector's equality is the
  key's identity, and `[-0,1]` and `[0,1]` are one key. A span key still refuses a vector field, which btree_gist has
  no operator class for (`UnrepresentableKey`, fault `gistOperatorClass`); the `vector` fault is removed. No codemod.
- **Format and state:** snapshot.json and meta.json fingerprints over decimal literals change (`~d:1.50` is refused;
  `~d:1.5` is the payload); CHECKs and expression indexes that divide, raise to a power or take a root gain
  `trim_scale(...)`, which the next `grizzle generate` redrafts; cursors over numeric order columns change their
  bytes (they are now a function of the value).

#### Rename candidates are a tree decided by path; meta.json records every drafted statement (#8)

- **meta.json's decisions are a complete decision record.** A drafted folder's meta.json held
  `decisions: { candidates, choices, confirms, losses }`, candidates numbered by allocation and each decided by a
  "witness" statement. It now holds `files: [{ name, steps }]`: every drafted statement of every file in its place,
  each step a `statement`, a `choice` (`keep`, `offers`, `follows`), a `loss` (`loses`, `statement`, `carriers`) or a
  `confirm` (`statements`); a candidate's own offer (`rename`, `relation rename`, a field's `nested rename` inside its
  relation's alternative) holds its `head` and its `alternative`'s steps, and every reference (`replace`, `delete`, a
  loss's `carriers`, a field's `requires`) is the candidate's path, such as
  `{ "kind": "relation", "removed": "\"s\".\"first\"", "added": "\"s\".\"third\"" }` or, nested,
  `{ "kind": "nested field", "parent": { … }, "removed": "\"value\"", "added": "\"amount\"" }`. No codemod: regenerate.
  A folder's old meta.json is refused as unreadable by `grizzle check` and `grizzle migrate`.
- **`grizzle generate` drafts rival relation renames that each rename a field.** Two removed relations that both pair
  with one added relation, each dropping a field the added one may be renamed from, failed with `internal error`; each
  rival's nested field rename is now decided only under its own relation's rename. No codemod.
- **`grizzle check` refuses a statement of a branch the review did not take, wherever it stands,** a statement inside a
  rename that is not chosen as an orphan, an untaken branch's statement or a chosen choice's kept statement as a
  split; a drafted statement no candidate decides, at the top of a file, stays yours to keep, delete or edit. A correct
  review of rival renames (one chosen, its field's drop written in) is no longer refused as an orphan of the other.
  Fix: write in only the statements of the branches you take.
- **Labels name both ends in full.** A field's candidate reads `the candidate rename of "s"."t"."a" to "s"."t"."b"`
  (was `… to "b"`), a nested field's `the candidate rename of "s"."first"."value" to "s"."third"."amount"` (was
  `"s"."third"."value" to "amount"`), and a nested field's note and its loss name the removed relation. No codemod;
  only comment lines change, never a drafted statement.
- **Format and state:** meta.json changes format (above); drafted SQL statements are unchanged.

#### Every name grizzle's SQL holds names its schema; `grizzle drift` gets stage `unchecked` (#4)

- **Generated SQL names every PostgreSQL type, function and carrier by its schema.** A builtin type prints as its SQL
  keyword (`integer`, `bigint`, `boolean`, `numeric(10, 2)`, `double precision`) or qualified (`"pg_catalog"."text"`,
  `"pg_catalog"."uuid"`, `"pg_catalog"."jsonb"`, `"pg_catalog"."money"`, the ranges, `"pg_catalog"."record"`); a
  builtin function as `"pg_catalog"."<name>"(...)`, `count(*)` as `"pg_catalog"."count"(*)`; a function's return type as
  `RETURNS "pg_catalog"."trigger"` / `"pg_catalog"."void"` / `boolean`; a relation in a regclass value as
  `'"<schema>"."<name>"'::"pg_catalog"."regclass"`; a write program's carrier as `"pg_temp"."__carrier_<d>_<k>"`.
  Before: `"id" uuid NOT NULL`, `count(*)`, `'shop.seq'::regclass`. After: `"id" "pg_catalog"."uuid" NOT NULL`,
  `"pg_catalog"."count"(*)`, `'"shop"."seq"'::"pg_catalog"."regclass"`. A relation may now be named `Text`, `Uuid`,
  `Money`, `Void` or `Trigger`, and a database, role or session search_path that lists grizzle's schemas first changes
  nothing.
  - Codemod for hand-written SQL in your migrations (custom migrations and tuned drafts): qualify every builtin type
    that is not a keyword, `::text` → `::"pg_catalog"."text"`, `::uuid` → `::"pg_catalog"."uuid"`, `::jsonb` →
    `::"pg_catalog"."jsonb"`, `::money` → `::"pg_catalog"."money"`, and every builtin function call `f(` →
    `"pg_catalog"."f"(`; a statement of yours runs under the session's search_path, where a relation of yours named
    `Text` is the type `text`, and the drift check judges what it built.
- **A drift check that reaches no verdict stops at the new stage `unchecked`**, not `drift`: the snapshot did not
  render, the ledger or the catalog could not be read, or the replay that builds the snapshot beside the schema was
  refused (reported as `the snapshot of <schema> could not be built beside it to compare (statement <n> of <m> of the
  replay): ...`). Its outcome line reads `Every folder applied; the drift check reached no verdict.` (migrate) or
  `Nothing was applied; the drift check reached no verdict.` (drift), and its fix `the check changed nothing: run
  grizzle drift again, and report it with this output if it is refused the same way`. Exit code 1, as before.
  - Codemod for scripts that read the report: match `refused at stage unchecked` where they matched a `stage drift`
    refusal whose message was `the catalog of <schema> could not be read` or `the snapshot's installation ... could not
    be rendered`.
- **Format and state:** snapshot.json changes: a function's `searchPath` key is gone (every function runs under
  `pg_catalog, pg_temp`), a relation a regclass value names is a `{ "kind": "regclass", "relation": ... }` node, and
  every fingerprint changes; a pre-cutover snapshot is refused at stage snapshot. Every drafted migration file changes
  text. Re-create every database installed before.

#### Every login pins its search_path, and `Db.open` refuses a login whose search_path is not the pin (#4)

- **A login's sessions run under `search_path = pg_catalog, pg_temp`.** The first migration stores
  `ALTER ROLE <login> SET search_path = "pg_catalog", "pg_temp"` beside the login's other defaults
  (`extra_float_digits = 1`, and `lc_monetary`, `lc_numeric` and `lc_time` at `C.UTF-8`). PostgreSQL applies a role's
  own default over the database's and the server's, so an `ALTER DATABASE ... SET search_path`, or a server's, no
  longer reaches a `Db`'s sessions. No codemod.
- **`Db.open` refuses a login whose search_path default is missing or another path**, as an `OpenError` at stage
  `settings` with the mismatch `role <login> default search_path`, expected `pg_catalog, pg_temp`; one set for the
  login in this database alone is refused as any such default is. The drift check after `grizzle migrate` refuses it
  the same way. Fix: re-create the database from your migrations.
- **Every session of a login's pool sends the pinned defaults as its startup options**: `-c search_path=pg_catalog,\
  pg_temp -c extra_float_digits=1 -c lc_monetary=C.UTF-8 -c lc_numeric=C.UTF-8 -c lc_time=C.UTF-8`. Before,
  node-postgres sent the environment's `PGOPTIONS` instead, whose settings silently overrode the pins. After, pg never
  reads `PGOPTIONS` for a login's session. No codemod.
- **`DbLayer.make` refuses a process environment that sets `PGREPLICATION`**, which node-postgres would send at every
  login, making each session a replication connection: `OpenError` at stage `config`, reason
  `ConnectionEnvironmentRefused`, naming the variable and never its value. grizzle reads `process.env`, the source pg
  reads, never the ConfigProvider. Fix: unset `PGREPLICATION`.
- **`grizzle migrate` and `grizzle drift` refuse a process environment that sets `PGOPTIONS` or `PGREPLICATION`**, at
  stage `environment` with the same reason, before any check runs. A migration session sets no options of its own and starts under its role's
  and its database's defaults, so pg would send either at its startup. Fix: unset both for the command.
- **No grizzle session reads `PGPASSWORD` or `~/.pgpass`.** Before, a password given as the empty text, `noPassword`
  for trust, peer or certificate logins, or an empty `Redacted`, fell back in node-postgres to `PGPASSWORD`, then to the
  password file. After, pg is always given a function that yields the configured password, and a server that asks for
  one refuses the empty one. Fix: give every login its password in `DbConfig.password`.
- **A session's client encoding and TLS negotiation are grizzle's own**, so `PGCLIENT_ENCODING` and `PGSSLNEGOTIATION`
  no longer reach a session. `DbConfig` has no `options` setting, and refuses one as any unknown setting. No codemod.
- **Format and state:** snapshot.json changes: a login default's `action` holds its setting,
  `{ "kind": "set", "setting": { "parameter": "extra_float_digits", "value": "1" } }`, and the search path's names no
  value, since the pin is the only one, `{ "kind": "set", "setting": { "parameter": "search_path" } }`. Every fingerprint changes,
  and a pre-cutover snapshot is refused at stage snapshot. Re-create every database installed before.

#### Every generated text is built once, a text past JavaScript's longest string is refused, and a large schema no longer crashes (#6)

- **No admitted schema crashes `generate`, `check` or `migrate` with `grizzle: internal error`.** A schema whose law
  function, drafted file or snapshot.json ran past about 120,000 lines (an alternatives law with about 240 armed
  handles) failed with `RangeError: Maximum call stack size exceeded`. Every text is now written once into one line
  sink, and grizzle passes no list as a call's argument list, so these schemas generate. No codemod.
- **A text past V8's longest string is `ResourceBound`.** One SQL statement, migration file, `snapshot.json`,
  `meta.json` or fingerprint text may hold at most 536,870,888 UTF-16 code units (2^29 − 24, about 512 MiB of ASCII).
  Before: `generate` and `check` crashed with `RangeError: Invalid string length` (an internal error). After: they
  refuse with `ResourceBound` whose `bound` is `{ kind: "stringLength", limit, needed }`.
  - Fix: a program that switches over `CompileBound["kind"]` exhaustively gains the case `"stringLength"`; its message
    is `a text of at most 536870888 UTF-16 code units, V8's longest string (needed <n>)`.
- **A commented alternative in a drafted file comments every line PostgreSQL reads as one.** A literal holding a
  carriage return inside a commented rename or loss alternative is now followed by `-- ` after the carriage return too,
  so no part of a commented alternative is live SQL. Uncomment it as before. No codemod.
- **Format and state:** snapshot.json changes: a PL/pgSQL `perform` node's `query` is `{ body, orderBy?, limit?,
  offset? }` (no `kind`, no `with`); a set operation is `{ kind: "setOp", op, arms: [...] }` (two arms at least) where it
  was nested `left`/`right` pairs; a join is one `{ kind: "joins", first, steps: [{ kind: "on" | "cross", source,
  on? }] }` where it was nested `join`/`crossJoin` pairs; and every fingerprint changes. A pre-cutover snapshot is
  refused. The printed SQL of these statements does not change.

#### A value nests to any depth, and a write program holds any number of carriers of one column-type class

- **A description, an IR value or a canonical text nests to any depth.** The canonical serializer (`encode`, `toJson`,
  `fromJson`, `decode`) and every description and IR decoder kept the containers they were inside on the call stack,
  and refused a value inside more than 512 of them with `ResourceBound` (`{ kind: "nesting", limit: 512 }`). Each now
  keeps them on a stack on the heap, so a value 100,000 containers deep decodes on a sixth of Node's stack, and the
  bound is gone. A value that holds itself is refused as cyclic wherever it meets itself, `MalformedDescription` (`an
  acyclic value`) at that path; `fromJson` refuses a cyclic in-memory value the same way, as `MalformedArtifact`,
  where it used to stop at the depth bound.
  - Fix: a program that switches over `CompileBound["kind"]` exhaustively drops the case `"nesting"`.
- **A write program holds any number of carriers.** A carrier was named `__carrier_<n>`, n a 36-bit digest of its
  column types times 65,536 plus its ordinal, so a program with more than 65,535 carriers of one column-type class was
  refused with `ResourceBound` (`{ kind: "carriers", limit: 65535 }`). A carrier is now named `__carrier_<d>_<k>`:
  d, the first 36 hex digits (144 bits) of SHA-256 over its column types, and k, its ordinal among the program's
  carriers of those types, which no count runs out of. Two column-type classes of one program whose digests agree are
  refused with `UnsupportedOperation` rather than given one name.
  - Fix: a program that switches over `CompileBound["kind"]` exhaustively drops the case `"carriers"`; a log filter or
    a query of `pg_stat_activity` that matched `__carrier_<n>` matches `__carrier_<d>_<k>`.

#### A residual law is one deferred trigger and one function per table and event, each checking only what its event can break (#5)

- **Installed objects.** Each residual law (an alternatives law's reverse obligation, a conditional mirrors, a
  selected-source containment or coverage, a residual capacity) installs one deferred constraint trigger per
  participating table and threatening event (`AFTER INSERT`, `AFTER DELETE`, `AFTER UPDATE OF …`), each executing a
  function of its own. Before, one function served the whole law, behind one `AFTER INSERT OR DELETE OR UPDATE OF …`
  trigger per table. Every law trigger's and law function's name changes; each is `__law_<stem>_<digest>`, hashed
  over the law, the table and the event.
  - Fix: code that names a law trigger (`SET CONSTRAINTS <trigger> IMMEDIATE` in a direct writer or a test) names
    every trigger of the law on that table, or writes `SET CONSTRAINTS ALL IMMEDIATE`. No codemod: the names are
    compiler-derived, and `grizzle generate`'s snapshot.json lists them.
- **A law trigger filters its rows.** Its `WHEN` holds its event's static test: the row's selection for a guarded
  image, and for an UPDATE a change of a field its `UPDATE OF` lists. An UPDATE that changes no such field, and a row
  outside the law's selection, queue no deferred event and call no function. No codemod.
- **A write re-checks only what it can break.** A payload table's write checks only its own handles' obligations,
  never the whole roster; an UPDATE checks what deleting OLD and inserting NEW would. Outcomes do not change: the same
  23000, constraint name and DETAIL, with its role-dependent visibility. Fewer reads mean fewer 40001s. No codemod.
- **A migration that changes what a law checks under one identity revalidates it.** Moving an arm relation to another
  handle, arming or unarming a handle, a roster change, a bound or a selection: the law's Validate file runs its
  violation query again. Before, such a change replaced the function in Publish unvalidated. Declaring or removing
  `mutable` adds or drops only the law's UPDATE triggers and functions, and no longer replaces the others. No codemod.
- **A discriminator value outside the roster raises `CASE_NOT_FOUND` (20000)** instead of passing. The enum type
  refuses such a value first, so no write reaches it. No codemod.
- **Format and state:** snapshot.json writes each installed statement compact on one line of its own (a changed
  statement is one changed line), lists one `lawFunction` and one `lawTrigger` object per unit, holds the new
  statement forms (PL/pgSQL `whenAbsent`, a `case` without `else`, a constraint trigger's `event` and `when`), and
  digests each residual law's whole record; a previous snapshot.json is refused, never read. Every database installed
  before is re-created.

#### `alternatives` refuses a stray arm key and the parent as its own arm, in the types first; a shared arm relation accepts each handle's payloads (#5)

- **An arm map is keyed by handles of its roster alone, as a type error.** Before, an arm map that mixed a roster
  handle with another key (`{ Manual: ManualTask, Bogus: ManualTask }`) typechecked and was refused only when the
  statement was built (MalformedDescription, "arms keyed by Kind's handles; Bogus is not one"). It is now refused by
  the type, `Refusal<"an arm is keyed by a handle of its roster">`; the runtime refusal stays for JavaScript callers
  and for a roster whose handles are no literals.
  - Fix: drop the stray key, or add its handle to the roster. No codemod.
- **No arm is the parent itself.** Before, `alternatives(Task, "kind", Kind, { Manual: Task })` was admitted, though an
  arm is keyed by a key of its relation, so every task had to stand at `Manual` and every other handle was dead. It is
  now refused by the type, `Refusal<"an arm is a relation other than its parent">`, wherever the relation's name is a
  literal, and with MalformedDescription when the statement is built and when a description declares it.
  - Fix: declare the arm as a relation of its own, keyed like the parent. No codemod.
- **A relation that is the arm of several handles accepts each one's payloads.** Before, each handle installed its
  own constant tag and tagged foreign key on the arm, so a relation shared by two handles (`{ Manual: Task1,
  Scheduled: Task1 }`) carried two foreign keys no row meets, and no row could ever be written to it. A shared arm's
  rows now belong to a parent of any handle it is the arm of. The containment fact the query layer reads carries the
  handle only where the arm serves one. An arm relation keyed differently at two of its handles is refused
  (MalformedDescription).
- **An arm's foreign key is the law `alternativesArm`**, `{ kind: "alternativesArm", relation, field, arm, handles }`,
  one per arm relation, no longer a `mirrors` half from the arm into the parent. The reverse obligation stays
  `alternatives`.
  - Codemod: a program that switches over `Law["kind"]` exhaustively gains `"alternativesArm"`, and a match on an
    arm's `mirrors` half into its parent becomes a match on `alternativesArm` by `arm`.
  - Installed objects change only for a parent with an arm relation of several handles. It gets a STORED arm tag
    column, mapping each kind to its arm relation, and UNIQUE (key, arm tag), and that relation gets one tagged
    foreign key into it. An unshared parent installs exactly as before. Re-create every database.

#### A uuid is the uuid language, a refined text's identity is text, and a parameter carries its type (#7)

- **A uuid field's values are `Uuid`.** `uuid` is `Field<Uuid, "uuid">`, where `Uuid` is ArkRegex's inference of
  uuid_out's spelling, `${string}-${string}-${string}-${string}-${string}`, exported beside `uuid`. Every fact, head row,
  key value, parameter, binding and comparison operand of a uuid field is a `Uuid`. A uuid literal and
  `crypto.randomUUID()` typecheck as they are. A plain `string`, or a text without four hyphens, is a type error at a
  uuid position. Before: `{ readonly id: string }`. After: `{ readonly id: Uuid }`.
  - Codemod: a `string`-typed value written to a uuid position (a fact, a `db.execute`/`get`/`page` argument, a binding,
    a comparison operand) is parsed once at the boundary: `const id = Uuid.parse(text)`, which returns
    `Result<Uuid, ValueFault>` (`id.ok ? id.value : id.error`, error `"uuidSyntax"`). A function that builds an id types
    its result `Uuid` and returns a template, ``(n: number): Uuid => `00000000-0000-4000-8000-${hex12(n)}` ``.
    Type annotations of uuid values `string` → `Uuid` (`import { Uuid } from "@bjornpagen/grizzle"`). Type pins:
    `Field<string, "uuid">` → `Field<Uuid, "uuid">`, `Term<string, P, O, "uuid">` → `Term<Uuid, P, O, "uuid">`,
    `Carrier<string, "uuid">` → `Carrier<Uuid, "uuid">`.
- **A refined text's identity is text; its values are its pattern's language.** `str.regex(source)` is
  `Field<Host, "text", string>`, its host type `Host` (the pattern's inference, unchanged) its values and its language,
  and `string` its domain. A term of one pattern now meets a text column or term of any other pattern (a join, a
  comparison, a binding, a union's arms, mirrors and contained sides), as PostgreSQL compares texts and the checker
  admits. A JavaScript value at the column, opposite one of its terms, for one of its parameters or in a fact is still
  one of the pattern's language. Before: `Field<"yes" | "no", "text">`, `v(R, "r").answer: Term<"yes" | "no", …, "text">`.
  After: `Field<"yes" | "no", "text", string>`, `v(R, "r").answer: Term<string, …, "text", "yes" | "no">`.
  - Codemod: type pins only. `Field<H, "text">` for a `str.regex` field → `Field<H, "text", string>`, and
    `Term<H, P, O, "text">` → `Term<string, P, O, "text", H>`. A refused join or comparison between two patterns now
    typechecks; delete its `@ts-expect-error`.
- **A term's type has a language component.** `Term<T, P, O, Sql, V, F, L>`, `Carrier<A, Sql, D, F, L>`,
  `Scalar<T, P, O, Sql, L>` and `Operand<T, Sql, L>` gain `L`, the values of the term's type that a JavaScript value
  opposite it may be (`LanguageOf<X>`). It defaults to V, so code that writes these types positionally changes only
  where it pins a refined text or a roster constant. A comparison's, `inSet`'s, `Compute.in`'s and `Compute.literal`'s
  JavaScript values are of the met term's or descriptor's language, and `Compute.cast(x, F)` is a term of F's domain
  whose values are F's host type (before: of F's host type). Codemod: none; a pin of a cast into a refined text,
  `Term<H, P, O, "text">` → `Term<string, P, O, "text", H>`.
- **A parameter map entry is the parameter's type.** `ParamsOf<Q>` maps each scalar parameter to
  `ParamType<Domain, Sql, Language>` (exported from the query barrel), the descriptor `r.param` took. Before:
  `ParamsOf<typeof q>` was `{ readonly account: string }`. After: `{ readonly account: ParamType<Uuid, "uuid"> }`. The
  argument a caller passes is `ParamArg<ParamsOf<Q>>` (also exported), each scalar parameter's value of its language. A
  relation parameter's entry is unchanged, its facts; a named `take("batch")` contributes
  `{ readonly batch: ParamType<number, "integer"> }`. `Q.bind` takes a term for a scalar parameter only when the term
  meets the parameter's domain and SQL type: a text term never binds a uuid parameter. It takes a JavaScript value only
  when the value is of the parameter's language.
  - Codemod: `const p: ParamsOf<typeof q> = { … }` → `const p: ParamArg<ParamsOf<typeof q>> = { … }`. A pin
    `{ readonly k: X }` of a scalar parameter declared `r.param("k", F)` → `{ readonly k: ParamType<DomainOf<F>,
    SqlOf<F>, Infer<F>> }`, written out, e.g. `ParamType<Uuid, "uuid">`, `ParamType<string, "text", "yes" | "no">`,
    `ParamType<bigint & Brand<"Cents">, "bigint">`.

#### A union's arms and a matched query's constants mean one thing to the types and the engine (#7)

- **A constant that no arm of the matched source delivers is refused.** A match or an `r.not` over a query, a union, a
  bound import or an interior binds a field to a JavaScript value or a typed constant. If no arm of the source can
  deliver all the bound constants, the program is refused. An arm can deliver a constant when its head holds that
  constant at the field, or when it delivers the field by a term whose type has the value. This is a filter no fact
  meets, so a match was always empty and a negation always true. Before: `r.match(tones, { tone: "high" })`, where
  `tones`'s arms find `tone: Tone.handle("low")` and `tone: Tone.handle("mid")`, compiled and read no row. After: a
  type error, `Refusal<"no arm of the source delivers the bound constants">`, and `MalformedDescription` ("no arm of the
  source delivers the bound constants (tone)") from the compiler. The types judge every constant whose value they
  carry: a primitive JavaScript value or a handle. A `Decimal`, a `Money`, a `Compute.literal`, a value of a
  non-literal type, or a head parameter that `Q.bind` binds to a literal is refused by the compiler alone.
  - Fix: delete the dead match together with the rule it empties, or delete the dead `r.not`. Otherwise bind a value
    some arm delivers.
- **A matched union narrows by every constant it is bound to, and so does a negated one.** Before, a match selected
  the arms of a union of several headings only by constants bound to its discriminant. `r.match(u, { e: 2, f })`
  refused `f`, a field only the arm with `e: 2` delivers, unless `e` was the discriminant. An `r.not` never narrowed. A
  negated union refused every field some arm lacks. After: the constants bound to any field common to the arms select
  the arms that deliver them, for a match and a negation alike. The match may then bind the fields those arms share.
  A constant is matched against the type its arm delivers it at, before the union widened the arm, so a refined text's
  arm never delivers a value outside its pattern. Programs the compiler refused now compile, as the types already
  admitted them.
  - Fix: none needed.
- **A bare head value is typed by every arm of its union, across headings.** Before, a JavaScript value in a head took
  the type of the terms delivering its field only within arms of the same heading. Beside an arm of another heading it
  kept its JavaScript default. So `find({ id, kind: Tone.handle("low"), x })` in one arm and
  `find({ id, kind: "mid", y })` in another was `MissingDiscriminant` (text never meets an enum), and a bare `1` beside
  a bigint column of another heading left the column out of the union's heading. After: a value that is one of the
  type the union's typed arms agree on takes that type, as the types always read it. So that union is discriminated
  by `kind`, and the column is common at bigint. A union's heading can gain such a column, which changes its SQL and
  a derived relation's view over it.
  - Fix: none for a program. Regenerate migrations for a derived relation defined by such a union.
- **Arms of different headings deliver every field they share at one type.** Before, the compiler admitted
  `find({ id, d: "a", x: t })` beside `find({ id, d: "b", x: n, y: n })`, with `t` a text and `n` an integer. It left
  `x` out of the union's heading, so no match, order or attachment could read `x`. The types already refused it.
  After: `MalformedDescription` ("arms of one query with one type per column they share; x is text and integer"),
  as for arms of one heading, and the type error is `Refusal<"a union's arms deliver each field at one type">`.
  - Fix: rename the field in one arm, or cast it to the other arm's type with `Compute.cast`.
- **The types judge a union over all its arms, as the compiler does.** `Query` and `Ordered` gain an eighth type
  parameter, `Arms`, the carriers of each arm in order; the readers infer it. After a take, an approximate search or an
  attachment over a union it is one arm with no head constant. Three or more arms told apart only by a combination of
  fields (`d: "a", e: 1`; `d: "a", e: 2`; `d: "b", e: 1`) now typecheck. Two arms of one heading that hold the same
  constants still typecheck, since only arms of different headings need telling apart. Constants whose value the
  types do not carry count as different. The check sits on the arm the callback returns. A block-bodied
  arm is still refused with TS2345 at `.rule(`. An expression-bodied arm is refused with TS2322 at its body.
  - Codemod: a type pin `Query<S, H, Ev, P, IH, Hc, Cx>` of a union query → `typeof q`, or add its arms:
    `Query<S, H, Ev, P, IH, Hc, Cx, readonly [UnionArm<Hc1, never, "rule", false>, UnionArm<Hc2, never, "rule", false>]>`
    (each arm's carriers, the attachments it carries, the stage that made it and whether a take bounds it; see the
    entry on attached arms below). Delete a `@ts-expect-error` on a union arm that now typechecks.

#### Every scope is named: `v(R, "name")`, and a self-join's two scopes are two types

- **`v` takes the scope's name.** `v(source, name)` mints one variable per field of the source in the scope `name`, a
  string literal: a declared name (ASCII letters, digits and underscores, a letter first). The name is part of each
  variable's origin, `Origin<Relation, Field, Name>`, so two scopes of one relation in a rule are two types. A
  self-join's keys, `db.get` and evidence are now typed as any join's: before, a rule that matched a relation twice
  proved no key through its variables, and `db.get` of a self-join was refused even where the engine proved one row.
  `v(R)` with one argument is gone: no default name, no overload, no alias. The JavaScript view is
  `varsOver(source, name)`.
  - Before: `const { id, title } = v(Post)`; a self-join `const a = v(Post); const b = v(Post)`.
  - After: `const { id, title } = v(Post, "post")`; `const post = v(Post, "post"); const twin = v(Post, "twin")`.
- **A rule holds one scope of each name.** Two calls to `v` with one name in one rule are refused when the rule is
  built (at `.find`): `CompileError` `DuplicateIdentity`, duplicate kind `"scope"`, at the second call, with the first
  call's location as `earlier`. The types cannot refuse it: two calls with one name have one type.
- **The one-variable-per-field rule (R1) is deleted.** A second scope of a relation the rule matches once, bound at
  another relation's field, used to be `MalformedDescription` ("mint it where it is bound"). It now compiles, as a
  variable of its own scope.
- **A Description spells each variable `<scope>.<field>`** (`post.id`), and diagnostics name variables that way. The
  user's name never reaches SQL: aliases stay compiler-derived. Type pins change: `Origin<"Task", "id">` →
  `Origin<"Task", "id", "task">`, `VarsOf<R>` → `VarsOf<R, N>`, and `typeof v<typeof Task>` →
  `typeof v<typeof Task, "task">`.
- **Codemod.** Rewrite every call `v(R)`, and `varsOver(R)`, to `v(R, "<name>")`, grouping the calls by their nearest
  enclosing function, the rule callback that holds them; R is a scope's source, compared by its source text.
  - **One scope of R in its rule:** the name is R's identifier in lower camel case: the last property for a member
    expression (`Blog.relations.Post` → `"post"`), a leading acronym lowercased (`URLQueue` → `"urlQueue"`, `U4` →
    `"u4"`). A delta source `d.added(R)` or `d.removed(R)` is `"addedR"` or `"removedR"` (`"removedComment"`). Any other
    source expression is named by hand.
  - **Two or more scopes of R in one rule:** derive each name from what the call is bound to, so the names say each
    scope's role, never a number (`r1`, `r2`):
    - `const x = v(R)`: the name is `x`. Where `x` is one or two letters (`a`, `b`, `t`), name the role by hand:
      `first`/`second`, `earlier`, `lower`, `floor`/`ceil`.
    - `const { f, g } = v(R)`, every field unrenamed: R's lower camel case.
    - `const { f: alias, … } = v(R)`: the alias without its field's name as a suffix (`{ id: parentId }` →
      `"parent"`), or the alias itself (`{ id: start }` → `"start"`); the most frequent wins.
    - By hand: two scopes destructured only to pick fields one match binds (`const { id } = v(A)`,
      `const { value } = v(A)`, then `r.match(A, { id, value })`) merge into one call,
      `const { id, value } = v(A, "a")`.
    - Names that collide within a rule, and calls in any other position (an argument, `v(R).id`), are named by hand.
  - **Strings and comments:** generated source in template literals and code in comments or docs, by hand, with the
    same rules.
  - **Typecheck after.** Every remaining error names its site: a missed `v(R)` is TS2554 ("Expected 2 arguments"), and
    a name typed `string` is `Refusal<"one literal name">`. Then run the tests: a name a rule holds twice, such as a
    helper's scope beside the rule's own of one name, is `DuplicateIdentity`, which names both calls.
- **Upgrade with one sweeping hard cutover.** Apply the codemod to the whole code base at once, typecheck to zero, and
  keep no compatibility layer: no wrapper that defaults a name, no one-argument shim.

#### An attachment over a self-join is proved per scope, and a scope's name is a declared name in its type

- **Each scope of a self-join parent proves what its own fact proves.** Before, a parent that matched a relation twice
  kept no origin for any head field, so no attachment over it was the one child or an alternatives arm: `"one"` and
  `arm(field, handle)` were refused even where the engine proved them. Now each scope keeps the origins of its head
  fields, the fields of its one fact. A declared `contained` from one scope's fields proves the one child, a reflexive
  count over one scope's fields is the bare row, and `arm(field, handle)` reads the discriminator of the scope the
  arm's key is bound to. A proof never joins a field of one scope with a field of the other: a key bound to one scope's
  account and the other's label is an Option. A scope whose head fields no one match binds together, each the field
  of another fact, keeps no origin. `EvidenceOfQuery<Q>["origins"]` of a self-join now holds each scope's fields.
  - Before: over `pairs`, a TaskLabel self-join finding `{ account: first.account, label: first.label, … }`,
    `pairs.attach("color", (p) => query(S).rule(…match(Label, { account: p.account, label: p.label, color })…), "one")`
    was `Refusal<"the one child needs a child the evidence proves exactly one per parent">`. After: it typechecks, as
    the engine proves it. An `arm` keyed by the second scope's id names the second scope's kind field.
  - Fix: none for a program. A type pin of a self-join's `origins` as `{}` → each scope's `Origin<R, F, N>`; a delivery
    stated `"option"` that now proves `"one"` may be restated.
- **A scope's name is a declared name in its type.** Before, `v(source, name)` took any one literal, and the builder
  refused a name outside the declared-name rule when the rule ran. Now the type states the rule: ASCII letters, digits
  and underscores, a letter first. `v(Task, "2task")`, `v(Task, "_task")`, `v(Task, "task-peer")` and
  `v(Task, "tâche")` are type errors, `Refusal<"a declared name: ASCII letters, digits and underscores, a letter
  first">`; a JavaScript caller's is `MalformedDescription`, as before. A scope's name names variables, never a
  PostgreSQL identifier, so it no longer keeps the 63-byte limit on its conversion that a relation's or field's name
  keeps.
  - Fix: rename the scope by the codemod of `v`'s entry above.

#### An attached arm shares its heading with no other arm, under every stage that keeps it, in the types first

- **A union of an attached arm and another arm of its heading is a type error.** The compiler refuses a union in which
  several arms share a heading and one of them is attached (`UnsupportedOperation`, "attachment on an arm of a union
  whose heading several arms share"): a fact both arms deliver would carry one arm's attachment and not the other's.
  The types admitted it. Now it is `Refusal<"an attachment on an arm of a union whose heading several arms share">` at
  the arm that joins, whether the attached arm comes first or joins, and whether it is a `Finished.attach` or the
  query a `Query.attach` closes. An attached arm whose heading no other arm has still joins, told apart by its
  constants.
  - Before: `query(S).rule((r) => r.match(Task, { id, kind: "Automatic" }).find({ id }).attach("note", …, "option"))`
    `.rule((r) => r.match(Task, { id, kind: "Manual" }).find({ id }))` typechecked, and its compile was refused.
    After: a type error at the second `.rule(`.
  - Fix: attach over the whole union, `query(S).rule(…).rule(…).attach(…)`, or give the attached arm a heading of
    its own with a constant that tells it apart.
- **An arm is attached under every stage that keeps its records.** The compiler read an arm as attached only when the
  arm was the attachment itself. A take over an attached query, `q.orderBy(…).take(k).rule(…)` with the joining arm of
  `q`'s heading, passed the union's check, and the lowering refused it later ("attachments on the arm … of a union of
  several arms"). Now the compiler reads an arm's attachments off its rows, through a take, a name and an order alike,
  so the union's check refuses it by name, and so do the types. The same reading refuses two more programs: a union
  that widens a column of an attached arm under a take, whose widening projection dropped the attachment from the
  arm's records; and, from a Description, an attachment over a union named like one an arm of it carries ("one
  attachment per name"), which the builder and the types already refused.
  - Before: `q.orderBy(["id", "asc"]).take(5).rule((r) => r.match(Task, { id, kind: "Manual" }).find({ id }))`, with `q`
    the attached query above, typechecked, and its compile was refused by the lowering. After: a type error at
    `.rule(`, and the compiler's refusal is the union's.
  - Fix: as above. Attach over the whole union, or give the attached arm a heading of its own.
- **`Arms` records what each arm is to the compiler.** `Query` and `Ordered`'s eighth type parameter is each arm's
  `UnionArm<Carriers, Attached, Stage, Bounded>`: its carriers; `Attached`, the names of the attachments its records
  carry, `never` for an arm that attaches nothing, read off the records, the fields an attachment adds beside its
  carriers, so a take, an approximate search, a name and an order keep it; `Stage`, the `ArmStage` that made it
  (`"rule"`, `"union"`, `"take"`, `"attach"`, `"approximate"`, `"recursive"`); and `Bounded`, whether a take bounds its
  rows.
  - Codemod: a pin `Query<…, readonly [Hc1, Hc2]>` →
    `Query<…, readonly [UnionArm<Hc1, never, "rule", false>, UnionArm<Hc2, never, "rule", false>]>`, or `typeof q`.

#### Every combinator over a query reads the columns it delivers, in the types first

- **Order keys, parent variables and an arm over a union are the columns every arm delivers.** A union of several
  headings delivers, as a relation, the columns its arms share, which is the heading every stage over it reads; only a
  query's result delivers each heading group whole. The types now compute that heading in one place,
  `DeliveredKeys<Head, Hc>` and `DeliveredHeading<Head, Hc>`, and every combinator reads it: `orderBy`'s keys, the parent
  variables an attachment mints, and the one arm a take, an attachment or an approximate search makes. `CommonKeys` is
  gone.
  - Before: `q.orderBy(["note", "asc"])`, with `note` an attachment of `q`, typechecked and the builder refused it
    ("fields of the result heading"); over a union of two headings, `u.attach("n", (p) => …p.own…, "array")` with `own`
    a field of one arm typechecked and the compiler refused it ("a parent variable of the parent's heading"). After:
    both are type errors (TS2322 at the key, TS2339 at `p.own`).
  - Codemod: `CommonKeys<HeadOf<typeof q>>` → `DeliveredKeys<HeadOf<typeof q>, (typeof q)["heading"]>`.
  - Fix: order by a column every arm delivers, and read in an attachment only the parent's delivered columns.
- **A take or an attachment over a union of several headings is no arm of a further union.** Such a stage has the
  columns its heading groups share for its heading, so as an arm it delivered those alone while its records' type
  promised each group's own columns. The compiler refuses it (`UnsupportedOperation`, "an arm over a union of several
  headings: only a query's result delivers each heading group, and an arm would deliver the columns they share
  alone"), and the types refuse it at the joining arm,
  `Refusal<"an arm over a union of several headings: only a query's result delivers each heading group">`.
  - Before: `u.orderBy(["id", "asc"]).take(5).rule(…)`, `u` a union of two headings and the new arm of their shared
    columns, compiled and delivered the five without their own columns. After: refused.
  - Fix: add the arm to the union before the take, `u.rule(…).orderBy(…).take(5)`, or deliver the bounded union as a
    query of its own.
- **A union of several headings is bounded once.** The compiler refuses a second take over a union of several
  headings that a take bounds already, and a page over one, since each heading group is a statement of its own. The
  types now refuse both: `Refusal<"one take over a union of several headings: each heading group is a statement of
  its own, which one take bounds and the merge across them keeps">` at the take's bound, and `Refusal<"a page over a
  bounded heterogeneous union: a group statement cannot tell which of its rows are among the union's first k">` at
  `db.page` and a compiled program's `page`.
  - Before: `u.orderBy(…).take(5).orderBy(…).take(3)` and `db.page(u.orderBy(…).take(5).orderBy(…), …)` typechecked,
    and the compiler refused them when the program compiled. After: type errors.
  - Fix: take once, over the whole union; page the union unbounded.
- **`approximateNearest` is one rule's projection in the types too.** The compiler refuses a search over anything
  else; the types now name the same source: `Refusal<"approximateNearest over one rule's projection; this source is
  …">` with "a union of rules, which no single index orders", "a bounded subset, whose own order already selects among
  the rows", "a query with attachments", "another approximate search" or "a recursive relation".
  - Before: `q.attach(…).approximateNearest({ by: "distance", take: 10 })` typechecked and its compile was refused.
    After: a type error at the spec.
  - Fix: search the rule first, then attach, take or union the search's result.
- **An approximate search over a rule whose head holds a literal runs.** The optimized lowering ordered ties after the
  distance by heading columns that could include a head literal, and PostgreSQL refuses a literal ORDER BY item
  ("non-integer constant in ORDER BY"). A column the projection holds constant settles no tie and is now no order item.
  - Before: `find({ id, kind: "doc", distance: Compute.cosineDistance(…) })` searched with `approximateNearest` failed
    when PostgreSQL ran it. After: it runs.
  - Fix: none needed.

#### A JavaScript value where a first operand belongs is refused by name

- **Every first operand refuses a JavaScript value with one named refusal.** A first operand is a term: a comparison's
  (`r.eq`, `Compute.eq` and the rest, `between`, `inSet`, `in`, `allen`, `pointIn`), a Compute operation's, a
  conditional's first branch, a guard's subject, an aggregate's and a span producer's. Before, a JavaScript value
  there failed the term's shape: `r.eq(Decimal.of("1.5"), x)` and `Compute.cond(p, Money.of(150n), x)` raised TS2739
  ("missing the following properties … expr, column, sql"), and `r.eq(1, x)` or `Compute.add(1n, x)` a bare TS2345.
  Now each is TS2345, `Refusal<"a term first: a literal takes its place opposite a term, never first">`, the refusal
  a parameter in that place already raised.
  - Fix: write the term first, `r.eq(x, 1)`, or type the value, `Compute.literal(pg.numeric(2, 1), "1.5")`.
  - Codemod: a `@ts-expect-error` naming the old diagnostic of a JavaScript value first →
    `// @ts-expect-error -- TS2345 refusal: a term first: a literal takes its place opposite a term, never first`.
    Explicit type arguments of these signatures gain one for the first operand, before the old ones (after the
    predicate's in `Compute.cond`).

#### A schema holds each relation under its own name, and a schema or role of thousands typechecks

- **`schema(name, relations, statements)` and `schema.extend(base, relations, statements)` hold each relation under
  its own name**, as a role's whole entries already did. `schema("Work", { Tasks: Task }, [])` is a type error,
  TS2322 `Refusal<"a schema holds each relation under its own name">`, and `MalformedDescription` ("a relation under
  its own name; Tasks holds the relation Task") from the builder where the types do not see it (a record typed
  `Record<string, …>`). The record is the level's index by name, so one level cannot declare a name twice: the same
  relation under two keys is no longer taken as one declaration.
  - Codemod: an entry `key: R` whose key is not R's name → `Name: R`, shorthand where the binding has that name; a
    record built at run time is keyed by `r.name`. A generic helper that rebuilds a schema from its record carries the
    proof, `Schema<N, R, St> & { readonly relations: UnderOwnNames<R> }`; `UnderOwnNames` is exported from the schema
    barrel.
- **A schema of thousands of statements and a role of thousands of entries typecheck.** A lookup by relation name went
  through an index remapped with `as`, whose keys TypeScript recomputes at every `keyof`, one instantiation per key,
  so `schema(...)` failed with TS2589 once its statements named 699 relations, and `role(...)` at a few hundred
  entries. Now "R is one of the level's relations" is one membership test in the union of the record's values, which
  the checker builds once per record, and candidate keys are indexed by their own domain; instantiations grow
  linearly. The type test `schema/budget` checks one schema of 2,000 relations and about 2,500 statements, a full role
  and a role through `Pick`. No codemod: delete any workaround, such as statements typed `ReadonlyArray<Statement>`
  to skip the check, or a role record written out as a literal.
- **Format and state:** none. snapshot.json and meta.json do not change, and no installed object changes.

#### A `str.regex` pattern is bounded by PostgreSQL's regex compile space alone, never by its length or nesting

- **The budget of 512 regex constructs is removed.** A pattern of any length and nesting depth parses, a group nested
  100,000 deep included, and compilation refuses one with `ResourceBound` only past grizzle's measures of PostgreSQL's
  regex compile space (`REG_MAX_COMPILE_SPACE`): 4,096 positions once counted repetitions are written out, 65,536
  pairs of positions joined by empty paths, 8 anchors, and 8,192 for anchors times positions. A pattern the budget
  refused may now be admitted, such as RFC 3986's URI-reference grammar written as one pattern.
- **`CompileBound` loses `regexConstructs`, and `regexCompileSpace.measure` is structured.** `measure` was a sentence;
  it is now a `RegexSpaceMeasure`, exported: `{ kind: "positions" | "anchors", limit, needed }`,
  `{ kind: "anchorWeight", limit, anchors, positions }`, `{ kind: "closurePairs", limit }` or `{ kind: "anchorLoop" }`.
  The error's message states the measure and names PostgreSQL's limit.
  - Codemod: a branch on `bound.kind === "regexConstructs"` → delete it; a read of `bound.measure` as text → a switch
    on `bound.measure.kind`, or the error's message.
- **Format and state:** none. A pattern the budget admitted keeps its CHECK, its canonical key and its digest, so
  snapshot.json and meta.json do not change, and no installed object changes.

#### The unit relation is a relation input: every insert of serial columns alone compiles; a relation parameter has a field (#2)

- **An insert whose every carried column is serial compiles and inserts.** Before, an insert through a writable query
  entry whose head holds only serial columns was refused before any SQL, as an array or a Stream, with its serial
  values (`[{ no: 1n }]`) or without them (`[{}]`): `MalformedDescription` ("a relation parameter or a row with at
  least one field"). A described insertion whose rows carry no column, into such an entry or into a table whose every
  column is an identity, was refused with `UnsupportedOperation` ("as an array or a Stream of empty facts"). All of
  them now compile. A row that leaves out every serial column is a new row, and equal such rows are one new row, so
  `[{}, {}]` and a query of several rows of no column each insert one row. No codemod: delete any workaround, such as
  a column added to the entry's head only to carry a value.
- **`r.relation(name, {})` is refused.** A relation parameter is a list of rows, matched like a table, so its heading
  has at least one field. Before, the program built and its compile was refused. After: a type error at the call,
  `Refusal<"a relation parameter has at least one field, as a relation does">`, and `MalformedDescription` ("a heading
  of at least one field") from the builder when the types are bypassed; a Description whose relation parameter has a
  heading of no field is refused where it is decoded. Fix: give the parameter its fields, or delete it and the match
  that reads it. No codemod.
- **A generated insert into a table whose every column is an identity reads its input.** It was a statement of its
  own, `INSERT … ("no") OVERRIDING USER VALUE SELECT 0::bigint`, tied to the facts only by a skip at run time. It is
  now the same `INSERT … SELECT FROM` its input as every other insert, of no column (`INSERT INTO t AS r SELECT FROM
  …`). Its outcome is unchanged. No codemod.
- **Format and state:** none. snapshot.json and meta.json do not change, and no installed object changes; only the
  statements a write program sends do.

#### Membership in an empty list is false (#2)

- **`r.inSet(x, [])` and `Compute.in(x, [])` build a predicate that is false.** So do a row check's and a contract's
  `.in([])` and a Compute term's `.in([])`: a membership in no value holds of no row, and `r.not` of a rule that
  filters by one holds of every row, by the ordinary rules. Before, each was refused when the program was built, with
  `MalformedDescription` ("a nonempty finite list of literals"), though the types took `[]`; the types are unchanged
  and now say exactly what is admitted. A Description whose `in` holds no value is decoded, not refused. No codemod:
  delete any guard you wrote around an empty list, such as `ids.length === 0 ? … : r.inSet(x, ids)`.
- **Format and state:** none. A row check or a contract whose predicate is `.in([])` admits no row, as its CHECK
  says.

#### An empty conjunction is true and an empty disjunction is false (#2)

- **`r.and()` and `Compute.and()` build the constant `true`; `r.or()` and `Compute.or()` build the constant `false`.**
  So do a row check's `and()` and `or()`: a conjunction of no predicate holds of every row, a disjunction of none of no
  row, and either of one predicate is that predicate. Before, each empty one was refused when the program was built,
  with `MalformedDescription` ("at least one predicate"), though the types took no argument; the types are unchanged
  and now say exactly what is admitted. A Description whose `and` or `or` holds no operand decodes to `true` or
  `false`, not refused. No codemod: delete any guard you wrote for the empty case, such as
  `filters.length === 0 ? … : r.and(...)`.
- **Format and state:** a query, row check or contract that wrote `and` or `or` of one predicate now holds that
  predicate itself in its Description, so a fingerprint over that Description changes once; none otherwise.

#### A stage a statement reads more than once is computed once, and the `nodes` budget is removed

- **No query is refused for its number of attachments or for the stages it shares.** The conservative artifact computed
  a stage again at every place its statement read it, so its size grew with the number of paths through the query,
  and a budget of 10,000 lowered nodes refused large queries: one attaching about 90 relations was refused with
  `ResourceBound`. Now a stage a statement reads more than once is one `MATERIALIZED` CTE, of the statement, or of the
  LATERAL subquery or EXISTS whose outer row it reads, so a statement grows with its query, and a query attaching 200
  relations compiles. No codemod.
- **`ResourceBound` has no `budget` bound.** `nodes` was the last compiler budget, so no compilation is metered and a
  `ResourceBound`'s bound is never `{ kind: "budget" }`.
  - Fix: a program that switches over the `kind` of a `ResourceBound`'s bound drops the case `"budget"`.
- **Format and state:** a drafted law validation (`<n>-validate.sql`, and its statement in meta.json) reads a stage
  its violation query reads more than once from one `MATERIALIZED` CTE. snapshot.json and every fingerprint are
  unchanged, so a folder drafted before keeps passing `grizzle check`.

#### No read raises an evaluation error: integer and money arithmetic is exact, floats are IEEE 754, partial operations are guarded (#9)

- **Integer arithmetic is exact and delivers `bigint`.** `Compute.add`, `sub`, `mul`, `neg`, `abs`, `div`, `gcd` and
  `lcm` over `smallint`, `integer` and `bigint` yield an *exact integer*: SQL `numeric` at scale 0 (`bigint` while its
  digit bound is at most 18 digits), host `bigint`, which never overflows. `Compute.div` over integers truncates.
  `Compute.width` of a span is an exact integer too. `Compute.mod` keeps its operands' type: a remainder is smaller in
  magnitude than its divisor and never overflows.
  Before: `Compute.add(a.qty, b.qty)` was `Term<number, …, "integer">` and raised 22003 past 2^31 − 1. After: it is
  `Term<bigint, …, "exact integer">`. A JavaScript literal opposite an exact integer is a `bigint`.
  - Codemod: a head or comparison literal opposite integer arithmetic, `0` → `0n`; a host read of such a column,
    `row.total: number` → `row.total: bigint`. To store an exact integer into an integer field, narrow it:
    `Compute.cast(x, pg.integer)` under a guard that proves it fits,
    `Compute.when(Compute.within(x, -2147483648n, 2147483647n), (x) => Compute.cast(x, pg.integer), 0n)`.
- **A computed integer or money value binds at a plain integer or money column.** `r.match(Tag, { w:
  Compute.mul(note.k, 2) })` binds an exact integer at an integer column: the checker compares the column with the
  value, the column widened into the exact integers, as `Compute.eq` does. Two variables still bind each other only at
  one type. No codemod.
- **Money arithmetic is exact.** `Compute.add` and `sub` over money yield *exact money*, delivered as `Money`, which
  never overflows; `r.sum` over money is exact money. Narrow it into a `pg.money` field with `Compute.cast` under a
  `Compute.within` guard. No codemod for reads: the host type is still `Money`.
- **Float arithmetic is IEEE 754.** `+`, `-`, `*`, `/` and `sqrt` over `real` and `double precision`, casts into a
  float and float sums round to the nearest value or overflow to ±Infinity: `1e308 * 10` is `Infinity`, `x / 0.0` is
  `±Infinity` by the sign of `x`, `0.0 / 0.0` and `sqrt(-1.0)` are `NaN`, where PostgreSQL raised 22003 or 2201F.
  No codemod.
- **A partial operation needs its precondition proved, by a type or by `Compute.when`.** `Compute.div`, `mod`, `quot`
  and `rem` need a divisor proved nonzero (a float's excepted); numeric `sqrt` a radicand proved nonnegative; `power`
  a base proved nonnegative and nonzero, or its exponent nonnegative; `widthBucket` and `minScale` finite operands; a
  cast from numeric or a float into an integer or money a value proved finite, and every narrowing a value proved to
  fit. An unproved divisor is a type error naming the guard to write, and compilation refuses what the types admit but
  cannot be proved (a narrowing's range, a power's magnitude) with the new `CompileError` reason `PartialOperation`
  (`{ at, operation, precondition, operand, guard }`). Facts come from a number or bigint literal's own type, from a
  contract that declares them, and from a guard.
  Before: `Compute.div(t.amount, t.count)` compiled and raised 22012 on a zero count. After: it is a type error; write
  `Compute.when(Compute.nonzero(t.count), (count) => Compute.div(t.amount, count), 0n)`.
  - Codemod: wrap each unguarded partial operation in `Compute.when(<guard>(x), (x) => <operation over x>, <your
    value>)`, the guard one of `Compute.nonzero`, `Compute.nonnegative`, `Compute.positive`, `Compute.isFinite` and
    `Compute.within(x, low, high)`. A guard is also a predicate, so `r.where(Compute.nonzero(x))` reads as `x <> 0`.
  - A contract may declare what its predicate proves, so its values need no guard:
    `contract("Divisor", pg.bigint, (v) => v.ne(0n), { proves: ["nonzero"] })`. Compilation proves each declared fact
    from the predicate, and a declaration it does not prove is `MalformedDescription`.
  - A program that switches over `CompileReason["_tag"]` exhaustively gains `"PartialOperation"`.
- **A parameter is a term of its declared type, first included.** `r.param(name, type)` is of `type` wherever it
  stands: a guard's subject (`Compute.when(Compute.nonzero(d), (d) => Compute.div(x, d), 0n)` over
  `d = r.param("d", pg.bigint)`, which delivers `0n` for `d = 0` under custom and generic plans alike), `Compute.base`'s
  operand, a first operand and a conditional's first branch. A parameter of a contract has the facts it declares, so
  `Compute.div(x, Compute.base(r.param("d", Divisor)))` needs no guard. Before: a parameter took the type of the term it
  met, never stood first, and a head parameter no other use typed was `MalformedDescription`. After: its declared type
  is its type, opposite a term it meets that term like any other (`MalformedDescription` when the types do not meet),
  and two declarations of one name must be compatible.
  - Codemod: a parameter declared at a base type opposite a contract field, `r.param("p", pg.bigint)` → `r.param("p",
    Cents)`; the types already refused the base.
  - The Description format changed for JavaScript callers who build Descriptions by hand: a scalar parameter is
    `{ kind: "param", name, type }`, `type` its field descriptor, and the decoder refuses one without `type`
    (`MalformedDescription`); an import binds a relation parameter to the importer's as `{ kind: "relationParam", name }`
    in its bind map, where it was `{ kind: "param", name }`; and a `Compute.when` is
    `{ kind: "when", guard, subject, proved, otherwise }`, `proved` the branch that receives the subject proved.
- **`Contract`'s third type argument is the tuple of the fact names it declares.** `contract(name, base, predicate,
  { proves })` has the type `Contract<Name, Base, Proves>`, `Proves` the `proves` tuple, and `Contract<Name, Base>` is a
  contract that declares none, the same type `contract(...)` without `proves` gives.
  - Codemod: a written `Contract<N, B, DeclaredFacts<readonly ["nonzero"]>>` → `Contract<N, B, readonly ["nonzero"]>`;
    `Contract<N, B>` is unchanged.
- **A recursive relation's counter types.** A recursive arm's head delivers the row by the same rule a binding meets
  its column, so `hops: Compute.add(hops, 1)` into `row: { hops: pg.integer }` typechecks, and compilation proves the
  counter fits its field from the recursion's bound, or refuses it with `PartialOperation`. An arm whose head misses a
  row field, adds one, or delivers a type that meets no field's is refused at the arm, `Refusal<"an arm's head delivers
  the row: each of its fields, at a type that meets the field's">`. No codemod.
- **A parameter is checked against its contract and pattern at bind.** A scalar or relation parameter whose declared
  type is a contract or a refined text is refused at bind, `EncodingFailure` with reason `refinedValue`, when its value
  violates them, before any SQL is sent; before, a read cast it to its domain and PostgreSQL raised 23514. A program
  that switches over the codec fault words gains `"refinedValue"`. No codemod.
- **A numeric expression whose digit bound passes 131,072 digits is `ResourceBound`** with `bound: { kind:
  "numericDigits", limit, needed }`; every numeric's digits are known, a field's by its typmod and a computed one's by
  its type's bound.
  - Fix: a program that switches over `CompileBound["kind"]` exhaustively gains `"numericDigits"`.
- **A role entry's arithmetic is no longer refused.** A role's query entry may compute with arithmetic, casts and
  every other Compute operation, since no operation raises; the refusal of arithmetic in a role entry is removed. No
  codemod.
- **A derived relation stores no exact value.** A derived head that delivers an exact integer or exact money is
  `DerivedRefused` with reason `exactField`; narrow it with `Compute.cast` into the field's type under a guard. An
  aggregate is a head column, never a term, so a sum is narrowed one stage later: find the sum in an interior stage
  (`r.interior`), match it, and narrow the matched variable,
  `Compute.when(Compute.within(total, least, greatest), (t) => Compute.cast(t, pg.money), Compute.literal(pg.money,
  Money.of(0n)))`. `Compute.cast(r.sum(...))` is refused and names that route.
- **`r.sum` over `bigint` is `numeric`, and over money exact money.** Sums over exact values are exact. No codemod for
  reads of `bigint` sums, which already delivered `Decimal`.
- **Format and state:** snapshot.json changes: a scalar operation node carries its precondition proof, failure
  annotations are gone, and a contract records its declared facts.
  Re-create every database installed before.

#### Node 26 and Effect 4.1 are the floor

- **grizzle needs Node 26 or later.** `engines.node` of `@bjornpagen/grizzle` and `@bjornpagen/grizzle-engine` is
  `>=26`. No codemod: run on Node 26.
- **`effect` is a peer dependency at `^4.1.2`.** Install Effect 4.1 beside grizzle; 4.0 is outside the range. Effect
  4.1 moved its crypto services out of the `effect` barrel into `effect/crypto`. No codemod in grizzle code.

#### Effect Schema leaves grizzle's runtime: errors are `Data.TaggedError`, snapshot.json and meta.json are trusted once their digests hold

- **Every grizzle error is a `Data.TaggedError`.** `OpenError`, `ReadFailure`, `TransientFailure`,
  `TransportFailure`, `ExecutionFailure`, `CommitUnknown`, `StaleSnapshot`, `CredentialError`, `TokenError` and every
  reason class keep their `_tag`, their fields, their getters and their `message`, and `Effect.catchTag`,
  `catchReason`, `catchReasons` and `unwrapReason` reach them as before. They are no longer Effect Schema classes: no
  `.make`, no decoding or encoding, no use as a Schema, and the constructor checks nothing its type does not.
  - Codemod: `CredentialError.make({ cause })` → `new CredentialError({ cause })`; `TokenError.make({ cause })` →
    `new TokenError({ cause })`; any grizzle error `X.make(args)` → `new X(args)`, and `X.make()` of an error without
    fields → `new X()`.
  - Codemod: `Schema.is(X)(u)` of a grizzle error `X` → `u instanceof X`; a test of `_tag` needs no change.
  - Fix: a grizzle error held in a field of the application's own Schema is declared with
    `Schema.declare((u: unknown): u is X => u instanceof X)`.
- **Format and state:** snapshot.json records each installed statement as itself: every clause stated (an empty list,
  a false flag, the ascending order), which it left out before, and each placeholder as the statement holds it, so it
  grows by what it now states. Its fingerprint is the digest of the file's own JSON value, every property but the
  fingerprint, checked over that value before anything reads it as a snapshot: a snapshot.json edited by hand is still
  refused (`grizzle check`, `grizzle generate`, `DbLayer.make`), now before it is read. meta.json is
  `{ "meta": ..., "seal": ... }`, its meta sealed by the digest of its content: a meta.json edited or corrupted
  outside grizzle is refused as malformed by `grizzle check`, `grizzle generate` and `grizzle migrate` before its meta
  is read. Every snapshot fingerprint changes, and a previous snapshot.json or meta.json is refused, never read:
  delete `migrations/`, re-create every database and run `grizzle generate` (step 3 above).

#### What the full test run found and fixed: proofs PostgreSQL disagreed with, and literals, plans and checks it refused

Every one of these was reached by the suites under the witness phases (#1) and the cutovers above; none needs a
codemod unless it says so.
- **Cast proofs are PostgreSQL's conversions.** A narrowing proof reads the conversion the cast is: an exact
  conversion is not widened (so `Compute.cast(x, pg.numeric(1, 0))` under `Compute.within(x, -9n, 9n)` is proved),
  rounding to a scale widens by one unit, and a float into numeric widens outward to the float's significant digits
  (6 for `real`, 15 for `double precision`), where before a `real` near the bound was proved and PostgreSQL raised
  22003. `fits` into a numeric typmod admits NaN, which a numeric column holds; a cast into an integer or money also
  needs the value finite. Float bounds account for IEEE rounding (overflow to ±Infinity, underflow to 0), so a float
  product or divisor is no longer proved finite or nonzero where rounding makes it infinite or zero.
- **Power proofs are PostgreSQL's limits.** A numeric power with a fractional exponent is proved in range only while
  its result has at most 6000 digits (PostgreSQL's power_var); an exponent proved integral keeps the wider range of
  power_var_int. A small base with a negative exponent is bounded too (`power(1e-16383, -10)` overflows and was
  proved). Write the guard the type error names.
- **Recursive counters.** A counter is proved from the recursion's termination interval: every value the step
  computes from every state the counter holds, the step past its bound included. A walk whose arms step by 1 and 2
  is admitted, and so are mixed arms (`h: Compute.add(h, 1)` beside `h: h`). A counter seeded by data or bounded by a
  parameter can reach its carrier's extreme and is refused (`PartialOperation`); a counter without a bound is refused
  as unbounded state.
- **Float arithmetic runs natively where that is exact.** An IEEE 754 operation is sent as PostgreSQL's own
  operation where a kept proof shows its result is the IEEE result (literals, contracts, guards, conversions of
  exact integers), and otherwise as a guarded form whose operands are bound once, fenced so PostgreSQL plans it in
  linear time: a percentile over a few rows took minutes to plan, and now milliseconds.
- **An entry insert leaves out only its classed serial fields.** An insert through a writable entry may omit the
  serial fields the entry classes, and carries every serial field its filter reads, as the README states; before,
  the fill was checked against the table's whole serial list and refused. Every serial value the insert supplies, one
  its filter reads or its fill fixes, is the value stored (`OVERRIDING SYSTEM VALUE`, and the serial advances past
  it). Only the serial fields the entry classes are drawn. At `e7fd8b3` such a supplied value was replaced by a drawn
  one without an error, or refused by the entry's row-level policy (42501): a row written there through such an
  entry may hold a wrong serial, so re-create every database written at that commit.
- **A literal equality in a role or workload filter is indexed.** The index request of a filter such as
  `org = '<uuid>'` now holds that column, so it is read by an index and not a scan; an equality over a roster handle
  alone is still no index. Index names and snapshots change.
- **Writing an exact value into a plain field is a type error.** A ChangeSet member (put, insert, delete, an entry
  write) whose head writes a field a term of another SQL type than the field's, an exact integer or exact money into
  a `bigint` or `money` field above all, is refused by the types,
  `Refusal<"a member's head writes each field at its type: an exact value re-enters a plain field only by Compute.cast">`;
  before, the types admitted it and compilation refused it (`DescribedHeadingMismatch`). A JavaScript value is judged
  by its host type as before.
  - Fix: narrow the term under a guard, the way a credit into a `bigint` balance is written:
    `balance: Compute.when(Compute.within(Compute.add(balance, amount), -(2n ** 63n), 2n ** 63n - 1n), (b) => Compute.cast(b, pg.bigint), balance)`,
    with the otherwise-value your domain chooses.
- **Smaller corrections:** a rewritten WITH or target table of an INSERT is no longer lost (the SQL transformer);
  a residual law's violation probe admits a contract over text; a read's relation parameter outside its refinement
  is refused at bind (`EncodingFailure` with `refinedValue`), as a scalar parameter is; a page over a vector key
  compares by pgvector's qualified operator; `r.not` binds an exact value at a plain column; a money literal is
  written in its one form (`1.5::money`); decimal literals are never written with an exponent.
- **Format and state:** snapshot.json changes again: a cast's operation id names its source carrier
  (`cast:exactInteger->numeric`, where exact carriers shared numeric's id), an interval premise records whether it
  admits NaN, and a float operation may carry its native proof. Delete `migrations/`, re-create every database and
  run `grizzle generate`.
