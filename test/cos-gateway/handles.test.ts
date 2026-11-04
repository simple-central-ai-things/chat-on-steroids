/**
 * The per-handle deployment registry (platform spec D1 / H-042), proven
 * offline with synthetic definitions only — no account material, no live CoS.
 *
 * Two accounts are the minimum that can expose the invariants: a shared
 * browser profile, a shared port or a handle that adopts another handle's
 * session can only be detected with two.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assessReadiness,
  buildDeploymentMap,
  deploymentIdentity,
  handleOfConversationKey,
  HandleRegistry,
  HandleRegistryError,
  parseModelIdentity,
  publicHandleView,
  resolveIdentity,
  scopedConversationKey,
  SERVED_BY_HEADER,
  servedByValue,
  type HandleDefinition,
  type HandleReadiness
} from '../../src/main/openai-gateway/handles.js';
import { GATEWAY_ERRORS, GatewayError } from '../../src/main/openai-gateway/errors.js';

/** Synthetic handles: example.invalid accounts, no real material anywhere. */
function fixture(): HandleDefinition[] {
  return [
    {
      handle: 'work',
      instance: { apiPort: 18801, vncPort: 18802 },
      browserProfile: '/srv/cos/fixtures/work/browser-profile',
      userData: '/srv/cos/fixtures/work/user-data',
      keyring: 'keyring://fixture-work',
      account: 'work@example.invalid',
      models: ['gpt-5.1', 'gpt-5.1-mini'],
      order: 0
    },
    {
      handle: 'home',
      instance: { apiPort: 18811, vncPort: 18812 },
      browserProfile: '/srv/cos/fixtures/home/browser-profile',
      userData: '/srv/cos/fixtures/home/user-data',
      keyring: 'keyring://fixture-home',
      account: 'home@example.invalid',
      models: ['gpt-5.1'],
      order: 1
    }
  ];
}

function problemsOf(raw: unknown): string[] {
  try {
    HandleRegistry.parse(raw);
  } catch (error) {
    assert.ok(error instanceof HandleRegistryError, `expected a registry error, got ${String(error)}`);
    return [...error.problems];
  }
  assert.fail('the registry accepted an invalid handle list');
}

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof GatewayError, `expected a gateway error, got ${String(error)}`);
    return error.code;
  }
  assert.fail('the call did not throw');
}

const ready: HandleReadiness = {
  handle: 'work',
  status: 'ready',
  ready: true,
  reason: 'live browser evidence',
  evidence: { signedIn: true, browserRunning: true, extensionFresh: true }
};

test('a valid two-handle deployment parses in operator order', () => {
  const registry = HandleRegistry.parse(fixture());
  assert.deepEqual(registry.list().map((handle) => handle.handle), ['work', 'home']);
  const home = registry.get('home');
  assert.ok(home);
  assert.equal(home.apiPort, 18811);
  assert.equal(home.vncPort, 18812);
  assert.equal(home.enabled, true);
  assert.equal(registry.get('ghost'), null);
  // The document shape { handles: [...] } is accepted too.
  assert.equal(HandleRegistry.parse({ handles: fixture() }).list().length, 2);
});

test('a shared browser profile is refused: one account per instance', () => {
  const handles = fixture();
  handles[1] = { ...handles[1]!, browserProfile: handles[0]!.browserProfile };
  const problems = problemsOf(handles);
  assert.ok(
    problems.some((problem) => problem.includes('browserProfile') &&
      problem.includes('work') && problem.includes('home')),
    problems.join('; ')
  );
});

test('a trailing slash or a case difference does not hide a shared profile', () => {
  const handles = fixture();
  handles[1] = { ...handles[1]!, browserProfile: '/srv/cos/fixtures/work/browser-profile/' };
  assert.ok(problemsOf(handles).some((problem) => problem.includes('browserProfile')));
  const upper = fixture();
  upper[1] = { ...upper[1]!, userData: '/srv/cos/fixtures/WORK/user-data' };
  assert.ok(problemsOf(upper).some((problem) => problem.includes('userData')));
});

test('shared userData, keyring or account label is refused', () => {
  for (const field of ['userData', 'keyring', 'account'] as const) {
    const handles = fixture();
    handles[1] = { ...handles[1]!, [field]: handles[0]![field] };
    assert.ok(
      problemsOf(handles).some((problem) => problem.includes(field)),
      `a shared ${field} was accepted`
    );
  }
});

test('ports belong to exactly one handle, API and VNC namespaces alike', () => {
  const sameApi = fixture();
  sameApi[1] = { ...sameApi[1]!, instance: { apiPort: 18801, vncPort: 18812 } };
  assert.ok(problemsOf(sameApi).some((problem) => problem.includes('port 18801')));

  const sameVnc = fixture();
  sameVnc[1] = { ...sameVnc[1]!, instance: { apiPort: 18811, vncPort: 18802 } };
  assert.ok(problemsOf(sameVnc).some((problem) => problem.includes('port 18802')));

  // Cross-namespace: home's API port may not be work's VNC port.
  const crossed = fixture();
  crossed[1] = { ...crossed[1]!, instance: { apiPort: 18802, vncPort: 18812 } };
  assert.ok(problemsOf(crossed).some((problem) => problem.includes('port 18802')));

  // One handle's own API and VNC ports must differ.
  const own = fixture();
  own[0] = { ...own[0]!, instance: { apiPort: 18801, vncPort: 18801 } };
  assert.ok(problemsOf(own).some((problem) => problem.includes('different ports')));
});

test('invalid names, ports, paths and field types are all reported together', () => {
  const raw = [
    fixture()[0],
    {
      handle: 'HOME' as unknown as string,
      instance: { apiPort: 70000, vncPort: '8793' as unknown as number },
      browserProfile: '',
      userData: '/srv/cos/fixtures/home/user-data',
      keyring: 'keyring://fixture-home',
      models: 'gpt-5.1' as unknown as string[],
      enabled: 'yes' as unknown as boolean,
      order: 'first' as unknown as number
    },
    { handle: 'work' },
    'nope'
  ];
  const problems = problemsOf(raw);
  for (const expected of [
    'handles[1].handle',
    'handles[1].instance.apiPort',
    'handles[1].instance.vncPort',
    'handles[1].browserProfile',
    'handles[1].models',
    'handles[1].enabled',
    'handles[1].order',
    'handles[2].instance',
    'handles[3] must be an object',
    'defined twice'
  ]) {
    assert.ok(problems.some((problem) => problem.includes(expected)), `${expected} not reported: ${problems}`);
  }
});

test('a list that is not a handle list is refused, and an empty one too', () => {
  assert.ok(problemsOf(null)[0]!.includes('handles must be a list'));
  assert.ok(problemsOf({ nope: true })[0]!.includes('handles must be a list'));
  assert.ok(problemsOf([])[0]!.includes('at least one handle'));
});

test('the served handle is looked up, and unknown or disabled handles are refused', () => {
  const handles = fixture();
  handles[1] = { ...handles[1]!, enabled: false };
  const registry = HandleRegistry.parse(handles);
  assert.equal(registry.local('work').handle, 'work');
  assert.equal(codeOf(() => registry.local('ghost')), 'handle_unknown');
  assert.equal(codeOf(() => registry.local('home')), 'handle_disabled');
  // A disabled handle keeps its isolation claims: two definitions still cannot
  // share a profile even while one is off.
  const shared = fixture();
  shared[1] = { ...shared[1]!, enabled: false, browserProfile: shared[0]!.browserProfile };
  assert.ok(problemsOf(shared).some((problem) => problem.includes('browserProfile')));
});

test('model identity parsing keeps the marker and the model apart', () => {
  assert.deepEqual(parseModelIdentity('gpt-5.1'), { model: 'gpt-5.1', handle: null, malformed: false });
  assert.deepEqual(parseModelIdentity('gpt-5.1@cos-work'),
    { model: 'gpt-5.1', handle: 'work', malformed: false });
  // The marker is matched from the end, so a model id containing '@' survives.
  assert.deepEqual(parseModelIdentity('vendor@gpt@cos-home'),
    { model: 'vendor@gpt', handle: 'home', malformed: false });
  assert.deepEqual(parseModelIdentity('@cos-work'), { model: null, handle: 'work', malformed: false });
  assert.equal(parseModelIdentity('gpt-5.1@cos-').malformed, true);
  assert.deepEqual(parseModelIdentity(''), { model: null, handle: null, malformed: false });
  assert.deepEqual(parseModelIdentity(null), { model: null, handle: null, malformed: false });
  assert.equal(deploymentIdentity('gpt-5.1', 'work'), 'gpt-5.1@cos-work');
});

test('identity resolution serves only this instance its own handle', () => {
  const registry = HandleRegistry.parse(fixture());
  // Bare model and the instance's own suffix are the same request.
  assert.deepEqual(resolveIdentity(registry, 'work', 'gpt-5.1'), {
    handle: registry.local('work'), model: 'gpt-5.1'
  });
  assert.deepEqual(resolveIdentity(registry, 'work', 'gpt-5.1@cos-work'), {
    handle: registry.local('work'), model: 'gpt-5.1'
  });
  // Handle-only identity: the account's own picker chooses the model.
  assert.equal(resolveIdentity(registry, 'work', '@cos-work').model, null);
  assert.equal(resolveIdentity(registry, 'work', null).model, null);
  // Another handle is a routing error, never a reason to reach that account.
  assert.equal(codeOf(() => resolveIdentity(registry, 'work', 'gpt-5.1@cos-home')), 'handle_mismatch');
  assert.equal(codeOf(() => resolveIdentity(registry, 'work', 'gpt-5.1@cos-ghost')), 'handle_unknown');
  assert.equal(codeOf(() => resolveIdentity(registry, 'work', 'gpt-5.1@cos-')), 'handle_unknown');
  assert.equal(codeOf(() => resolveIdentity(registry, 'ghost', 'gpt-5.1')), 'handle_unknown');
});

test('a disabled handle is refused even when it is the one this instance serves', () => {
  const handles = fixture();
  handles[0] = { ...handles[0]!, enabled: false };
  const registry = HandleRegistry.parse(handles);
  assert.equal(codeOf(() => resolveIdentity(registry, 'work', 'gpt-5.1')), 'handle_disabled');
  handles[0] = { ...handles[0]!, enabled: true };
  handles[1] = { ...handles[1]!, enabled: false };
  const second = HandleRegistry.parse(handles);
  assert.equal(codeOf(() => resolveIdentity(second, 'work', 'gpt-5.1@cos-home')), 'handle_disabled');
});

test('readiness is ready only on positive live evidence, and unknown is not ready', () => {
  const registry = HandleRegistry.parse(fixture());
  const work = registry.local('work');
  const all = assessReadiness(work, { signedIn: true, browserRunning: true, extensionFresh: true });
  assert.equal(all.status, 'ready');
  assert.equal(all.ready, true);

  // Unknown: any signal unobserved keeps the handle unready.
  for (const evidence of [
    null,
    { signedIn: null, browserRunning: true, extensionFresh: true },
    { signedIn: true, browserRunning: null, extensionFresh: true },
    { signedIn: true, browserRunning: true, extensionFresh: null }
  ]) {
    const state = assessReadiness(work, evidence);
    assert.equal(state.status, 'unknown');
    assert.equal(state.ready, false, `unknown evidence must never be ready: ${JSON.stringify(evidence)}`);
  }

  // A negative signal is not_ready, not unknown.
  const denied = assessReadiness(work, { signedIn: false, browserRunning: true, extensionFresh: true });
  assert.equal(denied.status, 'not_ready');
  assert.equal(denied.ready, false);
  assert.match(denied.reason, /signedIn/);
});

test('a disabled handle never reads ready, whatever the evidence says', () => {
  const handles = fixture();
  handles[0] = { ...handles[0]!, enabled: false };
  const registry = HandleRegistry.parse(handles);
  const state = assessReadiness(registry.get('work')!, { signedIn: true, browserRunning: true, extensionFresh: true });
  assert.equal(state.status, 'disabled');
  assert.equal(state.ready, false);
});

test('the deployment map tags identities with provable readiness and no account detail', () => {
  const registry = HandleRegistry.parse(fixture());
  const entries = buildDeploymentMap(
    registry,
    new Map<string, HandleReadiness>([['work', ready]]),
    new Map([['home', ['gpt-5.1']]])
  );
  assert.deepEqual(entries.map((entry) => entry.model), [
    'gpt-5.1@cos-work',
    'gpt-5.1-mini@cos-work',
    'gpt-5.1@cos-home'
  ]);
  assert.equal(entries[0]!.ready, true);
  // This instance cannot observe home's browser: unknown, hence not ready.
  assert.equal(entries[2]!.status, 'unknown');
  assert.equal(entries[2]!.ready, false);

  const serialized = JSON.stringify(entries);
  for (const secretish of [
    'work@example.invalid',
    'home@example.invalid',
    'keyring://fixture-work',
    '/srv/cos/fixtures/work/browser-profile',
    '/srv/cos/fixtures/home/user-data'
  ]) {
    assert.equal(serialized.includes(secretish), false, `deployment map leaked ${secretish}`);
  }
});

test('the public handle view carries the alias and readiness only', () => {
  assert.deepEqual(publicHandleView(ready), {
    handle: 'work', status: 'ready', ready: true, reason: 'live browser evidence'
  });
  assert.equal(servedByValue('work'), 'work');
  assert.equal(SERVED_BY_HEADER, 'x-cos-handle');
});

test('conversation keys are scoped by handle, so retries cannot cross accounts', () => {
  const folded = 'a'.repeat(64);
  const work = scopedConversationKey('work', folded);
  const home = scopedConversationKey('home', folded);
  assert.notEqual(work, home);
  assert.equal(handleOfConversationKey(work), 'work');
  assert.equal(handleOfConversationKey(home), 'home');
  // A legacy unscoped key names no handle.
  assert.equal(handleOfConversationKey(folded), null);
  assert.equal(handleOfConversationKey('cos:'), null);
  assert.equal(handleOfConversationKey('cos:work'), null);
  assert.equal(handleOfConversationKey('cos:Work:' + folded), null);
});

test('the handle error codes stay bound to the ledger', () => {
  const expected: Array<[string, number]> = [
    ['handle_unknown', 400],
    ['handle_mismatch', 400],
    ['handle_disabled', 403],
    ['cross_handle_session', 409],
    ['handle_not_ready', 503],
    ['handle_unavailable', 503],
    ['handle_registry_invalid', 503]
  ];
  for (const [code, status] of expected) {
    const spec = GATEWAY_ERRORS[code as keyof typeof GATEWAY_ERRORS];
    assert.ok(spec, `no ledger row for ${code}`);
    assert.equal(spec.status, status, code);
  }
});
