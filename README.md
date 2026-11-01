# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some Oxlint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the Oxlint configuration

If you are developing a production application, we recommend enabling type-aware lint rules by installing `oxlint-tsgolint` and editing `.oxlintrc.json`:

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["react", "typescript", "oxc"],
  "options": {
    "typeAware": true
  },
  "rules": {
    "react/rules-of-hooks": "error",
    "react/only-export-components": ["warn", { "allowConstantExport": true }]
  }
}
```

See the [Oxlint rules documentation](https://oxc.rs/docs/guide/usage/linter/rules) for the full list of rules and categories.

### Photo document input

Install backend dependencies with `backend/.venv/Scripts/python.exe -m pip install -r backend/requirements.txt`.
The Upload dialog accepts 1–5 ordered JPEG, PNG, or static WebP photos as one document (10 MiB each, 20 MiB total, 40 MP each). The backend normalizes them to JPEG at a 2048px longest edge and caps prepared images at 3 MiB each.

`POST /api/documents/photos` accepts repeated multipart `files` in page order and returns the usual `document_id`, `job_id`, and `status`. Jobs expose `warnings` for omitted unreadable content. Reliable text feeds the existing Episode-1 pipeline with web supplementation disabled. The browser caches the episode without photo blobs.

OCR uses the existing `META_MODEL` and Chat Completions adapter. Defaults: `PHOTO_EXTRACT_BUDGET=300000`, `PHOTO_JOB_BUDGET=900000`, `PHOTO_INPUT_TOKENS=8000`, `PHOTO_OUTPUT_TOKENS=48000`. Explicit `TOKEN_STAGE_BUDGETS.extract` overrides the photo extraction default; PDF budgets are unchanged. Input counting includes the image and fails closed when unavailable. Returned usage is recorded, including rejected OCR; a timeout can incur provider charges without returning usage, so these are application accounting limits rather than a billing guarantee.

Run `backend/.venv/Scripts/python.exe -m pytest backend/app/tests/test_photos.py` for offline checks. Run `backend/.venv/Scripts/python.exe -u backend/scripts/live_photo_check.py` for a real two-photo → published Episode-1 check plus blank-photo recovery; this uses the configured Meta account and prints its isolated temporary artifact directory.

### Optional 3D mascot

Set `VITE_MASCOT_VRM_URL` to a URL for a VRM 0 or VRM 1 file you are licensed to use. Set `VITE_MASCOT_IDLE_URL` to a licensed Mixamo FBX idle animation to add a body idle. These Vite variables are read when the frontend is built. With no model, reduced motion, or an unavailable model/WebGL context, Mita uses the built-in stand-in. Only use models and animations whose terms permit your intended use.
