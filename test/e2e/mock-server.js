'use strict';
/**
 * One local HTTP server that stands in for every external system during the end-to-end test:
 *   PlacidWay (robots.txt, listing pages, detail pages)  -> serves test/fixtures
 *   OpenAI-compatible LLM  (POST /v1/chat/completions)    -> canned generation + judge responses
 *   Facebook Graph API     (/v23.0/...)                   -> records posts, can simulate errors
 *   Telegram Bot API       (/bot<token>/sendMessage)      -> records messages
 * Behaviour is switched at runtime with POST /__mock/mode {llm, judge, fb, site}.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.MOCK_PORT || 8787);
const SELF = `http://127.0.0.1:${PORT}`;
const FX = path.join(__dirname, '..', 'fixtures');
const fx = (f) => fs.readFileSync(path.join(FX, f), 'utf8').replace(/https:\/\/www\.placidway\.com\/(article|package|answer-detail)\//g, `${SELF}/$1/`);

const state = { mode: { llm: 'ok', judge: 'ok', fb: 'ok', site: 'ok' }, requests: [], telegram: [], fbPosts: [], llmCalls: 0 };

const listing = (links) => `<!doctype html><html><body><nav><a href="/">Home</a></nav><main>${links.map(([h, t]) => `<div class="card"><a href="${h}">${t}</a></div>`).join('')}</main></body></html>`;

const VARIANTS = {
  shoulder: [
    { angle: 'bad on purpose', hook: 'Get a guaranteed pain-free shoulder replacement in Guadalajara!', lines: ['Best surgeons, cheapest prices.', 'Book now.'], cta: 'Act now!', hashtags: ['#Cure', '#MedicalTourism', '#Mexico'], evidence: [] },
    { angle: 'practical takeaway', hook: 'Considering a shoulder replacement in Guadalajara, Mexico?', lines: ['Typical estimates run $8,500 to $11,500, depending on the implant, hospital and package.', 'Travel, accommodation and physical therapy may be billed separately, so ask for an itemized quote.', "Plan to stay roughly 10 to 14 days and get your surgeon's travel clearance before flying."], cta: 'Read the full answer before you request quotes.', hashtags: ['#MedicalTourism', '#Guadalajara', '#ShoulderReplacement', '#PlacidWay'], evidence: ['estimated at $8,500 to $11,500', 'roughly 10 to 14 days in the area'] },
    { angle: 'question-led', hook: 'What does a shoulder replacement in Guadalajara really cost?', lines: ['The answer puts typical estimates at $8,500 to $11,500.', 'Implant brand, hospital tier and included physical therapy all move the price.', 'Line up a local physical therapist at home before you travel.'], cta: 'See what to ask for in your itemized quote.', hashtags: ['#MedicalTourism', '#Guadalajara', '#JointCare'], evidence: ['$8,500 to $11,500', 'Hospital tier and whether post-operative physical therapy is included'] },
  ],
  facelift: [
    { angle: 'planning checklist', hook: 'Thinking about a facelift in Seoul? Here is what this package lists.', lines: ['Listed from $5,100 at VG Plastic Surgery in Gangnam.', 'Inclusions cover consultation, anesthesia, preoperative tests and interpreter coordination.', "Plan for about 10–14 days in Seoul, subject to your surgeon's clearance to fly."], cta: 'Ask for the written list of inclusions before you book.', hashtags: ['#MedicalTourism', '#Seoul', '#FaceliftAbroad', '#PlacidWay'], evidence: ['starts at $5,100', 'Plan for about 10–14 days in Seoul'] },
    { angle: 'what is not included', hook: 'Comparing facelift packages in Seoul?', lines: ['This listing starts at $5,100 and covers surgery, anesthesia and postoperative reviews.', 'Airfare, visas, accommodation and meals are not part of the package price.'], cta: 'Check the full package details below.', hashtags: ['#MedicalTourism', '#SouthKorea', '#Facelift'], evidence: ['starts at $5,100', 'not part of the package price'] },
    { angle: 'bad on purpose', hook: 'Look 10 years younger with the best facelift in Korea!', lines: ['JCI accredited, 100% safe.', 'Only $3,999 this month.'], cta: 'Hurry, limited time!', hashtags: ['#Facelift', '#Seoul', '#Guaranteed'], evidence: [] },
  ],
  hair: [
    { angle: 'checklist', hook: 'Comparing hair transplant quotes from Turkey and the UK?', lines: ['Turkish packages often bundle airport transfers, hotel nights, blood tests and aftercare products.', 'UK quotes may charge consultations, medication and follow-ups separately.', 'Ask every clinic for an itemised written quote.'], cta: 'Read the line-by-line checklist below.', hashtags: ['#HairTransplant', '#Turkey', '#MedicalTourism'], evidence: ['Airport transfers between the hotel and the clinic', 'ask each clinic for an itemised written quote'] },
    { angle: 'questions to ask', hook: '3 questions to ask before booking a hair transplant abroad.', lines: ['Who performs each step of the procedure?', 'How will follow-up work once you are back home?', 'Which costs sit outside the quote, like flights and insurance?'], cta: 'Get the full checklist in our guide.', hashtags: ['#HairTransplant', '#Turkey', '#UK', '#PlacidWay'], evidence: ['who performs each step of the procedure', 'how follow-up will be handled once they are back home'] },
  ],
};

function pickVariants(source) {
  if (/Shoulder Replacement/i.test(source)) return VARIANTS.shoulder;
  if (/Facelift/i.test(source)) return VARIANTS.facelift;
  return VARIANTS.hair;
}

function llm(body) {
  state.llmCalls++;
  const system = body.messages[0].content;
  const user = body.messages[1].content;
  const usage = { prompt_tokens: 1200, completion_tokens: 400, total_tokens: 1600 };
  if (state.mode.llm === 'fail401') return [401, { error: { message: 'Incorrect API key provided', type: 'invalid_request_error', code: 'invalid_api_key' } }];
  if (/compliance reviewer/i.test(system)) {
    const drafts = [...user.matchAll(/--- DRAFT (\d+) ---/g)].map((m) => Number(m[1]));
    const results = drafts.map((i) => state.mode.judge === 'fail'
      ? { variant: i, verdict: 'fail', quality: 4, claims: [{ claim: 'invented detail', supported: false, evidence: '' }], violations: [{ type: 'unsupported_fact', text: 'invented detail', reason: 'not in source' }] }
      : { variant: i, verdict: 'pass', quality: 3 + (i % 3), claims: [{ claim: 'price range/inclusions as stated', supported: true, evidence: 'from source' }], violations: [] });
    return [200, { id: 'cmpl-judge', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify({ results }) } }], usage }];
  }
  const variants = state.mode.llm === 'garbage' ? null : pickVariants(user);
  const content = variants ? JSON.stringify({ variants }) : 'Sorry, I cannot help with that.';
  return [200, { id: 'cmpl-gen', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content } }], usage }];
}

function graph(method, url, body) {
  const u = new URL(url, SELF);
  const token = u.searchParams.get('access_token');
  const parts = u.pathname.split('/').filter(Boolean); // [v23.0, id, edge?]
  if (!token) return [400, { error: { message: 'An active access token must be used', type: 'OAuthException', code: 2500 } }];
  if (state.mode.fb === 'token_expired') return [400, { error: { message: 'Error validating access token: Session has expired on Tuesday.', type: 'OAuthException', code: 190, error_subcode: 463 } }];
  if (method === 'GET' && parts.length === 2 && u.searchParams.get('fields') === 'id,name') return [200, { id: parts[1], name: 'PW Demo Test Page' }];
  if (method === 'POST' && parts[2] === 'photos') {
    if (state.mode.fb === 'image_error') return [400, { error: { message: '(#324) Requires upload file', type: 'OAuthException', code: 324 } }];
    const n = state.fbPosts.length + 1;
    state.fbPosts.push({ edge: 'photos', body });
    return [200, { id: `90000${n}`, post_id: `123456_70000${n}` }];
  }
  if (method === 'POST' && parts[2] === 'feed') {
    const n = state.fbPosts.length + 1;
    state.fbPosts.push({ edge: 'feed', body });
    return [200, { id: `123456_80000${n}` }];
  }
  if (method === 'POST' && parts[2] === 'media') { state.igPosts = (state.igPosts || []).concat({ step: 'container', body }); return [200, { id: 'ig_container_1' }]; }
  if (method === 'POST' && parts[2] === 'media_publish') { state.igPosts = (state.igPosts || []).concat({ step: 'publish', body }); return [200, { id: 'ig_media_1' }]; }
  if (method === 'GET' && parts[2] === 'insights') return [200, { data: [{ name: 'post_clicks', period: 'lifetime', values: [{ value: 7 }] }] }];
  if (method === 'GET' && parts.length === 2) {
    const f = u.searchParams.get('fields') || '';
    if (f.includes('reactions')) return [200, { id: parts[1], reactions: { data: [], summary: { total_count: 12 } }, comments: { data: [], summary: { total_count: 3 } }, shares: { count: 2 }, permalink_url: `https://www.facebook.com/${parts[1]}`, is_published: true }];
    return [200, { id: parts[1], permalink_url: `https://www.facebook.com/${parts[1]}` }];
  }
  return [404, { error: { message: `mock: unknown graph call ${method} ${u.pathname}`, code: 803 } }];
}

function send(res, status, body, type) {
  const isJson = typeof body !== 'string';
  res.writeHead(status, { 'Content-Type': type || (isJson ? 'application/json' : 'text/html; charset=utf-8') });
  res.end(isJson ? JSON.stringify(body) : body);
}

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const u = new URL(req.url, SELF);
    const body = raw ? (() => { try { return JSON.parse(raw); } catch (e) { return raw; } })() : null;
    state.requests.push({ t: Date.now(), method: req.method, path: u.pathname, ua: req.headers['user-agent'] });

    if (u.pathname === '/__mock/mode' && req.method === 'POST') { Object.assign(state.mode, body || {}); return send(res, 200, state.mode); }
    if (u.pathname === '/__mock/state') return send(res, 200, state);
    if (u.pathname === '/__mock/reset' && req.method === 'POST') { state.requests = []; state.telegram = []; state.fbPosts = []; state.igPosts = []; state.llmCalls = 0; state.mode = { llm: 'ok', judge: 'ok', fb: 'ok', site: 'ok' }; return send(res, 200, { ok: true }); }

    if (u.pathname === '/v1/chat/completions') {
      if (!/^Bearer \S+/.test(req.headers.authorization || '')) return send(res, 401, { error: { message: 'missing key' } });
      const [s, b] = llm(body); return send(res, s, b);
    }
    if (u.pathname.startsWith('/v23.0/')) { const [s, b] = graph(req.method, req.url, body); return send(res, s, b); }
    const tg = u.pathname.match(/^\/bot([^/]+)\/sendMessage$/);
    if (tg) {
      state.telegram.push({ chat_id: body.chat_id, text: body.text, parse_mode: body.parse_mode, disable_web_page_preview: body.disable_web_page_preview });
      return send(res, 200, { ok: true, result: { message_id: state.telegram.length, chat: { id: body.chat_id }, text: body.text } });
    }

    // PlacidWay
    if (state.mode.site === 'down') return send(res, 503, '<h1>503 Service Unavailable</h1>');
    if (u.pathname === '/robots.txt') return send(res, 200, fx('robots.txt'), 'text/plain');
    if (u.pathname === '/search-medical-articles/All/All/1') return send(res, 200, fx('listing-articles.html'));
    if (u.pathname === '/search-medical-packages/All/All/1') return send(res, 200, listing([[`${SELF}/package/6950/Facelift-Package-in-Seoul-South-Korea-by-VG-Plastic-Surgery`, 'Facelift Package in Seoul']]));
    if (u.pathname === '/search-medical-answers/All/All/1') return send(res, 200, listing([['/answer-detail/9999/Broken-Answer', 'A broken answer page'], ['/answer-detail/29/How-Much-Does-Shoulder-Replacement-Cost-in-Guadalajara-Mexico', 'How Much Does Shoulder Replacement Cost in Guadalajara, Mexico?']]));
    if (u.pathname.startsWith('/package/6950/')) return send(res, 200, fx('package-6950.html'));
    if (u.pathname.startsWith('/answer-detail/29/')) return send(res, 200, fx('answer-29.html'));
    if (u.pathname.startsWith('/article/9809/')) return send(res, 200, fx('article-9809.html'));
    return send(res, 404, fx('thin-page.html'));
  });
});

server.keepAliveTimeout = 65000;
server.listen(PORT, '127.0.0.1', () => console.log(`mock server on ${SELF}`));
module.exports = { state };
