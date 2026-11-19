---- MODULE Properties ----
VARIABLES pc, goalStatus, goalRevision, verdict, drafted, reviewed, ready,
          approved, outcome

\* Independently authored requirements, NOT derived from questions.yml.
\* Full route only. The candidate depends on approved Goals revision "1".
Prerequisites == drafted => (goalStatus = "approved" /\ goalRevision = "1")
ReviewBeforeReady == ready => (drafted /\ reviewed /\ verdict = "clean")
HumanBoundary == ~approved
TruthfulReady == (outcome = "ready") => ready
Finishes == <>(outcome /= "none")
====
