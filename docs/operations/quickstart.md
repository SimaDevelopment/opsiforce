---
kind: operations
---

# Quickstart

> Stand up the whole Opsiforce stack on macOS or Linux with one command and land in the app already signed in.

## Prerequisites

- macOS or Linux; the Quickstart refuses to run anywhere else, because it leans on `minikube tunnel` for routing and `host.minikube.internal` for the host-side LLM bridge. On macOS it detects missing tools and installs them with Homebrew once you consent; on Linux you install them yourself first and the cluster runs on the Docker driver, with the Ubuntu commands listed in the package [README](../../README.md).
- An administrator password, asked once for the tunnel.
- Either a ChatGPT or Codex subscription you can sign in to, or an OpenAI API key (optionally set as `OPENAI_API_KEY` before running).

## Steps

1. From the package root run:

   ```bash
   yarn dev
   ```

   It walks a fixed sequence of numbered steps and prints each as running, done or cached: detect and pin tools, size and start the cluster, open the tunnel, install in-cluster infra and TLS, install workspace dependencies, build the images, create and migrate the databases, install the LLM gateway, connect an LLM, optionally enable local email testing, bring the stack up under Tilt, open the app. The authoritative list is the `STEPS` array in `scripts/spin-up.mjs`.
2. Answer the prompts: the resource-sizing suggestion (adjust or accept), the administrator password, the LLM choice, and the opt-in for local email testing (off by default).
3. Choose the LLM. The ChatGPT or Codex subscription option runs a browser device-code login against OpenAI and stores the token under `~/.opsiforce/` ([Codex Proxy](../gateways/codex-proxy.md)). The API-key option bills your OpenAI account per token. Either way the Agent's default model stays `openai/gpt-5.6-sol`; the step checks the chosen provider serves it and offers an available model if not.
4. Re-run `yarn dev` whenever you like. Each step records completion, so a second run fast-paths cached work; the tunnel and the `up` step re-run every time to reconcile the live stack. A failed step stops the run, saves progress and resumes there next time. Progress, saved choices and the login token live under `~/.opsiforce/`, outside the repo.
5. Use the flags when needed, listed in full by `yarn dev --help`: `--yes` consents to tool installs non-interactively; `--cpus N` and `--memory G` size the cluster without the prompt; `--reset` tears the cluster down and clears `~/.opsiforce/`, the stored login included.
6. Pinned versions come from `versions.json` at the package root: exact pins for Node, Yarn, the cluster Kubernetes version and the Helm charts, and tested versions plus floors for host CLI tools. Refresh the tested observations from a known-good machine with `scripts/capture-baseline.mjs`.

## Verify

- The command prints the addresses in use: the app, the Tilt UI, the Bifrost dashboard and the data-store ports, and opens the app in your browser signed in as the local user ([Local orchestration](local-orchestration.md)).
- The LLM step reports that the chosen provider serves the default model.
