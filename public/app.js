const imageInput = document.querySelector("#imageInput");
const previewWrap = document.querySelector("#previewWrap");
const previewImage = document.querySelector("#previewImage");
const modeSelect = document.querySelector("#modeSelect");
const variantCountField = document.querySelector("#variantCountField");
const variantCount = document.querySelector("#variantCount");
const ideaField = document.querySelector("#ideaField");
const ideaLabel = document.querySelector("#ideaLabel");
const ideaInput = document.querySelector("#ideaInput");
const presetRow = document.querySelector("#presetRow");
const generateButton = document.querySelector("#generateButton");
const statusText = document.querySelector("#statusText");
const resultsGrid = document.querySelector("#resultsGrid");
const resultsTitle = document.querySelector("#resultsTitle");
const clearButton = document.querySelector("#clearButton");
const resultCardTemplate = document.querySelector("#resultCardTemplate");

let uploadedImage = null;
let isGenerating = false;
let selectedVariantText = "";
let activeVariantRunId = 0;
let variantStates = [];

const imageEditConcurrency = 2;
const imageEditMaxAttempts = 2;
const imageEditConcurrencyForFour = 3;
const retryDelayMs = 700;
const retryJitterMs = 450;
const uploadMaxDimension = 896;
const memeIdeasClientTimeoutMs = 12000;
const imageEditClientTimeoutMs = 32000;

const presets = {
  single: [
    "Make the background sunset.",
    "Add cool sunglasses.",
    "Turn this into a clean sticker.",
    "Make it cinematic.",
  ],
  variants: [
    "startup chaos",
    "developer life",
    "Monday morning",
    "group chat energy",
    "AI launch day",
    "founder mode",
    "office politics",
    "product demo panic",
    "design review",
    "API outage",
    "gaming rage",
    "dating app energy",
    "coffee addiction",
    "finals week",
    "main character moment",
    "meeting that should be an email",
  ],
  caption: [
    "Works locally.",
    "This is fine.",
    "Ship it.",
    "Send help.",
    "Bug found.",
  ],
};

const modeCopy = {
  single: {
    title: "Speed edit result",
    label: "Fast edit instruction",
    button: "Run speed edit",
    placeholder: "Add cool sunglasses.",
  },
  variants: {
    title: "Meme variants",
    label: "Theme",
    button: "Generate variants",
    placeholder: "startup chaos",
  },
  caption: {
    title: "Caption challenge",
    label: "Caption text",
    button: "Add caption",
    placeholder: "POV: the demo works locally.",
  },
};

async function prepareImageForUpload(file) {
  const sourceUrl = URL.createObjectURL(file);

  try {
    const image = await loadImage(sourceUrl);
    const scale = Math.min(1, uploadMaxDimension / Math.max(image.naturalWidth, image.naturalHeight));
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext("2d");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);

    return {
      dataUrl: canvas.toDataURL("image/jpeg", 0.88),
      type: "image/jpeg",
    };
  } finally {
    URL.revokeObjectURL(sourceUrl);
  }
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = url;
  });
}

function limitText(text, limit) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();

  if (normalized.length <= limit) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, limit - 3)).trim()}...`;
}

function setStatus(message) {
  statusText.textContent = message;
}

class ApiRequestError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "ApiRequestError";
    this.status = options.status;
    this.code = options.code || "request_failed";
    this.retryable = options.retryable !== false;
    this.requestId = options.requestId || "";
    this.latencyMs = options.latencyMs;
  }
}

function isRetryableStatus(status) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function isRetryableError(error) {
  if (error instanceof ApiRequestError) {
    return error.retryable;
  }

  return true;
}

function friendlyErrorMessage(error) {
  if (error instanceof ApiRequestError) {
    if (error.code === "client_timeout" || error.code === "timeout") {
      return "This variant timed out. Retry just this slot.";
    }

    if (error.status === 429) {
      return "The API is rate-limiting requests. Retry this slot in a moment.";
    }

    if (error.status >= 500) {
      return "The image API had a temporary issue. Retry this slot.";
    }
  }

  return error instanceof Error ? error.message : "This variant failed. Retry this slot.";
}

async function fetchJsonWithTimeout(url, options, timeoutMs, label) {
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
    const payload = await response.json().catch(() => null);
    const latencyMs = Math.round(performance.now() - startedAt);

    if (!response.ok) {
      throw new ApiRequestError(payload?.error || `${label} failed.`, {
        status: response.status,
        code: payload?.code || (response.status === 504 ? "timeout" : "upstream_error"),
        retryable: payload?.retryable ?? isRetryableStatus(response.status),
        requestId: payload?.requestId,
        latencyMs: payload?.latencyMs ?? latencyMs,
      });
    }

    return payload || {};
  } catch (error) {
    if (didTimeout && error?.name === "AbortError") {
      throw new ApiRequestError(`${label} took too long.`, {
        code: "client_timeout",
        retryable: true,
        latencyMs: Math.round(performance.now() - startedAt),
      });
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function setGenerating(nextState) {
  isGenerating = nextState;
  generateButton.disabled = nextState || !uploadedImage;

  if (variantStates.length) {
    renderVariantCards();
  }
}

function clearResults() {
  activeVariantRunId += 1;
  variantStates = [];
  resultsGrid.innerHTML = `
    <div class="empty-state">
      <strong>Ready for a meme sprint.</strong>
      <span>Results appear one by one as each variant finishes.</span>
    </div>
  `;
  resultsGrid.classList.add("empty");
}

function showDebugPanel(title, payload) {
  if (resultsGrid.classList.contains("empty")) {
    resultsGrid.innerHTML = "";
    resultsGrid.classList.remove("empty");
  }

  const debugCard = document.createElement("article");
  debugCard.className = "result-card debug-card";
  debugCard.innerHTML = `
    <div class="debug-header">
      <span class="latency-badge">Debug</span>
      <strong></strong>
    </div>
    <pre></pre>
  `;
  debugCard.querySelector("strong").textContent = title;
  debugCard.querySelector("pre").textContent = JSON.stringify(payload, null, 2);
  resultsGrid.prepend(debugCard);
}

function createVariantState(index) {
  return {
    index,
    label: `Variant ${index + 1}`,
    status: "queued",
    message: "Waiting for prompt...",
    prompt: "",
    caption: "",
    imageUrl: "",
    latencyMs: null,
    attempts: 0,
    retryable: false,
    textMode: false,
  };
}

function initializeVariantStates(count) {
  variantStates = Array.from({ length: count }, (_, index) => createVariantState(index));
  renderVariantCards();
}

function setVariantState(index, patch) {
  if (!variantStates[index]) {
    return;
  }

  variantStates[index] = {
    ...variantStates[index],
    ...patch,
  };
  renderVariantCards();
}

function renderVariantCards() {
  if (!variantStates.length) {
    return;
  }

  resultsGrid.classList.remove("empty");
  resultsGrid.innerHTML = "";
  variantStates.forEach((state) => {
    resultsGrid.append(createVariantCard(state));
  });
}

function createVariantCard(state) {
  const card = document.createElement("article");
  card.className = `result-card variant-card is-${state.status}`;

  const imageWrap = document.createElement("div");
  imageWrap.className = "result-image-wrap";

  if (state.status === "done" && state.imageUrl) {
    const image = document.createElement("img");
    image.className = "result-image";
    image.alt = `${state.label} result`;
    image.src = state.imageUrl;
    imageWrap.append(image);

    const caption = document.createElement("div");
    caption.className = "result-caption";
    caption.textContent = state.caption || "";
    caption.hidden = !state.caption;
    imageWrap.append(caption);
  } else {
    const placeholder = document.createElement("div");
    placeholder.className = "variant-placeholder";
    const spinner = document.createElement("span");
    spinner.className = "variant-spinner";
    spinner.hidden = state.status === "failed";
    const title = document.createElement("strong");
    title.textContent = state.label;
    const message = document.createElement("span");
    message.textContent = state.message;

    placeholder.append(spinner);
    placeholder.append(title);
    placeholder.append(message);
    imageWrap.append(placeholder);
  }

  const meta = document.createElement("div");
  meta.className = "result-meta variant-meta";

  const status = document.createElement("span");
  status.className = "variant-status";
  status.textContent = variantStatusText(state);
  meta.append(status);

  if (state.status === "done" && state.imageUrl) {
    const downloadLink = document.createElement("a");
    downloadLink.className = "download-link";
    downloadLink.download = `meme-remix-${state.index + 1}.png`;
    downloadLink.href = state.imageUrl;
    downloadLink.textContent = "Download";
    meta.append(downloadLink);
  }

  if (state.status === "failed" && state.retryable) {
    const retryButton = document.createElement("button");
    retryButton.type = "button";
    retryButton.className = "retry-button";
    retryButton.textContent = "Retry";
    retryButton.disabled = isGenerating;
    retryButton.addEventListener("click", () => {
      retryVariant(state.index);
    });
    meta.append(retryButton);
  }

  const details = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = state.status === "failed" ? "Failure details" : "Prompt used";
  const promptText = document.createElement("p");
  promptText.className = "prompt-text";
  promptText.textContent = state.status === "failed" ? state.message : state.prompt || "Prompt pending.";
  details.append(summary);
  details.append(promptText);

  card.append(imageWrap);
  card.append(meta);
  card.append(details);

  return card;
}

function variantStatusText(state) {
  if (state.status === "done") {
    return "Ready";
  }

  if (state.status === "retrying") {
    return `Retrying ${state.attempts}/${imageEditMaxAttempts}`;
  }

  if (state.status === "rendering") {
    return "Rendering";
  }

  if (state.status === "failed") {
    return state.retryable ? "Failed, retryable" : "Failed";
  }

  return "Queued";
}

function updateVariantSummary() {
  if (!variantStates.length) {
    return;
  }

  const total = variantStates.length;
  const done = variantStates.filter((state) => state.status === "done").length;
  const failed = variantStates.filter((state) => state.status === "failed").length;
  const pending = total - done - failed;

  if (pending > 0) {
    setStatus(`Images: ${done}/${total} ready. ${pending} still rendering.`);
    return;
  }

  setStatus(
    failed > 0
      ? `${done}/${total} variants ready. ${failed} failed; retry failed slots.`
      : `${done}/${total} variants ready.`,
  );
}

function renderPresets() {
  const mode = modeSelect.value;
  presetRow.innerHTML = "";
  presetRow.classList.toggle("is-list", mode === "variants");

  if (mode === "variants") {
    const themeLabel = document.createElement("label");
    themeLabel.className = "preset-label";
    themeLabel.setAttribute("for", "variantThemeSelect");
    themeLabel.textContent = "Visual meme theme";

    const themeSelect = document.createElement("select");
    themeSelect.id = "variantThemeSelect";
    themeSelect.className = "theme-list";
    themeSelect.setAttribute("aria-label", "Visual meme theme list");

    presets.variants.forEach((preset) => {
      const option = document.createElement("option");
      option.value = preset;
      option.textContent = preset;
      themeSelect.append(option);
    });

    themeSelect.value = presets.variants.includes(ideaInput.value) ? ideaInput.value : presets.variants[0];
    ideaInput.value = themeSelect.value;
    themeSelect.addEventListener("change", () => {
      ideaInput.value = themeSelect.value;
    });

    const captionLabel = document.createElement("label");
    captionLabel.className = "preset-label";
    captionLabel.setAttribute("for", "variantCaptionInput");
    captionLabel.textContent = "Caption text";

    const captionInput = document.createElement("textarea");
    captionInput.id = "variantCaptionInput";
    captionInput.rows = 4;
    captionInput.maxLength = 40;
    captionInput.placeholder = "Type custom caption text, or leave blank for no text rendering.";
    captionInput.value = selectedVariantText;
    captionInput.addEventListener("input", () => {
      selectedVariantText = captionInput.value.trim();
      syncVariantCopy();
    });

    const captionPresetRow = document.createElement("div");
    captionPresetRow.className = "caption-preset-row";

    presets.caption.forEach((preset) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = preset;
      button.addEventListener("click", () => {
        selectedVariantText = preset;
        captionInput.value = preset;
        syncVariantCopy();
      });
      captionPresetRow.append(button);
    });

    presetRow.append(themeLabel);
    presetRow.append(themeSelect);
    presetRow.append(captionLabel);
    presetRow.append(captionInput);
    presetRow.append(captionPresetRow);
    return;
  }

  presets[mode].forEach((preset) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = preset.length > 26 ? `${preset.slice(0, 26)}...` : preset;
    button.title = preset;
    button.addEventListener("click", () => {
      ideaInput.value = preset;
    });
    presetRow.append(button);
  });
}

function getVariantCount() {
  return Number(variantCount.value) === 4 ? 4 : 2;
}

function syncVariantCopy() {
  if (modeSelect.value !== "variants") {
    return;
  }

  const count = getVariantCount();
  const label = selectedVariantText.trim() ? "text-rendered meme variants" : "meme variants";
  generateButton.textContent = `Generate ${count} variants`;
  resultsTitle.textContent = `${count} ${label}`;
}

function syncModeUi() {
  const mode = modeSelect.value;
  const copy = modeCopy[mode];

  resultsTitle.textContent = copy.title;
  ideaLabel.textContent = copy.label;
  ideaInput.placeholder = copy.placeholder;
  generateButton.textContent = copy.button;
  variantCountField.hidden = mode !== "variants";
  ideaField.hidden = mode === "variants";
  selectedVariantText = "";
  ideaInput.value = presets[mode][0];
  renderPresets();
  syncVariantCopy();
}

function buildSinglePrompt(idea) {
  return [
    "Keep the main subject unchanged.",
    limitText(idea, 120),
  ].join(" ");
}

function buildCaptionPrompt(caption) {
  const shortCaption = limitText(caption, 24);

  return [
    "Keep the image composition and main subject.",
    `Naturally integrate the exact readable caption "${shortCaption}" into the scene.`,
    "Choose a placement that fits the image, such as a sign, sticker, poster, screen, speech bubble, or meme text.",
    "Keep the text crisp and readable without covering the main subject.",
  ].join(" ");
}

function removeTextFreeConstraints(prompt) {
  return String(prompt || "")
    .replace(/\s*No readable text anywhere\./gi, "")
    .replace(
      /\s*No speech bubbles, chat bubbles, signs, labels, subtitles, captions, logos, or UI text\./gi,
      "",
    )
    .replace(/\s*No captions?, signs, or readable text\./gi, "")
    .replace(/\s*No captions?, labels, signs, or readable text\./gi, "")
    .replace(/\s*no readable text\.?/gi, "")
    .replace(/\s*without readable text/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function addTextRenderingToVariantPrompt(prompt, caption, index) {
  const shortCaption = limitText(caption, 24);
  const templates = [
    `Naturally integrate the exact readable caption "${shortCaption}" into the scene as meme text that fits the composition.`,
    `Place the exact readable caption "${shortCaption}" on an object that belongs in the image, such as a sign, poster, or screen.`,
    `Add a clean speech bubble containing exactly "${shortCaption}" with crisp readable lettering, positioned naturally near the subject.`,
    `Add "${shortCaption}" as a readable sticker-style detail that feels physically part of the image, not a flat overlay.`,
  ];
  const visualPrompt = removeTextFreeConstraints(prompt);
  const textPrompt = templates[index % templates.length];

  return limitText(`${visualPrompt} ${textPrompt}`, 512);
}

function buildVariantPrompts(theme, count) {
  const normalizedTheme = theme.trim() || "startup chaos";

  const templates = [
    {
      label: "Reaction",
      prompt: `Keep the main subject from the image. Turn this into a dramatic visual reaction about ${normalizedTheme}. Use expressive body language, cinematic lighting, no readable text.`,
    },
    {
      label: "Office chaos",
      prompt: `Keep the main subject from the image. Turn the background into chaotic office energy about ${normalizedTheme}. Use props and facial expressions only, no readable text.`,
    },
    {
      label: "Deadline panic",
      prompt: `Keep the main subject from the image. Turn this into deadline panic about ${normalizedTheme}. Add motion, messy props, dramatic lighting, no readable text.`,
    },
    {
      label: "Victory lap",
      prompt: `Keep the main subject from the image. Turn this into a triumphant but slightly cursed visual scene about ${normalizedTheme}. No captions, signs, or readable text.`,
    },
    {
      label: "Social chaos",
      prompt: `Keep the main subject from the image. Turn this into social chaos about ${normalizedTheme}. Use people reacting in the background, no bubbles, no screens, no readable text.`,
    },
    {
      label: "Overthinking",
      prompt: `Keep the main subject from the image. Turn this into an overthinking scene about ${normalizedTheme}. Use visual clutter and dramatic expression, no readable text.`,
    },
    {
      label: "Plot twist",
      prompt: `Keep the main subject from the image. Turn this into a dramatic plot twist scene about ${normalizedTheme}. Use lighting and reactions, no readable text.`,
    },
    {
      label: "Main character",
      prompt: `Keep the main subject from the image. Turn this into a cinematic main character moment about ${normalizedTheme}. No captions, labels, signs, or readable text.`,
    },
  ];

  return templates.slice(0, count);
}

async function generateCreativeVariantPrompts(theme, count) {
  const payload = await fetchJsonWithTimeout("/api/meme-ideas", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      theme,
      count,
    }),
  }, memeIdeasClientTimeoutMs, "Meme idea generation");

  if (!Array.isArray(payload.ideas) || payload.ideas.length < count) {
    console.error("AI creative director debug payload:", payload);
    throw new ApiRequestError(
      payload.error ||
        "step-3.5-flash did not return enough usable meme ideas. Try a more specific theme.",
      {
        code: payload.code || "meme_ideas_parse_error",
        retryable: true,
        requestId: payload.requestId,
        latencyMs: payload.latencyMs,
      },
    );
  }

  return payload.ideas.slice(0, count).map((idea) => ({
    label: idea.title || "AI idea",
    prompt: idea.prompt,
  }));
}

async function editImage(prompt, seed, options = {}) {
  const startedAt = performance.now();
  const payload = await fetchJsonWithTimeout("/api/edit-image", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      imageBase64: uploadedImage.dataUrl,
      mimeType: uploadedImage.type,
      prompt,
      seed,
      textMode: options.textMode === true,
      variantId: options.variantId,
    }),
  }, options.timeoutMs || imageEditClientTimeoutMs, "Image edit");

  return {
    imageUrl: payload.imageUrl,
    latencyMs: payload.latencyMs ?? Math.round(performance.now() - startedAt),
    prompt,
  };
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getImageEditConcurrency(count) {
  return count >= 4 ? imageEditConcurrencyForFour : imageEditConcurrency;
}

async function editVariantWithRetry(item, index, runId, options = {}) {
  let lastError = null;

  for (let attempt = 1; attempt <= imageEditMaxAttempts; attempt += 1) {
    if (runId !== activeVariantRunId) {
      return null;
    }

    setVariantState(index, {
      status: attempt > 1 || options.manualRetry ? "retrying" : "rendering",
      message:
        attempt > 1
          ? `Retrying after a temporary issue (${attempt}/${imageEditMaxAttempts})...`
          : "Rendering with step-image-edit-2...",
      attempts: attempt,
      retryable: false,
    });
    updateVariantSummary();

    try {
      const result = await editImage(item.prompt, index + 1 + (attempt - 1) * 100, {
        textMode: item.textMode === true,
        timeoutMs: imageEditClientTimeoutMs,
        variantId: `variant-${index + 1}`,
      });

      if (runId !== activeVariantRunId) {
        return null;
      }

      setVariantState(index, {
        status: "done",
        message: "Ready.",
        imageUrl: result.imageUrl,
        latencyMs: result.latencyMs,
        prompt: result.prompt,
        caption: item.caption || "",
        retryable: false,
      });
      updateVariantSummary();
      return result;
    } catch (error) {
      lastError = error;
      console.warn(`Variant ${index + 1} attempt ${attempt} failed:`, error);

      if (attempt < imageEditMaxAttempts && isRetryableError(error)) {
        const delay = retryDelayMs + Math.round(Math.random() * retryJitterMs);
        setVariantState(index, {
          status: "retrying",
          message: `${friendlyErrorMessage(error)} Retrying in ${(delay / 1000).toFixed(1)}s...`,
          attempts: attempt + 1,
          retryable: false,
        });
        await wait(delay);
      } else {
        break;
      }
    }
  }

  setVariantState(index, {
    status: "failed",
    message: friendlyErrorMessage(lastError),
    retryable: isRetryableError(lastError),
  });
  updateVariantSummary();
  return null;
}

async function retryVariant(index) {
  const state = variantStates[index];

  if (!uploadedImage || !state?.prompt || state.status === "rendering" || state.status === "retrying") {
    return;
  }

  const runId = activeVariantRunId;
  setGenerating(true);
  await editVariantWithRetry(state, index, runId, { manualRetry: true });
  setGenerating(false);
}

async function runWithConcurrency(items, concurrency, worker) {
  let nextIndex = 0;

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      await worker(items[currentIndex], currentIndex);
    }
  });

  await Promise.all(workers);
}

function addResultCard(result) {
  const card = resultCardTemplate.content.firstElementChild.cloneNode(true);
  const image = card.querySelector(".result-image");
  const caption = card.querySelector(".result-caption");
  const downloadLink = card.querySelector(".download-link");
  const promptText = card.querySelector(".prompt-text");

  image.src = result.imageUrl;
  caption.textContent = result.caption || "";
  caption.hidden = !result.caption;
  downloadLink.href = result.imageUrl;
  promptText.textContent = result.prompt;

  if (resultsGrid.classList.contains("empty")) {
    resultsGrid.innerHTML = "";
    resultsGrid.classList.remove("empty");
  }

  resultsGrid.prepend(card);
}

async function generate() {
  if (!uploadedImage || isGenerating) {
    return;
  }

  const mode = modeSelect.value;
  const idea = ideaInput.value.trim();

  if (!idea) {
    setStatus("Add a meme idea or caption first.");
    return;
  }

  setGenerating(true);
  setStatus(
    mode === "variants"
      ? `Generating ${getVariantCount()} variants...`
      : mode === "single"
        ? "Running speed edit..."
        : "Generating meme...",
  );

  try {
    if (mode === "variants") {
      const count = getVariantCount();
      const captionText = selectedVariantText.trim();
      const runId = activeVariantRunId + 1;
      activeVariantRunId = runId;
      initializeVariantStates(count);
      setStatus(`Creating ${count} meme ideas with step-3.5-flash...`);
      let prompts = [];

      try {
        prompts = await generateCreativeVariantPrompts(idea, count);
      } catch (error) {
        console.warn("Meme ideas request failed; using fast local fallback prompts:", error);
        prompts = buildVariantPrompts(idea, count);
        setStatus("Creative prompt request was slow, using fast local prompts...");
      }

      const variantPrompts = captionText
        ? prompts.map((item, index) => ({
            ...item,
            prompt: addTextRenderingToVariantPrompt(item.prompt, captionText, index),
            textMode: true,
          }))
        : prompts;

      variantPrompts.forEach((item, index) => {
        setVariantState(index, {
          label: item.label || `Variant ${index + 1}`,
          prompt: item.prompt,
          caption: "",
          textMode: item.textMode === true,
          status: "queued",
          message: "Queued for rendering.",
        });
      });

      const concurrency = getImageEditConcurrency(variantPrompts.length);
      setStatus(`Rendering ${variantPrompts.length} variants with ${concurrency} parallel lanes...`);

      await runWithConcurrency(
        variantPrompts,
        concurrency,
        async (item, index) => {
          if (runId !== activeVariantRunId) {
            return;
          }

          await editVariantWithRetry(
            {
              ...item,
              caption: "",
            },
            index,
            runId,
          );
        },
      );
      updateVariantSummary();
      return;
    }

    const prompt = mode === "caption" ? buildCaptionPrompt(idea) : buildSinglePrompt(idea);
    const result = await editImage(prompt, 1, { textMode: mode === "caption" });
    addResultCard(result);
    setStatus("Result ready.");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Something went wrong.");
  } finally {
    setGenerating(false);
  }
}

imageInput.addEventListener("change", async () => {
  const file = imageInput.files?.[0];

  if (!file) {
    return;
  }

  if (file.size > 8 * 1024 * 1024) {
    setStatus("Please use an image under 8MB for this prototype.");
    return;
  }

  setStatus("Optimizing image for faster edits...");
  uploadedImage = await prepareImageForUpload(file);
  previewImage.src = uploadedImage.dataUrl;
  previewWrap.classList.remove("is-empty");
  setStatus("Image ready. Pick a mode and generate.");
  setGenerating(false);
});

modeSelect.addEventListener("change", syncModeUi);
variantCount.addEventListener("change", syncVariantCopy);
generateButton.addEventListener("click", generate);
clearButton.addEventListener("click", clearResults);

syncModeUi();
clearResults();
setGenerating(false);
