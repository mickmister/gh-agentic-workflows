---------------------------- MODULE Resumption -----------------------------
EXTENDS Properties
CONSTANTS BlindRetry, SkipAuth, SkipScope, AllowStale, KeepApproval, ReplayResponse
Init == /\ stage = "ready" /\ crashed = FALSE /\ candidate = 1
        /\ checkpoint = 0 /\ effects = [v \in 1..2 |-> 0] /\ known = FALSE
        /\ approved = 0 /\ witness = [revision |-> 0, authorized |-> FALSE, sameScope |-> FALSE]
        /\ consumed = {} /\ dispatches = [v \in 1..2 |-> 0]
Start == /\ stage = "ready" /\ stage' = "admitted"
         /\ UNCHANGED <<crashed, candidate, checkpoint, effects, known, approved, witness, consumed, dispatches>>
Run == /\ stage = "admitted" /\ stage' = "running"
       /\ UNCHANGED <<crashed, candidate, checkpoint, effects, known, approved, witness, consumed, dispatches>>
Effect == /\ stage = "running" /\ effects[candidate] < 2
          /\ effects' = [effects EXCEPT ![candidate] = @ + 1] /\ stage' = "unacknowledged"
          /\ UNCHANGED <<crashed, candidate, checkpoint, known, approved, witness, consumed, dispatches>>
Ack == /\ stage = "unacknowledged" /\ stage' = "retained" /\ known' = TRUE
       /\ UNCHANGED <<crashed, candidate, checkpoint, effects, approved, witness, consumed, dispatches>>
Publish == /\ stage = "retained" /\ known /\ checkpoint' = candidate /\ stage' = "waiting"
           /\ UNCHANGED <<crashed, candidate, effects, known, approved, witness, consumed, dispatches>>
Crash == /\ ~crashed /\ stage \in {"admitted", "running", "unacknowledged", "retained", "waiting"}
         /\ crashed' = TRUE /\ stage' = "uncertain"
         /\ UNCHANGED <<candidate, checkpoint, effects, known, approved, witness, consumed, dispatches>>
Reconcile == /\ stage = "uncertain"
             /\ stage' = IF BlindRetry THEN "admitted" ELSE IF known THEN "retained" ELSE "blocked"
             /\ UNCHANGED <<crashed, candidate, checkpoint, effects, known, approved, witness, consumed, dispatches>>
Receive(v, auth, scope) ==
    /\ stage = "waiting" /\ candidate \notin consumed
    /\ (auth \/ SkipAuth) /\ (scope \/ SkipScope) /\ (v = checkpoint \/ AllowStale)
    /\ approved' = candidate /\ witness' = [revision |-> v, authorized |-> auth, sameScope |-> scope]
    /\ stage' = "approved"
    /\ UNCHANGED <<crashed, candidate, checkpoint, effects, known, consumed, dispatches>>
Revise == /\ stage \in {"waiting", "approved"} /\ candidate = 1
          /\ candidate' = 2 /\ checkpoint' = 0 /\ approved' = IF KeepApproval THEN approved ELSE 0
          /\ known' = FALSE /\ stage' = "admitted"
          /\ UNCHANGED <<crashed, effects, witness, consumed, dispatches>>
Dispatch == /\ stage = "approved" /\ candidate \notin consumed
            /\ consumed' = consumed \cup {candidate}
            /\ dispatches' = [dispatches EXCEPT ![candidate] = @ + 1] /\ stage' = "done"
            /\ UNCHANGED <<crashed, candidate, checkpoint, effects, known, approved, witness>>
Duplicate == /\ ReplayResponse /\ stage = "done" /\ dispatches[candidate] < 2
             /\ consumed' = consumed \ {candidate} /\ stage' = "approved"
             /\ UNCHANGED <<crashed, candidate, checkpoint, effects, known, approved, witness, dispatches>>
Internal == Start \/ Run \/ Effect \/ Ack \/ Publish \/ Reconcile \/ Dispatch
Next == Internal \/ Crash \/ Revise \/ Duplicate
        \/ (\E v \in 1..2, auth \in BOOLEAN, scope \in BOOLEAN: Receive(v, auth, scope))
Spec == Init /\ [][Next]_vars /\ WF_vars(Internal)
=============================================================================
