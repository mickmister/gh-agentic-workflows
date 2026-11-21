# PR comment → agent decision → workflow → PR comment → repeat

The PR conversation is the human-facing entry point. Each accepted human request
starts a bounded GitHub Actions run. A Gas City-managed orchestrator chooses how
to advance the work; durable state connects that run to the next human reply.

## End-to-end sequence

```mermaid
sequenceDiagram
    autonumber
    actor Human
    participant PR as Source repository PR conversation
    participant Caller as Source Actions caller / shared entrypoint
    participant Runner as Central Actions runner / trusted controller
    participant Store as nugs durable workspace and conversation state
    participant GC as Gas City CLI and supervisor
    participant Agent as Gas City-managed orchestrator agent
    participant Worker as Gas City formula worker

    opt Start with a form
        Runner->>PR: Agent/publisher posts a marked github-task form
        PR-->>Human: Extension renders questions
        Human->>PR: Fill form and post generated slash-command response
        Note over Human,PR: Posting the response creates the event.<br/>Previewing or inserting it into the editor does not.
    end

    loop Each human request or follow-up
        Human->>PR: Post /agentic request or generated /github-ultimate response
        PR->>Caller: issue_comment.created
        Caller->>Caller: Recognize slash command and check requester permission
        Caller->>Runner: Dispatch comment identity and body hash using scoped App token
        Runner->>Store: Restore configured workspace and synchronize current history
        Store-->>Runner: Existing execution graph, events and native worker conversation
        Runner->>PR: Fetch authoritative comment, PR head and referenced form
        Runner->>Runner: Validate author, thread, body hash and form revision/answers

        alt Request is invalid
            Runner-->>PR: Report rejection when an authenticated thread binding exists
            Note over Runner,GC: No agent or formula is launched.
        else Request is valid
            Runner->>PR: Create or update App-owned status comment: running
            Runner->>Runner: Check whether this event/response was already handled

            alt Duplicate of a successful request
                Runner->>Runner: Record no-op and preserve execution checkpoint
                Note over Runner,Worker: No new orchestrator or worker inference.
            else New request
                Runner->>GC: Start runner-owned supervisor and orchestrator session
                GC->>Agent: Launch configured coding provider with event, state and formula catalog
                Agent-->>Runner: Propose start / resume / update / await_human / noop
                Runner->>Runner: Validate decision, execution revision and installed formula

                alt Start, resume or update
                    Runner->>GC: Apply validated native formula operation
                    GC->>Worker: Dispatch selected formula step
                    opt Continuing an existing conversation
                        Store-->>Worker: Restore supported native conversation export
                    end
                    Worker-->>Runner: Return result and execution evidence
                    Runner->>PR: Re-check request/form bindings and PR head
                    Runner->>GC: Close validated step and finalize workflow when ready
                else Await human or no-op
                    Runner->>Runner: Record question, explanation or no-work decision
                end

                Runner->>GC: Stop runner-owned sessions and supervisor
                Runner->>Store: Save native graph, conversation, events and run report
            end

            Runner->>Store: Final synchronization and independent recovery verification
            Runner->>PR: Create or update result/status comment with run link and snapshot

            opt A follow-up form is needed
                Runner->>PR: Agent/publisher posts a new marked form
                PR-->>Human: Show questions awaiting an answer
            end

            Note over PR,Caller: Marked form/status output does not launch another agent.<br/>The next execution waits for a human slash-command comment.
            PR-->>Human: Read result, answer questions or make another request
        end
    end
```

The initial form submission is the first iteration's request; it is not a second
comment that must be posted again at the top of the loop. A plain `/agentic ...`
comment can start the same flow without a form.

## What the agent decides

| Decision | Effect |
| --- | --- |
| `start` | Instantiate an installed formula for a new request. A new graph can follow a completed workflow while retaining conversation history. |
| `resume` | Continue an incomplete execution and restore its native worker conversation. |
| `update` | Incorporate the latest instructions or form answers into pending work. |
| `await_human` | Persist the need for clarification and end the current run. |
| `noop` | Record that the request needs no additional work. Successful duplicates are detected before launching the agent. |

The installed catalog currently contains `investigate` and `plan-change`.
Their workers perform read-only investigation and planning. A form's approval
intent does not add source-editing capabilities to those workers.

## Comments and repetition

- **Human request:** `/agentic <request>`, or the extension-generated
  `/github-ultimate discuss` / `/github-ultimate approve` plus its structured
  response. Ordinary conversation comments do not launch agents.
- **Status/result:** the current implementation creates one App-owned status
  comment per PR and updates it on subsequent runs. It contains readable results,
  links and a `github-workflow` snapshot. Per-run reports remain in nugs.
- **Form:** a publisher can create a new `github-task` form comment. The current
  form CLI supports this, including forms published manually by an agent. The
  workflow does **not yet automatically generate a fresh form for every human
  gate**; that branch in the diagram is the intended publisher integration.
- **Loop prevention:** form and status output contains
  `<!-- github-ultimate:form:` and is skipped by the entrypoint. An agent's output
  is not itself a new execution request.

In short, the repeating interaction is:

> Human posts request → orchestrator chooses an operation/formula → Gas City runs
> work → results and state are saved → PR receives an update or new form → human
> posts a follow-up → a fresh runner continues the durable conversation.

## Ownership of the steps

The diagram describes the current implementation: Python adapters perform the
trusted GitHub integration, decision application, persistence and reporting;
Gas City launches the orchestrator and workers and owns the native formula graph.
The orchestrator makes the high-level workflow decision. Making it use Gas City
more directly would thin the controller layer without changing this human-facing
sequence.

Execution and publication failures are tracked separately. Ordinary worker failure
still runs final persistence; invalid requests never reach inference. A runner
lost abruptly may leave the last saved checkpoint/status. Actions concurrency
serializes each repository/PR, but its pending slot is not a durable request queue.

For configuration, validation and source links, see
[PR comment workflow](pr-comment-workflow.md) and
[Gas City execution core](gascity-event-orchestrator.md).
