// GitHub supplies GITHUB_ACTOR_ID; never derive trusted identity from dispatch inputs.
export function authenticateReceipt(reviewer: string, actorId = process.env.GITHUB_ACTOR_ID) {
  if (!actorId || !/^[1-9][0-9]*$/.test(actorId) || reviewer !== `github:${actorId}`)
    throw new Error("Response reviewer must match trusted GitHub dispatch actor; broker provenance unavailable");
}
if (process.argv[1]?.endsWith("identity.ts")) {
  const receipt = process.env.REVIEW_RESPONSE;
  if (receipt) authenticateReceipt(JSON.parse(receipt).reviewer);
}
