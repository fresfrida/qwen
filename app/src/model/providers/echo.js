// A fake provider that is honestly fake: it produces no research and no script, it only exercises
// the plumbing. Answers are labelled SIMULATED wherever they appear, and 'auto' mode keys off the
// stage name rather than guessing from a single fixed reply.

const RESEARCH = JSON.stringify({
  claims: [{ claim: 'SIMULATED: the brand sells a canned citrus drink.', sources: [{ url: 'https://example.com/brand', quote: 'SIMULATED source line' }] }],
  open_questions: ['SIMULATED: is the price permitted on screen?'],
  quoted_requests: [],
  evidence_gaps: ['SIMULATED: no evidence about competitors.'],
});
const SCRIPT = 'SCENE 1 — a kitchen counter, a can condenses — SIMULATED narration: a canned citrus drink.';
const NOISE = 'SIMULATED refusal: I cannot help with that.';

export function createEchoProvider(cfg) {
  const mode = cfg.echoMode || 'auto';
  return {
    name: 'echo',
    configured: () => true,
    describe: () => ({ provider: 'echo', simulated: true, mode }),
    async complete({ prompt, stage }) {
      const text = mode === 'research' ? RESEARCH : mode === 'script' ? SCRIPT : mode === 'noise' ? NOISE
        : stage === 'research' ? RESEARCH : SCRIPT;
      return { ran: true, provider: 'echo', simulated: true, text, finishReason: 'simulated', promptChars: prompt.length };
    },
  };
}
