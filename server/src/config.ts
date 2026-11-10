export const pipelineDefaults = {
  gateThreshold: 0.85,
  voiceThreshold: 0.95,
  gateTimeoutMs: 1000,
  searchTimeoutMs: 900,
  verdictTimeoutMs: 1000,
  totalTimeoutMs: 3000,
  speechTimeoutMs: 1500,
  warmupTimeoutMs: 5000,
  voiceCooldownMs: 10000,
  maxInFlight: 3,
  dedupTtlMs: 300000,
  dedupMaxEntries: 500,
};
export type PipelineConfig = typeof pipelineDefaults;
export type Config = PipelineConfig & {
  typesafeApiKey: string;
  exaApiKey: string;
  jevModel: string;
  port: number;
  host: string;
};

export function validatePipelineConfig(config: PipelineConfig): PipelineConfig {
  for (const key of Object.keys(pipelineDefaults) as (keyof PipelineConfig)[]) {
    const value = config[key];
    if (!Number.isFinite(value)) throw new Error(`Invalid configuration: ${key}`);
    if (key.endsWith("Threshold")) {
      if (value < 0 || value > 1) throw new Error(`Invalid configuration: ${key} must be in [0,1]`);
    } else if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`Invalid configuration: ${key} must be a positive integer`);
    }
  }
  return config;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const key = (name: string): string => {
    const value = env[name]?.trim();
    if (!value || /^(?:tu[_ -]?clave|your[_ -]?key|replace[_ -]?me)/i.test(value)) {
      throw new Error(`Set ${name} in .env`);
    }
    return value;
  };
  const number = (name: string, fallback: number): number => env[name] === undefined ? fallback : Number(env[name]);
  const pipeline = validatePipelineConfig({
    ...pipelineDefaults,
    gateThreshold: number("GATE_THRESHOLD", pipelineDefaults.gateThreshold),
    voiceThreshold: number("VOICE_THRESHOLD", pipelineDefaults.voiceThreshold),
    gateTimeoutMs: number("GATE_TIMEOUT_MS", pipelineDefaults.gateTimeoutMs),
    searchTimeoutMs: number("SEARCH_TIMEOUT_MS", pipelineDefaults.searchTimeoutMs),
    verdictTimeoutMs: number("VERDICT_TIMEOUT_MS", pipelineDefaults.verdictTimeoutMs),
    totalTimeoutMs: number("TOTAL_TIMEOUT_MS", pipelineDefaults.totalTimeoutMs),
    speechTimeoutMs: number("SPEECH_TIMEOUT_MS", pipelineDefaults.speechTimeoutMs),
    warmupTimeoutMs: number("WARMUP_TIMEOUT_MS", pipelineDefaults.warmupTimeoutMs),
    voiceCooldownMs: number("VOICE_COOLDOWN_MS", pipelineDefaults.voiceCooldownMs),
    maxInFlight: number("MAX_IN_FLIGHT", pipelineDefaults.maxInFlight),
  });
  const port = number("PORT", 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT");
  return {
    ...pipeline,
    typesafeApiKey: key("TYPESAFE_API_KEY"),
    exaApiKey: key("EXA_API_KEY"),
    jevModel: env.JEV_MODEL?.trim() || "jev-1.13.0",
    port,
    host: env.HOST?.trim() || "127.0.0.1",
  };
}
