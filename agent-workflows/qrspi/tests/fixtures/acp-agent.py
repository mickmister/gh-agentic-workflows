"""Deterministic ACP server; native history is independent of acpx records."""
import json
import os
from pathlib import Path
import sys
import time
import uuid

root = Path(os.environ["QRSPI_FIXTURE_NATIVE_STORE"])
root.mkdir(parents=True, exist_ok=True)


def send(value):
    print(json.dumps(value), flush=True)


for line in sys.stdin:
    request = json.loads(line)
    if "id" not in request:
        continue
    method = request["method"]
    params = request.get("params", {})
    error = None
    result = {}
    if method == "initialize":
        result = {"protocolVersion": 1, "agentCapabilities": {"loadSession": True},
                  "authMethods": [], "agentInfo": {"name": "qrspi-fixture", "version": "1"}}
    elif method == "session/new":
        sid = "fixture-" + str(uuid.uuid4())
        (root / (sid + ".json")).write_text("[]")
        result = {"sessionId": sid}
    elif method == "session/load":
        if not (root / (params["sessionId"] + ".json")).exists():
            error = {"code": -32001, "message": "Native session missing"}
    elif method == "session/prompt":
        sid = params["sessionId"]
        native = root / (sid + ".json")
        history = json.loads(native.read_text())
        prompt = "".join(part.get("text", "") for part in params["prompt"])
        if prompt == "HANG":
            time.sleep(20)
        history.append(prompt)
        native.write_text(json.dumps(history))
        if prompt == "FAIL":
            send({"jsonrpc": "2.0", "method": "session/update", "params": {
                "sessionId": sid, "update": {"sessionUpdate": "agent_message_chunk",
                "content": {"type": "text", "text": "No findings. (partial, not success)"}}}})
            error = {"code": -32001, "message": "fixture prompt failure"}
        else:
            if prompt != "EMPTY":
                send({"jsonrpc": "2.0", "method": "session/update", "params": {
                    "sessionId": sid, "update": {"sessionUpdate": "agent_message_chunk",
                    "content": {"type": "text", "text": json.dumps(history)}}}})
            result = {"stopReason": "cancelled" if prompt == "CANCEL" else "end_turn"}
    else:
        error = {"code": -32601, "message": "Unsupported method: " + method}
    send({"jsonrpc": "2.0", "id": request["id"],
          **({"error": error} if error else {"result": result})})
