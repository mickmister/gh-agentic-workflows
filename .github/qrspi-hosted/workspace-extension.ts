import { request } from "node:http";
import { Type } from "typebox";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function(pi: ExtensionAPI) {
  // Worker capability does not register a delegation tool. Host checks it again.
  const names = ["worker", "intake"].includes(process.env.WORKSPACE_AGENT_ROLE ?? "") ? ["workspace_operation"] : ["workspace_operation", "workspace_workers"];
  for (const name of names) pi.registerTool(defineTool({ name, label: name,
    description: name === "workspace_operation"
      ? "Execute a workspace capability. First call {area:'help'} for actual operations and authority. You decide workflow semantics from instructions/artifacts; tool successes never imply methodology approval."
      : "Dispatch an explicit group of independent workers concurrently, then await every outcome. Pass {workers:[{id,role,prompt,promptFiles?:['agents/canonical-agent.md'],artifactAccess?:{read:['input.md'],write:['output.md']},task?,documents?:[{resource,version_kind:'git-blob',version,snapshot}],access:'read'|'write'|'test'}]}. Spec Kit workers require canonical promptFiles. Read access to product source is separate from explicitly assigned process-artifact outputs. Assign task for source reads and exact pins for document reads. No parent conversation is inherited. Select work under the methodology; never retry uncertain work.",
    parameters: Type.Object({ area: Type.Optional(Type.String()), operation: Type.Optional(Type.String()), args: Type.Optional(Type.Any()), workers: Type.Optional(Type.Array(Type.Any(), { maxItems: 2 })) }),
    async execute(callId, args, signal) {
      const value = await new Promise<string>((ok, fail) => {
        const req = request({ socketPath: process.env.QRSPI_TOOL_SOCKET, path: "/tool", method: "POST", signal,
          headers: { authorization: `Bearer ${process.env.QRSPI_TOOL_TOKEN}`, "content-type": "application/json" } }, res => {
          const parts: Buffer[] = []; let size = 0;
          res.on("data", part => { size += part.length; if (size > 260000) req.destroy(new Error("Workspace result exceeds bound")); else parts.push(part); });
          res.on("end", () => ok(Buffer.concat(parts).toString("utf8"))); res.on("error", fail);
        });
        req.on("error", fail); req.end(JSON.stringify({ name, args, callId }));
      });
      const parsed = JSON.parse(value);
      return { content: [{ type: "text" as const, text: value }], details: { failed: Boolean(parsed.error) }, isError: Boolean(parsed.error) };
    },
  }));
}
