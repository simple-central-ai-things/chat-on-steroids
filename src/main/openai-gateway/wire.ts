/**
 * The gateway's entry point, called once from CoS's patched main bootstrap
 * (see patch/wire-openai-server.patch). This file and internals.ts are the
 * only two files that import CoS modules; everything else in the module is
 * dependency-free so node:test exercises it with stubs and no Electron.
 *
 * It must run after the session store is initialized (initSessionStore in
 * index.ts) and be stopped in the admission/drain shutdown phase, the same
 * place the local control API starts and stops.
 */
import { gatewayConfigFromEnv, startOpenAiServer, type OpenAiServer } from './openai-server.js';
import { createCosInternals } from './internals.js';

export type { OpenAiServer };

let gateway: OpenAiServer | null = null;

export async function startOpenAiGateway(options: {
  userData: string;
  log?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
}): Promise<OpenAiServer> {
  if (gateway) return gateway;
  const log = options.log ?? (() => undefined);
  const env = options.env ?? process.env;
  const config = gatewayConfigFromEnv(env);
  const internals = createCosInternals();
  gateway = await startOpenAiServer(internals, config, {
    stateDir: `${options.userData}/openai-gateway`,
    log
  });
  return gateway;
}

/**
 * Stops the gateway once and resolves when the listener is closed; a no-op
 * when it never started. CoS's shutdown phase awaits it (the admission/drain
 * run array takes promises), so the port is released before the process
 * drains.
 */
export async function stopOpenAiGateway(): Promise<void> {
  const current = gateway;
  gateway = null;
  if (current === null) return;
  try {
    await current.stop();
  } catch (error: unknown) {
    (console as { error?: (message: string) => void }).error?.(
      `OpenAI gateway stop failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
