import {test} from 'node:test';
import assert from 'node:assert/strict';
import {modelsURL, runSmoke} from './inference-smoke.mjs';

const env = {
  INFERENCE_BASE_URL: 'https://private.example/gateway/v1/',
  INFERENCE_API_KEY: 'synthetic-inference-secret',
  CF_ACCESS_CLIENT_ID: 'synthetic-id',
  CF_ACCESS_CLIENT_SECRET: 'synthetic-access-secret',
};
const ok = () => Response.json({data: [{id: 'private-model-alias'}]});

test('uses exact API prefix, separate auth headers and never follows redirects', async () => {
  const calls = [];
  const result = await runSmoke(env, async (url, options) => {
    calls.push({url: url.href, ...options});
    return calls.length === 1 ? ok() : new Response('', {status: calls.length === 2 ? 302 : 401});
  });
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call.url, 'https://private.example/gateway/v1/models');
    assert.equal(call.method, 'GET');
    assert.equal(call.redirect, 'manual');
    assert.ok(call.signal instanceof AbortSignal);
  }
  assert.equal(calls[0].headers.Authorization, `Bearer ${env.INFERENCE_API_KEY}`);
  assert.equal(calls[0].headers['CF-Access-Client-Secret'], env.CF_ACCESS_CLIENT_SECRET);
  assert.equal(calls[1].headers['CF-Access-Client-Secret'], undefined);
  assert.equal(calls[2].headers.Authorization, undefined);
  assert.equal(result.inference_requested, false);
  assert.equal(result.authorized_model_count, 1);
  assert.doesNotMatch(JSON.stringify(result), /private|synthetic/);
});

test('rejects unsafe base URLs before transmitting any secrets', async () => {
  for (const base of ['http://host/v1', 'https://user:pass@host', 'https://host/?token=x', 'https://host/#x', 'not a url']) {
    assert.throws(() => modelsURL(base), /HTTPS/);
    await assert.rejects(runSmoke({...env, INFERENCE_BASE_URL: base}, () => assert.fail('must not fetch')), /HTTPS/);
  }
});

test('requires secrets but no model selection', async () => {
  for (const key of Object.keys(env)) {
    await assert.rejects(runSmoke({...env, [key]: ''}, () => assert.fail('must not fetch')), /Missing required Actions secret/);
  }
});

test('fails on authenticated redirects without exposing response or location', async () => {
  await assert.rejects(runSmoke(env, async () => new Response('secret body', {
    status: 302, headers: {Location: 'https://secret-location.example'},
  })), error => /HTTP 302/.test(error.message) && !/secret/.test(error.message));
});

test('rejects missing Access or inference authentication enforcement', async () => {
  let n = 0;
  await assert.rejects(runSmoke(env, async () => ++n === 1 ? ok() : new Response('', {status: 200})), /Access bypass/);
  n = 0;
  await assert.rejects(runSmoke(env, async () => ++n === 1 ? ok() : new Response('', {status: n === 2 ? 403 : 200})), /inference-key enforcement/);
});

test('rejects HTML, empty/malformed catalogs and oversized response bodies', async () => {
  for (const response of [
    new Response('<html>login</html>', {headers: {'content-type': 'text/html'}}),
    Response.json({data: []}), Response.json({data: [{id: 5}]}),
    new Response('{bad', {headers: {'content-type': 'application/json'}}),
    Response.json({data: [{id: 'x'.repeat(256 * 1024)}]}),
  ]) {
    await assert.rejects(runSmoke(env, async () => response), /JSON|data array|size limit/);
  }
});

test('redacts transport errors including credential and hostname details', async () => {
  await assert.rejects(runSmoke(env, async () => { throw new Error(JSON.stringify(env)); }), error =>
    /failed or timed out/.test(error.message) && !/private|synthetic/.test(error.message));
});
