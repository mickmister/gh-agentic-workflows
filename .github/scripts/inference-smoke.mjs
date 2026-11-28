import {pathToFileURL} from 'node:url';

const requiredSecrets = [
  'INFERENCE_BASE_URL', 'INFERENCE_API_KEY',
  'CF_ACCESS_CLIENT_ID', 'CF_ACCESS_CLIENT_SECRET',
];
const maxBodyBytes = 256 * 1024;

export class SmokeError extends Error {}

export function modelsURL(base) {
  let url;
  try { url = new URL(base); } catch { throw new SmokeError('INFERENCE_BASE_URL must be a valid HTTPS API base URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new SmokeError('INFERENCE_BASE_URL requires HTTPS, without userinfo, query or fragment.');
  }
  // Preserve the configured API prefix, for example /v1 or /gateway/v1.
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/models`;
  return url;
}

async function catalog(response) {
  if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
    throw new SmokeError('Authenticated model discovery did not return JSON. Check the API base path and Access Service Auth policy.');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new SmokeError('Model discovery returned an empty response.');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBodyBytes) throw new SmokeError('Model discovery exceeded the response-size limit.');
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new SmokeError('Model discovery returned invalid JSON.'); }
  if (!Array.isArray(body.data) || !body.data.length ||
      !body.data.every(model => typeof model?.id === 'string' && model.id.length > 0)) {
    throw new SmokeError('Model discovery must return a nonempty OpenAI-compatible data array with model IDs.');
  }
  return body.data.length;
}

export async function runSmoke(env = process.env, fetcher = fetch) {
  for (const name of requiredSecrets) {
    if (!env[name]?.trim()) throw new SmokeError(`Missing required Actions secret: ${name}.`);
  }
  const url = modelsURL(env.INFERENCE_BASE_URL);
  const access = {
    'CF-Access-Client-Id': env.CF_ACCESS_CLIENT_ID,
    'CF-Access-Client-Secret': env.CF_ACCESS_CLIENT_SECRET,
  };
  const auth = {Authorization: `Bearer ${env.INFERENCE_API_KEY}`};
  async function request(headers) {
    try {
      return await fetcher(url, {
        method: 'GET', headers: {Accept: 'application/json', ...headers},
        redirect: 'manual', signal: AbortSignal.timeout(30_000),
      });
    } catch {
      // Fetch errors can contain hostnames or header values; never print them.
      throw new SmokeError('Inference request failed or timed out. Check DNS, TLS, tunnel availability and header values.');
    }
  }
  const authenticated = await request({...access, ...auth});
  if (authenticated.status !== 200) {
    await authenticated.body?.cancel();
    throw new SmokeError(`Authenticated model discovery returned HTTP ${authenticated.status}. Check the base path, Access token/policy and inference key. Redirects are not followed.`);
  }
  let count;
  try { count = await catalog(authenticated); }
  catch (error) {
    if (error instanceof SmokeError) throw error;
    throw new SmokeError('Model discovery response could not be read within the request limit.');
  }

  const withoutAccess = await request(auth);
  await withoutAccess.body?.cancel();
  if (![401, 403, 302, 303, 307, 308].includes(withoutAccess.status)) {
    throw new SmokeError(`Request without Access credentials returned HTTP ${withoutAccess.status}; expected an authentication denial. Check for Access bypass policies.`);
  }
  const withoutInference = await request(access);
  await withoutInference.body?.cancel();
  if (![401, 403].includes(withoutInference.status)) {
    throw new SmokeError(`Request without inference credentials returned HTTP ${withoutInference.status}; expected 401 or 403. Check inference-key enforcement.`);
  }
  // Do not log endpoint, model aliases, headers, response bodies or credentials.
  return {
    authenticated_catalog: 'passed', authorized_model_count: count,
    missing_access_credentials: 'denied', missing_inference_credentials: 'denied',
    inference_requested: false,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await runSmoke())); }
  catch (error) {
    console.error(error instanceof SmokeError ? error.message : 'Inference smoke test failed; diagnostics redacted.');
    process.exitCode = 1;
  }
}
