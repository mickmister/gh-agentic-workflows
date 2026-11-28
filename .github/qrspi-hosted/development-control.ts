import { request } from "node:http";
import { randomUUID } from "node:crypto";

export async function developmentControl(operation: string, role?: string) {
  return new Promise<any>((resolve, reject) => {
    const req = request({ socketPath: process.env.DEVELOPMENT_SOCKET, path: "/tool", method: "POST",
      headers: { authorization: `Bearer ${process.env.DEVELOPMENT_TOKEN}`, "content-type": "application/json" }, timeout: 3_600_000 }, res => {
      let text = "";
      res.on("data", chunk => { text += chunk; if (Buffer.byteLength(text) > 512000) req.destroy(new Error("Control response exceeds bound")); });
      res.on("end", () => {
        try { const value = JSON.parse(text); if (res.statusCode !== 200) throw new Error("Development capability failed; inspect private evidence"); resolve(value.value); }
        catch (error) { reject(error); }
      });
    });
    req.once("error", reject); req.once("timeout", () => req.destroy(new Error("Development control timeout")));
    req.end(JSON.stringify({ name: "development_control", args: { operation, role }, callId: randomUUID() }));
  });
}
