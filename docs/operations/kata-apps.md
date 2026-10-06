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

The regular workflow also sets `config.agentPrivileged=true`, passed as
`AGENT_PRIVILEGED` to the backend. Generated app containers, their init containers,
and workspace-update Job containers receive `securityContext.privileged: true`.
The backend rejects privileged agent creation unless the runtime is exactly
`kata-clh-runtime-rs-opsiforce`; it never falls back to a privileged default-runtime pod.
The shared chart defaults this option to false, leaving Azure and local deployments
unprivileged. Backend and proxy containers are unaffected. Existing app pods need
recreation to pick up this setting. To disable it, set `config.agentPrivileged=false`.
