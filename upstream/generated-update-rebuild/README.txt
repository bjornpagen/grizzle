README: the per-row re-initialization of stored generated columns in an UPDATE that feeds none of them, PostgreSQL 18
and 19, with a patch for master, REL_19_STABLE and REL_18_STABLE

Status: ready to send, NOT sent. Nothing in this folder has gone to any list, site or PostgreSQL remote. The owner
sends it, by hand.

1. WHAT THIS IS
   - The bug: when an UPDATE assigns no column any stored generated column of its table reads, ExecInitGenerated()
     frees its array and stores NULL in ri_GeneratedExprsU, which ExecComputeStoredGenerated() takes to mean "not
     initialized yet", so every row parses and walks every generation expression again in ExecutorState: about 81 kB
     a row with one 1,000-element IN list, 72 GB in a migration of ours. ON CONFLICT DO UPDATE, MERGE and
     partitioned tables do it too (EVIDENCE.txt 1, 3).
   - Introduced by 83ea6c54025 "Virtual generated columns" (Peter Eisentraut, 2025-02-07), confirmed by building it
     and its parent (EVIDENCE.txt 2). Affected: every 18 release, 18.0 to 18.7, 19.0, REL_18_STABLE, REL_19_STABLE
     and master as of 2026-11-19. 17 is not.
   - It is already known upstream: Anton A. Melnikov reported it on pgsql-hackers on 2026-03-30, "[BUG] Excessive
     memory usage with update on STORED generated columns." (https://postgr.es/m/ddc34dbd-1efc-4710-824c-e101e7eb63e6@postgrespro.ru).
     Matthias van de Meent posted a v2 that tests ri_extraUpdatedCols_valid in ExecComputeStoredGenerated(); Tom Lane
     objected (callers would need to know how ExecInitGenerated works, and he suspected INSERT too) and proposed three
     new validity booleans squeezed into ResultRelInfo's padding; Matthias objected to new fields in back branches and
     deferred to Peter. The thread ends there, seven messages all on 2026-03-30, and nothing was committed.
   - v3, ours (master/, REL_19_STABLE/, REL_18_STABLE/): ExecInitGenerated() keeps the array even when nothing needs
     computing, as 17 did, so a NULL array means only "not initialized" again, for UPDATE and INSERT alike. That answers
     Tom's objection (callers test the field they use and nothing else) and Matthias's (no new field, back-patchable
     as is). The "Don't call twice" assertion for UPDATE tests ri_extraUpdatedCols_valid, so it can fire; a new
     regression test fails it without the fix (EVIDENCE.txt 5b). The design fork was settled this way because the
     bug is a NULL that means two things: removing the second meaning beats adding a flag beside it.

2. WHAT TO SEND, TO WHOM
   - A reply in that pgsql-hackers thread, not a new report to pgsql-bugs. PostgreSQL's bug reporting guidelines ask
     first whether a bug is already known (https://www.postgresql.org/docs/current/bug-reporting.html 5.1), and this
     one is, on hackers; patches go to pgsql-hackers (https://wiki.postgresql.org/wiki/Submitting_a_Patch); and a
     reply keeps Tom's and Matthias's objections, which v3 answers, in the same thread the commit's Discussion link
     names. The list is reply-all and bottom-posted, plain text.
   - email.txt is that reply: To Peter Eisentraut (the code's author, whom the thread waits on), Cc Tom Lane, Matthias
     van de Meent, Anton A. Melnikov and pgsql-hackers, In-Reply-To the thread's last message
     (CAEze2WhrYY6J=0X54EQbTH0POWPTSnWeAwNJd01vcoWoXhtiig@mail.gmail.com), with References. To reply from a mail
     client: open https://www.postgresql.org/message-id/CAEze2WhrYY6J%3D0X54EQbTH0POWPTSnWeAwNJd01vcoWoXhtiig%40mail.gmail.com,
     sign in with a PostgreSQL community account and use "Resend email" to have the archive mail it to you, then
     reply-all to it and paste email.txt's body below the headers. Or set In-Reply-To and References by hand as
     email.txt gives them.
   - Attach master/v3-0001-Don-t-initialize-generated-columns-again-for-ever.patch only: it applies as is to
     REL_19_STABLE and REL_18_STABLE (EVIDENCE.txt 5e). The REL_19_STABLE and REL_18_STABLE files are the same change
     made on those branches, for a committer who asks; their subjects say [PATCH REL_19 v3] and [PATCH REL_18 v3].
     Attach, don't paste. The name is v3 because the thread's v1 is Anton's and v2 Matthias's.
   - Before sending, in a PostgreSQL clone at master (likewise for a back-branch file on its branch):
         git am master/v3-0001-*.patch
         git commit --amend --reset-author    # sets your sending address as the author, From: is the GitHub noreply
                                              # address; edit "Reported-by: REPLACE-ME <REPLACE-ME>" to your name
                                              # and address, or delete that line
         git format-patch -v3 -1
     The sending address is deliberately not written anywhere in this public repository.
   - Afterwards, once the reply is in the archive: add the thread to the open commitfest
     (https://commitfest.postgresql.org/, community account), as a bug fix, so it is not lost again; the March thread
     never had an entry.

3. HOW TO APPLY AND TEST
       git clone https://git.postgresql.org/git/postgresql.git && cd postgresql
       git am .../master/v3-0001-*.patch                          # or: git checkout REL_18_STABLE && git am .../REL_18_STABLE/v3-0001-*.patch
       meson setup build -Dcassert=true -Dtap_tests=enabled      # TAP needs Perl's IPC::Run
       ninja -C build && meson test -C build                     # every suite; make check-world under autoconf
   - The kill: put the "didn't need it after all" block back in ExecInitGenerated(), keeping the new Assert, and
     generated_stored fails with TRAP: failed Assert("!resultRelInfo->ri_extraUpdatedCols_valid").
   - The memory, against any build, unpatched and patched: psql -X -f repro.sql (40,000 rows, ExecutorState raised as a
     NOTICE), and psql -X -v n1=10000 -v n2=20000 -v n3=40000 -f measure.sql for every statement kind at n, 2n and 4n
     rows, read both from pg_backend_memory_contexts and, through pg_log_backend_memory_contexts, from the server log.

4. FILES
   master/v3-0001-...patch          the patch, git format-patch of the commit on master 5c06a7ef24c
   REL_19_STABLE/v3-0001-...patch   the same, cherry-picked onto REL_19_STABLE 898a967c0e4
   REL_18_STABLE/v3-0001-...patch   the same, cherry-picked onto REL_18_STABLE 1901aa07eda
   email.txt                         the reply to send
   EVIDENCE.txt                      the cause in the source, the introducing commit, before and after numbers on all
                                     three branches, the tests
   repro.sql                         the reproduction the email inlines
   measure.sql, measure-size.sql     every statement kind at three sizes, for EVIDENCE.txt 3
   NOTES.txt                         grizzle's side: its workaround and when it goes

5. CHECKLIST: PostgreSQL contribution policy, applied
  A. GATES BEFORE REPORTING
  [x] Check whether the problem is already known (bug-reporting.html 5.1): it is, the pgsql-hackers thread of
      2026-03-30 (section 1). A web search for ExecInitGenerated, ri_GeneratedExprsU and "generated column UPDATE
      memory" finds that thread alone, besides Apache AGE PR #2450, a different per-row re-initialization in an
      extension that builds a ResultRelInfo per row. No commit on master, REL_19_STABLE or REL_18_STABLE since touches
      it.
  [x] Check the current development branch: master 5c06a7ef24c, built and measured (EVIDENCE.txt 1, 3).
  [x] A released version is affected: 18.0 to 18.7 and 19.0 carry the code; REL_18_STABLE and REL_19_STABLE measured.
  [x] Don't duplicate a discussion (https://wiki.postgresql.org/wiki/Guide_to_reporting_problems): a reply in the
      thread, not a new one.
  B. REPORT CONTENT
  [x] A self-contained reproduction runnable with psql -X, inline in email.txt (repro.sql).
  [x] Observed and expected behaviour, versions and platform: email.txt, EVIDENCE.txt.
  [x] Plain text, bottom-posted, quoting what it answers, no confidentiality footer.
  C. PATCH
  [x] Against current master, one patch, git format-patch, versioned after the thread's v1 and v2.
  [x] Commit message in the project's style: summary line, cause, fix, effect, test, Reported-by, Discussion,
      Backpatch-through: 18.
  [x] A regression test, which fails without the fix on assert-enabled builds; the memory is not testable in
      regress, as the commit message says, and repro.sql is the evidence.
  [x] Builds with assertions; meson test, every suite including TAP, passes on master, REL_19_STABLE and REL_18_STABLE.
  [x] pgindent clean, git diff --check clean.
  [x] Back-branch versions prepared and tested; the master patch applies to both as is.
  [ ] The author and Reported-by lines: the owner sets them before sending (section 2).
  [ ] The commitfest entry, after the reply reaches the archive.
