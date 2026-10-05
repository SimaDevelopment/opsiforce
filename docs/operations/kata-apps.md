# Generated apps with Kata

The regular `opsiforce.yml` deployment selects `kata-clh-runtime-rs-opsiforce`
through the backend Helm value `config.agentRuntimeClassName`. The workflow
checks that this RuntimeClass exists before deploying the backend. Install Kata
and its RuntimeClass in each target cluster (including production) first; the
workflow does not install node runtimes. The RuntimeClass must select nodes
where its handler is installed, compatible with the configured agent affinity.

The ConfigMap passes `AGENT_RUNTIME_CLASS_NAME` to the backend. It applies to
generated agent/app pods (including their init containers) and workspace-update
Jobs. Backend and proxy deployments keep their existing runtime.

The shared chart defaults this value to empty. Azure and local deployments use
the default Kubernetes runtime; they must not inherit the regular workflow's
Kata override. An explicit Helm override to disable it is
`--set-string config.agentRuntimeClassName=`, which also clears a previous value.

Existing pods keep their current runtime until recreated. Deploying the backend
does not restart active apps. Validate a newly created app's startup, CephFS
workspace access, application routing and workspace updates before recycling
existing apps. Setting the value back to empty affects newly created pods only.
