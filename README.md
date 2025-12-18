# Git Hooks Bootstrap (Cross-platform)

This project uses a **custom Git hooks bootstrap mechanism** based on Node.js, without external tools such as Husky.

The goal is to ensure that **Git hooks and AI-powered documentation workflows** are automatically and consistently configured on **Windows, macOS, and Linux**, with **zero manual setup per developer**.

The bootstrap logic is implemented in:

scripts/bootstrap-hooks.mjs

---

## Quick Start (Installation)

```bash
git clone <repo-url>
cd <repo-folder>
cp .env.example .env
# edit .env and set OPENAI_API_KEY
npm install
```

That’s it.  
Git hooks are installed automatically via the `prepare` script.

---

## 1. Prerequisites

To work with this project, you need:

- **Git** (available in PATH)
- **Node.js** (LTS recommended)
- **npm** (comes with Node.js)

The setup is fully cross-platform and works on **Windows, macOS, and Linux**.

---

## 2. Cloning and initial project setup

### 2.1 Clone the repository

```bash
git clone <repo-url>
cd <repo-folder>
```

### 2.2 Configure environment variables

This project uses a local `.env` file for sensitive and environment-specific configuration  
(e.g. API keys and AI model selection).

The `.env` file is **not committed** to the repository and is ignored by Git.  
Instead, an example file is provided.

```bash
cp .env.example .env
```

Now open `.env` in your editor and set at least the following variable:

```env
OPENAI_API_KEY=your_openai_api_key_here
```

Optional (but recommended) model configuration:

```env
OPENAI_MODEL_DEFAULT=gpt-4.1-mini
OPENAI_MODEL_TRANSLATE=
OPENAI_MODEL_DETECT=
OPENAI_LOG_MODEL=1
```

---

## 3. How the Git hooks bootstrap works

The bootstrap script performs the following steps:

1. Verifies that the project is a Git repository
2. Detects the repository root
3. Verifies that `.githooks/pre-commit` exists
4. Ensures executable permissions on macOS/Linux (`chmod +x`)
5. Sets a local Git configuration:

```bash
git config core.hooksPath .githooks
```

---

## 4. AI workflow configuration

AI features are controlled exclusively via `.env`.

---

## 5. Token usage tracking

Token usage is tracked locally in:

.translation-usage.jsonl

---

## 6. Summary

- Automatic Git hooks bootstrap
- Safe AI configuration via `.env`
- Cross-platform behavior
