README: pg_plan_advice (contrib, new in PostgreSQL 19): advice for a scan's parameterization, cached generic plans
that follow the advice in force, and relation-qualified identifiers; a v1 series of four patches for master

Status: draft, NOT sent. Nothing in this folder has gone to any list, site, commitfest or PostgreSQL remote. Sending
it publishes under Bjorn's name and needs his OK on the final text; he sends it, by hand.

1. WHAT THIS IS
   - Three gaps grizzle measured in pg_plan_advice, each a place where the module's own guarantees fail
     (EVIDENCE.txt has the numbers and how they were taken):
     a. Parameterization isn't in the vocabulary. Advice pins a join's order, its method and the inner's index, but
        not whether the inner scan takes parameters from the outer side, so a probe and a join-filter plan generate
        the same advice, and when statistics say a table is empty the advice reproduces the wrong one: add_path()
        frees the parameterized path while the base rel is planned. That breaks the README's round-trip promise.
     b. A cached generic plan ignores the advice in force. PostgreSQL's foreign-key queries are prepared once per
        constraint and kept for the backend's life, so the first transaction to run a check decides its plan for
        every later one, and SET LOCAL advice outlives its transaction. Upstream knows the general case (Noah Misch's
        review, 2026-08-27) and documented it (26bd08fb5c0, "use DISCARD PLANS"); the RI measurement is new.
     c. Advice for alias x lands on every query's x. The foreign-key queries alias every table x, so advice could not
        reach them per table: one item per table conflicts in both checks.
   - The series (master/, git format-patch of the lane's branch, against master cf9d92d1f755):
       v1-0001 Let extensions restrict the parameterization of a relation's paths.   core: RelOptInfo
               pgs_required_outer/pgs_forbidden_outer, checked in add_path() and siblings and reparameterize_path();
               also reparameterize_path() now honors IndexOptInfo.disabled (a bug in 19, could be split out and
               back-patched)
       v1-0002 pg_plan_advice: Add PARAMETERIZED and UNPARAMETERIZED advice.          generation from the final plan,
               enforcement through 0001, README, SGML, tests
       v1-0003 Replan a cached generic plan when the plan advice in force changes.    core: check_cached_plan_hook in
               plancache.c; pg_plan_advice records the advice each plan was planned under and revalidates by source;
               advisor generation callback (API change); pg_stash_advice supplies one; DISCARD PLANS limitation out of
               the docs; tests
       v1-0004 pg_plan_advice: Add relation-qualified identifiers.                    alias:schema.relation, one shared
               matching function, docs, tests including a real foreign-key check advised per table
     45 files, +3,454/-212 (1,506 lines of C, the rest tests, expected output and docs).
   - Design and its reasoning: ~/.cache/grizzle-release/status/PG-ADVICE-DESIGN.md (sections 3, 4, 8). Main and
     Bjorn reviewed the direction on 2026-11-27: include advisors in revalidation, no generated-qualification GUC.

2. WHAT TO SEND, TO WHOM
   - A new thread on pgsql-hackers (patches go there: https://wiki.postgresql.org/wiki/Submitting_a_Patch). These are
     new features for 20, not fixes to a pending thread, though 0003 answers Noah's report; the cover letter cites it.
   - email.txt is the cover letter: To Robert Haas (the module's author and committer), Cc Noah Misch (who reported
     the cached-plan problem and drove the identifier-uniqueness fix 0004 builds on) and pgsql-hackers. Bjorn may
     want to Cc Tom Lane too, since 0001 touches add_path() and 0003 plancache.c; that is his call. Plain text,
     the four patches and EVIDENCE.txt and repro.sql attached (the "Attach:" line is for the sender, not a header).
   - The patches' author line is Bjorn Pagen <11238136+bjornpagen@users.noreply.github.com>, git's configured
     address in the lane's tree. Before sending, either regenerate with his list address (git -c user.email=... in a
     clone, or edit the From: lines) or send as is. Each commit message ends with a Co-Authored-By line for Claude;
     PostgreSQL commit messages carry trailers like "Co-authored-by:", but committers write their own messages, so
     whether to keep it is Bjorn's call.
   - After sending: register the thread in the next open commitfest (https://commitfest.postgresql.org), topic
     "Performance" or "Miscellaneous", and review a patch of similar size in return, as is customary.

3. HOW TO REPRODUCE AND TEST
   - Build: meson setup build <src> -Dcassert=true -Dtap_tests=enabled; ninja -C build; meson test -C build --suite
     setup; meson test -C build --suite pg_plan_advice --suite pg_stash_advice --suite test_plan_advice --suite
     regress --suite plpgsql (TAP needs Perl's IPC::Run).
   - repro.sql reproduces EVIDENCE.txt sections 2 and 3 on a patched build (see its header). The same script on
     unpatched master lacks PARAMETERIZED and the qualifier, so its D2/D3/R3 lines fail to parse there; EVIDENCE.txt
     3a has the unpatched numbers, measured with the lane's ri1 script.

4. CHECKLIST BEFORE SENDING
   - Rebase onto current master and rerun the suites above; the module changes often (25 commits since June).
   - Read the four commit messages and email.txt as the final text; names in section "Things I'd most like opinions
     on" are deliberately open.
   - Decide the author address and the Co-Authored-By trailers (section 2).
