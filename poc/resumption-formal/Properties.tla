---------------------------- MODULE Properties -----------------------------
EXTENDS Naturals
VARIABLES stage, crashed, candidate, checkpoint, effects, known,
          approved, witness, consumed, dispatches
vars == <<stage, crashed, candidate, checkpoint, effects, known,
          approved, witness, consumed, dispatches>>
TypeOK == /\ stage \in {"ready", "admitted", "running", "unacknowledged", "retained", "waiting", "uncertain", "blocked", "approved", "done"}
          /\ crashed \in BOOLEAN /\ known \in BOOLEAN /\ candidate \in 1..2
          /\ checkpoint \in 0..2 /\ approved \in 0..2
          /\ effects \in [1..2 -> 0..2] /\ dispatches \in [1..2 -> 0..2]
          /\ consumed \subseteq 1..2
          /\ witness \in [revision: 0..2, authorized: BOOLEAN, sameScope: BOOLEAN]
NoEffectReplay == \A v \in 1..2: effects[v] <= 1
CheckpointHasCandidate == checkpoint # 0 => effects[checkpoint] = 1
ExactAuthorizedApproval == approved # 0 =>
    /\ approved = candidate /\ approved = checkpoint
    /\ witness.revision = approved
    /\ witness.authorized /\ witness.sameScope
ResponseConsumedOnce == \A v \in 1..2: dispatches[v] <= 1
ObservableOutcome == <>(stage \in {"waiting", "done", "blocked"})
=============================================================================
