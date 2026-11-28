import { assert } from "./core.ts";

export type ReviewDraft = { title: string; purpose: string; question: string; body: string };
export function reviewDraft(value: any): ReviewDraft {
  assert(value && Object.keys(value).sort().join(",") === "body,purpose,question,title", "Review author must return title, purpose, question and body");
  for (const [key, limit] of [["title", 1000], ["purpose", 16000], ["question", 16000], ["body", 48000]] as const)
    assert(typeof value[key] === "string" && value[key].trim() && Buffer.byteLength(value[key]) <= limit, "Invalid review author field: " + key);
  return value;
}
