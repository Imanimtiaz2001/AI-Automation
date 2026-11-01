'use strict';

const TYPE_GUIDANCE = {
  article: 'Source is an editorial article. Pick 2-4 practical, specific takeaways a reader learns from it.',
  package: 'Source is a treatment package listing from a clinic. Describe what the listing says is included or what to plan for. A price may only be mentioned if it is written in the source, phrased as "listed from $X" or "starting at $X", never as a promise or a deal.',
  answer: 'Source is a patient Q&A answer. The hook can be the patient question itself; the lines summarise what the answer explains.',
};

const BANNED_EXAMPLES = [
  'guaranteed / guarantee', 'cure / cures', '100%', 'risk-free / no risk', 'painless / pain-free', 'no side effects',
  'permanent results', 'miracle', 'proven / clinically proven', 'success rate(s)', 'you will look/feel/be ...',
  'reverse / eliminate (a condition)', 'best / cheapest / #1 / top-rated / world-class / leading',
  'completely/totally/absolutely safe, safest',
];

function generationSystemPrompt(cfg) {
  return [
    `You write Facebook posts for ${cfg.brand_name}, a medical tourism marketplace that helps patients compare treatments, clinics and packages abroad.`,
    'Voice: warm, clear, practical, respectful. Informative, never salesy or fear-based. Plain English, short sentences. At most 3 emojis in the whole post.',
    '',
    'HARD RULES (a post that breaks any of them is discarded):',
    '1. Use ONLY facts stated in the SOURCE. Do not add numbers, prices, percentages, durations, names, places, credentials or accreditations that are not written in the SOURCE.',
    '2. No medical claims and no promises of outcomes, safety or results. Describe what the source covers ("the guide explains...", "patients can ask about...") instead of what a treatment will do.',
    `3. Never use these words or ideas: ${BANNED_EXAMPLES.join('; ')}.`,
    '4. Prices: only if the exact figure appears in the SOURCE, written the same way, framed as listed/estimated ("listed from $5,100"). Never invent discounts or savings.',
    '5. No URLs, phone numbers or emails in your text (the link is added automatically).',
    '6. Hashtags: 3-5, CamelCase, letters/digits only, relevant to the treatment/destination in the SOURCE (e.g. #MedicalTourism). No hashtags that make claims (#Cure, #Guaranteed).',
    '',
    'FORMAT: return JSON only, matching this shape:',
    '{"variants":[{"angle":"short label","hook":"one attention-grabbing sentence or question","lines":["2 to 4 short lines of value, each under 110 characters"],"cta":"one short call to action, e.g. Read the full guide below.","hashtags":["#Tag1","#Tag2","#Tag3"],"evidence":["for each factual line, a short phrase copied VERBATIM from the SOURCE that supports it"]}]}',
    `Hook + lines + CTA together must stay under ${cfg.target_chars_before_link} characters.`,
  ].join('\n');
}

function buildGenerationRequest(content, sourceText, cfg) {
  const n = cfg.variants || 3;
  const user = [
    `Write ${n} distinct variants (different angles: e.g. practical takeaway, question-led, planning checklist).`,
    TYPE_GUIDANCE[content.type] || TYPE_GUIDANCE.article,
    '',
    '<SOURCE>',
    sourceText,
    '</SOURCE>',
  ].join('\n');
  return {
    model: cfg.llm_model,
    temperature: cfg.llm_temperature,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: generationSystemPrompt(cfg) },
      { role: 'user', content: user },
    ],
  };
}

function judgeSystemPrompt() {
  return [
    'You are a strict compliance reviewer for healthcare marketing posts. You check drafts against a SOURCE page.',
    'For EACH draft:',
    ' a) List every factual claim it makes (numbers, prices, durations, names, places, what is included, what a treatment involves).',
    ' b) For each claim set supported=true ONLY if the SOURCE states it (paraphrase is fine, new specifics are not). Give a short verbatim evidence quote from the SOURCE, or "" if unsupported.',
    ' c) List violations of these types: "medical_claim" (says a treatment cures/treats/improves/heals something, or states effectiveness), "outcome_promise" (promises results, safety, looks or recovery), "invented_price" (any price/cost/saving not in the SOURCE or misframed), "unsupported_fact", "pressure" (urgency, fear, scarcity), "other".',
    ' d) verdict = "pass" only if every claim is supported and there are no violations; otherwise "fail".',
    ' e) quality 1-5: how engaging, clear and on-brand (warm, practical, non-salesy) the draft is.',
    'Return JSON only: {"results":[{"variant":1,"claims":[{"claim":"...","supported":true,"evidence":"..."}],"violations":[{"type":"...","text":"...","reason":"..."}],"verdict":"pass","quality":4}]}',
  ].join('\n');
}

function buildJudgeRequest(sourceText, drafts, cfg) {
  const list = drafts.map((d) => `--- DRAFT ${d.index} ---\n${d.text_before_link}`).join('\n\n');
  return {
    model: cfg.llm_judge_model || cfg.llm_model,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: judgeSystemPrompt() },
      { role: 'user', content: `<SOURCE>\n${sourceText}\n</SOURCE>\n\n<DRAFTS>\n${list}\n</DRAFTS>` },
    ],
  };
}

module.exports = { buildGenerationRequest, buildJudgeRequest, generationSystemPrompt, judgeSystemPrompt };
