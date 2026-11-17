/** Intake needs a substantive answer, not an approval/discussion control masquerading as an answer. */
export function dialogueQuestions(question: string, proposed?: unknown) {
  if (proposed !== undefined) {
    if (!Array.isArray(proposed) || proposed.length < 1 || proposed.length > 6) throw Error('Supply one to six substantive intake questions.');
    if (proposed.some(item => !item || typeof item !== 'object' || item.id === 'decision')) throw Error('Intake questions cannot use the reserved phase decision field.');
    // Production parseRecord validates the complete standard-form DSL, including
    // choices, descriptions, recommendations and pros/cons. The first actual
    // question must be answered before submission; no generic gate fallback.
    return proposed.map((item, index) => ({...item,...(index === 0 ? {required:true} : {})}));
  }
  return [{id:'answer',type:'textarea',title:question,required:true,
    description:'Answer the question directly: confirm the recommendation, give your correction, or say what you are unsure about. This continues discussion only; it does not approve a QRSPI phase or code changes.'}];
}
