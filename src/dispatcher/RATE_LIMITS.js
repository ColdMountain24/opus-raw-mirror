// Documented provider rate limits (5d).
//
// WARNING: confirm every value against current provider docs before wiring real
// fetch. The queue enforces THROTTLE (80%) of each limit. Edit only here; the
// dispatcher reads from this config. Free-tier defaults are the safe baseline:
// if a number is wrong, the queue under-consumes rather than blowing past the
// real limit.

export const RATE_LIMITS = {
  anthropic: {
    rpm: 50, // Tier 1 (~$5 spend). Free: 5. Paid: 1000+
    itpm: 40_000, // input tokens per minute
    otpm: 8_000, // output tokens per minute
  },
  groq: {
    rpm: 30, // Llama 3.3 70B free tier (model specific, verify)
    tpm: 6_000, // tokens per minute
  },
  mistral: {
    rps: 1, // ~1 req/s free tier; no hard RPM documented
    rpm: null, // derived from rps if needed
  },
  ollama: {
    rpm: null, // local, no enforced limit
    tpm: null,
  },
};

export const THROTTLE = 0.8;

// Effective caps the queue enforces (80% of the above):
//   anthropic: 40 RPM, 32k ITPM, 6.4k OTPM
//   groq:      24 RPM, 4.8k TPM
//   mistral:   0.8 RPS (about 1 call / 1.25s)
//   ollama:    uncapped
