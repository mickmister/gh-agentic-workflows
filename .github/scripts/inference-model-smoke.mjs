import {pathToFileURL} from 'node:url';
import {modelsURL, SmokeError} from './inference-smoke.mjs';

export const profile = Object.freeze({model: 'gpt-6.1-sol', reasoning_effort: 'medium', max_completion_tokens: 1536});
const limit = 256 * 1024;
const marker = 'NUGS_INFERENCE_OK';
const toolName = 'nugs_smoke_echo';

function require(value, message) { if (!value) throw new SmokeError(message); }

async function jsonBody(response) {
  require(response.headers.get('content-type')?.includes('application/json'), 'Inference endpoint did not return JSON.');
  const reader = response.body?.getReader();
  require(reader, 'Inference endpoint returned an empty body.');
  const chunks = []; let size = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      require(size <= limit, 'Inference response exceeded the size limit.');
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new SmokeError('Inference response was not valid JSON.'); }
}

function safeUsage(usage) {
  if (!usage || typeof usage !== 'object') return undefined;
  const result = {};
  for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
    if (Number.isSafeInteger(usage[key]) && usage[key] >= 0) result[key] = usage[key];
  }
  const reasoning = usage.completion_tokens_details?.reasoning_tokens;
  if (Number.isSafeInteger(reasoning) && reasoning >= 0) result.reasoning_tokens = reasoning;
  return Object.keys(result).length ? result : undefined;
}

async function streamedAnswer(response) {
  require(response.headers.get('content-type')?.includes('text/event-stream'), 'Streamed inference did not return SSE.');
  const reader = response.body?.getReader();
  require(reader, 'Inference stream was empty.');
  const decoder = new TextDecoder();
  let buffer = '', answer = '', size = 0, events = 0, finished = false, doneMarker = false, usage;
  function event(frame) {
    const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data) return;
    if (data === '[DONE]') { doneMarker = true; return; }
    require(!doneMarker, 'Inference stream continued after its completion marker.');
    let value;
    try { value = JSON.parse(data); } catch { throw new SmokeError('Inference stream contained invalid JSON.'); }
    require(!value.error && Array.isArray(value.choices), 'Inference stream returned an invalid event.');
    events++;
    usage = safeUsage(value.usage) ?? usage;
    for (const choice of value.choices) {
      require(choice.index === 0 && !choice.delta?.tool_calls, 'Unexpected response choice/tool call in the final stream.');
      if (typeof choice.delta?.content === 'string') answer += choice.delta.content;
      if (choice.finish_reason != null) {
        require(choice.finish_reason === 'stop', 'Inference stream did not complete normally within its output budget.');
        finished = true;
      }
    }
  }
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      require(size <= limit, 'Inference stream exceeded the size limit.');
      buffer = (buffer + decoder.decode(chunk.value, {stream: true})).replaceAll('\r\n', '\n');
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        event(buffer.slice(0, end)); buffer = buffer.slice(end + 2);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) event(buffer);
  } finally { await reader.cancel().catch(() => {}); }
  require(events > 0 && finished && doneMarker && answer.trim() === marker,
    'Streamed tool-result response did not match the expected completion marker.');
  return {events, usage};
}

export async function runModelSmoke(env = process.env, fetcher = fetch) {
  for (const name of ['INFERENCE_BASE_URL', 'INFERENCE_API_KEY', 'CF_ACCESS_CLIENT_ID', 'CF_ACCESS_CLIENT_SECRET']) {
    require(env[name]?.trim(), `Missing required Actions secret: ${name}.`);
  }
  const models = modelsURL(env.INFERENCE_BASE_URL);
  const completions = new URL(models);
  completions.pathname = completions.pathname.replace(/\/models$/, '/chat/completions');
  const headers = {Accept: 'application/json', Authorization: `Bearer ${env.INFERENCE_API_KEY}`,
    'CF-Access-Client-Id': env.CF_ACCESS_CLIENT_ID, 'CF-Access-Client-Secret': env.CF_ACCESS_CLIENT_SECRET};
  async function request(url, body) {
    let response;
    try {
      response = await fetcher(url, {method: body ? 'POST' : 'GET',
        headers: body ? {...headers, 'Content-Type': 'application/json'} : headers,
        body: body ? JSON.stringify(body) : undefined, redirect: 'manual',
        signal: AbortSignal.timeout(body ? 90_000 : 30_000)});
    } catch { throw new SmokeError('Selected-model request failed or timed out; diagnostics redacted.'); }
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new SmokeError(`Selected-model endpoint returned HTTP ${response.status}; redirects are not followed and no model fallback is attempted.`);
    }
    return response;
  }
  const catalog = await jsonBody(await request(models));
  require(Array.isArray(catalog.data) && catalog.data.some(item => item?.id === profile.model),
    'Selected gateway model gpt-6.1-sol is not available in the authenticated catalog; no fallback attempted.');
  const tools = [{type: 'function', function: {name: toolName, description: 'Return the fixed smoke-test value.',
    strict: true, parameters: {type: 'object', properties: {value: {type: 'string', enum: ['NUGS_TOOL_OK']}},
      required: ['value'], additionalProperties: false}}}];
  const messages = [{role: 'user', content: 'Call nugs_smoke_echo once with value NUGS_TOOL_OK. Do not do any other work.'}];
  const initial = await jsonBody(await request(completions, {...profile, messages, tools,
    tool_choice: {type: 'function', function: {name: toolName}}, stream: false}));
  const message = initial.choices?.[0]?.message;
  require(initial.choices?.length === 1 && message?.tool_calls?.length === 1, 'Selected model did not produce the required single tool call.');
  const call = message.tool_calls[0];
  require(call.type === 'function' && call.function?.name === toolName && typeof call.id === 'string' && call.id.length > 0,
    'Selected model returned an unexpected tool call.');
  let args;
  try { args = JSON.parse(call.function.arguments); } catch { throw new SmokeError('Selected model returned invalid tool arguments.'); }
  require(args && args.value === 'NUGS_TOOL_OK' && Object.keys(args).length === 1, 'Selected model returned unexpected tool arguments.');
  // The only tool is this fixed in-memory echo. No model-selected command,
  // filesystem action, URL or repository content is executed.
  const stream = await request(completions, {...profile, tools, tool_choice: 'none', stream: true,
    stream_options: {include_usage: true}, messages: [...messages,
      {role: 'assistant', content: message.content ?? null, tool_calls: [call]},
      {role: 'tool', tool_call_id: call.id, content: JSON.stringify({value: args.value})},
      {role: 'user', content: `Reply with exactly ${marker} and no other text.`}]});
  const final = await streamedAnswer(stream);
  return {selected_model: profile.model, reasoning_effort: profile.reasoning_effort,
    max_completion_tokens_per_request: profile.max_completion_tokens,
    authenticated_catalog_match: true, completion_tool_call: 'passed', tool_result_round_trip: 'passed',
    streaming: 'passed', stream_events: final.events, usage_initial: safeUsage(initial.usage), usage_final: final.usage,
    opencode_executed: false, gas_city_executed: false};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await runModelSmoke())); }
  catch (error) {
    console.error(error instanceof SmokeError ? error.message : 'Selected-model smoke failed; diagnostics redacted.');
    process.exitCode = 1;
  }
}
