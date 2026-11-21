import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runModelSmoke, profile} from './inference-model-smoke.mjs';

const env = {INFERENCE_BASE_URL: 'https://private.invalid/gateway/v1', INFERENCE_API_KEY: 'inference-secret',
  CF_ACCESS_CLIENT_ID: 'access-id', CF_ACCESS_CLIENT_SECRET: 'access-secret'};
const json = data => new Response(JSON.stringify(data), {headers: {'content-type': 'application/json'}});
function harness(options = {}) {
  const calls = [];
  async function fetcher(url, init) {
    calls.push({url: String(url), ...init});
    if (calls.length === 1) return json({data: [{id: options.model ?? profile.model}]});
    if (calls.length === 2) return json({choices: [{message: {role: 'assistant', content: null, tool_calls: [
      {id: 'call_smoke', type: 'function', function: {name: 'nugs_smoke_echo', arguments: options.arguments ?? '{"value":"NUGS_TOOL_OK"}'}}]}}],
      usage: {prompt_tokens: 10, completion_tokens: 20, total_tokens: 30, secret_extra: 'must not log'}});
    const events = [
      {choices: [{index: 0, delta: {content: options.answer ?? 'NUGS_INFERENCE_OK'}, finish_reason: null}]},
      {choices: [{index: 0, delta: {}, finish_reason: options.finish ?? 'stop'}]},
      {choices: [], usage: {prompt_tokens: 30, completion_tokens: 20, total_tokens: 50}},
    ].map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + (options.noDone ? '' : 'data: [DONE]\n\n');
    // Split frames across reads to exercise real incremental SSE parsing.
    const bytes = new TextEncoder().encode(events);
    return new Response(new ReadableStream({start(controller) {
      for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
      controller.close();
    }}), {headers: {'content-type': 'text/event-stream'}});
  }
  return {calls, fetcher};
}

test('uses the exact model/medium profile and authenticated tool-result stream without fallback', async () => {
  const h = harness();
  const result = await runModelSmoke(env, h.fetcher);
  assert.equal(result.streaming, 'passed');
  assert.equal(result.tool_result_round_trip, 'passed');
  assert.equal(result.opencode_executed, false);
  assert.deepEqual(result.usage_initial, {prompt_tokens: 10, completion_tokens: 20, total_tokens: 30});
  assert.equal(h.calls[1].url, 'https://private.invalid/gateway/v1/chat/completions');
  for (const call of h.calls) {
    assert.equal(call.redirect, 'manual');
    assert.equal(call.headers.Authorization, 'Bearer inference-secret');
    assert.equal(call.headers['CF-Access-Client-Secret'], 'access-secret');
    if (call.body) {
      const body = JSON.parse(call.body);
      assert.equal(body.model, 'gpt-6.1-sol');
      assert.equal(body.reasoning_effort, 'medium');
      assert.equal(body.max_completion_tokens, 1536);
    }
  }
  assert.equal(JSON.parse(h.calls[2].body).messages[2].tool_call_id, 'call_smoke');
  assert.doesNotMatch(JSON.stringify(result), /private.invalid|inference-secret|access-secret|secret_extra/);
});

test('does not send inference if selected model is missing', async () => {
  const h = harness({model: 'unrelated-model'});
  await assert.rejects(runModelSmoke(env, h.fetcher), /no fallback/);
  assert.equal(h.calls.length, 1);
});

test('refuses invalid tool arguments rather than executing model-selected actions', async () => {
  const h = harness({arguments: '{"value":"NUGS_TOOL_OK","command":"unexpected"}'});
  await assert.rejects(runModelSmoke(env, h.fetcher), /unexpected tool arguments/);
  assert.equal(h.calls.length, 2);
});

test('rejects incomplete, budget-exhausted or incorrect streamed results', async () => {
  for (const options of [{noDone: true}, {finish: 'length'}, {answer: 'wrong marker'}]) {
    const h = harness(options);
    await assert.rejects(runModelSmoke(env, h.fetcher));
  }
});

test('refuses redirects and redacts network errors before leaking transport details', async () => {
  await assert.rejects(runModelSmoke(env, async () => new Response('', {status: 302})), /HTTP 302/);
  await assert.rejects(runModelSmoke(env, async () => { throw new Error('private.invalid inference-secret access-secret'); }),
    error => !/private.invalid|inference-secret|access-secret/.test(error.message));
  await assert.rejects(runModelSmoke({...env, INFERENCE_BASE_URL: 'http://unsafe.invalid'}, async () => assert.fail('must not fetch')), /HTTPS/);
});
