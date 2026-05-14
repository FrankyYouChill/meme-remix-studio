# Meme Remix Studio

A small local demo for remixing one uploaded image into meme variants with StepFun.

## Features

- Upload one image and generate 2 or 4 meme variants
- Use `step-3.5-flash` to create meme edit prompts
- Use `step-image-edit-2` to edit images
- Optional caption/text rendering samples
- Local Node server keeps the API key out of the browser

## Get A StepFun API Key

1. Go to [platform.stepfun.ai](https://platform.stepfun.ai/).
2. Sign in or create an account.
3. Open the API key section in the dashboard.
4. Create a new API key.
5. Copy the key into a local `.env` file.

## Setup

```bash
cd step-image-edit-2/meme-remix-studio
cp .env.example .env
```

Edit `.env`.

### Option A: Step Plan

Use this if your account uses Step Plan:

```bash
STEP_API_KEY=sk-your-stepfun-api-key
STEP_API_BASE_URL=https://api.stepfun.ai/step_plan/v1
STEP_CHAT_API_BASE_URL=https://api.stepfun.ai/step_plan/v1
MEME_IDEAS_TIMEOUT_MS=10000
IMAGE_EDIT_TIMEOUT_MS=25000
PORT=3000
```

### Option B: Standard API

Use this if you are not using Step Plan:

```bash
STEP_API_KEY=sk-your-stepfun-api-key
STEP_API_BASE_URL=https://api.stepfun.ai/v1
STEP_CHAT_API_BASE_URL=https://api.stepfun.ai/v1
MEME_IDEAS_TIMEOUT_MS=10000
IMAGE_EDIT_TIMEOUT_MS=25000
PORT=3000
```

## Run

```bash
npm start
```

Open:

```text
http://localhost:3000
```

## Notes

- Restart `npm start` after changing `.env`.
- Keep uploaded images under 8MB.
- `2 variants` sends 1 chat request plus 2 image edit requests.
- `4 variants` sends 1 chat request plus 4 image edit requests.
- If generation is slow, lower image size or increase `IMAGE_EDIT_TIMEOUT_MS`.
- This is a demo only: no database, login, gallery, or payment flow.

## Troubleshooting

If you see `Missing STEP_API_KEY`, check `.env`.

If the port is busy, either stop the old server or change:

```bash
PORT=3001
```

