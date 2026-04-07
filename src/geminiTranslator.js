/**
 * Translates between OpenAI Chat Completions format and Gemini generateContent format.
 * This allows Gemini to be used as a drop-in replacement for OpenAI APIs.
 */

/**
 * Convert an OpenAI chat/completions request body to a Gemini generateContent body.
 * @param {object} openaiBody - Parsed OpenAI request body
 * @returns {{ geminiBody: object, model: string }}
 */
function openaiToGemini(openaiBody) {
  const model = openaiBody.model || 'gemini-2.0-flash';

  // Convert messages to Gemini contents
  const contents = [];
  let systemInstruction = null;

  for (const msg of (openaiBody.messages || [])) {
    const role = msg.role;
    const content = msg.content;

    if (role === 'system') {
      // Gemini uses a separate systemInstruction field
      systemInstruction = {
        parts: [{ text: typeof content === 'string' ? content : extractText(content) }]
      };
      continue;
    }

    const geminiRole = role === 'assistant' ? 'model' : 'user';

    // Content can be a string or an array of content parts
    let parts;
    if (typeof content === 'string') {
      parts = [{ text: content }];
    } else if (Array.isArray(content)) {
      parts = content.map(part => {
        if (part.type === 'text') return { text: part.text };
        if (part.type === 'image_url') {
          // Handle base64 images
          const url = part.image_url && part.image_url.url;
          if (url && url.startsWith('data:')) {
            const [meta, data] = url.split(',');
            const mimeType = meta.replace('data:', '').replace(';base64', '');
            return { inlineData: { mimeType, data } };
          }
          return { text: '[image]' };
        }
        return { text: JSON.stringify(part) };
      });
    } else {
      parts = [{ text: String(content) }];
    }

    // Merge consecutive same-role messages (Gemini requires alternating roles)
    if (contents.length > 0 && contents[contents.length - 1].role === geminiRole) {
      contents[contents.length - 1].parts.push(...parts);
    } else {
      contents.push({ role: geminiRole, parts });
    }
  }

  const geminiBody = { contents };

  if (systemInstruction) {
    geminiBody.systemInstruction = systemInstruction;
  }

  // Generation config
  const generationConfig = {};
  if (openaiBody.max_tokens != null) generationConfig.maxOutputTokens = openaiBody.max_tokens;
  if (openaiBody.max_completion_tokens != null) generationConfig.maxOutputTokens = openaiBody.max_completion_tokens;
  if (openaiBody.temperature != null) generationConfig.temperature = openaiBody.temperature;
  if (openaiBody.top_p != null) generationConfig.topP = openaiBody.top_p;
  if (openaiBody.stop != null) {
    generationConfig.stopSequences = Array.isArray(openaiBody.stop) ? openaiBody.stop : [openaiBody.stop];
  }
  if (openaiBody.n != null) generationConfig.candidateCount = openaiBody.n;

  if (Object.keys(generationConfig).length > 0) {
    geminiBody.generationConfig = generationConfig;
  }

  return { geminiBody, model };
}

/**
 * Convert a Gemini generateContent response to an OpenAI chat completions response.
 * @param {object} geminiResponse - Parsed Gemini response body
 * @param {string} model - Model name to include in response
 * @param {boolean} streaming - Whether this is a streaming response
 * @returns {object} OpenAI-format response
 */
function geminiToOpenai(geminiResponse, model, streaming = false) {
  const id = 'chatcmpl-' + Math.random().toString(36).substring(2, 15);
  const created = Math.floor(Date.now() / 1000);

  const candidates = geminiResponse.candidates || [];
  const choices = candidates.map((candidate, index) => {
    const parts = (candidate.content && candidate.content.parts) || [];
    const text = parts.map(p => p.text || '').join('');

    const finishReason = mapFinishReason(candidate.finishReason);

    if (streaming) {
      return {
        index,
        delta: { role: 'assistant', content: text },
        finish_reason: finishReason
      };
    }

    return {
      index,
      message: { role: 'assistant', content: text },
      finish_reason: finishReason,
      logprobs: null
    };
  });

  // If no candidates, return empty choice
  if (choices.length === 0) {
    if (streaming) {
      choices.push({ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: 'stop' });
    } else {
      choices.push({ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop', logprobs: null });
    }
  }

  // Usage metadata
  const usageMeta = geminiResponse.usageMetadata || {};
  const usage = {
    prompt_tokens: usageMeta.promptTokenCount || 0,
    completion_tokens: usageMeta.candidatesTokenCount || 0,
    total_tokens: usageMeta.totalTokenCount || 0
  };

  if (streaming) {
    return {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices,
      usage
    };
  }

  return {
    id,
    object: 'chat.completion',
    created,
    model,
    choices,
    usage,
    system_fingerprint: null
  };
}

/**
 * Convert a Gemini streaming SSE chunk to an OpenAI streaming SSE chunk.
 * Gemini streams JSON arrays; OpenAI streams `data: {...}\n\n` lines.
 * @param {string} geminiChunk - Raw text chunk from Gemini stream
 * @param {string} model - Model name
 * @returns {string} OpenAI SSE formatted string (may be empty if chunk not parseable)
 */
function convertStreamChunk(geminiChunk, model) {
  // Gemini streams JSON — it may arrive in pieces. We try to extract complete JSON objects.
  const lines = geminiChunk.split('\n');
  let output = '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === '[' || trimmed === ']' || trimmed === ',') continue;

    // Remove leading comma if present (Gemini wraps in a JSON array)
    const jsonStr = trimmed.startsWith(',') ? trimmed.slice(1) : trimmed;

    try {
      const parsed = JSON.parse(jsonStr);
      const openaiChunk = geminiToOpenai(parsed, model, true);
      output += `data: ${JSON.stringify(openaiChunk)}\n\n`;
    } catch (e) {
      // Incomplete chunk — skip
    }
  }

  return output;
}

/**
 * Build a Gemini API URL for a given model and action.
 * @param {string} baseUrl - Gemini base URL (e.g. https://generativelanguage.googleapis.com/v1)
 * @param {string} model - Model name (e.g. gemini-2.0-flash)
 * @param {boolean} streaming - Whether to use streamGenerateContent
 * @returns {string}
 */
function buildGeminiUrl(baseUrl, model, streaming) {
  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const action = streaming ? 'streamGenerateContent?alt=sse' : 'generateContent';
  return `${base}/models/${model}:${action}`;
}

// --- Helpers ---

function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter(p => p.type === 'text').map(p => p.text).join('');
  }
  return '';
}

function mapFinishReason(geminiReason) {
  const map = {
    STOP: 'stop',
    MAX_TOKENS: 'length',
    SAFETY: 'content_filter',
    RECITATION: 'content_filter',
    OTHER: 'stop',
    FINISH_REASON_UNSPECIFIED: 'stop'
  };
  return map[geminiReason] || 'stop';
}

module.exports = {
  openaiToGemini,
  geminiToOpenai,
  convertStreamChunk,
  buildGeminiUrl
};