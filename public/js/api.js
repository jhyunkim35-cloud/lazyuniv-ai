// Claude API calls: non-streaming and streaming with SSE parsing.
// Depends on: constants.js (MAX_TOKENS_NOTES, USE_ADVISOR, abortController, abortableSleep, debugLog, isBatchMode), markdown.js (renderMarkdown).

/* ═══════════════════════════════════════════════
   Claude API — non-streaming
═══════════════════════════════════════════════ */
async function callClaudeOnce(apiKey, userPrompt, systemPrompt, maxTokens = MAX_TOKENS_NOTES, model = 'claude-haiku-4-5-20251001', cachePrefix = null, meta = {}) {
  let idToken = null;
  try { idToken = await firebase.auth().currentUser?.getIdToken(); } catch (_) {}
  const MAX_RETRIES = 3;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    debugLog('API', `callOnce model=${model} prompt=${userPrompt.length}chars max_tokens=${maxTokens} cache=${!!cachePrefix}`);
    const messages = cachePrefix
      ? [{ role: 'user', content: [
          { type: 'text', text: cachePrefix, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: userPrompt }
        ]}]
      : [{ role: 'user', content: userPrompt }];
    const body = { model, max_tokens: maxTokens, system: systemPrompt, messages, idToken, isFirstCall: meta.isFirstCall || false, feature: meta.feature || 'unknown' };
    if (USE_ADVISOR && model.includes('sonnet') && !systemPrompt.includes('검토자')) {
      body.tools = (body.tools || []).concat([{
        type: 'advisor_20260301',
        name: 'advisor',
        model: 'claude-opus-4-6',
        max_uses: 1
      }]);
    }
    const res = await fetch('/api/claude', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: abortController ? abortController.signal : undefined,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.error('[callClaudeOnce] API error', res.status, JSON.stringify(err));
      debugLog('API', `Error ${res.status}: ${JSON.stringify(err)}`);
      if (res.status === 429) {
        if (attempt === MAX_RETRIES) throw new Error('API 한도 초과 — 잠시 후 다시 시도해주세요.');
        const waitSec = parseInt(res.headers.get('Retry-After') || '30', 10);
        debugLog('API', `429 rate limit — retry ${attempt+1}, waiting ${waitSec}s`);
        agentLog(0, `Rate limit hit — waiting ${waitSec}s… (시도 ${attempt}/${MAX_RETRIES})`);
        await abortableSleep(waitSec * 1000);
        continue;
      }
      if (res.status === 401) throw new Error('API 키가 유효하지 않습니다. 키를 확인해주세요.');
      throw new Error(err?.error?.message || `API 오류 (${res.status})`);
    }
    const data = await res.json();
    const result = data.content.filter(b => b.type === 'text').map(b => b.text).join('') || '';
    debugLog('API', `Response ${result.length}chars`);
    return result;
  }
  throw new Error('Max retries reached without response');
}

/* ═══════════════════════════════════════════════
   Claude API — streaming
═══════════════════════════════════════════════ */
async function callClaudeStream(
  apiKey, userPrompt, targetEl, dotEl,
  systemPrompt = '당신은 전문 회의 분석가입니다. 모든 답변은 반드시 한국어로 작성하세요. 명확하고 구조적으로 정리해주세요.',
  maxTokens = MAX_TOKENS_NOTES,
  cachePrefix = null,
  model = 'claude-haiku-4-5-20251001',
  meta = {}
) {
  let idToken = null;
  try { idToken = await firebase.auth().currentUser?.getIdToken(); } catch (_) {}

  dotEl.className = 'status-dot loading';
  if (!isBatchMode) document.getElementById('dotNotes').className = 'status-dot loading';
  targetEl.innerHTML = '<div class="loading-row"><div class="spinner"></div><span>AI 노트 작성 중…</span></div>';

  const messages = cachePrefix
    ? [{ role: 'user', content: [
        { type: 'text', text: cachePrefix, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: userPrompt }
      ]}]
    : [{ role: 'user', content: userPrompt }];

  const body = {
    model,
    max_tokens: maxTokens,
    stream: true,
    system: systemPrompt,
    messages,
    idToken,
    isFirstCall: meta.isFirstCall || false,
    feature: meta.feature || 'unknown',
  };

  if (USE_ADVISOR && model.includes('sonnet') && !systemPrompt.includes('검토자')) {
    body.tools = (body.tools || []).concat([{
      type: 'advisor_20260301',
      name: 'advisor',
      model: 'claude-opus-4-6',
      max_uses: 1
    }]);
  }

  const MAX_RETRIES = 3;
  let response;
  debugLog('API', `callStream model=${model} prompt=${userPrompt.length}chars max_tokens=${maxTokens} cache=${!!cachePrefix}`);
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    response = await fetch('/api/claude', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: abortController ? abortController.signal : undefined,
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      console.error('[callClaudeStream] API error', response.status, JSON.stringify(err));
      debugLog('API', `Error ${response.status}: ${JSON.stringify(err)}`);
      if (response.status === 429) {
        if (attempt === MAX_RETRIES) throw new Error('API 한도 초과 — 잠시 후 다시 시도해주세요.');
        const waitSec = parseInt(response.headers.get('Retry-After') || '30', 10);
        agentLog(0, `Rate limit hit — waiting ${waitSec}s… (시도 ${attempt}/${MAX_RETRIES})`);
        await abortableSleep(waitSec * 1000);
        continue;
      }
      if (response.status === 401) throw new Error('API 키가 유효하지 않습니다. 키를 확인해주세요.');
      throw new Error(err?.error?.message || `API 오류 (${response.status})`);
    }
    break;
  }

  if (!response.body) throw new Error('스트림 응답이 비어 있습니다.');
  const reader  = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer    = '';
  let fullText  = '';
  let firstChunk = true;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines  = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;

        try {
          const json = JSON.parse(data);
          if (json.type === 'content_block_delta' && json.delta?.type === 'text_delta') {
            if (firstChunk) { targetEl.innerHTML = ''; firstChunk = false; }
            fullText += json.delta.text;
            targetEl.innerHTML = renderMarkdown(fullText);
            // scroll hero body to bottom while streaming
            targetEl.scrollTop = targetEl.scrollHeight;
          } else if (json.type === 'content_block_start') {
            const blockType = json.content_block?.type || 'unknown';
            if (blockType === 'advisor_tool_use') {
              agentLog(1, '🧠 Opus 자문 요청 중…');
            } else if (blockType === 'advisor_tool_result') {
              agentLog(1, '🧠 Opus 자문 수신 완료');
            } else if (blockType !== 'text') {
              debugLog('SSE', `content_block_start type=${blockType}`);
            }
          } else if (json.type === 'content_block_stop' || json.type === 'message_delta') {
            // silently ignore
          } else if (json.type !== 'message_start' && json.type !== 'message_stop' && json.type !== 'ping') {
            debugLog('SSE', `event type=${json.type} ${JSON.stringify(json).slice(0, 200)}`);
          }
        } catch (_) { /* ignore SSE parse errors */ }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }

  debugLog('API', `Stream complete ${fullText.length}chars`);
  dotEl.className = 'status-dot done';
  return fullText;
}
