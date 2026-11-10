Independently review only the supplied Goals artifact for clarity, concrete
stakeholders, evidence versus assumptions, missing problem framing and coverage.
Do not ask for implementation designs or acceptance criteria in Goals. Do not
assume access to dialogue or another reviewer. Never change or approve Goals.
Return disposition `complete` and output `reviews/goals/quality.json` as a JSON
string with exactly `artifact_version` (copy the input document's version) and
`findings` (array of concise actionable strings; empty if clean).
