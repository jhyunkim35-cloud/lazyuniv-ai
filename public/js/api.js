// Claude API calls: non-streaming and streaming with SSE parsing.
// Depends on: constants.js (MAX_TOKENS_NOTES, USE_ADVISOR, abortController, abortableSleep, debugLog, isBatchMode), markdown.js (renderMarkdown).

// Fix 1 (Q1): stop_reason from the most recent callClaudeOnce/callClaudeStream
// call, so pipeline.js can detect max_tokens truncation right after a call
// returns. Reset at the start of each call, set once the value is known.
let lastStopReason = null;
function getLastStopReason() { return lastStopReason; }

/* ═══════════════════════════════════════════════
   Claude API — non-streaming
═══════════════════════════════════════════════ */
async function callClaudeOnce(apiKey, userPrompt, systemPrompt, maxTokens = MAX_TOKENS_NOTES, model = 'claude-haiku-4-5-20251001', cachePrefix = null, meta = {}, assistantPrefill = null) {
  let idToken = null;
  try { idToken = await firebase.auth().currentUser?.getIdToken(); } catch (_) {}
  lastStopReason = null;
  const MAX_RETRIES = 3;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    debugLog('API', `callOnce model=${model} prompt=${userPrompt.length}chars max_tokens=${maxTokens} cache=${!!cachePrefix}`);
    const messages = cachePrefix
      ? [{ role: 'user', content: [
          { type: 'text', text: cachePrefix, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: userPrompt }
        ]}]
      : [{ role: 'user', content: userPrompt }];
    // Fix 3 (Q1): optional continuation turn — appended so the model resumes
    // exactly where a previous max_tokens cutoff left off.
    if (assistantPrefill) messages.push({ role: 'assistant', content: assistantPrefill });
    // B1: auto-inject the active analysisId. The pipeline sets this once
    // at runAgentPipeline start and clears it in finally; every billable
    // fetch in between picks it up automatically without callers having
    // to thread it through. meta.analysisId can override (currently unused).
    const analysisId = meta.analysisId
      || (typeof _currentAnalysisId !== 'undefined' ? _currentAnalysisId : null);
    const body = { model, max_tokens: maxTokens, system: systemPrompt, messages, idToken, isFirstCall: meta.isFirstCall || false, feature: meta.feature || 'unknown', analysisId };
    if (USE_ADVISOR && model.includes('sonnet') && !systemPrompt.includes('검토자')) {
      body.tools = (body.tools || []).concat([{
        type: 'advisor_20260301',
        name: 'advisor',
        model: 'claude-opus-4-6',
        max_uses: 1
      }]);
    }
    let res;
    try {
      res = await fetch('/api/claude', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: abortController ? abortController.signal : undefined,
        body: JSON.stringify(body),
      });
    } catch (e) {
      // Fix 4 (Q1): network-level failure (fetch throws TypeError, e.g. offline/DNS/reset).
      // AbortError isn't a TypeError so a user cancel still propagates immediately.
      if (e instanceof TypeError && attempt < MAX_RETRIES) {
        debugLog('API', `Network error — retry ${attempt+1}: ${e.message}`);
        await abortableSleep(2000);
        continue;
      }
      throw e;
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.error('[callClaudeOnce] API error', res.status, JSON.stringify(err));
      debugLog('API', `Error ${res.status}: ${JSON.stringify(err)}`);
      // Auto bug report on terminal (non-retry) backend errors — credit
      // balance, 401 key, 5xx. 429 is transient/expected and skipped.
      if (res.status !== 429) {
        try { window.reportAutoError?.('api', (err?.error?.message) || `API ${res.status}`, { status: res.status, endpoint: '/api/claude (once)' }); } catch (_) {}
      }
      if (res.status === 429) {
        if (attempt === MAX_RETRIES) throw new Error('API 한도 초과 — 잠시 후 다시 시도해주세요.');
        const waitSec = parseInt(res.headers.get('Retry-After') || '30', 10);
        debugLog('API', `429 rate limit — retry ${attempt+1}, waiting ${waitSec}s`);
        agentLog(0, `Rate limit hit — waiting ${waitSec}s… (시도 ${attempt}/${MAX_RETRIES})`);
        await abortableSleep(waitSec * 1000);
        continue;
      }
      // Fix 4 (Q1): retry once on transient 5xx, same backoff as network errors. Never retry 4xx.
      if (res.status >= 500 && attempt < MAX_RETRIES) {
        debugLog('API', `${res.status} server error — retry ${attempt+1}`);
        await abortableSleep(2000);
        continue;
      }
      if (res.status === 401) throw new Error('API 키가 유효하지 않습니다. 키를 확인해주세요.');
      throw new Error(err?.error?.message || `API 오류 (${res.status})`);
    }
    const data = await res.json();
    lastStopReason = data.stop_reason || null;
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
  lastStopReason = null;

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
    // B1: auto-inject — see callClaudeOnce above for rationale.
    analysisId: meta.analysisId
      || (typeof _currentAnalysisId !== 'undefined' ? _currentAnalysisId : null),
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
    try {
      response = await fetch('/api/claude', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: abortController ? abortController.signal : undefined,
        body: JSON.stringify(body),
      });
    } catch (e) {
      // Fix 4 (Q1): network-level failure — see callClaudeOnce for rationale.
      if (e instanceof TypeError && attempt < MAX_RETRIES) {
        debugLog('API', `Network error — retry ${attempt+1}: ${e.message}`);
        await abortableSleep(2000);
        continue;
      }
      throw e;
    }
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      console.error('[callClaudeStream] API error', response.status, JSON.stringify(err));
      debugLog('API', `Error ${response.status}: ${JSON.stringify(err)}`);
      // Auto bug report on terminal (non-retry) backend errors — credit
      // balance, 401 key, 5xx. 429 is transient/expected and skipped.
      if (response.status !== 429) {
        try { window.reportAutoError?.('api', (err?.error?.message) || `API ${response.status}`, { status: response.status, endpoint: '/api/claude (stream)' }); } catch (_) {}
      }
      if (response.status === 429) {
        if (attempt === MAX_RETRIES) throw new Error('API 한도 초과 — 잠시 후 다시 시도해주세요.');
        const waitSec = parseInt(response.headers.get('Retry-After') || '30', 10);
        agentLog(0, `Rate limit hit — waiting ${waitSec}s… (시도 ${attempt}/${MAX_RETRIES})`);
        await abortableSleep(waitSec * 1000);
        continue;
      }
      // Fix 4 (Q1): retry once on transient 5xx, same backoff as network errors.
      if (response.status >= 500 && attempt < MAX_RETRIES) {
        debugLog('API', `${response.status} server error — retry ${attempt+1}`);
        await abortableSleep(2000);
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

        let json;
        try { json = JSON.parse(data); } catch (_) { continue; /* ignore malformed SSE line */ }

        // Fix 2 (Q1): a mid-stream error event must abort the call, not vanish
        // into a debugLog line — the caller would otherwise treat a partial/
        // failed stream as a successful (truncated) note.
        if (json.type === 'error') {
          throw new Error(json.error?.message || 'stream error');
        } else if (json.type === 'content_block_delta' && json.delta?.type === 'text_delta') {
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
        } else if (json.type === 'message_delta') {
          // Fix 1 (Q1): stop_reason arrives here (e.g. 'max_tokens', 'end_turn').
          if (json.delta?.stop_reason) lastStopReason = json.delta.stop_reason;
        } else if (json.type === 'content_block_stop') {
          // silently ignore
        } else if (json.type !== 'message_start' && json.type !== 'message_stop' && json.type !== 'ping') {
          debugLog('SSE', `event type=${json.type} ${JSON.stringify(json).slice(0, 200)}`);
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }

  debugLog('API', `Stream complete ${fullText.length}chars`);
  dotEl.className = 'status-dot done';
  return fullText;
}
