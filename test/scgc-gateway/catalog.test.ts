import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  openAiModels,
  resolveModelChoice,
  REASONING_EFFORTS,
  type ChatModelCatalog
} from '../../src/main/openai-gateway/catalog.js';
import { GatewayError } from '../../src/main/openai-gateway/errors.js';

const ready: ChatModelCatalog = {
  state: 'ready',
  requestedAt: null,
  observedAt: 1_730_000_000_000,
  models: [
    { id: 'gpt-5.1', label: 'GPT-5.1', efforts: ['minimal', 'low', 'medium', 'high'] },
    { id: 'grok-4-1-fast', label: 'Grok 4.1 Fast', efforts: ['high'], aliases: ['grok-4-fast'] },
    { id: 'gpt-6-pro', label: 'GPT-6', efforts: ['pro'] }
  ]
};

test('the catalog maps to OpenAI model objects with plain ids', () => {
  const models = openAiModels(ready);
  assert.equal(models.length, 3);
  assert.deepEqual(models[0], {
    id: 'gpt-5.1',
    object: 'model',
    created: 1_730_000_000,
    owned_by: 'chat-on-steroids'
  });
  for (const model of models) {
    assert.ok(!model.id.startsWith('cos/'), 'ids must not carry the cos/ prefix');
    assert.equal(model.object, 'model');
  }
});

test('an explicit model + effort is validated against the catalog', () => {
  assert.deepEqual(resolveModelChoice(ready, 'gpt-5.1', 'high'), {
    model: 'gpt-5.1',
    reasoningEffort: 'high'
  });
});

test('an omitted effort forwards null — the page confirms the model on any offered lane', () => {
  // Defaulting to efforts[0] is unsafe: the picker refuses some exact
  // (model, effort) pairs (measured live: gpt-6 + "none" failed
  // model-unconfirmed while gpt-6 + "medium" confirmed).
  assert.deepEqual(resolveModelChoice(ready, 'gpt-5.1', null), {
    model: 'gpt-5.1',
    reasoningEffort: null
  });
  assert.deepEqual(resolveModelChoice(ready, 'gpt-5.1', undefined), {
    model: 'gpt-5.1',
    reasoningEffort: null
  });
});

test('aliases and unique display labels resolve', () => {
  assert.equal(resolveModelChoice(ready, 'grok-4-fast', 'high').model, 'grok-4-1-fast');
  assert.equal(resolveModelChoice(ready, 'Grok 4.1 Fast', 'high').model, 'grok-4-1-fast');
  assert.equal(resolveModelChoice(ready, 'GPT-6', 'pro').model, 'gpt-6-pro');
});

test('no model means ChatGPT keeps its own selection', () => {
  assert.deepEqual(resolveModelChoice(ready, null, null), { model: null, reasoningEffort: null });
  assert.deepEqual(resolveModelChoice(ready, undefined, undefined), { model: null, reasoningEffort: null });
});

test('unknown models and unavailable efforts are client errors', () => {
  assert.throws(() => resolveModelChoice(ready, 'nope', null), (error: Error) => {
    return error instanceof GatewayError && error.status === 400 && error.code === 'model_unknown';
  });
  assert.throws(() => resolveModelChoice(ready, 'gpt-5.1', 'pro'), (error: Error) => {
    return error instanceof GatewayError && error.status === 400 && error.code === 'effort_unavailable';
  });
});

test('a not-ready catalog is a 503, like /v1/models', () => {
  const pending: ChatModelCatalog = { ...ready, state: 'pending', error: undefined };
  assert.throws(() => resolveModelChoice(pending, 'gpt-5.1', 'high'), (error: Error) => {
    return error instanceof GatewayError && error.status === 503 && error.code === 'models_unknown';
  });
});

test('the reasoning-effort vocabulary matches CoS', () => {
  assert.deepEqual(REASONING_EFFORTS, [
    'pro', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'
  ]);
});
