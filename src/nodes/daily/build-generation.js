// Build generation request: OpenAI-compatible chat completion in JSON mode (best-of-N variants).
const { buildGenerationRequest } = require('../../lib/prompt');

const { cfg } = $('Config').first(0).json;
const { content } = $('Extract & validate content').first(0).json;
return [{ json: { request: buildGenerationRequest(content, content.llm_context, cfg) } }];
