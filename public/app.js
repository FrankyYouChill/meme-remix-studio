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

const imageEditConcurrency = 2;
const imageEditMaxAttempts = 2;
const retryDelayMs = 600;

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
    const maxDimension = 1024;
    const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
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

function setGenerating(nextState) {
  isGenerating = nextState;
  generateButton.disabled = nextState || !uploadedImage;
}

function clearResults() {
  resultsGrid.innerHTML = `
    <div class="empty-state">
      <strong>Ready for a meme sprint.</strong>
      <span>Results will appear here when generation finishes.</span>
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
    `Add short readable meme text: "${shortCaption}".`,
    "Use bold white text with a black outline.",
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
    `Add the readable meme caption "${shortCaption}" as large bold white top text with a black outline.`,
    `Add the readable caption "${shortCaption}" near the bottom as bold meme text with strong contrast and black outline.`,
    `Add a clean speech bubble containing exactly "${shortCaption}" with crisp readable lettering.`,
    `Add "${shortCaption}" as a bright readable sticker-style text label, bold and centered in the composition.`,
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
  const response = await fetch("/api/meme-ideas", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      theme,
      count,
    }),
  });
  const payload = await response.json();

  if (!response.ok || !Array.isArray(payload.ideas) || payload.ideas.length < count) {
    console.error("AI creative director debug payload:", payload);
    showDebugPanel("step-3.5-flash raw response", payload);
    throw new Error(
      payload.error ||
        "step-3.5-flash did not return enough usable meme ideas. Try a more specific theme.",
    );
  }

  return payload.ideas.slice(0, count).map((idea) => ({
    label: idea.title || "AI idea",
    prompt: idea.prompt,
  }));
}

async function editImage(prompt, seed, options = {}) {
  const startedAt = performance.now();
  const response = await fetch("/api/edit-image", {
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
    }),
  });

  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.error || "Image edit failed.");
  }

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

async function editImageWithRetry(item, index, total) {
  let lastError = null;

  for (let attempt = 1; attempt <= imageEditMaxAttempts; attempt += 1) {
    try {
      const retryCopy = attempt > 1 ? ` Retrying attempt ${attempt}/${imageEditMaxAttempts}...` : "";
      setStatus(`Generating variant ${index + 1}/${total}.${retryCopy}`);

      return await editImage(item.prompt, index + 1 + (attempt - 1) * 100, {
        textMode: item.textMode === true,
      });
    } catch (error) {
      lastError = error;
      console.warn(`Variant ${index + 1} attempt ${attempt} failed:`, error);

      if (attempt < imageEditMaxAttempts) {
        setStatus(`Variant ${index + 1}/${total} failed once. Retrying...`);
        await wait(retryDelayMs);
      }
    }
  }

  throw lastError || new Error(`Variant ${index + 1} failed.`);
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
      setStatus(`Creating ${count} meme ideas with step-3.5-flash...`);
      const prompts = await generateCreativeVariantPrompts(idea, count);
      const variantPrompts = captionText
        ? prompts.map((item, index) => ({
            ...item,
            prompt: addTextRenderingToVariantPrompt(item.prompt, captionText, index),
            textMode: true,
          }))
        : prompts;
      setStatus(`Generating ${variantPrompts.length} image variants with step-image-edit-2...`);
      let successCount = 0;
      let failedCount = 0;

      await runWithConcurrency(
        variantPrompts,
        imageEditConcurrency,
        async (item, index) => {
          try {
            const result = await editImageWithRetry(item, index, variantPrompts.length);
            successCount += 1;
            addResultCard(result);
            setStatus(`${successCount}/${variantPrompts.length} variants ready...`);
          } catch (error) {
            failedCount += 1;
            console.error("Image variant failed:", error);
            setStatus(
              `${successCount}/${variantPrompts.length} variants ready. ${failedCount} failed or timed out...`,
            );
          }
        },
      );
      setStatus(
        failedCount > 0
          ? `${successCount} variants ready. ${failedCount} request failed or timed out.`
          : `${successCount} variants ready.`,
      );
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
