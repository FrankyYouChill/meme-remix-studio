import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(__dirname, "public");

loadEnvFile(join(__dirname, ".env"));

const port = Number(process.env.PORT || 3000);
const stepApiBaseUrl = process.env.STEP_API_BASE_URL || "https://api.stepfun.ai/step_plan/v1";
const stepChatApiBaseUrl = process.env.STEP_CHAT_API_BASE_URL || stepApiBaseUrl;
const imagePromptLimit = 512;
const captionLimit = 24;
const memeIdeasTimeoutMs = Number(process.env.MEME_IDEAS_TIMEOUT_MS || 10000);
const imageEditTimeoutMs = Number(process.env.IMAGE_EDIT_TIMEOUT_MS || 25000);

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

function logEvent(event, details = {}) {
  console.log(`[${new Date().toISOString()}] ${event}`, details);
}

function errorDetails(error) {
  return {
    name: error?.name,
    message: error instanceof Error ? error.message : String(error),
    code: error?.code,
    causeName: error?.cause?.name,
    causeMessage: error?.cause?.message,
    causeCode: error?.cause?.code,
  };
}

function createRequestId(prefix = "req") {
  const safePrefix = String(prefix).replace(/[^a-z0-9_-]/gi, "").slice(0, 24) || "req";
  return `${safePrefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function isRetryableStatus(statusCode) {
  return statusCode === 408 || statusCode === 409 || statusCode === 425 || statusCode === 429 ||
    statusCode >= 500;
}

function errorCodeForStatus(statusCode, fallbackCode) {
  if (statusCode === 400) return "invalid_request";
  if (statusCode === 401 || statusCode === 403) return "auth_error";
  if (statusCode === 408 || statusCode === 504) return "timeout";
  if (statusCode === 429) return "rate_limited";
  if (statusCode >= 500) return "upstream_error";
  return fallbackCode;
}

function upstreamErrorMessage(payload, fallback) {
  if (payload?.error?.message) return payload.error.message;
  if (payload?.message) return payload.message;
  if (typeof payload?.error === "string") return payload.error;
  return fallback;
}

function sendApiError(res, statusCode, options) {
  sendJson(res, statusCode, {
    error: options.error,
    code: options.code || errorCodeForStatus(statusCode, "request_failed"),
    retryable: options.retryable ?? isRetryableStatus(statusCode),
    requestId: options.requestId,
    latencyMs: options.latencyMs,
  });
}

async function fetchJsonWithTimeout(url, options, timeoutMs, label = "Request") {
  const controller = new AbortController();
  let didTimeout = false;
  const startedAt = performance.now();
  const timeout = setTimeout(() => {
    didTimeout = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    const headersLatencyMs = Math.round(performance.now() - startedAt);
    const bodyText = await response.text();
    const totalLatencyMs = Math.round(performance.now() - startedAt);
    const payload = bodyText ? parseJsonPayload(bodyText) : null;

    return {
      response,
      payload,
      timing: {
        headersLatencyMs,
        bodyLatencyMs: totalLatencyMs - headersLatencyMs,
        totalLatencyMs,
        bodyBytes: Buffer.byteLength(bodyText || "", "utf8"),
      },
    };
  } catch (error) {
    if (didTimeout && error?.name === "AbortError") {
      const timeoutError = new Error(
        `${label} timed out after ${Math.round(timeoutMs / 1000)} seconds.`,
      );
      timeoutError.name = "TimeoutError";
      timeoutError.cause = error;
      throw timeoutError;
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function parseJsonPayload(bodyText) {
  try {
    return JSON.parse(bodyText);
  } catch {
    return null;
  }
}

function loadEnvFile(filePath) {
  try {
    const envFile = readFileSync(filePath, "utf8");

    for (const line of envFile.split(/\r?\n/)) {
      const trimmed = line.trim();

      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }

      const separatorIndex = trimmed.indexOf("=");

      if (separatorIndex === -1) {
        continue;
      }

      const key = trimmed.slice(0, separatorIndex).trim();
      const rawValue = trimmed.slice(separatorIndex + 1).trim();
      const value = rawValue.replace(/^["']|["']$/g, "");

      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch {
    // .env is optional. Shell-provided environment variables still work.
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 12 * 1024 * 1024) {
        req.destroy();
        reject(new Error("Request body is too large."));
      }
    });

    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        reject(new Error("Invalid JSON body."));
      }
    });

    req.on("error", reject);
  });
}

function base64ToBuffer(dataUrlOrBase64) {
  const base64 = dataUrlOrBase64.includes(",")
    ? dataUrlOrBase64.split(",").pop()
    : dataUrlOrBase64;

  return Buffer.from(base64, "base64");
}

function pickImageBase64(payload) {
  const firstImage = payload?.data?.[0];
  return firstImage?.b64_json || firstImage?.b64 || firstImage?.image || null;
}

function normalizeWhitespace(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function limitText(text, limit) {
  const normalized = normalizeWhitespace(text);

  if (normalized.length <= limit) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, limit - 3)).trim()}...`;
}

function limitImagePrompt(prompt) {
  return limitText(prompt, imagePromptLimit);
}

function limitCaption(caption) {
  return limitText(caption, captionLimit);
}

function parseMemeIdeas(text, count) {
  const normalized = text
    .replace(/\r\n/g, "\n")
    .replace(/```(?:json|text)?/gi, "")
    .replace(/```/g, "")
    .trim();

  const jsonIdeas = parseJsonMemeIdeas(normalized, count);

  if (jsonIdeas.length) {
    return jsonIdeas;
  }

  const titlePattern = /(?:^|\n)\s*(?:\d+[\.)]\s*)?\*{0,2}TITLE\*{0,2}:\s*(.+)/gim;
  const titleMatches = [...normalized.matchAll(titlePattern)];

  if (!titleMatches.length) {
    return parseLooseMemeIdeas(normalized, count);
  }

  const structuredIdeas = titleMatches
    .map((match, index) => {
      const blockStart = match.index ?? 0;
      const nextBlockStart = titleMatches[index + 1]?.index ?? normalized.length;
      const block = normalized.slice(blockStart, nextBlockStart).trim();

      const title =
        block.match(/(?:^|\n)\s*(?:\d+[\.)]\s*)?\*{0,2}TITLE\*{0,2}:\s*(.+)/im)?.[1]?.trim() ||
        "Meme variant";
      const caption =
        block.match(/(?:^|\n)\s*\*{0,2}CAPTION\*{0,2}:\s*(.+)/im)?.[1]?.trim() || "";
      const promptMatch = block.match(/(?:^|\n)\s*\*{0,2}PROMPT\*{0,2}:\s*([\s\S]*)/im);
      const prompt = promptMatch?.[1]
        ?.replace(/\n-{3,}\s*$/m, "")
        .replace(/\n\s*(?:Wait|Let's|Check if|Make sure)[\s\S]*$/im, "")
        .replace(/\n\s*(?:\d+[\.)]\s*)?\*{0,2}TITLE\*{0,2}:[\s\S]*$/im, "")
        .trim();

      if (!prompt) {
        return null;
      }

      return { title, caption, prompt };
    })
    .filter(Boolean)
    .slice(0, count);

  if (structuredIdeas.length >= count) {
    return structuredIdeas;
  }

  const looseIdeas = parseLooseMemeIdeas(normalized, count);
  const mergedIdeas = [...structuredIdeas];

  for (const idea of looseIdeas) {
    if (mergedIdeas.length >= count) {
      break;
    }

    if (!mergedIdeas.some((existingIdea) => existingIdea.prompt === idea.prompt)) {
      mergedIdeas.push(idea);
    }
  }

  return mergedIdeas.slice(0, count);
}

function parseLooseMemeIdeas(text, count) {
  const promptPattern = /\b\*{0,2}PROMPT\*{0,2}:\s*/gi;
  const matches = [...text.matchAll(promptPattern)];

  return matches
    .map((match, index) => {
      const promptStart = (match.index ?? 0) + match[0].length;
      const promptEnd = matches[index + 1]?.index ?? text.length;
      const prompt = cleanLoosePrompt(text.slice(promptStart, promptEnd));

      if (!prompt) {
        return null;
      }

      return {
        title: pickLooseTitle(text.slice(Math.max(0, (match.index ?? 0) - 220), match.index)) ||
          `Meme variant ${index + 1}`,
        caption: "",
        prompt,
      };
    })
    .filter(Boolean)
    .slice(0, count);
}

function cleanLoosePrompt(prompt) {
  return normalizeWhitespace(prompt)
    .replace(/\b(?:Wait|Let's|Check|Make sure|Oh right|Oh that's|Yep|Perfect)\b[\s\S]*$/i, "")
    .replace(/\b(?:First|Second|Third|Fourth|Fifth)\s+(?:one|title)\b[\s\S]*$/i, "")
    .replace(/\bTITLE\s*:[\s\S]*$/i, "")
    .replace(/^["“”']|["“”']$/g, "")
    .trim();
}

function pickLooseTitle(text) {
  const matches = [...text.matchAll(/\b\*{0,2}TITLE\*{0,2}:\s*["“”']?([^.\n"“”']+)/gi)];
  const title = matches.pop()?.[1];

  return title ? limitText(title, 48) : "";
}

function parseJsonMemeIdeas(text, count) {
  try {
    const jsonText = text.match(/\[[\s\S]*\]/)?.[0] || text.match(/\{[\s\S]*\}/)?.[0];

    if (!jsonText) {
      return [];
    }

    const parsed = JSON.parse(jsonText);
    const items = Array.isArray(parsed) ? parsed : parsed.ideas || parsed.variants || [];

    if (!Array.isArray(items)) {
      return [];
    }

    return items
      .map((item) => {
        const prompt = item.prompt || item.edit_prompt || item.image_prompt || "";

        if (!prompt) {
          return null;
        }

        return {
          title: item.title || item.name || "Meme variant",
          caption: item.caption || "",
          prompt,
        };
      })
      .filter(Boolean)
      .slice(0, count);
  } catch {
    return [];
  }
}

function pickMemeIdeasFromMessage(message, count) {
  const content = message.content || "";
  const reasoning = message.reasoning || "";
  const contentIdeas = parseMemeIdeas(content, count);

  if (contentIdeas.length >= count) {
    return {
      ideas: contentIdeas,
      raw: content,
      source: "content",
    };
  }

  const reasoningIdeas = parseMemeIdeas(reasoning, count);

  if (reasoningIdeas.length >= count) {
    return {
      ideas: reasoningIdeas,
      raw: reasoning,
      source: "reasoning",
    };
  }

  const combined = [content, reasoning].filter(Boolean).join("\n---\n");
  const combinedIdeas = parseMemeIdeas(combined, count);

  return {
    ideas: combinedIdeas.length > contentIdeas.length ? combinedIdeas : contentIdeas,
    raw: combined || content,
    source: combinedIdeas.length > contentIdeas.length ? "combined" : "content",
  };
}

function removeTextRenderingCues(prompt) {
  return normalizeWhitespace(prompt)
    .replace(/\b(?:speech|dialogue|thought|chat|message)\s+bubbles?\b/gi, "visual reaction elements")
    .replace(/\b(?:text|caption|subtitle|subtitles|letters?|words?|labels?|signs?|stickers?)\b/gi, "visual details")
    .replace(/\b(?:phone|screen|monitor|whiteboard|poster|banner|sign)\s+(?:showing|saying|reading|with)\b/gi, "$1 without readable text")
    .replace(/["“”][^"“”]{1,80}["“”]/g, "");
}

function prepareMemeIdea(idea) {
  const visualPrompt = removeTextRenderingCues(idea.prompt);

  return {
    ...idea,
    caption: "",
    prompt: limitImagePrompt(
      `Keep the main subject from the image. ${visualPrompt} Use visual expressions and scene changes only. No readable text anywhere. No speech bubbles, chat bubbles, signs, labels, subtitles, captions, logos, or UI text.`,
    ),
  };
}

async function handleMemeIdeas(req, res) {
  const requestId = createRequestId("ideas");

  if (!process.env.STEP_API_KEY) {
    sendApiError(res, 500, {
      error: "Missing STEP_API_KEY. Add it to your environment before starting the server.",
      code: "config_error",
      retryable: false,
      requestId,
    });
    return;
  }

  try {
    const body = await readJson(req);
    const theme = String(body.theme || "").trim();
    const count = Number(body.count) === 4 ? 4 : 2;

    if (!theme) {
      sendApiError(res, 400, {
        error: "Theme is required.",
        code: "invalid_request",
        retryable: false,
        requestId,
      });
      return;
    }

    logEvent("meme-ideas:start", {
      requestId,
      model: "step-3.5-flash",
      url: `${stepChatApiBaseUrl}/chat/completions`,
      theme,
      count,
    });

    const userPrompt = [
      `Return exactly ${count} concise image-editing meme ideas for theme: "${theme}".`,
      "Preserve the uploaded main subject. Use visual comedy: pose, expression, props, lighting, background action.",
      "Do not include visible text in the image prompt; the app may add text later.",
      "Return valid JSON only, with no prose, no markdown, no reasoning.",
      'Schema: [{"title":"short title","prompt":"Keep the main subject from the image. visual edit under 120 chars"}]',
    ].join("\n");

    const startedAt = performance.now();
    const { response, payload, timing } = await fetchJsonWithTimeout(
      `${stepChatApiBaseUrl}/chat/completions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.STEP_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "step-3.5-flash",
          messages: [
            {
              role: "system",
              content:
                "You create concise visual prompts for image editing. Return final JSON only. Do not include analysis or commentary.",
            },
            {
              role: "user",
              content: userPrompt,
            },
          ],
          max_tokens: count === 4 ? 520 : 300,
          stream: false,
        }),
      },
      memeIdeasTimeoutMs,
      "StepFun meme ideas",
    );
    const latencyMs = Math.round(performance.now() - startedAt);
    logEvent("meme-ideas:response", {
      requestId,
      status: response.status,
      latencyMs,
      ...timing,
    });

    if (!response.ok) {
      const error = upstreamErrorMessage(payload, "StepFun chat completion failed.");
      logEvent("meme-ideas:error", {
        requestId,
        status: response.status,
        latencyMs,
        error,
      });
      sendApiError(res, response.status, {
        error,
        code: errorCodeForStatus(response.status, "meme_ideas_upstream_error"),
        retryable: isRetryableStatus(response.status),
        requestId,
        latencyMs,
      });
      return;
    }

    const message = payload?.choices?.[0]?.message || {};
    const result = pickMemeIdeasFromMessage(message, count);
    const generatedIdeas = result.ideas.map((idea, index) => ({
      ...prepareMemeIdea(idea),
      source: result.source,
      variant: index + 1,
    }));

    if (generatedIdeas.length < count) {
      logEvent("meme-ideas:parse-error", {
        requestId,
        expected: count,
        parsed: generatedIdeas.length,
        rawSource: result.source,
      });
      sendApiError(res, 502, {
        error: `step-3.5-flash returned ${generatedIdeas.length}/${count} usable meme ideas.`,
        code: "meme_ideas_parse_error",
        retryable: true,
        requestId,
        latencyMs,
      });
      return;
    }

    generatedIdeas.sort((a, b) => a.variant - b.variant);

    logEvent("meme-ideas:done", {
      requestId,
      requested: count,
      returned: generatedIdeas.slice(0, count).length,
      source: result.source,
      latencyMs,
      promptLengths: generatedIdeas.slice(0, count).map((idea) => idea.prompt.length),
    });

    sendJson(res, 200, {
      ideas: generatedIdeas.slice(0, count),
      source: result.source,
      latencyMs,
      requestId,
    });
  } catch (error) {
    logEvent("meme-ideas:exception", {
      requestId,
      ...errorDetails(error),
      url: `${stepChatApiBaseUrl}/chat/completions`,
    });
    sendApiError(res, error?.name === "TimeoutError" ? 504 : 500, {
      error: error instanceof Error ? error.message : "Unexpected server error.",
      code: error?.name === "TimeoutError" ? "timeout" : "meme_ideas_exception",
      retryable: true,
      requestId,
    });
  }
}

async function handleEditImage(req, res) {
  const requestId = createRequestId("edit");

  if (!process.env.STEP_API_KEY) {
    sendApiError(res, 500, {
      error: "Missing STEP_API_KEY. Add it to your environment before starting the server.",
      code: "config_error",
      retryable: false,
      requestId,
    });
    return;
  }

  try {
    const body = await readJson(req);
    const { imageBase64, mimeType, seed } = body;
    const variantId = String(body.variantId || "");
    const textMode = body.textMode === true;
    const prompt = limitImagePrompt(body.prompt);

    if (!imageBase64 || !prompt) {
      sendApiError(res, 400, {
        error: "Both imageBase64 and prompt are required.",
        code: "invalid_request",
        retryable: false,
        requestId,
      });
      return;
    }

    const imageBuffer = base64ToBuffer(imageBase64);

    logEvent("image-edit:start", {
      requestId,
      variantId,
      model: "step-image-edit-2",
      seed: seed ?? 1,
      textMode,
      mimeType: mimeType || "image/png",
      promptLength: prompt.length,
      imageBytes: imageBuffer.length,
    });

    const imageBlob = new Blob([imageBuffer], {
      type: mimeType || "image/png",
    });

    const formData = new FormData();
    formData.append("model", "step-image-edit-2");
    formData.append("image", imageBlob, "input.png");
    formData.append("prompt", prompt);
    formData.append("response_format", "b64_json");
    formData.append("cfg_scale", "1.0");
    formData.append("steps", "8");
    formData.append("seed", String(seed ?? 1));

    if (textMode) {
      formData.append("text_mode", "true");
    }

    const startedAt = performance.now();
    const { response, payload, timing } = await fetchJsonWithTimeout(
      `${stepApiBaseUrl}/images/edits`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.STEP_API_KEY}`,
        },
        body: formData,
      },
      imageEditTimeoutMs,
      "StepFun image edit",
    );
    const latencyMs = Math.round(performance.now() - startedAt);
    logEvent("image-edit:response", {
      requestId,
      variantId,
      status: response.status,
      latencyMs,
      ...timing,
      seed: seed ?? 1,
    });

    if (!response.ok) {
      const error = upstreamErrorMessage(payload, "StepFun API request failed.");
      logEvent("image-edit:error", {
        requestId,
        variantId,
        status: response.status,
        latencyMs,
        error,
      });
      sendApiError(res, response.status, {
        error,
        code: errorCodeForStatus(response.status, "image_edit_upstream_error"),
        retryable: isRetryableStatus(response.status),
        requestId,
        latencyMs,
      });
      return;
    }

    const resultBase64 = pickImageBase64(payload);

    if (!resultBase64) {
      logEvent("image-edit:error", {
        requestId,
        variantId,
        status: 502,
        latencyMs,
        error: "StepFun API did not return a b64_json image.",
      });
      sendApiError(res, 502, {
        error: "StepFun API did not return a b64_json image.",
        code: "missing_image_output",
        retryable: true,
        requestId,
        latencyMs,
      });
      return;
    }

    logEvent("image-edit:done", {
      requestId,
      variantId,
      latencyMs,
      seed: seed ?? 1,
      outputChars: resultBase64.length,
    });

    sendJson(res, 200, {
      imageUrl: `data:image/png;base64,${resultBase64}`,
      latencyMs,
      requestId,
    });
  } catch (error) {
    logEvent("image-edit:exception", {
      requestId,
      ...errorDetails(error),
    });
    sendApiError(res, error?.name === "TimeoutError" ? 504 : 500, {
      error: error instanceof Error ? error.message : "Unexpected server error.",
      code: error?.name === "TimeoutError" ? "timeout" : "image_edit_exception",
      retryable: true,
      requestId,
    });
  }
}

async function serveStatic(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = normalize(join(publicDir, requestedPath));

  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const file = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream",
    });
    res.end(file);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
  });
  res.end(JSON.stringify(payload));
}

const server = createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/api/edit-image") {
    await handleEditImage(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/meme-ideas") {
    await handleMemeIdeas(req, res);
    return;
  }

  if (req.method === "GET" || req.method === "HEAD") {
    await serveStatic(req, res);
    return;
  }

  res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Method not allowed");
});

server.listen(port, () => {
  console.log(`Meme Remix Studio running at http://localhost:${port}`);
});
