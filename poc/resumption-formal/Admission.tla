----------------------------- MODULE Admission -----------------------------
EXTENDS Naturals, FiniteSets
CONSTANT Serialized
VARIABLES pc, store, admitted
vars == <<pc, store, admitted>>
Callers == 1..2
Init == /\ pc = [i \in Callers |-> "ready"]
        /\ store = 0 /\ admitted = {}
Read(i) == /\ pc[i] = "ready"
           /\ (~Serialized \/ \A j \in Callers \ {i}: pc[j] \in {"ready", "done"})
           /\ pc' = [pc EXCEPT ![i] = IF store = 0 THEN "read-empty" ELSE "done"]
           /\ UNCHANGED <<store, admitted>>
Put(i) == /\ pc[i] = "read-empty"
          /\ store' = i /\ pc' = [pc EXCEPT ![i] = "put"]
          /\ UNCHANGED admitted
Readback(i) == /\ pc[i] = "put"
               /\ admitted' = IF store = i THEN admitted \cup {i} ELSE admitted
               /\ pc' = [pc EXCEPT ![i] = "done"] /\ UNCHANGED store
Next == \E i \in Callers: Read(i) \/ Put(i) \/ Readback(i)
Spec == Init /\ [][Next]_vars
SingleAdmission == Cardinality(admitted) <= 1
=============================================================================
