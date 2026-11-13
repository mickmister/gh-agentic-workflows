// Use the actual pinned extension protocol, not a second form/answer schema.
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { readFileSync } from 'node:fs';

try {
  const root = process.env.GITHUB_ULTIMATE_PROTOCOL_ROOT;
  if (!root) throw new Error('Pinned form protocol checkout missing');
  const { parseRecord, validateAnswers, omittedQuestions, revisionOf } = await import(
    pathToFileURL(path.join(root, 'src/protocol.ts')).href);
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const response = parseRecord(input.response_raw);
  const form = parseRecord(input.form_raw);
  if (response.kind !== 'response' || form.format !== 'standard' || form.invalidatedAt) throw new Error('Invalid response/form');
  if (response.form_id !== form.id || response.task_id !== (form.task_id ?? form.id) ||
      response.session_id !== (form.session_id ?? null) || response.parent_task_id !== (form.parent_task_id ?? null) ||
      response.resume_session !== Boolean(form.session_id)) throw new Error('Form identity changed');
  if (response.source.revision !== await revisionOf(input.form_raw)) throw new Error('Form revision changed');
  if (form.allowCodeFileChanges === false && response.allow_code_file_changes) throw new Error('Discussion-only form');
  const errors = validateAnswers(form, response.answers, { allowUnanswered: true });
  if (errors.length) throw new Error('Invalid answers');
  const omitted = omittedQuestions(form, response.answers).sort();
  if (JSON.stringify([...(response.omitted_questions ?? [])].sort()) !== JSON.stringify(omitted)) throw new Error('Omitted answers mismatch');
  process.stdout.write(JSON.stringify({ form, response }));
} catch {
  console.error('Form response validation failed: check schema, answers, source revision and intent.');
  process.exitCode = 1;
}
