---
kind: operations
---

# Quickstart

> Stand up the whole Opsiforce stack on macOS or Linux with one command and land in the app already signed in.

## Prerequisites

- macOS or Linux; the Quickstart refuses to run anywhere else, because it leans on `minikube tunnel` for routing. On macOS it detects missing tools and installs them with Homebrew once you consent; on Linux you install them yourself first and the cluster runs on the Docker driver, with the Ubuntu commands listed in the package [README](../../README.md).
- An administrator password, asked once for the tunnel.
- Either a ChatGPT or Codex subscription you can sign in to, or an OpenAI API key (optionally set as `OPENAI_API_KEY` before running).

## Steps

1. From the package root run:

   ```bash
   yarn dev
   ```

   It walks a fixed sequence of numbered steps and prints each as running, done or cached: detect and pin tools, size and start the cluster, open the tunnel, install in-cluster infra and TLS, install workspace dependencies, build the images, create and migrate the databases, install the LLM gateway, connect an LLM, optionally enable local email testing, bring the stack up under Tilt, open the app. The authoritative list is the `STEPS` array in `scripts/spin-up.mjs`.
2. Answer the prompts: the resource-sizing suggestion (adjust or accept), the administrator password, the LLM choice, and the opt-in for local email testing (off by default).
3. Choose the LLM. The API-key option bills your OpenAI account per token: the step writes the key into the `opsiforce-bifrost-provider-keys` Secret that Bifrost's Helm-declared `openai` reads, restarts Bifrost, saves the key as `OPENAI_API_KEY` in the package's gitignored `.env`, checks it serves the Agent's default model, `openai/gpt-5.6-sol`, and offers an available model if not; the backend's first boot adopts the built-in `openai` Model provider as Bifrost has it. After that the key is changed on Settings → Model providers, never in `.env`. The subscription option needs nothing more at this point.
4. Re-run `yarn dev` whenever you like. Each step records completion, so a second run fast-paths cached work; the tunnel and the `up` step re-run every time to reconcile the live stack. A failed step stops the run, saves progress and resumes there next time. Progress and saved choices live under `~/.opsiforce/`, outside the repo.
5. Use the flags when needed, listed in full by `yarn dev --help`: `--yes` consents to tool installs non-interactively; `--cpus N` and `--memory G` size the cluster without the prompt; `--reset` tears the cluster down and clears `~/.opsiforce/`.
6. Pinned versions come from `versions.json` at the package root: exact pins for Node, Yarn, the cluster Kubernetes version and the Helm charts, and tested versions plus floors for host CLI tools. Refresh the tested observations from a known-good machine with `scripts/capture-baseline.mjs`.
7. Sign in ChatGPT. With the ChatGPT or Codex subscription option, open Settings → Model providers once the app is open, click **Sign in** beside Not signed in on the `custom-openai-1` row of the OpenAI card, open `auth.openai.com/codex/device` and enter the code shown; the row turns Connected by itself, and every Organization gets a `custom-openai-1` row that routes to it ([Linked account](../organization/linked-account.md)).

## Verify

- The command prints the addresses in use: the app, the Tilt UI, the Bifrost dashboard and the data-store ports, and opens the app in your browser signed in as the local user ([Local orchestration](local-orchestration.md)).
- The LLM step reports that the chosen provider serves the default model.
- Settings → Model providers lists `openai` as Working on the API-key option, or `custom-openai-1` as Connected after the ChatGPT sign-in, and a chat in a new Project answers.
